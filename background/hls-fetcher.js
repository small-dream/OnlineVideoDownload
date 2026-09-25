// background/hls-fetcher.js
// Download HLS playlists, merge segments, and save the final file without page context.

import '../lib/byte-utils.js';
import '../lib/constants.js';
import '../lib/download-path.js';
import '../lib/hls-pipeline.js';
import '../lib/message-types.js';
import { injectHeaders } from './header-injector.js';
import { submitBlobDownloadFromOffscreen } from './offscreen-download.js';

const byteUtils = globalThis.__OVD_BYTE_UTILS__ || {};
const constants = globalThis.__OVD_CONSTANTS__ || {};
const downloadPathUtils = globalThis.__OVD_DOWNLOAD_PATH__ || {};
const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
const MSG = messageTypes;

const BLOB_TRANSFER_CHUNK_SIZE = constants.BLOB_TRANSFER_CHUNK_SIZE || 256 * 1024;
const HLS_SEGMENT_CONCURRENCY = constants.HLS_SEGMENT_CONCURRENCY || 5;

function uint8ArrayToBase64Fallback(uint8Array) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < uint8Array.length; i += step) {
    const slice = uint8Array.subarray(i, i + step);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

const uint8ArrayToBase64 = byteUtils.uint8ArrayToBase64 || uint8ArrayToBase64Fallback;

function getHlsPipeline() {
  const pipeline = globalThis.__OVD_HLS_PIPELINE__;
  if (!pipeline) {
    throw new Error('HLS pipeline helpers are not loaded');
  }
  return pipeline;
}

export class HlsFetcher {
  async downloadAndMerge(m3u8Url, filename, headers = {}, onProgress = null, tabId = null, taskMeta = {}) {
    console.log(`[HLS] start filename="${filename}" tabId=${tabId ?? 'none'} url=${m3u8Url}`);
    const cleanupRules = await injectHeaders(m3u8Url, headers);

    try {
      return await this._doDownloadAndMerge(m3u8Url, filename, headers, onProgress, tabId, taskMeta);
    } finally {
      await cleanupRules();
    }
  }

  async _doDownloadAndMerge(m3u8Url, filename, headers, onProgress, tabId, taskMeta = {}) {
    const pipeline = getHlsPipeline();

    let m3u8Content = await pipeline.hlsFetchText(m3u8Url, headers);
    if (m3u8Content.includes('#EXT-X-STREAM-INF')) {
      const mediaUrl = pipeline.selectBestHlsStream(m3u8Content, m3u8Url);
      m3u8Url = mediaUrl;
      m3u8Content = await pipeline.hlsFetchText(mediaUrl, headers);
    }

    const keyInfo = await pipeline.parseHlsEncryption(m3u8Content, m3u8Url, headers);
    const playlist = pipeline.parseHlsPlaylist(m3u8Content, m3u8Url);
    const { segments } = playlist;
    if (segments.length === 0) {
      throw new Error('No segments found in m3u8 playlist');
    }

    const output = pipeline.inferHlsOutputProfile(playlist);
    const prefixBuffers = [];
    if (playlist.initSegmentUrl) {
      prefixBuffers.push(await pipeline.hlsFetchBuffer(playlist.initSegmentUrl, headers));
    }

    const { buffers, failedCount } = await pipeline.downloadHlsSegments(segments, {
      concurrency: HLS_SEGMENT_CONCURRENCY,
      headers,
      onProgress,
    });
    if (failedCount > 0) {
      console.warn(`[HLS] ${failedCount}/${segments.length} 个分片下载失败（未超阈值），已按空洞跳过`);
    }

    let finalBuffers = buffers;
    if (keyInfo) {
      finalBuffers = await pipeline.decryptHlsSegments(buffers, keyInfo);
    }

    finalBuffers = prefixBuffers.concat(finalBuffers);
    const totalSize = finalBuffers.reduce((sum, buffer) => sum + (buffer?.byteLength || 0), 0);
    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const buffer of finalBuffers) {
      if (buffer?.byteLength > 0) {
        merged.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
      }
    }

    return this._downloadMergedBlob(merged, filename, output, taskMeta);
  }

  async _downloadMergedBlob(uint8Array, filename, output, taskMeta = {}) {
    const pipeline = getHlsPipeline();
    const blob = new Blob([uint8Array], { type: output.mimeType });
    const downloadFilename = await downloadPathUtils.applyDownloadSubdir?.(
      pipeline.ensureExtension(filename, output.ext)
    );

    const result = await submitBlobDownloadFromOffscreen(blob, downloadFilename, output.mimeType, taskMeta);
    if (result?.ok) {
      console.log(`[HLS] download submitted downloadId=${result.downloadId} filename="${downloadFilename}"`);
    }
    return result;
  }
}
