// background/streaming-merge.js
// 大文件（YouTube 自适应流 / HLS 独立音轨）的"流式合并落盘"：
//
//   ① 视频流、音频流分别按 Range 分块下载，边下边写入 OPFS（内存只留一个分块）
//   ② 用 lib/fmp4-file-merge.js 从两个 OPFS 文件按片段读取样本，喂给 Mp4Muxer，
//      输出直接写进第三个 OPFS 文件（峰值内存 ≈ 一个分块 + 一个 moof）
//   ③ 交给 offscreen 生成对象 URL 并用 chrome.downloads 保存
//
// 与内存版合并的区别：峰值内存与文件体积解耦，1.7GB 甚至更大都不再抛
// "Array buffer allocation failed"；代价是需要磁盘空间（OPFS 上限 8GB）。

import '../lib/byte-utils.js';
import '../lib/constants.js';
import '../lib/mp4-muxer.js';
import '../lib/bilibili-muxer.js';
import '../lib/fmp4-file-merge.js';
import '../lib/opfs-sink.js';
import { registerOpfsTempFile } from './opfs-temp-registry.js';
import { submitOpfsDownloadFromOffscreen } from './offscreen-download.js';

// 全局对象一律懒取：测试可以替换 __OVD_OPFS_SINK__ / fetch，不受加载顺序影响
const getByteUtils = () => globalThis.__OVD_BYTE_UTILS__ || {};
const getConstants = () => globalThis.__OVD_CONSTANTS__ || {};
const getFileMerge = () => globalThis.__OVD_FMP4_FILE_MERGE__ || {};
const getOpfs = () => globalThis.__OVD_OPFS_SINK__ || {};

const getStreamChunkBytes = () => getConstants().STREAM_MERGE_CHUNK_BYTES || 8 * 1024 * 1024;
const getRetryDelays = () => getConstants().STREAM_FETCH_RETRY_DELAYS || [0, 1000, 2500, 5000];

