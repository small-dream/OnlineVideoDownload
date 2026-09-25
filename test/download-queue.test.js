'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '../background/download-queue.js');

let importCounter = 0;

function loadQueueClass() {
  importCounter += 1;
  return import(`${pathToFileURL(MODULE_PATH).href}?test=${importCounter}`)
    .then((mod) => mod.DownloadQueue);
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('DownloadQueue 在限额内立即执行', async () => {
  const DownloadQueue = await loadQueueClass();
  const queue = new DownloadQueue({ limit: 2 });
  const order = [];

  await Promise.all([
    queue.run(async () => { order.push('a'); }),
    queue.run(async () => { order.push('b'); }),
  ]);

  assert.deepEqual(order.sort(), ['a', 'b']);
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.pendingCount, 0);
});

test('DownloadQueue 超过限额时排队并按释放顺序唤醒', async () => {
  const DownloadQueue = await loadQueueClass();
  const queue = new DownloadQueue({ limit: 1 });
  const first = deferred();
  const order = [];

  const running = queue.run(async () => {
    order.push('first-start');
    await first.promise;
    order.push('first-end');
  });

  const second = queue.run(async () => {
    order.push('second');
  });

  // 让第一个任务真正开始
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['first-start']);
  assert.equal(queue.pendingCount, 1);
  assert.equal(queue.activeCount, 1);

  first.resolve();
  await Promise.all([running, second]);

  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.pendingCount, 0);
});

test('DownloadQueue 提高限额后立即放行等待中的任务', async () => {
  const DownloadQueue = await loadQueueClass();
  const queue = new DownloadQueue({ limit: 1 });
  const first = deferred();
  const done = [];

  const running = queue.run(async () => {
    await first.promise;
  });
  const waiting = queue.run(async () => {
    done.push('second');
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(done, []);

  queue.setLimit(2);
  await waiting;
  assert.deepEqual(done, ['second']);
  assert.equal(queue.activeCount, 1);

  first.resolve();
  await running;
  assert.equal(queue.activeCount, 0);
});

test('DownloadQueue 任务抛错时仍然释放额度', async () => {
  const DownloadQueue = await loadQueueClass();
  const queue = new DownloadQueue({ limit: 1 });

  await assert.rejects(() => queue.run(async () => {
    throw new Error('boom');
  }), /boom/);

  assert.equal(queue.activeCount, 0);
  await queue.run(async () => {});
  assert.equal(queue.activeCount, 0);
});

test('DownloadQueue 拒绝已取消（aborted）的任务', async () => {
  const DownloadQueue = await loadQueueClass();
  const queue = new DownloadQueue({ limit: 1 });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => queue.run(async () => {}, { signal: controller.signal }),
    (err) => {
      assert.equal(err.code, 'DOWNLOAD_ABORTED');
      return true;
    }
  );
  assert.equal(queue.activeCount, 0);
});

test('DownloadQueue 对非法限额回退到默认值', async () => {
  const DownloadQueue = await loadQueueClass();
  assert.equal(new DownloadQueue({ limit: 0 }).limit, 3);
  assert.equal(new DownloadQueue({ limit: -5 }).limit, 3);
  assert.equal(new DownloadQueue({ limit: 'abc' }).limit, 3);
  assert.equal(new DownloadQueue({ limit: 99 }).limit, 10);
});
