// background/opfs-temp-registry.js
// 登记 OPFS 落盘任务产生的临时文件（downloadId → 文件名），
// 供 service worker 在下载完成/中断后释放对象 URL 并删除文件。
// 不持久化：SW 重启前的下载已由 lib/opfs-sink.js 的 cleanupStale 兜底。

const tempFiles = new Map();

export function registerOpfsTempFile(downloadId, name) {
  if (downloadId == null || !name) {
    return false;
  }
  tempFiles.set(String(downloadId), { createdAt: Date.now(), name: String(name) });
  return true;
}

/** 取出并移除登记项（调用方负责真正清理） */
export function takeOpfsTempFile(downloadId) {
  const key = String(downloadId);
  const entry = tempFiles.get(key);
  if (!entry) {
    return null;
  }
  tempFiles.delete(key);
  return entry;
}

export function listOpfsTempFiles() {
  return [...tempFiles.values()];
}

export function clearOpfsTempFiles() {
  tempFiles.clear();
}
