// lib/settings-store.js
// 通用设置持久化
// 存储扩展全局设置：并发下载数、通知、调试、文件名格式等
// 以 <script> 方式加载，暴露全局 SettingsStore

'use strict';

(() => {
  if (globalThis.__OVD_GENERAL_SETTINGS_STORE__) {
    return;
  }

  const STORAGE_KEY = 'ovd.generalSettings';
  const DEFAULT_SETTINGS = Object.freeze({
    concurrentDownloadLimit: 3,
    downloadNotification: true,
    debugLogging: false,
    youtubeDefaultMode: 'capture',
    bilibiliDefaultQuality: 'auto',
    filenameFormat: 'title',
    downloadSubdir: 'OnlineVideoDownload',
    historyRetentionDays: 30,
  });

  let initialized = false;
  let initPromise = null;
  let settingsCache = { ...DEFAULT_SETTINGS };

  function listenStorageChanges() {
    if (listenStorageChanges._attached || !chrome?.storage?.onChanged) {
      return;
    }

    listenStorageChanges._attached = true;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      if (changes[STORAGE_KEY]) {
        settingsCache = {
          ...DEFAULT_SETTINGS,
          ...(changes[STORAGE_KEY].newValue || {}),
        };
      }
    });
  }

  async function init() {
    if (initialized) {
      return getCachedSettings();
    }

    if (!chrome?.storage?.local?.get) {
      initialized = true;
      return getCachedSettings();
    }

    if (!initPromise) {
      initPromise = chrome.storage.local.get([STORAGE_KEY])
        .then((items) => {
          if (items[STORAGE_KEY] && typeof items[STORAGE_KEY] === 'object') {
            settingsCache = {
              ...DEFAULT_SETTINGS,
              ...items[STORAGE_KEY],
            };
          }
          initialized = true;
          listenStorageChanges();
          return getCachedSettings();
        })
        .catch((err) => {
          console.warn('[OVD][settings-store] init failed', err);
          initialized = true;
          return getCachedSettings();
        });
    }

    return initPromise;
  }

  function getCachedSettings() {
    return {
      ...DEFAULT_SETTINGS,
      ...settingsCache,
    };
  }

  async function getSettings() {
    await init();
    return getCachedSettings();
  }

  async function updateSettings(partialSettings = {}) {
    const nextSettings = {
      ...getCachedSettings(),
      ...partialSettings,
    };
    settingsCache = nextSettings;

    if (!chrome?.storage?.local?.set) {
      return nextSettings;
    }

    await chrome.storage.local.set({
      [STORAGE_KEY]: nextSettings,
    });
    return nextSettings;
  }

  globalThis.__OVD_GENERAL_SETTINGS_STORE__ = {
    DEFAULT_SETTINGS,
    getCachedSettings,
    getSettings,
    init,
    updateSettings,
  };
})();
