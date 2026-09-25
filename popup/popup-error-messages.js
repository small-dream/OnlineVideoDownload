// popup/popup-error-messages.js
// Friendly error text mapping for popup display.
// Exposes globals so it can be loaded in classic script contexts and unit tested in Node.

'use strict';

(() => {
  if (globalThis.__OVD_POPUP__) {
    return;
  }

  // 国际化：优先 chrome.i18n；未加载/缺 key 时退回中文原文（见 lib/i18n.js）
  const i18n = globalThis.__OVD_I18N__ || {};
  const t = typeof i18n.t === 'function' ? i18n.t : (_key, fallback) => fallback;

  // 错误码 → 友好文案（key + 中文兜底，含可操作提示）
  const ERROR_CODE_TEXT = Object.freeze({
    YT_UNKNOWN: { key: 'err_yt_unknown', text: 'YouTube 下载失败，可尝试切换下载模式后重试。' },
    YT_SIGNATURE_CIPHER_UNSUPPORTED: { key: 'err_yt_signature', text: '该视频使用了加密签名，暂不支持解析下载，可尝试切换为「录制模式」下载。' },
    YT_NO_STREAMS: { key: 'err_yt_noStreams', text: '未找到可下载的视频流，请刷新页面后重试，或尝试「录制模式」。' },
    YT_PARSE_TOO_LARGE: { key: 'err_yt_tooLarge', text: '视频体积过大，无法通过解析模式下载，可尝试「录制模式」。' },
    YT_PARSE_FAILED: { key: 'err_yt_parseFailed', text: 'YouTube 解析下载失败，可尝试切换为「录制模式」下载。' },
    YT_SAVE_FAILED: { key: 'err_yt_saveFailed', text: '文件保存失败，请检查浏览器下载设置后重试。' },
    YT_CAPTURE_FAILED: { key: 'err_yt_captureFailed', text: '录制下载失败，请保持页面处于前台播放状态后重试。' },
    YT_CAPTURE_VIDEO_NOT_FOUND: { key: 'err_yt_videoNotFound', text: '未找到页面内的视频元素，请开始播放视频后重试。' },
    YT_CAPTURE_PLAYBACK_FAILED: { key: 'err_yt_playbackBlocked', text: '视频播放被页面阻止，请手动点击播放后再重试。' },
    YT_CAPTURE_UNSUPPORTED: { key: 'err_yt_captureUnsupported', text: '当前浏览器或页面不支持录制模式，可尝试「解析下载」。' },
    HLS_SEGMENT_DOWNLOAD_FAILED: { key: 'err_hls_segmentFailed', text: '部分视频分片下载失败（重试后仍不可用），任务已中止，请稍后重试。' },
    HLS_KEY_FETCH_FAILED: { key: 'err_hls_keyFailed', text: '获取视频加密密钥失败，请确认已登录该站点后重试。' },
    HLS_SEGMENT_DECRYPT_FAILED: { key: 'err_hls_decryptFailed', text: '视频分片解密失败，任务已中止。' },
    HLS_UNSUPPORTED_ENCRYPTION: { key: 'err_hls_encryption', text: '该视频使用了不支持的加密方式，暂时无法下载。' },
    HLS_CONTENT_SIZE_SKIP: { key: 'err_hls_sizeSkip', text: '该视频体积超出浏览器内合并上限，已改为后台落盘下载。' },
    HLS_OUTPUT_TOO_LARGE: { key: 'err_hls_tooLarge', text: '视频体积超出浏览器内合并上限，已中止下载，可尝试降低清晰度。' },
    DASH_OUTPUT_TOO_LARGE: { key: 'err_dash_tooLarge', text: 'DASH 流体积超出浏览器内合并上限，将分别保存视频与音频文件。' },
    OPFS_WRITE_FAILED: { key: 'err_diskFull', text: '写入临时文件失败（可能是磁盘空间或存储配额不足），已中止下载。' },
    DOWNLOAD_ABORTED: { key: 'err_aborted', text: '下载已取消。' },
  });

  // 无错误码时的消息关键词兜底（按顺序匹配，命中即停）。
  // 中英关键词都要有：抛错文案本身可能来自任一语言。
  const KEYWORD_ERROR_TEXT = Object.freeze([
    { pattern: /Receiving end does not exist/, text: '当前页面下载脚本未就绪，请刷新页面后重试。' },
    {
      key: 'err_bilibili',
      pattern: /B站 API 错误|Bilibili|Bilibili download failed/i,
      text: 'Bilibili 下载失败，请确认已登录 B 站账号后重试。',
    },
    {
      key: 'err_httpForbidden',
      pattern: /HTTP 403|403 Forbidden/i,
      text: '服务器拒绝了下载请求（403），请确认已登录该站点或刷新页面后重试。',
    },
    {
      key: 'err_loginRequired',
      pattern: /未登录|请登录|login required|not logged in/i,
      text: '该视频需要登录后才能下载，请先登录站点账号。',
    },
    {
      key: 'err_drm',
      pattern: /DRM|Widevine|PlayReady/i,
      text: '该视频受 DRM 保护，无法下载。',
    },
    {
      key: 'err_timeout',
      pattern: /timeout|超时/i,
      text: '下载请求超时，请检查网络后重试。',
    },
    {
      key: 'err_noSegments',
      pattern: /没有找到分片|No segments found/i,
      text: '未在播放列表中找到可下载的分片，请刷新页面后重试。',
    },
  ]);

  /**
   * 把带 code/message 的错误对象转成友好文案。
   * @param {{ code?: string, message?: string }} errLike
   * @returns {{ text: string, code: string, friendly: boolean }}
   *   friendly 为 true 表示命中映射表；text 可直接展示给用户。
   */
  function buildFriendlyErrorMessage({ code = '', message = '' } = {}) {
    const rawMessage = String(message || '').trim();
    const normalizedCode = String(code || '').trim();

    if (normalizedCode && ERROR_CODE_TEXT[normalizedCode]) {
      const entry = ERROR_CODE_TEXT[normalizedCode];
      return { text: t(entry.key, entry.text), code: normalizedCode, friendly: true };
    }

    for (const { key, pattern, text } of KEYWORD_ERROR_TEXT) {
      if (rawMessage && pattern.test(rawMessage)) {
        return { text: key ? t(key, text) : text, code: normalizedCode, friendly: true };
      }
    }

    return {
      text: rawMessage || t('error_unknown', '未知错误'),
      code: normalizedCode,
      friendly: false,
    };
  }

  globalThis.__OVD_POPUP__ = Object.freeze({
    ERROR_CODE_TEXT,
    KEYWORD_ERROR_TEXT,
    buildFriendlyErrorMessage,
  });
})();
