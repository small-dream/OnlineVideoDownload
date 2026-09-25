'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadCoordinator() {
  const key = '__OVD_DOWNLOAD_COORDINATOR__';
  const filePath = path.resolve(__dirname, '../content/download-coordinator.js');
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[key];
}

function createHarness({ onDownload } = {}) {
  const messages = [];
  const coordinator = loadCoordinator().createDownloadCoordinator({
    emitRuntimeMessage: (message) => messages.push(message),
    progressReporterFactory: { createProgressReporter: () => null },
    sourceRegistry: {
      download: (meta, context) => (onDownload
        ? onDownload(meta, context)
        : Promise.resolve({ filename: 'video.mp4' })),
      resolveDownload: () => ({
        handler: { getTaskKey: () => 'task-key-1' },
        sourceId: 'dash',
        strategyId: 'dash-merge',
      }),
    },
    sourceUtils: {
      buildTaskKey: () => 'task-key-1',
      getSourceId: () => 'dash',
    },
  });

  return { coordinator, messages };
}

test('取消内容侧任务会中止 AbortSignal 并广播取消结果', async () => {
  let receivedSignal = null;
  const { coordinator, messages } = createHarness({
    onDownload: (_meta, context) => new Promise((_resolve, reject) => {
      receivedSignal = context.signal;
      context.signal.addEventListener('abort', () => {
        const err = new Error('下载已取消');
        err.code = 'DOWNLOAD_ABORTED';
        reject(err);
      });
    }),
  });

  const started = coordinator.startSourceDownload({ type: 'dash', url: 'https://cdn.example.com/m.mpd' });
  assert.equal(started.started, true);
  assert.ok(receivedSignal, '内容侧任务必须拿到 AbortSignal');
  assert.equal(receivedSignal.aborted, false);

  const cancelled = coordinator.cancelSourceDownload({ taskKey: started.taskKey });
  assert.deepEqual(cancelled, { cancelled: true, ok: true, taskKey: started.taskKey, traceId: started.traceId });
  assert.equal(receivedSignal.aborted, true);

  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = messages.find((message) => message.type === 'SOURCE_DOWNLOAD_RESULT');
  assert.ok(result, '取消必须广播 SOURCE_DOWNLOAD_RESULT');
  assert.equal(result.ok, false);
  assert.equal(result.error, '已取消');
});

test('取消内容侧任务支持用 traceId 或 videoUrl 匹配', () => {
  const { coordinator } = createHarness();
  const started = coordinator.startSourceDownload({ type: 'dash', url: 'https://cdn.example.com/m.mpd' });

  assert.equal(coordinator.cancelSourceDownload({ videoUrl: 'https://cdn.example.com/m.mpd' }).cancelled, true);
  assert.equal(coordinator.cancelSourceDownload({ traceId: started.traceId }).cancelled, false);
});

test('没有匹配任务时取消请求返回失败而不是抛错', () => {
  const { coordinator, messages } = createHarness();
  const result = coordinator.cancelSourceDownload({ taskKey: 'missing' });

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.equal(messages.filter((message) => message.type === 'SOURCE_DOWNLOAD_RESULT').length, 0);
});
