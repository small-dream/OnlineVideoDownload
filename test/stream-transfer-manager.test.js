'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadManagerFactory() {
  const key = '__OVD_STREAM_TRANSFER_MANAGER__';
  const filePath = path.resolve(__dirname, '../content/stream-transfer-manager.js');
  // 真实内容脚本顺序里 byte-utils 先加载，base64 解码依赖它
  require(path.resolve(__dirname, '../lib/byte-utils.js'));
  globalThis.__OVD_CONSTANTS__ = { MEDIA_STREAM_TIMEOUT: 200 };
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[key];
}

function base64Of(bytes) {
  return Buffer.from(Uint8Array.from(bytes)).toString('base64');
}

function createHarness() {
  const sent = [];
  const manager = loadManagerFactory().createStreamTransferManager({
    postMessageToPage: () => {},
    sendMessageAsync: async (message) => {
      sent.push(message);
      return { ok: true };
    },
    triggerBlobDownload: () => {},
    videoUtils: {},
  });

  return { manager, sent };
}

async function createTransfer(harness) {
  const promise = harness.manager.fetchMediaStreamsAndWait('v', 'a', {}, 'bili', 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { promise, transferId: harness.sent[0].transferId };
}

test('抓取请求携带任务身份（只透传身份字段，不含 videoInfo）', async () => {
  const harness = createHarness();
  const promise = harness.manager.fetchMediaStreamsAndWait('https://cdn.example/v', 'https://cdn.example/a', {}, 'bili', 'timeout', {
    sourceId: 'bilibili',
    strategyId: 'page-api',
    taskKey: 'bili:BV1:2',
    title: 'Demo',
    traceId: 'trace-1',
    videoInfo: { large: true },
    videoUrl: 'https://www.bilibili.com/video/BV1',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // 后台据此把抓取阶段进度写进同一任务，不必逐条回传整个 videoInfo
  assert.deepEqual(harness.sent[0].taskMeta, {
    sourceId: 'bilibili',
    strategyId: 'page-api',
    taskKey: 'bili:BV1:2',
    title: 'Demo',
    traceId: 'trace-1',
    videoUrl: 'https://www.bilibili.com/video/BV1',
  });

  harness.manager.failMediaStreamTransfer(harness.sent[0].transferId, 'test cleanup');
  await promise.catch(() => {});
});

// ---------------------------------------------------------------
// P0：后台流水线回传后，分片按 seq 还原顺序（到达顺序不再保证）
// ---------------------------------------------------------------

test('乱序到达的视音频分片按 seq 还原为正确顺序', async () => {
  const harness = createHarness();
  const { promise, transferId } = await createTransfer(harness);

  harness.manager.startMediaStreamTransfer(transferId);

  // 视频 3 块、音频 2 块，均乱序到达
  harness.manager.appendMediaStreamChunk(transferId, 'video', base64Of([3, 3]), 2);
  harness.manager.appendMediaStreamChunk(transferId, 'video', base64Of([1, 1]), 0);
  harness.manager.appendMediaStreamChunk(transferId, 'video', base64Of([2, 2]), 1);
  harness.manager.appendMediaStreamChunk(transferId, 'audio', base64Of([9]), 1);
  harness.manager.appendMediaStreamChunk(transferId, 'audio', base64Of([8]), 0);

  harness.manager.finishMediaStreamTransfer(transferId);
  const result = await promise;

  assert.deepEqual(Array.from(new Uint8Array(result.videoBuffer)), [1, 1, 2, 2, 3, 3]);
  assert.deepEqual(Array.from(new Uint8Array(result.audioBuffer)), [8, 9]);
});

test('重复到达的同一 seq 不会覆盖已收到的分片', async () => {
  const harness = createHarness();
  const { promise, transferId } = await createTransfer(harness);

  harness.manager.appendMediaStreamChunk(transferId, 'video', base64Of([1]), 0);
  harness.manager.appendMediaStreamChunk(transferId, 'video', base64Of([9]), 0);
  harness.manager.appendMediaStreamChunk(transferId, 'video', base64Of([2]), 1);
  harness.manager.finishMediaStreamTransfer(transferId);

  const result = await promise;
  assert.deepEqual(Array.from(new Uint8Array(result.videoBuffer)), [1, 2]);
});

test('分片缺失时 fail-fast，不产出缺片文件', async () => {
  const harness = createHarness();
  const { promise, transferId } = await createTransfer(harness);

  harness.manager.appendMediaStreamChunk(transferId, 'video', base64Of([1]), 0);
  harness.manager.appendMediaStreamChunk(transferId, 'video', base64Of([3]), 2);
  harness.manager.appendMediaStreamChunk(transferId, 'audio', base64Of([8]), 0);
  harness.manager.finishMediaStreamTransfer(transferId);

  await assert.rejects(promise, (err) => {
    assert.equal(err.code, 'MEDIA_STREAM_CHUNK_MISSING');
    assert.equal(err.label, '视频');
    assert.equal(err.index, 1);
    return true;
  });
});

test('不带 seq 的旧调用方退化为顺序追加', async () => {
  const harness = createHarness();
  const { promise, transferId } = await createTransfer(harness);

  harness.manager.appendMediaStreamChunk(transferId, 'video', base64Of([1]));
  harness.manager.appendMediaStreamChunk(transferId, 'video', base64Of([2]));
  harness.manager.appendMediaStreamChunk(transferId, 'audio', base64Of([7]));
  harness.manager.finishMediaStreamTransfer(transferId);

  const result = await promise;
  assert.deepEqual(Array.from(new Uint8Array(result.videoBuffer)), [1, 2]);
  assert.deepEqual(Array.from(new Uint8Array(result.audioBuffer)), [7]);
});

test('空的传输（无分片）仍可正常完成', async () => {
  const harness = createHarness();
  const { promise, transferId } = await createTransfer(harness);

  harness.manager.finishMediaStreamTransfer(transferId);
  const result = await promise;

  assert.equal(result.videoBuffer.byteLength, 0);
  assert.equal(result.audioBuffer.byteLength, 0);
});
