// lib/opfs-sink.js
// OPFS 落盘 sink：把分片顺序写到扩展自身 origin 的 OPFS，避免 GB 级文件常驻内存。
// 与 lib/hls-pipeline.js 的 createInMemorySink 接口一致（write / byteLength / mode），
// 因此 downloadHlsSegments 的 sink 挂载点不需要改动。
// 以 <script> / side-effect import 方式加载，暴露全局 __OVD_OPFS_SINK__。

'use strict';

(() => {
  if (globalThis.__OVD_OPFS_SINK__) {
    return;
  }

  const DEFAULT_PREFIX = 'ovd-stream-';
  const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

  function storageManager() {
    try {
      return globalThis.navigator?.storage || null;
    } catch (_err) {
      return null;
    }
  }

  /** 仅检查 API 存在性；权限/配额问题在真正写入时才会暴露 */
  function isSupported() {
    return typeof storageManager()?.getDirectory === 'function';
  }

  async function openDirectory() {
    const storage = storageManager();
    if (!storage || typeof storage.getDirectory !== 'function') {
      const err = new Error('当前环境不支持 OPFS（navigator.storage.getDirectory 不可用）');
      err.code = 'OPFS_UNSUPPORTED';
      throw err;
    }
    return storage.getDirectory();
  }

  function createFileName(prefix = DEFAULT_PREFIX) {
    return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function listNames() {
    const dir = await openDirectory();
    const names = [];

    if (typeof dir.keys === 'function') {
      for await (const key of dir.keys()) {
        names.push(key);
      }
      return names;
    }

    if (typeof dir.entries === 'function') {
      for await (const [key] of dir.entries()) {
        names.push(key);
      }
      return names;
    }

    return names;
  }

  async function removeFile(name) {
    if (!name) {
      return false;
    }

    try {
      const dir = await openDirectory();
      await dir.removeEntry(name);
      return true;
    } catch (err) {
      if (err?.name === 'NotFoundError') {
        return false;
      }
      console.warn(`[OVD][OPFS] 删除临时文件失败 name=${name}: ${err.message}`);
      return false;
    }
  }

  async function readFile(name) {
    try {
      const dir = await openDirectory();
      const handle = await dir.getFileHandle(name);
      return await handle.getFile();
    } catch (err) {
      if (err?.name === 'NotFoundError') {
        return null;
      }
      throw err;
    }
  }

  /**
   * 清理残留临时文件（SW 启动/异常退出后遗留）。
   * 用文件的 lastModified 判断"多久没被写过"，避免误删正在写入的任务。
   */
  async function cleanupStale(options = {}) {
    const {
      maxAgeMs = DEFAULT_STALE_MS,
      now = Date.now(),
      prefix = DEFAULT_PREFIX,
    } = options;

    if (!isSupported()) {
      return { removed: 0, scanned: 0 };
    }

    let removed = 0;
    let scanned = 0;

    try {
      const dir = await openDirectory();
      for (const name of await listNames()) {
        if (!String(name).startsWith(prefix)) {
          continue;
        }
        scanned++;
        try {
          const handle = await dir.getFileHandle(name);
          const file = await handle.getFile();
          if (now - (file.lastModified || 0) > maxAgeMs) {
            await dir.removeEntry(name);
            removed++;
          }
        } catch (err) {
          if (err?.name !== 'NotFoundError') {
            console.warn(`[OVD][OPFS] 检查残留文件失败 name=${name}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[OVD][OPFS] 清理残留文件失败: ${err.message}`);
    }

    return { removed, scanned };
  }

  /** 纯 OPFS sink：顺序写入，finalize 后可用 name 交给 offscreen 生成对象 URL */
  async function createOpfsSink(options = {}) {
    const name = options.name || createFileName(options.prefix);
    const dir = await openDirectory();
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });

    let byteLength = 0;
    let chunkCount = 0;
    let closed = false;

    return {
      get byteLength() {
        return byteLength;
      },
      get chunkCount() {
        return chunkCount;
      },
      mode: 'opfs',
      name,
      supportsSpill: true,
      /**
       * 定位写入：Mp4Muxer 的流式输出会按绝对偏移写（含末尾写 moov），
       * OPFS 的 writable 支持 {type:'write', position}。
       */
      async writeAt(position, chunk) {
        if (!chunk || chunk.byteLength === 0) {
          return;
        }
        if (closed) {
          throw new Error('OPFS sink 已关闭，无法继续写入');
        }
        try {
          await writable.write({ type: 'write', position, data: chunk });
        } catch (err) {
          const wrapped = new Error(`OPFS 定位写入失败（可能是存储配额不足）: ${err.message}`);
          wrapped.code = 'OPFS_WRITE_FAILED';
          wrapped.cause = err;
          throw wrapped;
        }
        byteLength = Math.max(byteLength, Number(position) + chunk.byteLength);
        chunkCount++;
      },
      async write(chunk) {
        if (!chunk || chunk.byteLength === 0) {
          return;
        }
        if (closed) {
          throw new Error('OPFS sink 已关闭，无法继续写入');
        }
        try {
          await writable.write(chunk);
        } catch (err) {
          const wrapped = new Error(`OPFS 写入失败（可能是存储配额不足）: ${err.message}`);
          wrapped.code = 'OPFS_WRITE_FAILED';
          wrapped.cause = err;
          throw wrapped;
        }
        byteLength += chunk.byteLength;
        chunkCount++;
      },
      async finalize() {
        if (!closed) {
          closed = true;
          await writable.close();
        }
        return { byteLength, chunkCount, mode: 'opfs', name };
      },
      async remove() {
        try {
          if (!closed) {
            closed = true;
            await writable.close();
          }
        } catch (err) {
          console.warn(`[OVD][OPFS] 关闭写入失败 name=${name}: ${err.message}`);
        }
        return removeFile(name);
      },
    };
  }

  /**
   * 自适应 sink：小文件全程内存（快），累计超过 thresholdBytes 时把已缓冲内容
   * 一次性溢出到 OPFS 并继续落盘。溢出失败（不支持/配额）时退回纯内存，
   * 由调用方的体积守卫兜底，不影响既有小文件路径。
   */
  function createSpillSink(options = {}) {
    const {
      name = createFileName(options.prefix),
      thresholdBytes = 128 * 1024 * 1024,
    } = options;

    const chunks = [];
    let byteLength = 0;
    let opfs = null;
    let spillFailed = false;
    let spillPromise = null;

    async function spill() {
      if (opfs || spillFailed) {
        return opfs;
      }
      if (spillPromise) {
        return spillPromise;
      }

      spillPromise = (async () => {
        if (!isSupported()) {
          spillFailed = true;
          console.warn('[OVD][OPFS] 环境不支持 OPFS，继续使用内存缓冲');
          return null;
        }

        try {
          const sink = await createOpfsSink({ name });
          for (const chunk of chunks) {
            await sink.write(chunk);
          }
          chunks.length = 0;
          opfs = sink;
          console.log(`[OVD][OPFS] 超过 ${Math.round(thresholdBytes / 1024 / 1024)} MB，已切换为落盘 name=${name}`);
          return opfs;
        } catch (err) {
          spillFailed = true;
          console.warn(`[OVD][OPFS] 溢出到 OPFS 失败，继续使用内存缓冲: ${err.message}`);
          return null;
        }
      })();

      return spillPromise;
    }

    return {
      get byteLength() {
        return byteLength;
      },
      get chunkCount() {
        return (opfs?.chunkCount || 0) + chunks.length;
      },
      get mode() {
        return opfs ? 'opfs' : 'memory';
      },
      get name() {
        return opfs?.name || name;
      },
      get spillFailed() {
        return spillFailed;
      },
      supportsSpill: true,
      async write(chunk) {
        if (!chunk || chunk.byteLength === 0) {
          return;
        }

        if (opfs) {
          await opfs.write(chunk);
          byteLength += chunk.byteLength;
          return;
        }

        chunks.push(chunk);
        byteLength += chunk.byteLength;

        if (byteLength > thresholdBytes) {
          await spill();
        }
      },
      /** 主动触发溢出（调用方在开始前就知道这是大文件时可用） */
      spill,
      /** 内存出口；已溢出时抛错，调用方应改用 finalize() */
      toBlob(mimeType = 'application/octet-stream') {
        if (opfs) {
          throw new Error('sink 已溢出到 OPFS，请使用 finalize()');
        }
        const blob = new Blob(chunks, { type: mimeType });
        chunks.length = 0;
        return blob;
      },
      async finalize() {
        if (opfs) {
          return opfs.finalize();
        }
        return { byteLength, chunkCount: chunks.length, mode: 'memory' };
      },
      async remove() {
        chunks.length = 0;
        if (opfs) {
          await opfs.remove();
          opfs = null;
        }
      },
    };
  }

  globalThis.__OVD_OPFS_SINK__ = {
    cleanupStale,
    createFileName,
    createOpfsSink,
    createSpillSink,
    isSupported,
    listNames,
    readFile,
    removeFile,
  };
})();
