// background/hls-fetcher.js
// Download HLS playlists, merge segments, and save the final file without page context.

import '../lib/byte-utils.js';
import '../lib/constants.js';
import '../lib/download-path.js';
import '../lib/hls-pipeline.js';
import '../lib/message-types.js';
import '../lib/mp4-muxer.js';
import '../lib/bilibili-muxer.js';
import { safeRuntimeMessage } from '../lib/browser-compat.module.js';
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
  async downloadAndMerge(m3u8Url, filename, headers = {}, onProgress = null, tabId = null, taskMeta = {}, options = {}) {
    console.log(`[HLS] start filename="${filename}" tabId=${tabId ?? 'none'} url=${m3u8Url}`);
    const cleanupRules = await injectHeaders(m3u8Url, headers);

    try {
      return await this._doDownloadAndMerge(m3u8Url, filename, headers, onProgress, tabId, taskMeta, options);
    } finally {
      await cleanupRules();
    }
  }

  async _doDownloadAndMerge(m3u8Url, filename, headers, onProgress, tabId, taskMeta = {}, options = {}) {
    const pipeline = getHlsPipeline();

    let m3u8Content = await pipeline.hlsFetchText(m3u8Url, headers);
    let audioRenditionUrl = null;
    let selectedQuality = '';

    if (m3u8Content.includes('#EXT-X-STREAM-INF')) {
      const master = pipeline.parseHlsMasterPlaylist?.(m3u8Content, m3u8Url)
        || { audioRenditions: [], isMaster: false, variants: [] };
      const variant = pipeline.selectHlsVariant?.(master.variants, m3u8Url, {
        quality: options.quality || options.variantUrl || '',
      });

      if (variant) {
        selectedQuality = variant.label || '';
        console.log(`[HLS] Master Playlist 选中画质=${selectedQuality} 带宽=${variant.bandwidth} url=${variant.url}`);
        const audioRendition = pipeline.findMatchingAudioRendition?.(master, variant);
        if (audioRendition?.uri) {
          audioRenditionUrl = audioRendition.uri;
          console.log(`[HLS] 检测到独立音轨 group=${audioRendition.groupId} url=${audioRenditionUrl}`);
        }
        m3u8Url = variant.url;
      } else {
        m3u8Url = pipeline.selectBestHlsStream(m3u8Content, m3u8Url);
      }

      m3u8Content = await pipeline.hlsFetchText(m3u8Url, headers);
    }

    const playlist = pipeline.parseHlsPlaylist(m3u8Content, m3u8Url);
    const { segments } = playlist;
    if (segments.length === 0) {
      throw new Error('No segments found in m3u8 playlist');
    }

    if (playlist.isLive) {
      // 直播流无 ENDLIST，只能下载当前窗口，必须显式提示而不是静默产出残片
      console.warn(`[HLS] 直播流，仅下载当前窗口 ${segments.length} 个分片`);
      safeRuntimeMessage({
        level: 'info',
        message: `检测到直播流，仅能下载当前播放窗口的 ${segments.length} 个分片`,
        taskMeta,
        type: MSG.SOURCE_DOWNLOAD_STATUS || 'SOURCE_DOWNLOAD_STATUS',
        videoUrl: taskMeta.videoUrl || m3u8Url,
      });
    }

    const keyInfo = await this._resolveKeyInfo(pipeline, playlist, m3u8Content, m3u8Url, headers);

    const output = pipeline.inferHlsOutputProfile(playlist);
    const prefixBuffers = [];
    if (playlist.initSegmentUrl) {
      prefixBuffers.push(await pipeline.hlsFetchBuffer(playlist.initSegmentUrl, headers, {
        range: playlist.initSegmentByteRange,
      }));
    }

    const { buffers, failedCount } = await pipeline.downloadHlsSegments(segments, {
      concurrency: HLS_SEGMENT_CONCURRENCY,
      fetchBuffer: (url, range) => pipeline.hlsFetchBuffer(url, headers, { range }),
      headers,
      maxTotalBytes: constants.MAX_IN_PAGE_MERGE_BYTES,
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
    let merged = this._concatBuffers(finalBuffers);

    let audioMerged = false;
    if (audioRenditionUrl) {
      try {
        const withAudio = await this._mergeAudioRendition(
          pipeline,
          audioRenditionUrl,
          headers,
          merged,
          output,
          taskMeta
        );
        if (withAudio) {
          merged = withAudio;
          audioMerged = true;
        }
      } catch (err) {
        console.warn(`[HLS] 独立音轨合并失败，回退为纯视频文件: ${err.message}`);
        safeRuntimeMessage({
          level: 'info',
          message: `独立音轨合并失败（${err.message}），将只保存视频画面`,
          taskMeta,
          type: MSG.SOURCE_DOWNLOAD_STATUS || 'SOURCE_DOWNLOAD_STATUS',
          videoUrl: taskMeta.videoUrl || m3u8Url,
        });
      }
    }

    const result = await this._downloadMergedBlob(merged, filename, output, taskMeta);
    return {
      ...(result || {}),
      audioMerged,
      isLive: !!playlist.isLive,
      quality: selectedQuality,
    };
  }

  _concatBuffers(buffers) {
    const totalSize = buffers.reduce((sum, buffer) => sum + (buffer?.byteLength || 0), 0);
    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const buffer of buffers) {
      if (buffer?.byteLength > 0) {
        merged.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
      }
    }
    return merged;
  }

  /** 解析解密密钥：优先支持 EXT-X-KEY 轮换 */
  async _resolveKeyInfo(pipeline, playlist, playlistText, playlistUrl, headers) {
    const keyEntries = playlist.keys || [];
    if (keyEntries.length > 0 && typeof pipeline.resolveHlsKeys === 'function') {
      return {
        keys: await pipeline.resolveHlsKeys(keyEntries, headers, {}),
        segments: playlist.segments,
      };
    }

    if (!playlist.isEncrypted) {
      return null;
    }

    return pipeline.parseHlsEncryption(playlistText, playlistUrl, headers) || null;
  }

  /**
   * 下载独立音轨并合并进视频数据；仅在 fMP4 + muxer 可用时生效，
   * 否则返回 null 由调用方保存纯视频。
   */
  async _mergeAudioRendition(pipeline, audioUrl, headers, videoBytes, output, taskMeta) {
    const muxer = globalThis.BilibiliMuxer || {};
    if (output.ext !== '.mp4' || typeof muxer.mergeFmp4Streams !== 'function') {
      return null;
    }

    const audioText = await pipeline.hlsFetchText(audioUrl, headers);
    const audioPlaylist = pipeline.parseHlsPlaylist(audioText, audioUrl);
    if (audioPlaylist.segments.length === 0) {
      return null;
    }

    const keyInfo = await this._resolveKeyInfo(pipeline, audioPlaylist, audioText, audioUrl, headers);
    const prefixBuffers = [];
    if (audioPlaylist.initSegmentUrl) {
      prefixBuffers.push(await pipeline.hlsFetchBuffer(audioPlaylist.initSegmentUrl, headers, {
        range: audioPlaylist.initSegmentByteRange,
      }));
    }

    const { buffers } = await pipeline.downloadHlsSegments(audioPlaylist.segments, {
      concurrency: HLS_SEGMENT_CONCURRENCY,
      fetchBuffer: (url, range) => pipeline.hlsFetchBuffer(url, headers, { range }),
      maxTotalBytes: constants.MAX_IN_PAGE_MERGE_BYTES,
    });

    let audioBuffers = buffers;
    if (keyInfo) {
      audioBuffers = await pipeline.decryptHlsSegments(buffers, keyInfo);
    }

    const audioBytes = this._concatBuffers(prefixBuffers.concat(audioBuffers));
    const blob = await muxer.mergeFmp4Streams(
      videoBytes.buffer.slice(videoBytes.byteOffset, videoBytes.byteOffset + videoBytes.byteLength),
      audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength)
    );
    console.log(`[HLS] 独立音轨合并完成 task=${taskMeta.taskId || 'none'} size=${(blob.size / 1024 / 1024).toFixed(2)} MB`);
    return new Uint8Array(await blob.arrayBuffer());
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
