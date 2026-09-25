// background/service-worker.js
// Service Worker 主入口：统一消息路由、下载状态管理、流数据抓取中转。

import { VideoRegistry } from './video-registry.js';
import { RequestInterceptor } from './request-interceptor.js';
import { Downloader } from './downloader.js';
import { DownloadStateStore } from './download-state-store.js';
import { DownloadHistoryStore } from './download-history-store.js';
import { SessionMirror } from './session-mirror.js';
import { recoverDownloadTasks } from './download-task-recovery.js';
import { DownloadNotificationManager } from './download-notification.js';
import { createTabBadgeManager } from './action-badge.js';
import { resolveClearVideoScope } from './clear-video-scope.js';
import { DownloadQueue } from './download-queue.js';
import { resolveSaveAs } from './save-location.js';
import { releaseOpfsDownload } from './offscreen-download.js';
import { takeOpfsTempFile } from './opfs-temp-registry.js';
import { cleanupAllRules, injectHeaders } from './header-injector.js';
import {
  browserInfo,
  resumeDownloadAsync,
  safeRuntimeMessage,
  safeTabMessage,
  sendTabMessageAsync,
  supportsDownloadResume,
} from '../lib/browser-compat.module.js';

import '../lib/byte-utils.js';
import '../lib/http-utils.js';
import '../lib/constants.js';
import '../lib/download-path.js';
import '../lib/message-types.js';
import '../lib/settings-store.js';
import '../lib/video-filter.js';
import '../lib/opfs-sink.js';
import '../lib/page-message-guard.js';

const byteUtils = globalThis.__OVD_BYTE_UTILS__ || {};
const httpUtils = globalThis.__OVD_HTTP_UTILS__ || {};
const constants = globalThis.__OVD_CONSTANTS__ || {};
const downloadPathUtils = globalThis.__OVD_DOWNLOAD_PATH__ || {};
const messageRuntime = globalThis.__OVD_MESSAGE_TYPES__ || {};
const messageTypes = messageRuntime.MESSAGE_TYPES || {};
const assertValidMessage = messageRuntime.assertValidMessage || ((message) => message);
const toErrorResponse = messageRuntime.toErrorResponse || ((error) => ({ ok: false, error: error?.message || String(error) }));
const toMessageResponse = messageRuntime.toMessageResponse || ((result) => ({ ok: true, ...(result || {}) }));
const MSG = messageTypes;

function parseContentRangeTotalFallback(contentRange) {
  const match = String(contentRange || '').match(/\/(\d+)$/);
  return match ? Number(match[1]) || 0 : 0;
}

function inferTotalBytesFromResponseFallback(response, loadedBytesBefore = 0, fallbackTotal = 0) {
  const contentRangeTotal = parseContentRangeTotalFallback(response?.headers?.get?.('content-range'));
  if (contentRangeTotal > 0) {
    return contentRangeTotal;
  }

  const contentLength = Number(response?.headers?.get?.('content-length')) || 0;
  if ((response?.status || 0) === 206 && loadedBytesBefore > 0 && contentLength > 0) {
    return loadedBytesBefore + contentLength;
  }

  return contentLength || fallbackTotal || 0;
}

function createRangeRequestHeadersFallback(headers, start = 0) {
  const requestHeaders = headers ? { ...headers } : {};
  const offset = Math.max(0, Number(start) || 0);
  if (offset > 0) {
    requestHeaders.Range = `bytes=${offset}-`;
  } else if ('Range' in requestHeaders) {
    delete requestHeaders.Range;
  }
  return requestHeaders;
}

