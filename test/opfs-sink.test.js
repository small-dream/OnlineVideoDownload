'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const MODULE_PATH = path.resolve(__dirname, '../lib/opfs-sink.js');

function loadModule() {
  const key = '__OVD_OPFS_SINK__';
  delete globalThis[key];
  delete require.cache[require.resolve(MODULE_PATH)];
  require(MODULE_PATH);
  return globalThis[key];
}

/** 最小 OPFS 替身：够用即可（getFileHandle / removeEntry / keys + writable/getFile） */
function installFakeOpfs(initial = {}) {
  const files = new Map();
  for (const [name, value] of Object.entries(initial)) {
    files.set(name, {
      bytes: [], lastModified: value.lastModified ?? Date.now(),
    });
  }

  const dir = {
    async getFileHandle(name, options = {}) {
      if (!files.has(name)) {
        if (!options.create) {
          const err = new Error('not found');
          err.name = 'NotFoundError';
          throw err;
        }
        files.set(name, { bytes: [], lastModified: Date.now() });
      }
      const entry = files.get(name);
      return {
        name,
        async createWritable() {
          let local = [];
          return {
            async write(chunk) {
              local.push(new Uint8Array(chunk));
            },
            async close() {
              entry.bytes = local;
              entry.lastModified = Date.now();
              files.set(name, entry);
            },
          };
        },
        async getFile() {
          const total = entry.bytes.reduce((sum, bytes) => sum + bytes.length, 0);
          const buffer = new Uint8Array(total);
          let offset = 0;
          for (const bytes of entry.bytes) {
            buffer.set(bytes, offset);
            offset += bytes.length;
          }
          return { lastModified: entry.lastModified, name, size: total, _buffer: buffer };
        },
      };
    },
    async removeEntry(name) {
      if (!files.has(name)) {
        const err = new Error('not found');
        err.name = 'NotFoundError';
        throw err;
      }
      files.delete(name);
    },
    // eslint-disable-next-line require-yield
    async *keys() {
      for (const key of [...files.keys()]) {
        yield key;
      }
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

function removeFakeOpfs() {
  delete globalThis.navigator;
}

const bytesOf = (file) => Array.from(file._buffer);

test('isSupported 反映 navigator.storage.getDirectory 是否可用', () => {
  const mod = loadModule();
  removeFakeOpfs();
  assert.equal(mod.isSupported(), false);

  installFakeOpfs();
  try {
    assert.equal(mod.isSupported(), true);
  } finally {
    removeFakeOpfs();
  }
});

test('createOpfsSink 顺序写入并在 finalize 后可通过 readFile 取回', async () => {
  const mod = loadModule();
  const fake = installFakeOpfs();

  try {
    const sink = await mod.createOpfsSink({ name: 'ovd-stream-a' });
    await sink.write(new Uint8Array([1, 2]).buffer);
    await sink.write(new Uint8Array(0).buffer);
    await sink.write(new Uint8Array([3]).buffer);

    assert.equal(sink.mode, 'opfs');
    assert.equal(sink.byteLength, 3);
    assert.equal(sink.chunkCount, 2);

    const info = await sink.finalize();
    assert.deepEqual(info, { byteLength: 3, chunkCount: 2, mode: 'opfs', name: 'ovd-stream-a' });

    const file = await mod.readFile('ovd-stream-a');
    assert.equal(file.size, 3);
    assert.deepEqual(bytesOf(file), [1, 2, 3]);
    assert.ok(fake.files.has('ovd-stream-a'));
  } finally {
    removeFakeOpfs();
  }
});

test('createOpfsSink 在写入失败时抛 OPFS_WRITE_FAILED', async () => {
  const mod = loadModule();

  try {
    // 模拟写入时配额不足
    const brokenDir = {
      async getFileHandle(name) {
        return {
          name,
          async createWritable() {
            return {
              async write() {
                const err = new Error('quota exceeded');
                err.name = 'QuotaExceededError';
                throw err;
              },
              async close() {},
            };
          },
          async getFile() {
            return { lastModified: Date.now(), size: 0 };
          },
        };
      },
      async removeEntry() {},
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { storage: { async getDirectory() { return brokenDir; } } },
      writable: true,
    });

    const brokenSink = await mod.createOpfsSink({ name: 'ovd-stream-broken' });
    await assert.rejects(
      () => brokenSink.write(new Uint8Array([1]).buffer),
      (err) => {
        assert.equal(err.code, 'OPFS_WRITE_FAILED');
        assert.match(err.message, /配额/);
        return true;
      }
    );
  } finally {
    removeFakeOpfs();
  }
});

test('removeFile 删除文件，文件不存在时返回 false', async () => {
  const mod = loadModule();
  const fake = installFakeOpfs({ 'ovd-stream-x': {} });

  try {
    assert.equal(await mod.removeFile('ovd-stream-x'), true);
    assert.equal(fake.files.has('ovd-stream-x'), false);
    assert.equal(await mod.removeFile('ovd-stream-missing'), false);
    assert.equal(await mod.removeFile(''), false);
  } finally {
    removeFakeOpfs();
  }
});

test('createSpillSink 在阈值内保持内存模式并可用 toBlob', async () => {
  const mod = loadModule();
  installFakeOpfs();

  try {
    const sink = mod.createSpillSink({ name: 'ovd-stream-small', thresholdBytes: 1024 });
    await sink.write(new Uint8Array(100).buffer);
    await sink.write(new Uint8Array(100).buffer);

    assert.equal(sink.mode, 'memory');
    assert.equal(sink.byteLength, 200);

    const info = await sink.finalize();
    assert.deepEqual(info, { byteLength: 200, chunkCount: 2, mode: 'memory' });

    const blob = sink.toBlob('video/mp2t');
    assert.equal(blob.size, 200);
    assert.equal(blob.type, 'video/mp2t');
  } finally {
    removeFakeOpfs();
  }
});

test('createSpillSink 超过阈值后溢出到 OPFS，并把已缓冲内容一起落盘', async () => {
  const mod = loadModule();
  const fake = installFakeOpfs();

  try {
    const sink = mod.createSpillSink({ name: 'ovd-stream-big', thresholdBytes: 10 });
    await sink.write(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    assert.equal(sink.mode, 'memory');

    // 跨过阈值 → 触发溢出，之前的 5 字节也要一起写入 OPFS
    await sink.write(new Uint8Array([6, 7, 8, 9, 10, 11]).buffer);
    assert.equal(sink.mode, 'opfs');
    assert.equal(sink.byteLength, 11);
    assert.equal(sink.spillFailed, false);

    await sink.write(new Uint8Array([12]).buffer);
    const info = await sink.finalize();
    assert.deepEqual(info, { byteLength: 12, chunkCount: 3, mode: 'opfs', name: 'ovd-stream-big' });

    const file = await mod.readFile('ovd-stream-big');
    assert.deepEqual(bytesOf(file), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.ok(fake.files.has('ovd-stream-big'));

    // 已溢出后不允许再用内存出口
    assert.throws(() => sink.toBlob('video/mp2t'), /finalize/);
  } finally {
    removeFakeOpfs();
  }
});

test('createSpillSink 在 OPFS 不可用时退回内存且不影响后续写入', async () => {
  const mod = loadModule();
  removeFakeOpfs();

  try {
    const sink = mod.createSpillSink({ name: 'ovd-stream-nofs', thresholdBytes: 4 });
    await sink.write(new Uint8Array(8).buffer);

    assert.equal(sink.mode, 'memory');
    assert.equal(sink.spillFailed, true);
    assert.equal(sink.byteLength, 8);
    assert.equal(sink.toBlob().size, 8);
  } finally {
    removeFakeOpfs();
  }
});

test('createSpillSink.remove 清理 OPFS 临时文件', async () => {
  const mod = loadModule();
  const fake = installFakeOpfs();

  try {
    const sink = mod.createSpillSink({ name: 'ovd-stream-cleanup', thresholdBytes: 1 });
    await sink.write(new Uint8Array([1, 2]).buffer);
    assert.ok(fake.files.has('ovd-stream-cleanup'));

    await sink.remove();
    assert.equal(fake.files.has('ovd-stream-cleanup'), false);
  } finally {
    removeFakeOpfs();
  }
});

test('cleanupStale 只删除超过保留时间的前缀文件', async () => {
  const mod = loadModule();
  const now = Date.now();
  const fake = installFakeOpfs({
    'ovd-stream-old': { lastModified: now - 60 * 60 * 1000 },
    'ovd-stream-fresh': { lastModified: now - 1000 },
    'unrelated-file': { lastModified: now - 60 * 60 * 1000 },
  });

  try {
    const result = await mod.cleanupStale({ maxAgeMs: 10 * 60 * 1000, now });

    assert.deepEqual(result, { removed: 1, scanned: 2 });
    assert.equal(fake.files.has('ovd-stream-old'), false);
    assert.equal(fake.files.has('ovd-stream-fresh'), true);
    assert.equal(fake.files.has('unrelated-file'), true);
  } finally {
    removeFakeOpfs();
  }
});

test('cleanupStale 在不支持 OPFS 的环境直接返回零', async () => {
  const mod = loadModule();
  removeFakeOpfs();
  assert.deepEqual(await mod.cleanupStale(), { removed: 0, scanned: 0 });
});
