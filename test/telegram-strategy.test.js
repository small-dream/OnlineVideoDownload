'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule(globalKey, relPath) {
  delete globalThis[globalKey];
  const filePath = path.resolve(__dirname, '..', relPath);
  delete require.cache[filePath];
  require(filePath);
  return globalThis[globalKey];
}

function loadStrategy() {
  loadModule('__OVD_MESSAGE_TYPES__', 'lib/message-types.js');
  loadModule('__OVD_TELEGRAM_UTILS__', 'lib/telegram-utils.js');
  loadModule('__OVD_VIDEO_UTILS__', 'lib/video-utils.js');
  return loadModule('__OVD_TELEGRAM_STRATEGY__', 'content/strategies/telegram-strategy.js');
}

function createStrategy(fetchPageStreamInPage, overrides = {}) {
  return loadStrategy().createTelegramStrategy({
    fetchPageStreamInPage,
    videoUtils: globalThis.__OVD_VIDEO_UTILS__,
    ...overrides,
  });
}

const STREAM_URL = `https://web.telegram.org/k/stream/${encodeURIComponent(JSON.stringify({
  location: { id: '777' },
  mime_type: 'video/mp4',
  size: 2500,
}))}`;

function createContext(overrides = {}) {
  const progress = [];
  const statuses = [];
  return {
    context: {
      progressReporter: {
        progress: (percent) => progress.push(percent),
        status: (message) => statuses.push(message),
      },
      sourceId: 'telegram',
      strategyId: 'page-stream',
      taskKey: '777',
      title: '自拍群 #1234',
      traceId: 'trace-1',
      videoUrl: STREAM_URL,
      ...overrides,
    },
    progress,
    statuses,
  };
}

test('telegram strategy 把抓取交给页面上下文，并回传文件名/taskMeta/进度', async () => {
  const calls = [];
  const { context, progress, statuses } = createContext();
  const strategy = createStrategy(async (options) => {
    calls.push(options);
    options.onProgress(1250, 2500);
    options.onProgress(2500, 2500);
    return { downloadId: 42, filename: options.filename, ok: true, size: 2500 };
  });

  const result = await strategy.download({
    fileSize: 2500,
    mimeType: 'video/mp4',
    title: '自拍群 #1234',
    type: 'telegram',
    url: STREAM_URL,
  }, context);

  assert.equal(result.ok, true);
  assert.equal(result.downloadId, 42);
  assert.equal(result.filename, '自拍群 #1234.mp4');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, STREAM_URL);
  assert.equal(calls[0].filename, '自拍群 #1234.mp4');
  assert.equal(calls[0].mimeType, 'video/mp4');
  assert.equal(calls[0].fileSize, 2500);
  assert.deepEqual(calls[0].taskMeta, {
    sourceId: 'telegram',
    strategyId: 'page-stream',
    taskKey: '777',
    title: '自拍群 #1234',
    traceId: 'trace-1',
    videoInfo: { fileSize: 2500, mimeType: 'video/mp4', title: '自拍群 #1234', type: 'telegram', url: STREAM_URL },
    videoUrl: STREAM_URL,
  });

  assert.deepEqual(progress, [50, 99, 100]);
  assert.ok(statuses.some((message) => /Telegram/.test(message)));
});

test('telegram strategy 从流地址兜底解析体积与扩展名', async () => {
  const calls = [];
  const { context } = createContext();
  const strategy = createStrategy(async (options) => {
    calls.push(options);
    return { downloadId: 1, filename: options.filename, ok: true, size: 2500 };
  });

  await strategy.download({ title: '自拍群 #1234', type: 'telegram', url: STREAM_URL }, context);

  assert.equal(calls[0].fileSize, 2500);
  assert.equal(calls[0].mimeType, 'video/mp4');
  assert.equal(calls[0].filename, '自拍群 #1234.mp4');
});

test('telegram strategy 把 EMPTY_MEDIA_STREAM 映射为可读提示', async () => {
  const { context } = createContext();
  const error = new Error('empty media stream');
  error.code = 'EMPTY_MEDIA_STREAM';
  const strategy = createStrategy(async () => { throw error; });

  await assert.rejects(
    () => strategy.download({ type: 'telegram', title: 'TG', url: STREAM_URL }, context),
    /未取到任何视频数据/
  );
});

test('telegram strategy 透传取消错误（DOWNLOAD_ABORTED）', async () => {
  const { context } = createContext();
  const error = new Error('下载已取消');
  error.code = 'DOWNLOAD_ABORTED';
  const strategy = createStrategy(async () => { throw error; });

  await assert.rejects(
    () => strategy.download({ type: 'telegram', title: 'TG', url: STREAM_URL }, context),
    (thrown) => thrown.code === 'DOWNLOAD_ABORTED'
  );
});

test('telegram strategy 透传页面抓流失败', async () => {
  const { context } = createContext();
  const strategy = createStrategy(async () => { throw new Error('HTTP 302 Found'); });

  await assert.rejects(
    () => strategy.download({ type: 'telegram', title: 'TG', url: STREAM_URL }, context),
    /HTTP 302/
  );
});

test('telegram strategy 在页面抓流不可用时明确报错', async () => {
  const { context } = createContext();
  const strategy = createStrategy(null);

  await assert.rejects(
    () => strategy.download({ type: 'telegram', title: 'TG', url: STREAM_URL }, context),
    /页面侧抓流不可用/
  );
});

test('telegram strategy exposes support detection for the registry', () => {
  const strategy = createStrategy(async () => ({ ok: true }));
  assert.equal(strategy.supports({ type: 'telegram', url: STREAM_URL }), true);
  assert.equal(strategy.supports({ type: 'direct', url: STREAM_URL }), true);
  assert.equal(strategy.supports({ type: 'direct', url: 'https://example.com/a.mp4' }), false);
});
