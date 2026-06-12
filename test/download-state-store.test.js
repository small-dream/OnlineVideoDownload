'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function createStore() {
  const { DownloadStateStore } = await import('../background/download-state-store.js');
  return new DownloadStateStore();
}

test('registerDownload stores initial state with percent=0, state=downloading', async () => {
  const store = await createStore();
  store.registerDownload(1001, { tabId: 42, videoUrl: 'https://example.com/v.mp4' });

  const states = store.getStatesForTab(42);
  assert.ok(states[1001]);
  assert.equal(states[1001].percent, 0);
  assert.equal(states[1001].state, 'downloading');
  assert.equal(states[1001].tabId, 42);
  assert.equal(states[1001].videoUrl, 'https://example.com/v.mp4');
  assert.equal(states[1001].requiresTabContext, true);
});

test('registerDownload ignores null downloadId', async () => {
  const store = await createStore();
  store.registerDownload(null, { tabId: 42, videoUrl: 'https://example.com/v.mp4' });

  const states = store.getStatesForTab(42);
  assert.deepEqual(states, {});
});

test('registerDownload ignores missing tabId', async () => {
  const store = await createStore();
  store.registerDownload(1001, { videoUrl: 'https://example.com/v.mp4' });

  const states = store.getStatesForTab(undefined);
  assert.deepEqual(states, {});
});

test('registerResult registers main and nested results', async () => {
  const store = await createStore();
  store.registerResult(
    { downloadId: 'main', results: [{ downloadId: 'sub1' }, { downloadId: 'sub2' }] },
    { tabId: 10, videoUrl: 'https://example.com/v.mp4' },
  );

  const states = store.getStatesForTab(10);
  assert.ok(states['main']);
  assert.ok(states['sub1']);
  assert.ok(states['sub2']);
  assert.equal(states['main'].tabId, 10);
  assert.equal(states['sub1'].tabId, 10);
  assert.equal(states['sub2'].tabId, 10);
});

test('registerResult ignores missing tabId in context', async () => {
  const store = await createStore();
  store.registerResult(
    { downloadId: 'main' },
    {},
  );

  const states = store.getStatesForTab(undefined);
  assert.deepEqual(states, {});
});

test('getTabId returns null for unknown', async () => {
  const store = await createStore();
  assert.equal(store.getTabId(9999), null);
});

test('getTabId returns correct tabId', async () => {
  const store = await createStore();
  store.registerDownload(1001, { tabId: 42, videoUrl: 'https://example.com/v.mp4' });
  assert.equal(store.getTabId(1001), 42);
});

test('update merges and returns state', async () => {
  const store = await createStore();
  store.registerDownload(1001, { tabId: 42, videoUrl: 'https://example.com/v.mp4' });

  const updated = store.update(1001, { percent: 50, state: 'downloading' });
  assert.equal(updated.percent, 50);
  assert.equal(updated.state, 'downloading');
  assert.equal(updated.tabId, 42);
});

test('update returns null if not found', async () => {
  const store = await createStore();
  assert.equal(store.update(9999, { percent: 50 }), null);
});

test('markFailed sets percent=0, state=failed', async () => {
  const store = await createStore();
  store.registerDownload(1001, { tabId: 42, videoUrl: 'https://example.com/v.mp4' });
  store.update(1001, { percent: 75 });

  const result = store.markFailed(1001);
  assert.equal(result.percent, 0);
  assert.equal(result.state, 'failed');
});

test('markFailed returns null for unknown downloadId', async () => {
  const store = await createStore();
  assert.equal(store.markFailed(9999), null);
});

test('markComplete sets percent=100, state=complete', async () => {
  const store = await createStore();
  store.registerDownload(1001, { tabId: 42, videoUrl: 'https://example.com/v.mp4' });

  store.markComplete(1001);
  const states = store.getStatesForTab(42);
  assert.equal(states[1001].percent, 100);
  assert.equal(states[1001].state, 'complete');
});

