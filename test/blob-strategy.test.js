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

test('MSE blob 条目在 fetch 之前就失败，并带上可映射的错误码', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error('MSE object URL 不应被 fetch');
  };

  try {
    const strategy = loadBlobStrategy().createBlobStrategy({
      getFloatButton: () => ({ showMessage() {} }),
      triggerBlobDownload() {},
    });

    await assert.rejects(
      () => strategy.download({
        mse: true,
        title: 'MSE video',
        type: 'blob',
        url: 'blob:https://example.com/mse',
      }),
      (err) => {
        assert.equal(err.code, 'BLOB_MSE_UNSUPPORTED');
        assert.match(err.message, /MSE/);
        return true;
      },
    );
    assert.equal(fetched, false, 'MSE 地址没有文件数据，不应该再 fetch 一次');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('handleFetch 也认 taskMeta.videoInfo.mse', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error('should not fetch');
  };

  try {
    const strategy = loadBlobStrategy().createBlobStrategy({
      getFloatButton: () => null,
      triggerBlobDownload() {},
    });

    await assert.rejects(
      () => strategy.handleFetch(
        'blob:https://example.com/mse',
        'video.mp4',
        { videoInfo: { mse: true, type: 'blob', url: 'blob:https://example.com/mse' } },
      ),
      (err) => err.code === 'BLOB_MSE_UNSUPPORTED',
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('blob 读取失败映射为 BLOB_UNREADABLE 并保留底层原因', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  try {
    const strategy = loadBlobStrategy().createBlobStrategy({
      getFloatButton: () => null,
      triggerBlobDownload() {},
    });

    await assert.rejects(
      () => strategy.handleFetch('blob:https://example.com/revoked', 'video.mp4', {}),
      (err) => {
        assert.equal(err.code, 'BLOB_UNREADABLE');
        assert.match(err.message, /Failed to fetch/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
