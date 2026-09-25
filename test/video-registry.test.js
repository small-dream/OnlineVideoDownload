'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function createRegistry() {
  const { VideoRegistry } = await import('../background/video-registry.js');
  return new VideoRegistry();
}

test('add registers a new video entry', async () => {
  const registry = await createRegistry();
  const result = registry.add(1, {
    url: 'https://example.com/v.mp4',
    type: 'direct',
    title: 'demo',
    requestHeaders: { Referer: 'https://example.com/' },
  });

  assert.equal(result, 'new');
  const videos = registry.getForTab(1);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].url, 'https://example.com/v.mp4');
  assert.equal(videos[0].tabId, 1);
  assert.deepEqual(videos[0].requestHeaders, { Referer: 'https://example.com/' });
});

test('add ignores invalid input', async () => {
  const registry = await createRegistry();
  assert.equal(registry.add(0, { url: 'https://example.com/v.mp4' }), 'ignored');
  assert.equal(registry.add(-1, { url: 'https://example.com/v.mp4' }), 'ignored');
  assert.equal(registry.add(1, null), 'ignored');
  assert.equal(registry.add(1, { type: 'direct' }), 'ignored');
  assert.equal(registry.countForTab(1), 0);
});

test('merge keeps captured requestHeaders when later report carries empty object', async () => {
  const registry = await createRegistry();
  const url = 'https://example.com/v.mp4';

  // onSendHeaders 先捕获到真实请求头
  registry.add(1, { url, type: 'direct', requestHeaders: { Referer: 'https://example.com/', Origin: 'https://example.com' } });
  // 页面侧 reportVideo 后上报，固定带空 requestHeaders
  const result = registry.add(1, { url, type: 'direct', title: 'demo', requestHeaders: {} });

  assert.equal(result, 'updated');
  const video = registry.getByUrl(1, url);
  assert.deepEqual(video.requestHeaders, { Referer: 'https://example.com/', Origin: 'https://example.com' });
  assert.equal(video.title, 'demo');
});

test('merge keeps captured requestHeaders when later report omits the field', async () => {
  const registry = await createRegistry();
  const url = 'https://example.com/v.mp4';

  registry.add(1, { url, type: 'direct', requestHeaders: { Cookie: 'sid=1' } });
  registry.add(1, { url, type: 'direct', mimeType: 'video/mp4', fileSize: 1024 });

  const video = registry.getByUrl(1, url);
  assert.deepEqual(video.requestHeaders, { Cookie: 'sid=1' });
  assert.equal(video.mimeType, 'video/mp4');
  assert.equal(video.fileSize, 1024);
});

test('merge overwrites requestHeaders when later report carries non-empty headers', async () => {
  const registry = await createRegistry();
  const url = 'https://example.com/v.mp4';

  registry.add(1, { url, type: 'direct', requestHeaders: { Referer: 'https://a.example/' } });
  registry.add(1, { url, type: 'direct', requestHeaders: { Referer: 'https://b.example/', Cookie: 'sid=2' } });

  const video = registry.getByUrl(1, url);
  assert.deepEqual(video.requestHeaders, { Referer: 'https://b.example/', Cookie: 'sid=2' });
});

test('merge keeps existing title when later report carries empty title', async () => {
  const registry = await createRegistry();
  const url = 'https://example.com/v.mp4';

  registry.add(1, { url, type: 'direct', title: '片名' });
  // onBeforeRequest 后到会带 title: ''
  registry.add(1, { url, type: 'direct', title: '', requestHeaders: {} });

  assert.equal(registry.getByUrl(1, url).title, '片名');
});

test('merge keeps existing fileSize when later report carries undefined or zero', async () => {
  const registry = await createRegistry();
  const url = 'https://example.com/v.mp4';

  registry.add(1, { url, type: 'direct', fileSize: 2048 });
  registry.add(1, { url, type: 'direct', fileSize: undefined });
  assert.equal(registry.getByUrl(1, url).fileSize, 2048);

  registry.add(1, { url, type: 'direct', fileSize: 0 });
  assert.equal(registry.getByUrl(1, url).fileSize, 2048);

  // 真实的非零值仍然正常更新
  registry.add(1, { url, type: 'direct', fileSize: 4096 });
  assert.equal(registry.getByUrl(1, url).fileSize, 4096);
});

