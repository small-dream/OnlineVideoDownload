// background/download-history-store.js
// 下载历史持久化存储，ES Module，仅用于 Service Worker

const HISTORY_STORAGE_KEY = 'ovd.downloadHistory';
const MAX_RECORDS = 100;

function normalizePath(value) {
  return String(value || '').trim();
}

function normalizeRecord(record = {}, fallback = {}) {
  return {
    id: record.id || fallback.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    downloadId: record.downloadId ?? fallback.downloadId ?? null,
    taskId: record.taskId || fallback.taskId || '',
    url: record.url || fallback.url || '',
    title: record.title || fallback.title || '',
    type: record.type || fallback.type || 'direct',
    filename: record.filename || fallback.filename || '',
    size: record.size ?? fallback.size ?? null,
    timestamp: record.timestamp || fallback.timestamp || Date.now(),
    tabUrl: record.tabUrl || fallback.tabUrl || '',
    status: record.status || fallback.status || 'complete',
  };
}

export class DownloadHistoryStore {
  constructor() {
    this._records = [];
  }

  async init() {
    try {
      const items = await chrome.storage.local.get([HISTORY_STORAGE_KEY]);
      const data = items[HISTORY_STORAGE_KEY];
      if (data && Array.isArray(data.records)) {
        this._records = data.records;
      }
    } catch (err) {
      console.warn('[OVD][history-store] init failed:', err);
      this._records = [];
    }
  }

  async addRecord(record) {
    const existingIndex = this._findDuplicateIndex(record);
    if (existingIndex >= 0) {
      const existing = this._records[existingIndex];
      const merged = normalizeRecord(record, existing);
      this._records.splice(existingIndex, 1);
      this._records.unshift(merged);
    } else {
      this._records.unshift(normalizeRecord(record));
    }

    this._enforceLimit();
    await this._persist();
  }

  async getAll() {
    return [...this._records];
  }

  async clear() {
    this._records = [];
    await this._persist();
  }

  async deleteRecord(id) {
    const before = this._records.length;
    this._records = this._records.filter((r) => r.id !== id);
    if (this._records.length < before) {
      await this._persist();
    }
  }

  async prune(retentionDays) {
    if (!retentionDays || retentionDays <= 0) {
      return;
    }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const before = this._records.length;
    this._records = this._records.filter((r) => r.timestamp >= cutoff);

    if (this._records.length < before) {
      await this._persist();
    }
  }

  _enforceLimit() {
    if (this._records.length > MAX_RECORDS) {
      this._records = this._records.slice(0, MAX_RECORDS);
    }
  }

  _findDuplicateIndex(record = {}) {
    const downloadId = record.downloadId ?? null;
    if (downloadId != null) {
      const index = this._records.findIndex((item) => item.downloadId === downloadId);
      if (index >= 0) {
        return index;
      }
    }

    const taskId = String(record.taskId || '').trim();
    if (taskId) {
      const index = this._records.findIndex((item) => String(item.taskId || '').trim() === taskId);
      if (index >= 0) {
        return index;
      }
    }

    const filename = normalizePath(record.filename);
    if (filename) {
      const index = this._records.findIndex((item) => {
        if (normalizePath(item.filename) !== filename) {
          return false;
        }

        const itemDownloadId = item.downloadId ?? null;
        if (downloadId != null && itemDownloadId != null && itemDownloadId !== downloadId) {
          return false;
        }

        const itemTaskId = String(item.taskId || '').trim();
        if (taskId && itemTaskId && itemTaskId !== taskId) {
          return false;
        }

        return true;
      });
      if (index >= 0) {
        return index;
      }
    }
    return -1;
  }

  async _persist() {
    try {
      await chrome.storage.local.set({
        [HISTORY_STORAGE_KEY]: { records: this._records },
      });
    } catch (err) {
      console.warn('[OVD][history-store] persist failed:', err);
    }
  }
}
