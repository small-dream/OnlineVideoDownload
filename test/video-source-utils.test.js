'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule(globalKey, filePath) {
  delete globalThis[globalKey];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[globalKey];
}

const mod = () => loadModule('__OVD_VIDEO_SOURCE_UTILS__', path.resolve(__dirname, '../lib/video-source-utils.js'));

// --- getSourceId ---

test('getSourceId: youtube-adaptive returns "youtube"', () => {
  const { getSourceId } = mod();
  assert.equal(getSourceId({ type: 'youtube-adaptive' }), 'youtube');
});

test('getSourceId: bilibili-meta returns "bilibili"', () => {
  const { getSourceId } = mod();
  assert.equal(getSourceId({ type: 'bilibili-meta' }), 'bilibili');
});

test('getSourceId: bilibili-dash returns "bilibili"', () => {
  const { getSourceId } = mod();
  assert.equal(getSourceId({ type: 'bilibili-dash' }), 'bilibili');
});

test('getSourceId: blob returns "blob"', () => {
  const { getSourceId } = mod();
  assert.equal(getSourceId({ type: 'blob' }), 'blob');
});

test('getSourceId: dash returns "dash"', () => {
  const { getSourceId } = mod();
  assert.equal(getSourceId({ type: 'dash' }), 'dash');
});

test('getSourceId: telegram returns "telegram"', () => {
  const { getSourceId } = mod();
  assert.equal(getSourceId({ type: 'telegram' }), 'telegram');
});

test('getSourceId: direct returns "generic"', () => {
  const { getSourceId } = mod();
  assert.equal(getSourceId({ type: 'direct' }), 'generic');
});

test('getSourceId: audio returns "generic"', () => {
  const { getSourceId } = mod();
  assert.equal(getSourceId({ type: 'audio' }), 'generic');
});

test('getSourceId: empty type returns "generic"', () => {
  const { getSourceId } = mod();
  assert.equal(getSourceId({ type: '' }), 'generic');
});

test('getSourceId: no argument returns "generic"', () => {
  const { getSourceId } = mod();
  assert.equal(getSourceId(), 'generic');
});

test('getSourceId: undefined videoInfo returns "generic"', () => {
  const { getSourceId } = mod();
  assert.equal(getSourceId(undefined), 'generic');
});

// --- getExecutionMode ---

test('getExecutionMode: youtube returns "content"', () => {
  const { getExecutionMode } = mod();
  assert.equal(getExecutionMode({ type: 'youtube-adaptive' }), 'content');
});

test('getExecutionMode: youtube parse mode returns "background"', () => {
  const { getExecutionMode } = mod();
  assert.equal(getExecutionMode({ type: 'youtube-adaptive', downloadOptions: { mode: 'parse' } }), 'background');
});

test('getExecutionMode: youtube capture mode returns "content"', () => {
  const { getExecutionMode } = mod();
  assert.equal(getExecutionMode({ type: 'youtube-adaptive', downloadOptions: { mode: 'capture' } }), 'content');
});

test('getExecutionMode: youtube audio-only returns "background"', () => {
  const { getExecutionMode } = mod();
  assert.equal(
    getExecutionMode({ type: 'youtube-adaptive', downloadOptions: { audioOnly: true, mode: 'parse' } }),
    'background',
  );
});

test('getExecutionMode: youtube audio-only in capture mode also returns "background"', () => {
  const { getExecutionMode } = mod();
  assert.equal(
    getExecutionMode({ type: 'youtube-adaptive', downloadOptions: { audioOnly: true, mode: 'capture' } }),
    'background',
  );
});

test('getExecutionMode: bilibili audio-only stays "content" (needs page cookies)', () => {
  const { getExecutionMode } = mod();
  assert.equal(
    getExecutionMode({ type: 'bilibili-meta', downloadOptions: { audioOnly: true } }),
    'content',
  );
});

test('getExecutionMode: bilibili returns "content"', () => {
  const { getExecutionMode } = mod();
  assert.equal(getExecutionMode({ type: 'bilibili-meta' }), 'content');
});

