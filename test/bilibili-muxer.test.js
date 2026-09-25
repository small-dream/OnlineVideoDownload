'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadMuxer() {
  const filePath = path.resolve(__dirname, '../lib/bilibili-muxer.js');
  // 真实内容脚本顺序里 mp4-muxer 先加载（manifest content_scripts 顺序）
  require(path.resolve(__dirname, '../lib/mp4-muxer.js'));
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

// ===============================================================
// 4.2：真实 moov fixture 的端到端合并
// ===============================================================

function fourCC(text) {
  return Uint8Array.from([...text].map((ch) => ch.charCodeAt(0)));
}

function makeHdlr(handler) {
  const payload = new Uint8Array(24);
  payload.set(fourCC(handler), 8); // version+flags(4) + pre_defined(4) + handler_type
  return makeBox('hdlr', payload);
}

function makeMdhd(timescale) {
  const payload = new Uint8Array(20);
  const view = new DataView(payload.buffer);
  view.setUint32(12, timescale); // v0: timescale
  view.setUint32(16, 0); // duration
  return makeBox('mdhd', payload);
}

/** 最小但结构合法的 avcC（含 SPS/PPS，供 mp4-muxer 构造输出配置） */
function makeAvcC() {
  const sps = new Uint8Array([
    0x67, 0x42, 0xC0, 0x1E, 0xDA, 0x01, 0x40, 0x16, 0xEC, 0x04, 0x40, 0x00,
    0x00, 0x03, 0x00, 0x40, 0x00, 0x00, 0x0C, 0x83, 0xC6, 0x0C, 0xA8,
  ]);
  const pps = new Uint8Array([0x68, 0xCE, 0x38, 0x80]);
  const payload = Uint8Array.from([
    1, 0x42, 0xC0, 0x1E, 0xFF, 0xE1, 0, sps.length,
    ...sps,
    1, 0, pps.length, ...pps,
  ]);
  return makeBox('avcC', payload);
}

/** 标准 esds 描述符链，DecoderSpecificInfo 为 AAC-LC / 44.1kHz / 立体声 */
function makeEsds() {
  const asc = new Uint8Array([0x12, 0x10]);
  const dsi = Uint8Array.from([0x05, asc.length, ...asc]);
  const dcd = Uint8Array.from([
    0x04, 13 + dsi.length, // tag + length
    0x40, 0x15, // AAC + AudioStream
    0, 0, 0, // bufferSizeDB
    0, 0, 0, 0, // maxBitrate
    0, 0, 0, 0, // avgBitrate
    ...dsi,
  ]);
  const es = Uint8Array.from([0x03, 3 + dcd.length, 0x00, 0x01, 0x00, ...dcd]);
  return makeBox('esds', Uint8Array.from([0, 0, 0, 0, ...es]));
}

function makeStsd(sampleEntry) {
  const payload = new Uint8Array(8 + sampleEntry.length);
  new DataView(payload.buffer).setUint32(4, 1); // entry_count = 1
  payload.set(sampleEntry, 8);
  return makeBox('stsd', payload);
}

function makeVideoMoov(timescale = 30000) {
  // size+type(8) 之后的 VisualSampleEntry：8(SampleEntry) + 70(visual fields)
  const visualEntry = new Uint8Array(78);
  const visualView = new DataView(visualEntry.buffer);
  visualView.setUint16(16, 1920);
  visualView.setUint16(18, 1080);
  visualView.setUint16(24, 1920);
  visualView.setUint16(26, 1080);
  const avc1 = makeBox('avc1', concat([visualEntry, makeAvcC()]));
  const stbl = makeBox('stbl', makeStsd(avc1));
  const minf = makeBox('minf', stbl);
  const mdia = makeBox('mdia', concat([makeHdlr('vide'), makeMdhd(timescale), minf]));
  return makeBox('moov', makeBox('trak', mdia));
}

function makeAudioMoov(timescale = 44100) {
  const audioEntry = new Uint8Array(28);
  const audioView = new DataView(audioEntry.buffer);
  audioView.setUint16(16, 2); // channelCount
  audioView.setUint16(18, 16); // sampleSize
  audioView.setUint32(24, timescale << 16); // 16.16 sampleRate
  const mp4a = makeBox('mp4a', concat([audioEntry, makeEsds()]));
  const stbl = makeBox('stbl', makeStsd(mp4a));
  const minf = makeBox('minf', stbl);
  const mdia = makeBox('mdia', concat([makeHdlr('soun'), makeMdhd(timescale), minf]));
  return makeBox('moov', makeBox('trak', mdia));
}

/** 真实结构的最小 fMP4：ftyp + moov + N×(moof+mdat) */
function buildRealFmp4({ moov, fragmentCount, sampleSize, fill }) {
  const parts = [makeBox('ftyp', concat([fourCC('isom'), new Uint8Array([0, 0, 2, 0]), fourCC('isom')])), moov];
  for (let index = 0; index < fragmentCount; index++) {
    parts.push(makeMoof([sampleSize]));
    parts.push(makeBox('mdat', new Uint8Array(sampleSize).fill(fill ?? index % 250)));
  }
  return concat(parts).buffer;
}

test('真实 moov fixture 可以端到端合并出带双轨 moov 的 MP4', async () => {
  const muxer = loadMuxer();
  const { __internals } = muxer;
  const video = buildRealFmp4({ moov: makeVideoMoov(), fragmentCount: 4, sampleSize: 2048 });
  const audio = buildRealFmp4({ moov: makeAudioMoov(), fragmentCount: 4, sampleSize: 512 });

  const blob = await muxer.mergeFmp4Streams(video, audio);
  const output = new Uint8Array(await blob.arrayBuffer());
  const boxes = __internals.parseBoxes(output.buffer);

  assert.ok(blob.size > 0);
  assert.ok(output.byteLength > video.byteLength + audio.byteLength, '输出应包含 moov 与 mdia 开销');
  assert.ok(boxes.has('moov'), '输出应包含 moov');
  assert.ok(boxes.has('mdat'), '输出应包含 mdat');

  const moov = boxes.get('moov');
  const moovBoxes = __internals.parseBoxes(output.buffer, moov.offset + 8, moov.offset + moov.size);
  const traks = moovBoxes.get('trak');
  assert.equal(Array.isArray(traks) ? traks.length : 1, 2, '合并结果应包含视频与音频两条轨道');
});

test('真实 fixture 多分片合并仍满足零拷贝（解析期内存与体积解耦）', async () => {
  const muxer = loadMuxer();
  const { __internals } = muxer;
  const video = buildRealFmp4({ moov: makeVideoMoov(), fragmentCount: 16, sampleSize: 128 * 1024 });
  const audio = buildRealFmp4({ moov: makeAudioMoov(), fragmentCount: 16, sampleSize: 32 * 1024 });

  const videoFragments = __internals.collectFragments(video);
  const audioFragments = __internals.collectFragments(audio);
  const before = usedBytes();
  const samples = [
    ...videoFragments.flatMap((fragment) => __internals.parseFragment(video, fragment)),
    ...audioFragments.flatMap((fragment) => __internals.parseFragment(audio, fragment)),
  ];
  const growth = usedBytes() - before;

  assert.equal(samples.length, 32);
  assert.ok(samples.every((sample) => sample.data.buffer === video || sample.data.buffer === audio));
  assert.ok(growth < 8 * 1024 * 1024, `解析期不应随媒体体积增长，实际 ${growth} 字节`);
});
