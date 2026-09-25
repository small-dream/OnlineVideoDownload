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
