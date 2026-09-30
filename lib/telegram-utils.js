// lib/telegram-utils.js
// Telegram Web（web.telegram.org/k、web.telegram.org/a 等）媒体识别工具。
//
// 为什么单列一类：Telegram Web 播放文档时不走普通直链，而是由页面自己的 Service Worker
// 把 MTProto 分块伪装成同源地址，再用 Range 请求逐段吐字节。两个前端各有一套端点：
//   · WebK（旧版 tweb）：`…/k/stream/<URL 编码的 DownloadOptions JSON>`（src/lib/serviceWorker/stream.ts）
//   · WebA / 新版 tweb：`…/a/progressive/document<id>?fileSize=…&mimeType=…`（src/serviceWorker/progressive.ts）
// 这类地址只在页面上下文里可读：SW 用 `self.clients.get(e.clientId)` 找页面客户端
// （content script 的 fetch 没有 clientId，SW 不接管，会落到真实服务器并拿到 302；
// 扩展后台 fetch 同理）。因此识别出来之后必须回到页面上下文（注入脚本）里按 Range 抓取。
'use strict';

(() => {
  if (globalThis.__OVD_TELEGRAM_UTILS__) {
    return;
  }

  /** Telegram Web 站点（K / A / Z 三个前端同域不同路径） */
  const TELEGRAM_WEB_HOSTS = ['web.telegram.org', 'webk.telegram.org', 'webz.telegram.org'];
  /** WebK（旧版 tweb）的流式媒体端点；路径里带 stream/ 且同源时才由页面 SW 接管 */
  const STREAM_PATH_SEGMENT = '/stream/';
  /** WebA / 新版 tweb 的流式媒体端点；同一段代码也服务缩略图与「下载」入口（见 isProgressiveMediaUrl） */
  const PROGRESSIVE_PATH_SEGMENT = '/progressive/';
  const TELEGRAM_STREAM_PATH_SEGMENTS = [STREAM_PATH_SEGMENT, PROGRESSIVE_PATH_SEGMENT];
  const MIME_EXTENSION_MAP = {
    'audio/aac': '.aac',
    'audio/flac': '.flac',
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.oga',
    'audio/wav': '.wav',
    'audio/webm': '.weba',
    'video/mp2t': '.ts',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/x-flv': '.flv',
    'video/x-matroska': '.mkv',
  };

  function parseUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) {
      return null;
    }
    try {
      return new URL(raw, 'https://web.telegram.org/');
    } catch (_err) {
      return null;
    }
  }

  function isTelegramWebHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return TELEGRAM_WEB_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
  }

  /** 页面地址本身（不是媒体地址）：web.telegram.org 下的任意页面 */
  function isTelegramWebPageUrl(url) {
    const parsed = parseUrl(url);
    return !!parsed && isTelegramWebHost(parsed.hostname);
  }

  /**
   * 命中哪个流式端点（`/stream/` 或 `/progressive/`），没命中返回空串。
   * 只看 pathname 与宿主 —— WebK 在修复 Chromium 的 mp4 bug 时会追加 `?_crbug1250841`。
   */
  function matchTelegramStreamSegment(url) {
    const parsed = parseUrl(url);
    if (!parsed || !isTelegramWebHost(parsed.hostname)) {
      return '';
    }
    const pathname = parsed.pathname.toLowerCase();
    return TELEGRAM_STREAM_PATH_SEGMENTS.find((segment) => pathname.includes(segment)) || '';
  }

  /**
   * `/progressive/` 这一段同时服务三种东西，只有第一种是完整媒体：
   *   · `document<id>`（可带 `fileSize` / `mimeType`）→ 视频、音频、视频文件本体
   *   · `document<id>?size=x|m|v`                    → 缩略图 / 视频预览小片
   *   · `document<id>?download`                      → 页面自己的「下载」按钮
   * 后两种若也算媒体，检测列表会被封面图刷屏。
   */
  function isProgressiveMediaUrl(parsed) {
    if (parsed.searchParams.has('size') || parsed.searchParams.has('download')) {
      return false;
    }
    const name = progressiveMediaName(parsed);
    return /^document\d+$/i.test(name);
  }

  /** `…/a/progressive/document123?fileSize=…` 里的 `document123`（不含 query） */
  function progressiveMediaName(parsed) {
    const pathname = parsed.pathname;
    const index = pathname.toLowerCase().indexOf(PROGRESSIVE_PATH_SEGMENT);
    if (index < 0) {
      return '';
    }
    const raw = pathname.slice(index + PROGRESSIVE_PATH_SEGMENT.length);
    try {
      return decodeURIComponent(raw);
    } catch (_err) {
      return raw;
    }
  }

  /**
   * Telegram Web 的流式媒体地址（同源）：
   *   · WebK：`…/k/stream/<URL 编码的 DownloadOptions JSON>`
   *   · WebA：`…/a/progressive/document<id>?fileSize=…&mimeType=…`
   */
  function isTelegramStreamUrl(url) {
    const segment = matchTelegramStreamSegment(url);
    if (!segment) {
      return false;
    }
    if (segment === PROGRESSIVE_PATH_SEGMENT) {
      return isProgressiveMediaUrl(parseUrl(url));
    }
    return true;
  }

  /** 页面自己 createObjectURL 出来的 blob（如被修复过的 mp4），宿主必须是 Telegram Web */
  function isTelegramBlobUrl(url) {
    const raw = String(url || '');
    if (!/^blob:/i.test(raw)) {
      return false;
    }
    return /^blob:https?:\/\/web[a-z]*\.telegram\.org\//i.test(raw) || isTelegramWebHost(parseUrl(raw.slice(5))?.hostname);
  }

  function isTelegramMediaUrl(url) {
    return isTelegramStreamUrl(url) || isTelegramBlobUrl(url);
  }

  /**
   * 从 stream 地址里解出文件元信息（best-effort）。
   * WebK 把 DownloadOptions 整体 JSON 编码后放在 stream/ 之后，里面的 size / mime_type
   * 正好是列表里需要的体积与格式；WebA 则把 `fileSize` / `mimeType` 放在 query 上。
   * 解析失败不影响下载（回退用响应头）。
   */
  function parseTelegramStreamInfo(url) {
    const parsed = parseUrl(url);
    // 缩略图 / 预览小片 / 页面自带下载入口都不是完整媒体（isTelegramStreamUrl 已把它们排除）
    if (!parsed || !isTelegramStreamUrl(url)) {
      return null;
    }
    const matchedSegment = matchTelegramStreamSegment(url);

    const info = { docId: '', mimeType: '', size: 0 };
    const queryMime = parsed.searchParams.get('mime')
      || parsed.searchParams.get('mime_type')
      || parsed.searchParams.get('mimeType')
      || '';
    if (queryMime) {
      info.mimeType = queryMime;
    }

    if (matchedSegment === PROGRESSIVE_PATH_SEGMENT) {
      return parseProgressiveStreamInfo(parsed, info);
    }

    const segment = parsed.pathname.slice(parsed.pathname.toLowerCase().indexOf(STREAM_PATH_SEGMENT) + STREAM_PATH_SEGMENT.length);
    if (!segment) {
      return info;
    }

    let payload = null;
    try {
      payload = JSON.parse(decodeURIComponent(segment));
    } catch (_err) {
      payload = null;
    }

    if (payload && typeof payload === 'object') {
      const docId = payload?.location?.id ?? payload?.docId ?? payload?.doc_id ?? '';
      if (docId !== '') {
        info.docId = String(docId);
      }
      const mimeType = payload.mime_type || payload.mimeType || '';
      if (mimeType) {
        info.mimeType = String(mimeType);
      }
      const size = Number(payload.size);
      if (Number.isFinite(size) && size > 0) {
        info.size = size;
      }
      return info;
    }

    // 回退格式：`<account>-<docId>`
    const [accountNumber, docId] = decodeURIComponent(segment).split('-');
    if (docId) {
      info.docId = docId;
    }
    if (accountNumber) {
      info.accountNumber = accountNumber;
    }
    return info;
  }

  /**
   * WebA 的地址自带元信息：`…/a/progressive/document<id>?fileSize=<size>&mimeType=<mime>&account=<n>`。
   * `fileSize` / `mimeType` 由页面在拼 `document<id>` 时补上（tweb `appendProgressiveQueryParameters`），
   * 直接读比 WebK 的 JSON 还省事；缺失时留 0，下载回退用响应头。
   */
  function parseProgressiveStreamInfo(parsed, info) {
    const name = progressiveMediaName(parsed);
    const docIdMatch = /^document(\d+)/i.exec(name);
    if (docIdMatch) {
      info.docId = docIdMatch[1];
    } else if (name) {
      info.docId = name;
    }

    const rawSize = parsed.searchParams.get('fileSize') || parsed.searchParams.get('size');
    const size = Number(rawSize);
    if (Number.isFinite(size) && size > 0) {
      info.size = size;
    }

    const accountNumber = parsed.searchParams.get('account');
    if (accountNumber) {
      info.accountNumber = accountNumber;
    }

    return info;
  }

  function guessMediaExtension(mimeType, fallback = '.mp4') {
    const normalized = String(mimeType || '').toLowerCase().split(';')[0].trim();
    if (!normalized) {
      return fallback;
    }
    if (MIME_EXTENSION_MAP[normalized]) {
      return MIME_EXTENSION_MAP[normalized];
    }
    for (const [mime, ext] of Object.entries(MIME_EXTENSION_MAP)) {
      if (normalized.startsWith(mime)) {
        return ext;
      }
    }
    if (normalized.startsWith('audio/')) {
      return '.m4a';
    }
    return fallback;
  }

  /** `Content-Range: bytes 0-524287/12345678` → 12345678（拿不到时返回 0） */
  function totalBytesFromContentRange(header) {
    const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(String(header || ''));
    const total = match ? Number(match[1]) : 0;
    return Number.isFinite(total) && total > 0 ? total : 0;
  }

  /** 取消下载时抛出的错误：错误码与内容侧/后台的取消约定一致 */
  function createStreamAbortError(message = '下载已取消') {
    const error = new Error(message);
    error.code = 'DOWNLOAD_ABORTED';
    return error;
  }

  /**
   * 按 Range 逐段读取 Telegram 的页面侧媒体流（必须在页面上下文调用）。
   *
   * 为什么不直接在内容脚本里 fetch：WebK 的 stream 端点由页面自己的 Service Worker 生成，
   * SW 用 `self.clients.get(e.clientId)` 找页面客户端（见 tweb 的 progressive.ts#requestPart）；
   * 内容脚本发起的请求没有 clientId，SW 不会接管，请求会落到真实服务器并拿到 302。
   *
   * `onChunk(bytes, seq)` 会被逐块 await，调用方据此做背压（例如等后台确认后再继续）。
   */
  async function readTelegramStream(options = {}) {
    const {
      url,
      fetchImpl = globalThis.fetch,
      signal = null,
      totalHint = 0,
      rangeChunkBytes = 2 * 1024 * 1024,
      transferChunkBytes = 512 * 1024,
      onChunk = null,
      onProgress = null,
    } = options;

    if (!url) {
      throw new Error('缺少视频地址');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('当前环境不支持 fetch');
    }

    let offset = 0;
    let totalBytes = Number(totalHint) > 0 ? Number(totalHint) : 0;
    // 是否见过权威总长（Content-Range）。只有见过时才敢断言下载完整性
    let ranged = false;
    let seq = 0;

    for (;;) {
      if (signal?.aborted) {
        throw createStreamAbortError();
      }

      const response = await fetchImpl(url, {
        cache: 'no-store',
        credentials: 'include',
        headers: { Range: `bytes=${offset}-${offset + rangeChunkBytes - 1}` },
        signal: signal || undefined,
      });

      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const headerTotal = totalBytesFromContentRange(response.headers?.get?.('content-range'));
      if (headerTotal > 0) {
        totalBytes = headerTotal;
        ranged = true;
      }

      const partial = response.status === 206;
      let received = 0;
      const emit = async (bytes) => {
        received += bytes.byteLength;
        if (onChunk) {
          await onChunk(bytes, seq++);
        }
        if (onProgress) {
          onProgress(offset + received, totalBytes);
        }
      };

      if (response.body?.getReader) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (!value?.byteLength) {
              continue;
            }
            if (signal?.aborted) {
              await reader.cancel().catch(() => {});
              throw createStreamAbortError();
            }
            for (let start = 0; start < value.byteLength; start += transferChunkBytes) {
              await emit(value.subarray(start, start + transferChunkBytes));
            }
          }
        } finally {
          reader.releaseLock?.();
        }
      } else {
        const buffer = new Uint8Array(await response.arrayBuffer());
        for (let start = 0; start < buffer.byteLength; start += transferChunkBytes) {
          await emit(buffer.subarray(start, start + transferChunkBytes));
        }
      }

      offset += received;

      // 整包响应（服务端忽略 Range / 单次读完）或没有更多数据
      if (!partial || received === 0) {
        break;
      }
      if (totalBytes > 0 && offset >= totalBytes) {
        break;
      }
    }

    return { bytes: offset, ranged, totalBytes };
  }

  /**
   * Telegram 的媒体条目没有文件名，标题只能从 DOM 拼：
   * 「会话名 · #消息ID」，两者都拿不到时返回空串（调用方退回标签页标题）。
   */
  function buildTelegramTitle({ chatTitle = '', messageId = '' } = {}) {
    const chat = String(chatTitle || '').replace(/\s+/g, ' ').trim();
    const id = String(messageId || '').replace(/[^\w-]/g, '').trim();
    if (chat && id) {
      return `${chat} #${id}`;
    }
    return chat || '';
  }

  globalThis.__OVD_TELEGRAM_UTILS__ = Object.freeze({
    PROGRESSIVE_PATH_SEGMENT,
    STREAM_PATH_SEGMENT,
    TELEGRAM_STREAM_PATH_SEGMENTS,
    TELEGRAM_WEB_HOSTS,
    buildTelegramTitle,
    guessMediaExtension,
    isTelegramBlobUrl,
    isTelegramMediaUrl,
    isTelegramProgressiveMediaUrl: isProgressiveMediaUrl,
    isTelegramStreamUrl,
    isTelegramWebHost,
    isTelegramWebPageUrl,
    matchTelegramStreamSegment,
    parseTelegramStreamInfo,
    readTelegramStream,
    createStreamAbortError,
    totalBytesFromContentRange,
  });
})();
