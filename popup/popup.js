import { sendRuntimeMessageAsync, sendTabMessageAsync } from '../lib/browser-compat.module.js';

const videoUtils = globalThis.__OVD_VIDEO_UTILS__ || {};
const uiDomUtils = globalThis.__OVD_UI_DOM_UTILS__ || {};
const sourceUtils = globalThis.__OVD_VIDEO_SOURCE_UTILS__ || {};
const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
const streamUtils = globalThis.__OVD_YOUTUBE_STREAM_UTILS__ || {};
const youtubeModeStore = globalThis.__OVD_YOUTUBE_DOWNLOAD_MODE_STORE__ || {};
const youtubeOptionFactory = globalThis.__OVD_YOUTUBE_DOWNLOAD_OPTIONS__ || {};
const bilibiliQualityUtils = globalThis.__OVD_BILIBILI_QUALITY_UTILS__ || {};
const bilibiliQualityStore = globalThis.__OVD_BILIBILI_QUALITY_STORE__ || {};
const generalSettingsStore = globalThis.__OVD_GENERAL_SETTINGS_STORE__ || {};
const popupErrorMessages = globalThis.__OVD_POPUP__ || {};
const MSG = messageTypes;
// 国际化：缺 key 时退回中文原文（见 lib/i18n.js）
const i18n = globalThis.__OVD_I18N__ || {};
const t = typeof i18n.t === 'function' ? i18n.t : (_key, fallback) => fallback;

const {
  deriveTitleFromUrl,
  escapeHtml,
  formatDuration,
  formatSize,
  getMediaFormatLabel,
  getVideoTypeLabel,
} = videoUtils;
const {
  setButtonState,
  setHidden,
  startInlineTitleEdit,
} = uiDomUtils;

const videoListEl = document.getElementById('videoList');
const emptyStateEl = document.getElementById('emptyState');
const subtitleEl = document.getElementById('subtitle');
const mainViewEl = document.getElementById('mainView');
const settingsViewEl = document.getElementById('settingsView');
const historyViewEl = document.getElementById('historyView');
const tasksViewEl = document.getElementById('tasksView');
const closeSettingsBtnEl = document.getElementById('closeSettingsBtn');
const closeHistoryBtnEl = document.getElementById('closeHistoryBtn');
const closeTasksBtnEl = document.getElementById('closeTasksBtn');
const historyListEl = document.getElementById('historyList');
const historyEmptyEl = document.getElementById('historyEmpty');
const historySubtitleEl = document.getElementById('historySubtitle');
const clearHistoryBtnEl = document.getElementById('clearHistoryBtn');
const taskListEl = document.getElementById('taskList');
const tasksEmptyEl = document.getElementById('tasksEmpty');
const tasksSubtitleEl = document.getElementById('tasksSubtitle');
const taskEntryBadgeEl = document.getElementById('taskEntryBadge');

const actionBarEl = document.getElementById('actionBar');
const clearListBtnEl = document.getElementById('clearListBtn');
const historyBtnEl = document.getElementById('historyBtn');
const tasksBtnEl = document.getElementById('tasksBtn');
const listHeaderEl = document.getElementById('listHeader');
const listCountEl = document.getElementById('listCount');
const selectAllCheckboxEl = document.getElementById('selectAllCheckbox');
const batchDownloadBtnEl = document.getElementById('batchDownloadBtn');

const selectedIndices = new Set();

const DOWNLOAD_DISPLAY_LABELS = Object.freeze({
  completed: t('download_buttonCompleted', '已完成'),
  downloading: t('download_buttonDownloading', '下载中'),
  idle: t('download_button', '下载'),
  pending: t('download_buttonDownloading', '下载中'),
});

let currentTabId = null;
let currentVideos = [];
let downloadStateCache = {};
let downloadTaskCache = [];
let youtubePreferenceCache = {
  ...(youtubeModeStore.DEFAULT_PREFERENCES || youtubeOptionFactory.DEFAULT_OPTIONS || {}),
};
let bilibiliQualityCache = {
  ...(bilibiliQualityStore.DEFAULT_PREFERENCES || { qualityId: 'auto' }),
};
// YouTube HLS 清单 → 变体列表缓存（清晰度下拉与 HLS 下载共用）
const hlsVariantCache = new Map();

const activeSourceTaskByTraceId = new Map();
const activeSourceTaskByTaskKey = new Map();
const activeBackgroundHlsTaskByUrl = new Map();

function setDownloadButtonState(button, state) {
  if (!button) {
    return;
  }

  const label = DOWNLOAD_DISPLAY_LABELS[state] || DOWNLOAD_DISPLAY_LABELS.idle;
  const disabled = state === 'downloading' || state === 'pending' || state === 'completed';
  button.disabled = disabled;
  button.dataset.state = state;
  button.removeAttribute('aria-label');
  button.innerHTML = state === 'idle'
    ? `
      <span class="dl-label">${label}</span>
      <span class="dl-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v12"/>
          <path d="M7 10l5 5 5-5"/>
          <path d="M5 21h14"/>
        </svg>
      </span>
    `
    : `<span class="dl-label">${label}</span>`;
}

function normalizeAssetUrl(url) {
  const value = String(url || '').trim();
  if (!value) {
    return '';
  }
  if (value.startsWith('//')) {
    return `https:${value}`;
  }
  return value;
}

function canUseInlinePreview(video, thumbnailUrl) {
  if (thumbnailUrl || !video?.url) {
    return false;
  }

  return ['direct', 'hls'].includes(video.type);
}

function buildThumbHtml(video, thumbnailUrl, durationText) {
  if (canUseInlinePreview(video, thumbnailUrl)) {
    const previewUrl = escapeHtml(normalizeAssetUrl(video.url));
    const previewType = video.type === 'hls'
      ? 'application/vnd.apple.mpegurl'
      : escapeHtml(video.mimeType || 'video/mp4');

    return `
      <div class="video-thumb video-thumb-preview">
        <video class="thumb-video" muted playsinline loop preload="metadata" data-preview-type="${escapeHtml(video.type || '')}">
          <source src="${previewUrl}" type="${previewType}">
        </video>
        <div class="thumb-shade"></div>
        <span class="duration-badge">
          <span class="mini-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 4v10"/>
              <path d="M7 10l5 5 5-5"/>
              <path d="M5 20h14"/>
            </svg>
          </span>
          <span class="duration-text">${durationText}</span>
        </span>
      </div>
    `;
  }

  const thumbnailStyle = thumbnailUrl ? ` style="background-image: url('${escapeHtml(thumbnailUrl)}')"` : '';
  return `
    <div class="video-thumb"${thumbnailStyle}>
      <div class="thumb-shade"></div>
      <span class="duration-badge">
        <span class="mini-logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 4v10"/>
            <path d="M7 10l5 5 5-5"/>
            <path d="M5 20h14"/>
          </svg>
        </span>
        <span class="duration-text">${durationText}</span>
      </span>
    </div>
  `;
}

function wireThumbPreview(item, videoIndex = -1) {
  const videoEl = item.querySelector('.thumb-video');
  if (!videoEl) {
    return;
  }

  const thumbEl = videoEl.closest('.video-thumb');
  const durationBadgeEl = thumbEl?.querySelector('.duration-badge');
  const durationTextEl = durationBadgeEl?.querySelector('.duration-text');
  const markFailed = () => {
    thumbEl?.classList.add('preview-failed');
    videoEl.removeAttribute('src');
    videoEl.querySelectorAll('source').forEach((source) => source.removeAttribute('src'));
    try {
      videoEl.load();
    } catch (_err) {}
  };

  videoEl.addEventListener('error', markFailed, { once: true });
  videoEl.querySelector('source')?.addEventListener('error', markFailed, { once: true });
  videoEl.addEventListener('loadeddata', () => {
    thumbEl?.classList.add('preview-ready');
  }, { once: true });

  const updateDuration = () => {
    const duration = videoEl.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }

    const roundedDuration = Math.round(duration);
    const durationText = formatDuration(roundedDuration);
    if (!durationText) {
      return;
    }

    if (durationBadgeEl) {
      if (durationTextEl) {
        durationTextEl.textContent = durationText;
      } else {
        durationBadgeEl.append(` ${durationText}`);
      }
      durationBadgeEl.title = durationText;
    }

    if (currentVideos[videoIndex]) {
      currentVideos[videoIndex].duration = roundedDuration;
    }
  };

  videoEl.addEventListener('loadedmetadata', updateDuration);
  videoEl.addEventListener('durationchange', updateDuration);

  const playPreview = () => {
    if (thumbEl?.classList.contains('preview-failed')) {
      return;
    }
    const playResult = videoEl.play?.();
    if (playResult?.catch) {
      playResult.catch(() => markFailed());
    }
  };

  const pausePreview = () => {
    if (!videoEl.paused) {
      videoEl.pause();
    }
  };

  thumbEl?.addEventListener('mouseenter', playPreview);
  thumbEl?.addEventListener('mouseleave', pausePreview);
  thumbEl?.addEventListener('focusin', playPreview);
  thumbEl?.addEventListener('focusout', pausePreview);
}

closeSettingsBtnEl?.addEventListener('click', () => showMainView());
historyBtnEl?.addEventListener('click', () => showHistoryView());
tasksBtnEl?.addEventListener('click', () => showTasksView());
closeHistoryBtnEl?.addEventListener('click', () => showMainView());
closeTasksBtnEl?.addEventListener('click', () => showMainView());
document.getElementById('settingsBtn')?.addEventListener('click', () => showSettingsView());
clearHistoryBtnEl?.addEventListener('click', () => clearHistory());
clearListBtnEl?.addEventListener('click', async () => {
  currentVideos = [];
  selectedIndices.clear();
  renderVideos([]);

  if (currentTabId == null) {
    return;
  }
  try {
    await sendRuntimeMessageAsync({
      tabId: currentTabId,
      type: MSG.CLEAR_TAB_VIDEOS || 'CLEAR_TAB_VIDEOS',
    });
  } catch (err) {
    console.warn(`[OVD] failed to clear tab videos in background: ${err.message}`);
  }
});

