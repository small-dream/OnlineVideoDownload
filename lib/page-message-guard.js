// lib/page-message-guard.js
// 页面上下文消息守卫：页面脚本可以伪造 postMessage（MAIN world 无法对页面保密），
// 因此来自页面方向的检测结果必须当作「不可信数据」校验后才允许进入注册表。
// 以 <script> 方式加载，暴露全局 __OVD_PAGE_MESSAGE_GUARD__。

'use strict';

(() => {
  if (globalThis.__OVD_PAGE_MESSAGE_GUARD__) {
    return;
  }

  // 允许页面上报的媒体类型（与 page-interceptor / youtube / bilibili 解析器一致）
  const ALLOWED_DETECTED_TYPES = new Set([
    'audio',
    'bilibili-dash',
    'bilibili-meta',
    'blob',
    'dash',
    'direct',
    'drm-detected',
    'hls',
    'youtube-adaptive',
  ]);

  // 只允许 http(s) 与 blob:；显式挡掉 file:、data:、chrome:、javascript:、filesystem:
  const ALLOWED_URL_SCHEMES = /^(?:https?|blob):/i;
  const MAX_URL_LENGTH = 8192;
  const MAX_TITLE_LENGTH = 512;

  function normalizeUrl(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function isAllowedMediaUrl(url) {
    const value = normalizeUrl(url);
    if (!value || value.length > MAX_URL_LENGTH) {
      return false;
    }
    if (!ALLOWED_URL_SCHEMES.test(value)) {
      return false;
    }
    // blob: 之后必须是具体 origin（blob:https://site/uuid），裸 blob: 一律拒绝
    if (/^blob:/i.test(value) && !/^blob:https?:\/\//i.test(value)) {
      return false;
    }
    return true;
  }

  /**
   * 校验页面上报的检测结果。
   * @returns {{ ok: boolean, reason?: string }}
   */
  function validateDetectedPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: 'payload 不是对象' };
    }

    const type = typeof payload.type === 'string' ? payload.type : '';
    if (!ALLOWED_DETECTED_TYPES.has(type)) {
      return { ok: false, reason: `未知媒体类型: ${type || '(empty)'}` };
    }

    if (!isAllowedMediaUrl(payload.url)) {
      return { ok: false, reason: 'URL 协议或长度不被允许' };
    }

    if (payload.title != null && String(payload.title).length > MAX_TITLE_LENGTH) {
      return { ok: false, reason: 'title 过长' };
    }

    return { ok: true };
  }

  globalThis.__OVD_PAGE_MESSAGE_GUARD__ = {
    ALLOWED_DETECTED_TYPES,
    MAX_URL_LENGTH,
    isAllowedMediaUrl,
    validateDetectedPayload,
  };
})();
