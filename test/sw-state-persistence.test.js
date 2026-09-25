'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function createMemoryStorage() {
  const data = {};
  const calls = { set: 0, get: 0 };
  return {
    calls,
    async get(keys) {
      calls.get++;
      const out = {};
      for (const key of keys) {
        if (key in data) out[key] = data[key];
      }
      return out;
    },
    async set(items) {
      calls.set++;
      Object.assign(data, items);
    },
  };
}

async function createModules() {
  const { SessionMirror } = await import('../background/session-mirror.js');
  const { DownloadStateStore } = await import('../background/download-state-store.js');
  const { VideoRegistry } = await import('../background/video-registry.js');
  const { recoverDownloadTasks } = await import('../background/download-task-recovery.js');
  return { SessionMirror, DownloadStateStore, VideoRegistry, recoverDownloadTasks };
}

test('SessionMirror: scheduleSave 去抖后 flush 只写最新快照', async () => {
  const { SessionMirror } = await createModules();
  const storage = createMemoryStorage();
  const mirror = new SessionMirror('k', { storage });

  mirror.scheduleSave([{ taskId: 'a' }]);
  mirror.scheduleSave([{ taskId: 'b' }]);
  await mirror.flush();

  assert.equal(storage.calls.set, 1);
  assert.deepEqual(await mirror.load(), [{ taskId: 'b' }]);
});

test('SessionMirror: 无 storage 后端时静默降级', async () => {
  const { SessionMirror } = await createModules();
  const mirror = new SessionMirror('k', { storage: null });

  mirror.scheduleSave([{ taskId: 'a' }]);
  await mirror.flush();
  assert.equal(await mirror.load(), undefined);
});

test('upsertTask 自动镜像任务表到 storage', async () => {
  const { SessionMirror, DownloadStateStore } = await createModules();
  const storage = createMemoryStorage();
  const mirror = new SessionMirror('ovd.downloadTasks', { storage });
  const store = new DownloadStateStore(mirror);

  store.registerDownload(1001, { tabId: 42, videoUrl: 'https://example.com/v.mp4', title: 'demo' });
  await mirror.flush();

  const snapshot = await mirror.load();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].downloadId, 1001);
  assert.equal(snapshot[0].tabId, 42);
  assert.equal(snapshot[0].videoUrl, 'https://example.com/v.mp4');
  assert.equal(snapshot[0].status, 'running');

  store.update(1001, { percent: 55, state: 'downloading' });
  await mirror.flush();
  assert.equal((await mirror.load())[0].percent, 55);
});

test('deleteTask 镜像移除任务', async () => {
  const { SessionMirror, DownloadStateStore } = await createModules();
  const storage = createMemoryStorage();
  const mirror = new SessionMirror('ovd.downloadTasks', { storage });
  const store = new DownloadStateStore(mirror);

  store.registerDownload(1001, { tabId: 42, videoUrl: 'https://example.com/v.mp4' });
  await mirror.flush();
  assert.equal((await mirror.load()).length, 1);

  const taskId = store.getTasks()[0].taskId;
  store.deleteTask(taskId);
  await mirror.flush();
  assert.deepEqual(await mirror.load(), []);
});

test('restoreTasks 重建 downloadId->tabId 映射', async () => {
  const { SessionMirror, DownloadStateStore } = await createModules();
  const storage = createMemoryStorage();
  const mirror = new SessionMirror('ovd.downloadTasks', { storage });

  // 模拟 SW 回收前写入的快照
  const store1 = new DownloadStateStore(mirror);
  store1.registerDownload(2001, { tabId: 7, videoUrl: 'https://example.com/a.mp4', title: 'A' });
  await mirror.flush();

  // 模拟 SW 重启后的新实例
  const store2 = new DownloadStateStore(new SessionMirror('ovd.downloadTasks', { storage }));
  const restored = store2.restoreTasks(await mirror.load());

  assert.equal(restored, 1);
  assert.equal(store2.getTabId(2001), 7);
  assert.equal(store2.getStatesForTab(7)[2001].state, 'downloading');
  assert.equal(store2.getTasks()[0].videoUrl, 'https://example.com/a.mp4');
});

test('restoreTasks 清理过期的终态任务（定时器随 SW 丢失）', async () => {
  const { DownloadStateStore } = await createModules();
  const store = new DownloadStateStore();
  const expired = Date.now() - 31 * 60 * 1000;

  const restored = store.restoreTasks([
    { taskId: 't-old', status: 'complete', updatedAt: expired, downloadId: 3001, tabId: 1 },
    { taskId: 't-fresh', status: 'complete', updatedAt: Date.now(), downloadId: 3002, tabId: 1 },
    { taskId: 't-running', status: 'running', updatedAt: expired, downloadId: 3003, tabId: 1 },
  ]);

  assert.equal(restored, 2);
  assert.equal(store.getTask('t-old'), null);
  assert.ok(store.getTask('t-fresh'));
  assert.ok(store.getTask('t-running'));
});

test('recoverDownloadTasks: 幽灵任务（浏览器记录不存在）标记失败', async () => {
  const { DownloadStateStore, recoverDownloadTasks } = await createModules();
  const store = new DownloadStateStore();
  store.upsertTask({ taskId: 't-ghost', downloadId: 4001, tabId: 1, status: 'running', videoUrl: 'https://example.com/g.mp4' });

  const updates = [];
  const result = await recoverDownloadTasks(store, {
    getDownloadItem: async () => null,
    tryResumeDownload: async () => false,
    onTaskUpdate: (task) => updates.push(task),
  });

  assert.equal(result.ghost, 1);
  assert.equal(store.getTask('t-ghost').status, 'failed');
  assert.equal(updates.length, 1);
});