function uint8ArrayToBase64Fallback(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const createRangeRequestHeaders = httpUtils.createRangeRequestHeaders || createRangeRequestHeadersFallback;
const inferTotalBytesFromResponse = httpUtils.inferTotalBytesFromResponse || inferTotalBytesFromResponseFallback;
const uint8ArrayToBase64 = byteUtils.uint8ArrayToBase64 || uint8ArrayToBase64Fallback;
const BLOB_TRANSFER_CHUNK_SIZE = constants.BLOB_TRANSFER_CHUNK_SIZE || 256 * 1024;
const DOWNLOAD_RESUME_RETRY_DELAYS = constants.DOWNLOAD_RESUME_RETRY_DELAYS || [1500, 4000, 8000];
const OBJECT_URL_REVOKE_DELAY = constants.OBJECT_URL_REVOKE_DELAY || 60000;
const STREAM_FETCH_RETRY_DELAYS = constants.STREAM_FETCH_RETRY_DELAYS || [0, 1000, 2500, 5000];

console.log(`[OVD] Service Worker 启动 browser=${browserInfo.name}`);
if (browserInfo.supported === false) {
  // 非 Chromium 内核缺少 offscreen / DNR 动态规则 / 脚本注入等能力，
  // 明确告知而不是让用户在"功能静默失效"里排查。
  console.warn('[OVD] 当前浏览器不在支持矩阵内：本扩展仅支持 Chrome / Edge 109+ 等 Chromium 内核浏览器');
}
cleanupAllRules();

// storage.session 镜像：任务表与检测列表随浏览器会话存续，SW 回收后可恢复
const taskSnapshotMirror = new SessionMirror('ovd.downloadTasks');
const registrySnapshotMirror = new SessionMirror('ovd.videoRegistry');
const registry = new VideoRegistry(registrySnapshotMirror);
const downloader = new Downloader();
const downloadStore = new DownloadStateStore(taskSnapshotMirror);
const historyStore = new DownloadHistoryStore();
const downloadResumeAttempts = new Map();
const downloadResumeTimers = new Map();
const lastKnownTabUrls = new Map();
// 下载完成/失败通知（settings.downloadNotification 控制）与按 tab 的视频数徽章
const downloadNotifications = new DownloadNotificationManager({ settingsStore: globalThis.__OVD_GENERAL_SETTINGS_STORE__ });
const videoFilter = globalThis.__OVD_VIDEO_FILTER__ || {};
const generalSettingsStore = globalThis.__OVD_GENERAL_SETTINGS_STORE__ || {};

// content 侧发起的请求头注入会话：token → declarativeNetRequest 清理函数
const headerInjectionSessions = new Map();
let headerInjectionToken = 0;

// 全局下载并发队列：让 concurrentDownloadLimit 覆盖所有下载入口，而非仅 popup 批量下载
const downloadQueue = new DownloadQueue({ limit: 3 });

// OPFS 落盘能力（临时文件登记见 background/opfs-temp-registry.js）
const opfsSink = globalThis.__OVD_OPFS_SINK__ || {};
const pageMessageGuard = globalThis.__OVD_PAGE_MESSAGE_GUARD__ || {};
downloadNotifications.attach();
const tabBadge = createTabBadgeManager();

// SW 启动恢复：先初始化历史库，再从 storage.session 读回任务表与注册表
const restorePersistedStatePromise = historyStore.init().then(async () => {
  try {
    const items = await chrome.storage.local.get(['ovd.generalSettings']);
    const retentionDays = items?.['ovd.generalSettings']?.historyRetentionDays ?? 30;
    if (retentionDays > 0) {
      await historyStore.prune(retentionDays);
    }
  } catch (_err) {}
}).catch((err) => {
  console.warn('[OVD] download history store init failed:', err);
}).then(() => restorePersistedState()).catch((err) => {
  console.warn('[OVD] persisted state restore failed:', err);
});

// 启动时清理上次异常退出遗留的 OPFS 临时文件（超过保留时间才删，避免误删在跑的任务）
Promise.resolve(opfsSink.cleanupStale?.({ maxAgeMs: constants.OPFS_STALE_MS }))
  .then((result) => {
    if (result?.removed > 0) {
      console.log(`[OVD] 清理 OPFS 残留临时文件 removed=${result.removed} scanned=${result.scanned}`);
    }
  })
  .catch((err) => console.warn(`[OVD] OPFS 残留清理失败: ${err.message}`));

async function onVideoDetected(tabId) {
  try {
    await notifyVisibleVideoCount(tabId);
  } catch (err) {
    console.warn(`[OVD] failed to update visible video count tab=${tabId}: ${err.message}`);
  }
}

/** SW 启动恢复：读回注册表与任务表，核对 chrome.downloads 实际状态 */
async function restorePersistedState() {
  try {
    const registrySnapshot = await registrySnapshotMirror.load();
    if (registrySnapshot) {
      registry.restoreAll(registrySnapshot);
      // 恢复后同步刷新各 tab 的视频数徽章
      for (const rawTabId of Object.keys(registrySnapshot)) {
        const restoredTabId = Number(rawTabId);
        if (Number.isFinite(restoredTabId)) {
          notifyVisibleVideoCount(restoredTabId).catch((err) => {
            console.warn(`[OVD] failed to refresh badge for restored tab=${restoredTabId}: ${err.message}`);
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[OVD] video registry restore failed: ${err.message}`);
  }

  const taskSnapshot = await taskSnapshotMirror.load();
  if (!Array.isArray(taskSnapshot) || !taskSnapshot.length) {
    return;
  }

  const restoredCount = downloadStore.restoreTasks(taskSnapshot);
  if (!restoredCount) {
    return;
  }
  console.log(`[OVD] SW 重启恢复任务数=${restoredCount}`);

  const recovery = await recoverDownloadTasks(downloadStore, {
    getDownloadItem,
    tryResumeDownload: tryAutoResumeDownload,
    onTaskUpdate: (task) => broadcastTaskUpdate(task),
  });
  console.log(`[OVD] 任务恢复核对 resumed=${recovery.resumed} interrupted=${recovery.interrupted} ghost=${recovery.ghost} completed=${recovery.completed}`);

  // SW 回收期间完成的下载补写历史（addRecord 按 downloadId 去重）
  for (const task of recovery.completedTasks) {
    try {
      const tab = task.tabId ? await chrome.tabs.get(task.tabId).catch(() => null) : null;
      await historyStore.addRecord({
        taskId: task.taskId || '',
        url: task.videoUrl || '',
        title: getTaskDisplayTitle(task),
        type: task.sourceId || 'direct',
        filename: task.filename || '',
        downloadId: task.downloadId,
        tabUrl: tab?.url || '',
        status: 'complete',
      });
      await downloadNotifications.notifyComplete(downloadId, item);
    } catch (err) {
      console.warn(`[OVD] failed to backfill download history on restore: ${err.message}`);
    }
  }
}

const interceptor = new RequestInterceptor(registry, onVideoDetected);
interceptor.start();

chrome.downloads.onChanged.addListener(async (delta) => {
  const downloadId = delta.id;
  // 等待启动恢复完成，确保 downloadId->tabId 映射已重建
  await restorePersistedStatePromise;
  if (downloadStore.isDeletedDownload(downloadId)) {
    clearDownloadResumeTracking(downloadId);
    return;
  }
  const tabId = downloadStore.getTabId(downloadId);

  if ((delta.bytesReceived != null || delta.totalBytes != null) && tabId) {
    const item = await getDownloadItem(downloadId);
    if (item && item.totalBytes > 0) {
      const percent = Math.round((item.bytesReceived / item.totalBytes) * 100);
      downloadStore.update(downloadId, { percent, state: 'downloading' });
      broadcastTaskUpdate(downloadStore.updateTaskByDownloadId(downloadId, {
        percent,
        status: 'running',
      }));
      broadcast(tabId, {
        type: MSG.DOWNLOAD_PROGRESS || 'DOWNLOAD_PROGRESS',
        downloadId,
        percent,
        bytesReceived: item.bytesReceived,
        totalBytes: item.totalBytes,
      });
    }
  }

  if (!delta.state) return;
  const nextState = delta.state.current;

  if (nextState === 'interrupted') {
    const reason = delta.error?.current || 'unknown';
    console.warn(`[OVD] 下载中断/取消 downloadId=${downloadId} state=${nextState} reason=${reason}`);
    const resumed = await tryAutoResumeDownload(downloadId, tabId, reason);
    if (!resumed) {
      downloadStore.markFailed(downloadId);
      broadcastTaskUpdate(downloadStore.updateTaskByDownloadId(downloadId, {
        error: reason,
        percent: 0,
        status: 'failed',
      }));
      downloadStore.cleanupRules(downloadId);
      clearDownloadResumeTracking(downloadId);
      releaseOpfsTempFile(downloadId);
      void downloadNotifications.notifyFailed(downloadId, await getDownloadItem(downloadId), reason).catch(() => {});
    }
    return;
  }

  if (nextState !== 'complete') return;

  console.log(`[OVD] 下载完成 downloadId=${downloadId}`);
  clearDownloadResumeTracking(downloadId);
  releaseOpfsTempFile(downloadId);
  downloadStore.markComplete(downloadId);
  const completedTask = downloadStore.updateTaskByDownloadId(downloadId, {
    percent: 100,
    status: 'complete',
  });
  broadcastTaskUpdate(completedTask);
  downloadStore.scheduleRuleCleanup(downloadId, 3000);
  downloadStore.scheduleDelete(downloadId, 30000);

  try {
    const item = await getDownloadItem(downloadId);
    const stateInfo = downloadStore._states.get(downloadId);
    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    const videos = tabId ? registry.getForTab(tabId) : [];
    const video = videos.find((v) => v.url === stateInfo?.videoUrl);
    await historyStore.addRecord({
      taskId: completedTask?.taskId || '',
      url: completedTask?.videoUrl || stateInfo?.videoUrl || '',
      title: getTaskDisplayTitle(completedTask, video?.title || item?.filename || ''),
      type: completedTask?.sourceId || video?.type || 'direct',
      filename: item?.filename || '',
      size: item?.fileSize ?? item?.totalBytes ?? null,
      downloadId,
      tabUrl: tab?.url || '',
      status: 'complete',
    });
  } catch (err) {
    console.warn(`[OVD] failed to persist download history: ${err.message}`);
  }

  if (tabId) {
    broadcast(tabId, {
      type: MSG.DOWNLOAD_PROGRESS || 'DOWNLOAD_PROGRESS',
      downloadId,
      percent: 100,
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((response) => sendResponse(toMessageResponse(response)))
    .catch((err) => {
      console.error('[OVD] Message handling failed:', err);
      sendResponse(toErrorResponse(err, 'Message handling failed'));
    });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  registry.clearTab(tabId);
  tabBadge.clear(tabId);
  const interruptedTasks = downloadStore.markTabInterrupted(tabId);
  interruptedTasks.forEach((task) => broadcastTaskUpdate(task));
  downloadStore.clearTab(tabId, { onlyRequiresTabContext: true });
  lastKnownTabUrls.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    const previousUrl = lastKnownTabUrls.get(tabId) || '';
    if (shouldPreserveVideosOnPageChange(previousUrl, changeInfo.url, registry.getForTab(tabId))) {
      lastKnownTabUrls.set(tabId, changeInfo.url);
      void notifyVisibleVideoCount(tabId);
      console.log(`[OVD] preserve tab=${tabId} video registry on same YouTube tab update url=${changeInfo.url}`);
      return;
    }

    registry.clearTab(tabId);
    lastKnownTabUrls.set(tabId, changeInfo.url);
  }
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 下载结束（完成/失败/取消）后释放 OPFS 临时文件。
 * 不等待：清理失败只记日志，避免拖慢下载状态回调。
 */
function releaseOpfsTempFile(downloadId) {
  const entry = takeOpfsTempFile(downloadId);
  if (!entry) {
    return;
  }
  void releaseOpfsDownload({ name: entry.name });
}

function clearDownloadResumeTracking(downloadId) {
  const timer = downloadResumeTimers.get(downloadId);
  if (timer) {
    clearTimeout(timer);
    downloadResumeTimers.delete(downloadId);
  }
  downloadResumeAttempts.delete(downloadId);
}

async function tryAutoResumeDownload(downloadId, tabId, reason) {
  if (!supportsDownloadResume?.()) {
    return false;
  }

  const attempt = downloadResumeAttempts.get(downloadId) || 0;
  if (attempt >= DOWNLOAD_RESUME_RETRY_DELAYS.length) {
    return false;
  }

  const item = await getDownloadItem(downloadId);
  if (!item?.canResume) {
    return false;
  }

  const retryDelay = DOWNLOAD_RESUME_RETRY_DELAYS[attempt];
  downloadResumeAttempts.set(downloadId, attempt + 1);
  downloadStore.update(downloadId, { state: 'retrying' });

  if (tabId) {
    broadcast(tabId, {
      type: MSG.DOWNLOAD_PROGRESS || 'DOWNLOAD_PROGRESS',
      downloadId,
      percent: downloadStore.getStatesForTab(tabId)?.[downloadId]?.percent || 0,
      state: 'retrying',
    });
  }

  console.warn(`[OVD] scheduling download resume downloadId=${downloadId} attempt=${attempt + 1} reason=${reason} delayMs=${retryDelay}`);
  const timer = setTimeout(async () => {
    downloadResumeTimers.delete(downloadId);
    try {
      await resumeDownloadAsync(downloadId);
      console.log(`[OVD] resumed interrupted download downloadId=${downloadId} attempt=${attempt + 1}`);
    } catch (err) {
      console.warn(`[OVD] resume attempt failed downloadId=${downloadId} attempt=${attempt + 1}: ${err.message}`);
    }
  }, retryDelay);

  downloadResumeTimers.set(downloadId, timer);
  return true;
}

async function handleMessage(msg, sender) {
  assertValidMessage(msg);
  const tabId = sender.tab?.id ?? msg.tabId;
  // 内容脚本注入所有 frame，用 sender.frameId 区分主/子框架（0 = 主框架）
  const frameId = sender.frameId ?? msg.frameId ?? null;

  if (msg.type === (MSG.FETCH_MEDIA_STREAMS || 'FETCH_MEDIA_STREAMS') && !tabId) {
    throw new Error('Unable to resolve tabId for media stream fetch');
  }

  if (msg.type === (MSG.SET_TAB_MUTED || 'SET_TAB_MUTED') && !tabId) {
    throw new Error('Unable to resolve tabId for mute update');
  }

  switch (msg.type) {
    case MSG.VIDEO_DETECTED || 'VIDEO_DETECTED':
      return handleVideoDetected(msg.payload, tabId, frameId);

    case MSG.GET_VIDEOS || 'GET_VIDEOS':
      return getVideosForTab(tabId ?? msg.tabId);

    case MSG.GET_VIDEOS_FOR_TAB || 'GET_VIDEOS_FOR_TAB':
      return getVideosForTab(msg.tabId);

    case MSG.DOWNLOAD_VIDEO || 'DOWNLOAD_VIDEO': {
      // 所有后台下载入口统一走并发队列（长任务会占用槽位，超出上限时排队）
      try {
        const settings = await generalSettingsStore.getSettings?.() || {};
        downloadQueue.setLimit(settings.concurrentDownloadLimit || 3);
      } catch (err) {
        console.warn(`[OVD] 读取并发设置失败，沿用当前上限: ${err.message}`);
      }
      if (downloadQueue.pendingCount > 0) {
        console.log(`[OVD] 下载排队中 pending=${downloadQueue.pendingCount} active=${downloadQueue.activeCount}`);
      }
      return downloadQueue.run(() => handleDownloadVideo(msg.payload, msg.tabId ?? tabId, msg));
    }

    case MSG.GET_DOWNLOAD_STATES || 'GET_DOWNLOAD_STATES':
      return { states: downloadStore.getStatesForTab(msg.tabId) };

    case MSG.GET_DOWNLOAD_TASKS || 'GET_DOWNLOAD_TASKS':
      return { tasks: downloadStore.getTasks({ tabId: msg.tabId ?? tabId }) };

    case MSG.RETRY_DOWNLOAD_TASK || 'RETRY_DOWNLOAD_TASK':
      return retryDownloadTask(msg.taskId);

    case MSG.DELETE_DOWNLOAD_TASK || 'DELETE_DOWNLOAD_TASK':
      return deleteDownloadTask(msg.taskId);

    case MSG.DOWNLOAD_BLOB_DATA || 'DOWNLOAD_BLOB_DATA':
      return downloadBlobData(msg, tabId, frameId);

    case MSG.INJECT_PAGE_SCRIPTS || 'INJECT_PAGE_SCRIPTS': {
      // 页面注入优先走 chrome.scripting.executeScript({ world: 'MAIN' })，
      // 规避 Twitter/X 等 CSP 严格站点对 <script src> 注入的静默拦截。
      const targetTabId = msg.tabId ?? tabId;
      if (!targetTabId) {
        throw new Error('无法解析 tabId，无法注入页面脚本');
      }
      const files = Array.isArray(msg.files) ? msg.files : [];
      if (files.length === 0) {
        throw new Error('注入脚本列表为空');
      }
      const target = { tabId: targetTabId };
      if (frameId != null) {
        target.frameIds = [frameId];
      } else if (msg.allFrames) {
        target.allFrames = true;
      }
      await chrome.scripting.executeScript({
        files,
        injectImmediately: true,
        target,
        world: 'MAIN',
      });
      console.log(`[OVD] MAIN world 脚本注入完成 tab=${targetTabId} frame=${frameId ?? 'all'} files=${files.length}`);
      return { ok: true, files: files.length, injected: 'main-world' };
    }

    case MSG.INJECT_DOWNLOAD_HEADERS || 'INJECT_DOWNLOAD_HEADERS': {
      // content 侧无法直接写 DNR 规则：由 SW 代注册临时 Referer/CORS 规则
      const token = `hdr-${++headerInjectionToken}-${Date.now()}`;
      const cleanup = await injectHeaders(msg.url, msg.headers || {}, {
        corsOrigin: msg.corsOrigin || '',
      });
      headerInjectionSessions.set(token, cleanup);
      return { ok: true, token };
    }

    case MSG.RELEASE_DOWNLOAD_HEADERS || 'RELEASE_DOWNLOAD_HEADERS': {
      const cleanup = headerInjectionSessions.get(msg.token);
      headerInjectionSessions.delete(msg.token);
      if (cleanup) {
        await cleanup();
      }
      return { ok: true };
    }

    case MSG.HLS_PROGRESS_UPDATE || 'HLS_PROGRESS_UPDATE':
      if (hasTaskIdentity(msg)) {
        broadcastTaskUpdate(downloadStore.upsertTask({
          ...(msg.taskMeta || {}),
          percent: msg.percent || 0,
          phase: msg.phase || '',
          status: msg.percent >= 100 ? 'complete' : 'running',
          tabId,
          videoUrl: msg.videoUrl || msg.m3u8Url || msg.taskMeta?.videoUrl || '',
        }));
      }
      if (tabId) {
        broadcast(tabId, {
          type: MSG.HLS_PROGRESS || 'HLS_PROGRESS',
          percent: msg.percent || 0,
          phase: msg.phase || '',
          videoUrl: msg.videoUrl || msg.m3u8Url || '',
        });
      }
      return {};

    case MSG.FETCH_MEDIA_STREAMS || 'FETCH_MEDIA_STREAMS':
      if (!tabId) {
        return { ok: false, error: '无法获取 tabId' };
      }
      return fetchMediaStreams(msg.videoUrl, msg.audioUrl, msg.headers, tabId, msg.transferId, frameId);

    case MSG.BILIBILI_MUXER_LOG || 'BILIBILI_MUXER_LOG':
      logMuxerMessage(tabId, msg.level, msg.message);
      return {};

    case MSG.BILIBILI_STREAM_PROGRESS || 'BILIBILI_STREAM_PROGRESS':
      if (tabId) {
        broadcast(tabId, msg);
      }
      return {};

    case MSG.SOURCE_DOWNLOAD_PROGRESS || 'SOURCE_DOWNLOAD_PROGRESS':
    case MSG.SOURCE_DOWNLOAD_STATUS || 'SOURCE_DOWNLOAD_STATUS':
    case MSG.SOURCE_DOWNLOAD_STARTED || 'SOURCE_DOWNLOAD_STARTED': {
      const sourceTask = updateSourceDownloadTask(msg, tabId);
      if (sourceTask) {
        safeRuntimeMessage(msg);
      }
      return {};
    }

    case MSG.SOURCE_DOWNLOAD_RESULT || 'SOURCE_DOWNLOAD_RESULT': {
      const sourceTask = updateSourceDownloadTask(msg, tabId);
      if (!sourceTask) {
        return {};
      }
      if (msg.ok) {
        try {
          const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
          await historyStore.addRecord({
            taskId: sourceTask?.taskId || '',
            url: sourceTask?.videoUrl || msg.videoUrl || '',
            title: getTaskDisplayTitle(sourceTask, msg.title || msg.filename || ''),
            type: sourceTask?.sourceId || msg.sourceId || 'unknown',
            filename: msg.filename || '',
            size: msg.size ?? null,
            downloadId: msg.downloadId ?? null,
            tabUrl: tab?.url || '',
            status: 'complete',
          });
        } catch (err) {
          console.warn(`[OVD] failed to persist source download history: ${err.message}`);
        }
      }
      safeRuntimeMessage(msg);
      return {};
    }

    case MSG.SET_TAB_MUTED || 'SET_TAB_MUTED':
      return setTabMuted(tabId, !!msg.muted);

    case MSG.CLEAR_TAB_VIDEOS || 'CLEAR_TAB_VIDEOS': {
      // popup 来源 sender.tab 为空：frameId 为 null → 整 tab 清理；仅子框架 frameId>0 时清该 frame
      const clearScope = resolveClearVideoScope({ sender, msg });
      const clearTabId = clearScope.tabId;
      if (clearTabId) {
        // 子框架导航/卸载只清理该 frame 上报的条目，主框架才做 tab 级清理
        if (clearScope.frameId != null) {
          registry.clearFrame(clearTabId, clearScope.frameId);
          void notifyVisibleVideoCount(clearTabId);
          return { ok: true, frameCleared: true };
        }
        const previousUrl = lastKnownTabUrls.get(clearTabId) || '';
        const nextUrl = msg.url || '';
        lastKnownTabUrls.set(clearTabId, nextUrl || previousUrl);

        if (shouldPreserveVideosOnPageChange(previousUrl, nextUrl, registry.getForTab(clearTabId))) {
          const count = await notifyVisibleVideoCount(clearTabId);
          console.log(`[OVD] preserve tab=${clearTabId} video registry on same YouTube video URL change count=${count} url=${nextUrl || '-'}`);
          return { ok: true, count, preserved: true };
        }

        registry.clearTab(clearTabId);
        tabBadge.clear(clearTabId);
        safeTabMessage(clearTabId, { type: MSG.UPDATE_BUTTON || 'UPDATE_BUTTON', count: 0 });
        console.log(`[OVD] 清理 tab=${clearTabId} 的视频注册表（SPA 导航）`);
      }
      return { ok: true };
    }

    case MSG.GET_DOWNLOAD_HISTORY || 'GET_DOWNLOAD_HISTORY':
      return { records: await getDownloadHistoryRecords() };

    case MSG.CLEAR_DOWNLOAD_HISTORY || 'CLEAR_DOWNLOAD_HISTORY':
      await historyStore.clear();
      return { ok: true };

    case MSG.DELETE_DOWNLOAD_HISTORY_RECORD || 'DELETE_DOWNLOAD_HISTORY_RECORD':
      await historyStore.deleteRecord(msg.id);
      return { ok: true };

    case MSG.OPEN_DOWNLOAD_FOLDER || 'OPEN_DOWNLOAD_FOLDER':
      return openDownloadFolder(msg.downloadId);

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

function isYouTubeWatchPageUrl(url = '') {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) {
      return !!parsed.pathname.split('/').filter(Boolean)[0];
    }

    if (!parsed.hostname.includes('youtube.com')) {
      return false;
    }

    if (parsed.pathname === '/watch') {
      return !!parsed.searchParams.get('v');
    }

    return (
      parsed.pathname.startsWith('/shorts/') ||
      parsed.pathname.startsWith('/live/') ||
      parsed.pathname.startsWith('/embed/')
    );
  } catch (err) {
    console.warn(`[OVD] failed to parse YouTube watch URL: ${err.message}`);
    return false;
  }
}

function getYouTubeVideoIdFromPageUrl(url = '') {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.split('/').filter(Boolean)[0] || '';
    }

    if (!parsed.hostname.includes('youtube.com')) {
      return '';
    }

    if (parsed.pathname === '/watch') {
      return parsed.searchParams.get('v') || '';
    }

    if (
      parsed.pathname.startsWith('/shorts/') ||
      parsed.pathname.startsWith('/live/') ||
      parsed.pathname.startsWith('/embed/')
    ) {
      return parsed.pathname.split('/').filter(Boolean)[1] || '';
    }
  } catch (err) {
    console.warn(`[OVD] failed to parse YouTube video id from page URL: ${err.message}`);
  }

  return '';
}

function shouldPreserveVideosOnPageChange(previousUrl = '', nextUrl = '', existingVideos = []) {
  const previousVideoId = getYouTubeVideoIdFromPageUrl(previousUrl);
  const nextVideoId = getYouTubeVideoIdFromPageUrl(nextUrl);
  if (!nextVideoId || previousVideoId !== nextVideoId) {
    return false;
  }

  return existingVideos.some((video) => (
    video?.type === 'youtube-adaptive' &&
    (video.videoId === nextVideoId || getYouTubeVideoIdFromPageUrl(video.url || '') === nextVideoId)
  ));
}

function isYouTubePageUrl(url = '') {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be');
  } catch (err) {
    console.warn(`[OVD] failed to parse YouTube page URL: ${err.message}`);
    return false;
  }
}

function shouldHideVideoFromYouTubeList(video, tabUrl = '', hasYouTubeAdaptive = false) {
  if (isYouTubePageUrl(tabUrl) && !isYouTubeWatchPageUrl(tabUrl)) {
    return true;
  }

  if (!hasYouTubeAdaptive || !isYouTubeWatchPageUrl(tabUrl)) {
    return false;
  }

  if (video?.type === 'audio') {
    return true;
  }

  if (video?.type === 'blob') {
    return String(video?.url || '').startsWith('blob:https://www.youtube.com/');
  }

  return false;
}

async function getVisibleVideosForTab(tabId) {
  if (!tabId) {
    return { tabTitle: '', tabUrl: '', videos: [] };
  }

  let tabTitle = '';
  let tabUrl = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    tabTitle = tab?.title || '';
    tabUrl = tab?.url || '';
  } catch (err) {
    console.warn(`[OVD] failed to get tab metadata tab=${tabId}: ${err.message}`);
  }

  registry.enrichTitles(tabId, tabTitle);
  const videos = registry.getForTab(tabId);
  const hasYouTubeAdaptive = videos.some((video) => video?.type === 'youtube-adaptive');
  const visibleVideos = videos.filter((video) => !shouldHideVideoFromYouTubeList(video, tabUrl, hasYouTubeAdaptive));

  // 用户级过滤（域名黑名单/最小时长/最小体积）：在读取时应用，
  // 设置变化后无需重新检测即可生效。
  let settings = {};
  try {
    settings = await generalSettingsStore.getSettings?.() || {};
  } catch (err) {
    console.warn(`[OVD] 读取过滤设置失败: ${err.message}`);
  }
  const filteredVideos = videoFilter.filterVideos
    ? videoFilter.filterVideos(visibleVideos, settings, { tabUrl })
    : visibleVideos;

  if (filteredVideos.length !== visibleVideos.length) {
    console.log(`[OVD] 过滤噪声条目 tab=${tabId} 隐藏=${visibleVideos.length - filteredVideos.length}`);
  }

  return {
    tabTitle,
    tabUrl,
    videos: filteredVideos,
  };
}

async function notifyVisibleVideoCount(tabId) {
  if (!tabId) {
    return 0;
  }

  const { videos } = await getVisibleVideosForTab(tabId);
  safeTabMessage(tabId, { type: MSG.UPDATE_BUTTON || 'UPDATE_BUTTON', count: videos.length });
  tabBadge.refresh(tabId, videos.length);
  return videos.length;
}

async function handleVideoDetected(payload, tabId, frameId = null) {
  if (!payload?.url || !tabId) {
    throw new Error('Missing video payload or tabId');
  }

  // 纵深防御：内容脚本已校验页面来源的消息，这里再挡一次，
  // 防止任何来源把 file:/data:/chrome: 之类的地址塞进注册表。
  const guardResult = pageMessageGuard.validateDetectedPayload?.(payload);
  if (guardResult && !guardResult.ok) {
    console.warn(`[OVD] 拒绝可疑的 VIDEO_DETECTED（${guardResult.reason}）url=${String(payload.url).slice(0, 80)}`);
    return { ok: false, rejected: true };
  }

  const isBlobVideo = payload.url.startsWith('blob:');
  // blob URL 不是页面地址，不能写入 lastKnownTabUrls 影响 SPA 导航判断
  if (!isBlobVideo && !frameId) {
    lastKnownTabUrls.set(tabId, payload.url);
  }

  // blob: URL 只在创建它的页面上下文有效，注册时标记需要 tab 上下文，
  // 下载时由 DOWNLOAD_VIDEO 链路委托回该 tab 的 content script 提取数据
  const detectedInfo = frameId != null ? { ...payload, frameId } : payload;
  const registryResult = registry.add(tabId, isBlobVideo
    ? { ...detectedInfo, type: 'blob', requiresTabContext: true }
    : detectedInfo);
  const count = await notifyVisibleVideoCount(tabId);

  if (registryResult === 'new') {
    console.log(`[OVD] 页面上报新视频 type=${payload.type} tab=${tabId} url=${payload.url}`);
  } else if (registryResult === 'updated') {
    console.log(`[OVD] 页面上报更新视频 type=${payload.type} tab=${tabId} url=${payload.url}`);
  }

  return { count };
}

async function getVideosForTab(tabId) {
  const { videos } = await getVisibleVideosForTab(tabId);
  return { videos };
}

function getTaskTitle(videoInfo = {}) {
  return videoInfo.title || videoInfo.filename || videoInfo.url || 'Download task';
}

function getTaskDisplayTitle(task = null, fallback = '') {
  return task?.title || task?.filename || task?.videoUrl || fallback || 'Download task';
}

function findTaskForHistoryRecord(record = {}) {
  if (record.taskId) {
    const task = downloadStore.getTask(record.taskId);
    if (task) {
      return task;
    }
  }

  if (record.downloadId != null) {
    return downloadStore
      .getTasks({ limit: 200 })
      .find((task) => task.downloadId === record.downloadId) || null;
  }

  return null;
}

async function getDownloadHistoryRecords() {
  const records = await historyStore.getAll();
  return records.map((record) => {
    const task = findTaskForHistoryRecord(record);
    if (!task) {
      return record;
    }
    return {
      ...record,
      title: getTaskDisplayTitle(task, record.title || record.filename || ''),
    };
  });
}

function isTabContextRequiredForVideo(videoInfo = {}) {
  const type = String(videoInfo?.type || '').trim();
  if (type === 'blob') return true;
  if (type === 'bilibili-dash') return true;
  return false;
}

function broadcastTaskUpdate(task = null) {
  if (!task) {
    return;
  }
  safeRuntimeMessage({
    task,
    type: MSG.DOWNLOAD_TASKS_UPDATED || 'DOWNLOAD_TASKS_UPDATED',
  });
}

function hasTaskIdentity(input = {}) {
  const taskMeta = input.taskMeta || {};
  return Boolean(
    input.downloadId != null ||
    input.taskId ||
    input.taskKey ||
    input.traceId ||
    input.videoUrl ||
    input.m3u8Url ||
    taskMeta.taskId ||
    taskMeta.taskKey ||
    taskMeta.traceId ||
    taskMeta.videoUrl
  );
}

function updateSourceDownloadTask(msg = {}, tabId = null) {
  const status = msg.type === (MSG.SOURCE_DOWNLOAD_RESULT || 'SOURCE_DOWNLOAD_RESULT')
    ? (msg.ok ? 'complete' : 'failed')
    : 'running';
  const task = downloadStore.updateSourceTask({
    ...msg,
    error: msg.error || '',
    status,
  }, tabId);
  broadcastTaskUpdate(task);
  return task;
}

async function retryDownloadTask(taskId) {
  const task = downloadStore.getTask(taskId);
  if (!task) {
    return { ok: false, error: 'Download task not found' };
  }
  if (!task.videoInfo) {
    return { ok: false, error: 'Original download metadata is missing' };
  }
  if (!task.tabId) {
    return { ok: false, error: 'Original tab is missing' };
  }

  const retryingTask = downloadStore.upsertTask({
    error: '',
    message: 'Retrying...',
    percent: 0,
    status: 'retrying',
    taskId,
  });
  broadcastTaskUpdate(retryingTask);

  const isContentTask = task.strategyId && task.strategyId !== 'browser-download' && task.strategyId !== 'youtube-adaptive-background';
  if (isContentTask) {
    try {
      const response = await sendTabMessageAsync(task.tabId, {
        meta: task.videoInfo,
        type: MSG.SOURCE_DOWNLOAD || 'SOURCE_DOWNLOAD',
      });
      if (response?.ok === false) {
        throw new Error(response.error || 'Retry failed to start');
      }
      const nextTask = downloadStore.upsertTask({
        error: '',
        message: 'Retry started',
        percent: 0,
        sourceId: response.sourceId || task.sourceId,
        status: 'running',
        strategyId: response.strategyId || task.strategyId,
        taskId,
        taskKey: response.taskKey || task.taskKey,
        traceId: response.traceId || task.traceId,
      });
      broadcastTaskUpdate(nextTask);
      return { ok: true, task: nextTask };
    } catch (err) {
      const failedTask = downloadStore.upsertTask({
        error: err.message,
        status: 'failed',
        taskId,
      });
      broadcastTaskUpdate(failedTask);
      return { ok: false, error: err.message };
    }
  }

  return handleDownloadVideo(task.videoInfo, task.tabId, { taskId });
}

async function deleteDownloadTask(taskId) {
  const task = downloadStore.getTask(taskId);
  if (!task) {
    return { ok: false, error: 'Download task not found' };
  }

  const downloadId = task.downloadId;
  downloadStore.deleteTask(taskId, { tombstone: true });
  broadcastTaskUpdate({ ...task, deleted: true });
  if (downloadId != null) {
    clearDownloadResumeTracking(downloadId);
  }
  if (downloadId != null && ['running', 'retrying'].includes(task.status)) {
    await cancelBrowserDownload(downloadId);
  }
  return { ok: true };
}

async function cancelBrowserDownload(downloadId) {
  const numericDownloadId = Number(downloadId);
  if (!Number.isFinite(numericDownloadId)) {
    return;
  }

  await new Promise((resolve) => {
    try {
      chrome.downloads.cancel(numericDownloadId, () => resolve());
    } catch (_err) {
      resolve();
    }
  });
}

async function handleDownloadVideo(payload, tabId, taskOptions = {}) {
  const options = typeof taskOptions === 'string' ? { taskId: taskOptions } : (taskOptions || {});
  const videoUrl = payload?.url || '';
  console.log(`[OVD] 收到下载请求 type=${payload?.type} tabId=${tabId} url=${videoUrl}`);
  const requiresTabContext = isTabContextRequiredForVideo(payload);

  const initialTask = downloadStore.upsertTask({
    sourceId: options.sourceId || payload?.type || 'download',
    status: 'running',
    strategyId: options.strategyId || 'browser-download',
    requiresTabContext,
    tabId,
    taskId: options.taskId || null,
    taskKey: options.taskKey || '',
    title: options.title || getTaskTitle(payload),
    traceId: options.traceId || '',
    videoInfo: options.videoInfo || payload || null,
    videoUrl: options.videoUrl || videoUrl,
  });
  broadcastTaskUpdate(initialTask);

  const taskMeta = {
    sourceId: initialTask.sourceId,
    strategyId: initialTask.strategyId,
    taskId: initialTask.taskId,
    taskKey: initialTask.taskKey,
    title: initialTask.title,
    traceId: initialTask.traceId,
    videoInfo: initialTask.videoInfo,
    videoUrl: initialTask.videoUrl,
  };

  let result;
  try {
    result = await downloader.download(payload, tabId, {
      onTaskProgress: (percent, progress = {}) => {
        const task = downloadStore.upsertTask({
          ...progress,
          percent,
          taskId: initialTask.taskId,
        });
        broadcastTaskUpdate(task);
      },
      taskMeta,
    });
  } catch (err) {
    const failedTask = downloadStore.upsertTask({
      error: err.message,
      sourceId: options.sourceId || payload?.type || 'download',
      status: 'failed',
      strategyId: options.strategyId || 'browser-download',
      tabId,
      taskId: initialTask.taskId,
      taskKey: options.taskKey || '',
      title: options.title || getTaskTitle(payload),
      traceId: options.traceId || '',
      videoInfo: options.videoInfo || payload || null,
      videoUrl: options.videoUrl || videoUrl,
    });
    broadcastTaskUpdate(failedTask);
    throw err;
  }

  if (result.needsBlobFetch) {
    if (!tabId) {
      return { ok: false, error: '无法获取 tabId，无法下载 blob 视频' };
    }

    console.log(`[OVD] blob 下载委托给 content script tab=${tabId} url=${result.url}`);
    try {
      const frameOptions = payload?.frameId != null ? { frameId: payload.frameId } : undefined;
      const response = await sendTabMessageAsync(tabId, {
        type: MSG.FETCH_BLOB || 'FETCH_BLOB',
        blobUrl: result.url,
        filename: result.filename,
        // 透传任务元数据，让 content 侧回传 DOWNLOAD_BLOB_DATA 时更新同一任务
        taskMeta,
      }, frameOptions);

      if (response?.ok) {
        broadcastTaskUpdate(downloadStore.upsertTask({
          message: 'Blob processing delegated to page',
          sourceId: options.sourceId || payload?.type || 'blob',
          status: 'running',
          strategyId: options.strategyId || 'browser-download',
          requiresTabContext: true,
          tabId,
          taskId: initialTask.taskId,
          taskKey: options.taskKey || '',
          title: options.title || getTaskTitle(payload),
          traceId: options.traceId || '',
          videoInfo: options.videoInfo || payload || null,
          videoUrl: options.videoUrl || videoUrl,
        }));
        return {};
      }

      const error = response?.error || 'blob download failed';
      broadcastTaskUpdate(downloadStore.upsertTask({
        error,
        sourceId: options.sourceId || payload?.type || 'blob',
        status: 'failed',
        strategyId: options.strategyId || 'browser-download',
        requiresTabContext: true,
        tabId,
        taskId: initialTask.taskId,
        taskKey: options.taskKey || '',
        title: options.title || getTaskTitle(payload),
        traceId: options.traceId || '',
        videoInfo: options.videoInfo || payload || null,
        videoUrl: options.videoUrl || videoUrl,
      }));
      return { ok: false, error };
    } catch (err) {
      broadcastTaskUpdate(downloadStore.upsertTask({
        error: err.message,
        sourceId: options.sourceId || payload?.type || 'blob',
        status: 'failed',
        strategyId: options.strategyId || 'browser-download',
        requiresTabContext: true,
        tabId,
        taskId: initialTask.taskId,
        taskKey: options.taskKey || '',
        title: options.title || getTaskTitle(payload),
        traceId: options.traceId || '',
        videoInfo: options.videoInfo || payload || null,
        videoUrl: options.videoUrl || videoUrl,
      }));
      return { ok: false, error: err.message };
    }
  }

  downloadStore.registerResult(result, {
    sourceId: options.sourceId || payload?.type || 'download',
    strategyId: options.strategyId || 'browser-download',
    requiresTabContext: result.requiresTabContext ?? requiresTabContext,
    tabId,
    taskId: initialTask.taskId,
    title: options.title || getTaskTitle(payload),
    videoInfo: options.videoInfo || payload || null,
    videoUrl: options.videoUrl || videoUrl,
  });
  const downloadId = result.downloadId ?? result.results?.[0]?.downloadId ?? null;
  const task = downloadStore.upsertTask({
    downloadId,
    filename: result.filename || '',
    percent: downloadId == null ? 100 : 0,
    sourceId: options.sourceId || payload?.type || 'download',
    status: downloadId == null ? 'complete' : 'running',
    strategyId: options.strategyId || 'browser-download',
    requiresTabContext: result.requiresTabContext ?? requiresTabContext,
    tabId,
    taskId: initialTask.taskId,
    taskKey: options.taskKey || '',
    title: options.title || getTaskTitle(payload),
    traceId: options.traceId || '',
    videoInfo: options.videoInfo || payload || null,
    videoUrl: options.videoUrl || videoUrl,
  });
  broadcastTaskUpdate(task);
  return result;
}

async function downloadBlobData(message = {}, tabId, frameId = null) {
  const objectUrl = message.objectUrl;
  const filename = message.filename;
  const finalFilename = await downloadPathUtils.applyDownloadSubdir?.(filename || 'video.mp4');
  const saveAs = await resolveSaveAs();

  return new Promise((resolve) => {
    chrome.downloads.download({
      url: objectUrl,
      filename: finalFilename,
      saveAs,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        const task = downloadStore.upsertTask({
          error: chrome.runtime.lastError.message,
          filename: finalFilename,
          sourceId: message.sourceId || 'blob',
          status: 'failed',
          strategyId: message.strategyId || 'browser-download',
          requiresTabContext: true,
          tabId,
          taskId: message.taskId || null,
          taskKey: message.taskKey || '',
          title: message.title || filename || '',
          traceId: message.traceId || '',
          videoInfo: message.videoInfo || null,
          videoUrl: message.videoUrl || '',
        });
        broadcastTaskUpdate(task);
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      const task = downloadStore.upsertTask({
        downloadId,
        filename: finalFilename,
        sourceId: message.sourceId || 'blob',
        status: 'running',
        strategyId: message.strategyId || 'browser-download',
        requiresTabContext: true,
        tabId,
        taskId: message.taskId || null,
        taskKey: message.taskKey || '',
        title: message.title || filename || '',
        traceId: message.traceId || '',
        videoInfo: message.videoInfo || null,
        videoUrl: message.videoUrl || '',
      });
      downloadStore.registerDownload(downloadId, {
        sourceId: task.sourceId,
        strategyId: task.strategyId,
        requiresTabContext: true,
        tabId,
        taskId: task.taskId,
        title: task.title,
        videoInfo: task.videoInfo,
        videoUrl: task.videoUrl,
      });
      broadcastTaskUpdate(downloadStore.updateTaskByDownloadId(downloadId, {
        filename: finalFilename,
        status: 'running',
      }));

      setTimeout(() => {
        if (tabId) {
          safeTabMessage(tabId, {
            type: MSG.REVOKE_OBJECT_URL || 'REVOKE_OBJECT_URL',
            objectUrl,
          }, undefined, frameId != null ? { frameId } : undefined);
        }
      }, OBJECT_URL_REVOKE_DELAY);

      resolve({ ok: true, downloadId });
    });
  });
}

async function fetchMediaStreams(videoUrl, audioUrl, headers, tabId, transferId, frameId = null) {
  const cleanups = [];
  let videoLoaded = 0;
  let audioLoaded = 0;
  let videoTotal = 0;
  let audioTotal = 0;
  let lastBroadcastPercent = 0;

  function onStreamProgress(label, loadedBytes, totalBytes) {
    if (label === 'video') {
      videoLoaded = loadedBytes;
      videoTotal = totalBytes;
    } else {
      audioLoaded = loadedBytes;
      audioTotal = totalBytes;
    }

    const combinedLoaded = videoLoaded + audioLoaded;
    const combinedTotal = videoTotal + audioTotal;
    if (combinedTotal <= 0) {
      return;
    }

    const percent = Math.min(100, Math.round((combinedLoaded / combinedTotal) * 100));
    if (percent === lastBroadcastPercent) {
      return;
    }

    lastBroadcastPercent = percent;
    broadcast(tabId, {
      type: MSG.BILIBILI_STREAM_PROGRESS || 'BILIBILI_STREAM_PROGRESS',
      loadedBytes: combinedLoaded,
      percent,
      phase: 'fetching',
      totalBytes: combinedTotal,
      transferId,
    });
  }

  try {
    const urls = [...new Set([videoUrl, audioUrl].filter(Boolean))];
    for (const url of urls) {
      const cleanup = await injectHeaders(url, headers || {});
      cleanups.push(cleanup);
    }

    const [videoBuffer, audioBuffer] = await Promise.all([
      fetchStreamBufferResumable(videoUrl, 'video', headers, onStreamProgress),
      fetchStreamBufferResumable(audioUrl, 'audio', headers, onStreamProgress),
    ]);

    // 回传是本地 IPC（不是网络），256KB + 逐条 await 会让大文件被 IPC 往返拖住：
    // 改用 1MB 分块 + 有界流水线，分片自带 seq 供内容侧按序还原。
    const chunkSize = constants.MEDIA_STREAM_CHUNK_SIZE || 1024 * 1024;
    const pipelineDepth = Math.max(1, constants.MEDIA_STREAM_PIPELINE_DEPTH || 4);
    const frameOptions = frameId != null ? { frameId } : undefined;
    await sendTabMessageAsync(tabId, { type: MSG.MEDIA_STREAM_START || 'MEDIA_STREAM_START', transferId }, frameOptions);

    for (const [label, buffer] of [['video', videoBuffer], ['audio', audioBuffer]]) {
      const bytes = new Uint8Array(buffer);
      let seq = 0;
      let inFlight = [];

      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        // subarray 是视图，避免每个分片再复制一次
        const chunk = bytes.subarray(offset, offset + chunkSize);
        inFlight.push(sendTabMessageAsync(tabId, {
          type: MSG.MEDIA_STREAM_CHUNK || 'MEDIA_STREAM_CHUNK',
          transferId,
          label,
          chunkBase64: uint8ArrayToBase64(chunk),
          seq: seq++,
        }, frameOptions));

        if (inFlight.length >= pipelineDepth) {
          await Promise.all(inFlight);
          inFlight = [];
        }
      }

      if (inFlight.length > 0) {
        await Promise.all(inFlight);
      }
    }

    await sendTabMessageAsync(tabId, { type: MSG.MEDIA_STREAM_FINISH || 'MEDIA_STREAM_FINISH', transferId }, frameOptions);
    return { ok: true };
  } finally {
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (err) {
        console.warn(`[OVD] failed to cleanup injected headers for stream fetch: ${err.message}`);
      }
    }
  }
}

async function setTabMuted(tabId, muted) {
  if (!tabId) {
    return { ok: false, error: '无法获取 tabId' };
  }

  const tab = await chrome.tabs.get(tabId);
  const previousMuted = !!tab?.mutedInfo?.muted;

  if (previousMuted !== muted) {
    await chrome.tabs.update(tabId, { muted });
  }

  return { ok: true, previousMuted };
}

async function fetchStreamBuffer(url, label, headers) {
  let response;
  try {
    response = await fetch(url, {
      headers: headers ? { ...headers } : {},
      credentials: 'omit',
    });
  } catch (err) {
    throw new Error(`${label}流抓取失败: ${err.message}`);
  }

  if (!response.ok) {
    throw new Error(`${label}流返回异常: HTTP ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  console.log(`[OVD] ${label}流获取完成 size=${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
  return buffer;
}

async function fetchStreamBufferResumable(url, label, headers, onProgress = null) {
  const chunks = [];
  let loadedBytes = 0;
  let totalBytes = 0;
  const PROGRESS_REPORT_INTERVAL = 256 * 1024;
  let lastReportedBytes = 0;

  for (let attemptIndex = 0; attemptIndex < STREAM_FETCH_RETRY_DELAYS.length; attemptIndex++) {
    const retryDelay = STREAM_FETCH_RETRY_DELAYS[attemptIndex];
    if (retryDelay > 0) {
      console.warn(`[OVD] stream retry label=${label} attempt=${attemptIndex} loaded=${(loadedBytes / 1024 / 1024).toFixed(2)} MB`);
      await delay(retryDelay);
    }

    const rangeStart = loadedBytes;

    try {
      const response = await fetch(url, {
        headers: createRangeRequestHeaders(headers, rangeStart),
        credentials: 'omit',
      });

      if (rangeStart > 0 && response.status === 200) {
        console.warn(`[OVD] stream resume unsupported, restarting label=${label}`);
        chunks.length = 0;
        loadedBytes = 0;
      }

      if (!response.ok) {
        throw new Error(`${label} stream returned HTTP ${response.status} ${response.statusText}`);
      }

      totalBytes = inferTotalBytesFromResponse(response, rangeStart, totalBytes, url);

      if (!response.body || typeof response.body.getReader !== 'function') {
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        if (rangeStart > 0 && response.status !== 206) {
          chunks.length = 0;
          loadedBytes = 0;
        }
        chunks.push(bytes);
        loadedBytes += bytes.byteLength;
        break;
      }

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (value?.length) {
          chunks.push(value);
          loadedBytes += value.length;
          if (onProgress && loadedBytes - lastReportedBytes >= PROGRESS_REPORT_INTERVAL) {
            lastReportedBytes = loadedBytes;
            onProgress(label, loadedBytes, totalBytes);
          }
        }
      }

      break;
    } catch (err) {
      if (attemptIndex === STREAM_FETCH_RETRY_DELAYS.length - 1) {
        throw new Error(`${label} stream fetch failed: ${err.message}`);
      }
    }
  }

  // 使用实际接收的字节数分配，避免 totalBytes 不准确导致尾部填充零
  const merged = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  console.log(`[OVD] ${label} resumable stream complete size=${(merged.byteLength / 1024 / 1024).toFixed(2)} MB`);
  return merged.buffer;
}

function getDownloadItem(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (items) => resolve(items?.[0] || null));
  });
}

async function openDownloadFolder(downloadId) {
  const numericDownloadId = Number(downloadId);
  if (!Number.isFinite(numericDownloadId)) {
    return { ok: false, error: '缺少下载记录 ID，无法打开文件夹' };
  }

  const item = await getDownloadItem(numericDownloadId);
  if (!item) {
    return { ok: false, error: '浏览器下载记录不存在，可能已被清除' };
  }

  return new Promise((resolve) => {
    try {
      chrome.downloads.show(numericDownloadId);
      resolve({ ok: true });
    } catch (err) {
      resolve({ ok: false, error: err?.message || '无法打开下载文件夹' });
    }
  });
}

function logMuxerMessage(tabId, level, message) {
  const prefix = `[OVD][Muxer][tab=${tabId ?? 'unknown'}][${level || 'log'}]`;
  const line = `${prefix} ${message || ''}`;
  if (level === 'warn') console.warn(line);
  else if (level === 'error') console.error(line);
  else console.log(line);
}

function broadcast(tabId, message) {
  if (tabId) {
    safeTabMessage(tabId, message);
  }
  safeRuntimeMessage(message);
}
