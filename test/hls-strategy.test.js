'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadHlsStrategy() {
  const key = '__OVD_HLS_STRATEGY__';
  const filePath = path.resolve(__dirname, '../content/strategies/hls-strategy.js');
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[key];
}

function createPipeline(overrides = {}) {
  const fetchCalls = [];
  const pipeline = {
    decryptHlsSegments: async (buffers) => buffers,
    downloadHlsSegments: async (urls, options) => {
      const buffers = [];
      for (const url of urls) {
        buffers.push(await options.fetchBuffer(url));
        options.onProgress?.(buffers.length, urls.length, { failedCount: 0, retriedCount: 0 });
      }
      return { buffers, failedCount: 0, retriedCount: 0 };
    },
    ensureExtension: (name, ext) => `${name}${ext}`,
    hlsFetchBuffer: async (url, headers, options) => {
      fetchCalls.push({ headers, options, url });
      return new Uint8Array(2).buffer;
    },
    hlsFetchText: async (url, headers, options) => {
      fetchCalls.push({ headers, options, url });
      return '#EXTM3U\n#EXTINF:1,\nseg1.ts\n';
    },
    inferHlsOutputProfile: () => ({ ext: '.ts', mimeType: 'video/mp2t' }),
    parseHlsEncryption: async () => null,
    parseHlsPlaylist: () => ({
      initSegmentUrl: null,
      segments: ['https://cdn.example.com/seg1.ts'],
    }),
    selectBestHlsStream: (text, baseUrl) => baseUrl,
    ...overrides,
  };

  return { fetchCalls, pipeline };
}

test('HLS 委托下载在页面上下文带 Cookie 请求并把 downloadId 回传给后台', async () => {
  const { fetchCalls, pipeline } = createPipeline();
  const blobDownloads = [];
  const progressMessages = [];
  const taskMeta = { taskId: 'task-1', videoUrl: 'https://cdn.example.com/index.m3u8' };

  const handler = loadHlsStrategy().createHlsDelegateHandler({
    emitRuntimeMessage: (message) => progressMessages.push(message),
    hlsPipeline: pipeline,
    triggerBlobDownload: (blob, filename, receivedTaskMeta) => {
      blobDownloads.push({ filename, size: blob.size, taskMeta: receivedTaskMeta });
      return Promise.resolve({ downloadId: 42, ok: true });
    },
  });

  const result = await handler.handle('https://cdn.example.com/index.m3u8', 'video', {}, taskMeta);

  assert.equal(fetchCalls.length, 2);
  assert.ok(fetchCalls.every((call) => call.options.credentials === 'include'));
  assert.equal(fetchCalls[0].url, 'https://cdn.example.com/index.m3u8');
  assert.equal(blobDownloads.length, 1);
  assert.equal(blobDownloads[0].filename, 'video.ts');
  assert.equal(blobDownloads[0].size, 2);
  assert.deepEqual(blobDownloads[0].taskMeta, taskMeta);

  assert.equal(result.downloadId, 42);
  assert.equal(result.filename, 'video.ts');
  assert.equal(result.segmentCount, 1);
  assert.equal(result.failedCount, 0);

  assert.equal(progressMessages.at(-1).percent, 100);
  assert.equal(progressMessages.at(-1).phase, 'browser-handoff');
  assert.deepEqual(progressMessages.at(-1).taskMeta, taskMeta);
});

test('HLS 委托下载允许调用方覆盖 fetchOptions', async () => {
  const { fetchCalls, pipeline } = createPipeline();
  const handler = loadHlsStrategy().createHlsDelegateHandler({
    hlsPipeline: pipeline,
    triggerBlobDownload: () => Promise.resolve({ downloadId: 1, ok: true }),
  });

  await handler.handle(
    'https://cdn.example.com/index.m3u8',
    'video',
    {},
    {},
    { fetchOptions: { credentials: 'omit' } }
  );

  assert.ok(fetchCalls.every((call) => call.options.credentials === 'omit'));
});