selectAllCheckboxEl?.addEventListener('change', () => {
  selectedIndices.clear();
  if (selectAllCheckboxEl.checked) {
    currentVideos.forEach((video, index) => {
      if (video.type !== 'drm-detected') {
        selectedIndices.add(index);
      }
    });
  }
  videoListEl.querySelectorAll('.video-checkbox').forEach((checkbox) => {
    checkbox.checked = selectedIndices.has(Number(checkbox.dataset.index));
  });
  updateBatchSelection();
});

batchDownloadBtnEl?.addEventListener('click', async () => {
  if (selectedIndices.size === 0) {
    return;
  }

  const batchSize = selectedIndices.size;
  showMessage(t('download_startedBatch', '开始批量下载 $1 个视频。', [String(batchSize)]), 'success');
  await startBatchDownload();
  videoListEl.querySelectorAll('.video-checkbox').forEach((checkbox) => {
    checkbox.checked = false;
  });
  updateBatchSelection();
});

globalThis.__OVD_I18N__?.applyI18n?.();

init();

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender?.tab?.id != null && currentTabId != null && sender.tab.id !== currentTabId) {
    return;
  }

  if (msg.type === (MSG.HLS_PROGRESS || 'HLS_PROGRESS')) {
    routeHlsProgress(msg);
    return;
  }

  if (msg.type === (MSG.UPDATE_BUTTON || 'UPDATE_BUTTON')) {
    void loadVideos();
    return;
  }

  if (msg.type === (MSG.DOWNLOAD_PROGRESS || 'DOWNLOAD_PROGRESS') && msg.downloadId != null && msg.percent != null) {
    showItemProgress(msg.downloadId, msg.percent);
    return;
  }

  if (msg.type === (MSG.DOWNLOAD_TASKS_UPDATED || 'DOWNLOAD_TASKS_UPDATED')) {
    void loadDownloadTasks({ renderTaskList: !tasksViewEl?.hidden });
    return;
  }

  if (msg.type === (MSG.BILIBILI_STREAM_PROGRESS || 'BILIBILI_STREAM_PROGRESS') && msg.percent != null) {
    routeProgressToActiveItem(msg.percent);
    return;
  }

  if (msg.type === (MSG.SOURCE_DOWNLOAD_PROGRESS || 'SOURCE_DOWNLOAD_PROGRESS') && msg.percent != null) {
    routeProgressToActiveItem(msg.percent);
    return;
  }

  if (msg.type === (MSG.SOURCE_DOWNLOAD_STATUS || 'SOURCE_DOWNLOAD_STATUS') && msg.message) {
    showMessage(msg.message, msg.level === 'error' ? 'error' : 'info', { key: sourceToastKey(msg) });
    return;
  }

  const lifecycle = normalizeSourceLifecycleMessage(msg);
  if (lifecycle) {
    handleSourceLifecycleMessage(lifecycle);
  }
});

async function init() {
  await Promise.all([loadYouTubePreferences(), loadBilibiliPreferences(), loadPopupSettings()]);

  const tabs = await new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, resolve));
  if (!tabs[0]) {
    return;
  }

  currentTabId = tabs[0].id;
  await loadVideos();
}

async function loadPopupSettings() {
  try {
    const settings = await generalSettingsStore.getSettings?.() || {};
    populatePopupSettings(settings);
    wirePopupSettings();
  } catch (err) {
    console.warn(`[OVD] failed to load popup settings: ${err.message}`);
    wirePopupSettings();
  }
}

function populatePopupSettings(settings = {}) {
  const concurrentInput = document.getElementById('popupConcurrentLimit');
  const notificationInput = document.getElementById('popupDownloadNotification');
  const youtubeModeSelect = document.getElementById('popupYoutubeDefaultMode');
  const filenameFormatSelect = document.getElementById('popupFilenameFormat');
  const downloadSubdirInput = document.getElementById('popupDownloadSubdir');
  const historyRetentionSelect = document.getElementById('popupHistoryRetention');
  const debugLoggingInput = document.getElementById('popupDebugLogging');
  const minDurationInput = document.getElementById('popupMinDuration');
  const minSizeInput = document.getElementById('popupMinSize');
  const domainBlacklistInput = document.getElementById('popupDomainBlacklist');
  const askSaveLocationInput = document.getElementById('popupAskSaveLocation');

  if (concurrentInput && settings.concurrentDownloadLimit != null) {
    concurrentInput.value = String(settings.concurrentDownloadLimit);
  }
  if (notificationInput && settings.downloadNotification != null) {
    notificationInput.checked = !!settings.downloadNotification;
  }
  if (youtubeModeSelect && settings.youtubeDefaultMode) {
    youtubeModeSelect.value = settings.youtubeDefaultMode;
  }
  if (filenameFormatSelect && settings.filenameFormat) {
    filenameFormatSelect.value = settings.filenameFormat;
  }
  if (downloadSubdirInput && settings.downloadSubdir != null) {
    downloadSubdirInput.value = settings.downloadSubdir;
  }
  if (historyRetentionSelect && settings.historyRetentionDays != null) {
    historyRetentionSelect.value = String(settings.historyRetentionDays);
  }
  if (debugLoggingInput && settings.debugLogging != null) {
    debugLoggingInput.checked = !!settings.debugLogging;
  }
  if (minDurationInput && settings.minVideoDurationSec != null) {
    minDurationInput.value = String(settings.minVideoDurationSec);
  }
  if (minSizeInput && settings.minVideoSizeMb != null) {
    minSizeInput.value = String(settings.minVideoSizeMb);
  }
  if (domainBlacklistInput && settings.domainBlacklist != null) {
    domainBlacklistInput.value = String(settings.domainBlacklist);
  }
  if (askSaveLocationInput && settings.askSaveLocation != null) {
    askSaveLocationInput.checked = !!settings.askSaveLocation;
  }
}

