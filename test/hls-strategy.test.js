'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadHlsStrategy() {
  const key = '__OVD_HLS_STRATEGY__';
  const filePath = path.resolve(__dirname, '../content/strategies/hls-strategy.js');
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[key];
}

function createPipeline(overrides = {}) {
  const fetchCalls = [];
  const pipeline = {
    decryptHlsSegments: async (buffers) => buffers,
    ensureExtension: (name, ext) => `${name}${ext}`,
    hlsFetchBuffer: async (url, headers, options) => {
      fetchCalls.push({ headers, options, url });
      return new Uint8Array(2).buffer;
    },
    hlsFetchText: async (url, headers, options) => {
      fetchCalls.push({ headers, options, url });
      return '#EXTM3U\n#EXTINF:1,\nseg1.ts\n';
    },
    inferHlsOutputProfile: () => ({ ext: '.ts', mimeType: 'video/mp2t' }),
    parseHlsEncryption: async () => null,
    parseHlsPlaylist: () => ({
      initSegmentUrl: null,
      segments: ['https://cdn.example.com/seg1.ts'],
    }),
    selectBestHlsStream: (text, baseUrl) => baseUrl,
    ...overrides,
  };

  return { fetchCalls, pipeline };
}

test('HLS 委托下载在页面上下文带 Cookie 请求并把 downloadId 回传给后台', async () => {
  const { fetchCalls, pipeline } = createPipeline();
  const blobDownloads = [];
  const progressMessages = [];
  const taskMeta = { taskId: 'task-1', videoUrl: 'https://cdn.example.com/index.m3u8' };

  const handler = loadHlsStrategy().createHlsDelegateHandler({
    emitRuntimeMessage: (message) => progressMessages.push(message),
    hlsPipeline: pipeline,
    triggerBlobDownload: (blob, filename, receivedTaskMeta) => {
      blobDownloads.push({ filename, size: blob.size, taskMeta: receivedTaskMeta });
      return Promise.resolve({ downloadId: 42, ok: true });
    },
  });

  const result = await handler.handle('https://cdn.example.com/index.m3u8', 'video', {}, taskMeta);

  assert.equal(fetchCalls.length, 2);
  assert.ok(fetchCalls.every((call) => call.options.credentials === 'include'));
  assert.equal(fetchCalls[0].url, 'https://cdn.example.com/index.m3u8');
  assert.equal(blobDownloads.length, 1);
  assert.equal(blobDownloads[0].filename, 'video.ts');
  assert.equal(blobDownloads[0].size, 2);
  assert.deepEqual(blobDownloads[0].taskMeta, taskMeta);

  assert.equal(result.downloadId, 42);
  assert.equal(result.filename, 'video.ts');
  assert.equal(result.segmentCount, 1);
  assert.equal(result.failedCount, 0);

  assert.equal(progressMessages.at(-1).percent, 100);
  assert.equal(progressMessages.at(-1).phase, 'browser-handoff');
  assert.deepEqual(progressMessages.at(-1).taskMeta, taskMeta);
});

test('HLS 委托下载允许调用方覆盖 fetchOptions', async () => {
  const { fetchCalls, pipeline } = createPipeline();
  const handler = loadHlsStrategy().createHlsDelegateHandler({
    hlsPipeline: pipeline,
    triggerBlobDownload: () => Promise.resolve({ downloadId: 1, ok: true }),
  });

  await handler.handle(
    'https://cdn.example.com/index.m3u8',
    'video',
    {},
    {},
    { fetchOptions: { credentials: 'omit' } }
  );

  assert.ok(fetchCalls.every((call) => call.options.credentials === 'omit'));
});

test('HLS 委托下载把 m3u8 403 透出为错误，交由后台决定是否回退', async () => {
  const { pipeline } = createPipeline({
    hlsFetchText: async () => {
      throw new Error('HTTP 403: https://cdn10.11yun.space/TAV1/339370/339370.m3u8');
    },
  });
  const handler = loadHlsStrategy().createHlsDelegateHandler({
    hlsPipeline: pipeline,
    triggerBlobDownload: () => Promise.resolve({ downloadId: 1, ok: true }),
  });

  await assert.rejects(
    () => handler.handle('https://cdn10.11yun.space/TAV1/339370/339370.m3u8', 'video', {}, {}),
    /HTTP 403/
  );
});

test('HLS 委托下载在浏览器下载提交失败时抛错', async () => {
  const { pipeline } = createPipeline();
  const handler = loadHlsStrategy().createHlsDelegateHandler({
    hlsPipeline: pipeline,
    triggerBlobDownload: () => Promise.resolve({ error: 'user canceled', ok: false }),
  });

  await assert.rejects(
    () => handler.handle('https://cdn.example.com/index.m3u8', 'video', {}, {}),
    /user canceled/
  );
});

test('HLS 委托下载在 m3u8 无分片时报错', async () => {
  const { pipeline } = createPipeline({
    parseHlsPlaylist: () => ({ initSegmentUrl: null, segments: [] }),
  });
  const handler = loadHlsStrategy().createHlsDelegateHandler({
    hlsPipeline: pipeline,
    triggerBlobDownload: () => Promise.resolve({ downloadId: 1, ok: true }),
  });

  await assert.rejects(
    () => handler.handle('https://cdn.example.com/index.m3u8', 'video', {}, {}),
    /没有找到分片/
  );
});
