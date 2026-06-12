'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function createStore(storageData = {}) {
  globalThis.chrome = {
    storage: {
      local: {
        _data: { ...storageData },
        async get(keys) {
          const result = {};
          for (const key of keys) {
            if (key in this._data) result[key] = this._data[key];
          }
          return result;
        },
        async set(data) {
          Object.assign(this._data, data);
        },
      },
    },
  };

  const { DownloadHistoryStore } = await import('../background/download-history-store.js');
  const store = new DownloadHistoryStore();
  return store;
}

test('init loads records from storage', async () => {
  const records = [
    { id: '1', title: 'Video A', timestamp: 1000 },
    { id: '2', title: 'Video B', timestamp: 2000 },
  ];
  const store = await createStore({
    'ovd.downloadHistory': { records },
  });

  await store.init();
  const result = await store.getAll();

  assert.equal(result.length, 2);
  assert.equal(result[0].id, '1');
  assert.equal(result[1].id, '2');
});

test('init with empty storage sets empty records', async () => {
  const store = await createStore();
  await store.init();
  const result = await store.getAll();

  assert.equal(result.length, 0);
});

test('addRecord prepends with defaults, persists', async () => {
  const store = await createStore();
  await store.init();

  await store.addRecord({
    url: 'https://example.com/video.mp4',
    title: 'Test Video',
    type: 'direct',
  });

  const records = await store.getAll();
  assert.equal(records.length, 1);
  assert.equal(records[0].url, 'https://example.com/video.mp4');
  assert.equal(records[0].title, 'Test Video');
  assert.equal(records[0].type, 'direct');
  assert.ok(records[0].id, 'should have auto-generated id');
  assert.ok(records[0].timestamp > 0, 'should have timestamp');
  assert.equal(records[0].status, 'complete');

  // Verify persisted to storage
  const stored = globalThis.chrome.storage.local._data['ovd.downloadHistory'];
  assert.ok(stored);
  assert.equal(stored.records.length, 1);
});

test('addRecord prepends newest first', async () => {
  const store = await createStore();
  await store.init();

  await store.addRecord({ title: 'First' });
  await store.addRecord({ title: 'Second' });

  const records = await store.getAll();
  assert.equal(records.length, 2);
  assert.equal(records[0].title, 'Second');
  assert.equal(records[1].title, 'First');
});

test('addRecord merges duplicate downloadId instead of adding a second record', async () => {
  const store = await createStore();
  await store.init();

  await store.addRecord({
    downloadId: 123,
    title: 'Started',
    url: 'https://example.com/video',
  });
  await store.addRecord({
    downloadId: 123,
    filename: '/home/user/Downloads/video.mp4',
    size: 4096,
    title: 'Completed',
    url: 'https://example.com/video',
  });

  const records = await store.getAll();
  assert.equal(records.length, 1);
  assert.equal(records[0].downloadId, 123);
  assert.equal(records[0].title, 'Completed');
  assert.equal(records[0].filename, '/home/user/Downloads/video.mp4');
  assert.equal(records[0].size, 4096);
});

test('addRecord merges duplicate taskId when downloadId is unavailable', async () => {
  const store = await createStore();
  await store.init();

  await store.addRecord({
    taskId: 'trace:abc',
    title: 'Started',
    url: 'https://example.com/video',
  });
  await store.addRecord({
    filename: '/home/user/Downloads/video.mp4',
    size: 4096,
    taskId: 'trace:abc',
    title: 'Completed',
    url: 'https://example.com/video',
  });

  const records = await store.getAll();
  assert.equal(records.length, 1);
  assert.equal(records[0].taskId, 'trace:abc');
  assert.equal(records[0].title, 'Completed');
  assert.equal(records[0].filename, '/home/user/Downloads/video.mp4');
  assert.equal(records[0].size, 4096);
});

test('addRecord merges duplicate filename when downloadId is unavailable', async () => {
  const store = await createStore();
  await store.init();

  await store.addRecord({
    filename: '/home/user/Downloads/video.mp4',
    title: 'First',
  });
  await store.addRecord({
    filename: '/home/user/Downloads/video.mp4',
    title: 'Second',
    type: 'bilibili',
  });

  const records = await store.getAll();
  assert.equal(records.length, 1);
  assert.equal(records[0].title, 'Second');
  assert.equal(records[0].type, 'bilibili');
});

test('addRecord does not merge same URL without shared task identity', async () => {
  const store = await createStore();
  await store.init();

  await store.addRecord({
    timestamp: 10000,
    title: 'Detected title',
    url: 'https://example.com/video.mp4',
  });
  await store.addRecord({
    timestamp: 11000,
    title: 'Downloaded title',
    url: 'https://example.com/video.mp4',
  });

  const records = await store.getAll();
  assert.equal(records.length, 2);
  assert.equal(records[0].title, 'Downloaded title');
  assert.equal(records[1].title, 'Detected title');
});

test('addRecord does not merge records with similar titles', async () => {
  const store = await createStore();
  await store.init();

  await store.addRecord({
    filename: '/home/user/Downloads/探秘北极超市.mp4',
    timestamp: 20000,
    taskId: 'task:first',
    title: '/home/user/Downloads/探秘北极超市.mp4',
    type: 'direct',
  });
  await store.addRecord({
    filename: '/home/user/Downloads/探秘北极超市.mp4',
    timestamp: 21000,
    taskId: 'task:second',
    title: '探秘北极超市！物价多离谱？超市都卖...',
    type: 'bilibili',
  });

  const records = await store.getAll();
  assert.equal(records.length, 2);
  assert.equal(records[0].type, 'bilibili');
  assert.equal(records[0].filename, '/home/user/Downloads/探秘北极超市.mp4');
});

