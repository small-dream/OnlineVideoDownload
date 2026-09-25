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
import { releaseOpfsDownload, submitBlobDownloadFromOffscreen, submitOpfsDownloadFromOffscreen } from './offscreen-download.js';
import { registerOpfsTempFile } from './opfs-temp-registry.js';
import { isStreamingMergeSupported, mergeOpfsStreamsAndDownload } from './streaming-merge.js';

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

/** muxer 入参转换已收敛到 lib/hls-pipeline.js#toMuxBuffer */
function toMuxBuffer(bytes) {
  const pipeline = globalThis.__OVD_HLS_PIPELINE__ || {};
  return typeof pipeline.toMuxBuffer === 'function' ? pipeline.toMuxBuffer(bytes) : bytes.buffer;
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
    let selectedVariant = null;

    if (m3u8Content.includes('#EXT-X-STREAM-INF')) {
      const master = pipeline.parseHlsMasterPlaylist?.(m3u8Content, m3u8Url)
        || { audioRenditions: [], isMaster: false, variants: [] };
      const variant = pipeline.selectHlsVariant?.(master.variants, m3u8Url, {
        quality: options.quality || options.variantUrl || '',
      });

      if (variant) {
        selectedVariant = variant;
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
    const decryptor = keyInfo && typeof pipeline.createSegmentDecryptor === 'function'
      ? pipeline.createSegmentDecryptor(keyInfo)
      : null;

    const output = pipeline.inferHlsOutputProfile(playlist);

    // 需要"独立音轨合并"时，内存合并必须整体持有视频数据（上限 2GB）。
    // 体积超过流式阈值且 OPFS 可用时，改成"视频/音频各自落盘 → 文件级流式合并"，
    // 峰值内存与文件体积解耦（现场 1.7GB 视频撞 2048MB 上限就是这条分支）。
    const averageBandwidth = Number(selectedVariant?.averageBandwidth) || 0;
    const estimatedBytes = typeof pipeline.estimateHlsBytes === 'function'
      ? pipeline.estimateHlsBytes(
        playlist,
        averageBandwidth || Number(selectedVariant?.bandwidth) || 0,
        averageBandwidth > 0 ? { bandwidthFactor: 1 } : {}
      )
      : 0;
    const streamMergeThreshold = constants.STREAM_MERGE_THRESHOLD_BYTES || 512 * 1024 * 1024;
    const useStreamingAudioMerge = !!audioRenditionUrl
      && output.ext === '.mp4'
      && estimatedBytes > streamMergeThreshold
      && isStreamingMergeSupported();

    if (useStreamingAudioMerge) {
      console.log(
        `[HLS] 预估 ${Math.round(estimatedBytes / 1024 / 1024)} MB 需要音轨合并，`
        + '改走流式合并落盘（视频/音频分别落盘后文件级合并）'
      );
      return this._downloadWithStreamingAudioMerge({
        audioRenditionUrl,
        decryptor,
        headers,
        keyInfo,
        m3u8Url,
        onProgress,
        output,
        filename,
        pipeline,
        playlist,
        prefixBuffers,
        segments,
        taskMeta,
      });
    }

    // 需要把独立音轨合并进视频时必须整体持有视频数据（fMP4 muxer 接口所限）；
    // 其余情况走顺序写入 sink，避免再拼一份全量 Uint8Array。
    const audioMergePlanned = !!audioRenditionUrl
      && output.ext === '.mp4'
      && typeof globalThis.BilibiliMuxer?.mergeFmp4Streams === 'function';

    // 大文件走 OPFS：小文件仍是纯内存（快），累计超过阈值后自动落盘，
    // 上限也从"浏览器内存"变成"磁盘空间"。
    const opfs = globalThis.__OVD_OPFS_SINK__ || {};
    const diskBacked = typeof opfs.createSpillSink === 'function' && !!opfs.isSupported?.();
    const sink = !audioMergePlanned && typeof pipeline.createInMemorySink === 'function'
      ? (diskBacked
        ? opfs.createSpillSink({ thresholdBytes: constants.OPFS_SPILL_THRESHOLD_BYTES })
        : pipeline.createInMemorySink())
      : null;
    const maxTotalBytes = diskBacked && sink
      ? (constants.OPFS_MAX_OUTPUT_BYTES || 0)
      : constants.MAX_IN_PAGE_MERGE_BYTES;

    const prefixBuffers = [];
    if (playlist.initSegmentUrl) {
      const initBuffer = await pipeline.hlsFetchBuffer(playlist.initSegmentUrl, headers, {
        range: playlist.initSegmentByteRange,
      });
      if (sink) {
        await sink.write(initBuffer);
      } else {
        prefixBuffers.push(initBuffer);
      }
    }

    const { buffers, failedCount } = await pipeline.downloadHlsSegments(segments, {
      concurrency: HLS_SEGMENT_CONCURRENCY,
      fetchBuffer: (url, range) => pipeline.hlsFetchBuffer(url, headers, { range }),
      headers,
      maxTotalBytes,
      onProgress,
      sink,
      transform: decryptor,
    });
    if (failedCount > 0) {
      console.warn(`[HLS] ${failedCount}/${segments.length} 个分片下载失败（未超阈值），已按空洞跳过`);
    }

    let blob = null;
    let opfsName = '';
    let audioMerged = false;

    if (audioMergePlanned) {
      let finalBuffers = buffers || [];
      if (keyInfo && !decryptor) {
        finalBuffers = await pipeline.decryptHlsSegments(finalBuffers, keyInfo);
      }
      finalBuffers = prefixBuffers.concat(finalBuffers);
      let merged = this._concatBuffers(finalBuffers);

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

      blob = new Blob([merged], { type: output.mimeType });
    } else if (sink && sink.byteLength > 0) {
      const info = typeof sink.finalize === 'function'
        ? await sink.finalize()
        : { byteLength: sink.byteLength, mode: 'memory' };

      if (info.mode === 'opfs' && info.name) {
        opfsName = info.name;
      } else {
        blob = sink.toBlob(output.mimeType);
      }
    } else {
      // 兜底：下载管线未使用 sink（旧实现）时仍按缓冲数组拼接
      let finalBuffers = buffers || [];
      if (keyInfo && !decryptor) {
        finalBuffers = await pipeline.decryptHlsSegments(finalBuffers, keyInfo);
      }
      finalBuffers = prefixBuffers.concat(finalBuffers);
      blob = new Blob([this._concatBuffers(finalBuffers)], { type: output.mimeType });
    }

    const result = opfsName
      ? await this._downloadOpfsBlob(opfsName, filename, output, taskMeta)
      : await this._downloadMergedBlob(blob, filename, output, taskMeta);
    return {
      ...(result || {}),
      audioMerged,
      isLive: !!playlist.isLive,
      quality: selectedQuality,
    };
  }

  /**
   * 视频分片 + 独立音轨分别落盘到 OPFS，再做文件级流式合并。
   * 峰值内存 ≈ 一个分片 + 一个 moof，与整片体积解耦；磁盘上限走 OPFS_MAX_OUTPUT_BYTES。
   */
  async _downloadWithStreamingAudioMerge({
    audioRenditionUrl,
    decryptor,
    filename,
    headers,
    keyInfo,
    onProgress,
    output,
    pipeline,
    playlist,
    prefixBuffers,
    segments,
    taskMeta,
  }) {
    const opfs = globalThis.__OVD_OPFS_SINK__ || {};
    if (typeof opfs.createOpfsSink !== 'function') {
      throw new Error('OPFS 不可用，无法进行流式合并');
    }

    const maxOutputBytes = constants.OPFS_MAX_OUTPUT_BYTES || 0;
    const videoSink = await opfs.createOpfsSink({ prefix: 'ovd-hls-video' });
    let audioSink = null;
    let audioName = '';
    let videoName = '';

    try {
      // 1) 视频（init segment + 全部分片）顺序写盘
      for (const buffer of prefixBuffers) {
        await videoSink.write(buffer);
      }
      await pipeline.downloadHlsSegments(segments, {
        concurrency: HLS_SEGMENT_CONCURRENCY,
        fetchBuffer: (url, range) => pipeline.hlsFetchBuffer(url, headers, { range }),
        headers,
        maxTotalBytes: maxOutputBytes,
        onProgress,
        sink: videoSink,
        transform: decryptor,
      });
      const videoInfo = await videoSink.finalize();
      videoName = videoInfo.name;
      console.log(`[HLS] 视频分片已落盘 name=${videoName} 大小=${Math.round(videoInfo.byteLength / 1024 / 1024)} MB`);

      // 2) 独立音轨同样落盘
      audioSink = await opfs.createOpfsSink({ prefix: 'ovd-hls-audio' });
      const audioText = await pipeline.hlsFetchText(audioRenditionUrl, headers);
      const audioPlaylist = pipeline.parseHlsPlaylist(audioText, audioRenditionUrl);
      if (!audioPlaylist.segments.length) {
        throw new Error('独立音轨播放列表为空');
      }

      const audioKeyInfo = typeof pipeline.resolveHlsKeyInfo === 'function'
        ? await pipeline.resolveHlsKeyInfo(audioPlaylist, audioText, audioRenditionUrl, headers, {})
        : null;
      const audioDecryptor = audioKeyInfo && typeof pipeline.createSegmentDecryptor === 'function'
        ? pipeline.createSegmentDecryptor(audioKeyInfo)
        : null;

      if (audioPlaylist.initSegmentUrl) {
        await audioSink.write(await pipeline.hlsFetchBuffer(audioPlaylist.initSegmentUrl, headers, {
          range: audioPlaylist.initSegmentByteRange,
        }));
      }
      await pipeline.downloadHlsSegments(audioPlaylist.segments, {
        concurrency: HLS_SEGMENT_CONCURRENCY,
        fetchBuffer: (url, range) => pipeline.hlsFetchBuffer(url, headers, { range }),
        headers,
        maxTotalBytes: maxOutputBytes,
        sink: audioSink,
        transform: audioDecryptor,
      });
      const audioInfo = await audioSink.finalize();
      audioName = audioInfo.name;
      console.log(`[HLS] 音轨已落盘 name=${audioName} 大小=${Math.round(audioInfo.byteLength / 1024 / 1024)} MB`);

      // 3) 文件级流式合并 + 保存
      const merged = await mergeOpfsStreamsAndDownload({
        audioName,
        filename: pipeline.ensureExtension(filename, output.ext),
        mimeType: output.mimeType,
        onProgress,
        taskMeta,
        videoName,
      });

      // 输入临时文件已用完，立即释放；输出文件由 opfs-temp-registry 按 downloadId 清理
      videoName = '';
      audioName = '';
      await videoSink.remove?.().catch?.(() => {});
      await audioSink.remove?.().catch?.(() => {});

      return {
        ...merged,
        audioMerged: true,
        isLive: !!playlist.isLive,
        streamingMerge: true,
      };
    } catch (err) {
      if (videoName) {
        await opfs.removeFile?.(videoName).catch?.(() => {});
      }
      if (audioName) {
        await opfs.removeFile?.(audioName).catch?.(() => {});
      }
      throw err;
    }
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

  /** 解析解密密钥（实现已收敛到 lib/hls-pipeline.js#resolveHlsKeyInfo） */
  async _resolveKeyInfo(pipeline, playlist, playlistText, playlistUrl, headers) {
    if (typeof pipeline.resolveHlsKeyInfo === 'function') {
      return pipeline.resolveHlsKeyInfo(playlist, playlistText, playlistUrl, headers, {});
    }
    return playlist.isEncrypted
      ? (await pipeline.parseHlsEncryption?.(playlistText, playlistUrl, headers)) || null
      : null;
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
      toMuxBuffer(videoBytes),
      toMuxBuffer(audioBytes)
    );
    console.log(`[HLS] 独立音轨合并完成 task=${taskMeta.taskId || 'none'} size=${(blob.size / 1024 / 1024).toFixed(2)} MB`);
    return new Uint8Array(await blob.arrayBuffer());
  }

  async _downloadMergedBlob(blob, filename, output, taskMeta = {}) {
    const pipeline = getHlsPipeline();
    const downloadFilename = await downloadPathUtils.applyDownloadSubdir?.(
      pipeline.ensureExtension(filename, output.ext)
    );

    const result = await submitBlobDownloadFromOffscreen(blob, downloadFilename, output.mimeType, taskMeta);
    if (result?.ok) {
      console.log(`[HLS] download submitted downloadId=${result.downloadId} filename="${downloadFilename}"`);
    }
    return result;
  }

  /**
   * OPFS 落盘后的下载交接：SW 无法创建对象 URL，由 offscreen 按文件名打开同一份
   * OPFS 文件生成 URL（不传输字节），下载结束/中断后由 SW 删除临时文件。
   */
  async _downloadOpfsBlob(opfsName, filename, output, taskMeta = {}) {
    const pipeline = getHlsPipeline();
    const downloadFilename = pipeline.ensureExtension(filename, output.ext);

    const result = await submitOpfsDownloadFromOffscreen(
      opfsName,
      downloadFilename,
      output.mimeType,
      taskMeta
    );

    if (result?.ok) {
      registerOpfsTempFile(result.downloadId, opfsName);
      console.log(`[HLS] OPFS 落盘已提交 downloadId=${result.downloadId} filename="${result.filename}"`);
    } else {
      // 提交失败（例如用户取消保存对话框）立刻回收，避免临时文件残留
      await releaseOpfsDownload({ name: opfsName });
    }

    return result;
  }
}