test('HLS 委托下载把 m3u8 403 透出为错误，交由后台决定是否回退', async () => {
  const { pipeline } = createPipeline({
    hlsFetchText: async () => {
      throw new Error('HTTP 403: https://cdn10.11yun.space/TAV1/339370/339370.m3u8');
    },
  });
  const handler = loadHlsStrategy().createHlsDelegateHandler({
    hlsPipeline: pipeline,
    triggerBlobDownload: () => Promise.resolve({ downloadId: 1, ok: true }),
  });

  await assert.rejects(
    () => handler.handle('https://cdn10.11yun.space/TAV1/339370/339370.m3u8', 'video', {}, {}),
    /HTTP 403/
  );
});

test('HLS 委托下载在浏览器下载提交失败时抛错', async () => {
  const { pipeline } = createPipeline();
  const handler = loadHlsStrategy().createHlsDelegateHandler({
    hlsPipeline: pipeline,
    triggerBlobDownload: () => Promise.resolve({ error: 'user canceled', ok: false }),
  });

  await assert.rejects(
    () => handler.handle('https://cdn.example.com/index.m3u8', 'video', {}, {}),
    /user canceled/
  );
});

test('HLS 委托下载在 m3u8 无分片时报错', async () => {
  const { pipeline } = createPipeline({
    parseHlsPlaylist: () => ({ initSegmentUrl: null, segments: [] }),
  });
  const handler = loadHlsStrategy().createHlsDelegateHandler({
    hlsPipeline: pipeline,
    triggerBlobDownload: () => Promise.resolve({ downloadId: 1, ok: true }),
  });

  await assert.rejects(
    () => handler.handle('https://cdn.example.com/index.m3u8', 'video', {}, {}),
    /没有找到分片/
  );
});

test('HLS 委托下载在分片失败超阈值时中止且不触发浏览器下载', async () => {
  const { pipeline } = createPipeline({
    downloadHlsSegments: async () => {
      const err = new Error('分片下载失败数超过阈值：1/1 个分片失败（最多允许 0 个），已中止下载');
      err.code = 'HLS_SEGMENT_DOWNLOAD_FAILED';
      throw err;
    },
  });
  let blobDownloads = 0;
  const handler = loadHlsStrategy().createHlsDelegateHandler({
    hlsPipeline: pipeline,
    triggerBlobDownload: () => {
      blobDownloads++;
      return Promise.resolve({ downloadId: 1, ok: true });
    },
  });

  await assert.rejects(
    () => handler.handle('https://cdn.example.com/index.m3u8', 'video', {}, {}),
    (err) => {
      assert.equal(err.code, 'HLS_SEGMENT_DOWNLOAD_FAILED');
      assert.match(err.message, /1\/1/);
      return true;
    }
  );
  assert.equal(blobDownloads, 0);
});

test('HLS 委托下载在分片失败未超阈值时通过进度消息告知用户', async () => {
  const { pipeline } = createPipeline({
    downloadHlsSegments: async (urls, options) => {
      const buffers = [];
      for (const url of urls) {
        buffers.push(await options.fetchBuffer(url));
      }
      buffers.push(new ArrayBuffer(0));
      options.onProgress?.(urls.length, urls.length, { failedCount: 1, retriedCount: 0 });
      return { buffers, failedCount: 1, retriedCount: 0 };
    },
  });
  const progressMessages = [];
  const handler = loadHlsStrategy().createHlsDelegateHandler({
    emitRuntimeMessage: (message) => progressMessages.push(message),
    hlsPipeline: pipeline,
    triggerBlobDownload: () => Promise.resolve({ downloadId: 1, ok: true }),
  });

  const result = await handler.handle('https://cdn.example.com/index.m3u8', 'video', {}, {});

  assert.equal(result.failedCount, 1);
  const warning = progressMessages.find((message) => message.warning);
  assert.ok(warning, 'expected a progress message carrying the failure warning');
  assert.equal(warning.failedCount, 1);
  assert.match(warning.warning, /1\/1 个分片下载失败/);
});

