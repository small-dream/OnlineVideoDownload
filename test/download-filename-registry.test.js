'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '../background/download-filename-registry.js');

let importCounter = 0;

function loadRegistry() {
  importCounter += 1;
  return import(`${pathToFileURL(MODULE_PATH).href}?test=${importCounter}`);
}

test('登记与取回拟用文件名（onDeterminingFilename 用）', async () => {
  const registry = await loadRegistry();

  assert.equal(registry.rememberDownloadFilename(7, 'OnlineVideoDownload/视频_2160p.mp4'), true);
  assert.equal(registry.peekDownloadFilename(7), 'OnlineVideoDownload/视频_2160p.mp4');
  assert.equal(registry.takeDownloadFilename(7), 'OnlineVideoDownload/视频_2160p.mp4');
  // 取过之后不再命中（避免影响后续同名下载）
  assert.equal(registry.peekDownloadFilename(7), '');

  assert.equal(registry.rememberDownloadFilename(null, 'a.mp4'), false);
  assert.equal(registry.rememberDownloadFilename(8, ''), false);
  registry.clearDownloadFilenames();
});

test('stripSpuriousMimeSuffix 只去掉 MIME 追加的伪后缀', async () => {
  const registry = await loadRegistry();

  // 现场问题：CDN 把媒体标成 text/plain，Chrome 存成 xxx.mp4.txt
  assert.equal(registry.stripSpuriousMimeSuffix('Learn 10 phrases_2160p.mp4.txt'), 'Learn 10 phrases_2160p.mp4');
  assert.equal(registry.stripSpuriousMimeSuffix('video.webm.html'), 'video.webm');
  assert.equal(registry.stripSpuriousMimeSuffix('audio.m4a.xml'), 'audio.m4a');

  // 正常文件名 / 非媒体文件不动
  assert.equal(registry.stripSpuriousMimeSuffix('video.mp4'), 'video.mp4');
  assert.equal(registry.stripSpuriousMimeSuffix('notes.txt'), 'notes.txt');
  assert.equal(registry.stripSpuriousMimeSuffix('archive.zip.txt'), 'archive.zip.txt');
  assert.equal(registry.stripSpuriousMimeSuffix(''), '');
});
