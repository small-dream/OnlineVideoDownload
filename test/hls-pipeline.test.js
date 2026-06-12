'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule() {
  const key = '__OVD_HLS_PIPELINE__';
  const filePath = path.resolve(__dirname, '../lib/hls-pipeline.js');
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[key];
}

// ---------------------------------------------------------------
// parseAttributeList
// ---------------------------------------------------------------

test('parseAttributeList parses quoted values', () => {
  const mod = loadModule();
  const result = mod.parseAttributeList('METHOD=AES-128,URI="https://example.com/key"');
  assert.equal(result.METHOD, 'AES-128');
  assert.equal(result.URI, 'https://example.com/key');
});

test('parseAttributeList parses unquoted values', () => {
  const mod = loadModule();
  const result = mod.parseAttributeList('BANDWIDTH=800000,RESOLUTION=1920x1080');
  assert.equal(result.BANDWIDTH, '800000');
  assert.equal(result.RESOLUTION, '1920x1080');
});

test('parseAttributeList parses multiple attributes', () => {
  const mod = loadModule();
  const result = mod.parseAttributeList('A="1",B=2,C="three"');
  assert.equal(result.A, '1');
  assert.equal(result.B, '2');
  assert.equal(result.C, 'three');
});

test('parseAttributeList returns {} for empty string', () => {
  const mod = loadModule();
  assert.deepEqual(mod.parseAttributeList(''), {});
});

test('parseAttributeList returns {} for null', () => {
  const mod = loadModule();
  assert.deepEqual(mod.parseAttributeList(null), {});
});

test('parseAttributeList returns {} for undefined', () => {
  const mod = loadModule();
  assert.deepEqual(mod.parseAttributeList(undefined), {});
});

// ---------------------------------------------------------------
// parseHlsIV
// ---------------------------------------------------------------

test('parseHlsIV converts hex string to 16-byte ArrayBuffer', () => {
  const mod = loadModule();
  const result = mod.parseHlsIV('0x0102030405060708090a0b0c0d0e0f10');
  const view = new Uint8Array(result);
  assert.equal(view.length, 16);
  assert.equal(view[0], 1);
  assert.equal(view[15], 16);
});

test('parseHlsIV strips "0x" prefix', () => {
  const mod = loadModule();
  const withPrefix = mod.parseHlsIV('0xAABBCCDD');
  const noPrefix = mod.parseHlsIV('AABBCCDD');
  const view1 = new Uint8Array(withPrefix);
  const view2 = new Uint8Array(noPrefix);
  assert.equal(view1[0], 0xAA);
  assert.equal(view2[0], 0xAA);
  assert.deepEqual(view1, view2);
});

test('parseHlsIV returns zero-filled ArrayBuffer for null', () => {
  const mod = loadModule();
  const result = mod.parseHlsIV(null);
  const view = new Uint8Array(result);
  assert.equal(view.length, 16);
  for (let i = 0; i < 16; i++) {
    assert.equal(view[i], 0);
  }
});

test('parseHlsIV returns zero-filled ArrayBuffer for empty string', () => {
  const mod = loadModule();
  const result = mod.parseHlsIV('');
  const view = new Uint8Array(result);
  for (let i = 0; i < 16; i++) {
    assert.equal(view[i], 0);
  }
});

test('parseHlsIV pads short hex to 16 bytes', () => {
  const mod = loadModule();
  const result = mod.parseHlsIV('FF');
  const view = new Uint8Array(result);
  assert.equal(view[0], 0xFF);
  assert.equal(view[1], 0);
  assert.equal(view[15], 0);
});

// ---------------------------------------------------------------
// resolveHlsUrl
// ---------------------------------------------------------------

test('resolveHlsUrl resolves relative URL against base', () => {
  const mod = loadModule();
  const result = mod.resolveHlsUrl('segment001.ts', 'https://cdn.example.com/video/index.m3u8');
  assert.equal(result, 'https://cdn.example.com/video/segment001.ts');
});

test('resolveHlsUrl passes through absolute URL', () => {
  const mod = loadModule();
  const result = mod.resolveHlsUrl('https://other.example.com/seg.ts', 'https://cdn.example.com/video/index.m3u8');
  assert.equal(result, 'https://other.example.com/seg.ts');
});

// ---------------------------------------------------------------
// parseHlsPlaylist
// ---------------------------------------------------------------

test('parseHlsPlaylist extracts segments from non-# lines', () => {
  const mod = loadModule();
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXTINF:10.0,',
    'segment001.ts',
    '#EXTINF:10.0,',
    'segment002.ts',
  ].join('\n');

  const result = mod.parseHlsPlaylist(m3u8, 'https://cdn.example.com/video/index.m3u8');
  assert.equal(result.segments.length, 2);
  assert.ok(result.segments[0].includes('segment001.ts'));
  assert.ok(result.segments[1].includes('segment002.ts'));
});

