// background/session-mirror.js
// chrome.storage.session 薄镜像层：内存状态去抖写入，SW 重启后读回恢复。
// storage.session 随浏览器会话清除、默认不落盘，适合存放任务/注册表快照。
// storage 后端可注入，便于测试。

export class SessionMirror {
  /**
   * @param {string} key - storage 键名
   * @param {Object} [options]
   * @param {Object} [options.storage] - 默认 chrome.storage.session
   * @param {number} [options.debounceMs] - 写入去抖间隔
   */
  constructor(key, { storage, debounceMs = 250 } = {}) {
    this._key = key;
    this._storage = storage ?? (globalThis.chrome?.storage?.session || null);
    this._debounceMs = debounceMs;
    this._timer = null;
    this._pending = undefined;
    this._writing = Promise.resolve();
  }

  /** 去抖调度写入，只保留最新快照 */
  scheduleSave(value) {
    if (!this._storage) return;
    this._pending = value;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.flush();
    }, this._debounceMs);
    this._timer.unref?.();
  }

  /** 立即写入待保存快照 */
  async flush() {
    if (!this._storage) return;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._pending === undefined) return;
    const value = this._pending;
    this._pending = undefined;
    // 串行化写入，避免并发 set 乱序覆盖
    this._writing = this._writing.then(async () => {
      try {
        await this._storage.set({ [this._key]: value });
      } catch (err) {
        console.warn(`[OVD] session mirror save failed key=${this._key}: ${err.message}`);
      }
    });
    return this._writing;
  }

  /** 读回快照，不存在返回 undefined */
  async load() {
    if (!this._storage) return undefined;
    try {
      const items = await this._storage.get([this._key]);
      return items?.[this._key];
    } catch (err) {
      console.warn(`[OVD] session mirror load failed key=${this._key}: ${err.message}`);
      return undefined;
    }
  }
}
