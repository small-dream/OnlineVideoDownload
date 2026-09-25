'use strict';

(() => {
  if (globalThis.__OVD_HTTP_UTILS__) {
    return;
  }

  /**
   * 从 Content-Range 头部解析总字节数
   * @param {string} contentRange
   * @returns {number}
   */
  function parseContentRangeTotal(contentRange) {
    const match = String(contentRange || '').match(/\/(\d+)$/);
    return match ? Number(match[1]) || 0 : 0;
  }

  /**
   * 从 URL 的查询参数中解析 clen（Content-Length 提示）
   * @param {string} url
   * @returns {number}
   */
  function parseTotalBytesHintFromUrl(url) {
    try {
      return Number(new URL(url).searchParams.get('clen')) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * 根据 Response 头部推断资源总字节数
   * @param {Response} response
   * @param {number} [loadedBytesBefore=0] - 断点续传前已下载的字节数
   * @param {number} [fallbackTotal=0] - 兜底总字节数
   * @param {string} [requestUrl=''] - 请求 URL（用于从 clen 参数提取提示）
   * @returns {number}
   */
  function inferTotalBytesFromResponse(response, loadedBytesBefore = 0, fallbackTotal = 0, requestUrl = '') {
    const contentRangeTotal = parseContentRangeTotal(response?.headers?.get?.('content-range'));
    if (contentRangeTotal > 0) {
      return contentRangeTotal;
    }

    const contentLength = Number(response?.headers?.get?.('content-length')) || 0;
    if ((response?.status || 0) === 206 && loadedBytesBefore > 0 && contentLength > 0) {
      return loadedBytesBefore + contentLength;
    }

    if (contentLength > 0) {
      return contentLength;
    }

    if (requestUrl) {
      const urlHint = parseTotalBytesHintFromUrl(requestUrl);
      if (urlHint > 0) {
        return urlHint;
      }
    }

    return fallbackTotal || 0;
  }

  /**
   * 生成 Range 头值；无有效范围时返回空串。
   * @param {number} [start=0]
   * @param {number|null} [end=null] - 闭区间结束字节；缺省表示到文件末尾
   */
  function createRangeHeaderValue(start = 0, end = null) {
    const offset = Math.max(0, Number(start) || 0);
    if (offset <= 0 && !Number.isFinite(end)) {
      return '';
    }

    if (Number.isFinite(end) && Number(end) >= offset) {
      return `bytes=${offset}-${Number(end)}`;
    }

    return `bytes=${offset}-`;
  }

  /**
   * 构造包含 Range 头部的请求头副本（先剔除原有 Range，避免重复/冲突）。
   * @param {object} headers - 原始请求头
   * @param {number} [start=0] - 起始字节偏移
   * @param {number|null} [end=null] - 可选结束字节（闭区间）
   * @returns {object}
   */
  function createRangeRequestHeaders(headers, start = 0, end = null) {
    const requestHeaders = {};
    Object.entries(headers || {}).forEach(([name, value]) => {
      if (String(name || '').toLowerCase() !== 'range') {
        requestHeaders[name] = value;
      }
    });

    const rangeValue = createRangeHeaderValue(start, end);
    if (rangeValue) {
      requestHeaders.Range = rangeValue;
    }
    return requestHeaders;
  }

  globalThis.__OVD_HTTP_UTILS__ = Object.freeze({
    createRangeHeaderValue,
    createRangeRequestHeaders,
    inferTotalBytesFromResponse,
    parseContentRangeTotal,
    parseTotalBytesHintFromUrl,
  });
})();
