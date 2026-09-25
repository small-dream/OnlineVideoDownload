'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '../background/download-strategies/hls-download-strategy.js');

let importCounter = 0;

/**
 * 每次带唯一的 query 重新 import，避免 ES Module 缓存导致 header-injector 的规则 ID 累积。
 */
function loadStrategy() {
  importCounter += 1;
  return import(`${pathToFileURL(MODULE_PATH).href}?test=${importCounter}`);
}

/**
 * 最小 chrome API mock：tabs / declarativeNetRequest / runtime。
 * tabMessageResponses 队列耗尽后模拟 "Receiving end does not exist"。
 */
function mockChrome({ tab = { url: 'https://movie.example.com/play/339370' }, tabMessageResponses = [] } = {}) {
  const calls = {
    dynamicRules: [],
    removedRuleIds: [],
    runtimeMessages: [],
    tabMessages: [],
  };
  const queue = [...tabMessageResponses];

  globalThis.chrome = {
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async ({ addRules = [], removeRuleIds = [] } = {}) => {
        calls.dynamicRules.push(...addRules);
        calls.removedRuleIds.push(...removeRuleIds);
      },
    },
    runtime: {
      lastError: null,
      sendMessage: (message, callback) => {
        calls.runtimeMessages.push(message);
        if (callback) callback({ ok: true });
      },
    },
    tabs: {
      get: async (tabId) => {
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return tab;
      },
      sendMessage: (tabId, message, callback) => {
        calls.tabMessages.push({ message, tabId });
        if (queue.length === 0) {
          globalThis.chrome.runtime.lastError = {
            message: 'Could not establish connection. Receiving end does not exist.',
          };
          callback(undefined);
          globalThis.chrome.runtime.lastError = null;
          return;
        }
        callback(queue.shift());
      },
    },
  };

  return calls;
}

function findRule(calls, headerName) {
  return calls.dynamicRules.find((rule) => {
    const headers = rule.action?.responseHeaders || rule.action?.requestHeaders || [];
    return headers.some((header) => header.header === headerName);
  });
}

const HLS_VIDEO = {
  requestHeaders: {
    Cookie: 'cf_clearance=abc',
    Referer: 'https://movie.example.com/play/339370',
  },
  type: 'hls',
  url: 'https://cdn10.11yun.space/TAV1/339370/339370.m3u8',
};

test('hls download delegates to the page context before touching the service worker fetcher', async () => {
  const calls = mockChrome({
    tabMessageResponses: [{
      downloadId: 77,
      failedCount: 0,
      filename: 'video.ts',
      ok: true,
      segmentCount: 12,
    }],
  });
  const { createHlsDownloadStrategy } = await loadStrategy();

  let fetcherCalls = 0;
  const result = await createHlsDownloadStrategy().download(HLS_VIDEO, {
    filenameBase: 'video',
    hlsFetcher: {
      downloadAndMerge: async () => {
        fetcherCalls += 1;
        return { downloadId: 1, ok: true };
      },
    },
    tabId: 5,
    taskMeta: { taskId: 'task-1', videoUrl: HLS_VIDEO.url },
  });

  assert.equal(fetcherCalls, 0);
  assert.equal(result.downloadId, 77);
  assert.equal(result.filename, 'video.ts');
  assert.equal(result.requiresTabContext, true);
  assert.equal(result.segmentCount, 12);

  assert.equal(calls.tabMessages.length, 1);
  const message = calls.tabMessages[0].message;
  assert.equal(message.type, 'HLS_DOWNLOAD_DELEGATE');
  assert.equal(calls.tabMessages[0].tabId, 5);
  assert.equal(message.m3u8Url, HLS_VIDEO.url);
  assert.equal(message.filename, 'video');
  assert.deepEqual(message.headers, HLS_VIDEO.requestHeaders);
  assert.deepEqual(message.options, { fetchOptions: { credentials: 'include' } });
  assert.deepEqual(message.taskMeta, { taskId: 'task-1', videoUrl: HLS_VIDEO.url });
});

