'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MANAGER_PATH = path.resolve(__dirname, '../background/page-stream-download.js');

let importCounter = 0;

async function loadManager() {
  importCounter += 1;
  const module = await import(`${pathToFileURL(MANAGER_PATH).href}?test=${importCounter}`);
  return module.PageStreamDownloadManager;
}

function createSink(options = {}) {
  const sink = {
    byteLength: 0,
    name: options.name || 'ovd-page-stream-test',
    removed: false,
    writes: [],
    async finalize() {
      if (options.failFinalize) {
        throw new Error('quota exceeded');
      }
      return { byteLength: this.byteLength, chunkCount: this.writes.length, mode: 'opfs', name: this.name };
    },
    async remove() {
      this.removed = true;
      return true;
    },
    async write(chunk) {
      this.writes.push(Buffer.from(chunk));
      this.byteLength += chunk.byteLength;
    },
  };
  return sink;
}

function createDeps(options = {}) {
  const sink = options.sink || createSink();
  const registered = [];
  const tempFiles = [];
  const tasks = [];
  const submitted = [];
  const downloadStore = {
    registerDownload(downloadId, info) {
      registered.push({ downloadId, ...info });
    },
    updateTaskByVideoUrl(videoUrl, updates) {
      const task = { taskId: 'task:telegram:777', videoUrl, ...updates };
      tasks.push(task);
      return task;
    },
  };

  return {
    deps: {
      broadcastTaskUpdate: (task) => tasks.push(task),
      createSink: async () => sink,
      downloadStore,
      registerTempFile: (downloadId, name) => tempFiles.push({ downloadId, name }),
      submitOpfsDownload: async (name, filename, mimeType, taskMeta) => {
        submitted.push({ filename, mimeType, name, taskMeta });
        if (options.submitResult) {
          return options.submitResult;
        }
        return { downloadId: 7, filename, ok: true, opfsName: name, size: sink.byteLength };
      },
    },
    registered,
    sink,
    submitted,
    tasks,
    tempFiles,
  };
}

const START_MESSAGE = {
  fileSize: 6,
  filename: '自拍群 #1234.mp4',
  mimeType: 'video/mp4',
  tabId: 5,
  taskMeta: {
    sourceId: 'telegram',
    strategyId: 'page-stream',
    taskKey: '777',
    title: '自拍群 #1234',
    traceId: 'trace-1',
    videoUrl: 'https://web.telegram.org/k/stream/x',
  },
  transferId: 'tg-1',
};

test('start/append/finish writes the base64 chunks into OPFS and submits the download', async () => {
  const PageStreamDownloadManager = await loadManager();
  const { deps, registered, sink, submitted, tasks, tempFiles } = createDeps();
  const manager = new PageStreamDownloadManager(deps);

  await manager.start(START_MESSAGE);
  assert.equal(manager.transferCount, 1);

  await manager.append({ chunkBase64: Buffer.from([1, 2, 3]).toString('base64'), transferId: 'tg-1' });
  await manager.append({ chunkBase64: Buffer.from([4, 5, 6]).toString('base64'), transferId: 'tg-1' });
  assert.equal(manager.transferCount, 1);
  assert.deepEqual(Buffer.concat(sink.writes), Buffer.from([1, 2, 3, 4, 5, 6]));

  const result = await manager.finish({ transferId: 'tg-1' });
  assert.equal(manager.transferCount, 0);

  assert.deepEqual(submitted, [{
    filename: '自拍群 #1234.mp4',
    mimeType: 'video/mp4',
    name: sink.name,
    taskMeta: { ...START_MESSAGE.taskMeta },
  }]);
  assert.deepEqual(tempFiles, [{ downloadId: 7, name: sink.name }]);
  assert.deepEqual(registered, [{
    downloadId: 7,
    requiresTabContext: true,
    sourceId: 'telegram',
    strategyId: 'page-stream',
    tabId: 5,
    taskId: null,
    title: '自拍群 #1234',
    videoInfo: null,
    videoUrl: 'https://web.telegram.org/k/stream/x',
  }]);
  assert.equal(result.ok, true);
  assert.equal(result.downloadId, 7);
  assert.equal(result.filename, '自拍群 #1234.mp4');
  assert.equal(result.size, 6);

  // downloadId 挂回内容侧正在跟踪的同一条任务，而不是新建一条
  const attached = tasks.find((task) => task.downloadId === 7);
  assert.ok(attached);
  assert.equal(attached.taskKey, '777');
  assert.equal(attached.traceId, 'trace-1');
});

