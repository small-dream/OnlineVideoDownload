'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule() {
  delete globalThis.__OVD_TELEGRAM_UTILS__;
  const filePath = path.resolve(__dirname, '../lib/telegram-utils.js');
  delete require.cache[filePath];
  require(filePath);
  return globalThis.__OVD_TELEGRAM_UTILS__;
}

const STREAM_PAYLOAD = encodeURIComponent(JSON.stringify({
  dcId: 2,
  location: { id: '1234567890123' },
  mime_type: 'video/mp4',
  size: 5242880,
}));
const STREAM_URL = `https://web.telegram.org/k/stream/${STREAM_PAYLOAD}`;

// --- isTelegramStreamUrl / isTelegramWebPageUrl ---

test('isTelegramStreamUrl: detects the WebK streaming endpoint', () => {
  const { isTelegramStreamUrl } = loadModule();
  assert.equal(isTelegramStreamUrl(STREAM_URL), true);
});

test('isTelegramStreamUrl: tolerates the Chromium mp4 workaround query', () => {
  const { isTelegramStreamUrl } = loadModule();
  assert.equal(isTelegramStreamUrl(`${STREAM_URL}?_crbug1250841`), true);
});

test('isTelegramStreamUrl: ignores the chat page itself', () => {
  const { isTelegramStreamUrl } = loadModule();
  assert.equal(isTelegramStreamUrl('https://web.telegram.org/k/#@zipaiqun888'), false);
});

test('isTelegramStreamUrl: ignores other origins serving a stream/ path', () => {
  const { isTelegramStreamUrl } = loadModule();
  assert.equal(isTelegramStreamUrl('https://example.com/stream/abc'), false);
});

test('isTelegramWebPageUrl: matches Telegram Web hosts only', () => {
  const { isTelegramWebPageUrl } = loadModule();
  assert.equal(isTelegramWebPageUrl('https://web.telegram.org/k/#@zipaiqun888'), true);
  assert.equal(isTelegramWebPageUrl('https://webz.telegram.org/a/'), true);
  assert.equal(isTelegramWebPageUrl('https://example.com/k/'), false);
  assert.equal(isTelegramWebPageUrl(''), false);
});

// --- isTelegramBlobUrl / isTelegramMediaUrl ---

test('isTelegramBlobUrl: only Telegram-created blobs count', () => {
  const { isTelegramBlobUrl } = loadModule();
  assert.equal(isTelegramBlobUrl('blob:https://web.telegram.org/2f00-4a1b'), true);
  assert.equal(isTelegramBlobUrl('blob:https://example.com/2f00-4a1b'), false);
  assert.equal(isTelegramBlobUrl('https://web.telegram.org/k/stream/x'), false);
});

test('isTelegramMediaUrl: stream and blob both qualify', () => {
  const { isTelegramMediaUrl } = loadModule();
  assert.equal(isTelegramMediaUrl(STREAM_URL), true);
  assert.equal(isTelegramMediaUrl('blob:https://web.telegram.org/2f00-4a1b'), true);
  assert.equal(isTelegramMediaUrl('https://web.telegram.org/k/'), false);
});

// --- parseTelegramStreamInfo ---

test('parseTelegramStreamInfo: reads docId / mime / size from the encoded payload', () => {
  const { parseTelegramStreamInfo } = loadModule();
  assert.deepEqual(parseTelegramStreamInfo(STREAM_URL), {
    docId: '1234567890123',
    mimeType: 'video/mp4',
    size: 5242880,
  });
});

test('parseTelegramStreamInfo: falls back to the mime query parameter', () => {
  const { parseTelegramStreamInfo } = loadModule();
  assert.deepEqual(parseTelegramStreamInfo('https://web.telegram.org/k/stream/1-98765?mime=video%2Fwebm'), {
    accountNumber: '1',
    docId: '98765',
    mimeType: 'video/webm',
    size: 0,
  });
});

test('parseTelegramStreamInfo: opaque payloads do not throw', () => {
  const { parseTelegramStreamInfo } = loadModule();
  const info = parseTelegramStreamInfo('https://web.telegram.org/k/stream/not-json');
  assert.equal(info.mimeType, '');
  assert.equal(info.size, 0);
});

test('parseTelegramStreamInfo: non-Telegram urls return null', () => {
  const { parseTelegramStreamInfo } = loadModule();
  assert.equal(parseTelegramStreamInfo('https://example.com/k/stream/x'), null);
});

// --- guessMediaExtension / buildTelegramTitle ---

test('guessMediaExtension: maps common Telegram mime types', () => {
  const { guessMediaExtension } = loadModule();
  assert.equal(guessMediaExtension('video/mp4'), '.mp4');
  assert.equal(guessMediaExtension('video/webm; codecs=vp9'), '.webm');
  assert.equal(guessMediaExtension('audio/mpeg'), '.mp3');
  assert.equal(guessMediaExtension('application/octet-stream', '.bin'), '.bin');
  assert.equal(guessMediaExtension('', '.mp4'), '.mp4');
});

