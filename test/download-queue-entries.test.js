'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '../background/download-queue.js');

let importCounter = 0;

function loadQueueClass() {
  importCounter += 1;
  return import(`${pathToFileURL(MODULE_PATH).href}?entries=${importCounter}`)
    .then((mod) => mod.DownloadQueue);
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('snapshot 报告进行中与排队中的位次', async () => {
  const DownloadQueue = await loadQueueClass();
  const queue = new DownloadQueue({ limit: 1 });

  await queue.acquire({ id: 'a', label: 'A', owner: 'background', videoUrl: 'https://x/a' });
  queue.acquire({ id: 'b', label: 'B', owner: 'port:1', videoUrl: 'https://x/b' });
  queue.acquire({ id: 'c', label: 'C', owner: 'port:1', videoUrl: 'https://x/c' });

  const snapshot = queue.snapshot();
  assert.equal(snapshot.limit, 1);
  assert.equal(snapshot.active, 1);
  assert.equal(snapshot.pending, 2);
  assert.deepEqual(
    snapshot.entries.map((entry) => [entry.id, entry.state, entry.position]),
    [['a', 'running', 0], ['b', 'queued', 1], ['c', 'queued', 2]]
  );

  assert.equal(queue.positionOf('c'), 2);
  assert.equal(queue.positionOf('a'), 0);
  assert.equal(queue.positionOf('missing'), 0);
});

test('cancelQueued 取消等待中的条目并让 acquire 拒绝', async () => {
  const DownloadQueue = await loadQueueClass();
  const queue = new DownloadQueue({ limit: 1 });
  const first = deferred();

  const running = queue.run(async () => { await first.promise; });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const waiting = queue.acquire({ id: 'b', owner: 'port:1' });
  assert.equal(queue.cancelQueued('b'), true);
  await assert.rejects(waiting, (err) => err.code === 'DOWNLOAD_ABORTED');
  assert.equal(queue.cancelQueued('b'), false);
  assert.equal(queue.pendingCount, 0);

  first.resolve();
  await running;
});

test('cancelQueued 对已开始的条目返回 false', async () => {
  const DownloadQueue = await loadQueueClass();
  const queue = new DownloadQueue({ limit: 2 });

  await queue.acquire({ id: 'a' });
  assert.equal(queue.cancelQueued('a'), false);
  assert.equal(queue.activeCount, 1);
  assert.equal(queue.release('a'), true);
});

test('releaseOwner 回收某个归属的全部条目', async () => {
  const DownloadQueue = await loadQueueClass();
  const queue = new DownloadQueue({ limit: 1 });

  await queue.acquire({ id: 'bg', owner: 'background' });
  const queued = queue.acquire({ id: 'p1', owner: 'port:7' });
  const queuedSecond = queue.acquire({ id: 'p2', owner: 'port:7' });

  assert.equal(queue.releaseOwner('port:7'), 2);
  await assert.rejects(queued, (err) => err.code === 'DOWNLOAD_ABORTED');
  await assert.rejects(queuedSecond, (err) => err.code === 'DOWNLOAD_ABORTED');
  assert.equal(queue.activeCount, 1);
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.activeCount, 1, '后台条目不受影响');
  assert.equal(queue.snapshot().entries.map((entry) => entry.id).join(','), 'bg');
});

test('onChange 在入队/放行/释放时通知并带快照', async () => {
  const DownloadQueue = await loadQueueClass();
  const queue = new DownloadQueue({ limit: 1 });
  const seen = [];
  const unsubscribe = queue.onChange((snapshot) => {
    seen.push([snapshot.active, snapshot.pending]);
  });

  await queue.acquire({ id: 'a' });
  queue.acquire({ id: 'b' });
  queue.release('a');

  assert.ok(seen.length >= 3);
  assert.deepEqual(seen[0], [1, 0]);
  assert.deepEqual(seen[1], [1, 1]);
  assert.deepEqual(seen[seen.length - 1], [1, 0]);
  unsubscribe();
});

test('提高限额后排队条目按 FIFO 放行并更新位次', async () => {
  const DownloadQueue = await loadQueueClass();
  const queue = new DownloadQueue({ limit: 1 });

  await queue.acquire({ id: 'a' });
  const second = queue.acquire({ id: 'b' });
  const third = queue.acquire({ id: 'c' });

  queue.setLimit(2);
  assert.deepEqual(await second, { id: 'b', position: 0 });
  assert.equal(queue.positionOf('c'), 1);
  assert.equal(queue.activeCount, 2);

  queue.setLimit(3);
  assert.deepEqual(await third, { id: 'c', position: 0 });
  assert.equal(queue.activeCount, 3);
});