test('getStatesForTab returns copies filtered by tabId', async () => {
  const store = await createStore();
  store.registerDownload(1, { tabId: 10, videoUrl: 'a' });
  store.registerDownload(2, { tabId: 20, videoUrl: 'b' });
  store.registerDownload(3, { tabId: 10, videoUrl: 'c' });

  const states = store.getStatesForTab(10);
  assert.ok(states[1]);
  assert.ok(states[3]);
  assert.ok(!states[2]);

  // Verify it returns copies
  states[1].percent = 999;
  const statesAgain = store.getStatesForTab(10);
  assert.equal(statesAgain[1].percent, 0, 'should be a copy, not the original');
});

test('getStatesForTab returns empty for unknown tabId', async () => {
  const store = await createStore();
  store.registerDownload(1, { tabId: 10, videoUrl: 'a' });

  const states = store.getStatesForTab(99);
  assert.deepEqual(states, {});
});

test('clearTab removes all downloads for a tab', async () => {
  const store = await createStore();
  store.registerDownload(1, { tabId: 10, videoUrl: 'a' });
  store.registerDownload(2, { tabId: 10, videoUrl: 'b' });
  store.registerDownload(3, { tabId: 20, videoUrl: 'c' });

  store.clearTab(10);

  assert.deepEqual(store.getStatesForTab(10), {});
  assert.ok(store.getStatesForTab(20)[3], 'other tab should be untouched');
});

test('delete removes entry and clears timers', async () => {
  const store = await createStore();
  store.registerDownload(1001, { tabId: 42, videoUrl: 'https://example.com/v.mp4' });
  const cleanupCalled = { value: false };
  store._cleanupFns.set(1001, async () => { cleanupCalled.value = true; });

  store.delete(1001);

  assert.equal(store.getTabId(1001), null);
  assert.ok(!store._cleanupFns.has(1001));
});

test('deleteTask removes linked download state', async () => {
  const store = await createStore();
  store.registerDownload(1001, { tabId: 42, videoUrl: 'https://example.com/v.mp4' });
  const [task] = store.getTasks({ tabId: 42 });

  store.deleteTask(task.taskId);

  assert.equal(store.getTask(task.taskId), null);
  assert.equal(store.getTabId(1001), null);
});

test('deleteTask with tombstone ignores stale updates', async () => {
  const store = await createStore();
  const task = store.upsertTask({
    status: 'running',
    tabId: 42,
    title: 'Task',
    traceId: 'trace-delete',
  });

  store.deleteTask(task.taskId, { tombstone: true });

  const stale = store.upsertTask({
    percent: 80,
    status: 'running',
    traceId: 'trace-delete',
  });

  assert.equal(stale, null);
  assert.equal(store.getTask(task.taskId), null);
});

test('cleanupRules invokes cleanup function and removes it', async () => {
  const store = await createStore();
  let cleanupCalled = false;
  store._cleanupFns.set(1001, async () => { cleanupCalled = true; });

  await store.cleanupRules(1001);
  assert.ok(cleanupCalled);
  assert.ok(!store._cleanupFns.has(1001));
});

test('cleanupRules is no-op when no cleanup function exists', async () => {
  const store = await createStore();
  // Should not throw
  store.cleanupRules(9999);
});

test('registerDownload stores cleanupRules function', async () => {
  const store = await createStore();
  const cleanup = async () => {};
  store.registerDownload(1001, { tabId: 42, videoUrl: 'a', cleanupRules: cleanup });

  assert.ok(store._cleanupFns.has(1001));
  assert.equal(store._cleanupFns.get(1001), cleanup);
});

test('registerDownload re-registers existing downloadId, clearing delete timer', async () => {
  const store = await createStore();
  store.registerDownload(1001, { tabId: 42, videoUrl: 'a' });

  // Schedule a delete
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 60000);
  store._deleteTimers.set(1001, timer);

  // Re-register should clear the delete timer
  store.registerDownload(1001, { tabId: 42, videoUrl: 'b' });

  assert.ok(!store._deleteTimers.has(1001));
  clearTimeout(timer);

  const states = store.getStatesForTab(42);
  assert.equal(states[1001].videoUrl, 'b');
});

