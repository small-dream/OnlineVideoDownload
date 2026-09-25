'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const STREAMING_MERGE_PATH = path.resolve(__dirname, '../background/streaming-merge.js');

// ---------------------------------------------------------------
// 最小 fMP4 fixture（结构与 test/bilibili-muxer.test.js 一致）
// ---------------------------------------------------------------

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

function makeBox(type, payload) {
  const buffer = new Uint8Array(8 + payload.length);
  new DataView(buffer.buffer).setUint32(0, buffer.length);
  for (let i = 0; i < 4; i++) {
    buffer[4 + i] = type.charCodeAt(i);
  }
  buffer.set(payload, 8);
  return buffer;
}

function fourCC(text) {
  return Uint8Array.from([...text].map((ch) => ch.charCodeAt(0)));
}

function makeMoof(sampleSizes) {
  const tfhdPayload = new Uint8Array(12);
  tfhdPayload[3] = 0x08; // default-sample-duration-present
  const tfhdView = new DataView(tfhdPayload.buffer);
  tfhdView.setUint32(4, 1); // track_id
  tfhdView.setUint32(8, 1000); // default duration

  const trunPayload = new Uint8Array(8 + sampleSizes.length * 4);
  trunPayload[2] = 0x02; // sample-size-present
  const trunView = new DataView(trunPayload.buffer);
  trunView.setUint32(4, sampleSizes.length);
  sampleSizes.forEach((size, index) => trunView.setUint32(8 + index * 4, size));

  return makeBox('moof', makeBox('traf', concat([makeBox('tfhd', tfhdPayload), makeBox('trun', trunPayload)])));
}

function makeHdlr(handler) {
  const payload = new Uint8Array(24);
  payload.set(fourCC(handler), 8);
  return makeBox('hdlr', payload);
}

function makeMdhd(timescale) {
  const payload = new Uint8Array(20);
  new DataView(payload.buffer).setUint32(12, timescale);
  return makeBox('mdhd', payload);
}

function makeAvcC() {
  const sps = new Uint8Array([
    0x67, 0x42, 0xC0, 0x1E, 0xDA, 0x01, 0x40, 0x16, 0xEC, 0x04, 0x40, 0x00,
    0x00, 0x03, 0x00, 0x40, 0x00, 0x00, 0x0C, 0x83, 0xC6, 0x0C, 0xA8,
  ]);
  const pps = new Uint8Array([0x68, 0xCE, 0x38, 0x80]);
  return makeBox('avcC', Uint8Array.from([
    1, 0x42, 0xC0, 0x1E, 0xFF, 0xE1, 0, sps.length, ...sps, 1, 0, pps.length, ...pps,
  ]));
}

function makeEsds() {
  const asc = new Uint8Array([0x12, 0x10]);
  const dsi = Uint8Array.from([0x05, asc.length, ...asc]);
  const dcd = Uint8Array.from([
    0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...dsi,
  ]);
  const es = Uint8Array.from([0x03, 3 + dcd.length, 0x00, 0x01, 0x00, ...dcd]);
  return makeBox('esds', Uint8Array.from([0, 0, 0, 0, ...es]));
}

function makeStsd(sampleEntry) {
  const payload = new Uint8Array(8 + sampleEntry.length);
  new DataView(payload.buffer).setUint32(4, 1);
  payload.set(sampleEntry, 8);
  return makeBox('stsd', payload);
}

function makeVideoMoov(timescale = 30000) {
  const visualEntry = new Uint8Array(78);
  const view = new DataView(visualEntry.buffer);
  view.setUint16(16, 1920);
  view.setUint16(18, 1080);
  view.setUint16(24, 1920);
  view.setUint16(26, 1080);
  const avc1 = makeBox('avc1', concat([visualEntry, makeAvcC()]));
  const mdia = makeBox('mdia', concat([makeHdlr('vide'), makeMdhd(timescale), makeBox('minf', makeBox('stbl', makeStsd(avc1)))]));
  return makeBox('moov', makeBox('trak', mdia));
}

function makeAudioMoov(timescale = 44100) {
  const audioEntry = new Uint8Array(28);
  const view = new DataView(audioEntry.buffer);
  view.setUint16(16, 2);
  view.setUint16(18, 16);
  view.setUint32(24, timescale << 16);
  const mp4a = makeBox('mp4a', concat([audioEntry, makeEsds()]));
  const mdia = makeBox('mdia', concat([makeHdlr('soun'), makeMdhd(timescale), makeBox('minf', makeBox('stbl', makeStsd(mp4a)))]));
  return makeBox('moov', makeBox('trak', mdia));
}

