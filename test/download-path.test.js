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
