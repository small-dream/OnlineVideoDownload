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

// ---------------------------------------------------------------
// 第三波 3.9：内容侧任务取消通道
// ---------------------------------------------------------------

function setupBackgroundRouter(options = {}) {
  let listener = null;
  globalThis.__OVD_safeRuntimeMessage = () => {};
  globalThis.window = { addEventListener() {} };
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener(handler) {
          listener = handler;
        },
      },
    },
  };

  const router = loadRouter().createMessageRouter(options);
  router.start();

  return {
    send(message) {
      return new Promise((resolve) => {
        listener(message, {}, resolve);
      });
    },
  };
}

test('ABORT_SOURCE_DOWNLOAD 转发取消请求到内容侧任务', async () => {
  const cancelled = [];
  const harness = setupBackgroundRouter({
    cancelSourceDownload: (target) => {
      cancelled.push(target);
      return { cancelled: true, ok: true };
    },
  });

  const response = await harness.send({
    taskKey: 'bili:123:456',
    traceId: 'trace-9',
    type: 'ABORT_SOURCE_DOWNLOAD',
    videoUrl: 'https://www.bilibili.com/video/BV1',
  });

  assert.equal(response.ok, true);
  assert.equal(response.cancelled, true);
  assert.deepEqual(cancelled, [{
    taskKey: 'bili:123:456',
    traceId: 'trace-9',
    videoUrl: 'https://www.bilibili.com/video/BV1',
  }]);
});

test('ABORT_SOURCE_DOWNLOAD 中止 HLS 委托下载的 AbortController', async () => {
  let seenSignal = null;
  const harness = setupBackgroundRouter({
    cancelSourceDownload: () => ({ cancelled: false, ok: false, error: '未找到可取消的任务' }),
    hlsDelegateHandler: {
      handle(_url, _filename, _headers, _taskMeta, options = {}) {
        seenSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('下载已取消');
            err.code = 'DOWNLOAD_ABORTED';
            reject(err);
          });
        });
      },
    },
  });

  const delegated = harness.send({
    m3u8Url: 'https://cdn.example.com/index.m3u8',
    taskMeta: { taskKey: 'hls:task-1', videoUrl: 'https://cdn.example.com/index.m3u8' },
    type: 'HLS_DOWNLOAD_DELEGATE',
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(seenSignal, 'HLS 委托下载必须拿到 AbortSignal');
  assert.equal(seenSignal.aborted, false);

  const abortResponse = await harness.send({
    taskKey: 'hls:task-1',
    type: 'ABORT_SOURCE_DOWNLOAD',
  });

  assert.equal(abortResponse.hlsCancelled, true);
  assert.equal(seenSignal.aborted, true);

  const delegateResponse = await delegated;
  assert.equal(delegateResponse.ok, false);
  assert.match(delegateResponse.error, /取消/);
});

test('伪造的页面检测消息（危险协议 / 未知类型）不会转发到后台', async () => {
  let messageHandler = null;
  const sent = [];
  globalThis.__OVD_safeRuntimeMessage = () => {};
  globalThis.window = {
    addEventListener(type, handler) {
      if (type === 'message') {
        messageHandler = handler;
      }
    },
  };
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: (message) => sent.push(message),
    },
  };
  // 页面往内容脚本方向的消息按不可信数据处理（4.6）
  require(path.resolve(__dirname, '../lib/page-message-guard.js'));

  const router = loadRouter().createMessageRouter({});
  router.start();

  const sendForged = (payload) => messageHandler({
    data: { from: 'OVD_PAGE_SCRIPT', payload },
    source: globalThis.window,
  });

  sendForged({ type: 'direct', url: 'file:///C:/Users/secret.mp4' });
  sendForged({ type: 'direct', url: 'data:video/mp4;base64,AAAA' });
  sendForged({ type: 'exec', url: 'https://evil.example/payload.mp4' });
  sendForged({ type: 'direct', url: 'blob:no-origin-here' });
  assert.equal(sent.length, 0, '可疑消息必须被丢弃');

  sendForged({ title: '正常视频', type: 'direct', url: 'https://cdn.example.com/v.mp4' });
  assert.equal(sent.length, 1, '合法检测结果仍应转发');
  assert.equal(sent[0].type, 'VIDEO_DETECTED');
});

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

// ---------------------------------------------------------------
// 多 frame 去重：一次点击只应由持有该视频的 frame 下载（否则 N 个 iframe 各下一份）
// ---------------------------------------------------------------

function setupFrameGuardRouter() {
  let listener = null;
  globalThis.__OVD_safeRuntimeMessage = () => {};
  globalThis.window = { addEventListener() {} };
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener(handler) {
          listener = handler;
        },
      },
    },
  };
  // content-main 在 MAIN world 注入成功后从 SW 记录本 frame 的 frameId
  delete globalThis.__OVD_FRAME_ID__;

  const started = [];
  const router = loadRouter().createMessageRouter({
    startSourceDownload: (meta) => {
      started.push(meta);
      return { ok: true, started: true };
    },
  });
  router.start();

  const dispatch = async (message, sender) => {
    let responded = false;
    listener(message, sender, () => {
      responded = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return responded;
  };

  return {
    dispatch,
    setSelfFrameId(frameId) {
      globalThis.__OVD_FRAME_ID__ = frameId;
    },
    started,
  };
}

test('SOURCE_DOWNLOAD 只由上报该视频的 frame 处理（其它 frame 不响应也不下载）', async () => {
  const { dispatch, setSelfFrameId, started } = setupFrameGuardRouter();
  const message = { meta: { frameId: 0, url: 'https://www.bilibili.com/video/BV1' }, type: 'SOURCE_DOWNLOAD' };

  setSelfFrameId(6);
  const foreignResponded = await dispatch(message, {});
  assert.equal(foreignResponded, false, 'iframe 不应响应（否则会与主 frame 抢答）');
  assert.equal(started.length, 0, 'iframe 不应启动下载');

  setSelfFrameId(0);
  const ownerResponded = await dispatch(message, {});
  assert.equal(ownerResponded, true);
  assert.equal(started.length, 1, '主 frame 应启动下载');
});

test('缺少 frameId 的旧消息 / 未知自身 frameId 时仍按广播处理（兼容）', async () => {
  const { dispatch, setSelfFrameId, started } = setupFrameGuardRouter();

  setSelfFrameId(3);
  assert.equal(await dispatch({ meta: { url: 'https://cdn.example.com/v.mp4' }, type: 'SOURCE_DOWNLOAD' }, {}), true);
  assert.equal(started.length, 1);

  delete globalThis.__OVD_FRAME_ID__;
  assert.equal(await dispatch({ meta: { frameId: 0, url: 'https://cdn.example.com/v.mp4' }, type: 'SOURCE_DOWNLOAD' }, {}), true);
  assert.equal(started.length, 2);
});

test('taskMeta.videoInfo.frameId 同样用于判定归属', async () => {
  const { dispatch, setSelfFrameId, started } = setupFrameGuardRouter();
  const message = {
    taskMeta: { videoInfo: { frameId: 12 } },
    type: 'SOURCE_DOWNLOAD',
  };

  setSelfFrameId(5);
  assert.equal(await dispatch(message, {}), false);
  assert.equal(started.length, 0);
  setSelfFrameId(12);
  assert.equal(await dispatch(message, {}), true);
  assert.equal(started.length, 1);
});
