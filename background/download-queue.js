// background/download-queue.js
// 全局下载并发队列：所有后台下载（直链/HLS/DASH/YouTube parse）共享并发上限。
// 此前 concurrentDownloadLimit 仅在 popup 批量入口生效，其他入口可无限并发。

export class DownloadQueue {
  constructor({ limit = 3 } = {}) {
    this.limit = normalizeLimit(limit);
    this.active = 0;
    this.waiters = [];
  }

  setLimit(limit) {
    this.limit = normalizeLimit(limit);
    this._drain();
  }

  get activeCount() {
    return this.active;
  }

  get pendingCount() {
    return this.waiters.length;
  }

  acquire() {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this._drain();
  }

  async run(task, { signal = null } = {}) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    await this.acquire();
    try {
      if (signal?.aborted) {
        throw createAbortError();
      }
      return await task();
    } finally {
      this.release();
    }
  }

  /** 归还额度后唤醒等待中的任务（不改变 active，实际占用由被唤醒者保留） */
  _drain() {
    while (this.waiters.length > 0 && this.active < this.limit) {
      this.active++;
      const next = this.waiters.shift();
      next();
    }
  }
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) {
    return 3;
  }
  return Math.min(10, Math.floor(value));
}

function createAbortError() {
  const err = new Error('下载已取消');
  err.code = 'DOWNLOAD_ABORTED';
  return err;
}
