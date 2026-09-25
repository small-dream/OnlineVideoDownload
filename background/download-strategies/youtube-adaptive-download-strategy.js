import { injectHeaders } from '../header-injector.js';
import { submitDirectDownload } from './direct-download-strategy.js';
import { submitBlobDownloadFromOffscreen } from '../offscreen-download.js';
import { downloadStreamToOpfs, isStreamingMergeSupported, mergeOpfsStreamsAndDownload } from '../streaming-merge.js';
import '../../lib/byte-utils.js';
import '../../lib/http-utils.js';
import '../../lib/constants.js';
import '../../lib/message-types.js';
import '../../lib/mp4-muxer.js';
import '../../lib/bilibili-muxer.js';
import '../../lib/video-utils.js';
import '../../lib/youtube-stream-utils.js';

const byteUtils = globalThis.__OVD_BYTE_UTILS__ || {};
const constants = globalThis.__OVD_CONSTANTS__ || {};
const videoUtils = globalThis.__OVD_VIDEO_UTILS__ || {};
const streamUtils = globalThis.__OVD_YOUTUBE_STREAM_UTILS__ || {};

const MAX_BACKGROUND_MERGE_BYTES = constants.MAX_IN_PAGE_MERGE_BYTES || 1.5 * 1024 * 1024 * 1024;
const retryDelays = constants.STREAM_FETCH_RETRY_DELAYS || [0, 1000, 2500, 5000];
const YOUTUBE_PARALLEL_AUDIO_CHUNK_BYTES = constants.YOUTUBE_PARALLEL_AUDIO_CHUNK_BYTES || 1 * 1024 * 1024;
const YOUTUBE_PARALLEL_AUDIO_MIN_BYTES = constants.YOUTUBE_PARALLEL_AUDIO_MIN_BYTES || 1 * 1024 * 1024;
const YOUTUBE_PARALLEL_CHUNK_BYTES = constants.YOUTUBE_PARALLEL_CHUNK_BYTES || 8 * 1024 * 1024;
const YOUTUBE_PARALLEL_MAX_CONCURRENCY = constants.YOUTUBE_PARALLEL_MAX_CONCURRENCY || 4;
const YOUTUBE_PARALLEL_MIN_BYTES = constants.YOUTUBE_PARALLEL_MIN_BYTES || 16 * 1024 * 1024;
const STREAM_MERGE_THRESHOLD_BYTES = constants.STREAM_MERGE_THRESHOLD_BYTES || 512 * 1024 * 1024;

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return '';
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(value / 1024 / 1024).toFixed(0)} MB`;
}

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]+)$/);
    return match ? `.${match[1]}` : '';
  } catch {
    return '';
  }
}

function inferMediaExtension(url, mimeType) {
  const extFromPath = extFromUrl(url);
  if (extFromPath) return extFromPath;
  return videoUtils.inferExtensionFromMimeType?.(mimeType || 'video/mp4') || '.mp4';
}

function buildDirectFilename(meta, target) {
  const ext = inferMediaExtension(target?.url, target?.mimeType) || '.mp4';
  const heightLabel = target?.height ? `_${target.height}p` : '';
  return videoUtils.buildMediaFilename({
    ext,
    fallback: 'youtube_video',
    title: `${meta?.title || 'youtube_video'}${heightLabel}`,
  });
}

function buildMergeFilename(meta, videoStream) {
  return videoUtils.buildMediaFilename({
    ext: '.mp4',
    fallback: 'youtube_video',
    title: `${meta?.title || 'youtube_video'}_${videoStream?.height || 'video'}p`,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 这些工具已收敛到 lib/http-utils.js 与 lib/byte-utils.js（第四波 4.3），
// 原先此处存在一份拷贝并与库实现漂移。
const httpUtils = globalThis.__OVD_HTTP_UTILS__ || {};

const parseTotalBytesHintFromUrl = (url) => httpUtils.parseTotalBytesHintFromUrl?.(url) || 0;
const inferTotalBytesFromResponse = (response, loadedBytesBefore = 0, fallbackTotal = 0, requestUrl = '') =>
  httpUtils.inferTotalBytesFromResponse?.(response, loadedBytesBefore, fallbackTotal, requestUrl) || 0;
const buildRangeRequestHeaders = (headers, rangeStart = 0, rangeEnd = null) =>
  httpUtils.createRangeRequestHeaders?.(headers, rangeStart, rangeEnd) || { ...(headers || {}) };
const mergeUint8Chunks = (chunks, totalBytes = 0) =>
  byteUtils.concatUint8Arrays?.(chunks, totalBytes) || new Uint8Array(0);

function getParallelFetchConfig(label) {
  const isAudioStream = label === 'audio';
  return {
    chunkSize: isAudioStream ? YOUTUBE_PARALLEL_AUDIO_CHUNK_BYTES : YOUTUBE_PARALLEL_CHUNK_BYTES,
    concurrency: YOUTUBE_PARALLEL_MAX_CONCURRENCY,
    minBytes: isAudioStream ? YOUTUBE_PARALLEL_AUDIO_MIN_BYTES : YOUTUBE_PARALLEL_MIN_BYTES,
  };
}

async function fetchParallelRangeBuffer(url, label, headers, totalBytesHint = 0, onProgress = null) {
  const hintedTotalBytes = Math.max(Number(totalBytesHint) || 0, parseTotalBytesHintFromUrl(url));
  const { chunkSize, concurrency, minBytes } = getParallelFetchConfig(label);
  if (hintedTotalBytes > 0 && hintedTotalBytes < minBytes) {
    throw new Error(`${label} size ${hintedTotalBytes} below parallel threshold`);
  }

  onProgress?.(label, 0, hintedTotalBytes);

  const probeResponse = await fetch(url, {
    credentials: 'include',
    headers: buildRangeRequestHeaders(headers, 0, 0),
  });
  const totalBytes = inferTotalBytesFromResponse(probeResponse, 0, hintedTotalBytes, url);
  try {
    await probeResponse.body?.cancel?.();
  } catch (_err) {}

  if (probeResponse.status !== 206 || totalBytes <= 0 || totalBytes < minBytes) {
    throw new Error(`${label} range probe unsupported status=${probeResponse.status} total=${totalBytes}`);
  }

  const segments = [];
  for (let start = 0; start < totalBytes; start += chunkSize) {
    segments.push({
      end: Math.min(totalBytes - 1, start + chunkSize - 1),
      start,
    });
  }

  const buffers = new Array(segments.length);
  const abortController = new AbortController();
  let nextIndex = 0;
  let loadedBytes = 0;

  async function fetchSegment(index) {
    const segment = segments[index];
    const expectedBytes = segment.end - segment.start + 1;
    for (let attemptIndex = 0; attemptIndex < retryDelays.length; attemptIndex += 1) {
      if (abortController.signal.aborted) {
        throw new Error(`${label} segment ${index} aborted`);
      }

      const retryDelay = retryDelays[attemptIndex];
      if (retryDelay > 0) {
        await delay(retryDelay);
      }

      try {
        const response = await fetch(url, {
          credentials: 'include',
          headers: buildRangeRequestHeaders(headers, segment.start, segment.end),
          signal: abortController.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        if (response.status !== 206) {
          throw new Error(`expected 206, got ${response.status}`);
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== expectedBytes) {
          throw new Error(`expected ${expectedBytes} bytes, got ${bytes.byteLength}`);
        }

        buffers[index] = bytes;
        loadedBytes += bytes.byteLength;
        onProgress?.(label, loadedBytes, totalBytes);
        return;
      } catch (error) {
        if (abortController.signal.aborted) {
          throw new Error(`${label} segment ${index} aborted`);
        }
        if (attemptIndex === retryDelays.length - 1) {
          abortController.abort();
          throw new Error(`${label} segment ${index} failed: ${error.message}`);
        }
      }
    }
  }

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= segments.length) {
        return;
      }
      await fetchSegment(index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, segments.length) }, () => worker())
  );
  onProgress?.(label, totalBytes, totalBytes);
  return mergeUint8Chunks(buffers, totalBytes);
}

async function fetchResumableBuffer(url, label, headers, totalBytesHint = 0, onProgress = null) {
  const chunks = [];
  let loadedBytes = 0;
  let totalBytes = Math.max(Number(totalBytesHint) || 0, parseTotalBytesHintFromUrl(url));
  let lastReportedBytes = 0;
  const PROGRESS_REPORT_INTERVAL = 256 * 1024;

  for (let attemptIndex = 0; attemptIndex < retryDelays.length; attemptIndex++) {
    const retryDelay = retryDelays[attemptIndex];
    if (retryDelay > 0) {
      await delay(retryDelay);
    }

    const rangeStart = loadedBytes;
    try {
      const response = await fetch(url, {
        credentials: 'include',
        headers: buildRangeRequestHeaders(headers, rangeStart),
      });

      if (rangeStart > 0 && response.status === 200) {
        chunks.length = 0;
        loadedBytes = 0;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      totalBytes = inferTotalBytesFromResponse(response, rangeStart, totalBytes, url);
      if (!response.body || typeof response.body.getReader !== 'function') {
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        if (rangeStart > 0 && response.status !== 206) {
          chunks.length = 0;
          loadedBytes = 0;
        }
        chunks.push(bytes);
        loadedBytes += bytes.byteLength;
        break;
      }

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) {
          chunks.push(value);
          loadedBytes += value.length;
          if (onProgress && loadedBytes - lastReportedBytes >= PROGRESS_REPORT_INTERVAL) {
            lastReportedBytes = loadedBytes;
            onProgress(label, loadedBytes, totalBytes);
          }
        }
      }
      break;
    } catch (err) {
      if (attemptIndex === retryDelays.length - 1) {
        throw new Error(`${label} stream fetch failed: ${err.message}`);
      }
    }
  }

  // 使用实际接收的字节数分配，避免 totalBytes 不准确导致尾部填充零
  const merged = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.buffer;
}

async function fetchAdaptiveMediaBuffer(stream, label, headers, onProgress = null) {
  const totalBytesHint = Number(stream?.contentLength) || parseTotalBytesHintFromUrl(stream?.url || '');
  try {
    return await fetchParallelRangeBuffer(stream.url, label, headers, totalBytesHint, onProgress);
  } catch (parallelError) {
    console.warn(`[OVD][BG] YouTube parallel fetch fallback label=${label} error=${parallelError.message}`);
    return fetchResumableBuffer(stream.url, label, headers, totalBytesHint, onProgress);
  }
}

function selectTarget(meta, downloadOptions) {
  const exactCombinedTarget = downloadOptions.preferCombined && downloadOptions.resolution !== 'auto'
    ? streamUtils.pickCombinedStream?.(meta, {
      ...downloadOptions,
      fallbackToLowerQuality: false,
    })
    : null;
  if (exactCombinedTarget) {
    return { kind: 'combined', stream: exactCombinedTarget };
  }

  const videoStream = streamUtils.pickAdaptiveVideoStream?.(meta, downloadOptions);
  const audioStream = streamUtils.pickAdaptiveAudioStream?.(meta, downloadOptions);
  if (videoStream && audioStream) {
    return { audioStream, kind: 'adaptive', videoStream };
  }

  const fallbackCombinedTarget = downloadOptions.preferCombined
    ? streamUtils.pickCombinedStream?.(meta, downloadOptions)
    : null;
  if (fallbackCombinedTarget) {
    return { kind: 'combined', stream: fallbackCombinedTarget };
  }

  throw new Error('当前页面没有可用的 YouTube 下载流');
}

async function saveBlobViaBrowserDownload(blob, filename, context = {}, meta = {}) {
  const result = await submitBlobDownloadFromOffscreen(blob, filename, 'video/mp4', {
    sourceId: context.sourceId || 'youtube',
    strategyId: context.strategyId || 'youtube-adaptive-background',
    taskKey: context.taskKey || '',
    title: context.title || meta?.title || '',
    videoInfo: context.videoInfo || meta || null,
    videoUrl: context.videoUrl || meta?.url || '',
  });
  if (!result?.ok) {
    throw new Error(result?.error || 'Browser save failed');
  }
  return result;
}

/**
 * 大文件路径：视频/音频分别流式下载到 OPFS，再按片段读样本做"流式合并"，
 * 合并输出也落盘，最后由 offscreen 生成对象 URL 交给浏览器保存。
 * 峰值内存 ≈ 一个下载分块 + 一个 moof + 一个媒体片段，与文件体积解耦。
 */
async function mergeAdaptiveStreamsToDisk(meta, target, context) {
  const videoStream = target.videoStream;
  const audioStream = target.audioStream;
  const headers = meta?.requestHeaders || {};
  const corsOrigin = chrome?.runtime?.getURL ? chrome.runtime.getURL('').replace(/\/$/, '') : '';
  const cleanups = [];
  let audioName = '';
  let videoName = '';

  const report = (percent, phase) => {
    context.onTaskProgress?.(Math.max(0, Math.min(99, Math.round(percent))), { phase, status: 'running' });
  };
  const loaded = { audio: 0, video: 0 };
  const totals = {
    audio: Number(audioStream?.contentLength) || 0,
    video: Number(videoStream?.contentLength) || 0,
  };
  const onStreamProgress = (label, streamLoaded, streamTotal) => {
    if (label === 'video') {
      loaded.video = Number(streamLoaded) || 0;
      if (Number(streamTotal) > 0) totals.video = Number(streamTotal);
    } else if (label === 'audio') {
      loaded.audio = Number(streamLoaded) || 0;
      if (Number(streamTotal) > 0) totals.audio = Number(streamTotal);
    }
    const total = totals.video + totals.audio;
    if (total > 0) {
      report(((loaded.video + loaded.audio) / total) * 70, 'fetching');
    }
  };

  try {
    cleanups.push(await injectHeaders(videoStream.url, headers, { corsOrigin }));
    cleanups.push(await injectHeaders(audioStream.url, headers, { corsOrigin }));

    // 顺序下载：两条流都会写 OPFS，串行更稳（并发收益有限，瓶颈在磁盘）
    const video = await downloadStreamToOpfs({
      headers,
      label: 'video',
      onProgress: onStreamProgress,
      prefix: 'ovd-yt-video',
      url: videoStream.url,
    });
    videoName = video.name;
    console.log(`[OVD][BG] 视频流已落盘 name=${videoName} size=${formatBytes(video.byteLength)}`);

    const audio = await downloadStreamToOpfs({
      headers,
      label: 'audio',
      onProgress: onStreamProgress,
      prefix: 'ovd-yt-audio',
      url: audioStream.url,
    });
    audioName = audio.name;
    console.log(`[OVD][BG] 音频流已落盘 name=${audioName} size=${formatBytes(audio.byteLength)}`);

    const filename = `${buildMergeFilename(meta, videoStream)}.mp4`;
    const result = await mergeOpfsStreamsAndDownload({
      audioName,
      filename,
      onProgress: (percent) => report(70 + (Number(percent) || 0) * 0.29, Number(percent) >= 97 ? 'saving' : 'merging'),
      taskMeta: context.taskMeta || {},
      videoName,
    });

    // 输出文件已登记到 opfs-temp-registry（按 downloadId 清理），这里不再重复删
    videoName = '';
    audioName = '';
    return result;
  } catch (err) {
    const opfs = globalThis.__OVD_OPFS_SINK__ || {};
    if (videoName) {
      await opfs.removeFile?.(videoName).catch?.(() => {});
    }
    if (audioName) {
      await opfs.removeFile?.(audioName).catch?.(() => {});
    }
    throw err;
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (_err) {}
    }
  }
}

async function mergeAdaptiveStreams(meta, target, context) {
  const videoStream = target.videoStream;
  const audioStream = target.audioStream;
  console.log(
    `[OVD][BG] YouTube 合并选流 videoItag=${videoStream?.itag || '-'} audioItag=${audioStream?.itag || '-'} `
    + `audioTrack=${audioStream?.audioTrackName || '-'} audioDefault=${audioStream?.audioTrackIsDefault ? 'yes' : 'no'}`
  );
  const estimatedTotalBytes = (Number(videoStream?.contentLength) || 0) + (Number(audioStream?.contentLength) || 0);
  if (estimatedTotalBytes > MAX_BACKGROUND_MERGE_BYTES) {
    throw new Error(`当前清晰度预计需要抓取约 ${formatBytes(estimatedTotalBytes)}，浏览器内合并不稳定，请改用更低清晰度或录制模式`);
  }

  // 大文件走"流式合并落盘"：下载到 OPFS → 按片段读样本 → Mp4Muxer 边写边落盘。
  // 内存占用与文件体积解耦，避免 1.7GB 这类输入在内存合并里抛
  // "Array buffer allocation failed"。
  if (estimatedTotalBytes > STREAM_MERGE_THRESHOLD_BYTES && isStreamingMergeSupported()) {
    console.log(
      `[OVD][BG] 预计 ${formatBytes(estimatedTotalBytes)} 超过阈值 ${formatBytes(STREAM_MERGE_THRESHOLD_BYTES)}，`
      + '改走流式合并落盘（OPFS）'
    );
    return mergeAdaptiveStreamsToDisk(meta, target, context);
  }

  const headers = meta?.requestHeaders || {};
  const cleanups = [];
  const progressState = {
    audioLoaded: 0,
    audioTotal: Number(audioStream?.contentLength) || 0,
    videoLoaded: 0,
    videoTotal: Number(videoStream?.contentLength) || 0,
  };

  function reportFetchProgress(label, loadedBytes, totalBytes) {
    if (label === 'audio') {
      progressState.audioLoaded = Math.max(progressState.audioLoaded, Number(loadedBytes) || 0);
      if (Number(totalBytes) > 0) progressState.audioTotal = Math.max(progressState.audioTotal, Number(totalBytes) || 0);
    } else {
      progressState.videoLoaded = Math.max(progressState.videoLoaded, Number(loadedBytes) || 0);
      if (Number(totalBytes) > 0) progressState.videoTotal = Math.max(progressState.videoTotal, Number(totalBytes) || 0);
    }

    const loaded = progressState.audioLoaded + progressState.videoLoaded;
    const total = progressState.audioTotal + progressState.videoTotal;
    if (total > 0) {
      context.onTaskProgress?.(Math.min(95, Math.round((loaded / total) * 95)), {
        phase: 'fetching',
        status: 'running',
      });
    }
  }

  try {
    // injectHeaders 创建 declarativeNetRequest 规则，作为 fetch 的保底（如遇到跨域重定向导致 headers 被剥离时生效）
    // fetchResumableBuffer 内部也通过闭包直接将 headers 传给 fetch()，两套机制互为补充
    // 这些地址来自"直下客户端"（如 visionOS），可能与会话绑定：带上浏览器 Cookie，
    // 并让 CORS 响应头回显扩展来源（credentials:'include' 下 ACAO 不能是 *）
    const corsOrigin = chrome?.runtime?.getURL ? chrome.runtime.getURL('').replace(/\/$/, '') : '';
    cleanups.push(await injectHeaders(videoStream.url, headers, { corsOrigin }));
    cleanups.push(await injectHeaders(audioStream.url, headers, { corsOrigin }));

    const [videoBuffer, audioBuffer] = await Promise.all([
      fetchAdaptiveMediaBuffer(videoStream, 'video', headers, reportFetchProgress),
      fetchAdaptiveMediaBuffer(audioStream, 'audio', headers, reportFetchProgress),
    ]);

    const muxer = globalThis.BilibiliMuxer;
    if (!muxer?.mergeFmp4Streams) {
      throw new Error('BilibiliMuxer is not loaded');
    }

    const blob = await muxer.mergeFmp4Streams(videoBuffer, audioBuffer, (percent) => {
      context.onTaskProgress?.(percent, { phase: 'merging', status: 'running' });
    });

    const filename = buildMergeFilename(meta, videoStream);
    return saveBlobViaBrowserDownload(blob, filename, context, meta);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (_err) {}
    }
  }
}

export function createYouTubeAdaptiveDownloadStrategy() {
  return {
    id: 'youtube-adaptive-background',
    supports(videoInfo) {
      return videoInfo?.type === 'youtube-adaptive' && videoInfo?.downloadOptions?.mode === 'parse';
    },
    async download(videoInfo, context) {
      const downloadOptions = videoInfo?.downloadOptions || {};
      const target = selectTarget(videoInfo, downloadOptions);

      if (target.kind === 'combined') {
        // 注意：不要用"预检响应是 text/plain"来拦下载——现场环境里 CDN 会把
        // 有效媒体标成 text/plain，拦了等于把能用的文件拒之门外。
        // 文件名修正交给 downloads.onDeterminingFilename（见 download-filename-registry）。
        return submitDirectDownload({
          headers: videoInfo?.requestHeaders || {},
          filenameNoExt: buildDirectFilename(videoInfo, target.stream),
          type: 'video',
          url: target.stream.url,
        });
      }

      return mergeAdaptiveStreams(videoInfo, target, context);
    },
  };
}