test('upsertTask creates and updates a unified task by traceId', async () => {
  const store = await createStore();
  const created = store.upsertTask({
    sourceId: 'youtube',
    status: 'running',
    tabId: 42,
    taskKey: 'yt:1',
    title: 'Video',
    traceId: 'trace-1',
    videoUrl: 'https://example.com/watch?v=1',
  });

  assert.equal(created.status, 'running');
  assert.equal(created.percent, 0);
  assert.equal(created.traceId, 'trace-1');

  const updated = store.upsertTask({
    percent: 55,
    status: 'running',
    traceId: 'trace-1',
  });

  assert.equal(updated.taskId, created.taskId);
  assert.equal(updated.percent, 55);
  assert.equal(store.getTasks({ tabId: 42 }).length, 1);
});

test('registerDownload creates a task linked to downloadId', async () => {
  const store = await createStore();
  store.registerDownload(1001, {
    sourceId: 'direct',
    tabId: 42,
    title: 'Direct video',
    videoInfo: { url: 'https://example.com/v.mp4', type: 'direct' },
    videoUrl: 'https://example.com/v.mp4',
  });

  const tasks = store.getTasks({ tabId: 42 });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].downloadId, 1001);
  assert.equal(tasks[0].status, 'running');
  assert.equal(tasks[0].videoInfo.url, 'https://example.com/v.mp4');
});

test('markComplete updates linked task to complete', async () => {
  const store = await createStore();
  store.registerDownload(1001, { tabId: 42, videoUrl: 'a' });

  store.markComplete(1001);

  const [task] = store.getTasks({ tabId: 42 });
  assert.equal(task.status, 'complete');
  assert.equal(task.percent, 100);
});

test('markTabInterrupted marks running tab tasks interrupted', async () => {
  const store = await createStore();
  const running = store.upsertTask({
    status: 'running',
    tabId: 42,
    title: 'Running',
    traceId: 'trace-running',
  });
  store.upsertTask({
    status: 'complete',
    tabId: 42,
    title: 'Done',
    traceId: 'trace-done',
  });

  const interrupted = store.markTabInterrupted(42, 'tab closed');

  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].taskId, running.taskId);
  assert.equal(interrupted[0].status, 'interrupted');
  assert.equal(interrupted[0].error, 'tab closed');
});

test('markTabInterrupted skips tasks that do not require tab context', async () => {
  const store = await createStore();
  const running = store.upsertTask({
    requiresTabContext: false,
    status: 'running',
    tabId: 42,
    title: 'Running',
    traceId: 'trace-running',
  });

  const interrupted = store.markTabInterrupted(42, 'tab closed');

  assert.equal(interrupted.length, 0);
  assert.equal(store.getTask(running.taskId).status, 'running');
});

test('markTabInterrupted skips youtube-adaptive-background task (requiresTabContext=false)', async () => {
  const store = await createStore();
  const ytTask = store.upsertTask({
    sourceId: 'youtube',
    strategyId: 'youtube-adaptive-background',
    requiresTabContext: false,
    status: 'running',
    tabId: 42,
    title: 'YouTube Parse Download',
    traceId: 'trace-yt-bg',
  });

  const interrupted = store.markTabInterrupted(42, 'tab closed');

  assert.equal(interrupted.length, 0);
  assert.equal(store.getTask(ytTask.taskId).status, 'running');
});

test('clearTab preserves downloads that do not require tab context when requested', async () => {
  const store = await createStore();
  store.registerDownload(1, { requiresTabContext: false, tabId: 10, videoUrl: 'a' });
  store.registerDownload(2, { requiresTabContext: true, tabId: 10, videoUrl: 'b' });

  store.clearTab(10, { onlyRequiresTabContext: true });

  assert.ok(store.getTabId(1) !== null);
  assert.equal(store.getTabId(2), null);
});

test('upsertTask clears stale error when task returns to running', async () => {
  const store = await createStore();
  const task = store.upsertTask({
    error: '原标签页已关闭，任务中断',
    status: 'interrupted',
    tabId: 42,
    title: 'Task',
  });

  const resumed = store.upsertTask({
    error: '',
    status: 'running',
    taskId: task.taskId,
  });

  assert.equal(resumed.error, '');
  assert.equal(resumed.status, 'running');
});

