export class DownloadStateStore {
  constructor(snapshotMirror = null) {
    this._states = new Map();
    this._tasks = new Map();
    this._cleanupFns = new Map();
    this._deleteTimers = new Map();
    this._cleanupTimers = new Map();
    this._taskDeleteTimers = new Map();
    this._deletedDownloadIds = new Set();
    this._deletedTaskIds = new Set();
    this._deletedTraceIds = new Set();
    this._nextTaskOrder = 1;
    // SessionMirror 实例，任务变更自动镜像到 storage.session，供 SW 重启恢复
    this._mirror = snapshotMirror;
  }

  registerResult(result, context) {
    if (!context?.tabId) return;

    this.registerDownload(result?.downloadId, {
      tabId: context.tabId,
      requiresTabContext: !!context.requiresTabContext,
      videoUrl: context.videoUrl,
      cleanupRules: result?.cleanupRules,
      sourceId: context.sourceId,
      strategyId: context.strategyId,
      taskId: context.taskId,
      title: context.title,
      videoInfo: context.videoInfo,
    });

    if (Array.isArray(result?.results)) {
      for (const entry of result.results) {
        this.registerDownload(entry?.downloadId, {
          tabId: context.tabId,
          requiresTabContext: !!context.requiresTabContext,
          videoUrl: context.videoUrl,
          cleanupRules: entry?.cleanupRules,
          sourceId: context.sourceId,
          strategyId: context.strategyId,
          taskId: context.taskId,
          title: context.title,
          videoInfo: context.videoInfo,
        });
      }
    }
  }

  registerDownload(downloadId, {
    cleanupRules,
    sourceId,
    strategyId,
    tabId,
    taskId,
    title,
    videoInfo,
    videoUrl,
    requiresTabContext = true,
  } = {}) {
    if (downloadId == null || !tabId) return;

    this._deletedDownloadIds.delete(downloadId);
    this._clearDeleteTimer(downloadId);
    this._states.set(downloadId, {
      requiresTabContext: !!requiresTabContext,
      tabId,
      videoUrl: videoUrl || '',
      percent: 0,
      state: 'downloading',
    });

    this.upsertTask({
      downloadId,
      percent: 0,
      sourceId,
      status: 'running',
      strategyId,
      requiresTabContext: !!requiresTabContext,
      tabId,
      taskId,
      title,
      videoInfo,
      videoUrl,
    });

    if (typeof cleanupRules === 'function') {
      this._cleanupFns.set(downloadId, cleanupRules);
    }
  }

  getTabId(downloadId) {
    return this._states.get(downloadId)?.tabId ?? null;
  }

  update(downloadId, updates) {
    if (this.isDeletedDownload(downloadId)) return null;
    const existing = this._states.get(downloadId);
    if (!existing) return null;

    Object.assign(existing, updates);
    this.updateTaskByDownloadId(downloadId, {
      ...updates,
      status: this._stateToStatus(updates.state),
    });
    return existing;
  }

  markFailed(downloadId) {
    return this.update(downloadId, { percent: 0, state: 'failed' });
  }

  markComplete(downloadId) {
    this.update(downloadId, { percent: 100, state: 'complete' });
  }

  scheduleRuleCleanup(downloadId, delayMs = 3000) {
    this._clearCleanupTimer(downloadId);
    const timer = setTimeout(() => {
      this._cleanupTimers.delete(downloadId);
      this.cleanupRules(downloadId);
    }, delayMs);
    this._cleanupTimers.set(downloadId, timer);
  }

  cleanupRules(downloadId) {
    this._clearCleanupTimer(downloadId);
    const cleanup = this._cleanupFns.get(downloadId);
    if (!cleanup) return;

    this._cleanupFns.delete(downloadId);
    cleanup().catch((err) => {
      console.warn(`[OVD] failed to cleanup download rules downloadId=${downloadId}: ${err.message}`);
    });
  }