// ---------------------------------------------------------------
// 第三波：真实管线的画质选择 / 直播提示 / 独立音轨合并
// ---------------------------------------------------------------

function loadRealPipeline() {
  delete globalThis.__OVD_HLS_PIPELINE__;
  const filePath = path.resolve(__dirname, '../lib/hls-pipeline.js');
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis.__OVD_HLS_PIPELINE__;
}

const MASTER_WITH_AUDIO = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="主音轨",DEFAULT=YES,URI="audio.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,AUDIO="aud"',
  'low.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud"',
  'high.m3u8',
].join('\n');

function installFetchStub(routes) {
  const fetched = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    fetched.push(target);
    for (const [fragment, handler] of routes) {
      if (target.includes(fragment)) {
        return typeof handler === 'function' ? handler(target) : handler;
      }
    }
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(4).buffer };
  };
  return {
    fetched,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

const playlistResponse = (body) => ({
  arrayBuffer: async () => new Uint8Array(4).buffer,
  ok: true,
  status: 200,
  text: async () => body,
});

test('HLS 委托下载按 quality 选择 Master Playlist 变体', async () => {
  const pipeline = loadRealPipeline();
  const stub = installFetchStub([
    ['master.m3u8', playlistResponse(MASTER_WITH_AUDIO)],
    ['low.m3u8', playlistResponse('#EXTM3U\n#EXTINF:1,\nlow1.ts\n')],
    ['high.m3u8', playlistResponse('#EXTM3U\n#EXTINF:1,\nhigh1.ts\n')],
  ]);
  const blobDownloads = [];

  try {
    const handler = loadHlsStrategy().createHlsDelegateHandler({
      hlsPipeline: pipeline,
      triggerBlobDownload: (blob, filename) => {
        blobDownloads.push({ filename, size: blob.size });
        return { downloadId: 7, ok: true };
      },
    });

    const result = await handler.handle(
      'https://cdn.example.com/master.m3u8',
      'video',
      {},
      {},
      { quality: '360p' }
    );

    assert.equal(result.quality, '360p');
    assert.ok(stub.fetched.includes('https://cdn.example.com/low.m3u8'));
    assert.ok(!stub.fetched.includes('https://cdn.example.com/high.m3u8'));
    assert.equal(blobDownloads.length, 1);
  } finally {
    stub.restore();
    delete globalThis.__OVD_HLS_PIPELINE__;
  }
});

test('fetchQualities 返回 Master Playlist 的全部变体，单码率流返回空列表', async () => {
  const pipeline = loadRealPipeline();
  const stub = installFetchStub([
    ['master.m3u8', playlistResponse(MASTER_WITH_AUDIO)],
    ['single.m3u8', playlistResponse('#EXTM3U\n#EXTINF:1,\nseg1.ts\n')],
  ]);

  try {
    const handler = loadHlsStrategy().createHlsDelegateHandler({ hlsPipeline: pipeline });

    const master = await handler.fetchQualities('https://cdn.example.com/master.m3u8', {});
    assert.equal(master.isMaster, true);
    assert.deepEqual(master.qualities.map((quality) => quality.label), ['360p', '720p']);
    assert.ok(master.qualities[1].url.endsWith('high.m3u8'));
    assert.match(master.qualities[1].detail, /1280x720/);

    const single = await handler.fetchQualities('https://cdn.example.com/single.m3u8', {});
    assert.deepEqual(single, { isMaster: false, qualities: [] });
  } finally {
    stub.restore();
    delete globalThis.__OVD_HLS_PIPELINE__;
  }
});

test('HLS 直播流显式提示仅下载当前窗口而不是静默产出残片', async () => {
  const pipeline = loadRealPipeline();
  const liveBody = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:120\n#EXTINF:6.0,\nseg120.ts\n#EXTINF:6.0,\nseg121.ts\n';
  const stub = installFetchStub([['live.m3u8', playlistResponse(liveBody)]]);
  const messages = [];

  try {
    const handler = loadHlsStrategy().createHlsDelegateHandler({
      emitRuntimeMessage: (message) => messages.push(message),
      hlsPipeline: pipeline,
      triggerBlobDownload: () => ({ downloadId: 1, ok: true }),
    });

    const result = await handler.handle('https://cdn.example.com/live.m3u8', 'video', {}, {});

    assert.equal(result.isLive, true);
    const status = messages.find((message) => message.type === 'SOURCE_DOWNLOAD_STATUS');
    assert.ok(status, '直播流必须给出显式提示');
    assert.match(status.message, /直播/);
    assert.match(status.message, /2 个分片/);
  } finally {
    stub.restore();
    delete globalThis.__OVD_HLS_PIPELINE__;
  }
});

test('HLS 独立音轨与视频合并为单文件', async () => {
  const pipeline = loadRealPipeline();
  const videoBody = '#EXTM3U\n#EXT-X-MAP:URI="vinit.mp4"\n#EXTINF:1,\nv1.m4s\n';
  const audioBody = '#EXTM3U\n#EXT-X-MAP:URI="ainit.mp4"\n#EXTINF:1,\na1.m4s\n';
  const stub = installFetchStub([
    ['master.m3u8', playlistResponse(MASTER_WITH_AUDIO)],
    ['high.m3u8', playlistResponse(videoBody)],
    ['audio.m3u8', playlistResponse(audioBody)],
  ]);
  const muxerCalls = [];
  globalThis.BilibiliMuxer = {
    async mergeFmp4Streams(videoData, audioData) {
      muxerCalls.push({ audio: audioData.byteLength, video: videoData.byteLength });
      return new Blob([new Uint8Array(videoData.byteLength + audioData.byteLength)]);
    },
  };

  try {
    const handler = loadHlsStrategy().createHlsDelegateHandler({
      hlsPipeline: pipeline,
      triggerBlobDownload: () => ({ downloadId: 3, ok: true }),
    });

    const result = await handler.handle('https://cdn.example.com/master.m3u8', 'video', {}, {});

    assert.equal(result.audioMerged, true);
    assert.equal(result.quality, '720p');
    assert.equal(muxerCalls.length, 1);
    assert.equal(muxerCalls[0].video, 8);
    assert.equal(muxerCalls[0].audio, 8);
  } finally {
    stub.restore();
    delete globalThis.BilibiliMuxer;
    delete globalThis.__OVD_HLS_PIPELINE__;
  }
});

test('HLS 委托下载用顺序 sink 输出完整文件（init + 全部分片）', async () => {
  const pipeline = loadRealPipeline();
  const body = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:1,',
    'a1.m4s',
    '#EXTINF:1,',
    'a2.m4s',
    '#EXTINF:1,',
    'a3.m4s',
  ].join('\n');
  const stub = installFetchStub([['index.m3u8', playlistResponse(body)]]);
  const blobDownloads = [];

  try {
    const handler = loadHlsStrategy().createHlsDelegateHandler({
      hlsPipeline: pipeline,
      triggerBlobDownload: (blob, filename) => {
        blobDownloads.push({ blob, filename, size: blob.size });
        return { downloadId: 11, ok: true };
      },
    });

    const result = await handler.handle('https://cdn.example.com/index.m3u8', 'video', {}, {});

    // 每个响应 4 字节：init 1 个 + 3 个分片
    assert.equal(result.segmentCount, 3);
    assert.equal(blobDownloads[0].filename, 'video.mp4');
    assert.equal(blobDownloads[0].size, 16);
  } finally {
    stub.restore();
    delete globalThis.__OVD_HLS_PIPELINE__;
  }
});