function buildRealFmp4({ fill = 7, fragmentCount = 3, moov, sampleSize = 4096 }) {
  const parts = [makeBox('ftyp', concat([fourCC('isom'), new Uint8Array([0, 0, 2, 0]), fourCC('isom')])), moov];
  for (let index = 0; index < fragmentCount; index++) {
    parts.push(makeMoof([sampleSize]));
    parts.push(makeBox('mdat', new Uint8Array(sampleSize).fill(fill)));
  }
  return concat(parts);
}

// ---------------------------------------------------------------
// 假 OPFS（内存文件系统）与假 fetch（支持 Range）
// ---------------------------------------------------------------

function createFakeOpfs() {
  const files = new Map();

  function createFile() {
    return { data: new Uint8Array(0), size: 0 };
  }

  function writeInto(file, position, chunk) {
    const end = position + chunk.byteLength;
    if (end > file.data.length) {
      const grown = new Uint8Array(Math.max(end, file.data.length * 2, 1024));
      grown.set(file.data.subarray(0, file.size), 0);
      file.data = grown;
    }
    file.data.set(chunk, position);
    file.size = Math.max(file.size, end);
  }

  const opfs = {
    _files: files,
    createOpfsSink: async ({ prefix = 'ovd' } = {}) => {
      const name = `${prefix}-${files.size + 1}`;
      const file = createFile();
      files.set(name, file);
      let closed = false;
      return {
        get byteLength() { return file.size; },
        mode: 'opfs',
        name,
        async finalize() {
          closed = true;
          return { byteLength: file.size, chunkCount: 1, mode: 'opfs', name };
        },
        async remove() {
          closed = true;
          files.delete(name);
        },
        async write(chunk) {
          if (closed) throw new Error('closed');
          writeInto(file, file.size, chunk);
        },
        async writeAt(position, chunk) {
          if (closed) throw new Error('closed');
          writeInto(file, position, chunk);
        },
      };
    },
    isSupported: () => true,
    readFile: async (name) => {
      const file = files.get(name);
      if (!file) return null;
      return {
        size: file.size,
        slice: (start, end) => ({
          arrayBuffer: async () => file.data.slice(start, Math.min(end, file.size)).buffer,
        }),
      };
    },
    removeFile: async (name) => files.delete(name),
  };

  return opfs;
}

function createRangeFetch(payloads) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const bytes = payloads[String(url)];
    requests.push({ headers: init.headers || {}, url: String(url) });
    if (!bytes) {
      return { headers: new Map([['content-range', 'bytes */0']]), ok: false, status: 404, statusText: 'Not Found' };
    }

    const range = String(init.headers?.Range || '');
    const match = range.match(/bytes=(\d+)-(\d+)/);
    const start = match ? Number(match[1]) : 0;
    const end = match ? Math.min(Number(match[2]), bytes.byteLength - 1) : bytes.byteLength - 1;

    if (start >= bytes.byteLength) {
      return {
        headers: { get: (name) => (name.toLowerCase() === 'content-range' ? `bytes */${bytes.byteLength}` : null) },
        ok: false,
        status: 416,
        statusText: 'Range Not Satisfiable',
      };
    }

    const slice = bytes.slice(start, end + 1);
    return {
      arrayBuffer: async () => slice.buffer,
      headers: {
        get: (name) => {
          const key = String(name).toLowerCase();
          if (key === 'content-range') return `bytes ${start}-${end}/${bytes.byteLength}`;
          if (key === 'content-length') return String(slice.byteLength);
          return null;
        },
      },
      ok: true,
      status: start === 0 && end === bytes.byteLength - 1 ? 200 : 206,
      statusText: 'Partial Content',
    };
  };
  return requests;
}

let importCounter = 0;

async function loadStreamingMerge() {
  globalThis.chrome = globalThis.chrome || {};
  importCounter += 1;
  return import(`${pathToFileURL(STREAMING_MERGE_PATH).href}?test=${importCounter}`);
}

function mockChromeForSave(calls = {}) {
  calls.downloads = calls.downloads || [];
  globalThis.chrome = {
    downloads: {
      download: (options, callback) => {
        calls.downloads.push(options);
        callback(calls.downloads.length);
      },
    },
    offscreen: { createDocument: async () => {}, hasDocument: async () => true },
    runtime: {
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
      getURL: (relative = '') => `chrome-extension://test/${relative}`,
      lastError: null,
      sendMessage: (message, callback) => {
        if (callback) {
          callback({ byteLength: 1024, filename: 'merged.mp4', objectUrl: 'blob:ovd-test', ok: true });
        }
      },
    },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } },
  };
  return calls;
}

