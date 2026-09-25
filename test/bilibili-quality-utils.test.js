'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule() {
  const key = '__OVD_BILIBILI_QUALITY_UTILS__';
  const filePath = path.resolve(__dirname, '../lib/bilibili-quality-utils.js');
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[key];
}

test('BILIBILI_QUALITY_LABELS is a frozen object with common entries', () => {
  const mod = loadModule();
  const labels = mod.BILIBILI_QUALITY_LABELS;

  assert.equal(Object.isFrozen(labels), true);
  assert.equal(labels[80], '1080P');
  assert.equal(labels[64], '720P');
  assert.equal(labels[32], '480P');
  assert.equal(labels[16], '360P');
});

// ---------------------------------------------------------------
// listBilibiliStreamUrls（主地址 + 备用 CDN 回退，见 B 站下载 Failed to fetch 修复）
// ---------------------------------------------------------------

test('listBilibiliStreamUrls 返回 baseUrl 与 backupUrl（保持优先级）', () => {
  const { listBilibiliStreamUrls } = loadModule();
  const urls = listBilibiliStreamUrls({
    backupUrl: ['https://upos-sz-mirrorcoso1.bilivideo.com/a.m4s', 'https://cn-hnzz-cm-01-03.bilivideo.com/a.m4s'],
    baseUrl: 'https://xy106x227x71x161xy.mcdn.bilivideo.cn:8082/a.m4s',
  });

  assert.deepEqual(urls, [
    'https://xy106x227x71x161xy.mcdn.bilivideo.cn:8082/a.m4s',
    'https://upos-sz-mirrorcoso1.bilivideo.com/a.m4s',
    'https://cn-hnzz-cm-01-03.bilivideo.com/a.m4s',
  ]);
});

test('listBilibiliStreamUrls 兼容下划线字段并去重', () => {
  const { listBilibiliStreamUrls } = loadModule();
  const urls = listBilibiliStreamUrls({
    backup_url: ['https://backup.bilivideo.com/a.m4s'],
    base_url: 'https://backup.bilivideo.com/a.m4s',
  });

  assert.deepEqual(urls, ['https://backup.bilivideo.com/a.m4s']);
});

test('listBilibiliStreamUrls 过滤空值与非法协议', () => {
  const { listBilibiliStreamUrls } = loadModule();
  const urls = listBilibiliStreamUrls({
    backupUrl: ['', 'blob:https://example.com/x', 'https://ok.bilivideo.com/a.m4s'],
    baseUrl: '  ',
  });

  assert.deepEqual(urls, ['https://ok.bilivideo.com/a.m4s']);
});

test('listBilibiliStreamUrls 对缺失/异常输入返回空数组', () => {
  const { listBilibiliStreamUrls } = loadModule();
  assert.deepEqual(listBilibiliStreamUrls(), []);
  assert.deepEqual(listBilibiliStreamUrls({}), []);
  assert.deepEqual(listBilibiliStreamUrls({ backupUrl: 'not-an-array', baseUrl: 42 }), []);
});

// ---------------------------------------------------------------
// listAvailableBilibiliQualities
// ---------------------------------------------------------------

