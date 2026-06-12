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

test('progress(0) returns 0', () => {
  const factory = loadReporter();
  const messages = [];
  const reporter = factory.createProgressReporter({
    emitRuntimeMessage: (msg) => messages.push(msg),
    sourceId: 'test',
    taskKey: 'tk',
  });

  const result = reporter.progress(0);
  assert.equal(result, 0);
  assert.equal(messages[0].percent, 0);
});

test('progress(-10) returns 0 (clamped)', () => {
  const factory = loadReporter();
  const messages = [];
  const reporter = factory.createProgressReporter({
    emitRuntimeMessage: (msg) => messages.push(msg),
    sourceId: 'test',
    taskKey: 'tk',
  });

  const result = reporter.progress(-10);
  assert.equal(result, 0);
  assert.equal(messages[0].percent, 0);
});

test('progress with missing sourceId still emits', () => {
  const factory = loadReporter();
  const messages = [];
  const reporter = factory.createProgressReporter({
    emitRuntimeMessage: (msg) => messages.push(msg),
    sourceId: '',
    taskKey: 'tk',
  });

  reporter.progress(50);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].percent, 50);
  assert.ok(!('sourceId' in messages[0]), 'empty sourceId should not appear in message');
});

test('progress with missing taskKey still emits', () => {
  const factory = loadReporter();
  const messages = [];
  const reporter = factory.createProgressReporter({
    emitRuntimeMessage: (msg) => messages.push(msg),
    sourceId: 'test',
    taskKey: '',
  });

  reporter.progress(75);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].percent, 75);
  assert.ok(!('taskKey' in messages[0]), 'empty taskKey should not appear in message');
});

test('status with empty string still emits', () => {
  const factory = loadReporter();
  const messages = [];
  const reporter = factory.createProgressReporter({
    emitRuntimeMessage: (msg) => messages.push(msg),
    sourceId: 'test',
  });

  reporter.status('');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'SOURCE_DOWNLOAD_STATUS');
  assert.equal(messages[0].message, '');
});

test('Multiple progress calls accumulate messages in order', () => {
  const factory = loadReporter();
  const messages = [];
  const reporter = factory.createProgressReporter({
    emitRuntimeMessage: (msg) => messages.push(msg),
    sourceId: 'test',
    taskKey: 'tk',
  });

  reporter.progress(10);
  reporter.progress(30, { phase: 'downloading' });
  reporter.progress(60, { phase: 'merging' });
  reporter.progress(100, { phase: 'complete' });

  assert.equal(messages.length, 4);
  assert.equal(messages[0].percent, 10);
  assert.equal(messages[1].percent, 30);
  assert.equal(messages[1].phase, 'downloading');
  assert.equal(messages[2].percent, 60);
  assert.equal(messages[2].phase, 'merging');
  assert.equal(messages[3].percent, 100);
  assert.equal(messages[3].phase, 'complete');
});

test('progress with NaN returns 0', () => {
  const factory = loadReporter();
  const messages = [];
  const reporter = factory.createProgressReporter({
    emitRuntimeMessage: (msg) => messages.push(msg),
    sourceId: 'test',
  });

  const result = reporter.progress(NaN);
  assert.equal(result, 0);
  assert.equal(messages[0].percent, 0);
});

test('progress with Infinity returns 0 (not finite)', () => {
  const factory = loadReporter();
  const messages = [];
  const reporter = factory.createProgressReporter({
    emitRuntimeMessage: (msg) => messages.push(msg),
    sourceId: 'test',
  });

  // Number.isFinite(Infinity) === false, so safePercent defaults to 0
  const result = reporter.progress(Infinity);
  assert.equal(result, 0);
  assert.equal(messages[0].percent, 0);
});

test('status with payload merges correctly', () => {
  const factory = loadReporter();
  const messages = [];
  const reporter = factory.createProgressReporter({
    emitRuntimeMessage: (msg) => messages.push(msg),
    sourceId: 'test',
    taskKey: 'tk',
    traceId: 'trace-1',
  });

  reporter.status('Processing...', { level: 'warn', extra: 42 });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'SOURCE_DOWNLOAD_STATUS');
  assert.equal(messages[0].message, 'Processing...');
  assert.equal(messages[0].level, 'warn');
  assert.equal(messages[0].extra, 42);
  assert.equal(messages[0].traceId, 'trace-1');
  assert.equal(messages[0].taskKey, 'tk');
});

test('createProgressReporter with all empty options still works', () => {
  const factory = loadReporter();
  const messages = [];
  const reporter = factory.createProgressReporter({
    emitRuntimeMessage: (msg) => messages.push(msg),
  });

  reporter.progress(50);
  reporter.status('hello');

  assert.equal(messages.length, 2);
  assert.equal(messages[0].percent, 50);
  assert.equal(messages[1].message, 'hello');
  // traceId and taskKey are only included if truthy
  assert.ok(!('traceId' in messages[0]));
  assert.ok(!('taskKey' in messages[0]));
  // sourceId defaults to 'source' and is always included (truthy)
  assert.ok('sourceId' in messages[0]);
  assert.equal(messages[0].sourceId, 'source');
});