test('finish removes the temp file when the browser handoff fails', async () => {
  const PageStreamDownloadManager = await loadManager();
  const { deps, sink, tempFiles } = createDeps({ submitResult: { error: '保存失败', ok: false } });
  const manager = new PageStreamDownloadManager(deps);

  await manager.start(START_MESSAGE);
  await manager.append({ chunkBase64: Buffer.from([1]).toString('base64'), transferId: 'tg-1' });

  const result = await manager.finish({ transferId: 'tg-1' });
  assert.equal(result.ok, false);
  assert.equal(result.error, '保存失败');
  assert.equal(sink.removed, true);
  assert.deepEqual(tempFiles, []);
});

test('finish reports OPFS write failures instead of throwing', async () => {
  const PageStreamDownloadManager = await loadManager();
  const { deps, sink } = createDeps({ sink: createSink({ failFinalize: true }) });
  const manager = new PageStreamDownloadManager(deps);

  await manager.start(START_MESSAGE);
  const result = await manager.finish({ transferId: 'tg-1' });

  assert.equal(result.ok, false);
  assert.match(result.error, /临时文件写入失败/);
  assert.equal(sink.removed, true);
});

test('finish refuses to save a zero-byte stream', async () => {
  const PageStreamDownloadManager = await loadManager();
  const { deps, sink, submitted } = createDeps();
  const manager = new PageStreamDownloadManager(deps);

  await manager.start(START_MESSAGE);
  const result = await manager.finish({ transferId: 'tg-1' });

  assert.equal(result.ok, false);
  assert.match(result.error, /未取到任何视频数据/);
  assert.equal(sink.removed, true);
  assert.deepEqual(submitted, []);
});

test('append requires a live transfer', async () => {
  const PageStreamDownloadManager = await loadManager();
  const { deps } = createDeps();
  const manager = new PageStreamDownloadManager(deps);

  await assert.rejects(() => manager.append({ chunkBase64: '', transferId: 'missing' }), /传输不存在/);
  assert.deepEqual(await manager.finish({ transferId: 'missing' }), { error: '传输不存在或已结束', ok: false });
});

test('start rejects duplicate transfer ids', async () => {
  const PageStreamDownloadManager = await loadManager();
  const { deps } = createDeps();
  const manager = new PageStreamDownloadManager(deps);

  await manager.start(START_MESSAGE);
  await assert.rejects(() => manager.start(START_MESSAGE), /重复开始/);
});

test('abort drops the transfer and cleans the temp file', async () => {
  const PageStreamDownloadManager = await loadManager();
  const { deps, sink } = createDeps();
  const manager = new PageStreamDownloadManager(deps);

  await manager.start(START_MESSAGE);
  await manager.abort({ error: 'user cancel', transferId: 'tg-1' });

  assert.equal(manager.transferCount, 0);
  assert.equal(sink.removed, true);
});

test('abortForTab only cleans transfers owned by that tab', async () => {
  const PageStreamDownloadManager = await loadManager();
  const sinks = [createSink({ name: 'tab-5' }), createSink({ name: 'tab-9' })];
  let index = 0;
  const { deps, sink } = createDeps();
  deps.createSink = async () => sinks[index++];
  const manager = new PageStreamDownloadManager(deps);

  await manager.start({ ...START_MESSAGE, tabId: 5, transferId: 'tab-5-transfer' });
  await manager.start({ ...START_MESSAGE, tabId: 9, transferId: 'tab-9-transfer' });

  const aborted = await manager.abortForTab(5);
  assert.equal(aborted, 1);
  assert.equal(manager.transferCount, 1);
  assert.equal(sinks[0].removed, true);
  assert.equal(sinks[1].removed, false);

  await manager.abort({ transferId: 'tab-9-transfer' });
  assert.equal(sink.name, 'ovd-page-stream-test');
});