test('parseHlsPlaylist parses #EXT-X-MAP for init segment', () => {
  const mod = loadModule();
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:10.0,',
    'segment001.m4s',
  ].join('\n');

  const result = mod.parseHlsPlaylist(m3u8, 'https://cdn.example.com/video/index.m3u8');
  assert.ok(result.initSegmentUrl);
  assert.ok(result.initSegmentUrl.includes('init.mp4'));
});

test('parseHlsPlaylist skips blank lines', () => {
  const mod = loadModule();
  const m3u8 = '#EXTM3U\n\n\n#EXTINF:10.0,\nsegment001.ts\n\n';
  const result = mod.parseHlsPlaylist(m3u8, 'https://cdn.example.com/video/index.m3u8');
  assert.equal(result.segments.length, 1);
});

test('parseHlsPlaylist returns empty segments for empty string', () => {
  const mod = loadModule();
  const result = mod.parseHlsPlaylist('', 'https://cdn.example.com/video/index.m3u8');
  assert.equal(result.segments.length, 0);
  assert.equal(result.initSegmentUrl, null);
});

test('parseHlsPlaylist returns empty segments for null', () => {
  const mod = loadModule();
  const result = mod.parseHlsPlaylist(null, 'https://cdn.example.com/video/index.m3u8');
  assert.equal(result.segments.length, 0);
});

// ---------------------------------------------------------------
// selectBestHlsStream
// ---------------------------------------------------------------

test('selectBestHlsStream picks highest BANDWIDTH variant', () => {
  const mod = loadModule();
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360',
    'stream_360.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
    'stream_720.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480',
    'stream_480.m3u8',
  ].join('\n');

  const result = mod.selectBestHlsStream(master, 'https://cdn.example.com/master.m3u8');
  assert.ok(result.includes('stream_720.m3u8'));
});

test('selectBestHlsStream returns baseUrl when no stream-inf lines', () => {
  const mod = loadModule();
  const master = '#EXTM3U\n#EXT-X-VERSION:3';
  const result = mod.selectBestHlsStream(master, 'https://cdn.example.com/video.m3u8');
  assert.equal(result, 'https://cdn.example.com/video.m3u8');
});

// ---------------------------------------------------------------
// extFromUrl
// ---------------------------------------------------------------

test('extFromUrl extracts ".ts" extension', () => {
  const mod = loadModule();
  assert.equal(mod.extFromUrl('https://cdn.example.com/segment.ts'), '.ts');
});

test('extFromUrl extracts ".m4s" extension', () => {
  const mod = loadModule();
  assert.equal(mod.extFromUrl('https://cdn.example.com/segment.m4s'), '.m4s');
});

test('extFromUrl returns empty string when no extension', () => {
  const mod = loadModule();
  assert.equal(mod.extFromUrl('https://cdn.example.com/segment'), '');
});

// ---------------------------------------------------------------
// ensureExtension
// ---------------------------------------------------------------

test('ensureExtension appends extension', () => {
  const mod = loadModule();
  assert.equal(mod.ensureExtension('video', '.ts'), 'video.ts');
});

test('ensureExtension avoids double-extension', () => {
  const mod = loadModule();
  assert.equal(mod.ensureExtension('video.ts', '.ts'), 'video.ts');
});

test('ensureExtension uses "video" for empty filename', () => {
  const mod = loadModule();
  assert.equal(mod.ensureExtension('', '.mp4'), 'video.mp4');
});

test('ensureExtension uses "video" for whitespace-only filename', () => {
  const mod = loadModule();
  assert.equal(mod.ensureExtension('   ', '.mp4'), 'video.mp4');
});

// ---------------------------------------------------------------
// inferHlsOutputProfile
// ---------------------------------------------------------------

test('inferHlsOutputProfile returns mp4 profile for m4s segments', () => {
  const mod = loadModule();
  const playlist = {
    initSegmentUrl: null,
    segments: ['https://cdn.example.com/seg1.m4s', 'https://cdn.example.com/seg2.m4s'],
  };
  const result = mod.inferHlsOutputProfile(playlist);
  assert.equal(result.ext, '.mp4');
  assert.equal(result.mimeType, 'video/mp4');
});

test('inferHlsOutputProfile returns mp4 profile when initSegmentUrl is present', () => {
  const mod = loadModule();
  const playlist = {
    initSegmentUrl: 'https://cdn.example.com/init.mp4',
    segments: ['https://cdn.example.com/seg1.ts'],
  };
  const result = mod.inferHlsOutputProfile(playlist);
  assert.equal(result.ext, '.mp4');
  assert.equal(result.mimeType, 'video/mp4');
});

test('inferHlsOutputProfile returns ts profile for plain ts segments', () => {
  const mod = loadModule();
  const playlist = {
    initSegmentUrl: null,
    segments: ['https://cdn.example.com/seg1.ts', 'https://cdn.example.com/seg2.ts'],
  };
  const result = mod.inferHlsOutputProfile(playlist);
  assert.equal(result.ext, '.ts');
  assert.equal(result.mimeType, 'video/mp2t');
});
