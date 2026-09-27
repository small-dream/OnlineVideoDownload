'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const QUEUE_PATH = path.resolve(__dirname, '../background/download-queue.js');
const SLOT_PATH = path.resolve(__dirname, '../background/download-slot-port.js');

let importCounter = 0;

async function loadModules() {
  importCounter += 1;
  const suffix = `?slot=${importCounter}`;
  const queueMod = await import(`${pathToFileURL(QUEUE_PATH).href}${suffix}`);
  const slotMod = await import(`${pathToFileURL(SLOT_PATH).href}${suffix}`);
  return { DownloadQueue: queueMod.DownloadQueue, handleDownloadSlotMessage: slotMod.handleDownloadSlotMessage };
}

test('ACQUIRE 在限额内立即放行', async () => {
  const { DownloadQueue, handleDownloadSlotMessage } = await loadModules();
  const queue = new DownloadQueue({ limit: 2 });

  const reply = await handleDownloadSlotMessage(queue, 'port:1', {
    entry: { label: 'B 站视频', videoUrl: 'https://x/v' },
    id: 's1',
    type: 'ACQUIRE',
  });

  assert.deepEqual(reply, { id: 's1', type: 'SLOT_ADMITTED' });
  assert.equal(queue.activeCount, 1);
  assert.equal(queue.snapshot().entries[0].owner, 'port:1');
});

test('ACQUIRE 超出限额时挂起，RELEASE 后放行', async () => {
  const { DownloadQueue, handleDownloadSlotMessage } = await loadModules();
  const queue = new DownloadQueue({ limit: 1 });

  await handleDownloadSlotMessage(queue, 'port:1', { id: 'first', type: 'ACQUIRE' });
  const pending = handleDownloadSlotMessage(queue, 'port:1', { id: 'second', type: 'ACQUIRE' });

  assert.equal(queue.pendingCount, 1);
  assert.equal(queue.positionOf('second'), 1);

  const releaseReply = await handleDownloadSlotMessage(queue, 'port:1', { id: 'first', type: 'RELEASE' });
  assert.deepEqual(releaseReply, { id: 'first', released: true, type: 'SLOT_RELEASED' });

  assert.deepEqual(await pending, { id: 'second', type: 'SLOT_ADMITTED' });
  assert.equal(queue.activeCount, 1);
});

test('CANCEL 只取消排队中的槽位', async () => {
  const { DownloadQueue, handleDownloadSlotMessage } = await loadModules();
  const queue = new DownloadQueue({ limit: 1 });

  await handleDownloadSlotMessage(queue, 'port:1', { id: 'first', type: 'ACQUIRE' });
  const pending = handleDownloadSlotMessage(queue, 'port:1', { id: 'second', type: 'ACQUIRE' });

  const cancelReply = await handleDownloadSlotMessage(queue, 'port:1', { id: 'second', type: 'CANCEL' });
  assert.deepEqual(cancelReply, { cancelled: true, id: 'second', type: 'SLOT_CANCELLED' });
  assert.deepEqual(await pending, { error: '已取消排队', id: 'second', type: 'SLOT_ABORTED' });

  const cancelRunning = await handleDownloadSlotMessage(queue, 'port:1', { id: 'first', type: 'CANCEL' });
  assert.deepEqual(cancelRunning, { cancelled: false, id: 'first', type: 'SLOT_CANCELLED' });
});

test('PING 返回拥有者与队列快照，未知消息返回 null', async () => {
  const { DownloadQueue, handleDownloadSlotMessage } = await loadModules();
  const queue = new DownloadQueue({ limit: 3 });

  const pong = await handleDownloadSlotMessage(queue, 'port:9', { type: 'PING' });
  assert.equal(pong.type, 'SLOT_READY');
  assert.equal(pong.owner, 'port:9');
  assert.equal(pong.queue.limit, 3);

  assert.equal(await handleDownloadSlotMessage(queue, 'port:9', { type: 'NOPE' }), null);
});