  scheduleDelete(downloadId, delayMs = 30000) {
    this._clearDeleteTimer(downloadId);
    const timer = setTimeout(() => {
      this._deleteTimers.delete(downloadId);
      this.delete(downloadId);
    }, delayMs);
    this._deleteTimers.set(downloadId, timer);
  }

  scheduleTaskDelete(taskId, delayMs = 30 * 60 * 1000) {
    if (!taskId) return;
    this._clearTaskDeleteTimer(taskId);
    const timer = setTimeout(() => {
      this._taskDeleteTimers.delete(taskId);
      this.deleteTask(taskId);
    }, delayMs);
    timer.unref?.();
    this._taskDeleteTimers.set(taskId, timer);
  }

  getStatesForTab(tabId) {
    const states = {};
    for (const [downloadId, info] of this._states) {
      if (info.tabId === tabId) {
        states[downloadId] = { ...info };
      }
    }
    return states;
  }

  getTasks({ tabId = null, limit = 50 } = {}) {
    const tasks = [...this._tasks.values()]
      .filter((task) => tabId == null || task.tabId === tabId || this._isRecentTask(task))
      .sort((a, b) => {
        const orderDiff = (b.sortOrder || 0) - (a.sortOrder || 0);
        if (orderDiff !== 0) {
          return orderDiff;
        }
        const createdDiff = (b.createdAt || 0) - (a.createdAt || 0);
        if (createdDiff !== 0) {
          return createdDiff;
        }
        return String(b.taskId || '').localeCompare(String(a.taskId || ''));
      })
      .slice(0, limit)
      .map((task) => this._cloneTask(task));

    return tasks;
  }

  getTask(taskId) {
    const task = this._tasks.get(taskId);
    return task ? this._cloneTask(task) : null;
  }

  upsertTask(input = {}) {
    if (this.isDeletedTaskIdentity(input)) return null;
    const existing = this._findTask(input);
    const now = Date.now();
    const taskId = existing?.taskId || input.taskId || this._buildTaskId(input);
    this._deletedTaskIds.delete(taskId);
    if (input.traceId) {
      this._deletedTraceIds.delete(input.traceId);
    }
    const nextStatus = input.status || existing?.status || 'running';
    const nextPercent = input.percent ?? existing?.percent ?? 0;
    const inputTitle = this._isGenericTitle(input.title) ? '' : input.title;
    const inputFilename = this._isGenericTitle(input.filename) ? '' : input.filename;
    const next = {
      ...(existing || {}),
      createdAt: existing?.createdAt || input.createdAt || now,
      downloadId: input.downloadId ?? existing?.downloadId ?? null,
      error: input.error ?? existing?.error ?? '',
      filename: input.filename ?? existing?.filename ?? '',
      message: input.message ?? existing?.message ?? '',
      percent: this._normalizePercent(nextPercent),
      phase: input.phase ?? existing?.phase ?? '',
      size: input.size ?? existing?.size ?? null,
      sortOrder: existing?.sortOrder || input.sortOrder || this._nextTaskOrder++,
      sourceId: input.sourceId || existing?.sourceId || 'unknown',
      status: nextStatus,
      strategyId: input.strategyId || existing?.strategyId || '',
      requiresTabContext: input.requiresTabContext ?? existing?.requiresTabContext ?? true,
      tabId: input.tabId ?? existing?.tabId ?? null,
      taskId,
      taskKey: input.taskKey || existing?.taskKey || '',
      title: inputTitle || existing?.title || inputFilename || existing?.filename || input.title || '',
      traceId: input.traceId || existing?.traceId || '',
      updatedAt: now,
      videoInfo: input.videoInfo || existing?.videoInfo || null,
      videoUrl: input.videoUrl || existing?.videoUrl || input.url || '',
    };

    if (next.status === 'complete') {
      next.percent = 100;
      next.error = '';
    }

    if (next.status === 'running' || next.status === 'retrying') {
      next.error = input.error ?? '';
    }

    if (next.status === 'failed' || next.status === 'interrupted') {
      next.error = input.error || next.error;
    }

    this._tasks.set(taskId, next);
    if (['complete', 'failed', 'interrupted'].includes(next.status)) {
      this.scheduleTaskDelete(taskId);
    } else {
      this._clearTaskDeleteTimer(taskId);
    }

    this._persistTasks();
    return this._cloneTask(next);
  }