test('downloadStreamToOpfs：按 Range 分块落盘，内存只留一个分块', async () => {
  const opfs = createFakeOpfs();
  globalThis.__OVD_OPFS_SINK__ = opfs;
  globalThis.__OVD_CONSTANTS__ = { STREAM_MERGE_CHUNK_BYTES: 1024 };

  const payload = new Uint8Array(4096).map((_value, index) => index % 256);
  const requests = createRangeFetch({ 'https://cdn.example.com/v.mp4': payload });

  try {
    const { downloadStreamToOpfs } = await loadStreamingMerge();
    const result = await downloadStreamToOpfs({
      headers: { Referer: 'https://www.youtube.com/watch?v=x' },
      label: 'video',
      prefix: 'test-video',
      url: 'https://cdn.example.com/v.mp4',
    });

    assert.equal(result.byteLength, payload.byteLength);
    assert.ok(requests.length >= 4, '应分多个 Range 请求下载');
    assert.match(String(requests[1].headers.Range), /^bytes=1024-/);

    const stored = opfs._files.get(result.name);
    assert.equal(stored.size, payload.byteLength);
    assert.deepEqual(Array.from(stored.data.slice(0, 8)), Array.from(payload.slice(0, 8)));
  } finally {
    delete globalThis.__OVD_OPFS_SINK__;
    delete globalThis.__OVD_CONSTANTS__;
    delete globalThis.fetch;
  }
});

test('流式合并：从 OPFS 读两路 fMP4，按片段喂 muxer 并落盘（可用 MP4）', async () => {
  const opfs = createFakeOpfs();
  globalThis.__OVD_OPFS_SINK__ = opfs;
  globalThis.__OVD_CONSTANTS__ = { STREAM_MERGE_CHUNK_BYTES: 64 * 1024 };

  const videoBytes = buildRealFmp4({ fill: 11, fragmentCount: 4, moov: makeVideoMoov(), sampleSize: 2048 });
  const audioBytes = buildRealFmp4({ fill: 22, fragmentCount: 5, moov: makeAudioMoov(), sampleSize: 512 });

  // 用假 fetch 把两路流"下载"进 OPFS（等同真实流程的第一步）
  createRangeFetch({
    'https://cdn.example.com/audio.m4a': audioBytes,
    'https://cdn.example.com/video.mp4': videoBytes,
  });

  const calls = mockChromeForSave();

  try {
    const { downloadStreamToOpfs, mergeOpfsStreamsAndDownload } = await loadStreamingMerge();
    const video = await downloadStreamToOpfs({ label: 'video', prefix: 'v', url: 'https://cdn.example.com/video.mp4' });
    const audio = await downloadStreamToOpfs({ label: 'audio', prefix: 'a', url: 'https://cdn.example.com/audio.m4a' });

    const progress = [];
    const result = await mergeOpfsStreamsAndDownload({
      audioName: audio.name,
      filename: 'merged.mp4',
      onProgress: (percent) => progress.push(percent),
      videoName: video.name,
    });

    assert.equal(result.ok, true);
    assert.equal(calls.downloads.length, 1, '合并结果应交给浏览器下载');
    assert.match(calls.downloads[0].url, /^blob:/);
    assert.equal(progress.at(-1), 100);

    // 合并输出应是一个含 moov 且双轨的 MP4
    const outputName = [...opfs._files.keys()].find((name) => name.startsWith('ovd-merged'));
    assert.ok(outputName, '应产出合并文件');
    const merged = opfs._files.get(outputName);
    const bytes = merged.data.slice(0, merged.size);
    const boxes = globalThis.BilibiliMuxer.__internals.parseBoxes(bytes.buffer);
    assert.ok(boxes.has('moov'), '输出应包含 moov');
    assert.ok(boxes.has('mdat'), '输出应包含 mdat');

    const moov = boxes.get('moov');
    const moovBoxes = globalThis.BilibiliMuxer.__internals.parseBoxes(bytes.buffer, moov.offset + 8, moov.offset + moov.size);
    const traks = moovBoxes.get('trak');
    assert.equal(Array.isArray(traks) ? traks.length : 1, 2, '合并结果应包含视频与音频两条轨道');
  } finally {
    delete globalThis.__OVD_OPFS_SINK__;
    delete globalThis.__OVD_CONSTANTS__;
    delete globalThis.fetch;
  }
});