export function isStreamingMergeSupported() {
  const opfs = getOpfs();
  const fileMerge = getFileMerge();
  return typeof opfs.createOpfsSink === 'function'
    && typeof opfs.isSupported === 'function'
    && opfs.isSupported()
    && typeof fileMerge.prepareFmp4FileMerge === 'function';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function concatBytes(chunks, totalBytes) {
  const byteUtils = getByteUtils();
  if (typeof byteUtils.concatUint8Arrays === 'function') {
    return byteUtils.concatUint8Arrays(chunks, totalBytes);
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * 按 Range 分块下载一条流并顺序写入 OPFS sink。
 * 内存占用 = 单个分块；服务器不支持 Range 时退化为整段流式读取。
 *
 * @returns {Promise<{byteLength: number, name: string}>}
 */
export async function downloadStreamToOpfs({ headers = {}, label = 'stream', onProgress = null, prefix = 'ovd-merge', url }) {
  const opfs = getOpfs();
  const STREAM_CHUNK_BYTES = getStreamChunkBytes();
  const STREAM_RETRY_DELAYS = getRetryDelays();
  if (!url) {
    throw new Error(`${label} 下载地址为空`);
  }
  if (typeof opfs.createOpfsSink !== 'function') {
    throw new Error('OPFS 不可用，无法流式落盘');
  }

  const sink = await opfs.createOpfsSink({ prefix });

  try {
    let offset = 0;
    let totalBytes = 0;
    let rangeSupported = true;

    while (true) {
      let response = null;
      let lastError = null;

      for (let attempt = 0; attempt < STREAM_RETRY_DELAYS.length; attempt += 1) {
        if (STREAM_RETRY_DELAYS[attempt] > 0) {
          await delay(STREAM_RETRY_DELAYS[attempt]);
        }
        try {
          response = await fetch(url, {
            credentials: 'include',
            headers: rangeSupported
              ? { ...headers, Range: `bytes=${offset}-${offset + STREAM_CHUNK_BYTES - 1}` }
              : { ...headers },
          });
          if (response.status === 416 && offset > 0) {
            // 已经读到文件末尾
            response = null;
            lastError = null;
            break;
          }
          if (!response.ok && response.status !== 206) {
            throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
          }
          if (rangeSupported && response.status !== 206 && offset > 0) {
            console.warn(`[OVD][STREAM-MERGE] ${label} 服务器忽略 Range，改为整段读取`);
            rangeSupported = false;
            offset = 0;
            await sink.remove();
            return downloadStreamToOpfs({ headers, label, onProgress, prefix, url });
          }
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          console.warn(`[OVD][STREAM-MERGE] ${label} 分块下载失败 offset=${offset} attempt=${attempt + 1}: ${err.message}`);
        }
      }

      if (lastError) {
        throw lastError;
      }
      if (!response) {
        break; // 416：正常结束
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        break;
      }

      await sink.write(bytes);
      offset += bytes.byteLength;
      totalBytes += bytes.byteLength;
      onProgress?.(label, totalBytes, totalBytes);

      const contentRange = response.headers?.get?.('content-range') || '';
      const declaredTotal = Number(String(contentRange).split('/').pop()) || 0;
      if (declaredTotal > 0 && offset >= declaredTotal) {
        break;
      }
      if (!rangeSupported && bytes.byteLength < STREAM_CHUNK_BYTES) {
        break;
      }
    }

    const result = await sink.finalize();
    return { byteLength: result.byteLength, name: result.name };
  } catch (err) {
    await sink.remove().catch(() => {});
    throw err;
  }
}

/** 打开 OPFS 文件并返回 {size, readRange} 视图，供流式合并按需读取 */
async function openOpfsSource(name) {
  const opfs = getOpfs();
  const entry = await opfs.readFile?.(name);
  const file = entry?.file || entry?.blob || entry;
  if (!file || typeof file.slice !== 'function') {
    throw new Error(`无法读取 OPFS 文件 ${name}`);
  }

  return {
    readRange: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
    size: Number(file.size) || 0,
  };
}

/**
 * 流式合并两路已落盘的 fMP4，并把结果交给浏览器保存。
 *
 * @returns {Promise<{downloadId: number|null, filename: string, ok: true, size: number}>}
 */
export async function mergeOpfsStreamsAndDownload({
  audioName,
  filename,
  mimeType = 'video/mp4',
  onProgress = null,
  taskMeta = {},
  videoName,
}) {
  const opfs = getOpfs();
  const fileMerge = getFileMerge();
  const STREAM_CHUNK_BYTES = getStreamChunkBytes();
  if (!isStreamingMergeSupported()) {
    throw new Error('当前环境不支持流式合并落盘（OPFS 不可用）');
  }

  const Mp4Muxer = fileMerge.getMp4Muxer?.() || {};
  if (typeof Mp4Muxer.Muxer !== 'function' || typeof Mp4Muxer.StreamTarget !== 'function') {
    throw new Error('Mp4Muxer 不支持流式输出');
  }

  const outputSink = await opfs.createOpfsSink({ prefix: 'ovd-merged' });
  const writable = outputSink;

  try {
    const prepared = await fileMerge.prepareFmp4FileMerge({
      audio: await openOpfsSource(audioName),
      onProgress,
      video: await openOpfsSource(videoName),
    });

    const width = prepared.videoDimensions?.width || 1920;
    const height = prepared.videoDimensions?.height || 1080;
    // Mp4Muxer 的 onData 不 await 返回值：自己收集写入 Promise，
    // finalize 之后等它们全部落地再关闭文件（否则可能丢尾部/moov）
    const pendingWrites = [];
    const muxer = new Mp4Muxer.Muxer({
      audio: prepared.audioDecoderConfig
        ? {
          codec: prepared.audioDecoderConfig.codec,
          numberOfChannels: prepared.audioDecoderConfig.numberOfChannels,
          sampleRate: prepared.audioDecoderConfig.sampleRate,
        }
        : undefined,
      // 非 fastStart：moov 在末尾写出，才能边写样本边落盘（不缓存整段输出）
      fastStart: false,
      firstTimestampBehavior: 'offset',
      target: new Mp4Muxer.StreamTarget({
        chunkSize: STREAM_CHUNK_BYTES,
        chunked: true,
        // 位置是输出文件的绝对偏移：OPFS 支持定位写
        onData: (data, position) => {
          const task = writable.writeAt(position, data);
          pendingWrites.push(task);
          return task;
        },
      }),
      video: {
        codec: prepared.videoDecoderConfig?.codec,
        height,
        width,
      },
    });

    await fileMerge.writePreparedFmp4({ muxer, onProgress, prepared });
    muxer.finalize();
    await Promise.all(pendingWrites);
    const output = await outputSink.finalize();
    onProgress?.(97, { phase: 'saving' });

    const downloadResult = await submitOpfsDownloadFromOffscreen(output.name, filename, mimeType, taskMeta);
    if (!downloadResult?.ok) {
      await opfs.removeFile?.(output.name).catch(() => {});
      throw new Error(downloadResult?.error || '保存合并结果失败');
    }

    registerOpfsTempFile(downloadResult.downloadId, output.name);
    onProgress?.(100, { phase: 'complete' });

    return {
      downloadId: downloadResult.downloadId ?? null,
      filename: downloadResult.filename || filename,
      ok: true,
      size: output.byteLength,
    };
  } catch (err) {
    await outputSink.remove().catch(() => {});
    throw err;
  }
}

export { concatBytes };
