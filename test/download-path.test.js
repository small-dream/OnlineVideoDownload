'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule() {
  delete globalThis.__OVD_DOWNLOAD_PATH__;
  delete require.cache[require.resolve(path.resolve(__dirname, '../lib/download-path.js'))];
  require(path.resolve(__dirname, '../lib/download-path.js'));
  return globalThis.__OVD_DOWNLOAD_PATH__;
}

test('joinDownloadSubdir normalizes and prefixes subdir', () => {
  const mod = loadModule();
  assert.equal(mod.joinDownloadSubdir('video.mp4', '\\OnlineVideoDownload\\'), 'OnlineVideoDownload/video.mp4');
});

test('joinDownloadSubdir does not duplicate existing subdir', () => {
  const mod = loadModule();
  assert.equal(mod.joinDownloadSubdir('OnlineVideoDownload/video.mp4', 'OnlineVideoDownload'), 'OnlineVideoDownload/video.mp4');
});

test('applyDownloadSubdir reads settings store', async () => {
  const mod = loadModule();
  const result = await mod.applyDownloadSubdir('video.mp4', {
    getSettings: async () => ({ downloadSubdir: 'Downloads/TV' }),
  });

  assert.equal(result, 'Downloads/TV/video.mp4');
});

test('formatDateStamp 输出本地 YYYYMMDD', () => {
  const mod = loadModule();
  assert.equal(mod.formatDateStamp(new Date(2026, 8, 25)), '20260925');
  assert.equal(mod.formatDateStamp(new Date(2026, 0, 5)), '20260105');
  assert.equal(mod.formatDateStamp('invalid'), '');
});

test('pickFilenameQualitySuffix 优先级：标签 > 分辨率 > 高度 > 画质 id', () => {
  const mod = loadModule();
  assert.equal(mod.pickFilenameQualitySuffix({ qualityLabel: '1080P 高清' }), '1080P 高清');
  assert.equal(mod.pickFilenameQualitySuffix({ resolution: '720p' }), '720p');
  assert.equal(mod.pickFilenameQualitySuffix({ resolution: 'auto', height: 480 }), '480p');
  assert.equal(mod.pickFilenameQualitySuffix({ downloadOptions: { qualityId: 80 } }), '80P');
  assert.equal(mod.pickFilenameQualitySuffix({ resolution: 'auto' }), '');
  assert.equal(mod.pickFilenameQualitySuffix({}), '');
});

test('composeFilenameBase: title 格式原样返回', () => {
  const mod = loadModule();
  assert.equal(mod.composeFilenameBase('My Video', { height: 1080 }, { filenameFormat: 'title' }), 'My Video');
  assert.equal(mod.composeFilenameBase('', {}, { filenameFormat: 'title' }), 'video');
});

test('composeFilenameBase: title-quality 追加清晰度后缀', () => {
  const mod = loadModule();
  assert.equal(
    mod.composeFilenameBase('My Video', { height: 1080 }, { filenameFormat: 'title-quality' }),
    'My Video-1080p'
  );
  assert.equal(
    mod.composeFilenameBase('My Video', { downloadOptions: { resolution: '720p' } }, { filenameFormat: 'title-quality' }),
    'My Video-720p'
  );
  // 无清晰度信息时不加后缀
  assert.equal(mod.composeFilenameBase('My Video', {}, { filenameFormat: 'title-quality' }), 'My Video');
  // 后缀非法字符被剔除
  assert.equal(
    mod.composeFilenameBase('My Video', { qualityLabel: '10:80/P' }, { filenameFormat: 'title-quality' }),
    'My Video-1080P'
  );
});

test('composeFilenameBase: title-date 追加当天日期', () => {
  const mod = loadModule();
  const now = new Date(2026, 8, 25);
  assert.equal(
    mod.composeFilenameBase('My Video', {}, { filenameFormat: 'title-date' }, { now }),
    'My Video-20260925'
  );
});

test('applyDownloadNaming 依次应用命名规则与子目录', async () => {
  const mod = loadModule();
  const result = await mod.applyDownloadNaming(
    'My Video',
    { height: 1080 },
    { getSettings: async () => ({ filenameFormat: 'title-quality', downloadSubdir: 'OnlineVideoDownload' }) }
  );
  assert.equal(result, 'OnlineVideoDownload/My Video-1080p');
});

test('applyDownloadNaming 无设置存储时原样返回', async () => {
  const mod = loadModule();
  assert.equal(await mod.applyDownloadNaming('My Video', {}, null), 'My Video');
});
