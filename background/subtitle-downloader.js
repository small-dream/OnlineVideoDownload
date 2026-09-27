// background/subtitle-downloader.js
//
// 字幕侧车下载：在 SW 内取回字幕 → 统一转成 SRT → 交给浏览器下载。
//
// 页面只负责提供"轨道地址"（YouTube 来自 player response 的 captionTracks；
// Bilibili 需要页面 Cookie 的 player/v2），真正的取流/转换/保存都在 SW 完成：
// 既绕开页面的 CORS 限制，也不受"用户切走标签页"影响。

import '../lib/subtitle-utils.js';
import '../lib/video-utils.js';
import { submitBlobDownloadFromOffscreen } from './offscreen-download.js';

const subtitleUtils = globalThis.__OVD_SUBTITLE_UTILS__ || {};
const videoUtils = globalThis.__OVD_VIDEO_UTILS__ || {};

const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;

async function fetchSubtitleText(url, credentials = 'omit') {
  const response = await fetch(url, {
    credentials,
    headers: { Accept: 'text/plain,text/vtt,application/json,*/*' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const text = await response.text();
  if (text.length > MAX_SUBTITLE_BYTES) {
    throw new Error('字幕文件过大');
  }
  return text;
}

/**
 * 取回并解析字幕，返回 { cues, format, url }。全部尝试失败时抛出最后一次的错误。
 */
export async function fetchSubtitleCues(track = {}) {
  const url = String(track.url || '').trim();
  if (!url) {
    throw new Error('字幕地址为空');
  }

  const attempts = subtitleUtils.buildSubtitleFetchAttempts?.(url, track.format)
    || [{ credentials: 'omit', format: track.format || 'auto', url }];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const text = await fetchSubtitleText(attempt.url, attempt.credentials);
      const cues = subtitleUtils.parseSubtitleText?.(text, {
        contentType: attempt.contentType,
        format: attempt.format,
      }) || [];
      if (cues.length > 0) {
        return { cues, format: attempt.format, url: attempt.url };
      }
      lastError = new Error('字幕内容为空');
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('字幕下载失败');
}

/**
 * 下载一条字幕轨并保存为 .srt 侧车文件。
 * @param {{ url: string, languageCode?: string, languageName?: string, isAsr?: boolean, format?: string }} track
 * @param {{ sourceId?: string, title?: string, videoUrl?: string }} [options]
 * @returns {Promise<{ cues: number, downloadId: number|null, filename: string, format: string, ok: boolean, size: number }>}
 */
export async function downloadSubtitle(track = {}, options = {}) {
  const { cues, format } = await fetchSubtitleCues(track);
  const srt = subtitleUtils.cuesToSrt?.(cues) || '';
  const ext = subtitleUtils.DEFAULT_SUBTITLE_EXTENSION || '.srt';

  // 侧车文件名与媒体文件同源：同名标题 + 语言代码，落在同一目录便于播放器自动匹配
  const baseName = videoUtils.buildFilenameBase?.({
    fallback: 'video',
    title: options.title || '',
    type: 'video',
    url: options.videoUrl || '',
  }) || 'video';
  const filename = subtitleUtils.buildSubtitleFilename?.(baseName, track, ext)
    || `${baseName}.srt`;

  const mimeType = subtitleUtils.subtitleMimeTypeForExtension?.(ext) || 'application/x-subrip';
  const blob = new Blob([srt], { type: mimeType });
  const saved = await submitBlobDownloadFromOffscreen(blob, filename, mimeType, {
    sourceId: options.sourceId || 'generic',
    strategyId: 'subtitle',
    title: options.title || '',
    videoUrl: options.videoUrl || '',
  });
  if (!saved?.ok) {
    throw new Error(saved?.error || '字幕文件保存失败');
  }

  console.log(
    `[OVD] 字幕已保存 filename="${filename}" cues=${cues.length} format=${format} size=${blob.size}`
  );
  return {
    cues: cues.length,
    downloadId: saved.downloadId ?? null,
    filename: saved.filename || filename,
    format,
    ok: true,
    size: blob.size,
  };
}