test('listAvailableBilibiliQualities deduplicates by id', () => {
  const mod = loadModule();
  const result = mod.listAvailableBilibiliQualities([
    { id: 80, baseUrl: 'a' },
    { id: 80, baseUrl: 'b' },
    { id: 64, baseUrl: 'c' },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 80);
  assert.equal(result[1].id, 64);
});

test('listAvailableBilibiliQualities sorts descending by id', () => {
  const mod = loadModule();
  const result = mod.listAvailableBilibiliQualities([
    { id: 16 },
    { id: 80 },
    { id: 32 },
  ]);
  assert.deepEqual(result.map((q) => q.id), [80, 32, 16]);
});

test('listAvailableBilibiliQualities uses ${id}P label for unknown ids', () => {
  const mod = loadModule();
  const result = mod.listAvailableBilibiliQualities([{ id: 999 }]);
  assert.equal(result[0].label, '999P');
});

test('listAvailableBilibiliQualities uses known label for standard ids', () => {
  const mod = loadModule();
  const result = mod.listAvailableBilibiliQualities([{ id: 80 }]);
  assert.equal(result[0].label, '1080P');
});

test('listAvailableBilibiliQualities returns [] for empty array', () => {
  const mod = loadModule();
  assert.deepEqual(mod.listAvailableBilibiliQualities([]), []);
});

test('listAvailableBilibiliQualities returns [] for null', () => {
  const mod = loadModule();
  assert.deepEqual(mod.listAvailableBilibiliQualities(null), []);
});

test('listAvailableBilibiliQualities returns [] for non-array', () => {
  const mod = loadModule();
  assert.deepEqual(mod.listAvailableBilibiliQualities('bad'), []);
  assert.deepEqual(mod.listAvailableBilibiliQualities(42), []);
  assert.deepEqual(mod.listAvailableBilibiliQualities(undefined), []);
});

test('listAvailableBilibiliQualities skips streams with id == null', () => {
  const mod = loadModule();
  const result = mod.listAvailableBilibiliQualities([
    { id: null },
    { id: undefined },
    { id: 80 },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 80);
});

// ---------------------------------------------------------------
// pickBilibiliVideoStream
// ---------------------------------------------------------------

test('pickBilibiliVideoStream returns first for "auto"', () => {
  const mod = loadModule();
  const streams = [{ id: 80 }, { id: 64 }, { id: 32 }];
  assert.equal(mod.pickBilibiliVideoStream(streams, 'auto'), streams[0]);
});

test('pickBilibiliVideoStream returns first for null target', () => {
  const mod = loadModule();
  const streams = [{ id: 80 }, { id: 64 }];
  assert.equal(mod.pickBilibiliVideoStream(streams, null), streams[0]);
});

test('pickBilibiliVideoStream returns first for undefined target', () => {
  const mod = loadModule();
  const streams = [{ id: 80 }, { id: 64 }];
  assert.equal(mod.pickBilibiliVideoStream(streams, undefined), streams[0]);
});

test('pickBilibiliVideoStream exact match by id', () => {
  const mod = loadModule();
  const streams = [{ id: 80 }, { id: 64 }, { id: 32 }];
  const picked = mod.pickBilibiliVideoStream(streams, 64);
  assert.equal(picked.id, 64);
});

test('pickBilibiliVideoStream fallback when id not found', () => {
  const mod = loadModule();
  const streams = [{ id: 80 }, { id: 64 }];
  const picked = mod.pickBilibiliVideoStream(streams, 16);
  assert.equal(picked.id, 80);
});

test('pickBilibiliVideoStream returns null for empty array', () => {
  const mod = loadModule();
  assert.equal(mod.pickBilibiliVideoStream([], 80), null);
});

test('pickBilibiliVideoStream returns null for non-array', () => {
  const mod = loadModule();
  assert.equal(mod.pickBilibiliVideoStream(null, 80), null);
  assert.equal(mod.pickBilibiliVideoStream(undefined, 80), null);
});

// ---------------------------------------------------------------
// pickBilibiliAudioStream
// ---------------------------------------------------------------

test('pickBilibiliAudioStream returns first element', () => {
  const mod = loadModule();
  const streams = [{ id: 30280 }, { id: 30232 }];
  assert.equal(mod.pickBilibiliAudioStream(streams), streams[0]);
});

test('pickBilibiliAudioStream returns null for empty array', () => {
  const mod = loadModule();
  assert.equal(mod.pickBilibiliAudioStream([]), null);
});

test('pickBilibiliAudioStream returns null for null', () => {
  const mod = loadModule();
  assert.equal(mod.pickBilibiliAudioStream(null), null);
});

test('pickBilibiliAudioStream returns null for undefined', () => {
  const mod = loadModule();
  assert.equal(mod.pickBilibiliAudioStream(undefined), null);
});

// ---------------------------------------------------------------
// estimateBilibiliDownloadSize
// ---------------------------------------------------------------

test('estimateBilibiliDownloadSize sums selected video and audio content length', () => {
  const mod = loadModule();
  const result = mod.estimateBilibiliDownloadSize(
    {
      audio: [
        { id: 30280, contentLength: 7000000, baseUrl: 'https://example.com/a.m4s' },
      ],
      video: [
        { id: 64, contentLength: 120000000, baseUrl: 'https://example.com/v64.m4s' },
        { id: 80, contentLength: 200000000, baseUrl: 'https://example.com/v80.m4s' },
      ],
    },
    { qualityId: 64 },
  );

  assert.equal(result.kind, 'dash');
  assert.equal(result.bytes, 127000000);
});

test('buildBilibiliSelectionSnapshot includes selected size fields', () => {
  const mod = loadModule();
  const snapshot = mod.buildBilibiliSelectionSnapshot(
    {
      audio: [{ id: 30280, contentLength: 7000000, baseUrl: 'https://example.com/a.m4s' }],
      video: [{ id: 80, contentLength: 200000000, baseUrl: 'https://example.com/v80.m4s' }],
    },
    { qualityId: 80 },
  );

  assert.equal(snapshot.selectedSizeKind, 'dash');
  assert.equal(snapshot.selectedSizeBytes, 207000000);
});