test('buildTelegramTitle: combines chat title and message id', () => {
  const { buildTelegramTitle } = loadModule();
  assert.equal(buildTelegramTitle({ chatTitle: '自拍群', messageId: '1234' }), '自拍群 #1234');
  assert.equal(buildTelegramTitle({ chatTitle: '自拍群', messageId: '' }), '自拍群');
  assert.equal(buildTelegramTitle({}), '');
  assert.equal(buildTelegramTitle(), '');
});

// --- readTelegramStream（页面上下文按 Range 抓流） ---

function makeSource(length) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = i % 251;
  }
  return bytes;
}

function createStreamResponse(source, start, length, total) {
  const slice = source.subarray(start, start + length).slice();
  const headers = new Map();
  if (total != null) {
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${total}`);
  }
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(slice);
        controller.close();
      },
    }),
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    ok: total == null,
    status: total == null ? 200 : 206,
    statusText: total == null ? 'OK' : 'Partial Content',
  };
}

/** 模仿 WebK 的 SW：按 Range 返回分片，单次最多 maxChunk 字节 */
function createRangeFetch(source, maxChunk = source.length) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const range = init.headers?.Range || '';
    requests.push({ range, url });
    const match = /bytes=(\d+)-(\d+)/.exec(range);
    if (!match) {
      return createStreamResponse(source, 0, source.length, null);
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), start + maxChunk - 1, source.length - 1);
    return createStreamResponse(source, start, Math.max(0, end - start + 1), source.length);
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}

test('readTelegramStream: 循环 Range 直到 Content-Range 总长，逐块回调', async () => {
  const { readTelegramStream } = loadModule();
  const source = makeSource(2500);
  const chunks = [];
  const progress = [];
  const fetchImpl = createRangeFetch(source, 700);

  const result = await readTelegramStream({
    url: STREAM_URL,
    fetchImpl,
    transferChunkBytes: 400,
    onChunk: (bytes) => {
      chunks.push(Buffer.from(bytes));
    },
    onProgress: (loadedBytes, totalBytes) => progress.push([loadedBytes, totalBytes]),
  });

  assert.equal(result.bytes, 2500);
  assert.equal(result.totalBytes, 2500);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(source));
  assert.equal(fetchImpl.requests.length, 4);
  assert.equal(fetchImpl.requests[0].range, 'bytes=0-2097151');
  assert.equal(fetchImpl.requests[1].range, 'bytes=700-2097851');
  assert.equal(progress.at(-1)[0], 2500);
  assert.equal(progress.at(-1)[1], 2500);
});

test('readTelegramStream: await onChunk 形成背压（串行写入）', async () => {
  const { readTelegramStream } = loadModule();
  const source = makeSource(200);
  const fetchImpl = createRangeFetch(source, 200);
  const order = [];

  await readTelegramStream({
    url: STREAM_URL,
    fetchImpl,
    transferChunkBytes: 50,
    onChunk: async (bytes, seq) => {
      order.push(`start-${seq}`);
      await Promise.resolve();
      order.push(`end-${seq}`);
    },
  });

  assert.deepEqual(order, ['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
});

test('readTelegramStream: 整包响应（忽略 Range）只读一次', async () => {
  const { readTelegramStream } = loadModule();
  const source = makeSource(900);
  const fetchImpl = createRangeFetch(source);

  const result = await readTelegramStream({ url: STREAM_URL, fetchImpl });

  assert.equal(result.bytes, 900);
  assert.equal(fetchImpl.requests.length, 1);
});

test('readTelegramStream: HTTP 错误原样抛出（含 302）', async () => {
  const { readTelegramStream } = loadModule();
  const fetchImpl = async () => ({
    body: null,
    headers: { get: () => null },
    ok: false,
    status: 302,
    statusText: 'Found',
  });

  await assert.rejects(
    () => readTelegramStream({ url: STREAM_URL, fetchImpl }),
    /HTTP 302 Found/
  );
});

test('readTelegramStream: signal 已中止时抛 DOWNLOAD_ABORTED', async () => {
  const { readTelegramStream } = loadModule();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => readTelegramStream({ url: STREAM_URL, fetchImpl: async () => { throw new Error('should not fetch'); }, signal: controller.signal }),
    (error) => error.code === 'DOWNLOAD_ABORTED'
  );
});

test('readTelegramStream: 缺少 url 时直接报错', async () => {
  const { readTelegramStream } = loadModule();
  await assert.rejects(() => readTelegramStream({ fetchImpl: async () => {} }), /缺少视频地址/);
});