test('getExecutionMode: blob returns "content"', () => {
  const { getExecutionMode } = mod();
  assert.equal(getExecutionMode({ type: 'blob' }), 'content');
});

test('getExecutionMode: dash returns "content"', () => {
  const { getExecutionMode } = mod();
  assert.equal(getExecutionMode({ type: 'dash' }), 'content');
});

test('getExecutionMode: telegram returns "content" (needs the page service worker)', () => {
  const { getExecutionMode } = mod();
  assert.equal(getExecutionMode({ type: 'telegram' }), 'content');
});

test('getExecutionMode: generic returns "background"', () => {
  const { getExecutionMode } = mod();
  assert.equal(getExecutionMode({ type: 'direct' }), 'background');
});

test('getExecutionMode: audio (generic) returns "background"', () => {
  const { getExecutionMode } = mod();
  assert.equal(getExecutionMode({ type: 'audio' }), 'background');
});

test('getExecutionMode: empty returns "background"', () => {
  const { getExecutionMode } = mod();
  assert.equal(getExecutionMode({}), 'background');
});

// --- buildTaskKey ---

test('buildTaskKey: youtube uses videoId', () => {
  const { buildTaskKey } = mod();
  assert.equal(
    buildTaskKey({ type: 'youtube-adaptive', videoId: 'abc123' }),
    'abc123',
  );
});

test('buildTaskKey: youtube falls back to url', () => {
  const { buildTaskKey } = mod();
  assert.equal(
    buildTaskKey({ type: 'youtube-adaptive', url: 'https://youtube.com/watch?v=xyz' }),
    'https://youtube.com/watch?v=xyz',
  );
});

test('buildTaskKey: bilibili uses bvid:cid', () => {
  const { buildTaskKey } = mod();
  assert.equal(
    buildTaskKey({ type: 'bilibili-meta', bvid: 'BV1xx', cid: 12345 }),
    'BV1xx:12345',
  );
});

test('buildTaskKey: bilibili falls back to aid:cid', () => {
  const { buildTaskKey } = mod();
  assert.equal(
    buildTaskKey({ type: 'bilibili-dash', aid: 999, cid: 555 }),
    '999:555',
  );
});

test('buildTaskKey: bilibili without cid uses "no-cid"', () => {
  const { buildTaskKey } = mod();
  assert.equal(
    buildTaskKey({ type: 'bilibili-meta', bvid: 'BV1xx' }),
    'BV1xx:no-cid',
  );
});

test('buildTaskKey: blob uses url', () => {
  const { buildTaskKey } = mod();
  assert.equal(
    buildTaskKey({ type: 'blob', url: 'blob:https://example.com/abc' }),
    'blob:https://example.com/abc',
  );
});

test('buildTaskKey: dash uses url', () => {
  const { buildTaskKey } = mod();
  assert.equal(
    buildTaskKey({ type: 'dash', url: 'https://example.com/manifest.mpd' }),
    'https://example.com/manifest.mpd',
  );
});

test('buildTaskKey: generic uses url', () => {
  const { buildTaskKey } = mod();
  assert.equal(
    buildTaskKey({ type: 'direct', url: 'https://example.com/video.mp4' }),
    'https://example.com/video.mp4',
  );
});

test('buildTaskKey: generic falls back to title', () => {
  const { buildTaskKey } = mod();
  assert.equal(buildTaskKey({ type: 'direct', title: 'My Video' }), 'My Video');
});

// --- getSourceLabel ---

test('getSourceLabel: youtube returns "YouTube"', () => {
  const { getSourceLabel } = mod();
  assert.equal(getSourceLabel({ type: 'youtube-adaptive' }), 'YouTube');
});

test('getSourceLabel: bilibili returns "Bilibili"', () => {
  const { getSourceLabel } = mod();
  assert.equal(getSourceLabel({ type: 'bilibili-meta' }), 'Bilibili');
});

test('getSourceLabel: bilibili-dash returns "Bilibili"', () => {
  const { getSourceLabel } = mod();
  assert.equal(getSourceLabel({ type: 'bilibili-dash' }), 'Bilibili');
});

