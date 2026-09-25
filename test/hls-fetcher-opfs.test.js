'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const FETCHER_PATH = path.resolve(__dirname, '../background/hls-fetcher.js');
const PIPELINE_PATH = path.resolve(__dirname, '../lib/hls-pipeline.js');
const OPFS_PATH = path.resolve(__dirname, '../lib/opfs-sink.js');
const REGISTRY_PATH = path.resolve(__dirname, '../background/opfs-temp-registry.js');

let importCounter = 0;

function loadFetcher() {
  importCounter += 1;
  return import(`${pathToFileURL(FETCHER_PATH).href}?test=${importCounter}`);
}

/** 最小 OPFS 替身（SW 侧只用到 getFileHandle/createWritable/getFile/removeEntry） */
function installFakeOpfs() {
  const files = new Map();
  const dir = {
    async getFileHandle(name, options = {}) {
      if (!files.has(name)) {
        if (!options.create) {
          const err = new Error('not found');
          err.name = 'NotFoundError';
          throw err;
        }
        files.set(name, { bytes: [] });
      }
      const entry = files.get(name);
      return {
        name,
        async createWritable() {
          const local = [];
          return {
            async write(chunk) {
              local.push(new Uint8Array(chunk));
            },
            async close() {
              entry.bytes = local;
            },
          };
        },
        async getFile() {
          const size = entry.bytes.reduce((sum, bytes) => sum + bytes.length, 0);
          const buffer = new Uint8Array(size);
          let offset = 0;
          for (const bytes of entry.bytes) {
            buffer.set(bytes, offset);
            offset += bytes.length;
          }
          return { lastModified: Date.now(), name, size, _buffer: buffer };
        },
      };
    },
    async removeEntry(name) {
      files.delete(name);
    },
  };

  // Node 把 navigator 定义为只读 getter，必须用 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { async getDirectory() { return dir; } } },
    writable: true,
  });
  return { dir, files };
}

function installChrome({ files }) {
  const state = { downloads: [], opened: [], released: [] };

  globalThis.chrome = {
    declarativeNetRequest: {
      async getDynamicRules() {
        return [];
      },
      async updateDynamicRules() {},
    },
    downloads: {
      download(options, callback) {
        state.downloads.push(options);
        callback(42);
      },
    },
    offscreen: {
      async createDocument() {},
    },
    runtime: {
      lastError: null,
      getURL: (relative) => `chrome-extension://test/${relative}`,
      async getContexts() {
        return [{ contextType: 'OFFSCREEN_DOCUMENT' }];
      },
      sendMessage(message, callback) {
        if (message?.type === 'OFFSCREEN_OPFS_DOWNLOAD_OPEN') {
          state.opened.push(message);
          const entry = files.get(message.name);
          if (!entry) {
            callback({ error: 'OPFS 文件不存在', ok: false });
            return;
          }
          const size = entry.bytes.reduce((sum, bytes) => sum + bytes.length, 0);
          callback({ byteLength: size, name: message.name, objectUrl: `blob:opfs/${message.name}`, ok: true });
          return;
        }

        if (message?.type === 'OFFSCREEN_OPFS_DOWNLOAD_RELEASE') {
          state.released.push(message);
          files.delete(message.name);
          callback({ ok: true });
          return;
        }

        callback({ ok: true });
      },
    },
  };

  return state;
}

function teardown() {
  delete globalThis.navigator;
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.__OVD_HLS_PIPELINE__;
  delete globalThis.__OVD_OPFS_SINK__;
  delete globalThis.__OVD_CONSTANTS__;
}

/** 5 个 4 字节分片 + 无 init segment 的媒体播放列表 */
function installFetchStub() {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:1,',
    's1.ts',
    '#EXTINF:1,',
    's2.ts',
    '#EXTINF:1,',
    's3.ts',
    '#EXTINF:1,',
    's4.ts',
    '#EXTINF:1,',
    's5.ts',
  ].join('\n');

  globalThis.fetch = async (url) => {
    if (String(url).includes('index.m3u8')) {
      return { ok: true, status: 200, text: async () => playlist };
    }
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  };
}