test('getTask returns a copy', async () => {
  const store = await createStore();
  const task = store.upsertTask({
    status: 'running',
    tabId: 42,
    title: 'Copy',
    videoInfo: { url: 'https://example.com/a.mp4' },
  });

  const copy = store.getTask(task.taskId);
  copy.title = 'Changed';
  copy.videoInfo.url = 'changed';

  const again = store.getTask(task.taskId);
  assert.equal(again.title, 'Copy');
  assert.equal(again.videoInfo.url, 'https://example.com/a.mp4');
});

test('upsertTask merges tasks by tab and videoUrl when traceId is missing', async () => {
  const store = await createStore();
  const first = store.upsertTask({
    status: 'running',
    tabId: 42,
    title: 'Download task',
    videoUrl: 'https://example.com/same.mp4',
  });

  const second = store.upsertTask({
    status: 'complete',
    tabId: 42,
    title: 'Real title',
    videoUrl: 'https://example.com/same.mp4',
  });

  assert.equal(second.taskId, first.taskId);
  assert.equal(second.title, 'Real title');
  assert.equal(store.getTasks({ tabId: 42 }).length, 1);
});

test('upsertTask does not overwrite a real title with a generic task title', async () => {
  const store = await createStore();
  const first = store.upsertTask({
    status: 'running',
    tabId: 42,
    title: 'Real title',
    videoUrl: 'https://example.com/title.mp4',
  });

  const second = store.upsertTask({
    downloadId: 1001,
    status: 'running',
    tabId: 42,
    title: 'Download task',
    videoUrl: 'https://example.com/title.mp4',
  });

  assert.equal(second.taskId, first.taskId);
  assert.equal(second.title, 'Real title');
  assert.equal(second.downloadId, 1001);
});

test('updateTaskByVideoUrl updates the existing task progress', async () => {
  const store = await createStore();
  const task = store.upsertTask({
    status: 'running',
    tabId: 42,
    title: 'HLS video',
    videoUrl: 'https://example.com/master.m3u8',
  });

  const updated = store.updateTaskByVideoUrl('https://example.com/master.m3u8', {
    percent: 42,
    phase: 'segments',
    status: 'running',
    tabId: 42,
  });

  assert.equal(updated.taskId, task.taskId);
  assert.equal(updated.percent, 42);
  assert.equal(updated.phase, 'segments');
  assert.equal(store.getTasks({ tabId: 42 }).length, 1);
});

test('getTasks order is stable when task progress updates', async () => {
  const store = await createStore();
  store.upsertTask({
    createdAt: 1000,
    status: 'running',
    tabId: 42,
    taskId: 'older',
    title: 'Older',
  });
  store.upsertTask({
    createdAt: 2000,
    status: 'running',
    tabId: 42,
    taskId: 'newer',
    title: 'Newer',
  });

  assert.deepEqual(store.getTasks({ tabId: 42 }).map((task) => task.taskId), ['newer', 'older']);

  store.upsertTask({
    percent: 80,
    status: 'running',
    taskId: 'older',
  });

  assert.deepEqual(store.getTasks({ tabId: 42 }).map((task) => task.taskId), ['newer', 'older']);
});

test('getTasks order is stable for tasks created in the same millisecond', async () => {
  const store = await createStore();
  store.upsertTask({
    createdAt: 1000,
    status: 'running',
    tabId: 42,
    taskId: 'first',
    title: 'First',
  });
  store.upsertTask({
    createdAt: 1000,
    status: 'running',
    tabId: 42,
    taskId: 'second',
    title: 'Second',
  });

  assert.deepEqual(store.getTasks({ tabId: 42 }).map((task) => task.taskId), ['second', 'first']);

  store.upsertTask({
    percent: 80,
    status: 'running',
    taskId: 'first',
  });
  store.upsertTask({
    percent: 20,
    status: 'running',
    taskId: 'second',
  });

  assert.deepEqual(store.getTasks({ tabId: 42 }).map((task) => task.taskId), ['second', 'first']);
});

test('updateTaskByDownloadId ignores metadata-less orphan updates', async () => {
  const store = await createStore();

  const updated = store.updateTaskByDownloadId(1001, {
    percent: 100,
    status: 'complete',
  });

  assert.equal(updated, null);
  assert.deepEqual(store.getTasks({ tabId: 42 }), []);
});