test('getSourceLabel: blob returns "Blob"', () => {
  const { getSourceLabel } = mod();
  assert.equal(getSourceLabel({ type: 'blob' }), 'Blob');
});

test('getSourceLabel: dash returns "DASH"', () => {
  const { getSourceLabel } = mod();
  assert.equal(getSourceLabel({ type: 'dash' }), 'DASH');
});

test('getSourceLabel: generic with audio type returns "Audio"', () => {
  const { getSourceLabel } = mod();
  assert.equal(getSourceLabel({ type: 'audio' }), 'Audio');
});

test('getSourceLabel: generic with direct type returns "Video"', () => {
  const { getSourceLabel } = mod();
  assert.equal(getSourceLabel({ type: 'direct' }), 'Video');
});

test('getSourceLabel: empty type returns "Video"', () => {
  const { getSourceLabel } = mod();
  assert.equal(getSourceLabel({ type: '' }), 'Video');
});

// --- findBlobFallbackVideo ---

test('findBlobFallbackVideo: 非 blob 条目不做替换', () => {
  const { findBlobFallbackVideo } = mod();
  assert.equal(
    findBlobFallbackVideo(
      { type: 'direct', url: 'https://cdn.example.com/v.mp4' },
      [{ type: 'hls', url: 'https://cdn.example.com/index.m3u8' }],
    ),
    null,
  );
});

test('findBlobFallbackVideo: 同 frame + 同标题的清单优先', () => {
  const { findBlobFallbackVideo } = mod();
  const fallback = findBlobFallbackVideo(
    { frameId: 2, title: '正片', type: 'blob', url: 'blob:https://example.com/a' },
    [
      { frameId: 0, title: '正片', type: 'hls', url: 'https://cdn.example.com/main.m3u8' },
      { frameId: 2, title: '正片', type: 'hls', url: 'https://cdn.example.com/player.m3u8' },
    ],
  );
  assert.equal(fallback.url, 'https://cdn.example.com/player.m3u8');
});

test('findBlobFallbackVideo: 同标题优先于同 frame（避免借到同 frame 的广告清单）', () => {
  const { findBlobFallbackVideo } = mod();
  const fallback = findBlobFallbackVideo(
    { frameId: 2, title: '正片', type: 'blob', url: 'blob:https://example.com/a' },
    [
      { frameId: 2, title: '广告', type: 'hls', url: 'https://cdn.example.com/ad.m3u8' },
      { frameId: 0, title: '正片', type: 'hls', url: 'https://cdn.example.com/main.m3u8' },
    ],
  );
  assert.equal(fallback.url, 'https://cdn.example.com/main.m3u8');
});

test('findBlobFallbackVideo: 没有同标题候选时退回同 frame', () => {
  const { findBlobFallbackVideo } = mod();
  const fallback = findBlobFallbackVideo(
    { frameId: 2, title: '正片', type: 'blob', url: 'blob:https://example.com/a' },
    [
      { frameId: 2, timestamp: 10, title: '广告', type: 'hls', url: 'https://cdn.example.com/ad.m3u8' },
      { frameId: 0, title: '别的视频', type: 'hls', url: 'https://cdn.example.com/other.m3u8' },
    ],
  );
  assert.equal(fallback.url, 'https://cdn.example.com/ad.m3u8');
});

test('findBlobFallbackVideo: 跨 frame 时按标题匹配', () => {
  const { findBlobFallbackVideo } = mod();
  const fallback = findBlobFallbackVideo(
    { frameId: 3, title: '  Movie  ', type: 'blob', url: 'blob:https://example.com/a' },
    [
      { frameId: 0, title: 'movie', type: 'dash', url: 'https://cdn.example.com/main.mpd' },
      { frameId: 0, title: 'other', type: 'hls', url: 'https://cdn.example.com/other.m3u8' },
    ],
  );
  assert.equal(fallback.url, 'https://cdn.example.com/main.mpd');
});

