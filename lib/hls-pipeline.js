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
    if (attrs.METHOD === 'NONE' || attrs.METHOD !== 'AES-128') {
      return null;
    }

    const keyUrl = attrs.URI ? resolveHlsUrl(attrs.URI, baseUrl) : null;
    if (!keyUrl) {
      return null;
    }

    try {
      const keyBuffer = await hlsFetchBuffer(keyUrl, headers, options);
      const cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-CBC' }, false, ['decrypt']);
      return {
        iv: attrs.IV ? parseHlsIV(attrs.IV) : null,
        key: cryptoKey,
      };
    } catch (err) {
      console.warn(`[OVD][HLS] failed to parse AES-128 encryption key: ${err.message}`);
      return null;
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
        console.warn(`[OVD][HLS] failed to decrypt segment ${i}, using original buffer: ${err.message}`);
        decrypted.push(buffer);
      }
    }

    return decrypted;
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
