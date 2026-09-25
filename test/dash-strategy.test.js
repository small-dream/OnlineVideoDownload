'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadDashStrategy() {
  delete globalThis.__OVD_DASH_STRATEGY__;
  const filePath = path.resolve(__dirname, '../content/strategies/dash-strategy.js');
  delete require.cache[filePath];
  require(filePath);
  return globalThis.__OVD_DASH_STRATEGY__;
}

function bufferOf(size) {
  return new Uint8Array(size).buffer;
}

test('DASH merge progress and blob handoff keep task metadata', async () => {
  const sentMessages = [];
  const blobDownloads = [];
  const progressMessages = [];
  globalThis.BilibiliMuxer = {
    async mergeFmp4Streams(videoData, audioData, onProgress) {
      assert.equal(videoData.byteLength, 2);
      assert.equal(audioData.byteLength, 3);
      onProgress(40);
      return new Blob([bufferOf(5)], { type: 'video/mp4' });
    },
  };

  const taskMeta = {
    sourceId: 'dash',
    strategyId: 'dash-merge',
    taskKey: 'dash:https://example.com/manifest.mpd',
    title: 'Demo',
    traceId: 'dash-trace-1',
    videoUrl: 'https://example.com/manifest.mpd',
  };

  const strategy = loadDashStrategy().createDashStrategy({
    hlsPipeline: {
      async downloadHlsSegments(urls, options) {
        const buffers = [];
        for (const url of urls) {
          buffers.push(await options.fetchBuffer(url));
          options.onProgress?.(buffers.length, urls.length, { failedCount: 0, retriedCount: 0 });
        }
        return { buffers, failedCount: 0, retriedCount: 0 };
      },
      hlsFetchBuffer(url) {
        return Promise.resolve(url.includes('audio') ? bufferOf(3) : bufferOf(2));
      },
      hlsFetchText() {
        return Promise.resolve('<MPD></MPD>');
      },
    },
    mpdParser: {
      parseMpdManifest() {
        return {
          adaptations: [{ contentType: 'video' }, { contentType: 'audio' }],
          duration: 10,
        };
      },
      selectBestAudioRepresentation() {
        return { id: 'audio', segments: [{ url: 'https://cdn.example/audio.m4s' }] };
      },
      selectBestVideoRepresentation() {
        return { id: 'video', segments: [{ url: 'https://cdn.example/video.m4s' }] };
      },
    },
    sendMessageAsync(message) {
      sentMessages.push(message);
      return Promise.resolve({ ok: true });
    },
    triggerBlobDownload(blob, filename, receivedTaskMeta) {
      blobDownloads.push({ filename, size: blob.size, taskMeta: receivedTaskMeta });
    },
    videoUtils: {
      buildMediaFilename: () => 'demo.mp4',
    },
  });

  await strategy.download({
    title: 'Demo',
    type: 'dash',
    url: 'https://example.com/manifest.mpd',
  }, {
    buttonElement: null,
    progressReporter: {
      progress(percent, payload) {
        progressMessages.push({ percent, payload });
      },
      status() {},
    },
    ...taskMeta,
  });

  assert.deepEqual(sentMessages, [{
    percent: 70,
    phase: 'merging',
    taskMeta,
    type: 'HLS_PROGRESS_UPDATE',
    videoUrl: 'https://example.com/manifest.mpd',
  }]);
  assert.deepEqual(blobDownloads, [{
    filename: 'demo.mp4',
    size: 5,
    taskMeta,
  }]);
  assert.ok(progressMessages.some((item) => item.percent === 70 && item.payload.phase === 'merging'));
});

test('DASH 分片失败超阈值时中止下载且不触发 blob 下载', async () => {
  let blobDownloads = 0;
  const strategy = loadDashStrategy().createDashStrategy({
    hlsPipeline: {
      async downloadHlsSegments() {
        const err = new Error('分片下载失败数超过阈值：1/1 个分片失败（最多允许 0 个），已中止下载');
        err.code = 'HLS_SEGMENT_DOWNLOAD_FAILED';
        throw err;
      },
      hlsFetchText() {
        return Promise.resolve('<MPD></MPD>');
      },
    },
    mpdParser: {
      parseMpdManifest() {
        return {
          adaptations: [{ contentType: 'video' }],
          duration: 10,
        };
      },
      selectBestVideoRepresentation() {
        return { id: 'video', segments: [{ url: 'https://cdn.example/video.m4s' }] };
      },
    },
    triggerBlobDownload() {
      blobDownloads++;
    },
  });

  await assert.rejects(
    () => strategy.download({
      title: 'Demo',
      type: 'dash',
      url: 'https://example.com/manifest.mpd',
    }, {
      progressReporter: { progress() {}, status() {} },
    }),
    (err) => {
      assert.equal(err.code, 'HLS_SEGMENT_DOWNLOAD_FAILED');
      assert.match(err.message, /1\/1/);
      return true;
    }
  );
  assert.equal(blobDownloads, 0);
});