test('findBlobFallbackVideo: 跨 frame 且标题对不上时只在全页唯一候选时借用', () => {
  const { findBlobFallbackVideo } = mod();
  const blob = { frameId: 3, title: '主视频', type: 'blob', url: 'blob:https://example.com/a' };

  assert.equal(
    findBlobFallbackVideo(blob, [
      { frameId: 0, title: '别的视频', type: 'hls', url: 'https://cdn.example.com/other.m3u8' },
      { frameId: 0, title: '另一个', type: 'dash', url: 'https://cdn.example.com/other.mpd' },
    ]),
    null,
  );
  assert.equal(
    findBlobFallbackVideo(blob, [
      { frameId: 0, title: '别的视频', type: 'hls', url: 'https://cdn.example.com/other.m3u8' },
    ]).url,
    'https://cdn.example.com/other.m3u8',
  );
});

test('findBlobFallbackVideo: 没有清单类候选时返回 null', () => {
  const { findBlobFallbackVideo } = mod();
  assert.equal(
    findBlobFallbackVideo(
      { frameId: 0, type: 'blob', url: 'blob:https://example.com/a' },
      [{ type: 'direct', url: 'https://cdn.example.com/v.mp4' }],
    ),
    null,
  );
});

// --- dropShadowedMseBlobs ---

test('dropShadowedMseBlobs: 同页有清单时隐藏 MSE blob 行', () => {
  const { dropShadowedMseBlobs } = mod();
  const hls = { frameId: 1, title: '正片', type: 'hls', url: 'https://cdn.example.com/main.m3u8' };
  const result = dropShadowedMseBlobs([
    { frameId: 1, mse: true, title: '正片', type: 'blob', url: 'blob:https://example.com/mse' },
    hls,
  ]);
  assert.deepEqual(result, [hls]);
});

test('dropShadowedMseBlobs: 没有清单 / 普通 Blob / 未知类型时保留', () => {
  const { dropShadowedMseBlobs } = mod();
  const mseNoManifest = { frameId: 1, mse: true, title: 'A', type: 'blob', url: 'blob:https://example.com/a' };
  const plainBlob = { frameId: 1, mse: false, title: 'B', type: 'blob', url: 'blob:https://example.com/b' };
  const unknownBlob = { frameId: 1, title: 'C', type: 'blob', url: 'blob:https://example.com/c' };

  assert.deepEqual(
    dropShadowedMseBlobs([mseNoManifest, plainBlob, unknownBlob, { type: 'direct', url: 'https://cdn.example.com/v.mp4' }]),
    [mseNoManifest, plainBlob, unknownBlob, { type: 'direct', url: 'https://cdn.example.com/v.mp4' }],
  );
});

test('dropShadowedMseBlobs: 普通 Blob 不因存在清单而被隐藏', () => {
  const { dropShadowedMseBlobs } = mod();
  const plainBlob = { frameId: 1, mse: false, title: '正片', type: 'blob', url: 'blob:https://example.com/blob' };
  const hls = { frameId: 1, title: '正片', type: 'hls', url: 'https://cdn.example.com/main.m3u8' };
  assert.deepEqual(dropShadowedMseBlobs([plainBlob, hls]), [plainBlob, hls]);
});

test('dropShadowedMseBlobs: 跨 frame 有多个候选时保守保留（避免隐藏错视频）', () => {
  const { dropShadowedMseBlobs } = mod();
  const blob = { frameId: 3, mse: true, title: '正片', type: 'blob', url: 'blob:https://example.com/mse' };
  const otherHls = { frameId: 0, title: '广告', type: 'hls', url: 'https://cdn.example.com/ad.m3u8' };
  const otherDash = { frameId: 5, title: '其它', type: 'dash', url: 'https://cdn.example.com/other.mpd' };
  assert.deepEqual(dropShadowedMseBlobs([blob, otherHls, otherDash]), [blob, otherHls, otherDash]);
});

test('dropShadowedMseBlobs: 跨 frame 但全页只有一个清单候选时隐藏', () => {
  const { dropShadowedMseBlobs } = mod();
  const blob = { frameId: 3, mse: true, title: '正片', type: 'blob', url: 'blob:https://example.com/mse' };
  const hls = { frameId: 0, title: '正片', type: 'hls', url: 'https://cdn.example.com/main.m3u8' };
  assert.deepEqual(dropShadowedMseBlobs([blob, hls]), [hls]);
});