test('recoverDownloadTasks: interrupted 下载重新排程自动续传', async () => {
  const { DownloadStateStore, recoverDownloadTasks } = await createModules();
  const store = new DownloadStateStore();
  store.upsertTask({ taskId: 't-resume', downloadId: 4002, tabId: 9, status: 'running', videoUrl: 'https://example.com/r.mp4' });

  const resumeCalls = [];
  const result = await recoverDownloadTasks(store, {
    getDownloadItem: async () => ({ state: 'interrupted', error: 'NETWORK_FAILED' }),
    tryResumeDownload: async (downloadId, tabId, reason) => {
      resumeCalls.push({ downloadId, tabId, reason });
      return true;
    },
  });

  assert.equal(result.resumed, 1);
  assert.deepEqual(resumeCalls, [{ downloadId: 4002, tabId: 9, reason: 'NETWORK_FAILED' }]);
});

test('recoverDownloadTasks: 续传不可用（resume 拒绝）时标记失败', async () => {
  const { DownloadStateStore, recoverDownloadTasks } = await createModules();
  const store = new DownloadStateStore();
  store.upsertTask({ taskId: 't-noresume', downloadId: 4003, tabId: 9, status: 'running' });

  const result = await recoverDownloadTasks(store, {
    getDownloadItem: async () => ({ state: 'interrupted', error: 'CRASH' }),
    tryResumeDownload: async () => false,
  });

  assert.equal(result.resumed, 0);
  assert.equal(store.getTask('t-noresume').status, 'failed');
  assert.equal(store.getTask('t-noresume').error, 'CRASH');
});

test('recoverDownloadTasks: SW 内执行的任务（无 downloadId）标记中断可重试', async () => {
  const { DownloadStateStore, recoverDownloadTasks } = await createModules();
  const store = new DownloadStateStore();
  store.upsertTask({ taskId: 't-inpage', tabId: 3, status: 'running', videoUrl: 'blob:https://example.com/x' });

  const result = await recoverDownloadTasks(store, {
    getDownloadItem: async () => null,
    tryResumeDownload: async () => false,
  });

  assert.equal(result.interrupted, 1);
  const task = store.getTask('t-inpage');
  assert.equal(task.status, 'interrupted');
  assert.ok(task.error.includes('重启'));
});

test('recoverDownloadTasks: SW 回收期间完成的下载补齐终态', async () => {
  const { DownloadStateStore, recoverDownloadTasks } = await createModules();
  const store = new DownloadStateStore();
  store.upsertTask({ taskId: 't-done', downloadId: 4004, tabId: 5, status: 'running', percent: 80 });

  const result = await recoverDownloadTasks(store, {
    getDownloadItem: async () => ({ state: 'complete' }),
    tryResumeDownload: async () => false,
  });

  assert.equal(result.completed, 1);
  assert.equal(result.completedTasks.length, 1);
  const task = store.getTask('t-done');
  assert.equal(task.status, 'complete');
  assert.equal(task.percent, 100);
});

test('recoverDownloadTasks: in_progress 下载保持映射不动', async () => {
  const { DownloadStateStore, recoverDownloadTasks } = await createModules();
  const store = new DownloadStateStore();
  store.upsertTask({ taskId: 't-live', downloadId: 4005, tabId: 5, status: 'running', percent: 30 });

  const result = await recoverDownloadTasks(store, {
    getDownloadItem: async () => ({ state: 'in_progress' }),
    tryResumeDownload: async () => false,
  });

  assert.deepEqual(
    { resumed: result.resumed, interrupted: result.interrupted, ghost: result.ghost, completed: result.completed },
    { resumed: 0, interrupted: 0, ghost: 0, completed: 0 },
  );
  assert.equal(store.getTask('t-live').status, 'running');
});

test('VideoRegistry: add 镜像写入，restoreAll 恢复检测列表', async () => {
  const { SessionMirror, VideoRegistry } = await createModules();
  const storage = createMemoryStorage();
  const mirror = new SessionMirror('ovd.videoRegistry', { storage });

  const registry1 = new VideoRegistry(mirror);
  registry1.add(11, { url: 'https://example.com/v.mp4', type: 'direct', title: 'demo' });
  registry1.add(11, { url: 'blob:https://example.com/uuid', type: 'blob', requiresTabContext: true });
  await mirror.flush();

  const registry2 = new VideoRegistry(new SessionMirror('ovd.videoRegistry', { storage }));
  registry2.restoreAll(await mirror.load());

  const videos = registry2.getForTab(11);
  assert.equal(videos.length, 2);
  assert.equal(registry2.getByUrl(11, 'blob:https://example.com/uuid').type, 'blob');
});

test('VideoRegistry: clearTab 镜像移除', async () => {
  const { SessionMirror, VideoRegistry } = await createModules();
  const storage = createMemoryStorage();
  const mirror = new SessionMirror('ovd.videoRegistry', { storage });

  const registry = new VideoRegistry(mirror);
  registry.add(11, { url: 'https://example.com/v.mp4', type: 'direct' });
  await mirror.flush();
  assert.equal(Object.keys(await mirror.load()).length, 1);

  registry.clearTab(11);
  await mirror.flush();
  assert.equal(Object.keys(await mirror.load()).length, 0);
});
