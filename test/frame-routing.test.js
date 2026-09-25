'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadBrowserCompat(sendMessageImpl) {
  globalThis.chrome = {
    tabs: { sendMessage: sendMessageImpl },
    runtime: { sendMessage() {} },
  };
  delete globalThis.__OVD_BROWSER_COMPAT__;
  delete globalThis.__OVD_BROWSER__;
  const filePath = path.resolve(__dirname, '../lib/browser-compat.js');
  delete require.cache[filePath];
  require(filePath);
  return globalThis.__OVD_BROWSER_COMPAT__;
}

test('sendTabMessageAsync: 无 frameId 时广播到所有 frame（三参调用）', async () => {
  const calls = [];
  const compat = loadBrowserCompat((...args) => {
    calls.push(args);
    args[args.length - 1]({ ok: true });
  });

  await compat.sendTabMessageAsync(1, { type: 'PING' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 3); // tabId, message, callback
});

test('sendTabMessageAsync: meta.frameId 自动定向到子框架', async () => {
  const calls = [];
  const compat = loadBrowserCompat((...args) => {
    calls.push(args);
    args[args.length - 1]({ ok: true });
  });

  await compat.sendTabMessageAsync(1, { type: 'SOURCE_DOWNLOAD', meta: { url: 'blob:x', frameId: 7 } });
  assert.equal(calls[0].length, 4); // tabId, message, options, callback
  assert.deepEqual(calls[0][2], { frameId: 7 });
});

test('sendTabMessageAsync: 主框架 frameId=0 也定向（0 是合法值）', async () => {
  const calls = [];
  const compat = loadBrowserCompat((...args) => {
    calls.push(args);
    args[args.length - 1]({ ok: true });
  });

  await compat.sendTabMessageAsync(1, { type: 'SOURCE_DOWNLOAD', meta: { frameId: 0 } });
  assert.deepEqual(calls[0][2], { frameId: 0 });
});

test('sendTabMessageAsync: 显式 options 优先于 meta.frameId', async () => {
  const calls = [];
  const compat = loadBrowserCompat((...args) => {
    calls.push(args);
    args[args.length - 1]({ ok: true });
  });

  await compat.sendTabMessageAsync(1, { type: 'X', meta: { frameId: 3 } }, { frameId: 9 });
  assert.deepEqual(calls[0][2], { frameId: 9 });
});

test('safeTabMessage: taskMeta.videoInfo.frameId 自动定向', async () => {
  const calls = [];
  const compat = loadBrowserCompat((...args) => {
    calls.push(args);
    args[args.length - 1]({ ok: true });
  });

  await compat.safeTabMessage(1, {
    type: 'FETCH_BLOB',
    taskMeta: { videoInfo: { url: 'blob:x', frameId: 12 } },
  });
  assert.equal(calls[0].length, 4);
  assert.deepEqual(calls[0][2], { frameId: 12 });
});

test('safeTabMessage: 显式第 4 参 options 生效', async () => {
  const calls = [];
  const compat = loadBrowserCompat((...args) => {
    calls.push(args);
    args[args.length - 1]({ ok: true });
  });

  await compat.safeTabMessage(1, { type: 'MEDIA_STREAM_START' }, undefined, { frameId: 5 });
  assert.deepEqual(calls[0][2], { frameId: 5 });
});
