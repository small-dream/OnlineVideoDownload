'use strict';

// lib/preview-utils.js
// Popup 缩略图 / 内联预览补全的纯函数集合。
//
// 背景：Popup 里直接用 <video src=媒体直链> 取首帧当封面时，请求没有页面 Referer/Origin，
// 不少 CDN 会直接 403，条目就只剩占位图标。补全流程改为：
//   1) 弹出条目的直连预览失败后，由 Popup 向 background 申请临时 DNR 请求头规则；
//   2) Popup 自己 fetch 媒体（扩展页有 host 权限，不受 CORS 限制）；
//   3) 只读取前缀若干字节（避免为了封面下载整部影片），做成同源 blob URL。
// 该 blob 既能用 canvas 截一帧当静态封面，也能在鼠标悬停时直接播放。
//
// 这些函数不碰 DOM / chrome API，便于单元测试。

(() => {
  if (globalThis.__OVD_PREVIEW_UTILS__) {
    return;
  }

  // 单个条目最多读取的预览字节数：足够解出首帧并播放数秒；2.5MB ≈ 4Mbps 下 5 秒。
  const DEFAULT_PREVIEW_MAX_BYTES = 2621440;
  // 只有渐进式直链（mp4/webm）能靠前缀 blob 解码，HLS/DASH/blob 需要各自的解封装链路。
  const PREVIEWABLE_TYPES = new Set(['direct']);
  const MEDIA_MIME_PATTERN = /^(?:video|audio)\//i;
  const THUMBNAIL_DATA_URL_PATTERN = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,/i;

  function isHttpUrl(url) {
    return /^https?:\/\//i.test(String(url || '').trim());
  }

  function isPreviewableType(type) {
    return PREVIEWABLE_TYPES.has(String(type || '').trim());
  }

  /**
   * 是否需要为这个条目做「带请求头的预览补全」。
   * @param {Object} video
   * @param {{ directPreviewFailed?: boolean }} [options] 直连预览是否已经失败（默认视为失败）
   */
  function shouldMaterializePreview(video, options = {}) {
    if (!isPreviewableType(video?.type)) {
      return false;
    }
    if (!isHttpUrl(video?.url)) {
      return false;
    }
    return options.directPreviewFailed !== false;
  }

  function previewCacheKey(video) {
    return String(video?.url || '').trim();
  }

  /** 决定 blob 的 MIME：优先响应头，其次检测结果，最后按 mp4 兜底 */
  function resolvePreviewMimeType(video, responseMimeType) {
    const fromResponse = String(responseMimeType || '').split(';')[0].trim();
    if (MEDIA_MIME_PATTERN.test(fromResponse)) {
      return fromResponse;
    }

    const declared = String(video?.mimeType || '').split(';')[0].trim();
    if (MEDIA_MIME_PATTERN.test(declared)) {
      return declared;
    }

    return 'video/mp4';
  }

  /** <source type> 属性：HLS 清单必须是清单 MIME，否则浏览器不会去解析 */
  function resolvePreviewSourceType(video) {
    if (video?.type === 'hls') {
      return 'application/vnd.apple.mpegurl';
    }

    const declared = String(video?.mimeType || '').split(';')[0].trim();
    return MEDIA_MIME_PATTERN.test(declared) ? declared : 'video/mp4';
  }

  function normalizePreviewByteLimit(limit) {
    const value = Number(limit);
    if (!Number.isFinite(value) || value <= 0) {
      return DEFAULT_PREVIEW_MAX_BYTES;
    }
    return Math.floor(value);
  }

  /**
   * 限长读取响应体：达到上限就取消剩余读取，避免为了封面把整部影片拉下来。
   * 返回 `{ blob, bytes, truncated }`；body 不可流式读取时退回 arrayBuffer。
   */
  async function readPrefixBlob(response, options = {}) {
    const maxBytes = normalizePreviewByteLimit(options.limit);
    const mimeType = String(options.mimeType || 'video/mp4');
    const declaredLength = Number(response?.headers?.get?.('content-length')) || 0;

    if (!response || typeof response.body?.getReader !== 'function') {
      if (!response || typeof response.arrayBuffer !== 'function') {
        return { blob: null, bytes: 0, truncated: false };
      }
      const buffer = await response.arrayBuffer();
      const sliced = buffer.byteLength > maxBytes ? buffer.slice(0, maxBytes) : buffer;
      return {
        blob: new Blob([sliced], { type: mimeType }),
        bytes: sliced.byteLength,
        truncated: buffer.byteLength > maxBytes || declaredLength > maxBytes,
      };
    }

    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    let truncated = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || !value.byteLength) {
          continue;
        }

        const remaining = maxBytes - bytes;
        if (value.byteLength >= remaining) {
          chunks.push(value.subarray(0, remaining));
          bytes += remaining;
          truncated = true;
          break;
        }

        chunks.push(value);
        bytes += value.byteLength;
      }
    } finally {
      if (truncated) {
        try {
          await reader.cancel();
        } catch (_err) {
          // 取消失败不影响已读取的前缀
        }
      }
    }

    return {
      blob: new Blob(chunks, { type: mimeType }),
      bytes,
      truncated: truncated || declaredLength > bytes,
    };
  }

  /** 只在 background 校验通过的前提下使用：http(s) 图片地址或 base64 图片 data URL */
  function isSafeThumbnail(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) {
      return false;
    }
    return THUMBNAIL_DATA_URL_PATTERN.test(raw) || /^https?:\/\//i.test(raw);
  }

  // 会被 CSS url("...") 解析器当作语法字符的字符：引号、反斜杠、括号、换行
  const CSS_URL_ESCAPE_PATTERN = /[\\"'\n\r\t()]/g;

  /**
   * 生成可安全放进 CSS url("...") 的字符串，防止封面地址里的引号/括号截断样式。
   * 注意 encodeURIComponent 不会转义 `'`、`(`、`)`，必须自己转成 %XX。
   */
  function escapeCssUrl(value) {
    return String(value || '').replace(CSS_URL_ESCAPE_PATTERN, (char) => (
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
    ));
  }

  globalThis.__OVD_PREVIEW_UTILS__ = {
    DEFAULT_PREVIEW_MAX_BYTES,
    escapeCssUrl,
    isHttpUrl,
    isPreviewableType,
    isSafeThumbnail,
    normalizePreviewByteLimit,
    previewCacheKey,
    readPrefixBlob,
    resolvePreviewMimeType,
    resolvePreviewSourceType,
    shouldMaterializePreview,
  };
})();