test('page context delegation echoes the tab origin in CORS headers and cleans rules up', async () => {
  const calls = mockChrome({ tabMessageResponses: [{ ok: true }] });
  const { createHlsDownloadStrategy } = await loadStrategy();

  await createHlsDownloadStrategy().download(HLS_VIDEO, {
    filenameBase: 'video',
    hlsFetcher: { downloadAndMerge: async () => ({ ok: true }) },
    tabId: 5,
    taskMeta: {},
  });

  const corsRule = findRule(calls, 'access-control-allow-origin');
  assert.ok(corsRule, 'expected a CORS response header rule');
  assert.equal(
    corsRule.action.responseHeaders.find((h) => h.header === 'access-control-allow-origin').value,
    'https://movie.example.com'
  );
  assert.equal(
    corsRule.action.responseHeaders.find((h) => h.header === 'access-control-allow-credentials').value,
    'true'
  );
  assert.equal(corsRule.condition.urlFilter, '||cdn10.11yun.space');

  const refererRule = findRule(calls, 'referer');
  assert.ok(refererRule, 'expected a referer request header rule');
  assert.equal(
    refererRule.action.requestHeaders.find((h) => h.header === 'referer').value,
    'https://movie.example.com/play/339370'
  );

  assert.deepEqual(calls.removedRuleIds, calls.dynamicRules.map((rule) => rule.id));
  assert.ok(calls.removedRuleIds.length >= 2);
});

test('hls download falls back to the service worker fetcher when no content script responds', async () => {
  const calls = mockChrome({ tabMessageResponses: [] });
  const { createHlsDownloadStrategy } = await loadStrategy();

  let fetcherCalls = 0;
  const result = await createHlsDownloadStrategy().download(HLS_VIDEO, {
    filenameBase: 'video',
    hlsFetcher: {
      downloadAndMerge: async (...args) => {
        fetcherCalls += 1;
        assert.equal(args[0], HLS_VIDEO.url);
        assert.equal(args[1], 'video');
        assert.deepEqual(args[2], HLS_VIDEO.requestHeaders);
        assert.equal(args[4], 5);
        return { downloadId: 9, ok: true };
      },
    },
    tabId: 5,
    taskMeta: { taskId: 'task-1' },
  });

  assert.equal(fetcherCalls, 1);
  assert.equal(result.downloadId, 9);
  // 第一次是委托尝试，第二次是回退路径上报的 HLS_PROGRESS
  assert.deepEqual(calls.tabMessages.map((call) => call.message.type), ['HLS_DOWNLOAD_DELEGATE', 'HLS_PROGRESS']);

  // 后台回退路径依旧上报 HLS_PROGRESS，保持任务与 popup 进度一致
  const progressMessages = calls.runtimeMessages.filter((msg) => msg.type === 'HLS_PROGRESS');
  assert.ok(progressMessages.length >= 1);
  assert.equal(progressMessages.at(-1).percent, 100);
});

test('hls download falls back to the service worker fetcher when the page context fails', async () => {
  mockChrome({ tabMessageResponses: [{ error: 'HTTP 403: https://cdn10.11yun.space/x.m3u8', ok: false }] });
  const { createHlsDownloadStrategy } = await loadStrategy();

  let fetcherCalls = 0;
  const result = await createHlsDownloadStrategy().download(HLS_VIDEO, {
    filenameBase: 'video',
    hlsFetcher: {
      downloadAndMerge: async () => {
        fetcherCalls += 1;
        return { downloadId: 11, ok: true };
      },
    },
    tabId: 5,
    taskMeta: {},
  });

  assert.equal(fetcherCalls, 1);
  assert.equal(result.downloadId, 11);
});

test('hls download skips delegation when the task has no tab context', async () => {
  const calls = mockChrome({ tabMessageResponses: [{ ok: true }] });
  const { createHlsDownloadStrategy } = await loadStrategy();

  let fetcherCalls = 0;
  const result = await createHlsDownloadStrategy().download(HLS_VIDEO, {
    filenameBase: 'video',
    hlsFetcher: {
      downloadAndMerge: async () => {
        fetcherCalls += 1;
        return { downloadId: 13, ok: true };
      },
    },
    tabId: null,
    taskMeta: {},
  });

  assert.deepEqual(calls.tabMessages.map((call) => call.message.type), ['HLS_PROGRESS']);
  assert.equal(calls.dynamicRules.length, 0);
  assert.equal(fetcherCalls, 1);
  assert.equal(result.downloadId, 13);
});

test('hls strategy only supports hls video types', async () => {
  mockChrome();
  const { createHlsDownloadStrategy } = await loadStrategy();
  const strategy = createHlsDownloadStrategy();

  assert.equal(strategy.id, 'hls');
  assert.equal(strategy.supports({ type: 'hls' }), true);
  assert.equal(strategy.supports({ type: 'direct' }), false);
  assert.equal(strategy.supports(null), false);
});
