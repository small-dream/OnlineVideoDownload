// background/download-queue.js
// 全局下载并发队列：所有下载入口（后台直链/HLS/DASH/YouTube，以及内容侧的
// Bilibili/YouTube 页面内下载）共享同一个并发上限 concurrentDownloadLimit。
//
// 每个等待/进行中的下载都是一个"条目"，因此队列对外可观测：
//   - snapshot() 让 Popup 显示「排队中（第 N 位）」并支持取消排队；
//   - owner 归属（后台 / Popup 端口）让连接断开时能回收槽位，避免泄漏。
//
// 注意：队列状态在 Service Worker 内存里，SW 被回收后重新开始计数（已确认的
// 浏览器下载由 chrome.downloads 自己管理，不受影响）。

export class DownloadQueue {
  constructor({ limit = 3, now = null } = {}) {
    this.limit = normalizeLimit(limit);
    this.active = 0;
    this._entries = new Map();
    this._waiters = [];
    this._sequence = 0;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._listeners = new Set();
  }

  setLimit(limit) {
    const next = normalizeLimit(limit);
    if (next !== this.limit) {
      this.limit = next;
      this._drain();
      this._notify();
      return;
    }
    this._drain();
  }

  get activeCount() {
    return this.active;
  }

  get pendingCount() {
    return this._waiters.length;
  }

  /** 订阅队列变化（SW 用它广播给 Popup），返回取消订阅函数。 */
  onChange(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * 申请一个下载槽位：限额未满立即放行，否则排队等待。
   * @param {{ id?: string, label?: string, owner?: string, sourceId?: string, tabId?: number, videoUrl?: string }} [entry]
   * @returns {Promise<{ id: string, position: number }>} 放行时 resolve（position 恒为 0）
   */
  acquire(entry = {}) {
    const id = String(entry.id || `slot-${++this._sequence}`);
    const record = {
      enqueuedAt: this._now(),
      id,
      label: entry.label || '',
      owner: entry.owner || 'anonymous',
      sourceId: entry.sourceId || '',
      state: 'queued',
      tabId: entry.tabId ?? null,
      videoUrl: entry.videoUrl || '',
    };
    this._entries.set(id, record);

    if (this.active < this.limit) {
      return Promise.resolve(this._admit(id));
    }

    return new Promise((resolve, reject) => {
      this._waiters.push({ id, reject, resolve });
      this._notify();
    });
  }

  _admit(id) {
    const record = this._entries.get(id);
    if (!record) {
      return null;
    }
    record.state = 'running';
    this.active++;
    this._notify();
    return { id, position: 0 };
  }

  /** 归还槽位（幂等）；等待中的条目会被移出队列并 reject。 */
  release(id) {
    const key = String(id || '');
    const record = this._entries.get(key);
    if (!record) {
      return false;
    }

    this._entries.delete(key);
    if (record.state === 'running') {
      this.active = Math.max(0, this.active - 1);
      this._drain();
    } else {
      this._rejectWaiter(key, createAbortError('下载已取消'));
    }
    this._notify();
    return true;
  }

  /** 取消仍在排队（尚未开始）的条目；已开始的条目返回 false。 */
  cancelQueued(id) {
    const key = String(id || '');
    const record = this._entries.get(key);
    if (!record || record.state !== 'queued') {
      return false;
    }
    this._entries.delete(key);
    this._rejectWaiter(key, createAbortError('已取消排队'));
    this._notify();
    return true;
  }

  /** 释放某个归属（例如 Popup 端口断开）持有的全部条目。 */
  releaseOwner(owner) {
    const key = String(owner || '');
    if (!key) {
      return 0;
    }
    const ids = [...this._entries.values()]
      .filter((record) => record.owner === key)
      .map((record) => record.id);
    ids.forEach((id) => this.release(id));
    return ids.length;
  }

  /** 队列中该条目的等待位次（从 1 开始）；不等候时返回 0。 */
  positionOf(id) {
    const key = String(id || '');
    const index = this._waiters.findIndex((waiter) => waiter.id === key);
    return index < 0 ? 0 : index + 1;
  }

  /** 队列快照：供 Popup 展示「进行中 / 排队中（第 N 位）」。 */
  snapshot() {
    const running = [];
    for (const record of this._entries.values()) {
      if (record.state === 'running') {
        running.push(cloneEntry(record, 0));
      }
    }
    const queued = [];
    this._waiters.forEach((waiter, index) => {
      const record = this._entries.get(waiter.id);
      if (record) {
        queued.push(cloneEntry(record, index + 1));
      }
    });
    return {
      active: this.active,
      entries: [...running, ...queued],
      limit: this.limit,
      pending: this._waiters.length,
    };
  }

  /** 兼容旧入口：申请槽位后执行任务，结束（含异常）一定归还槽位。 */
  async run(task, { signal = null, entry = null } = {}) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const record = { ...(entry || {}) };
    if (!record.id) {
      record.id = `run-${++this._sequence}`;
    }

    const onAbort = () => {
      this.cancelQueued(record.id);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    try {
      await this.acquire(record);
      if (signal?.aborted) {
        throw createAbortError();
      }
      return await task();
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
      this.release(record.id);
    }
  }

  _rejectWaiter(id, error) {
    const index = this._waiters.findIndex((waiter) => waiter.id === id);
    if (index < 0) {
      return;
    }
    const [waiter] = this._waiters.splice(index, 1);
    waiter.reject(error);
  }

  /** 归还额度后唤醒等待中的任务（不改变 active，实际占用由被唤醒者保留） */
  _drain() {
    while (this._waiters.length > 0 && this.active < this.limit) {
      const waiter = this._waiters.shift();
      const record = this._entries.get(waiter.id);
      if (!record) {
        continue;
      }
      record.state = 'running';
      this.active++;
      waiter.resolve({ id: record.id, position: 0 });
    }
  }

  _notify() {
    if (this._listeners.size === 0) {
      return;
    }
    const snapshot = this.snapshot();
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        // 监听者异常不应影响队列本身
        console.warn(`[OVD] 下载队列监听器异常: ${err?.message || err}`);
      }
    }
  }
}

function cloneEntry(record, position) {
  return {
    enqueuedAt: record.enqueuedAt,
    id: record.id,
    label: record.label,
    owner: record.owner,
    position,
    sourceId: record.sourceId,
    state: record.state,
    tabId: record.tabId,
    videoUrl: record.videoUrl,
  };
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) {
    return 3;
  }
  return Math.min(10, Math.floor(value));
}

function createAbortError(message = '下载已取消') {
  const err = new Error(message);
  err.code = 'DOWNLOAD_ABORTED';
  return err;
}