test('merge keeps existing duration and mimeType against empty values', async () => {
  const registry = await createRegistry();
  const url = 'https://example.com/v.mp4';

  registry.add(1, { url, type: 'direct', duration: 95, mimeType: 'video/mp4' });
  registry.add(1, { url, type: 'direct', duration: null, mimeType: '' });

  const video = registry.getByUrl(1, url);
  assert.equal(video.duration, 95);
  assert.equal(video.mimeType, 'video/mp4');
});

test('identical re-report returns unchanged', async () => {
  const registry = await createRegistry();
  const url = 'https://example.com/v.mp4';
  const info = { url, type: 'direct', title: 'demo', requestHeaders: { Referer: 'https://example.com/' } };

  registry.add(1, info);
  assert.equal(registry.add(1, { ...info }), 'unchanged');
});

test('blob entries register with tabId and survive for popup listing', async () => {
  const registry = await createRegistry();
  const url = 'blob:https://example.com/4b1d9c2f-0000-4b00-8000-000000000000';

  const result = registry.add(7, {
    url,
    type: 'blob',
    title: 'MSE 视频',
    mimeType: 'video/mp4',
    requiresTabContext: true,
  });

  assert.equal(result, 'new');
  const videos = registry.getForTab(7);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].type, 'blob');
  assert.equal(videos[0].tabId, 7);
  assert.equal(videos[0].requiresTabContext, true);
  assert.equal(registry.getByUrl(7, url).mimeType, 'video/mp4');
});

test('clearTab removes entries for the tab', async () => {
  const registry = await createRegistry();
  registry.add(1, { url: 'https://example.com/a.mp4', type: 'direct' });
  registry.add(2, { url: 'https://example.com/b.mp4', type: 'direct' });

  registry.clearTab(1);
  assert.equal(registry.countForTab(1), 0);
  assert.equal(registry.countForTab(2), 1);
});

test('add 记录上报来源 frameId', async () => {
  const registry = await createRegistry();
  registry.add(1, { url: 'blob:https://example.com/uuid-1', type: 'blob', frameId: 3 });

  assert.equal(registry.getByUrl(1, 'blob:https://example.com/uuid-1').frameId, 3);
});

test('主子框架重复上报同一 URL 时合并为单条并更新 frameId', async () => {
  const registry = await createRegistry();
  const url = 'https://example.com/v.mp4';

  registry.add(1, { url, type: 'direct', frameId: 0 });
  registry.add(1, { url, type: 'direct', frameId: 5, title: 'iframe 上报' });

  const videos = registry.getForTab(1);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].frameId, 5);
  assert.equal(videos[0].title, 'iframe 上报');
});

test('不同 frame 的 blob URL 各自独立成条目', async () => {
  const registry = await createRegistry();
  registry.add(1, { url: 'blob:https://example.com/uuid-a', type: 'blob', frameId: 0 });
  registry.add(1, { url: 'blob:https://example.com/uuid-b', type: 'blob', frameId: 2 });

  assert.equal(registry.countForTab(1), 2);
});

test('clearFrame 只清理指定 frame 的条目', async () => {
  const registry = await createRegistry();
  registry.add(1, { url: 'https://example.com/main.mp4', type: 'direct', frameId: 0 });
  registry.add(1, { url: 'blob:https://example.com/uuid-b', type: 'blob', frameId: 2 });
  registry.add(1, { url: 'https://example.com/no-frame.mp4', type: 'direct' });

  registry.clearFrame(1, 2);
  const videos = registry.getForTab(1);
  assert.equal(videos.length, 2);
  assert.ok(videos.every((v) => v.frameId !== 2));

  registry.clearFrame(1, 0);
  assert.equal(registry.getForTab(1).length, 1);
  assert.equal(registry.getForTab(1)[0].url, 'https://example.com/no-frame.mp4');
});

test('clearFrame 清空 bucket 后移除 tab 记录', async () => {
  const registry = await createRegistry();
  registry.add(1, { url: 'blob:https://example.com/uuid-b', type: 'blob', frameId: 2 });

  registry.clearFrame(1, 2);
  assert.equal(registry.countForTab(1), 0);
});

test('restoreAll 保留 frameId', async () => {
  const registry = await createRegistry();
  registry.restoreAll({
    9: [
      { url: 'blob:https://example.com/uuid-c', type: 'blob', frameId: 4, tabId: 9 },
      { url: 'https://example.com/v.mp4', type: 'direct', frameId: 0, tabId: 9 },
    ],
  });

  assert.equal(registry.getByUrl(9, 'blob:https://example.com/uuid-c').frameId, 4);
  assert.equal(registry.countForTab(9), 2);
});
