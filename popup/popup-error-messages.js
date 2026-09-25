// popup/popup-error-messages.js
// Friendly error text mapping for popup display.
// Exposes globals so it can be loaded in classic script contexts and unit tested in Node.

'use strict';

(() => {
  if (globalThis.__OVD_POPUP__) {
    return;
  }

  // 错误码 → 中文友好文案（含可操作提示）
  const ERROR_CODE_TEXT = Object.freeze({
    YT_UNKNOWN: { text: 'YouTube 下载失败，可尝试切换下载模式后重试。' },
    YT_SIGNATURE_CIPHER_UNSUPPORTED: { text: '该视频使用了加密签名，暂不支持解析下载，可尝试切换为「录制模式」下载。' },
    YT_NO_STREAMS: { text: '未找到可下载的视频流，请刷新页面后重试，或尝试「录制模式」。' },
    YT_PARSE_TOO_LARGE: { text: '视频体积过大，无法通过解析模式下载，可尝试「录制模式」。' },
    YT_PARSE_FAILED: { text: 'YouTube 解析下载失败，可尝试切换为「录制模式」下载。' },
    YT_SAVE_FAILED: { text: '文件保存失败，请检查浏览器下载设置后重试。' },
    YT_CAPTURE_FAILED: { text: '录制下载失败，请保持页面处于前台播放状态后重试。' },
    YT_CAPTURE_VIDEO_NOT_FOUND: { text: '未找到页面内的视频元素，请开始播放视频后重试。' },
    YT_CAPTURE_PLAYBACK_FAILED: { text: '视频播放被页面阻止，请手动点击播放后再重试。' },
    YT_CAPTURE_UNSUPPORTED: { text: '当前浏览器或页面不支持录制模式，可尝试「解析下载」。' },
    HLS_SEGMENT_DOWNLOAD_FAILED: { text: '部分视频分片下载失败（重试后仍不可用），任务已中止，请稍后重试。' },
    HLS_KEY_FETCH_FAILED: { text: '获取视频加密密钥失败，请确认已登录该站点后重试。' },
    HLS_SEGMENT_DECRYPT_FAILED: { text: '视频分片解密失败，任务已中止。' },
    HLS_UNSUPPORTED_ENCRYPTION: { text: '该视频使用了不支持的加密方式，暂时无法下载。' },
  });

  // 无错误码时的消息关键词兜底（按顺序匹配，命中即停）
  const KEYWORD_ERROR_TEXT = Object.freeze([
    { pattern: /Receiving end does not exist/, text: '当前页面下载脚本未就绪，请刷新页面后重试。' },
    { pattern: /B站 API 错误|Bilibili/i, text: 'Bilibili 下载失败，请确认已登录 B 站账号后重试。' },
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
      return { text: ERROR_CODE_TEXT[normalizedCode].text, code: normalizedCode, friendly: true };
    }

    for (const { pattern, text } of KEYWORD_ERROR_TEXT) {
      if (rawMessage && pattern.test(rawMessage)) {
        return { text, code: normalizedCode, friendly: true };
      }
    }

    return { text: rawMessage || '未知错误', code: normalizedCode, friendly: false };
  }

  globalThis.__OVD_POPUP__ = Object.freeze({
    ERROR_CODE_TEXT,
    KEYWORD_ERROR_TEXT,
    buildFriendlyErrorMessage,
  });
})();
