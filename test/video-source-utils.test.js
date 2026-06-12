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