test('HLS 加密流在写入 sink 前逐分片解密（按媒体序号派生 IV）', async () => {
  const pipeline = loadRealPipeline();
  const keyBytes = new Uint8Array(16).fill(7);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  const plain1 = new Uint8Array(16).fill(1);
  const plain2 = new Uint8Array(16).fill(2);
  const cipher1 = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: pipeline.ivFromSequence(5) },
    key,
    plain1
  );
  const cipher2 = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: pipeline.ivFromSequence(6) },
    key,
    plain2
  );
  const body = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:5',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXTINF:1,',
    's1.ts',
    '#EXTINF:1,',
    's2.ts',
  ].join('\n');
  const stub = installFetchStub([
    ['index.m3u8', playlistResponse(body)],
    ['key.bin', { arrayBuffer: async () => keyBytes.buffer, ok: true, status: 200 }],
    ['s1.ts', { arrayBuffer: async () => cipher1, ok: true, status: 200 }],
    ['s2.ts', { arrayBuffer: async () => cipher2, ok: true, status: 200 }],
  ]);
  const blobDownloads = [];

  try {
    const handler = loadHlsStrategy().createHlsDelegateHandler({
      hlsPipeline: pipeline,
      triggerBlobDownload: (blob) => {
        blobDownloads.push(blob);
        return { downloadId: 12, ok: true };
      },
    });

    await handler.handle('https://cdn.example.com/index.m3u8', 'video', {}, {});

    const bytes = new Uint8Array(await blobDownloads[0].arrayBuffer());
    assert.equal(bytes.byteLength, 32);
    assert.deepEqual(Array.from(bytes.slice(0, 16)), Array.from(plain1));
    assert.deepEqual(Array.from(bytes.slice(16)), Array.from(plain2));
  } finally {
    stub.restore();
    delete globalThis.__OVD_HLS_PIPELINE__;
  }
});