test('HlsFetcher 大文件溢出到 OPFS 并通过 offscreen 对象 URL 提交下载', async () => {
  const fake = installFakeOpfs();
  const chromeState = installChrome({ files: fake.files });

  delete require.cache[require.resolve(PIPELINE_PATH)];
  require(PIPELINE_PATH);
  delete require.cache[require.resolve(OPFS_PATH)];
  require(OPFS_PATH);

  globalThis.__OVD_CONSTANTS__ = Object.freeze({
    HLS_SEGMENT_CONCURRENCY: 2,
    // 缩短对象 URL 回收定时器，避免用例结束后进程被 60s 定时器拖住
    OBJECT_URL_REVOKE_DELAY: 5,
    OPFS_MAX_OUTPUT_BYTES: 1024 * 1024,
    OPFS_SPILL_THRESHOLD_BYTES: 8,
  });
  installFetchStub();

  try {
    const { HlsFetcher } = await loadFetcher();
    const result = await new HlsFetcher().downloadAndMerge(
      'https://cdn.example.com/index.m3u8',
      'video',
      {},
      null,
      7,
      { taskId: 'task-opfs' }
    );

    assert.equal(result.ok, true);
    assert.equal(result.downloadId, 42);
    assert.equal(result.opfsName.startsWith('ovd-stream-'), true);

    // 只经过 offscreen 一次（用文件名换对象 URL），没有传输字节
    assert.equal(chromeState.opened.length, 1);
    assert.equal(chromeState.opened[0].name, result.opfsName);
    assert.equal(chromeState.downloads.length, 1);
    assert.equal(chromeState.downloads[0].url, `blob:opfs/${result.opfsName}`);
    // 默认子目录来自 settings-store 的 downloadSubdir
    assert.ok(chromeState.downloads[0].filename.endsWith('video.ts'));

    // OPFS 文件内容 = 5 个分片顺序拼接
    const file = await globalThis.__OVD_OPFS_SINK__.readFile(result.opfsName);
    assert.equal(file.size, 20);

    // 已登记临时文件，供 SW 在下载结束后清理
    const { listOpfsTempFiles, clearOpfsTempFiles } = await import(pathToFileURL(REGISTRY_PATH).href);
    assert.deepEqual(listOpfsTempFiles().map((entry) => entry.name), [result.opfsName]);
    clearOpfsTempFiles();
  } finally {
    teardown();
  }
});

test('HlsFetcher 小文件保持纯内存路径，不创建 OPFS 文件', async () => {
  const fake = installFakeOpfs();
  const chromeState = installChrome({ files: fake.files });

  delete require.cache[require.resolve(PIPELINE_PATH)];
  require(PIPELINE_PATH);
  delete require.cache[require.resolve(OPFS_PATH)];
  require(OPFS_PATH);

  globalThis.__OVD_CONSTANTS__ = Object.freeze({
    HLS_SEGMENT_CONCURRENCY: 2,
    OBJECT_URL_REVOKE_DELAY: 5,
    OPFS_MAX_OUTPUT_BYTES: 1024 * 1024,
    OPFS_SPILL_THRESHOLD_BYTES: 1024 * 1024,
  });
  installFetchStub();

  try {
    const { HlsFetcher } = await loadFetcher();
    const result = await new HlsFetcher().downloadAndMerge(
      'https://cdn.example.com/index.m3u8',
      'video',
      {},
      null,
      7,
      {}
    );

    assert.equal(result.ok, true);
    assert.equal(fake.files.size, 0, '小文件不应创建 OPFS 临时文件');
    assert.equal(chromeState.opened.length, 0);

    // offscreen 仍走 base64 分片中转（既有路径）
    assert.ok(chromeState.downloads.length <= 1);
    // 等对象 URL 回收定时器跑完，避免 teardown 之后才触发
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    teardown();
  }
});
