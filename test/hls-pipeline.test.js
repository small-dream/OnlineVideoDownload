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
  assert.ok(result.segments[0].url.includes('segment001.ts'));
  assert.ok(result.segments[1].url.includes('segment002.ts'));
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

// ---------------------------------------------------------------
// hlsFetchText / hlsFetchBuffer 凭证模式
// ---------------------------------------------------------------

test('hlsFetchText passes headers and credentials to fetch', async () => {
  const mod = loadModule();
  const seen = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    seen.push({ init, url });
    return { ok: true, status: 200, text: async () => '#EXTM3U\n' };
  };

  try {
    const text = await mod.hlsFetchText(
      'https://cdn.example.com/index.m3u8',
      { Referer: 'https://movie.example.com/' },
      { credentials: 'include' }
    );

    assert.equal(text, '#EXTM3U\n');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init.credentials, 'include');
    assert.deepEqual(seen[0].init.headers, { Referer: 'https://movie.example.com/' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hlsFetchText omits credentials when options are not provided', async () => {
  const mod = loadModule();
  const seen = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    seen.push({ init, url });
    return { ok: true, status: 200, text: async () => '#EXTM3U\n' };
  };

  try {
    await mod.hlsFetchText('https://cdn.example.com/index.m3u8', {});
    assert.equal('credentials' in seen[0].init, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hlsFetchBuffer retries without credentials when CORS rejects the credentialed request', async () => {
  const mod = loadModule();
  const attempts = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    attempts.push(init);
    if (init.credentials) {
      throw new TypeError('Failed to fetch');
    }
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  };

  try {
    const buffer = await mod.hlsFetchBuffer(
      'https://cdn.example.com/segment001.ts',
      { Referer: 'https://movie.example.com/' },
      { credentials: 'include' }
    );

    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].credentials, 'include');
    assert.equal('credentials' in attempts[1], false);
    assert.deepEqual(attempts[1].headers, { Referer: 'https://movie.example.com/' });
    assert.equal(buffer.byteLength, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('parseHlsEncryption forwards fetch options to the key request', async () => {
  const mod = loadModule();
  const seen = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    seen.push({ init, url });
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(16).buffer };
  };

  try {
    const keyInfo = await mod.parseHlsEncryption(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:1,\nseg.ts',
      'https://cdn.example.com/video/index.m3u8',
      {},
      { credentials: 'include' }
    );

    assert.ok(keyInfo);
    assert.equal(seen[0].url, 'https://cdn.example.com/video/key.bin');
    assert.equal(seen[0].init.credentials, 'include');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------
// parseHlsEncryption fail-fast
// ---------------------------------------------------------------

test('parseHlsEncryption returns null for METHOD=NONE', async () => {
  const mod = loadModule();
  const result = await mod.parseHlsEncryption(
    '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\nseg.ts',
    'https://cdn.example.com/video/index.m3u8',
    {}
  );
  assert.equal(result, null);
});

test('parseHlsEncryption throws HLS_UNSUPPORTED_ENCRYPTION for SAMPLE-AES', async () => {
  const mod = loadModule();
  await assert.rejects(
    () => mod.parseHlsEncryption(
      '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"\n#EXTINF:1,\nseg.ts',
      'https://cdn.example.com/video/index.m3u8',
      {}
    ),
    (err) => {
      assert.equal(err.code, 'HLS_UNSUPPORTED_ENCRYPTION');
      assert.match(err.message, /SAMPLE-AES/);
      return true;
    }
  );
});

test('parseHlsEncryption throws HLS_KEY_FETCH_FAILED when AES-128 key URI is missing', async () => {
  const mod = loadModule();
  await assert.rejects(
    () => mod.parseHlsEncryption(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:1,\nseg.ts',
      'https://cdn.example.com/video/index.m3u8',
      {}
    ),
    (err) => {
      assert.equal(err.code, 'HLS_KEY_FETCH_FAILED');
      return true;
    }
  );
});

test('parseHlsEncryption throws HLS_KEY_FETCH_FAILED when the key request fails', async () => {
  const mod = loadModule();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({ ok: false, status: 403 });

  try {
    await assert.rejects(
      () => mod.parseHlsEncryption(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:1,\nseg.ts',
        'https://cdn.example.com/video/index.m3u8',
        {}
      ),
      (err) => {
        assert.equal(err.code, 'HLS_KEY_FETCH_FAILED');
        assert.match(err.message, /HTTP 403/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------
// decryptHlsSegments fail-fast
// ---------------------------------------------------------------

function importAesKey(usages) {
  return crypto.subtle.importKey('raw', new Uint8Array(16).fill(7), { name: 'AES-CBC' }, false, usages);
}

test('decryptHlsSegments decrypts AES-128-CBC buffers', async () => {
  const mod = loadModule();
  const key = await importAesKey(['encrypt', 'decrypt']);
  const iv = new Uint8Array(16).fill(3).buffer;
  const plain = new Uint8Array(32).fill(9).buffer;
  const cipher = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plain);

  const result = await mod.decryptHlsSegments([cipher], { iv, key });
  assert.deepEqual(new Uint8Array(result[0]), new Uint8Array(plain));
});

test('decryptHlsSegments throws HLS_SEGMENT_DECRYPT_FAILED instead of falling back to ciphertext', async () => {
  const mod = loadModule();
  const key = await importAesKey(['decrypt']);
  // 长度不是 16 的倍数，AES-CBC 解密必失败
  const corrupted = new Uint8Array(7).buffer;

  await assert.rejects(
    () => mod.decryptHlsSegments([corrupted], { iv: new Uint8Array(16).buffer, key }),
    (err) => {
      assert.equal(err.code, 'HLS_SEGMENT_DECRYPT_FAILED');
      assert.equal(err.segmentIndex, 0);
      return true;
    }
  );
});

// ---------------------------------------------------------------
// downloadHlsSegments 重试与阈值中止
// ---------------------------------------------------------------

function segmentUrls(count) {
  return Array.from({ length: count }, (_, i) => `https://cdn.example.com/seg${i}.ts`);
}

test('downloadHlsSegments retries a failed segment and succeeds', async () => {
  const mod = loadModule();
  let attempts = 0;

  const result = await mod.downloadHlsSegments(segmentUrls(2), {
    fetchBuffer: async (url) => {
      if (url.includes('seg1')) {
        attempts++;
        if (attempts < 3) {
          throw new Error('HTTP 500');
        }
      }
      return new Uint8Array(4).buffer;
    },
    retryDelays: [0, 0, 0],
  });

  assert.equal(attempts, 3);
  assert.equal(result.failedCount, 0);
  assert.equal(result.retriedCount, 1);
  assert.equal(result.buffers[1].byteLength, 4);
});

test('downloadHlsSegments gives up after 3 retries and counts the failure', async () => {
  const mod = loadModule();
  let attempts = 0;

  // 20 个分片允许最多 2 个失败，此处仅 1 个彻底失败，不中止
  const result = await mod.downloadHlsSegments(segmentUrls(20), {
    fetchBuffer: async (url) => {
      if (url.includes('seg0.ts')) {
        attempts++;
        throw new Error('HTTP 500');
      }
      return new Uint8Array(2).buffer;
    },
    retryDelays: [0, 0, 0],
  });

  assert.equal(attempts, 4);
  assert.equal(result.failedCount, 1);
  assert.equal(result.buffers[0].byteLength, 0);
  assert.equal(result.buffers[1].byteLength, 2);
});

test('downloadHlsSegments aborts when the failure ratio exceeds the threshold', async () => {
  const mod = loadModule();

  // 20 个分片阈值 floor(20*0.1)=2，3 个失败必须中止
  await assert.rejects(
    () => mod.downloadHlsSegments(segmentUrls(20), {
      fetchBuffer: async (url) => {
        if (/seg[0-2]\.ts/.test(url)) {
          throw new Error('HTTP 500');
        }
        return new Uint8Array(2).buffer;
      },
      retryDelays: [0, 0, 0],
    }),
    (err) => {
      assert.equal(err.code, 'HLS_SEGMENT_DOWNLOAD_FAILED');
      assert.equal(err.failedCount, 3);
      assert.equal(err.totalSegments, 20);
      assert.match(err.message, /3\/20/);
      return true;
    }
  );
});

test('downloadHlsSegments aborts on any failure when there are at most 10 segments', async () => {
  const mod = loadModule();

  await assert.rejects(
    () => mod.downloadHlsSegments(segmentUrls(5), {
      fetchBuffer: async (url) => {
        if (url.includes('seg4')) {
          throw new Error('HTTP 404');
        }
        return new Uint8Array(2).buffer;
      },
      retryDelays: [0, 0, 0],
    }),
    (err) => {
      assert.equal(err.code, 'HLS_SEGMENT_DOWNLOAD_FAILED');
      assert.match(err.message, /1\/5/);
      return true;
    }
  );
});

test('downloadHlsSegments reports progress with failure stats below the threshold', async () => {
  const mod = loadModule();
  const progress = [];

  const result = await mod.downloadHlsSegments(segmentUrls(20), {
    fetchBuffer: async (url) => {
      if (url.includes('seg0.ts') || url.includes('seg1.ts')) {
        throw new Error('HTTP 500');
      }
      return new Uint8Array(2).buffer;
    },
    onProgress: (done, total, stats) => progress.push({ done, total, ...stats }),
    retryDelays: [0, 0, 0],
  });

  assert.equal(result.failedCount, 2);
  assert.equal(progress.length, 20);
  assert.equal(progress.at(-1).done, 20);
  assert.equal(progress.at(-1).total, 20);
  assert.equal(progress.at(-1).failedCount, 2);
});

// ---------------------------------------------------------------
// 第三波 3.1：Master Playlist 画质
// ---------------------------------------------------------------

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="中文",LANGUAGE="zh",DEFAULT=YES,URI="audio/main.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.42c01e"',
  'stream_360.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f",AUDIO="aud"',
  'stream_720.m3u8',
].join('\n');

test('parseHlsMasterPlaylist lists variants with resolution and bandwidth', () => {
  const mod = loadModule();
  const master = mod.parseHlsMasterPlaylist(MASTER_PLAYLIST, 'https://cdn.example.com/master.m3u8');

  assert.equal(master.isMaster, true);
  assert.equal(master.variants.length, 2);
  assert.deepEqual(master.variants.map((variant) => variant.label), ['360p', '720p']);
  assert.equal(master.variants[1].url, 'https://cdn.example.com/stream_720.m3u8');
  assert.equal(master.variants[1].audioGroupId, 'aud');
  assert.equal(master.audioRenditions.length, 1);
  assert.equal(mod.findMatchingAudioRendition(master, master.variants[1]).uri,
    'https://cdn.example.com/audio/main.m3u8');
  assert.equal(mod.findMatchingAudioRendition(master, master.variants[0]), null);
});

test('selectHlsVariant honours quality labels, heights and falls back to the highest bandwidth', () => {
  const mod = loadModule();
  const master = mod.parseHlsMasterPlaylist(MASTER_PLAYLIST, 'https://cdn.example.com/master.m3u8');

  assert.equal(mod.selectHlsVariant(master.variants, null, { quality: '360p' }).height, 360);
  assert.equal(mod.selectHlsVariant(master.variants, null, { quality: '720' }).height, 720);
  assert.equal(
    mod.selectHlsVariant(master.variants, null, { quality: 'https://cdn.example.com/stream_360.m3u8' }).height,
    360
  );
  assert.equal(mod.selectHlsVariant(master.variants, null, {}).height, 720);
  assert.equal(mod.selectHlsVariant(master.variants, null, { quality: '1080p' }).height, 720);
});

test('selectBestHlsStream still returns the highest bandwidth variant', () => {
  const mod = loadModule();
  const url = mod.selectBestHlsStream(MASTER_PLAYLIST, 'https://cdn.example.com/master.m3u8');
  assert.ok(url.includes('stream_720.m3u8'));
});

// ---------------------------------------------------------------
// 第三波 3.2：Media Playlist 协议补全
// ---------------------------------------------------------------

test('parseHlsPlaylist records EXT-X-BYTERANGE with implicit offsets', () => {
  const mod = loadModule();
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
    '#EXTINF:5.0,',
    '#EXT-X-BYTERANGE:1000@0',
    'video.mp4',
    '#EXTINF:5.0,',
    '#EXT-X-BYTERANGE:1000',
    'video.mp4',
  ].join('\n');

  const playlist = mod.parseHlsPlaylist(m3u8, 'https://cdn.example.com/index.m3u8');
  assert.deepEqual(playlist.initSegmentByteRange, { end: 719, length: 720, start: 0 });
  assert.deepEqual(playlist.segments[0].byteRange, { end: 999, length: 1000, start: 0 });
  assert.deepEqual(playlist.segments[1].byteRange, { end: 1999, length: 1000, start: 1000 });
  assert.equal(mod.toRangeHeader(playlist.segments[1].byteRange), 'bytes=1000-1999');
});

test('parseHlsPlaylist tracks EXT-X-KEY rotation per segment', () => {
  const mod = loadModule();
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key1.bin"',
    '#EXTINF:5.0,',
    'seg1.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="key2.bin",IV=0x0102030405060708090A0B0C0D0E0F10',
    '#EXTINF:5.0,',
    'seg2.ts',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:5.0,',
    'seg3.ts',
  ].join('\n');

  const playlist = mod.parseHlsPlaylist(m3u8, 'https://cdn.example.com/index.m3u8');
  assert.equal(playlist.keys.length, 2);
  assert.equal(playlist.keys[0].keyUrl, 'https://cdn.example.com/key1.bin');
  assert.equal(playlist.keys[1].ivHex, '0x0102030405060708090A0B0C0D0E0F10');
  assert.deepEqual(playlist.segments.map((segment) => segment.keyIndex), [0, 1, null]);
  assert.equal(playlist.isEncrypted, true);
});

test('resolveHlsKeys imports every rotated AES-128 key', async () => {
  const mod = loadModule();
  const requested = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    requested.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(16).fill(9).buffer };
  };

  try {
    const keys = await mod.resolveHlsKeys([
      { ivHex: '', keyUrl: 'https://cdn.example.com/key1.bin', method: 'AES-128' },
      { ivHex: '0x00', keyUrl: 'https://cdn.example.com/key2.bin', method: 'AES-128' },
    ], {}, {});

    assert.equal(keys.length, 2);
    assert.deepEqual(requested, [
      'https://cdn.example.com/key1.bin',
      'https://cdn.example.com/key2.bin',
    ]);
    assert.ok(keys[0].key);
    assert.equal(keys[0].explicitIv, false);
    assert.equal(keys[0].iv, null);
    assert.equal(keys[1].explicitIv, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveHlsKeys throws for SAMPLE-AES instead of producing garbage', async () => {
  const mod = loadModule();
  await assert.rejects(
    () => mod.resolveHlsKeys([{ keyUrl: 'https://cdn.example.com/key.bin', method: 'SAMPLE-AES' }], {}, {}),
    (err) => {
      assert.equal(err.code, 'HLS_UNSUPPORTED_ENCRYPTION');
      return true;
    }
  );
});

test('decryptHlsSegments derives IV from the media sequence and skips unencrypted segments', async () => {
  const mod = loadModule();
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(16).fill(5),
    { name: 'AES-CBC' },
    false,
    ['encrypt', 'decrypt']
  );

  const sequence = 7;
  const plain = new Uint8Array(16).fill(1).buffer;
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: mod.ivFromSequence(sequence) },
    key,
    plain
  );
  const plaintextSegment = new Uint8Array(4).fill(2).buffer;

  const decrypted = await mod.decryptHlsSegments([cipher, plaintextSegment], {
    keys: [{ explicitIv: false, iv: null, key, method: 'AES-128' }],
    segments: [
      { keyIndex: 0, seq: sequence },
      { keyIndex: null, seq: sequence + 1 },
    ],
  });

  assert.deepEqual(new Uint8Array(decrypted[0]), new Uint8Array(plain));
  assert.deepEqual(new Uint8Array(decrypted[1]), new Uint8Array(plaintextSegment));
});

test('decryptHlsSegments fails fast when a rotated key is missing', async () => {
  const mod = loadModule();
  await assert.rejects(
    () => mod.decryptHlsSegments([new Uint8Array(16).fill(3).buffer], {
      keys: [null],
      segments: [{ keyIndex: 0, seq: 0 }],
    }),
    (err) => {
      assert.equal(err.code, 'HLS_KEY_FETCH_FAILED');
      assert.equal(err.segmentIndex, 0);
      return true;
    }
  );
});

test('parseHlsPlaylist flags live playlists without EXT-X-ENDLIST', () => {
  const mod = loadModule();
  const liveM3u8 = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:120\n#EXTINF:6.0,\nseg120.ts\n';
  const live = mod.parseHlsPlaylist(liveM3u8, 'https://cdn.example.com/live.m3u8');
  assert.equal(live.isLive, true);
  assert.equal(live.hasEndList, false);
  assert.equal(live.mediaSequence, 120);
  assert.equal(live.segments[0].seq, 120);

  const vod = mod.parseHlsPlaylist(`${liveM3u8}#EXT-X-ENDLIST\n`, 'https://cdn.example.com/live.m3u8');
  assert.equal(vod.isLive, false);
  assert.equal(vod.hasEndList, true);
});

test('parseHlsPlaylist counts EXT-X-DISCONTINUITY markers', () => {
  const mod = loadModule();
  const m3u8 = [
    '#EXTM3U',
    '#EXTINF:5.0,',
    'seg1.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:5.0,',
    'seg2.ts',
  ].join('\n');

  const playlist = mod.parseHlsPlaylist(m3u8, 'https://cdn.example.com/index.m3u8');
  assert.equal(playlist.discontinuityCount, 1);
  assert.equal(playlist.segments[0].discontinuity, false);
  assert.equal(playlist.segments[1].discontinuity, true);
  assert.equal(playlist.totalDuration, 10);
});

// ---------------------------------------------------------------
// 第三波 3.7：大文件守卫
// ---------------------------------------------------------------

test('downloadHlsSegments aborts with HLS_OUTPUT_TOO_LARGE when the stream exceeds the limit', async () => {
  const mod = loadModule();

  await assert.rejects(
    () => mod.downloadHlsSegments(segmentUrls(4), {
      fetchBuffer: async () => new Uint8Array(1024 * 1024).buffer,
      maxTotalBytes: 2 * 1024 * 1024,
      retryDelays: [0, 0, 0],
    }),
    (err) => {
      assert.equal(err.code, 'HLS_OUTPUT_TOO_LARGE');
      assert.equal(err.maxTotalBytes, 2 * 1024 * 1024);
      assert.ok(err.totalBytes > err.maxTotalBytes);
      return true;
    }
  );
});

test('downloadHlsSegments forwards byte ranges to the fetcher', async () => {
  const mod = loadModule();
  const calls = [];

  await mod.downloadHlsSegments([
    { byteRange: { end: 99, length: 100, start: 0 }, url: 'https://cdn.example.com/v.mp4' },
    { byteRange: { end: 199, length: 100, start: 100 }, url: 'https://cdn.example.com/v.mp4' },
  ], {
    fetchBuffer: async (url, range) => {
      calls.push({ range, url });
      return new Uint8Array(100).buffer;
    },
    retryDelays: [0],
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].range, { end: 99, length: 100, start: 0 });
  assert.deepEqual(calls[1].range, { end: 199, length: 100, start: 100 });
});

test('hlsFetchBuffer sends a Range header when a byte range is provided', async () => {
  const mod = loadModule();
  const seen = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    seen.push({ init, url });
    return { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(10) };
  };

  try {
    const buffer = await mod.hlsFetchBuffer(
      'https://cdn.example.com/v.mp4',
      { Referer: 'https://example.com/' },
      { range: { end: null, start: 1000 } }
    );
    assert.equal(buffer.byteLength, 10);
    assert.equal(seen[0].init.headers.Range, 'bytes=1000-');
    assert.equal(seen[0].init.headers.Referer, 'https://example.com/');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('downloadHlsSegments aborts with DOWNLOAD_ABORTED when the signal is aborted', async () => {
  const mod = loadModule();
  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;

  await assert.rejects(
    () => mod.downloadHlsSegments(segmentUrls(4), {
      fetchBuffer: async () => {
        fetchCalls++;
        return new Uint8Array(1).buffer;
      },
      signal: controller.signal,
    }),
    (err) => {
      assert.equal(err.code, 'DOWNLOAD_ABORTED');
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

test('downloadHlsSegments aborts mid-flight when the signal is aborted', async () => {
  const mod = loadModule();
  const controller = new AbortController();
  let batches = 0;

  await assert.rejects(
    () => mod.downloadHlsSegments(segmentUrls(20), {
      concurrency: 1,
      fetchBuffer: async () => {
        batches++;
        if (batches === 2) {
          controller.abort();
        }
        return new Uint8Array(1).buffer;
      },
      signal: controller.signal,
    }),
    (err) => {
      assert.equal(err.code, 'DOWNLOAD_ABORTED');
      return true;
    }
  );
  assert.ok(batches >= 2);
});

// ---------------------------------------------------------------
// 分片顺序写入 sink（峰值内存从 O(总分片) 降到 O(并发数)）
// ---------------------------------------------------------------

test('createInMemorySink 累积分片、可转 ArrayBuffer/Blob，并在 toBlob 后释放引用', () => {
  const mod = loadModule();
  const sink = mod.createInMemorySink();

  assert.equal(sink.byteLength, 0);
  assert.equal(sink.chunkCount, 0);

  return Promise.resolve()
    .then(() => sink.write(new Uint8Array([1, 2]).buffer))
    .then(() => sink.write(new Uint8Array(0).buffer))
    .then(() => sink.write(null))
    .then(() => {
      assert.equal(sink.byteLength, 2);
      assert.equal(sink.chunkCount, 1);

      const bytes = new Uint8Array(sink.toArrayBuffer());
      assert.deepEqual(Array.from(bytes), [1, 2]);

      const blob = sink.toBlob('video/mp2t');
      assert.equal(blob.size, 2);
      assert.equal(blob.type, 'video/mp2t');
      // 已交给 Blob，引用被释放但统计值保留
      assert.equal(sink.chunkCount, 0);
      assert.equal(sink.byteLength, 2);
    });
});

test('createSegmentDecryptor 对空 keyInfo 返回 null', () => {
  const mod = loadModule();
  assert.equal(mod.createSegmentDecryptor(null), null);
  assert.equal(typeof mod.createSegmentDecryptor({ iv: null, key: {} }), 'function');
});

// ---------------------------------------------------------------
// P0：体积预估（用于跳过注定超限的内容侧下载）
// ---------------------------------------------------------------

test('estimateHlsBytes 按时长 × 带宽估算，并对峰值带宽打折', () => {
  const mod = loadModule();
  const playlist = { totalDuration: 3600 };

  // 1 小时 1080p（BANDWIDTH 峰值 5 Mbps）→ 按 0.8 折扣 ≈ 1.8 GB
  assert.equal(mod.estimateHlsBytes(playlist, 5000000), Math.round((3600 * 5000000 * 0.8) / 8));
  // 有 AVERAGE-BANDWIDTH 时传 factor=1
  assert.equal(
    mod.estimateHlsBytes(playlist, 800000, { bandwidthFactor: 1 }),
    Math.round((3600 * 800000) / 8)
  );
});

test('estimateHlsBytes 在缺时长/带宽时返回 0（不拦截）', () => {
  const mod = loadModule();
  assert.equal(mod.estimateHlsBytes(null, 5000000), 0);
  assert.equal(mod.estimateHlsBytes({ totalDuration: 0 }, 5000000), 0);
  assert.equal(mod.estimateHlsBytes({ totalDuration: 3600 }, 0), 0);
  assert.equal(mod.estimateHlsBytes(undefined, undefined), 0);
});

test('downloadHlsSegments 使用 sink 时按分片顺序写入并放弃整份 buffers', async () => {
  const mod = loadModule();
  const sink = mod.createInMemorySink();
  const writes = [];
  const maxInFlight = { value: 0 };
  let downloaded = 0;
  const originalWrite = sink.write.bind(sink);
  sink.write = (chunk, meta) => {
    writes.push({ index: meta.index, size: chunk.byteLength });
    // 未被写入 sink 的分片数量即内存里驻留的窗口大小
    maxInFlight.value = Math.max(maxInFlight.value, downloaded - writes.length);
    return originalWrite(chunk, meta);
  };

  const result = await mod.downloadHlsSegments(segmentUrls(9), {
    concurrency: 3,
    fetchBuffer: async (url) => {
      // 故意让乱序完成：seg0 最慢、seg2 最快
      if (url.includes('seg0.ts')) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      downloaded++;
      return new Uint8Array(4).buffer;
    },
    retryDelays: [0],
    sink,
  });

  assert.deepEqual(writes.map((item) => item.index), Array.from({ length: 9 }, (_v, i) => i));
  assert.deepEqual(writes.map((item) => item.size), new Array(9).fill(4));
  assert.equal(result.buffers, null);
  assert.equal(result.writtenBytes, 36);
  assert.equal(result.totalBytes, 36);
  assert.equal(sink.byteLength, 36);
  // 关键：驻留窗口不超过并发数，而不是随总分片数增长
  // 写入与下载重叠后，未落盘窗口 = sinkWindow(默认=并发数) + 当前批次，仍是常数
  assert.ok(
    maxInFlight.value <= 6,
    `驻留分片数应有界（≤ sinkWindow + 并发数），实际 ${maxInFlight.value}`
  );
});

test('downloadHlsSegments 使用 sink 时跳过失败分片但保持后续顺序', async () => {
  const mod = loadModule();
  const sink = mod.createInMemorySink();
  const writes = [];
  const originalWrite = sink.write.bind(sink);
  sink.write = (chunk, meta) => {
    writes.push(meta.index);
    return originalWrite(chunk, meta);
  };

  // 20 个分片阈值 floor(20*0.1)=2，仅 1 个失败不中止
  const result = await mod.downloadHlsSegments(segmentUrls(20), {
    concurrency: 5,
    fetchBuffer: async (url) => {
      if (url.includes('seg1.ts')) {
        throw new Error('HTTP 500');
      }
      return new Uint8Array(2).buffer;
    },
    retryDelays: [0, 0, 0],
    sink,
  });

  assert.equal(result.failedCount, 1);
  assert.equal(writes.length, 19);
  assert.ok(!writes.includes(1));
  assert.equal(writes[0], 0);
  assert.equal(writes.at(-1), 19);
  assert.equal(sink.byteLength, 38);
});

test('downloadHlsSegments 在写入 sink 前按分片顺序执行 transform', async () => {
  const mod = loadModule();
  const transformed = [];
  const writes = [];
  const sink = {
    async write(chunk) {
      writes.push(Array.from(new Uint8Array(chunk)));
    },
  };

  await mod.downloadHlsSegments(segmentUrls(3), {
    concurrency: 3,
    fetchBuffer: async (url) => new Uint8Array([Number(/seg(\d+)\.ts/.exec(url)[1])]).buffer,
    retryDelays: [0],
    sink,
    transform: async (buffer, index) => {
      transformed.push({ index, value: new Uint8Array(buffer)[0] });
      // 模拟解密：把原始值 +100 后写出
      return new Uint8Array([new Uint8Array(buffer)[0] + 100]).buffer;
    },
  });

  assert.deepEqual(transformed, [
    { index: 0, value: 0 },
    { index: 1, value: 1 },
    { index: 2, value: 2 },
  ]);
  assert.deepEqual(writes, [[100], [101], [102]]);
});

// ---------------------------------------------------------------
// P1：下载与 sink 落盘重叠（写入串行但不再挡住下载）
// ---------------------------------------------------------------

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('downloadHlsSegments 让下载与 sink 写入重叠，同时保持写入串行', async () => {
  const mod = loadModule();
  let writesInProgress = 0;
  let maxConcurrentWrites = 0;
  let downloadsStartedDuringWrite = 0;
  const writeOrder = [];

  const sink = {
    async write(chunk, meta) {
      writesInProgress += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, writesInProgress);
      writeOrder.push(meta.index);
      await sleepMs(5);
      writesInProgress -= 1;
    },
  };

  await mod.downloadHlsSegments(segmentUrls(20), {
    concurrency: 5,
    fetchBuffer: async () => {
      if (writesInProgress > 0) {
        downloadsStartedDuringWrite += 1;
      }
      await sleepMs(2);
      return new Uint8Array(4).buffer;
    },
    retryDelays: [0],
    sink,
    sinkWindow: 5,
  });

  assert.ok(downloadsStartedDuringWrite > 0, '下载应与写入重叠，而不是写完才继续下');
  assert.equal(maxConcurrentWrites, 1, '写入必须串行，避免顺序文件错位');
  assert.deepEqual(writeOrder, Array.from({ length: 20 }, (_v, index) => index));
});

test('重叠写入明显快于逐批等待（同一负载对比）', async () => {
  const mod = loadModule();

  const run = async (sinkWindow) => {
    const sink = { async write() { await sleepMs(6); } };
    const startedAt = Date.now();
    await mod.downloadHlsSegments(segmentUrls(10), {
      concurrency: 5,
      fetchBuffer: async () => {
        // 抓取等待占主导：串行实现会把每个 batch 的这段等待叠加到写入之后
        await sleepMs(20);
        return new Uint8Array(4).buffer;
      },
      retryDelays: [0],
      sink,
      sinkWindow,
    });
    return Date.now() - startedAt;
  };

  const serial = await run(1);
  const overlapped = await run(1000);

  // 理论收益 = (批次数 - 1) × 单批抓取等待 ≈ 20ms，这里按下界断言，避免定时器抖动导致误报
  assert.ok(
    serial - overlapped >= 15,
    `重叠应省下至少一批抓取等待（serial=${serial}ms overlapped=${overlapped}ms）`
  );
  assert.ok(overlapped <= serial, '重叠不应比串行更慢');
});

test('sink 写入失败会中止下载并透出错误码', async () => {
  const mod = loadModule();

  await assert.rejects(
    () => mod.downloadHlsSegments(segmentUrls(12), {
      concurrency: 2,
      fetchBuffer: async () => new Uint8Array(4).buffer,
      retryDelays: [0],
      sink: {
        async write(_chunk, meta) {
          if (meta.index === 2) {
            const err = new Error('模拟磁盘写满');
            err.code = 'OPFS_WRITE_FAILED';
            throw err;
          }
        },
      },
    }),
    (err) => {
      assert.equal(err.code, 'OPFS_WRITE_FAILED');
      return true;
    }
  );
});
