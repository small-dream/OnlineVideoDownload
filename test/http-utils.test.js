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

// --- 候设备用地址回退（B 站主地址为 PCDN 节点，失败时要用 backupUrl） ---

test('hostOfUrl 返回 hostname，非法 URL 返回空串', () => {
  const { hostOfUrl } = mod();
  assert.equal(
    hostOfUrl('https://xy106x227x71x161xy.mcdn.bilivideo.cn:8082/a.m4s?x=1'),
    'xy106x227x71x161xy.mcdn.bilivideo.cn'
  );
  assert.equal(hostOfUrl('not-a-url'), '');
  assert.equal(hostOfUrl(null), '');
});

test('fetchFirstAvailableUrl 返回第一个成功的地址与结果', async () => {
  const { fetchFirstAvailableUrl } = mod();
  const tried = [];
  const result = await fetchFirstAvailableUrl(['https://a.example/1.m4s', 'https://b.example/1.m4s'], async (url) => {
    tried.push(url);
    return `data:${url}`;
  });

  assert.deepEqual(tried, ['https://a.example/1.m4s']);
  assert.deepEqual(result, { url: 'https://a.example/1.m4s', value: 'data:https://a.example/1.m4s' });
});

test('fetchFirstAvailableUrl 主地址失败时回退到备用地址', async () => {
  const { fetchFirstAvailableUrl } = mod();
  const tried = [];
  const result = await fetchFirstAvailableUrl(['https://primary.example/1.m4s', 'https://backup.example/1.m4s'], async (url) => {
    tried.push(url);
    if (url.includes('primary')) {
      throw new Error('Failed to fetch');
    }
    return 'ok';
  });

  assert.deepEqual(tried, ['https://primary.example/1.m4s', 'https://backup.example/1.m4s']);
  assert.equal(result.url, 'https://backup.example/1.m4s');
  assert.equal(result.value, 'ok');
});

test('fetchFirstAvailableUrl 全部失败时报出每个候选域名与原因', async () => {
  const { fetchFirstAvailableUrl } = mod();
  await assert.rejects(
    () => fetchFirstAvailableUrl(['https://a.example/1.m4s'], async () => { throw new Error('Failed to fetch'); }),
    (err) => {
      assert.match(err.message, /所有候选地址均失败/);
      assert.match(err.message, /a\.example: Failed to fetch/);
      return true;
    }
  );
});

test('fetchFirstAvailableUrl 空候选或缺少下载实现时直接报错', async () => {
  const { fetchFirstAvailableUrl } = mod();
  await assert.rejects(() => fetchFirstAvailableUrl([], async () => 'ok'), /没有可用的候选下载地址/);
  await assert.rejects(() => fetchFirstAvailableUrl(['https://a.example/1.m4s']), /缺少候选地址下载实现/);
});
