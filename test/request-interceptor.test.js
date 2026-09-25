'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { before } = test;
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '../background/request-interceptor.js');

let importCounter = 0;
let RequestInterceptor = null;

before(async () => {
  importCounter += 1;
  const mod = await import(`${pathToFileURL(MODULE_PATH).href}?test=${importCounter}`);
  RequestInterceptor = mod.RequestInterceptor;
});

function createInterceptor(added = []) {
  const registry = {
    add(tabId, info) {
      added.push({ info, tabId });
      return 'new';
    },
    countForTab: () => added.length,
    getByUrl: () => undefined,
  };
  return new RequestInterceptor(registry, () => {});
}

// ---------------------------------------------------------------
// 第三波 3.5：通用嗅探增强（MIME + 二次确认）
// ---------------------------------------------------------------

test('video/mp2t、video/quicktime、video/x-matroska 视为可下载视频', () => {
  const interceptor = createInterceptor();
  assert.equal(interceptor._detectTypeByMime('video/mp2t'), 'direct');
  assert.equal(interceptor._detectTypeByMime('video/quicktime'), 'direct');
  assert.equal(interceptor._detectTypeByMime('video/x-matroska'), 'direct');
  assert.equal(interceptor._detectTypeByMime('video/mp4'), 'direct');
});

test('HLS/DASH 与音频 MIME 判定不受影响', () => {
  const interceptor = createInterceptor();
  assert.equal(interceptor._detectTypeByMime('application/vnd.apple.mpegurl'), 'hls');
  assert.equal(interceptor._detectTypeByMime('application/dash+xml'), 'dash');
  assert.equal(interceptor._detectTypeByMime('audio/mpeg'), 'audio');
  assert.equal(interceptor._detectTypeByMime('text/html'), null);
});

test('application/octet-stream 需要扩展名或 Content-Disposition 二次确认', () => {
  const interceptor = createInterceptor();

  assert.equal(
    interceptor._detectTypeByMime('application/octet-stream', { url: 'https://cdn.example.com/movie.mp4' }),
    'direct'
  );
  assert.equal(
    interceptor._detectTypeByMime('application/octet-stream', {
      contentDisposition: 'attachment; filename="clip.mkv"',
      url: 'https://cdn.example.com/download?id=1',
    }),
    'direct'
  );
  assert.equal(
    interceptor._detectTypeByMime('application/octet-stream', {
      contentDisposition: "attachment; filename*=UTF-8''song.mp3",
      url: 'https://cdn.example.com/download?id=2',
    }),
    'audio'
  );
  // 无任何线索时不上报，避免把任意二进制当视频
  assert.equal(
    interceptor._detectTypeByMime('application/octet-stream', { url: 'https://cdn.example.com/download?id=3' }),
    null
  );
});

test('_onHeadersReceived 登记由 Content-Disposition 确认的 octet-stream 视频', () => {
  const added = [];
  const interceptor = createInterceptor(added);

  interceptor._onHeadersReceived({
    frameId: 0,
    responseHeaders: [
      { name: 'Content-Type', value: 'application/octet-stream' },
      { name: 'Content-Disposition', value: 'attachment; filename="episode.ts"' },
      { name: 'Content-Length', value: '2048' },
    ],
    tabId: 7,
    type: 'xmlhttprequest',
    url: 'https://cdn.example.com/stream/episode',
  });

  assert.equal(added.length, 1);
  assert.equal(added[0].info.type, 'direct');
  assert.equal(added[0].info.mimeType, 'application/octet-stream');
  assert.equal(added[0].info.fileSize, 2048);
  assert.equal(added[0].tabId, 7);
});

test('_onHeadersReceived 忽略无扩展名线索的 octet-stream', () => {
  const added = [];
  const interceptor = createInterceptor(added);

  interceptor._onHeadersReceived({
    frameId: 0,
    responseHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }],
    tabId: 7,
    type: 'xmlhttprequest',
    url: 'https://cdn.example.com/blob/9f8e',
  });

  assert.equal(added.length, 0);
});
