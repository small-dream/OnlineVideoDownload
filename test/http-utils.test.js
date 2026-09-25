'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule(globalKey, filePath) {
  delete globalThis[globalKey];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[globalKey];
}

const mod = () => loadModule('__OVD_HTTP_UTILS__', path.resolve(__dirname, '../lib/http-utils.js'));

// --- parseContentRangeTotal ---

test('parseContentRangeTotal: "bytes 0-1023/2048" returns 2048', () => {
  const { parseContentRangeTotal } = mod();
  assert.equal(parseContentRangeTotal('bytes 0-1023/2048'), 2048);
});

test('parseContentRangeTotal: "bytes 0-1023/*" returns 0', () => {
  const { parseContentRangeTotal } = mod();
  assert.equal(parseContentRangeTotal('bytes 0-1023/*'), 0);
});

test('parseContentRangeTotal: null returns 0', () => {
  const { parseContentRangeTotal } = mod();
  assert.equal(parseContentRangeTotal(null), 0);
});

test('parseContentRangeTotal: empty string returns 0', () => {
  const { parseContentRangeTotal } = mod();
  assert.equal(parseContentRangeTotal(''), 0);
});

test('parseContentRangeTotal: "bytes 0-499/1000" returns 1000', () => {
  const { parseContentRangeTotal } = mod();
  assert.equal(parseContentRangeTotal('bytes 0-499/1000'), 1000);
});

// --- parseTotalBytesHintFromUrl ---

test('parseTotalBytesHintFromUrl: URL with clen=12345 returns 12345', () => {
  const { parseTotalBytesHintFromUrl } = mod();
  assert.equal(parseTotalBytesHintFromUrl('https://example.com/video.mp4?clen=12345'), 12345);
});

test('parseTotalBytesHintFromUrl: URL without clen returns 0', () => {
  const { parseTotalBytesHintFromUrl } = mod();
  assert.equal(parseTotalBytesHintFromUrl('https://example.com/video.mp4'), 0);
});

test('parseTotalBytesHintFromUrl: invalid URL returns 0', () => {
  const { parseTotalBytesHintFromUrl } = mod();
  assert.equal(parseTotalBytesHintFromUrl('not-a-url'), 0);
});

// --- inferTotalBytesFromResponse ---

test('inferTotalBytesFromResponse: content-range takes priority', () => {
  const { inferTotalBytesFromResponse } = mod();
  const response = {
    status: 206,
    headers: {
      get(key) {
        if (key === 'content-range') return 'bytes 0-1023/9999';
        if (key === 'content-length') return '5000';
        return null;
      },
    },
  };
  assert.equal(inferTotalBytesFromResponse(response), 9999);
});

test('inferTotalBytesFromResponse: 206 + loaded + content-length sums to total', () => {
  const { inferTotalBytesFromResponse } = mod();
  const response = {
    status: 206,
    headers: {
      get(key) {
        if (key === 'content-range') return null;
        if (key === 'content-length') return '2048';
        return null;
      },
    },
  };
  assert.equal(inferTotalBytesFromResponse(response, 1024, 0, ''), 3072);
});

test('inferTotalBytesFromResponse: content-length when not 206', () => {
  const { inferTotalBytesFromResponse } = mod();
  const response = {
    status: 200,
    headers: {
      get(key) {
        if (key === 'content-length') return '5000';
        return null;
      },
    },
  };
  assert.equal(inferTotalBytesFromResponse(response), 5000);
});

test('inferTotalBytesFromResponse: falls back to fallbackTotal', () => {
  const { inferTotalBytesFromResponse } = mod();
  const response = {
    status: 200,
    headers: { get() { return null; } },
  };
  assert.equal(inferTotalBytesFromResponse(response, 0, 7777, ''), 7777);
});

test('inferTotalBytesFromResponse: url clen hint used when headers have nothing', () => {
  const { inferTotalBytesFromResponse } = mod();
  const response = {
    status: 200,
    headers: { get() { return null; } },
  };
  assert.equal(inferTotalBytesFromResponse(response, 0, 0, 'https://example.com/v?clen=8888'), 8888);
});

test('inferTotalBytesFromResponse: returns 0 when nothing available', () => {
  const { inferTotalBytesFromResponse } = mod();
  assert.equal(inferTotalBytesFromResponse(null), 0);
});

// --- createRangeRequestHeaders ---

test('createRangeRequestHeaders: start > 0 adds Range header', () => {
  const { createRangeRequestHeaders } = mod();
  const result = createRangeRequestHeaders({}, 1024);
  assert.equal(result.Range, 'bytes=1024-');
});

test('createRangeRequestHeaders: start=0 removes Range header', () => {
  const { createRangeRequestHeaders } = mod();
  const result = createRangeRequestHeaders({ Range: 'bytes=500-' }, 0);
  assert.ok(!('Range' in result));
});

test('createRangeRequestHeaders: null headers returns empty object with start > 0', () => {
  const { createRangeRequestHeaders } = mod();
  const result = createRangeRequestHeaders(null, 2048);
  assert.equal(result.Range, 'bytes=2048-');
});

test('createRangeRequestHeaders: null headers and start=0 returns empty object', () => {
  const { createRangeRequestHeaders } = mod();
  const result = createRangeRequestHeaders(null, 0);
  assert.deepEqual(result, {});
});

test('createRangeRequestHeaders: preserves existing headers', () => {
  const { createRangeRequestHeaders } = mod();
  const result = createRangeRequestHeaders({ 'Content-Type': 'video/mp4' }, 512);
  assert.equal(result['Content-Type'], 'video/mp4');
  assert.equal(result.Range, 'bytes=512-');
});

// --- 4.3：闭区间 Range（原先只支持 bytes=N-） ---

test('createRangeHeaderValue 支持闭区间与开放式范围', () => {
  const api = mod();
  assert.equal(api.createRangeHeaderValue(0, 0), 'bytes=0-0');
  assert.equal(api.createRangeHeaderValue(100, 199), 'bytes=100-199');
  assert.equal(api.createRangeHeaderValue(100), 'bytes=100-');
  assert.equal(api.createRangeHeaderValue(0), '');
  assert.equal(api.createRangeHeaderValue(0, null), '');
});

test('createRangeRequestHeaders 支持 end 且剔除原有 Range（避免冲突）', () => {
  const api = mod();
  assert.deepEqual(
    api.createRangeRequestHeaders({ Range: 'bytes=5-', Referer: 'https://a/' }, 10, 20),
    { Range: 'bytes=10-20', Referer: 'https://a/' }
  );
  assert.deepEqual(api.createRangeRequestHeaders({ Range: 'bytes=5-' }, 0), {});
});
