'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadScale() {
  delete globalThis.__OVD_PROGRESS_SCALE__;
  const filePath = path.resolve(__dirname, '../lib/progress-scale.js');
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis.__OVD_PROGRESS_SCALE__;
}

test('抓取阶段映射到 0..90', () => {
  const scale = loadScale();
  assert.equal(scale.mapPhasePercent('fetching', 0), 0);
  assert.equal(scale.mapPhasePercent('fetching', 50), 45);
  assert.equal(scale.mapPhasePercent('fetching', 100), 90);
});

test('合并阶段接在抓取之后（90..99），完成后由 complete 补到 100', () => {
  const scale = loadScale();
  assert.equal(scale.mapPhasePercent('merging', 0), 90);
  assert.equal(scale.mapPhasePercent('merging', 50), 95);
  assert.equal(scale.mapPhasePercent('merging', 100), 99);
  assert.equal(scale.mapPhasePercent('complete', 100), 100);
});

test('阶段映射保持单调：抓取任何值都不超过合并起点', () => {
  const scale = loadScale();
  for (let percent = 0; percent <= 100; percent++) {
    assert.ok(
      scale.mapPhasePercent('fetching', percent) <= scale.mapPhasePercent('merging', 0),
      `fetching ${percent}% 不应超过合并阶段起点`
    );
  }
  assert.ok(scale.mapPhasePercent('merging', 100) < 100, '合并完成不等于任务完成');
});

test('未登记阶段原样返回，非法输入夹到合法区间', () => {
  const scale = loadScale();
  assert.equal(scale.mapPhasePercent('recording', 42), 42);
  assert.equal(scale.mapPhasePercent(undefined, 42), 42);
  assert.equal(scale.mapPhasePercent('fetching', -5), 0);
  assert.equal(scale.mapPhasePercent('fetching', NaN), 0);
  assert.equal(scale.mapPhasePercent('fetching', Infinity), 0);
  assert.equal(scale.mapPhasePercent('fetching', 150), 90);
  assert.equal(scale.mapPhasePercent('merging', 150), 99);
  assert.equal(scale.normalizePercent(37.6), 38);
});