test('addRecord does not merge duplicate filename when task identities differ', async () => {
  const store = await createStore();
  await store.init();

  await store.addRecord({
    filename: '/home/user/Downloads/video.mp4',
    taskId: 'task:first',
    title: 'First',
  });
  await store.addRecord({
    filename: '/home/user/Downloads/video.mp4',
    taskId: 'task:second',
    title: 'Second',
  });

  const records = await store.getAll();
  assert.equal(records.length, 2);
  assert.equal(records[0].title, 'Second');
  assert.equal(records[1].title, 'First');
});

test('addRecord enforces 100-record limit (FIFO eviction from end)', async () => {
  const store = await createStore();
  await store.init();

  // Add 102 records
  for (let i = 0; i < 102; i++) {
    await store.addRecord({ id: `rec-${i}`, title: `Video ${i}`, timestamp: i });
  }

  const records = await store.getAll();
  assert.equal(records.length, 100);
  // Newest should be at index 0 (rec-101 is not used; ids are auto-generated but order is guaranteed by unshift)
  // The oldest records (rec-0, rec-1) should have been evicted from the end
  // Since records are prepended, rec-101 (last added) is first, rec-0 is near the end and evicted
  assert.equal(records[0].title, 'Video 101');
  assert.equal(records[99].title, 'Video 2');
});

test('getAll returns copy', async () => {
  const store = await createStore();
  await store.init();
  await store.addRecord({ title: 'Original' });

  const copy1 = await store.getAll();
  const copy2 = await store.getAll();
  assert.notEqual(copy1, copy2);
  assert.deepEqual(copy1, copy2);
});

test('clear empties records', async () => {
  const store = await createStore();
  await store.init();
  await store.addRecord({ title: 'A' });
  await store.addRecord({ title: 'B' });

  await store.clear();
  const records = await store.getAll();
  assert.equal(records.length, 0);

  // Also persisted
  const stored = globalThis.chrome.storage.local._data['ovd.downloadHistory'];
  assert.deepEqual(stored.records, []);
});

test('prune removes records older than N days', async () => {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const store = await createStore({
    'ovd.downloadHistory': {
      records: [
        { id: '1', title: 'Recent', timestamp: now - DAY_MS },
        { id: '2', title: 'Old', timestamp: now - 10 * DAY_MS },
        { id: '3', title: 'Very Old', timestamp: now - 30 * DAY_MS },
      ],
    },
  });
  await store.init();

  await store.prune(7);

  const records = await store.getAll();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, '1');
});

test('prune removes nothing if all within retention', async () => {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const store = await createStore({
    'ovd.downloadHistory': {
      records: [
        { id: '1', title: 'Recent', timestamp: now - DAY_MS },
        { id: '2', title: 'Also Recent', timestamp: now - 2 * DAY_MS },
      ],
    },
  });
  await store.init();

  await store.prune(30);

  const records = await store.getAll();
  assert.equal(records.length, 2);
});

test('prune with retentionDays=0 is no-op', async () => {
  const now = Date.now();
  const store = await createStore({
    'ovd.downloadHistory': {
      records: [
        { id: '1', title: 'Old', timestamp: now - 365 * 24 * 60 * 60 * 1000 },
      ],
    },
  });
  await store.init();

  await store.prune(0);

  const records = await store.getAll();
  assert.equal(records.length, 1);
});

test('prune with retentionDays=null is no-op', async () => {
  const now = Date.now();
  const store = await createStore({
    'ovd.downloadHistory': {
      records: [
        { id: '1', title: 'Old', timestamp: now - 365 * 24 * 60 * 60 * 1000 },
      ],
    },
  });
  await store.init();

  await store.prune(null);

  const records = await store.getAll();
  assert.equal(records.length, 1);
});

test('deleteRecord removes a record by id', async () => {
  const store = await createStore();
  await store.init();
  await store.addRecord({ id: 'a', title: 'Keep' });
  await store.addRecord({ id: 'b', title: 'Delete' });
  await store.addRecord({ id: 'c', title: 'Also Keep' });

  await store.deleteRecord('b');

  const records = await store.getAll();
  assert.equal(records.length, 2);
  assert.equal(records[0].id, 'c');
  assert.equal(records[1].id, 'a');
});

test('deleteRecord persists after deletion', async () => {
  const store = await createStore();
  await store.init();
  await store.addRecord({ id: 'x', title: 'To Delete' });
  await store.addRecord({ id: 'y', title: 'To Keep' });

  await store.deleteRecord('x');

  const stored = globalThis.chrome.storage.local._data['ovd.downloadHistory'];
  assert.equal(stored.records.length, 1);
  assert.equal(stored.records[0].id, 'y');
});

test('deleteRecord is no-op when id not found', async () => {
  const store = await createStore();
  await store.init();
  await store.addRecord({ id: '1', title: 'Exists' });

  await store.deleteRecord('nonexistent');

  const records = await store.getAll();
  assert.equal(records.length, 1);
});