test('HLS 视频非 fMP4 时把独立音轨单独保存而不是丢弃', async () => {
  const pipeline = loadRealPipeline();
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="主音轨",DEFAULT=YES,URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="aud"',
    'video.m3u8',
  ].join('\n');
  const stub = installFetchStub([
    ['master.m3u8', playlistResponse(master)],
    ['video.m3u8', playlistResponse('#EXTM3U\n#EXTINF:1,\nv1.ts\n')],
    ['audio.m3u8', playlistResponse('#EXTM3U\n#EXTINF:1,\na1.ts\n')],
  ]);
  const blobDownloads = [];
  // muxer 存在但视频是 TS：只能分离保存
  globalThis.BilibiliMuxer = { mergeFmp4Streams: async () => new Blob([new Uint8Array(1)]) };

  try {
    const handler = loadHlsStrategy().createHlsDelegateHandler({
      hlsPipeline: pipeline,
      triggerBlobDownload: (blob, filename) => {
        blobDownloads.push({ filename, size: blob.size });
        return { downloadId: 1, ok: true };
      },
    });

    const result = await handler.handle('https://cdn.example.com/master.m3u8', 'video', {}, {});

    assert.equal(result.audioSavedSeparately, true);
    assert.equal(result.audioSeparateFilename, 'video_audio.ts');
    assert.equal(result.audioMerged, false);
    assert.deepEqual(blobDownloads.map((item) => item.filename), ['video_audio.ts', 'video.ts']);
  } finally {
    stub.restore();
    delete globalThis.BilibiliMuxer;
    delete globalThis.__OVD_HLS_PIPELINE__;
  }
});

test('HLS 合并失败时降级为单独保存音轨文件', async () => {
  const pipeline = loadRealPipeline();
  const videoBody = '#EXTM3U\n#EXT-X-MAP:URI="vinit.mp4"\n#EXTINF:1,\nv1.m4s\n';
  const audioBody = '#EXTM3U\n#EXT-X-MAP:URI="ainit.mp4"\n#EXTINF:1,\na1.m4s\n';
  const stub = installFetchStub([
    ['master.m3u8', playlistResponse(MASTER_WITH_AUDIO)],
    ['high.m3u8', playlistResponse(videoBody)],
    ['audio.m3u8', playlistResponse(audioBody)],
  ]);
  const blobDownloads = [];
  globalThis.BilibiliMuxer = {
    async mergeFmp4Streams() {
      throw new Error('muxer 解析失败');
    },
  };

  try {
    const handler = loadHlsStrategy().createHlsDelegateHandler({
      hlsPipeline: pipeline,
      triggerBlobDownload: (blob, filename) => {
        blobDownloads.push({ filename, size: blob.size });
        return { downloadId: 1, ok: true };
      },
    });

    const result = await handler.handle('https://cdn.example.com/master.m3u8', 'video', {}, {});

    assert.equal(result.audioMerged, false);
    assert.equal(result.audioSavedSeparately, true);
    assert.equal(result.audioSeparateFilename, 'video_audio.mp4');
    assert.deepEqual(blobDownloads.map((item) => item.filename), ['video_audio.mp4', 'video.mp4']);
  } finally {
    stub.restore();
    delete globalThis.BilibiliMuxer;
    delete globalThis.__OVD_HLS_PIPELINE__;
  }
});

