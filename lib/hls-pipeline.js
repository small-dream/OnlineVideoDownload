'use strict';

(() => {
  if (globalThis.__OVD_HLS_PIPELINE__) {
    return;
  }

  function parseAttributeList(attrText) {
    const attrs = {};
    const attrRegex = /(\w+)=(?:"([^"]*)"|([\w/.:%-]*))/g;
    let match;
    while ((match = attrRegex.exec(attrText || '')) !== null) {
      attrs[match[1]] = match[2] !== undefined ? match[2] : match[3];
    }
    return attrs;
  }

  function parseHlsIV(ivStr) {
    const hex = String(ivStr || '').replace(/^0x/i, '');
    const buffer = new Uint8Array(16);
    for (let i = 0; i < 16 && (i * 2) < hex.length; i++) {
      buffer[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return buffer.buffer;
  }

  function resolveHlsUrl(resourceUrl, baseUrl) {
    const base = new URL(baseUrl);
    const resolved = new URL(resourceUrl, base);
    const isRelative = !/^(?:[a-z]+:)?\/\//i.test(resourceUrl);
    if (isRelative && !resourceUrl.includes('?') && base.search && !resolved.search) {
      resolved.search = base.search;
    }
    return resolved.href;
  }

  function parseHlsPlaylist(m3u8, baseUrl) {
    const segments = [];
    let initSegmentUrl = null;

    for (const line of String(m3u8 || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      try {
        segments.push(resolveHlsUrl(trimmed, baseUrl));
      } catch (err) {
        console.warn(`[OVD][HLS] failed to resolve segment URL "${trimmed}": ${err.message}`);
      }
    }

    const mapMatch = String(m3u8 || '').match(/#EXT-X-MAP:([^\n]+)/);
    if (mapMatch) {
      const attrs = parseAttributeList(mapMatch[1]);
      if (attrs.URI) {
        try {
          initSegmentUrl = resolveHlsUrl(attrs.URI, baseUrl);
        } catch (err) {
          console.warn(`[OVD][HLS] failed to resolve init segment URL: ${err.message}`);
          initSegmentUrl = null;
        }
      }
    }

    return { initSegmentUrl, segments };
  }

  function selectBestHlsStream(masterM3u8, baseUrl) {
    const lines = String(masterM3u8 || '').split('\n');
    let bestBandwidth = -1;
    let bestUrl = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF')) {
        continue;
      }

      const bandwidth = parseInt(line.match(/BANDWIDTH=(\d+)/i)?.[1] || '0', 10);
      const nextLine = lines[i + 1]?.trim();

      if (nextLine && !nextLine.startsWith('#') && bandwidth >= bestBandwidth) {
        bestBandwidth = bandwidth;
        try {
          bestUrl = resolveHlsUrl(nextLine, baseUrl);
        } catch (err) {
          console.warn(`[OVD][HLS] failed to resolve best stream URL: ${err.message}`);
          bestUrl = nextLine;
        }
      }
    }

    return bestUrl || baseUrl;
  }

  /**
   * 统一的 HLS 请求入口。
   * options.credentials 用于页面上下文请求：content script 里带 Cookie 的跨域请求
   * 若被目标站点 CORS 拒绝（抛 TypeError），自动退化为默认凭证模式重试一次。
   */
  async function hlsFetch(url, headers, options = {}) {
    const init = { headers: headers || {} };
    if (options.credentials) {
      init.credentials = options.credentials;
    }

    try {
      return await fetch(url, init);
    } catch (err) {
      if (!init.credentials || init.credentials === 'same-origin') {
        throw err;
      }

      console.warn(`[OVD][HLS] 带凭证请求失败（${err.message}），改用默认凭证模式重试: ${url}`);
      return fetch(url, { headers: init.headers });
    }
  }

  async function hlsFetchText(url, headers, options = {}) {
    const response = await hlsFetch(url, headers, options);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    return response.text();
  }

  async function hlsFetchBuffer(url, headers, options = {}) {
    const response = await hlsFetch(url, headers, options);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    return response.arrayBuffer();
  }

  async function parseHlsEncryption(m3u8, baseUrl, headers, options = {}) {
    const keyMatch = String(m3u8 || '').match(/#EXT-X-KEY:([^\n]+)/);
    if (!keyMatch) {
      return null;
    }

    const attrs = parseAttributeList(keyMatch[1]);
    const method = String(attrs.METHOD || '').toUpperCase();
    if (!method || method === 'NONE') {
      return null;
    }

    if (method !== 'AES-128') {
      const err = new Error(`不支持的 HLS 加密方式: ${method}，仅支持 AES-128`);
      err.code = 'HLS_UNSUPPORTED_ENCRYPTION';
      throw err;
    }

    if (!attrs.URI) {
      const err = new Error('HLS AES-128 密钥缺少 URI');
      err.code = 'HLS_KEY_FETCH_FAILED';
      throw err;
    }

    const keyUrl = resolveHlsUrl(attrs.URI, baseUrl);
    try {
      const keyBuffer = await hlsFetchBuffer(keyUrl, headers, options);
      const cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-CBC' }, false, ['decrypt']);
      return {
        iv: attrs.IV ? parseHlsIV(attrs.IV) : null,
        key: cryptoKey,
      };
    } catch (err) {
      const wrapped = new Error(`HLS 密钥获取失败 (${keyUrl}): ${err.message}`);
      wrapped.code = 'HLS_KEY_FETCH_FAILED';
      wrapped.cause = err;
      throw wrapped;
    }
  }

  async function decryptHlsSegments(buffers, keyInfo) {
    const decrypted = [];

    for (let i = 0; i < buffers.length; i++) {
      const buffer = buffers[i];
      if (!buffer || buffer.byteLength === 0) {
        decrypted.push(buffer);
        continue;
      }

      let iv = keyInfo.iv;
      if (!iv) {
        iv = new ArrayBuffer(16);
        new DataView(iv).setUint32(12, i, false);
      }

      try {
        decrypted.push(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, keyInfo.key, buffer));
      } catch (err) {
        // 解密失败不得回退使用密文，直接中止，避免产出损坏文件
        const wrapped = new Error(`HLS 分片 ${i} 解密失败: ${err.message}`);
        wrapped.code = 'HLS_SEGMENT_DECRYPT_FAILED';
        wrapped.cause = err;
        wrapped.segmentIndex = i;
        throw wrapped;
      }
    }

    return decrypted;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchSegmentWithRetry(url, fetchOne, retryDelays) {
    let lastError = null;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      if (attempt > 0) {
        await sleep(retryDelays[attempt - 1]);
      }
      try {
        return { buffer: await fetchOne(url), retried: attempt > 0 };
      } catch (err) {
        lastError = err;
        console.warn(`[OVD][HLS] 分片第 ${attempt + 1} 次请求失败: ${url} (${err.message})`);
      }
    }
    return { error: lastError };
  }

  /**
   * 并发下载分片（background/content 共用的 fail-fast 实现）。
   * 每个失败分片按 retryDelays 指数退避重试；最终失败数超过阈值时抛出
   * HLS_SEGMENT_DOWNLOAD_FAILED 中止整个任务，绝不产出含空洞的文件。
   * 分片总数 ≤ 10 时任何失败都会中止（阈值取 floor，小列表零容忍）。
   */
  async function downloadHlsSegments(urls, options = {}) {
    const constants = globalThis.__OVD_CONSTANTS__ || {};
    const concurrency = options.concurrency || constants.HLS_SEGMENT_CONCURRENCY || 5;
    const maxFailedRatio = options.maxFailedRatio ?? constants.HLS_MAX_FAILED_RATIO ?? 0.1;
    const retryDelays = options.retryDelays || constants.HLS_SEGMENT_RETRY_DELAYS || [500, 1000, 2000];
    const onProgress = options.onProgress || null;
    const fetchOne = options.fetchBuffer
      ? (url) => options.fetchBuffer(url)
      : (url) => hlsFetchBuffer(url, options.headers, options.fetchOptions);

    const total = urls.length;
    const maxFailed = total <= 10 ? 0 : Math.floor(total * maxFailedRatio);
    const buffers = new Array(total).fill(null);
    let done = 0;
    let failedCount = 0;
    let retriedCount = 0;

    for (let i = 0; i < total; i += concurrency) {
      const batch = urls.slice(i, Math.min(i + concurrency, total));
      const results = await Promise.all(
        batch.map((url, batchIdx) => fetchSegmentWithRetry(url, fetchOne, retryDelays)
          .then((result) => ({ ...result, idx: i + batchIdx })))
      );

      for (const result of results) {
        if (result.error) {
          failedCount++;
          buffers[result.idx] = new ArrayBuffer(0);
        } else {
          if (result.retried) {
            retriedCount++;
          }
          buffers[result.idx] = result.buffer;
        }

        done++;
        onProgress?.(done, total, { failedCount, retriedCount });
      }

      if (failedCount > maxFailed) {
        const err = new Error(
          `分片下载失败数超过阈值：${failedCount}/${total} 个分片失败（最多允许 ${maxFailed} 个），已中止下载`
        );
        err.code = 'HLS_SEGMENT_DOWNLOAD_FAILED';
        err.failedCount = failedCount;
        err.totalSegments = total;
        throw err;
      }
    }

    return { buffers, failedCount, retriedCount };
  }

  function extFromUrl(url) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      const match = pathname.match(/\.([a-z0-9]+)$/);
      return match ? `.${match[1]}` : '';
    } catch (err) {
      console.warn(`[OVD][HLS] failed to infer extension from URL: ${err.message}`);
      return '';
    }
  }

  function ensureExtension(filename, ext) {
    const safeName = typeof filename === 'string' ? filename.trim() : '';
    const base = safeName || 'video';
    return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
  }

  function inferHlsOutputProfile(playlist) {
    const urls = [playlist?.initSegmentUrl, ...(playlist?.segments || [])].filter(Boolean);
    const extSet = new Set(urls.map((url) => extFromUrl(url)).filter(Boolean));
    const isMp4Like = extSet.has('.m4s') || extSet.has('.mp4') || playlist?.initSegmentUrl != null;

    return isMp4Like
      ? { ext: '.mp4', mimeType: 'video/mp4' }
      : { ext: '.ts', mimeType: 'video/mp2t' };
  }

  globalThis.__OVD_HLS_PIPELINE__ = {
    decryptHlsSegments,
    downloadHlsSegments,
    ensureExtension,
    extFromUrl,
    hlsFetch,
    hlsFetchBuffer,
    hlsFetchText,
    inferHlsOutputProfile,
    parseAttributeList,
    parseHlsEncryption,
    parseHlsIV,
    parseHlsPlaylist,
    resolveHlsUrl,
    selectBestHlsStream,
  };
})();