function wirePopupSettings() {
  if (wirePopupSettings.done) {
    return;
  }
  wirePopupSettings.done = true;

  const controls = [
    ['popupConcurrentLimit', 'concurrentDownloadLimit', (el) => Math.min(5, Math.max(1, parseInt(el.value, 10) || 3))],
    ['popupDownloadNotification', 'downloadNotification', (el) => el.checked],
    ['popupYoutubeDefaultMode', 'youtubeDefaultMode', (el) => el.value],
    ['popupFilenameFormat', 'filenameFormat', (el) => el.value],
    ['popupDownloadSubdir', 'downloadSubdir', (el) => el.value.replace(/[\\:*?"<>|]/g, '').trim()],
    ['popupHistoryRetention', 'historyRetentionDays', (el) => parseInt(el.value, 10)],
    ['popupDebugLogging', 'debugLogging', (el) => el.checked],
    ['popupMinDuration', 'minVideoDurationSec', (el) => Math.max(0, parseInt(el.value, 10) || 0)],
    ['popupMinSize', 'minVideoSizeMb', (el) => Math.max(0, parseInt(el.value, 10) || 0)],
    ['popupDomainBlacklist', 'domainBlacklist', (el) => el.value.trim()],
    ['popupAskSaveLocation', 'askSaveLocation', (el) => el.checked],
  ];

  controls.forEach(([id, key, readValue]) => {
    const el = document.getElementById(id);
    el?.addEventListener('change', async () => {
      try {
        await generalSettingsStore.updateSettings?.({ [key]: readValue(el) });
        showMessage(t('settings_saved', '设置已保存。'), 'success');
      } catch (err) {
        showMessage(t('settings_saveFailed', '设置保存失败: $1', [err.message]), 'error');
      }
    });
  });
}

function showSettingsView() {
  setHidden(mainViewEl, true);
  setHidden(historyViewEl, true);
  setHidden(tasksViewEl, true);
  setHidden(settingsViewEl, false);
  setHidden(actionBarEl, true);
}

function showMainView() {
  setHidden(settingsViewEl, true);
  setHidden(historyViewEl, true);
  setHidden(tasksViewEl, true);
  setHidden(mainViewEl, false);
  setHidden(actionBarEl, false);
}

async function showHistoryView() {
  setHidden(mainViewEl, true);
  setHidden(settingsViewEl, true);
  setHidden(tasksViewEl, true);
  setHidden(historyViewEl, false);
  setHidden(actionBarEl, true);
  await loadHistory();
}

async function showTasksView() {
  setHidden(mainViewEl, true);
  setHidden(settingsViewEl, true);
  setHidden(historyViewEl, true);
  setHidden(tasksViewEl, false);
  setHidden(actionBarEl, true);
  await loadDownloadTasks({ renderTaskList: true });
}

async function loadHistory() {
  if (!historyListEl) {
    return;
  }

  historyListEl.innerHTML = '';
  if (historySubtitleEl) {
    historySubtitleEl.textContent = '正在加载...';
  }

  try {
    const response = await sendRuntimeMessageAsync({
      type: MSG.GET_DOWNLOAD_HISTORY || 'GET_DOWNLOAD_HISTORY',
    });
    const records = Array.isArray(response?.records) ? response.records : [];
    renderHistory(records);
  } catch (err) {
    console.warn(`[OVD] failed to load history in popup: ${err.message}`);
    renderHistory([]);
  }
}

function renderHistory(records) {
  historyListEl.innerHTML = '';
  if (historySubtitleEl) {
    historySubtitleEl.textContent = t('history_count', '共 $1 条记录', [String(records.length)]);
  }
  if (clearHistoryBtnEl) {
    clearHistoryBtnEl.disabled = records.length === 0;
  }
  setHidden(historyEmptyEl, records.length > 0);

  records.forEach((record) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.dataset.id = record.id || '';

    const rawName = record.title || (record.filename ? record.filename.split(/[\\/]/).pop() : '');
    const title = rawName || '未知视频';
    const dateText = formatHistoryDate(record.timestamp);
    const sizeText = formatSize(record.size || 0) || '-';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'history-open';
    openButton.disabled = record.downloadId == null;
    openButton.innerHTML = `
      <span class="history-title">${escapeHtml(title)}</span>
      <span class="history-meta">${escapeHtml(getVideoTypeLabel(record.type || 'direct'))} · ${escapeHtml(sizeText)} · ${escapeHtml(dateText)}</span>
    `;
    openButton.addEventListener('click', () => openHistoryDownload(record.downloadId));

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'history-delete-btn';
    deleteButton.title = '删除';
    deleteButton.disabled = !record.id;
    deleteButton.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 6h18"/>
        <path d="M8 6V4h8v2"/>
        <path d="M19 6l-1 14H6L5 6"/>
        <path d="M10 11v6"/>
        <path d="M14 11v6"/>
      </svg>
    `;
    deleteButton.addEventListener('click', async () => {
      await deleteHistoryRecord(record.id, item);
    });

    item.append(openButton, deleteButton);
    historyListEl.appendChild(item);
  });
}

function formatHistoryDate(timestamp) {
  if (!timestamp) {
    return '-';
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
}

async function openHistoryDownload(downloadId) {
  if (downloadId == null) {
    showMessage('这条历史缺少下载 ID，无法打开文件夹。', 'error');
    return;
  }

  try {
    const response = await sendRuntimeMessageAsync({
      downloadId,
      type: MSG.OPEN_DOWNLOAD_FOLDER || 'OPEN_DOWNLOAD_FOLDER',
    });
    if (response?.ok === false) {
      throw new Error(response.error || '无法打开下载文件夹');
    }
  } catch (err) {
    showMessage(t('history_openFailed', '无法打开下载文件夹: $1', [err.message]), 'error');
  }
}

async function deleteHistoryRecord(recordId, itemEl) {
  if (!recordId) {
    return;
  }

  try {
    const response = await sendRuntimeMessageAsync({
      id: recordId,
      type: MSG.DELETE_DOWNLOAD_HISTORY_RECORD || 'DELETE_DOWNLOAD_HISTORY_RECORD',
    });
    if (response?.ok === false) {
      throw new Error(response.error || '删除失败');
    }

    itemEl.remove();
    const remaining = historyListEl.querySelectorAll('.history-item').length;
    if (historySubtitleEl) {
      historySubtitleEl.textContent = t('history_count', '共 $1 条记录', [String(remaining)]);
    }
    if (clearHistoryBtnEl) {
      clearHistoryBtnEl.disabled = remaining === 0;
    }
    setHidden(historyEmptyEl, remaining > 0);
  } catch (err) {
    showMessage(t('history_deleteFailed', '删除失败: $1', [err.message]), 'error');
  }
}

async function clearHistory() {
  if (!historyListEl || clearHistoryBtnEl?.disabled) {
    return;
  }

  try {
    if (clearHistoryBtnEl) {
      clearHistoryBtnEl.disabled = true;
    }
    const response = await sendRuntimeMessageAsync({
      type: MSG.CLEAR_DOWNLOAD_HISTORY || 'CLEAR_DOWNLOAD_HISTORY',
    });
    if (response?.ok === false) {
      throw new Error(response.error || '清空失败');
    }

    renderHistory([]);
  } catch (err) {
    if (clearHistoryBtnEl) {
      clearHistoryBtnEl.disabled = historyListEl.querySelectorAll('.history-item').length === 0;
    }
    showMessage(t('history_clearFailed', '清空失败: $1', [err.message]), 'error');
  }
}

async function loadYouTubePreferences() {
  try {
    youtubePreferenceCache = await youtubeModeStore.getPreferences?.() || youtubePreferenceCache;
  } catch (err) {
    console.warn(`[OVD] failed to load YouTube preferences in popup: ${err.message}`);
    youtubePreferenceCache = {
      ...(youtubeOptionFactory.DEFAULT_OPTIONS || {}),
      ...youtubePreferenceCache,
    };
  }
}

async function loadBilibiliPreferences() {
  try {
    bilibiliQualityCache = await bilibiliQualityStore.getPreferences?.() || bilibiliQualityCache;
  } catch (err) {
    console.warn(`[OVD] failed to load Bilibili preferences in popup: ${err.message}`);
  }
}

function cloneVideoWithDefaults(video) {
  const cloned = { ...video };
  if (cloned.type === 'youtube-adaptive') {
    const normalizedOptions = youtubeOptionFactory.normalizeYouTubeDownloadOptions?.(cloned) || {
      ...youtubePreferenceCache,
    };
    cloned.downloadOptions = {
      ...normalizedOptions,
      resolution: normalizeResolutionForVideo(cloned, normalizedOptions.resolution),
    };
    return cloned;
  }

  if (cloned.type === 'bilibili-meta') {
    cloned.downloadOptions = {
      ...(cloned.downloadOptions || {}),
      qualityId: cloned.downloadOptions?.qualityId || bilibiliQualityCache.qualityId || '',
    };
  }

  return cloned;
}

function normalizeResolutionForVideo(video, resolution) {
  // HLS 预合并选项：'hls:auto' 或 'hls:<variantUrl>'，不要被下面的"取可用清晰度"逻辑改写；
  // 但该视频没有 HLS 清单时（例如偏好被记住后换了视频）要退回普通清晰度逻辑
  if (typeof resolution === 'string' && resolution.startsWith('hls:')) {
    const hasManifest = typeof video?.hlsManifestUrl === 'string' && !!video.hlsManifestUrl;
    if (hasManifest) {
      return resolution;
    }
    resolution = 'auto';
  }

  const available = getYouTubeQualityOptions(video).map((item) => item.value);

  if (!resolution || resolution === 'auto' || !available.includes(resolution)) {
    return available[0] || resolution || 'auto';
  }

  return resolution;
}

function getSourceTaskKey(video) {
  return sourceUtils.buildTaskKey?.(video) || video?.url || video?.title || video?.type || 'video';
}

function findVideoUiByUrl(videoUrl) {
  const videoIndex = currentVideos.findIndex((video) => video.url === videoUrl);
  if (videoIndex < 0) {
    return null;
  }

  const item = videoListEl.querySelector(`.video-item[data-index="${videoIndex}"]`);
  const button = item?.querySelector('.dl-btn') || null;
  if (!item || !button) {
    return null;
  }

  return { button, item };
}

function trackBackgroundHlsTask(videoUrl, button) {
  const entry = {
    button,
    item: button?.closest('.video-item') || null,
    videoUrl: videoUrl || '',
  };
  if (entry.videoUrl) {
    activeBackgroundHlsTaskByUrl.set(entry.videoUrl, entry);
  }
  return entry;
}

function releaseBackgroundHlsTask(videoUrl) {
  if (videoUrl) {
    activeBackgroundHlsTaskByUrl.delete(videoUrl);
  }
}

function syncBackgroundHlsTaskEntry(entry) {
  if (!entry) {
    return null;
  }

  if (entry.button?.isConnected && entry.item?.isConnected) {
    return entry;
  }

  const nextUi = findVideoUiByUrl(entry.videoUrl);
  if (nextUi) {
    entry.button = nextUi.button;
    entry.item = nextUi.item;
  }
  return entry;
}

function syncTrackedSourceTaskEntry(entry) {
  if (!entry) {
    return null;
  }

  if (entry.button?.isConnected && entry.item?.isConnected) {
    return entry;
  }

  const nextUi = findVideoUiByUrl(entry.videoUrl);
  if (nextUi) {
    entry.button = nextUi.button;
    entry.item = nextUi.item;
  }
  return entry;
}

function setTrackedSourceTaskPending(entry) {
  const resolvedEntry = syncTrackedSourceTaskEntry(entry);
  if (!resolvedEntry?.button) {
    return;
  }

  setDownloadButtonState(resolvedEntry.button, 'pending');
}

function setTrackedSourceTaskFinished(entry, completed) {
  const resolvedEntry = syncTrackedSourceTaskEntry(entry);
  if (!resolvedEntry?.button) {
    return;
  }

  if (!completed) {
    setDownloadButtonState(resolvedEntry.button, 'idle');
    return;
  }

  setDownloadButtonState(resolvedEntry.button, 'completed');
  setTimeout(() => {
    const refreshedEntry = syncTrackedSourceTaskEntry(resolvedEntry);
    if (!refreshedEntry?.button) {
      return;
    }
    setDownloadButtonState(refreshedEntry.button, 'idle');
  }, 3000);
}

function trackSourceTask({ button = null, item = null, taskKey = '', traceId = '', videoUrl = '' } = {}) {
  const entry = {
    button,
    item: item || button?.closest('.video-item') || null,
    taskKey,
    traceId,
    videoUrl,
  };

  if (traceId) {
    activeSourceTaskByTraceId.set(traceId, entry);
  }
  if (taskKey) {
    activeSourceTaskByTaskKey.set(taskKey, entry);
  }

  setTrackedSourceTaskPending(entry);
  return entry;
}

function resolveTrackedSourceTask(msg = {}) {
  return (
    (msg.traceId ? activeSourceTaskByTraceId.get(msg.traceId) : null) ||
    (msg.taskKey ? activeSourceTaskByTaskKey.get(msg.taskKey) : null) ||
    null
  );
}

function releaseTrackedSourceTask(msg = {}, completed = false) {
  const entry = resolveTrackedSourceTask(msg);
  if (!entry) {
    return;
  }

  if (entry.traceId) {
    activeSourceTaskByTraceId.delete(entry.traceId);
  }
  if (entry.taskKey) {
    activeSourceTaskByTaskKey.delete(entry.taskKey);
  }

  setTrackedSourceTaskFinished(entry, completed);
}

function refreshTrackedSourceTaskButtons() {
  const seenEntries = new Set();

  for (const entry of activeSourceTaskByTraceId.values()) {
    seenEntries.add(entry);
  }
  for (const entry of activeSourceTaskByTaskKey.values()) {
    seenEntries.add(entry);
  }

  for (const entry of seenEntries) {
    setTrackedSourceTaskPending(entry);
  }
}

async function loadVideos() {
  if (!currentTabId) {
    return;
  }

  try {
    const response = await sendRuntimeMessageAsync({
      tabId: currentTabId,
      type: MSG.GET_VIDEOS_FOR_TAB || 'GET_VIDEOS_FOR_TAB',
    });
    if (response?.ok === false) {
      throw new Error(response.error || 'Failed to load videos');
    }
    currentVideos = (response?.videos || []).map((video) => cloneVideoWithDefaults(video));
    renderVideos(currentVideos);
    await loadDownloadStates();
    refreshTrackedSourceTaskButtons();
  } catch (err) {
    console.warn(`[OVD] failed to load popup videos: ${err.message}`);
    showMessage('无法连接到扩展后台。', 'error');
  }
}

async function loadDownloadStates() {
  await loadDownloadTasks({ renderTaskList: false });
}

async function loadDownloadTasks({ renderTaskList = false } = {}) {
  if (!currentTabId) {
    return;
  }

  try {
    const response = await sendRuntimeMessageAsync({
      tabId: currentTabId,
      type: MSG.GET_DOWNLOAD_TASKS || 'GET_DOWNLOAD_TASKS',
    });
    if (response?.ok === false) {
      throw new Error(response.error || 'Failed to load download tasks');
    }
    downloadTaskCache = Array.isArray(response?.tasks) ? response.tasks : [];
    downloadStateCache = {};
    for (const task of downloadTaskCache) {
      if (task.videoUrl && task.downloadId != null) {
        downloadStateCache[task.videoUrl] = {
          downloadId: task.downloadId,
          percent: task.percent || 0,
          state: task.status === 'complete' ? 'complete' : task.status === 'failed' ? 'failed' : 'downloading',
        };
      }
    }

    updateTaskEntryBadge(downloadTaskCache);
    applyTaskStatesToVideoList();
    if (renderTaskList) {
      renderTasks(downloadTaskCache);
    }
  } catch (err) {
    console.warn(`[OVD] failed to load popup download tasks: ${err.message}`);
    updateTaskEntryBadge([]);
    if (renderTaskList) {
      renderTasks([]);
    }
  }
}

function updateTaskEntryBadge(tasks = []) {
  if (!taskEntryBadgeEl) {
    return;
  }

  const runningCount = tasks.filter((task) => task.status === 'running' || task.status === 'retrying').length;
  if (runningCount <= 0) {
    taskEntryBadgeEl.hidden = true;
    taskEntryBadgeEl.textContent = '0';
    tasksBtnEl?.removeAttribute('aria-label');
    return;
  }

  taskEntryBadgeEl.hidden = false;
  taskEntryBadgeEl.textContent = runningCount > 99 ? '99+' : String(runningCount);
  tasksBtnEl?.setAttribute('aria-label', `${runningCount} 个下载任务进行中`);
}

function findTaskForVideo(video = {}) {
  const videoUrl = video.url || '';
  if (!videoUrl) {
    return null;
  }
  return downloadTaskCache.find((task) => (
    task.videoUrl === videoUrl ||
    task.videoInfo?.url === videoUrl
  )) || null;
}

function resetVideoDownloadButton(video = {}, item = null, btn = null) {
  if (!item || !btn || video.type === 'drm-detected') {
    return;
  }
  delete btn.dataset.downloadId;
  setDownloadButtonState(btn, 'idle');
  btn.disabled = false;
}

function applyTaskStatesToVideoList() {
  currentVideos.forEach((video, index) => {
    const task = findTaskForVideo(video);
    const item = videoListEl.querySelector(`.video-item[data-index="${index}"]`);
    const btn = item?.querySelector('.dl-btn');
    if (!item || !btn) {
      return;
    }

    if (!task) {
      resetVideoDownloadButton(video, item, btn);
      return;
    }

    if (task.downloadId != null) {
      btn.dataset.downloadId = String(task.downloadId);
    }

    if (task.status === 'running' || task.status === 'retrying') {
      applyItemProgress(item, btn, task.percent || 0);
      if ((task.percent || 0) <= 0) {
        setDownloadButtonState(btn, 'pending');
      }
      return;
    }

    if (task.status === 'complete') {
      applyItemProgress(item, btn, 100);
      return;
    }

    if (task.status === 'failed' || task.status === 'interrupted') {
      setDownloadButtonState(btn, 'idle');
      btn.disabled = false;
    }
  });
}

function renderTasks(tasks = []) {
  if (!taskListEl) {
    return;
  }
  taskListEl.innerHTML = '';
  if (tasksSubtitleEl) {
    const runningCount = tasks.filter((task) => task.status === 'running' || task.status === 'retrying').length;
    tasksSubtitleEl.textContent = runningCount > 0
      ? t('tasks_running', '$1 个任务进行中', [String(runningCount)])
      : t('tasks_total', '共 $1 个任务', [String(tasks.length)]);
  }
  setHidden(tasksEmptyEl, tasks.length > 0);

  tasks.forEach((task) => {
    const item = document.createElement('div');
    item.className = 'task-item';
    item.dataset.taskId = task.taskId || '';

    const title = escapeHtml(task.title || task.filename || task.videoUrl || '下载任务');
    const status = task.status || 'running';
    const percent = Math.max(0, Math.min(100, Math.round(Number(task.percent) || 0)));
    const message = status === 'failed' || status === 'interrupted'
      ? (task.error || task.message || task.phase || '')
      : (task.message || task.phase || '');
    const source = sourceLabelFromId(task.sourceId || 'generic');
    const timeText = formatTaskDate(task.updatedAt || task.createdAt);
    const messageClass = task.error || status === 'failed' || status === 'interrupted' ? ' error' : '';

    item.innerHTML = `
      <div class="task-head">
        <div class="task-title" title="${title}">${title}</div>
        <span class="task-status ${escapeHtml(status)}">${escapeHtml(getTaskStatusLabel(status))}</span>
      </div>
      <div class="task-meta">${escapeHtml(source)} · ${escapeHtml(timeText)}</div>
      <div class="task-progress">
        <div class="task-progress-track">
          <div class="task-progress-bar" style="width: ${percent}%"></div>
        </div>
        <span class="task-progress-text">${percent}%</span>
      </div>
      ${message ? `<div class="task-message${messageClass}">${escapeHtml(message)}</div>` : ''}
      <div class="task-actions"></div>
    `;

    const actions = item.querySelector('.task-actions');

    if ((status === 'running' || status === 'retrying') && task.tabId != null) {
      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'task-action-btn danger';
      cancelButton.textContent = t('tasks_cancel', '取消');
      cancelButton.addEventListener('click', () => cancelRunningTask(task, cancelButton));
      actions?.appendChild(cancelButton);
    }

    if ((status === 'failed' || status === 'interrupted') && task.taskId) {
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.className = 'task-action-btn';
      retryButton.textContent = t('tasks_retry', '重试');
      retryButton.addEventListener('click', () => retryTask(task.taskId, retryButton));
      actions?.appendChild(retryButton);
    }

    if (status === 'complete' && task.downloadId != null) {
      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'task-action-btn secondary';
      openButton.textContent = t('tasks_openLocation', '打开位置');
      openButton.addEventListener('click', () => openHistoryDownload(task.downloadId));
      actions?.appendChild(openButton);
    }

    if (task.taskId) {
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'task-action-btn danger';
      deleteButton.textContent = t('history_delete', '删除');
      deleteButton.addEventListener('click', () => deleteTask(task.taskId, deleteButton));
      actions?.appendChild(deleteButton);
    }

    taskListEl.appendChild(item);
  });
}

function getTaskStatusLabel(status) {
  const labels = {
    complete: t('taskStatus_complete', '已完成'),
    failed: t('taskStatus_failed', '失败'),
    interrupted: t('taskStatus_interrupted', '已中断'),
    retrying: t('taskStatus_retrying', '重试中'),
    running: t('taskStatus_running', '下载中'),
  };
  return labels[status] || '下载中';
}

function formatTaskDate(timestamp) {
  if (!timestamp) {
    return '-';
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 取消进行中的任务。
 * 内容侧任务（Bilibili/DASH/YouTube 录制）通过 ABORT 消息中止；
 * 已有 downloadId 的后台任务退回 chrome.downloads.cancel。
 */
async function cancelRunningTask(task = {}, button = null) {
  if (button) {
    button.disabled = true;
  }

  try {
    let cancelled = false;

    if (task.tabId != null) {
      const response = await sendTabMessageAsync(task.tabId, {
        taskKey: task.taskKey || '',
        traceId: task.traceId || '',
        type: MSG.ABORT_SOURCE_DOWNLOAD || 'ABORT_SOURCE_DOWNLOAD',
        videoUrl: task.videoUrl || '',
      }).catch(() => null);
      cancelled = !!response?.cancelled || !!response?.hlsCancelled;
    }

    if (!cancelled && task.downloadId != null && chrome.downloads?.cancel) {
      await new Promise((resolve) => chrome.downloads.cancel(task.downloadId, resolve));
      cancelled = true;
    }

    if (cancelled && task.taskId) {
      await sendRuntimeMessageAsync({
        taskId: task.taskId,
        type: MSG.DELETE_DOWNLOAD_TASK || 'DELETE_DOWNLOAD_TASK',
      }).catch(() => null);
    }

    showMessage(
      cancelled ? t('tasks_cancelled', '任务已取消。') : t('tasks_cancelUnavailable', '该任务当前无法取消，可能已在写入文件。'),
      cancelled ? 'success' : 'info'
    );
    await loadDownloadTasks({ renderTaskList: true });
  } catch (err) {
    showMessage(t('tasks_cancelFailed', '取消失败: $1', [err.message]), 'error');
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

async function retryTask(taskId, button) {
  if (!taskId) {
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = '重试中';
    }
    const response = await sendRuntimeMessageAsync({
      taskId,
      type: MSG.RETRY_DOWNLOAD_TASK || 'RETRY_DOWNLOAD_TASK',
    });
    if (response?.ok === false) {
      throw new Error(response.error || '重试失败');
    }
    await loadDownloadTasks({ renderTaskList: true });
  } catch (err) {
    showMessage(t('tasks_retryFailed', '重试失败: $1', [err.message]), 'error');
    await loadDownloadTasks({ renderTaskList: true });
  }
}

async function deleteTask(taskId, button) {
  if (!taskId) {
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = t('history_deleting', '删除中');
    }
    const response = await sendRuntimeMessageAsync({
      taskId,
      type: MSG.DELETE_DOWNLOAD_TASK || 'DELETE_DOWNLOAD_TASK',
    });
    if (response?.ok === false) {
      throw new Error(response.error || '删除失败');
    }
    await loadDownloadTasks({ renderTaskList: true });
  } catch (err) {
    showMessage(t('history_deleteFailed', '删除失败: $1', [err.message]), 'error');
    await loadDownloadTasks({ renderTaskList: true });
  }
}

function renderVideos(videos) {
  videoListEl.querySelectorAll('.video-item').forEach((el) => el.remove());

  setHidden(listHeaderEl, videos.length === 0);
  if (listCountEl) {
    listCountEl.textContent = videos.length > 0
      ? t('list_detected', '检测到 $1 个视频资源', [String(videos.length)])
      : t('list_none', '未检测到视频');
  }

  if (videos.length === 0) {
    subtitleEl.textContent = t('list_none', '未检测到视频');
    selectedIndices.clear();
    setHidden(emptyStateEl, false);
    updateBatchSelection();
    return;
  }

  subtitleEl.textContent = t('list_detected', '检测到 $1 个视频资源', [String(videos.length)]);
  setHidden(emptyStateEl, true);

  videos.forEach((video, index) => {
    videoListEl.appendChild(createVideoItem(video, index));
  });
  updateBatchSelection();
}

function createVideoItem(video, index) {
  const item = document.createElement('div');
  item.className = 'video-item';
  item.dataset.index = String(index);

  const typeLabel = video.type === 'audio'
    ? (getMediaFormatLabel?.(video) || getVideoTypeLabel(video.type))
    : getVideoTypeLabel(video.type);
  const typeClass = 'type-' + (video.type || 'direct').replace(/[^a-z-]/g, '');
  const title = escapeHtml(video.title || deriveTitleFromUrl(video.url) || t('title_unknownVideo', '未知视频'));
  const isDrm = video.type === 'drm-detected';
  const durationText = formatDuration(video.duration || 0) || '--:--';
  const thumbnailUrl = normalizeAssetUrl(video.thumbnail || video.cover || video.poster || '');

  item.innerHTML = `
    <input type="checkbox" class="video-checkbox" data-index="${index}" ${isDrm ? 'disabled' : ''} ${selectedIndices.has(index) ? 'checked' : ''}>
    ${buildThumbHtml(video, thumbnailUrl, durationText)}
    <div class="video-info">
      <div class="video-title-row">
        <div class="video-title" data-index="${index}" title="${title}">${title}</div>
      </div>
      <div class="video-controls-row">
        <button class="edit-title-btn" type="button" title="编辑标题">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>
          </svg>
        </button>
        ${buildFormatPillHtml(video, typeClass, typeLabel)}
        ${buildYouTubeControlsHtml(video, index)}
        ${buildBilibiliControlsHtml(video, index)}
        ${buildHlsControlsHtml(video, index)}
        ${buildMetaHtml(video)}
        <button class="dl-btn" data-index="${index}" ${isDrm ? 'disabled' : ''}>
          <span class="dl-label">${isDrm ? t('download_buttonProtected', '受保护') : t('download_button', '下载')}</span>
          ${isDrm ? '' : `
            <span class="dl-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3v12"/>
                <path d="M7 10l5 5 5-5"/>
                <path d="M5 21h14"/>
              </svg>
            </span>
          `}
        </button>
      </div>
      ${buildNoteHtml(video)}
    </div>
  `;

  const titleEl = item.querySelector('.video-title');
  titleEl?.addEventListener('click', () => startTitleEdit(titleEl, index));
  item.querySelector('.edit-title-btn')?.addEventListener('click', () => {
    const currentTitleEl = item.querySelector('.video-title');
    startTitleEdit(currentTitleEl, index);
  });
  const checkbox = item.querySelector('.video-checkbox');
  checkbox?.addEventListener('change', () => {
    if (checkbox.checked) {
      selectedIndices.add(index);
    } else {
      selectedIndices.delete(index);
    }
    updateBatchSelection();
  });

  wireYouTubeControls(item, index);
  wireBilibiliControls(item, index);
  wireHlsControls(item, index);
  wireThumbPreview(item, index);

  const btn = item.querySelector('.dl-btn');
  if (!btn.disabled) {
    btn.addEventListener('click', async () => {
      setDownloadButtonState(btn, 'pending');
      await triggerDownload(buildDownloadRequest(currentVideos[index]), btn);
    });
  }

  return item;
}

function buildFormatPillHtml(video, typeClass, typeLabel) {
  return `
    <div class="format-pill">
      <span class="type-badge ${typeClass}">${typeLabel}</span>
    </div>
  `;
}

function buildMetaHtml(video) {
  const metaText = getVideoMetaSizeText(video);

  if (!metaText) {
    return '';
  }

  return `<span class="video-meta-info">${escapeHtml(metaText)}</span>`;
}

function getVideoMetaSizeText(video) {
  if (!video) {
    return '';
  }

  if (video.type === 'youtube-adaptive') {
    const options = video.downloadOptions || youtubeOptionFactory.normalizeYouTubeDownloadOptions?.(video) || youtubePreferenceCache;
    const estimated = streamUtils.estimateYouTubeDownloadSize?.(video, options);
    if (estimated?.bytes) {
      return formatSize(estimated.bytes) || '';
    }
  }

  if (video.type === 'bilibili-meta') {
    const options = video.downloadOptions || { qualityId: bilibiliQualityCache.qualityId || 'auto' };
    const estimated = bilibiliQualityUtils.estimateBilibiliDownloadSize?.(video.dashStreams || video, options);
    if (estimated?.bytes) {
      return formatSize(estimated.bytes) || '';
    }
  }

  if (video.fileSize != null) {
    return formatSize(video.fileSize) || '';
  }

  return '';
}

function refreshVideoMeta(item, index) {
  const metaEl = item?.querySelector('.video-meta-info');
  if (!metaEl) {
    return;
  }

  const nextText = getVideoMetaSizeText(currentVideos[index]);
  if (!nextText) {
    metaEl.remove();
    return;
  }

  metaEl.textContent = nextText;
}

function buildNoteHtml(video) {
  if (video.type === 'youtube-adaptive') {
    const qualityOptions = streamUtils.listAvailableVideoQualities?.(video) || [];
    const hasCipherOnly = qualityOptions.some((item) => item.hasSignatureCipherOnly && !item.hasDirectUrl);
    if (hasCipherOnly) {
      return `<div class="note-text">${t('note_youtubeSignature', '部分高分辨率仍需要补充签名解析，扩展会继续尝试补全可下载地址。')}</div>`;
    }
    return '<div class="note-text">YouTube 下载模式可在设置中切换。</div>';
  }

  if (video.type === 'bilibili-meta') {
    return `<div class="note-text">${t('note_bilibili', 'Bilibili 会在页面侧解析并合并音视频。')}</div>`;
  }

  if (video.type === 'blob') {
    return `<div class="note-text">${t('note_blob', 'Blob 资源会先提取真实数据，再触发保存。')}</div>`;
  }

  if (video.type === 'hls') {
    return `<div class="note-text">${t('note_hls', 'HLS 可在清晰度下拉中选择具体码率；直播流只能保存当前播放窗口。')}</div>`;
  }

  if (video.type === 'audio') {
    return `<div class="note-text">${t('note_audio', '音频资源会走后台直链下载流程。')}</div>`;
  }

  if (video.type === 'drm-detected') {
    return `<div class="note-text">${t('note_drm', '该资源受 DRM 保护，无法下载。')}</div>`;
  }

  return '';
}

function buildYouTubeControlsHtml(video, index) {
  if (video.type !== 'youtube-adaptive') {
    return '';
  }

  const options = video.downloadOptions || youtubeOptionFactory.normalizeYouTubeDownloadOptions?.(video) || youtubePreferenceCache;
  const qualityOptions = getYouTubeQualityOptions(video);
  const modeValue = options.mode || 'capture';
  const resolutionValue = normalizeResolutionForVideo(video, options.resolution);
  // 有 HLS 预合并选项时不需要切到解析模式：这些选项与录制/解析模式无关
  const hasHlsOptions = typeof video.hlsManifestUrl === 'string' && !!video.hlsManifestUrl;
  const resolutionDisabled = modeValue !== 'parse' && !hasHlsOptions;

  return `
    <div class="youtube-controls" data-index="${index}">
      <label class="control-group">
        <span class="control-label">清晰度</span>
        <select class="control-select youtube-resolution-select" data-index="${index}" ${resolutionDisabled ? 'disabled' : ''}>
          ${qualityOptions.map((item) => `<option value="${escapeHtml(item.value)}" ${item.value === resolutionValue ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
        </select>
      </label>
      ${resolutionDisabled
        ? `<span class="control-hint">${t('youtube_switchToParse', '切到「解析下载」可选清晰度并合并音视频')}</span>`
        : ''}
    </div>
  `;
}

function getYouTubeQualityOptions(video) {
  const qualityOptions = streamUtils.listAvailableVideoQualities?.(video) || [];
  const options = [];

  qualityOptions.forEach((item) => {
    let suffix = '';
    if (!item.hasDirectUrl && item.hasSignatureCipherOnly) {
      suffix = t('quality_needsSignature', '（待签名解析）');
    } else if (item.hasCombined) {
      suffix = t('quality_withAudio', '（含音频）');
    } else if (item.hasAdaptive) {
      suffix = t('quality_needsMerge', '（需合并）');
    }

    options.push({
      value: item.label,
      label: `${item.label}${suffix}`,
    });
  });

  // YouTube 的高清晰度现在多以"预合并 HLS"提供（不要求 pot、音视频已合并），
  // 把它们追加到同一个清晰度下拉里：选它就按 HLS 清单下载，不必再合并。
  if (typeof video?.hlsManifestUrl === 'string' && video.hlsManifestUrl) {
    options.unshift({
      label: t('quality_hlsAuto', '自动（HLS 预合并，最高画质）'),
      value: 'hls:auto',
    });
    for (const variant of hlsVariantCache.get(video.hlsManifestUrl) || []) {
      options.push({
        label: `${variant.label}${variant.detail ? `（${variant.detail}）` : ''}·HLS`,
        value: `hls:${variant.url}`,
      });
    }
  }

  return options;
}

function wireYouTubeControls(item, index) {
  const video = currentVideos[index];
  if (!video || video.type !== 'youtube-adaptive') {
    return;
  }

  const resolutionSelect = item.querySelector('.youtube-resolution-select');
  if (!resolutionSelect) {
    return;
  }

  // 视频带 YouTube HLS 清单时，异步拉一次 Master Playlist 变体，
  // 把它们作为"HLS 预合并"选项补进同一个下拉（1080p 等常常只有 HLS 能下）
  if (typeof video.hlsManifestUrl === 'string' && video.hlsManifestUrl) {
    void ensureYouTubeHlsVariants(index, video, resolutionSelect);
  }

  resolutionSelect.addEventListener('change', async () => {
    const nextResolution = normalizeResolutionForVideo(currentVideos[index], resolutionSelect.value);
    currentVideos[index].downloadOptions = {
      ...(currentVideos[index].downloadOptions || {}),
      resolution: nextResolution,
    };

    try {
      youtubePreferenceCache = await youtubeModeStore.updatePreferences?.({
        mode: currentVideos[index].downloadOptions?.mode || youtubePreferenceCache.mode,
        resolution: nextResolution,
      }) || youtubePreferenceCache;
    } catch (err) {
      console.warn(`[OVD] failed to persist YouTube resolution preference: ${err.message}`);
    }

    refreshVideoMeta(item, index);
  });
}

/**
 * 拉取 YouTube HLS 清单的变体列表并刷新清晰度下拉。
 * 复用 HLS 条目那套 `HLS_FETCH_QUALITIES` 通道（页面上下文解析 Master Playlist）。
 */
async function ensureYouTubeHlsVariants(index, video, resolutionSelect) {
  const manifestUrl = video?.hlsManifestUrl || '';
  if (!manifestUrl || hlsVariantCache.has(manifestUrl)) {
    return;
  }

  try {
    const response = await sendTabMessageAsync(currentTabId, {
      frameId: video.frameId,
      headers: video.requestHeaders || {},
      m3u8Url: manifestUrl,
      type: MSG.HLS_FETCH_QUALITIES || 'HLS_FETCH_QUALITIES',
    });
    if (!response?.ok || !response.qualities?.length) {
      console.warn(
        `[OVD] YouTube HLS 变体获取失败: ${response?.error || 'no qualities'} url=${manifestUrl.slice(0, 120)}`
      );
      return;
    }

    hlsVariantCache.set(manifestUrl, response.qualities);
    console.log(`[OVD] YouTube HLS 变体已加载 count=${response.qualities.length}`);
  } catch (err) {
    console.warn(`[OVD] YouTube HLS 变体获取失败: ${err.message}`);
    return;
  }

  const current = currentVideos[index];
  if (!current || current.type !== 'youtube-adaptive') {
    return;
  }

  const selected = resolutionSelect.value;
  resolutionSelect.innerHTML = getYouTubeQualityOptions(current)
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join('');
  if (Array.from(resolutionSelect.options).some((option) => option.value === selected)) {
    resolutionSelect.value = selected;
  }
  resolutionSelect.disabled = (current.downloadOptions?.mode || 'capture') !== 'parse'
    && !(typeof current.hlsManifestUrl === 'string' && current.hlsManifestUrl);
}

/**
 * HLS 清晰度选择：Master Playlist 暴露的码率变体，选择后按 variantUrl 精确下载。
 */
function buildHlsControlsHtml(video, index) {
  if (video.type !== 'hls') {
    return '';
  }

  return `
    <div class="hls-controls" data-index="${index}">
      <label class="control-group">
        <span class="control-label">清晰度</span>
        <select class="control-select hls-quality-select" data-index="${index}">
          <option value="" selected>${t('quality_auto', '自动（最高画质）')}</option>
        </select>
      </label>
    </div>
  `;
}

function wireHlsControls(item, index) {
  const video = currentVideos[index];
  if (!video || video.type !== 'hls') {
    return;
  }

  const qualitySelect = item.querySelector('.hls-quality-select');
  if (!qualitySelect) {
    return;
  }

  let qualitiesFetched = false;
  let fetchInProgress = false;

  async function fetchAndPopulateQualities() {
    if (qualitiesFetched || fetchInProgress) {
      return;
    }

    fetchInProgress = true;
    qualitySelect.disabled = true;

    try {
      const response = await sendTabMessageAsync(currentTabId, {
        frameId: video.frameId,
        type: MSG.HLS_FETCH_QUALITIES || 'HLS_FETCH_QUALITIES',
        headers: currentVideos[index]?.requestHeaders || {},
        m3u8Url: video.url,
      });

      if (!response?.ok || !response.qualities?.length) {
        console.warn(
          `[OVD] HLS 画质获取失败: ${response?.error || 'no qualities'} url=${String(video.url || '').slice(0, 120)}`
        );
        return;
      }

      qualitySelect.innerHTML = `<option value="">${t('quality_auto', '自动（最高画质）')}</option>`;

      for (const quality of response.qualities) {
        const option = document.createElement('option');
        option.value = quality.url;
        option.dataset.label = quality.label;
        option.textContent = quality.detail ? `${quality.label}（${quality.detail}）` : quality.label;
        qualitySelect.appendChild(option);
      }

      const savedVariant = currentVideos[index]?.downloadOptions?.variantUrl;
      if (savedVariant && response.qualities.some((quality) => quality.url === savedVariant)) {
        qualitySelect.value = savedVariant;
      }

      qualitiesFetched = true;
      console.log(`[OVD] HLS 画质列表已加载 count=${response.qualities.length}`);
    } catch (err) {
      console.warn(`[OVD] HLS 画质获取失败: ${err.message}`);
    } finally {
      fetchInProgress = false;
      qualitySelect.disabled = false;
    }
  }

  qualitySelect.addEventListener('focus', fetchAndPopulateQualities);
  qualitySelect.addEventListener('click', fetchAndPopulateQualities);

  void fetchAndPopulateQualities();

  qualitySelect.addEventListener('change', () => {
    const option = qualitySelect.selectedOptions?.[0];
    currentVideos[index].downloadOptions = {
      ...(currentVideos[index].downloadOptions || {}),
      quality: option?.dataset?.label || '',
      variantUrl: qualitySelect.value || '',
    };
  });
}

function buildBilibiliControlsHtml(video, index) {
  if (video.type !== 'bilibili-meta') {
    return '';
  }

  return `
    <div class="bilibili-controls" data-index="${index}">
      <label class="control-group">
        <span class="control-label">清晰度</span>
        <select class="control-select bilibili-quality-select" data-index="${index}">
          <option value="" disabled selected>${t('quality_loading', '加载中…')}</option>
        </select>
      </label>
    </div>
  `;
}

function wireBilibiliControls(item, index) {
  const video = currentVideos[index];
  if (!video || video.type !== 'bilibili-meta') {
    return;
  }

  const qualitySelect = item.querySelector('.bilibili-quality-select');
  if (!qualitySelect) {
    return;
  }

  let qualitiesFetched = false;
  let fetchInProgress = false;

  async function fetchAndPopulateQualities() {
    if (qualitiesFetched || fetchInProgress) {
      return;
    }

    fetchInProgress = true;
    qualitySelect.disabled = true;

    try {
      const response = await sendTabMessageAsync(currentTabId, {
        type: MSG.BILIBILI_FETCH_QUALITIES || 'BILIBILI_FETCH_QUALITIES',
        meta: { bvid: video.bvid, cid: video.cid },
      });

      if (!response?.ok || !response.qualities?.length) {
        console.warn('[OVD] Bilibili 画质获取失败或无可用画质');
        qualitiesFetched = false;
        return;
      }

      if (response.dash) {
        currentVideos[index] = {
          ...currentVideos[index],
          dashStreams: response.dash,
        };
      }

      qualitySelect.innerHTML = '';

      for (const q of response.qualities) {
        const option = document.createElement('option');
        option.value = String(q.id);
        option.textContent = q.label;
        qualitySelect.appendChild(option);
      }

      const cachedQualityId = bilibiliQualityCache.qualityId;
      if (cachedQualityId && cachedQualityId !== 'auto' && response.qualities.some((q) => String(q.id) === cachedQualityId)) {
        qualitySelect.value = cachedQualityId;
      }

      qualitiesFetched = true;
      console.log(`[OVD] Bilibili 画质列表已加载 count=${response.qualities.length}`);
    } catch (err) {
      console.warn(`[OVD] Bilibili 画质获取失败: ${err.message}`);
    } finally {
      fetchInProgress = false;
      qualitySelect.disabled = false;
    }
  }

  qualitySelect.addEventListener('focus', fetchAndPopulateQualities);
  qualitySelect.addEventListener('click', fetchAndPopulateQualities);

  fetchAndPopulateQualities();

  qualitySelect.addEventListener('change', async () => {
    const nextQualityId = qualitySelect.value;
    currentVideos[index].downloadOptions = {
      ...(currentVideos[index].downloadOptions || {}),
      qualityId: nextQualityId,
    };

    try {
      bilibiliQualityCache = await bilibiliQualityStore.updatePreferences?.({
        qualityId: nextQualityId,
      }) || bilibiliQualityCache;
    } catch (err) {
      console.warn(`[OVD] failed to persist Bilibili quality preference: ${err.message}`);
    }

    refreshVideoMeta(item, index);
  });
}

function startTitleEdit(titleEl, index) {
  startInlineTitleEdit({
    buildDisplayElement: (newTitle) => {
      const newTitleEl = document.createElement('div');
      newTitleEl.className = 'video-title';
      newTitleEl.dataset.index = String(index);
      newTitleEl.title = newTitle;
      newTitleEl.textContent = newTitle;
      newTitleEl.addEventListener('click', () => startTitleEdit(newTitleEl, index));
      return newTitleEl;
    },
    currentValue: currentVideos[index]?.title || titleEl.textContent || '',
    inputClassName: 'video-title-input',
    onCommit: (newTitle) => {
      if (currentVideos[index]) {
        currentVideos[index].title = newTitle;
      }
    },
    titleElement: titleEl,
  });
}

function buildDownloadRequest(video) {
  if (video?.type === 'youtube-adaptive') {
    const selectedOptions = youtubeOptionFactory.normalizeYouTubeDownloadOptions?.(video) || {
      ...youtubePreferenceCache,
      ...(video.downloadOptions || {}),
    };

    return {
      ...video,
      downloadOptions: {
        ...selectedOptions,
        resolution: normalizeResolutionForVideo(video, selectedOptions.resolution),
      },
    };
  }

  if (video?.type === 'bilibili-meta') {
    return {
      ...video,
      downloadOptions: {
        qualityId: video.downloadOptions?.qualityId || bilibiliQualityCache.qualityId || 'auto',
      },
    };
  }

  return { ...video };
}

function normalizeSourceLifecycleMessage(msg) {
  if (
    msg.type === (MSG.SOURCE_DOWNLOAD_STARTED || 'SOURCE_DOWNLOAD_STARTED') ||
    msg.type === (MSG.SOURCE_DOWNLOAD_RESULT || 'SOURCE_DOWNLOAD_RESULT')
  ) {
    return msg;
  }

  const legacyMap = {
    [MSG.BILIBILI_DOWNLOAD_STARTED || 'BILIBILI_DOWNLOAD_STARTED']: {
      sourceId: 'bilibili',
      type: MSG.SOURCE_DOWNLOAD_STARTED || 'SOURCE_DOWNLOAD_STARTED',
    },
    [MSG.BILIBILI_DOWNLOAD_RESULT || 'BILIBILI_DOWNLOAD_RESULT']: {
      sourceId: 'bilibili',
      type: MSG.SOURCE_DOWNLOAD_RESULT || 'SOURCE_DOWNLOAD_RESULT',
    },
    [MSG.YOUTUBE_DOWNLOAD_STARTED || 'YOUTUBE_DOWNLOAD_STARTED']: {
      sourceId: 'youtube',
      type: MSG.SOURCE_DOWNLOAD_STARTED || 'SOURCE_DOWNLOAD_STARTED',
    },
    [MSG.YOUTUBE_DOWNLOAD_RESULT || 'YOUTUBE_DOWNLOAD_RESULT']: {
      sourceId: 'youtube',
      type: MSG.SOURCE_DOWNLOAD_RESULT || 'SOURCE_DOWNLOAD_RESULT',
    },
  };

  if (!legacyMap[msg.type]) {
    return null;
  }

  return {
    ...msg,
    ...legacyMap[msg.type],
  };
}

function handleSourceLifecycleMessage(msg) {
  const sourceId = msg.sourceId || 'generic';
  const sourceLabel = sourceLabelFromId(sourceId);
  // 同一次下载的状态/结果共用一个 toast（就地更新），避免堆出多条几乎一样的提示
  const toastKey = sourceToastKey(msg);

  if (msg.type === (MSG.SOURCE_DOWNLOAD_STARTED || 'SOURCE_DOWNLOAD_STARTED')) {
    const trackedEntry = resolveTrackedSourceTask(msg);
    if (trackedEntry) {
      setTrackedSourceTaskPending(trackedEntry);
    }
    showMessage(buildSourceStartedMessage(sourceLabel, msg.strategyId), 'info', { key: toastKey });
    return;
  }

  const entry = resolveTrackedSourceTask(msg);

  if (msg.ok) {
    // 更新条目内进度条至 100%，再释放跟踪
    if (entry?.item && entry.button) {
      applyItemProgress(entry.item, entry.button, 100);
    }
    releaseTrackedSourceTask(msg, true);
    showMessage(t('download_done', '$1 下载完成。', [sourceLabel]), 'success', { key: toastKey });
    return;
  }

  releaseTrackedSourceTask(msg, false);
  const friendly = popupErrorMessages.buildFriendlyErrorMessage?.({
    code: msg.code,
    message: msg.error || '未知错误',
  });
  showMessage(`${sourceLabel} 下载失败: ${friendly?.text || msg.error || '未知错误'}`, 'error', { key: toastKey });
}

/**
 * 同一次下载（同 taskKey / traceId）的提示共用一个 toast 槽位。
 * 返回空串时表示无法归类，此时退化为「连续重复文案不重复弹出」的默认行为。
 */
function sourceToastKey(msg = {}) {
  const identity = msg.taskKey || msg.traceId || '';
  return identity ? `source:${identity}` : '';
}

function sourceLabelFromId(sourceId) {
  const labels = {
    bilibili: 'Bilibili',
    blob: 'Blob',
    generic: '视频',
    youtube: 'YouTube',
  };

  return labels[sourceId] || '视频';
}

function buildSourceStartedMessage(sourceLabel, strategyId) {
  const strategyMessageMap = {
    'background-download': '已提交后台下载。',
    'blob-fetch': '已启动页面内 Blob 提取流程。',
    'page-api': '已启动页面内解析与合并流程。',
    'youtube-capture': '已启动页面录制策略，请保持标签页打开。',
    'youtube-parse': '已启动解析下载与音视频合并流程。',
  };

  return `${sourceLabel} ${strategyMessageMap[strategyId] || '下载已开始。'}`;
}

function showItemProgress(downloadId, percent) {
  const buttons = videoListEl.querySelectorAll(`.dl-btn[data-download-id="${downloadId}"]`);
  if (buttons.length === 0) {
    for (const [url, cached] of Object.entries(downloadStateCache)) {
      if (cached.downloadId !== downloadId) {
        continue;
      }

      const nextUi = findVideoUiByUrl(url);
      if (nextUi) {
        nextUi.button.dataset.downloadId = String(downloadId);
        applyItemProgress(nextUi.item, nextUi.button, percent);
      }
      break;
    }
    return;
  }

  buttons.forEach((btn) => {
    const item = btn.closest('.video-item');
    if (item) {
      applyItemProgress(item, btn, percent);
    }
  });
}

function applyItemProgress(item, btn, percent) {
  const safePercent = Number.isFinite(Number(percent))
    ? Math.max(0, Math.min(100, Math.round(Number(percent))))
    : 0;

  if (safePercent >= 100) {
    setDownloadButtonState(btn, 'completed');
    btn.removeAttribute('aria-label');
    return;
  }

  if (safePercent > 0) {
    setDownloadButtonState(btn, 'downloading');
    const label = btn.querySelector('.dl-label');
    if (label) {
      label.textContent = t('download_percent', '下载中 $1%', [String(safePercent)]);
    }
    btn.setAttribute('aria-label', `下载中 ${safePercent}%`);
  }
}

async function triggerDownload(video, btn) {
  let pendingSourceTask = null;
  let pendingBackgroundHlsTask = null;

  try {
    let downloadVideo = video;
    if (video?.type === 'youtube-adaptive') {
      const normalizedOptions = youtubeOptionFactory.normalizeYouTubeDownloadOptions?.(video) || {
        ...youtubePreferenceCache,
        ...(video.downloadOptions || {}),
      };
      const resolution = normalizeResolutionForVideo(video, normalizedOptions.resolution);

      if (typeof resolution === 'string' && resolution.startsWith('hls:') && video.hlsManifestUrl) {
        // 选了"HLS 预合并"清晰度：改走 HLS 下载链路（清单 + 变体），不需要再合并音视频
        const variantUrl = resolution === 'hls:auto' ? '' : resolution.slice('hls:'.length);
        downloadVideo = {
          ...video,
          // 'hls:auto' 时不传 quality（交给 HLS 链路选最高画质），选了具体变体才带上
          downloadOptions: { ...normalizedOptions, quality: variantUrl ? resolution : '', variantUrl },
          type: 'hls',
          url: video.hlsManifestUrl,
        };
      } else {
        downloadVideo = {
          ...video,
          downloadOptions: {
            ...normalizedOptions,
            resolution,
          },
        };
        youtubePreferenceCache = await youtubeModeStore.updatePreferences?.({
          mode: downloadVideo.downloadOptions.mode,
          resolution: downloadVideo.downloadOptions.resolution,
        }) || youtubePreferenceCache;
      }
    }

    const executionMode = sourceUtils.getExecutionMode?.(downloadVideo) || 'background';
    const sourceLabel = sourceUtils.getSourceLabel?.(downloadVideo) || sourceLabelFromId(sourceUtils.getSourceId?.(downloadVideo));
    // 本次下载的所有提示（开始/已在执行/失败）共用同一个 toast 槽位
    const downloadToastKey = `source:${getSourceTaskKey(downloadVideo)}`;

    if (executionMode === 'content') {
      const taskKey = getSourceTaskKey(downloadVideo);
      pendingSourceTask = trackSourceTask({
        button: btn,
        taskKey,
        videoUrl: downloadVideo?.url || '',
      });

      const response = await sendTabMessageAsync(currentTabId, {
        meta: downloadVideo,
        type: MSG.SOURCE_DOWNLOAD || 'SOURCE_DOWNLOAD',
      });

      if (!response?.ok) {
        releaseTrackedSourceTask({ taskKey, traceId: pendingSourceTask.traceId }, false);
        throw new Error(response?.error || t('download_failed', '$1 下载失败', [sourceLabel]));
      }

      pendingSourceTask.traceId = response.traceId || pendingSourceTask.traceId;
      pendingSourceTask.taskKey = response.taskKey || pendingSourceTask.taskKey;
      trackSourceTask(pendingSourceTask);

      if (response.alreadyRunning) {
        showMessage(t('download_alreadyRunning', '$1 下载任务已在执行中。', [sourceLabel]), 'info', { key: downloadToastKey });
      } else if (response.started) {
        showMessage(buildSourceStartedMessage(sourceLabel, response.strategyId), 'success', { key: downloadToastKey });
      }
      void loadDownloadTasks({ renderTaskList: !tasksViewEl?.hidden });
      return;
    }

    if (downloadVideo?.type === 'hls') {
      pendingBackgroundHlsTask = trackBackgroundHlsTask(downloadVideo.url, btn);
    }

    const response = await sendRuntimeMessageAsync({
      payload: downloadVideo,
      tabId: currentTabId,
      type: MSG.DOWNLOAD_VIDEO || 'DOWNLOAD_VIDEO',
    });

    if (!response?.ok) {
      throw new Error(response?.error || t('error_unknown', '未知错误'));
    }

    const isHlsDownload = downloadVideo?.type === 'hls';
    const downloadId = response.downloadId ?? response.results?.[0]?.downloadId;
    if (downloadId != null) {
      btn.dataset.downloadId = String(downloadId);
      downloadStateCache[downloadVideo.url] = { downloadId, percent: 0, state: 'downloading' };
      setDownloadButtonState(btn, 'downloading');
    } else if (isHlsDownload) {
      const item = btn.closest('.video-item');
      if (item) {
        applyItemProgress(item, btn, 100);
      } else {
        setDownloadButtonState(btn, 'completed');
      }
    } else {
      setDownloadButtonState(btn, 'downloading');
    }
    releaseBackgroundHlsTask(downloadVideo.url);
    void loadDownloadTasks({ renderTaskList: !tasksViewEl?.hidden });

    showMessage(t('download_started', '下载已开始。'), 'success', { key: downloadToastKey });
  } catch (err) {
    if (pendingSourceTask) {
      releaseTrackedSourceTask(pendingSourceTask, false);
    }
    if (pendingBackgroundHlsTask) {
      releaseBackgroundHlsTask(pendingBackgroundHlsTask.videoUrl);
    }

    const friendly = popupErrorMessages.buildFriendlyErrorMessage?.({
      code: err.code,
      message: err.message,
    });
    const friendlyMessage = friendly?.text || err.message;
    if (friendlyMessage !== err.message) {
      console.warn(`[OVD] 原始错误信息: ${err.message}`);
    }

    showMessage(t('error_prefix', '错误: $1', [friendlyMessage]), 'error', { key: downloadToastKey });
    setDownloadButtonState(btn, 'idle');
  }
}

function updateBatchSelection() {
  const selectableCount = currentVideos.filter((video) => video.type !== 'drm-detected').length;
  const selectedCount = selectedIndices.size;

  if (batchDownloadBtnEl) {
    batchDownloadBtnEl.textContent = `下载所选 (${selectedCount})`;
    batchDownloadBtnEl.disabled = selectedCount === 0;
  }

  if (selectAllCheckboxEl) {
    selectAllCheckboxEl.checked = selectableCount > 0 && selectedCount >= selectableCount;
    selectAllCheckboxEl.indeterminate = selectedCount > 0 && selectedCount < selectableCount;
  }
}

async function startBatchDownload() {
  const indices = [...selectedIndices].sort((a, b) => a - b);
  if (indices.length === 0) {
    return;
  }

  const settings = await generalSettingsStore.getSettings?.() || {};
  const maxConcurrent = settings.concurrentDownloadLimit || 3;

  let running = 0;
  let nextIdx = 0;

  await new Promise((resolveAll) => {
    function startNext() {
      while (running < maxConcurrent && nextIdx < indices.length) {
        const videoIndex = indices[nextIdx++];
        const videoItem = videoListEl.querySelector(`.video-item[data-index="${videoIndex}"]`);
        const btn = videoItem?.querySelector('.dl-btn');
        if (!btn || btn.disabled) {
          continue;
        }

        running++;
        const video = buildDownloadRequest(currentVideos[videoIndex]);
        triggerDownload(video, btn).finally(() => {
          running--;
          startNext();
          if (running === 0 && nextIdx >= indices.length) {
            resolveAll();
          }
        });
      }

      if (running === 0 && nextIdx >= indices.length) {
        resolveAll();
      }
    }
    startNext();
  });

  selectedIndices.clear();
  videoListEl.querySelectorAll('.video-checkbox').forEach((checkbox) => {
    checkbox.checked = false;
  });
  updateBatchSelection();
}

const TOAST_MAX_VISIBLE = 3;
const TOAST_HIDE_DELAY_MS = { success: 2800, info: 3000, error: 6000 };
const TOAST_FADE_MS = 240;
// 同一个下载任务的提示（获取地址 → 获取数据 → 合并 → 完成/失败）复用同一个 toast 就地更新，
// 否则一次下载会堆出多条「正在获取 Bilibili 视音频数据...」这类几乎一样的提示。
const toastByKey = new Map();

function forgetToast(toast) {
  const key = toast?.__toastKey;
  if (key && toastByKey.get(key) === toast) {
    toastByKey.delete(key);
  }
}

function dismissToast(toast) {
  if (!toast || toast.dataset.dismissing === '1') {
    return;
  }

  toast.dataset.dismissing = '1';
  clearTimeout(toast.__hideTimer);
  toast.classList.remove('toast-visible');
  setTimeout(() => {
    toast.remove();
    forgetToast(toast);
  }, TOAST_FADE_MS);
}

function removeToastImmediately(toast) {
  if (!toast) {
    return;
  }

  clearTimeout(toast.__hideTimer);
  toast.remove();
  forgetToast(toast);
}

/**
 * @param {string} text
 * @param {'info'|'success'|'error'} [type]
 * @param {{ key?: string }} [options] - key 相同的提示复用同一个 toast（同任务状态就地更新）
 */
function showMessage(text, type = 'info', options = {}) {
  if (type === 'error') {
    console.warn(`[OVD] ${text}`);
  }

  const container = document.getElementById('toastContainer');
  if (!container) {
    return;
  }

  const normalizedType = Object.prototype.hasOwnProperty.call(TOAST_HIDE_DELAY_MS, type) ? type : 'info';
  const message = String(text ?? '');
  const key = String(options?.key || '');

  const refreshTimer = (toast) => {
    clearTimeout(toast.__hideTimer);
    toast.__hideTimer = setTimeout(() => dismissToast(toast), TOAST_HIDE_DELAY_MS[normalizedType]);
  };

  if (key) {
    const existing = toastByKey.get(key);
    if (existing?.isConnected) {
      existing.className = `toast toast-${normalizedType} toast-visible`;
      existing.textContent = message;
      refreshTimer(existing);
      return existing;
    }
  }

  // 连续重复文案（例如多个 frame 上报同一条状态）只更新时间，不再补一条
  const lastToast = container.lastElementChild;
  if (lastToast && lastToast.dataset.dismissing !== '1' && lastToast.textContent === message) {
    refreshTimer(lastToast);
    return lastToast;
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${normalizedType}`;
  toast.textContent = message;
  if (key) {
    toast.__toastKey = key;
    toastByKey.set(key, toast);
  }
  container.appendChild(toast);

  while (container.children.length > TOAST_MAX_VISIBLE) {
    removeToastImmediately(container.firstElementChild);
  }

  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  refreshTimer(toast);
  return toast;
}

function routeHlsProgress(msg = {}) {
  const percent = msg.percent || 0;
  const videoUrl = msg.videoUrl || '';
  if (videoUrl) {
    const entry = syncBackgroundHlsTaskEntry(activeBackgroundHlsTaskByUrl.get(videoUrl));
    if (entry?.button?.isConnected) {
      applyItemProgress(entry.item, entry.button, percent);
      return;
    }

    const ui = findVideoUiByUrl(videoUrl);
    if (ui) {
      applyItemProgress(ui.item, ui.button, percent);
      return;
    }
  }

  routeProgressToActiveItem(percent);
  if (activeBackgroundHlsTaskByUrl.size !== 1) {
    return;
  }

  const [entry] = activeBackgroundHlsTaskByUrl.values();
  const resolved = syncBackgroundHlsTaskEntry(entry);
  if (resolved?.button?.isConnected) {
    applyItemProgress(resolved.item, resolved.button, percent);
  }
}

/** 将进度更新路由到当前活跃的源下载条目内进度条 */
function routeProgressToActiveItem(percent) {
  for (const entry of activeSourceTaskByTraceId.values()) {
    const resolved = syncTrackedSourceTaskEntry(entry);
    if (resolved?.button?.isConnected) {
      applyItemProgress(resolved.item, resolved.button, percent);
      return;
    }
  }
  for (const entry of activeSourceTaskByTaskKey.values()) {
    const resolved = syncTrackedSourceTaskEntry(entry);
    if (resolved?.button?.isConnected) {
      applyItemProgress(resolved.item, resolved.button, percent);
      return;
    }
  }
}