// ---------------------------------------------------------------
// P0：体积预估超限时跳过内容侧下载（交给后台 OPFS 落盘），避免白下 1.5GB
// ---------------------------------------------------------------

function longMediaPlaylist(segmentSeconds, segmentCount) {
  const lines = ['#EXTM3U'];
  for (let index = 0; index < segmentCount; index++) {
    lines.push(`#EXTINF:${segmentSeconds}.0,`, `seg${index}.ts`);
  }
  return lines.join('\n');
}

test('预估体积超限时内容侧立即跳过，不下载任何分片', async () => {
  const pipeline = loadRealPipeline();
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nmedia.m3u8\n';
  // 60 × 60s = 1 小时；1h × 5Mbps × 0.8 / 8 ≈ 1.8GB > 1.5GB 上限
  const stub = installFetchStub([
    ['master.m3u8', playlistResponse(master)],
    ['media.m3u8', playlistResponse(longMediaPlaylist(60, 60))],
  ]);
  let blobDownloads = 0;

  try {
    const handler = loadHlsStrategy().createHlsDelegateHandler({
      hlsPipeline: pipeline,
      triggerBlobDownload: () => {
        blobDownloads += 1;
        return { downloadId: 1, ok: true };
      },
    });

    await assert.rejects(
      () => handler.handle('https://cdn.example.com/master.m3u8', 'video', {}, {}),
      (err) => {
        assert.equal(err.code, 'HLS_CONTENT_SIZE_SKIP');
        assert.match(err.message, /后台 OPFS/);
        assert.ok(err.estimatedBytes > 1500 * 1024 * 1024);
        return true;
      }
    );

    assert.equal(blobDownloads, 0, '不应触发任何下载');
    assert.deepEqual(stub.fetched, [
      'https://cdn.example.com/master.m3u8',
      'https://cdn.example.com/media.m3u8',
    ], '只应读取两级播放列表，不下载分片');
  } finally {
    stub.restore();
    delete globalThis.__OVD_HLS_PIPELINE__;
  }
});

test('有 AVERAGE-BANDWIDTH 时按平均码率估算，不会误判为超限', async () => {
  const pipeline = loadRealPipeline();
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=800000,RESOLUTION=1920x1080',
    'media.m3u8',
  ].join('\n');
  // 1h × 0.8Mbps / 8 = 360MB < 1.5GB → 正常走内容侧
  const stub = installFetchStub([
    ['master.m3u8', playlistResponse(master)],
    ['media.m3u8', playlistResponse(longMediaPlaylist(60, 60))],
  ]);
  const blobDownloads = [];

  try {
    const handler = loadHlsStrategy().createHlsDelegateHandler({
      hlsPipeline: pipeline,
      triggerBlobDownload: (blob, filename) => {
        blobDownloads.push({ filename, size: blob.size });
        return { downloadId: 5, ok: true };
      },
    });

    const result = await handler.handle('https://cdn.example.com/master.m3u8', 'video', {}, {});

    assert.equal(result.segmentCount, 60);
    assert.equal(result.quality, '1080p');
    assert.equal(blobDownloads.length, 1);
    assert.ok(stub.fetched.some((url) => url.endsWith('seg59.ts')));
  } finally {
    stub.restore();
    delete globalThis.__OVD_HLS_PIPELINE__;
  }
});
