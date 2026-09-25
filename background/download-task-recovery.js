// background/download-task-recovery.js
// SW 重启后的任务恢复：从持久化快照重建的任务表中，
// 对"进行中"任务逐一核对 chrome.downloads 实际状态并修正。

/**
 * @param {DownloadStateStore} downloadStore
 * @param {Object} deps
 * @param {(downloadId: number) => Promise<Object|null>} deps.getDownloadItem - chrome.downloads.search 包装
 * @param {(downloadId: number, tabId: number, reason: string) => Promise<boolean>} deps.tryResumeDownload - 自动续传（内部重新排程定时器）
 * @param {(task: Object|null) => void} [deps.onTaskUpdate] - 任务状态变更回调（广播用）
 * @returns {Promise<{resumed: number, interrupted: number, ghost: number, completed: number, completedTasks: Object[]}>}
 */
export async function recoverDownloadTasks(downloadStore, {
  getDownloadItem,
  tryResumeDownload,
  onTaskUpdate = () => {},
} = {}) {
  const result = { resumed: 0, interrupted: 0, ghost: 0, completed: 0, completedTasks: [] };
  const tasks = downloadStore.getTasks({ limit: 500 });

  for (const task of tasks) {
    if (!['running', 'retrying'].includes(task.status)) continue;

    // 无 downloadId 的是 SW/页面内执行的任务（双流抓取、合并等），
    // SW 被杀即中断，标记为可重试而非永远 running
    if (task.downloadId == null) {
      onTaskUpdate(downloadStore.upsertTask({
        taskId: task.taskId,
        status: 'interrupted',
        error: '扩展后台已重启，任务中断，请重试',
      }));
      result.interrupted++;
      continue;
    }

    const item = await getDownloadItem(task.downloadId);

    // 浏览器下载记录已不存在，避免幽灵任务
    if (!item) {
      onTaskUpdate(downloadStore.upsertTask({
        taskId: task.taskId,
        status: 'failed',
        error: '浏览器下载记录已不存在',
      }));
      result.ghost++;
      continue;
    }

    // SW 回收期间中断且可续传的，重新走自动 resume（定时器随 SW 丢失需重排）
    if (item.state === 'interrupted') {
      const resumed = await tryResumeDownload(task.downloadId, task.tabId, item.error || 'interrupted');
      if (resumed) {
        result.resumed++;
      } else {
        onTaskUpdate(downloadStore.upsertTask({
          taskId: task.taskId,
          status: 'failed',
          error: item.error || 'interrupted',
        }));
      }
      continue;
    }

    // SW 回收期间已完成的，补齐终态
    if (item.state === 'complete') {
      downloadStore.markComplete(task.downloadId);
      const completedTask = downloadStore.updateTaskByDownloadId(task.downloadId, {
        percent: 100,
        status: 'complete',
      });
      onTaskUpdate(completedTask);
      result.completed++;
      if (completedTask) {
        result.completedTasks.push(completedTask);
      }
    }
    // item.state === 'in_progress'：映射已由 restoreTasks 重建，等 onChanged 继续推进
  }

  return result;
}
