// lib/hls-pipeline.js
// HLS 管线：Master/Media Playlist 解析、分片下载、AES-128 解密
// 以 <script> 方式加载，暴露全局 __OVD_HLS_PIPELINE__

'use strict';

(() => {
  if (globalThis.__OVD_HLS_PIPELINE__) {
    return;
  }

  const DEFAULT_MAX_MERGE_BYTES = 2 * 1024 * 1024 * 1024;

  function parseAttributeList(attrText) {
    const attrs = {};
    // 属性名允许连字符（GROUP-ID / AVERAGE-BANDWIDTH 等），未加引号的值以逗号结束
    const attrRegex = /([A-Za-z0-9-]+)=(?:"([^"]*)"|([^",\s]*))/g;
    let match;
    while ((match = attrRegex.exec(attrText || '')) !== null) {
      attrs[match[1]] = match[2] !== undefined ? match[2] : match[3];
    }
    return attrs;
  }

  /**
   * 解析 `start-end` / `start` 形式的字节区间（EXT-X-BYTERANGE 与 DASH range 通用）。
   */
  function parseByteRange(value) {
    const match = /^(\d+)(?:@(\d+))?(?:-(\d+))?$/.exec(String(value || '').trim());
    if (!match) {
      return null;
    }

    if (match[2] != null) {
      const start = parseInt(match[2], 10);
      const length = parseInt(match[1], 10);
      return {
        end: Number.isFinite(length) && length > 0 ? start + length - 1 : null,
        length: Number.isFinite(length) ? length : null,
        start,
      };
    }

    const start = parseInt(match[1], 10);
    const end = match[3] != null ? parseInt(match[3], 10) : null;
    return {
      end,
      length: end != null ? Math.max(0, end - start + 1) : null,
      start,
    };
  }

  function toRangeHeader(byteRange) {
    if (!byteRange || !Number.isFinite(byteRange.start)) {
      return null;
    }
    const end = Number.isFinite(byteRange.end) ? byteRange.end : '';
    return `bytes=${byteRange.start}-${end}`;
  }

  function parseHlsIV(ivStr) {
    const hex = String(ivStr || '').replace(/^0x/i, '');
    const buffer = new Uint8Array(16);
    for (let i = 0; i < 16 && (i * 2) < hex.length; i++) {
      buffer[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return buffer.buffer;
  }

  /** 无显式 IV 时，按 RFC 8216 用媒体序号（media sequence）构造 IV */
  function ivFromSequence(sequence) {
    const buffer = new ArrayBuffer(16);
    new DataView(buffer).setUint32(12, (Number(sequence) || 0) >>> 0, false);
    return buffer;
  }

  /**
   * 内存 sink：按顺序累积分片引用，最后一次性交给 Blob。
   * 之所以比"先存 buffers 数组再 concat 成 Uint8Array"省内存：
   * 旧路径峰值是 buffers(N) + merged(N) + Blob(N) ≈ 3N，
   * sink 路径只有分片引用(N) + 有序重排窗口(≤并发数)，且 toBlob() 后立即释放引用。
   * 这也是后续 OPFS/文件落盘 sink 的统一接口。
   */
  function createInMemorySink() {
    const chunks = [];
    let byteLength = 0;

    return {
      get byteLength() {
        return byteLength;
      },
      get chunkCount() {
        return chunks.length;
      },
      /** 分片顺序由 downloadHlsSegments 保证 */
      async write(chunk) {
        if (!chunk || chunk.byteLength === 0) {
          return;
        }
        chunks.push(chunk);
        byteLength += chunk.byteLength;
      },
      /** 一次性拼成 ArrayBuffer（仅在必须整体持有数据的路径使用，例如 fMP4 合并） */
      toArrayBuffer() {
        const merged = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(new Uint8Array(chunk), offset);
          offset += chunk.byteLength;
        }
        return merged.buffer;
      },
      /** 消费型出口：交给 Blob 后释放引用，byteLength 仍保留用于上报 */
      toBlob(mimeType = 'application/octet-stream') {
        const blob = new Blob(chunks, { type: mimeType });
        chunks.length = 0;
        return blob;
      },
    };
  }

  /**
   * 按分片下标生成解密函数，供 downloadHlsSegments 的 transform 使用。
   * 与 decryptHlsSegments 共用同一套密钥轮换 / IV 派生逻辑。
   */
  function createSegmentDecryptor(keyInfo) {
    if (!keyInfo) {
      return null;
    }

    const playlistKeys = Array.isArray(keyInfo.keys) ? keyInfo.keys : null;
    const playlistSegments = Array.isArray(keyInfo.segments) ? keyInfo.segments : null;

    return async function decryptSegment(buffer, index) {
      if (!buffer || buffer.byteLength === 0) {
        return buffer;
      }

      const segment = playlistSegments?.[index] || null;

      if (playlistKeys) {
        const keyIndex = segment?.keyIndex;
        if (keyIndex == null) {
          // 该分片未被加密（EXT-X-KEY:METHOD=NONE）
          return buffer;
        }

        const slot = playlistKeys[keyIndex];
        if (!slot?.key) {
          const err = new Error(`HLS 分片 ${index} 缺少可用的解密密钥`);
          err.code = 'HLS_KEY_FETCH_FAILED';
          err.segmentIndex = index;
          throw err;
        }

        const iv = slot.iv || ivFromSequence(segment?.seq != null ? segment.seq : index);
        return decryptOne(buffer, slot.key, iv, index);
      }

      if (!keyInfo.key) {
        const err = new Error(`HLS 分片 ${index} 缺少解密密钥`);
        err.code = 'HLS_KEY_FETCH_FAILED';
        err.segmentIndex = index;
        throw err;
      }

      const iv = keyInfo.iv || ivFromSequence(segment?.seq != null ? segment.seq : index);
      return decryptOne(buffer, keyInfo.key, iv, index);
    };
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

  // ---------------------------------------------------------------
  // Master Playlist
  // ---------------------------------------------------------------

  function variantLabel(variant = {}) {
    if (variant.height) {
      return `${variant.height}p`;
    }
    if (variant.name) {
      return String(variant.name);
    }
    if (variant.bandwidth) {
      return `${Math.round(variant.bandwidth / 1000)} kbps`;
    }
    return '未知画质';
  }

  function variantDetail(variant = {}) {
    const parts = [];
    if (variant.width && variant.height) {
      parts.push(`${variant.width}x${variant.height}`);
    }
    if (variant.bandwidth) {
      parts.push(`${Math.round(variant.bandwidth / 1000)} kbps`);
    }
    if (variant.codecs) {
      parts.push(variant.codecs);
    }
    return parts.join(' · ');
  }

  /**
   * 解析 Master Playlist：列出所有码率变体与独立音轨（EXT-X-MEDIA）。
   */
  function parseHlsMasterPlaylist(m3u8, baseUrl) {
    const lines = String(m3u8 || '').split('\n');
    const variants = [];
    const media = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXT-X-MEDIA:')) {
        const attrs = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
        const uri = attrs.URI ? safeResolve(attrs.URI, baseUrl) : null;
        media.push({
          autoselect: attrs.AUTOSELECT === 'YES',
          channels: attrs.CHANNELS || '',
          default: attrs.DEFAULT === 'YES',
          groupId: attrs['GROUP-ID'] || '',
          language: attrs.LANGUAGE || '',
          name: attrs.NAME || '',
          type: String(attrs.TYPE || '').toUpperCase(),
          uri,
        });
        continue;
      }

      if (!line.startsWith('#EXT-X-STREAM-INF:')) {
        continue;
      }

      const attrs = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      const nextLine = lines[i + 1]?.trim();
      if (!nextLine || nextLine.startsWith('#')) {
        continue;
      }

      const resolution = /^(\d+)x(\d+)$/i.exec(attrs.RESOLUTION || '');
      const variant = {
        audioGroupId: attrs.AUDIO || '',
        averageBandwidth: parseInt(attrs['AVERAGE-BANDWIDTH'], 10) || 0,
        bandwidth: parseInt(attrs.BANDWIDTH, 10) || 0,
        codecs: attrs.CODECS || '',
        frameRate: parseFloat(attrs['FRAME-RATE']) || 0,
        height: resolution ? parseInt(resolution[2], 10) : 0,
        name: attrs.NAME || '',
        subtitleGroupId: attrs.SUBTITLES || '',
        url: safeResolve(nextLine, baseUrl),
        width: resolution ? parseInt(resolution[1], 10) : 0,
      };
      variant.label = variantLabel(variant);
      variant.detail = variantDetail(variant);
      variants.push(variant);
    }

    return {
      audioRenditions: media.filter((item) => item.type === 'AUDIO'),
      isMaster: variants.length > 0,
      media,
      variants,
    };
  }

  function safeResolve(resourceUrl, baseUrl) {
    try {
      return resolveHlsUrl(resourceUrl, baseUrl);
    } catch (err) {
      console.warn(`[OVD][HLS] failed to resolve URL "${resourceUrl}": ${err.message}`);
      return resourceUrl;
    }
  }

  /**
   * 在变体列表中挑选目标画质。
   * quality 支持：变体 URL、label（如 "720p"）、高度数字、"best"/"auto"/空。
   */
  function selectHlsVariant(masterOrVariants, baseUrl, options = {}) {
    const variants = Array.isArray(masterOrVariants)
      ? masterOrVariants
      : parseHlsMasterPlaylist(masterOrVariants, baseUrl).variants;

    if (variants.length === 0) {
      return null;
    }

    const quality = options.quality == null ? '' : String(options.quality).trim();
    if (quality && quality !== 'auto' && quality !== 'best') {
      const byUrl = variants.find((variant) => variant.url === quality);
      if (byUrl) {
        return byUrl;
      }

      const byLabel = variants.find((variant) => variant.label === quality);
      if (byLabel) {
        return byLabel;
      }

      const height = parseInt(quality, 10);
      if (Number.isFinite(height)) {
        const byHeight = variants
          .filter((variant) => variant.height === height)
          .sort((left, right) => right.bandwidth - left.bandwidth);
        if (byHeight.length > 0) {
          return byHeight[0];
        }
      }

      console.warn(`[OVD][HLS] 未找到画质 "${quality}"，回退到最高码率`);
    }

    return variants.reduce((best, variant) =>
      (variant.bandwidth >= best.bandwidth ? variant : best));
  }

  function selectBestHlsStream(masterM3u8, baseUrl, options = {}) {
    const variant = selectHlsVariant(masterM3u8, baseUrl, options);
    return variant?.url || baseUrl;
  }

  // ---------------------------------------------------------------
  // Media Playlist
  // ---------------------------------------------------------------

  /**
   * 解析 Media Playlist。
   * 支持 EXT-X-MAP / EXT-X-BYTERANGE / EXT-X-KEY 轮换 / EXT-X-MEDIA-SEQUENCE /
   * EXT-X-DISCONTINUITY / EXT-X-ENDLIST（直播判定）。
   * segments 元素：{ url, seq, duration, byteRange, keyIndex, discontinuity }
   */
  function parseHlsPlaylist(m3u8, baseUrl, options = {}) {
    const text = String(m3u8 || '');
    const segments = [];
    const keys = [];
    const byteRangeOffsets = new Map();

    let initSegmentUrl = null;
    let initSegmentByteRange = null;
    let mediaSequence = 0;
    let targetDuration = null;
    let totalDuration = 0;
    let hasEndList = false;
    let playlistType = '';
    let discontinuityCount = 0;
    let currentKeyIndex = null;
    let currentDiscontinuity = false;
    let pendingDuration = null;
    let pendingByteRange = null;
    let sequenceCounter = 0;

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      if (trimmed.startsWith('#')) {
        if (trimmed.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
          mediaSequence = parseInt(trimmed.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
        } else if (trimmed.startsWith('#EXT-X-TARGETDURATION:')) {
          targetDuration = parseFloat(trimmed.slice('#EXT-X-TARGETDURATION:'.length)) || null;
        } else if (trimmed.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
          playlistType = trimmed.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim().toUpperCase();
        } else if (trimmed.startsWith('#EXT-X-ENDLIST')) {
          hasEndList = true;
        } else if (trimmed.startsWith('#EXT-X-DISCONTINUITY')) {
          currentDiscontinuity = true;
          discontinuityCount++;
        } else if (trimmed.startsWith('#EXT-X-KEY:')) {
          const attrs = parseAttributeList(trimmed.slice('#EXT-X-KEY:'.length));
          const method = String(attrs.METHOD || '').toUpperCase();
          if (!method || method === 'NONE') {
            currentKeyIndex = null;
          } else {
            keys.push({
              ivHex: attrs.IV || '',
              keyUrl: attrs.URI ? safeResolve(attrs.URI, baseUrl) : null,
              method,
              uri: attrs.URI || '',
            });
            currentKeyIndex = keys.length - 1;
          }
        } else if (trimmed.startsWith('#EXT-X-MAP:')) {
          const attrs = parseAttributeList(trimmed.slice('#EXT-X-MAP:'.length));
          if (attrs.URI) {
            initSegmentUrl = safeResolve(attrs.URI, baseUrl);
            initSegmentByteRange = parseByteRange(attrs.BYTERANGE);
          }
        } else if (trimmed.startsWith('#EXT-X-BYTERANGE:')) {
          pendingByteRange = trimmed.slice('#EXT-X-BYTERANGE:'.length).trim();
        } else if (trimmed.startsWith('#EXTINF:')) {
          pendingDuration = parseFloat(trimmed.slice('#EXTINF:'.length)) || null;
        }
        continue;
      }

      let url;
      try {
        url = resolveHlsUrl(trimmed, baseUrl);
      } catch (err) {
        console.warn(`[OVD][HLS] failed to resolve segment URL "${trimmed}": ${err.message}`);
        continue;
      }

      let byteRange = null;
      if (pendingByteRange) {
        // HLS 语法：#EXT-X-BYTERANGE:<length>[@<offset>]，省略 offset 时紧接同资源上一段
        const rangeMatch = /^(\d+)(?:@(\d+))?$/.exec(pendingByteRange);
        if (rangeMatch) {
          const length = parseInt(rangeMatch[1], 10);
          const start = rangeMatch[2] != null
            ? parseInt(rangeMatch[2], 10)
            : (byteRangeOffsets.get(url) || 0);
          byteRange = { end: start + length - 1, length, start };
          byteRangeOffsets.set(url, start + length);
        }
      }

      segments.push({
        byteRange,
        discontinuity: currentDiscontinuity,
        duration: pendingDuration,
        keyIndex: currentKeyIndex,
        seq: mediaSequence + sequenceCounter,
        url,
      });

      sequenceCounter++;
      if (pendingDuration) {
        totalDuration += pendingDuration;
      }
      currentDiscontinuity = false;
      pendingDuration = null;
      pendingByteRange = null;
    }

    return {
      discontinuityCount,
      hasEndList,
      initSegmentByteRange,
      initSegmentUrl,
      isEncrypted: keys.length > 0,
      isLive: !hasEndList && playlistType !== 'VOD',
      keys,
      mediaSequence,
      playlistType,
      segments,
      targetDuration,
      totalDuration,
      ...(options.extra || {}),
    };
  }

  // ---------------------------------------------------------------
  // AES-128
  // ---------------------------------------------------------------

  function parseHlsKeyEntries(m3u8, baseUrl) {
    const playlist = parseHlsPlaylist(m3u8, baseUrl);
    return playlist.keys;
  }

  /**
   * 统一的 HLS 请求入口。
   * options.credentials 用于页面上下文请求：content script 里带 Cookie 的跨域请求
   * 若被目标站点 CORS 拒绝（抛 TypeError），自动退化为默认凭证模式重试一次。
   * options.range = { start, end } 时追加 Range 请求头（EXT-X-BYTERANGE / DASH range）。
   */
  async function hlsFetch(url, headers, options = {}) {
    const rangeHeader = toRangeHeader(options.range);
    const requestHeaders = rangeHeader
      ? { ...(headers || {}), Range: rangeHeader }
      : (headers || {});
    const init = { headers: requestHeaders };
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
      return fetch(url, { headers: requestHeaders });
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
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    return response.arrayBuffer();
  }

  function normalizeKeyError(err, keyUrl, fallbackCode) {
    const wrapped = new Error(`HLS 密钥获取失败 (${keyUrl}): ${err.message}`);
    wrapped.code = fallbackCode || 'HLS_KEY_FETCH_FAILED';
    wrapped.cause = err;
    return wrapped;
  }

  /**
   * 抓取并导入所有 EXT-X-KEY 密钥（支持密钥轮换）。
   * 返回数组，元素与 playlist.keys 下标一一对应，失败即抛错（fail-fast）。
   */
  async function resolveHlsKeys(keyEntries, headers, options = {}) {
    const resolved = [];

    for (const entry of keyEntries || []) {
      if (!entry || String(entry.method || '').toUpperCase() === 'NONE') {
        resolved.push(null);
        continue;
      }

      const method = String(entry.method).toUpperCase();
      if (method !== 'AES-128') {
        const err = new Error(`不支持的 HLS 加密方式: ${method}，仅支持 AES-128`);
        err.code = 'HLS_UNSUPPORTED_ENCRYPTION';
        throw err;
      }

      if (!entry.keyUrl) {
        const err = new Error('HLS AES-128 密钥缺少 URI');
        err.code = 'HLS_KEY_FETCH_FAILED';
        throw err;
      }

      try {
        const keyBuffer = await hlsFetchBuffer(entry.keyUrl, headers, options);
        const key = await crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-CBC' }, false, ['decrypt']);
        resolved.push({
          explicitIv: !!entry.ivHex,
          iv: entry.ivHex ? parseHlsIV(entry.ivHex) : null,
          key,
          method,
        });
      } catch (err) {
        throw normalizeKeyError(err, entry.keyUrl);
      }
    }

    return resolved;
  }

  /** 单密钥兼容入口（沿用旧调用方）：仅处理第一个 EXT-X-KEY。 */
  async function parseHlsEncryption(m3u8, baseUrl, headers, options = {}) {
    const keys = parseHlsKeyEntries(m3u8, baseUrl);
    if (keys.length === 0) {
      return null;
    }

    const [resolved] = await resolveHlsKeys([keys[0]], headers, options);
    if (!resolved) {
      return null;
    }
    return { iv: resolved.iv, key: resolved.key };
  }

  /**
   * 解密分片。
   * - 旧接口：keyInfo = { key, iv }
   * - 播放列表接口：keyInfo = { keys, segments }，按 segment.keyIndex 逐段取密钥，
   *   无显式 IV 时用媒体序号（EXT-X-MEDIA-SEQUENCE + index）派生，避免 IV 错位。
   */
  async function decryptHlsSegments(buffers, keyInfo) {
    const decryptSegment = createSegmentDecryptor(keyInfo);
    if (!decryptSegment) {
      return buffers;
    }

    const decrypted = [];
    for (let i = 0; i < buffers.length; i++) {
      decrypted.push(await decryptSegment(buffers[i], i));
    }

    return decrypted;
  }

  async function decryptOne(buffer, key, iv, index) {
    try {
      return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buffer);
    } catch (err) {
      // 解密失败不得回退使用密文，直接中止，避免产出损坏文件
      const wrapped = new Error(`HLS 分片 ${index} 解密失败: ${err.message}`);
      wrapped.code = 'HLS_SEGMENT_DECRYPT_FAILED';
      wrapped.cause = err;
      wrapped.segmentIndex = index;
      throw wrapped;
    }
  }

  // ---------------------------------------------------------------
  // 分片下载
  // ---------------------------------------------------------------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 统一的取消错误：内容侧任务 ABORT 通道与 popup 取消按钮共用 */
  function createAbortError(message = '下载已取消') {
    const err = new Error(message);
    err.code = 'DOWNLOAD_ABORTED';
    return err;
  }

  function normalizeSegmentEntry(segment) {
    if (typeof segment === 'string') {
      return { byteRange: null, url: segment };
    }
    if (segment && typeof segment === 'object' && segment.url) {
      return segment;
    }
    return null;
  }

  async function fetchSegmentWithRetry(entry, fetchOne, retryDelays) {
    let lastError = null;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      if (attempt > 0) {
        await sleep(retryDelays[attempt - 1]);
      }
      try {
        return { buffer: await fetchOne(entry.url, entry.byteRange || null), retried: attempt > 0 };
      } catch (err) {
        lastError = err;
        console.warn(`[OVD][HLS] 分片第 ${attempt + 1} 次请求失败: ${entry.url} (${err.message})`);
      }
    }
    return { error: lastError };
  }

  /**
   * 并发下载分片（background/content 共用的 fail-fast 实现）。
   * 每个失败分片按 retryDelays 指数退避重试；最终失败数超过阈值时抛出
   * HLS_SEGMENT_DOWNLOAD_FAILED 中止整个任务，绝不产出含空洞的文件。
   * 分片总数 ≤ 10 时任何失败都会中止（阈值取 floor，小列表零容忍）。
   * 累计字节数超过 maxTotalBytes 时抛出 HLS_OUTPUT_TOO_LARGE，避免内存合并崩溃。
   *
   * options.sink：顺序写入出口（`{ write(chunk, meta) }`）。给出后不再返回整份
   * buffers 数组，只保留"有序重排窗口"（≤ concurrency 个分片），峰值内存从
   * O(总分片) 降到 O(并发数)。配合 options.transform 可在写入前逐分片处理
   * （如 AES 解密），避免额外一份解密后的全量数组。
   */
  async function downloadHlsSegments(segments, options = {}) {
    const constants = globalThis.__OVD_CONSTANTS__ || {};
    const concurrency = options.concurrency || constants.HLS_SEGMENT_CONCURRENCY || 5;
    const maxFailedRatio = options.maxFailedRatio ?? constants.HLS_MAX_FAILED_RATIO ?? 0.1;
    const retryDelays = options.retryDelays || constants.HLS_SEGMENT_RETRY_DELAYS || [500, 1000, 2000];
    const onProgress = options.onProgress || null;
    const signal = options.signal || null;
    const maxTotalBytes = Number.isFinite(Number(options.maxTotalBytes))
      ? Number(options.maxTotalBytes)
      : (constants.MAX_IN_PAGE_MERGE_BYTES || DEFAULT_MAX_MERGE_BYTES);
    const entries = (segments || []).map(normalizeSegmentEntry).filter(Boolean);
    const sink = options.sink && typeof options.sink.write === 'function' ? options.sink : null;
    const transform = typeof options.transform === 'function' ? options.transform : null;
    const fetchOne = options.fetchBuffer
      ? (url, range) => options.fetchBuffer(url, range)
      : (url, range) => hlsFetchBuffer(url, options.headers, { ...options.fetchOptions, range });

    const total = entries.length;
    const maxFailed = total <= 10 ? 0 : Math.floor(total * maxFailedRatio);
    const buffers = new Array(total).fill(null);
    // 写入侧：pending 只缓存"当前批次里尚不能按序落盘"的分片
    const pending = sink ? new Map() : null;
    let done = 0;
    let failedCount = 0;
    let retriedCount = 0;
    let totalBytes = 0;
    let writtenBytes = 0;
    let nextToWrite = 0;

    async function flushSink() {
      while (pending.has(nextToWrite)) {
        const index = nextToWrite;
        let chunk = pending.get(index);
        pending.delete(index);
        nextToWrite++;

        if (!chunk || chunk.byteLength === 0) {
          continue;
        }
        if (transform) {
          chunk = await transform(chunk, index, entries[index]);
        }
        if (chunk?.byteLength > 0) {
          writtenBytes += chunk.byteLength;
          await sink.write(chunk, { index, segment: entries[index] });
        }
      }
    }

    for (let i = 0; i < total; i += concurrency) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      const batch = entries.slice(i, Math.min(i + concurrency, total));
      const results = await Promise.all(
        batch.map((entry, batchIdx) => fetchSegmentWithRetry(entry, fetchOne, retryDelays)
          .then((result) => ({ ...result, idx: i + batchIdx })))
      );

      for (const result of results) {
        if (result.error) {
          failedCount++;
          if (pending) {
            pending.set(result.idx, null);
          } else {
            buffers[result.idx] = new ArrayBuffer(0);
          }
        } else {
          if (result.retried) {
            retriedCount++;
          }
          if (pending) {
            pending.set(result.idx, result.buffer);
          } else {
            buffers[result.idx] = result.buffer;
          }
          totalBytes += result.buffer?.byteLength || 0;
        }

        done++;
        onProgress?.(done, total, { failedCount, retriedCount, totalBytes });
      }

      if (pending) {
        await flushSink();
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

      if (maxTotalBytes > 0 && totalBytes > maxTotalBytes) {
        const err = new Error(
          `流体积超过 ${Math.round(maxTotalBytes / 1024 / 1024)} MB 上限，`
          + '浏览器内合并可能失败，已中止下载以保证不产出损坏文件'
        );
        err.code = 'HLS_OUTPUT_TOO_LARGE';
        err.totalBytes = totalBytes;
        err.maxTotalBytes = maxTotalBytes;
        throw err;
      }
    }

    return {
      buffers: sink ? null : buffers,
      failedCount,
      retriedCount,
      segments: entries,
      sink,
      totalBytes,
      writtenBytes: sink ? writtenBytes : totalBytes,
    };
  }

  function extFromUrl(url) {
    try {
      const value = typeof url === 'string' ? url : (url?.url || '');
      const pathname = new URL(value).pathname.toLowerCase();
      const match = pathname.match(/\.([a-z0-9]+)$/);
      return match ? `.${match[1]}` : '';
    } catch (err) {
      console.warn(`[OVD][HLS] failed to infer extension from URL: ${err.message}`);
      return '';
    }
  }

  /**
   * 估算 HLS 输出体积：sum(EXTINF) × 有效带宽 / 8。
   * 拿不到时长或带宽时返回 0，调用方据此不做拦截（宁可尝试，也不误判）。
   * bandwidth 通常是 Master Playlist 的 BANDWIDTH（峰值码率），
   * 因此默认乘 0.8 近似平均码率；有 AVERAGE-BANDWIDTH 时应传该值并用 factor=1。
   */
  function estimateHlsBytes(playlist, bandwidth, options = {}) {
    const duration = Number(playlist?.totalDuration) || 0;
    const peak = Number(bandwidth) || 0;
    if (!(duration > 0) || !(peak > 0)) {
      return 0;
    }

    const rawFactor = Number(options.bandwidthFactor);
    const factor = Number.isFinite(rawFactor) ? rawFactor : 0.8;
    return Math.round((duration * peak * factor) / 8);
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

  /**
   * 判断 playlists 中是否存在独立音轨（EXT-X-MEDIA TYPE=AUDIO + URI），
   * 返回与视频变体 audioGroupId 匹配的音轨入口。
   */
  function findMatchingAudioRendition(master, variant) {
    if (!master || !variant || !variant.audioGroupId) {
      return null;
    }

    return master.audioRenditions.find((rendition) =>
      rendition.uri && rendition.groupId === variant.audioGroupId) || null;
  }

  globalThis.__OVD_HLS_PIPELINE__ = {
    createAbortError,
    createInMemorySink,
    createSegmentDecryptor,
    decryptHlsSegments,
    downloadHlsSegments,
    ensureExtension,
    estimateHlsBytes,
    extFromUrl,
    findMatchingAudioRendition,
    hlsFetch,
    hlsFetchBuffer,
    hlsFetchText,
    inferHlsOutputProfile,
    ivFromSequence,
    parseAttributeList,
    parseByteRange,
    parseHlsEncryption,
    parseHlsIV,
    parseHlsKeyEntries,
    parseHlsMasterPlaylist,
    parseHlsPlaylist,
    resolveHlsKeys,
    resolveHlsUrl,
    selectBestHlsStream,
    selectHlsVariant,
    toRangeHeader,
    variantLabel,
  };
})();
