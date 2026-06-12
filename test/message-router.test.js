'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadRouter() {
  delete globalThis.__OVD_MESSAGE_ROUTER__;
  const routerPath = path.resolve(__dirname, '../content/message-router.js');
  delete require.cache[routerPath];

  globalThis.__OVD_MESSAGE_TYPES__ = {
    MESSAGE_TYPES: {
      SOURCE_DOWNLOAD_PROGRESS: 'SOURCE_DOWNLOAD_PROGRESS',
      YOUTUBE_MEDIA_STREAM_FINISH: 'YOUTUBE_MEDIA_STREAM_FINISH',
      YOUTUBE_MEDIA_STREAM_PROGRESS: 'YOUTUBE_MEDIA_STREAM_PROGRESS',
      YOUTUBE_MEDIA_STREAM_START: 'YOUTUBE_MEDIA_STREAM_START',
    },
    PAGE_CONTEXT_SOURCES: {
      PAGE_SCRIPT: 'OVD_PAGE_SCRIPT',
    },
    validateMessage: () => ({ ok: true }),
  };

  require(routerPath);
  return globalThis.__OVD_MESSAGE_ROUTER__;
}

test('YouTube page stream progress keeps task metadata when forwarded', () => {
  const emittedMessages = [];
  let messageHandler = null;
  globalThis.__OVD_safeRuntimeMessage = (message) => emittedMessages.push(message);
  globalThis.window = {
    addEventListener(type, handler) {
      if (type === 'message') {
        messageHandler = handler;
      }
    },
  };
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener() {},
      },
    },
  };

  const taskMeta = {
    sourceId: 'youtube',
    strategyId: 'youtube-parse',
    taskKey: 'yt:demo',
    title: 'Demo video',
    traceId: 'trace-1',
    videoUrl: 'https://www.youtube.com/watch?v=demo',
  };
  const streamTransferManager = {
    getMediaStreamTaskMeta: () => taskMeta,
    updateMediaStreamProgress: () => ({
      hasKnownTotal: true,
      loadedBytes: 50,
      percent: 50,
      totalBytes: 100,
    }),
  };

  const router = loadRouter().createMessageRouter({ streamTransferManager });
  router.start();

  messageHandler({
    source: globalThis.window,
    data: {
      from: 'OVD_PAGE_SCRIPT',
      payload: {
        label: 'video',
        loadedBytes: 50,
        totalBytes: 100,
        transferId: 'transfer-1',
        type: 'YOUTUBE_MEDIA_STREAM_PROGRESS',
      },
    },
  });

  assert.deepEqual(emittedMessages, [{
    hasKnownTotal: true,
    loadedBytes: 50,
    percent: 50,
    phase: 'fetching',
    sourceId: 'youtube',
    strategyId: 'youtube-parse',
    taskKey: 'yt:demo',
    title: 'Demo video',
    totalBytes: 100,
    traceId: 'trace-1',
    type: 'SOURCE_DOWNLOAD_PROGRESS',
    videoUrl: 'https://www.youtube.com/watch?v=demo',
  }]);
});
