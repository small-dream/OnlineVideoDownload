'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadReporter() {
  delete globalThis.__OVD_MESSAGE_TYPES__;
  delete globalThis.__OVD_PROGRESS_REPORTER__;

  const messageTypesPath = path.resolve(__dirname, '../lib/message-types.js');
  const progressReporterPath = path.resolve(__dirname, '../content/progress-reporter.js');
  delete require.cache[messageTypesPath];
  delete require.cache[progressReporterPath];

  require(messageTypesPath);
  require(progressReporterPath);

  return globalThis.__OVD_PROGRESS_REPORTER__;
}

test('progress reporter emits clamped source progress with task metadata', () => {
  const reporterFactory = loadReporter();
  const messages = [];
  const reporter = reporterFactory.createProgressReporter({
    emitRuntimeMessage: (message) => messages.push(message),
    sourceId: 'youtube',
    taskKey: 'yt:abc',
    title: 'Demo',
    traceId: 'trace-1',
  });

  const safePercent = reporter.progress(150.4, { phase: 'merging' });

  assert.equal(safePercent, 100);
  assert.deepEqual(messages, [{
    phase: 'merging',
    percent: 100,
    sourceId: 'youtube',
    taskKey: 'yt:abc',
    title: 'Demo',
    traceId: 'trace-1',
    type: 'SOURCE_DOWNLOAD_PROGRESS',
  }]);
});

test('progress reporter emits status messages for popup display', () => {
  const reporterFactory = loadReporter();
  const messages = [];
  const reporter = reporterFactory.createProgressReporter({
    emitRuntimeMessage: (message) => messages.push(message),
    sourceId: 'bilibili',
  });

  reporter.status('正在合并 Bilibili 视音频...', { level: 'info' });

  assert.deepEqual(messages, [{
    level: 'info',
    message: '正在合并 Bilibili 视音频...',
    sourceId: 'bilibili',
    type: 'SOURCE_DOWNLOAD_STATUS',
  }]);
});
