'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadStrategyFactory() {
  const key = '__OVD_BILIBILI_STRATEGY__';
  const filePath = path.resolve(__dirname, '../content/strategies/bilibili-strategy.js');
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  // 内容脚本真实加载顺序里 progress-scale 先于策略
  const scalePath = path.resolve(__dirname, '../lib/progress-scale.js');
  delete globalThis.__OVD_PROGRESS_SCALE__;
  delete require.cache[scalePath];
  require(scalePath);
  require(filePath);
  return globalThis[key];
}

function createHarness({ fetchTaskMetaRecorder = null, mergePercents = [0, 50, 100] } = {}) {
  const floatCalls = [];
  const progressMessages = [];
  const float = {
    showMessage() {},
    showProgress(percent) {
      floatCalls.push(percent);
    },
  };

  globalThis.BilibiliMuxer = {
    async mergeFmp4Streams(_videoBuffer, _audioBuffer, onProgress) {
      for (const percent of mergePercents) {
        onProgress(percent);
      }
      return new Blob([new Uint8Array(4)], { type: 'video/mp4' });
    },
  };

  const strategy = loadStrategyFactory().createBilibiliStrategy({
    fetchMediaStreamsAndWait: async (videoUrls, audioUrls, headers, prefix, timeoutMessage, taskMeta) => {
      fetchTaskMetaRecorder?.(taskMeta);
      return { audioBuffer: new Uint8Array(2).buffer, videoBuffer: new Uint8Array(6).buffer };
    },
    getFloatButton: () => float,
    sendMessageAsync: async () => ({ ok: true }),
    triggerBlobDownload: () => {},
    videoUtils: { buildMediaFilename: () => 'demo.mp4' },
  });

  const progressReporter = {
    progress(percent, payload = {}) {
      progressMessages.push({ percent, phase: payload.phase });
    },
    status() {},
  };

  return { floatCalls, progressMessages, progressReporter, strategy };
}

test('Bilibili 抓取→合并共用统一进度：浮条与上报 popup/任务列表的百分比逐一相同', async () => {
  let fetchTaskMeta = null;
  const { floatCalls, progressMessages, progressReporter, strategy } = createHarness({
    fetchTaskMetaRecorder: (taskMeta) => {
      fetchTaskMeta = taskMeta;
    },
  });

  const context = {
    sourceId: 'bilibili',
    strategyId: 'page-api',
    taskKey: 'bili:BV1:2',
    title: 'Demo',
    traceId: 'trace-1',
    videoUrl: 'https://www.bilibili.com/video/BV1',
  };

  const result = await strategy.mergeBilibiliDashAndDownload(
    ['https://cdn.example/v.m4s'],
    ['https://cdn.example/a.m4s'],
    'Demo',
    { Referer: 'https://www.bilibili.com' },
    progressReporter,
    context,
    { title: 'Demo', url: 'https://www.bilibili.com/video/BV1' }
  );

  assert.equal(result.ok, true);
  // 抓取请求带上任务身份，background 才能把抓取阶段进度写进同一任务
  assert.deepEqual(fetchTaskMeta, {
    sourceId: 'bilibili',
    strategyId: 'page-api',
    taskKey: 'bili:BV1:2',
    title: 'Demo',
    traceId: 'trace-1',
    videoUrl: 'https://www.bilibili.com/video/BV1',
  });
  // 合并阶段接在抓取之后（90..99），不会退回 0%
  assert.deepEqual(progressMessages, [
    { percent: 0, phase: 'fetching' },
    { percent: 90, phase: 'merging' },
    { percent: 95, phase: 'merging' },
    { percent: 99, phase: 'merging' },
    { percent: 100, phase: 'complete' },
  ]);
  // 浮条与上报给 popup 条目/任务列表的进度完全一致
  assert.deepEqual(floatCalls, progressMessages.map((message) => message.percent));
});

test('体积超限降级为分离文件时，三个展示位置同样落到 100%', async () => {
  // 上限设得极小，走「分别保存视频/音频」的降级分支
  globalThis.__OVD_CONSTANTS__ = { MAX_IN_PAGE_MERGE_BYTES: 4 };

  try {
    const { floatCalls, progressMessages, progressReporter, strategy } = createHarness();

    const result = await strategy.mergeBilibiliDashAndDownload(
      ['https://cdn.example/v.m4s'],
      ['https://cdn.example/a.m4s'],
      'Demo',
      {},
      progressReporter,
      { sourceId: 'bilibili', taskKey: 'bili:BV1:2', traceId: 'trace-2' },
      { title: 'Demo', url: 'https://www.bilibili.com/video/BV1' }
    );

    assert.deepEqual(result.separateFiles, ['demo-video.mp4', 'demo-audio.mp4']);
    assert.equal(progressMessages.at(-1).phase, 'complete');
    assert.equal(progressMessages.at(-1).percent, 100);
    assert.deepEqual(floatCalls, progressMessages.map((message) => message.percent));
  } finally {
    delete globalThis.__OVD_CONSTANTS__;
  }
});