  /** 任务表镜像到 storage.session（去抖写入） */
  _persistTasks() {
    this._mirror?.scheduleSave([...this._tasks.values()].map((task) => this._cloneTask(task)));
  }

  /**
   * SW 启动时从快照恢复任务表，重建 downloadId→tabId 映射。
   * SW 回收期间 scheduleTaskDelete 定时器丢失，过期终态任务在恢复时直接清理。
   * @returns {number} 恢复的任务数
   */
  restoreTasks(tasks = []) {
    if (!Array.isArray(tasks)) return 0;
    const now = Date.now();
    let restored = 0;

    for (const raw of tasks) {
      if (!raw?.taskId) continue;
      if (
        ['complete', 'failed', 'interrupted'].includes(raw.status) &&
        now - (raw.updatedAt || 0) > 30 * 60 * 1000
      ) {
        continue;
      }

      this._tasks.set(raw.taskId, { ...raw });
      this._nextTaskOrder = Math.max(this._nextTaskOrder, (raw.sortOrder || 0) + 1);
      restored++;

      // 仅进行中的浏览器下载需要重建 downloadId→tabId 映射供 onChanged 使用
      if (raw.downloadId != null && ['running', 'retrying'].includes(raw.status)) {
        this._states.set(raw.downloadId, {
          requiresTabContext: raw.requiresTabContext !== false,
          tabId: raw.tabId ?? null,
          videoUrl: raw.videoUrl || '',
          percent: raw.percent || 0,
          state: raw.status === 'retrying' ? 'retrying' : 'downloading',
        });
      }
    }

    if (restored) {
      this._persistTasks();
    }
    return restored;
  }

  updateTaskByDownloadId(downloadId, updates = {}) {
    if (downloadId == null) return null;
    const existing = this._findTask({ downloadId });
    const hasCreateMetadata = updates.tabId != null || updates.videoUrl || updates.title || updates.videoInfo || updates.taskId;
    if (!existing && !hasCreateMetadata) {
      return null;
    }
    return this.upsertTask({ ...updates, downloadId });
  }

  updateTaskByVideoUrl(videoUrl, updates = {}) {
    if (!videoUrl) return null;
    return this.upsertTask({ ...updates, videoUrl });
  }

  updateSourceTask(message = {}, tabId = null) {
    return this.upsertTask({
      downloadId: message.downloadId ?? null,
      error: message.error || '',
      filename: message.filename || '',
      message: message.message || '',
      percent: message.percent,
      phase: message.phase || '',
      size: message.size ?? null,
      sourceId: message.sourceId || 'unknown',
      status: message.status || 'running',
      strategyId: message.strategyId || '',
      tabId,
      taskKey: message.taskKey || '',
      title: message.title || '',
      traceId: message.traceId || '',
      videoInfo: message.videoInfo || null,
      videoUrl: message.videoUrl || '',
    });
  }

  markTabInterrupted(tabId, message = '原标签页已关闭，任务中断') {
    const interrupted = [];
    for (const task of this._tasks.values()) {
      if (
        task.tabId !== tabId ||
        !['running', 'retrying'].includes(task.status) ||
        task.requiresTabContext === false
      ) {
        continue;
      }
      interrupted.push(this.upsertTask({
        error: message,
        status: 'interrupted',
        taskId: task.taskId,
      }));
    }
    return interrupted;
  }

  clearTab(tabId, options = {}) {
    const { onlyRequiresTabContext = false } = options;
    for (const [downloadId, info] of this._states) {
      if (info.tabId !== tabId) continue;
      if (onlyRequiresTabContext && info.requiresTabContext === false) {
        continue;
      }
      this.cleanupRules(downloadId);
      this.delete(downloadId);
    }
  }

