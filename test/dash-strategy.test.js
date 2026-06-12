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
