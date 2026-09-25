'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const UTILS_PATH = path.resolve(__dirname, '../lib/download-artifact-utils.js');
const STRATEGY_PATH = path.resolve(__dirname, '../background/download-strategies/youtube-adaptive-download-strategy.js');

function loadUtils() {
  const key = '__OVD_DOWNLOAD_ARTIFACT_UTILS__';
  delete globalThis[key];
  delete require.cache[require.resolve(UTILS_PATH)];
  require(UTILS_PATH);
  return globalThis[key];
}

let importCounter = 0;

async function loadStrategy() {
  globalThis.chrome = globalThis.chrome || {};
  importCounter += 1;
  return import(`${pathToFileURL(STRATEGY_PATH).href}?test=${importCounter}`);
}

// ---------------------------------------------------------------
// 现场问题：`Learn 10 phrases …_2160p.mp4.txt`（服务器错误页被存成文件）
// ---------------------------------------------------------------

test('isBrokenTextStubDownload 识别 .txt 残片', () => {
  const utils = loadUtils();

  assert.equal(
    utils.isBrokenTextStubDownload({ filename: '/Downloads/Learn 10 phrases_2160p.mp4.txt' }),
    true
  );
  assert.equal(utils.isBrokenTextStubDownload({ filename: '/Downloads/video.mp4' }), false);
});

test('isBrokenTextStubDownload 识别小体积文本响应（MIME 命中）', () => {
  const utils = loadUtils();

  assert.equal(
    utils.isBrokenTextStubDownload({ filename: 'video.mp4', fileSize: 2048, mime: 'text/plain' }),
    true
  );
  assert.equal(
    utils.isBrokenTextStubDownload({ filename: 'video.mp4', fileSize: 1024, mime: 'application/xml' }),
    true
  );
  // 正常视频文件不受影响
  assert.equal(
    utils.isBrokenTextStubDownload({ filename: 'video.mp4', fileSize: 200 * 1024 * 1024, mime: 'video/mp4' }),
    false
  );
  // 文本 MIME 但体积不小（且文件名不是 .txt）：保守起见不判定为残片
  assert.equal(
    utils.isBrokenTextStubDownload({ filename: 'captions.vtt', fileSize: 5 * 1024 * 1024, mime: 'text/plain' }),
    false
  );
  assert.equal(utils.isBrokenTextStubDownload(null), false);
});

test('classifyDirectProbe：403/text 视为错误页，正常 206 放行', async () => {
  const { classifyDirectProbe } = await loadStrategy();

  assert.deepEqual(
    classifyDirectProbe({ contentType: 'text/plain', status: 403 }),
    { ok: false, reason: 'error-page-content-type' }
  );
  assert.deepEqual(
    classifyDirectProbe({ contentType: '', status: 403 }),
    { ok: false, reason: 'http-403' }
  );
  assert.deepEqual(
    classifyDirectProbe({ contentType: 'video/mp4', status: 206 }),
    { ok: true, reason: 'usable' }
  );
  // 探测没拿到响应（网络/CORS 异常）时不拦截
  assert.deepEqual(
    classifyDirectProbe({ contentType: '', status: 0 }),
    { ok: true, reason: 'usable' }
  );
});
