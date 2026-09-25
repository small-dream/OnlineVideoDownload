'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '../background/download-strategies/youtube-adaptive-download-strategy.js');
const GB = 1024 * 1024 * 1024;

let importCounter = 0;

async function loadStrategy() {
  // 模块顶层会 import 若干依赖（header-injector 等），给一个最小 chrome 兜底
  globalThis.chrome = globalThis.chrome || {};
  importCounter += 1;
  return import(`${pathToFileURL(MODULE_PATH).href}?test=${importCounter}`);
}

test('decideAdaptiveDownloadRoute：上限内照常合并', async () => {
  const { decideAdaptiveDownloadRoute } = await loadStrategy();

  assert.equal(decideAdaptiveDownloadRoute({ estimatedBytes: 300 * 1024 * 1024 }), 'merge');
  assert.equal(decideAdaptiveDownloadRoute({ estimatedBytes: 0 }), 'merge');
  // 恰好等于上限也允许（不引入 off-by-one 误报）
  assert.equal(
    decideAdaptiveDownloadRoute({ estimatedBytes: 768 * 1024 * 1024, limitBytes: 768 * 1024 * 1024 }),
    'merge'
  );
});

test('decideAdaptiveDownloadRoute：超限时优先改走 HLS 流式落盘', async () => {
  const { decideAdaptiveDownloadRoute } = await loadStrategy();

  // 现场案例：1.7GB 的视频
  assert.equal(
    decideAdaptiveDownloadRoute({ estimatedBytes: 1.7 * GB, hasHlsManifest: true }),
    'hls'
  );
});

test('decideAdaptiveDownloadRoute：超限且无 HLS 清单时明确拒绝', async () => {
  const { decideAdaptiveDownloadRoute } = await loadStrategy();

  assert.equal(
    decideAdaptiveDownloadRoute({ estimatedBytes: 1.7 * GB, hasHlsManifest: false }),
    'reject'
  );
});

test('YOUTUBE_MERGE_MAX_BYTES 明显低于 ArrayBuffer 硬上限', async () => {
  await loadStrategy();
  const constants = globalThis.__OVD_CONSTANTS__ || {};

  assert.equal(typeof constants.YOUTUBE_MERGE_MAX_BYTES, 'number');
  // 合并期峰值 ≈ 3~4× 总字节：留足余量，避免 1.7GB 这类输入直接分配失败
  assert.ok(constants.YOUTUBE_MERGE_MAX_BYTES <= 1024 * 1024 * 1024);
  assert.ok(constants.YOUTUBE_MERGE_MAX_BYTES < constants.MAX_IN_PAGE_MERGE_BYTES);
});
