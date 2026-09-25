'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadMuxer() {
  const filePath = path.resolve(__dirname, '../lib/bilibili-muxer.js');
  delete globalThis.BilibiliMuxer;
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis.BilibiliMuxer;
}

function makeBox(type, payload) {
  const buffer = new Uint8Array(8 + payload.length);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, buffer.length);
  for (let i = 0; i < 4; i++) {
    buffer[4 + i] = type.charCodeAt(i);
  }
  buffer.set(payload, 8);
  return buffer;
}

function makeTfhd(defaultDuration = 1000) {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  // payload[0]=version, payload[1..3]=flags(0x000008 = default-sample-duration)
  payload[3] = 0x08;
  view.setUint32(4, 1); // trackId
  view.setUint32(8, defaultDuration); // default-sample-duration
  return makeBox('tfhd', payload);
}

function makeTrun(sampleSizes) {
  const payload = new Uint8Array(8 + sampleSizes.length * 4);
  const view = new DataView(payload.buffer);
  // payload[0]=version, payload[1..3]=flags(0x000200 = sample-size-present)
  payload[2] = 0x02;
  view.setUint32(4, sampleSizes.length);
  sampleSizes.forEach((size, index) => {
    view.setUint32(8 + index * 4, size);
  });
  return makeBox('trun', payload);
}

function makeMoof(sampleSizes) {
  const trafPayload = concat([makeTfhd(), makeTrun(sampleSizes)]);
  const traf = makeBox('traf', trafPayload);
  return makeBox('moof', traf);
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

/** 构造 moov + N×(moof + mdat) 的盒子流（不做真实解码，只验证零拷贝不变量） */
function buildStream(fragmentCount, sampleSize) {
  const parts = [makeBox('moov', new Uint8Array(16))];
  for (let index = 0; index < fragmentCount; index++) {
    parts.push(makeMoof([sampleSize]));
    const sample = new Uint8Array(sampleSize).fill(index % 200);
    parts.push(makeBox('mdat', sample));
  }
  const bytes = concat(parts);
  return bytes.buffer;
}

function usedBytes() {
  globalThis.gc?.();
  return process.memoryUsage().arrayBuffers;
}

test('parseBoxes 只记录偏移，不再复制盒子内容', () => {
  const { __internals } = loadMuxer();
  const buffer = concat([makeBox('free', new Uint8Array(4096))]).buffer;

  const boxes = __internals.parseBoxes(buffer);
  const entry = boxes.get('free');

  assert.deepEqual(entry, { offset: 0, size: 4104 });
  assert.equal('data' in entry, false, 'box.data 不应再被复制出来');
});

test('collectFragments 只产出偏移，不复制媒体数据', () => {
  const { __internals } = loadMuxer();
  const sampleSize = 1024 * 1024;
  const buffer = buildStream(8, sampleSize);

  const before = usedBytes();
  const fragments = __internals.collectFragments(buffer);
  const growth = usedBytes() - before;

  assert.equal(fragments.length, 8);
  assert.deepEqual(
    Object.keys(fragments[0]).sort(),
    ['mdatPayloadOffset', 'mdatPayloadSize', 'moofPayloadOffset', 'moofPayloadSize']
  );
  assert.ok(growth < 128 * 1024, `不应按媒体体积分配内存，实际增长 ${growth} 字节`);
});

test('parseFragment 返回的样本是原缓冲视图（零拷贝）且内容正确', () => {
  const { __internals } = loadMuxer();
  const sampleSize = 4096;
  const buffer = buildStream(1, sampleSize);
  const [fragment] = __internals.collectFragments(buffer);

  const samples = __internals.parseFragment(buffer, fragment);

  assert.equal(samples.length, 1);
  assert.equal(samples[0].data.buffer, buffer, '样本必须是同一 ArrayBuffer 上的视图');
  assert.equal(samples[0].data.byteLength, sampleSize);
  assert.equal(samples[0].duration, 1000);
  assert.equal(samples[0].isKey, true);
  assert.equal(samples[0].data[0], 0);
  assert.equal(samples[0].data[sampleSize - 1], 0);
});

test('多分片解析的内存增量与媒体体积解耦', () => {
  const { __internals } = loadMuxer();
  const fragmentCount = 24;
  const sampleSize = 1024 * 1024;
  const buffer = buildStream(fragmentCount, sampleSize);

  const before = usedBytes();
  const fragments = __internals.collectFragments(buffer);
  const samples = fragments.flatMap((fragment) => __internals.parseFragment(buffer, fragment));
  const growth = usedBytes() - before;

  const totalSampleBytes = samples.reduce((sum, sample) => sum + sample.data.byteLength, 0);
  assert.equal(totalSampleBytes, fragmentCount * sampleSize);
  assert.ok(growth < 4 * 1024 * 1024, `视图不应随样本数增长内存，实际增长 ${growth} 字节`);
});

test('parseFragment 对缺少 traf 的片段返回空数组', () => {
  const { __internals } = loadMuxer();
  const moof = makeBox('moof', makeBox('free', new Uint8Array(8)));
  const mdat = makeBox('mdat', new Uint8Array(16));
  const buffer = concat([moof, mdat]).buffer;

  const [fragment] = __internals.collectFragments(buffer);
  assert.deepEqual(__internals.parseFragment(buffer, fragment), []);
});

test('__internals 暴露的都是函数（供零拷贝不变量测试使用）', () => {
  const { __internals } = loadMuxer();
  for (const name of ['collectFragments', 'findBox', 'parseBoxes', 'parseFragment']) {
    assert.equal(typeof __internals[name], 'function', `${name} 应为函数`);
  }
});
