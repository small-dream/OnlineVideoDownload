'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadBlobStrategy() {
  delete globalThis.__OVD_BLOB_STRATEGY__;
  const filePath = path.resolve(__dirname, '../content/strategies/blob-strategy.js');
  delete require.cache[filePath];
  require(filePath);
  return globalThis.__OVD_BLOB_STRATEGY__;
}

test('blob fetch forwards task metadata to browser download handoff', async () => {
  const originalFetch = globalThis.fetch;
  const downloads = [];
  const taskMeta = {
    sourceId: 'blob',
    strategyId: 'browser-download',
    taskId: 'task-1',
    title: 'Blob video',
    videoUrl: 'blob:https://example.com/demo',
  };

  globalThis.fetch = async () => ({
    async blob() {
      return new Blob([new Uint8Array([1, 2, 3])], { type: 'video/webm' });
    },
  });

  try {
    const strategy = loadBlobStrategy().createBlobStrategy({
      getFloatButton: () => ({ showMessage() {} }),
      triggerBlobDownload(blob, filename, receivedTaskMeta) {
        downloads.push({ filename, size: blob.size, taskMeta: receivedTaskMeta });
      },
    });

    const result = await strategy.handleFetch('blob:https://example.com/demo', 'Blob video.mp4', taskMeta);

    assert.deepEqual(result, { downloadId: null, ok: true });
    assert.deepEqual(downloads, [{
      filename: 'Blob video.webm',
      size: 3,
      taskMeta,
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