  delete(downloadId) {
    this._clearCleanupTimer(downloadId);
    this._clearDeleteTimer(downloadId);
    this._cleanupFns.delete(downloadId);
    this._states.delete(downloadId);
  }

  deleteTask(taskId, options = {}) {
    const { tombstone = false } = options;
    const task = this._tasks.get(taskId);
    if (tombstone) {
      this._deletedTaskIds.add(taskId);
    }
    if (task?.downloadId != null) {
      if (tombstone) {
        this._deletedDownloadIds.add(task.downloadId);
      }
      this.delete(task.downloadId);
    }
    if (tombstone && task?.traceId) {
      this._deletedTraceIds.add(task.traceId);
    }
    this._clearTaskDeleteTimer(taskId);
    this._tasks.delete(taskId);
    this._persistTasks();
  }

  isDeletedDownload(downloadId) {
    return this._deletedDownloadIds.has(downloadId);
  }

  isDeletedTaskIdentity(input = {}) {
    return Boolean(
      (input.taskId && this._deletedTaskIds.has(input.taskId)) ||
      (input.traceId && this._deletedTraceIds.has(input.traceId)) ||
      (input.downloadId != null && this._deletedDownloadIds.has(input.downloadId))
    );
  }

  _clearDeleteTimer(downloadId) {
    const timer = this._deleteTimers.get(downloadId);
    if (timer) {
      clearTimeout(timer);
      this._deleteTimers.delete(downloadId);
    }
  }

  _clearCleanupTimer(downloadId) {
    const timer = this._cleanupTimers.get(downloadId);
    if (timer) {
      clearTimeout(timer);
      this._cleanupTimers.delete(downloadId);
    }
  }

  _clearTaskDeleteTimer(taskId) {
    const timer = this._taskDeleteTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this._taskDeleteTimers.delete(taskId);
    }
  }

  _buildTaskId(input = {}) {
    if (input.downloadId != null) {
      return `download:${input.downloadId}`;
    }
    if (input.traceId) {
      return `trace:${input.traceId}`;
    }
    if (input.taskKey) {
      return `task:${input.sourceId || 'source'}:${input.taskKey}`;
    }
    const seed = input.videoUrl || input.url || input.title || 'task';
    return `task:${Date.now()}:${Math.random().toString(36).slice(2)}:${String(seed).slice(0, 24)}`;
  }

  _cloneTask(task) {
    return {
      ...task,
      videoInfo: task.videoInfo ? { ...task.videoInfo } : null,
    };
  }

  _findTask(input = {}) {
    if (input.taskId && this._tasks.has(input.taskId)) {
      return this._tasks.get(input.taskId);
    }
    for (const task of this._tasks.values()) {
      if (input.downloadId != null && task.downloadId === input.downloadId) {
        return task;
      }
      if (input.traceId && task.traceId === input.traceId) {
        return task;
      }
      if (input.taskKey && task.taskKey === input.taskKey && (!input.sourceId || task.sourceId === input.sourceId)) {
        return task;
      }
      if (
        input.videoUrl &&
        task.videoUrl === input.videoUrl &&
        (input.tabId == null || task.tabId == null || task.tabId === input.tabId)
      ) {
        return task;
      }
    }
    return null;
  }

  _isRecentTask(task) {
    const ageMs = Date.now() - (task.updatedAt || 0);
    return ageMs <= 30 * 60 * 1000;
  }

  _normalizePercent(percent) {
    const value = Number(percent);
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  _isGenericTitle(value) {
    return ['Download task', '下载任务'].includes(String(value || '').trim());
  }

  _stateToStatus(state) {
    if (state === 'downloading') return 'running';
    if (state === 'retrying') return 'retrying';
    if (state === 'complete') return 'complete';
    if (state === 'failed') return 'failed';
    return undefined;
  }
}
