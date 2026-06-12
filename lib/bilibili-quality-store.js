// lib/bilibili-quality-store.js
// B站视频清晰度偏好持久化
// 存储用户选择的 Bilibili 默认画质偏好
// 以 <script> 方式加载，暴露全局 BilibiliQualityStore

'use strict';

(() => {
  if (globalThis.__OVD_BILIBILI_QUALITY_STORE__) {
    return;
  }

  const STORAGE_KEY = 'ovd.bilibiliQualityPrefs';
  const DEFAULT_PREFERENCES = Object.freeze({
    qualityId: 'auto',
  });

  let initialized = false;
  let initPromise = null;
  let preferenceCache = { ...DEFAULT_PREFERENCES };

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
        preferenceCache = {
          ...DEFAULT_PREFERENCES,
          ...(changes[STORAGE_KEY].newValue || {}),
        };
      }
    });
  }

  async function init() {
    if (initialized) {
      return getCachedPreferences();
    }

    if (!chrome?.storage?.local?.get) {
      initialized = true;
      return getCachedPreferences();
    }

    if (!initPromise) {
      initPromise = chrome.storage.local.get([STORAGE_KEY])
        .then((items) => {
          if (items[STORAGE_KEY] && typeof items[STORAGE_KEY] === 'object') {
            preferenceCache = {
              ...DEFAULT_PREFERENCES,
              ...items[STORAGE_KEY],
            };
          }
          initialized = true;
          listenStorageChanges();
          return getCachedPreferences();
        })
        .catch((err) => {
          console.warn('[OVD][bilibili-store] init failed', err);
          initialized = true;
          return getCachedPreferences();
        });
    }

    return initPromise;
  }

  function getCachedPreferences() {
    return {
      ...DEFAULT_PREFERENCES,
      ...preferenceCache,
    };
  }

  async function getPreferences() {
    await init();
    return getCachedPreferences();
  }

  async function updatePreferences(partialPreferences = {}) {
    const nextPreferences = {
      ...getCachedPreferences(),
      ...partialPreferences,
    };
    preferenceCache = nextPreferences;

    if (!chrome?.storage?.local?.set) {
      return nextPreferences;
    }

    await chrome.storage.local.set({
      [STORAGE_KEY]: nextPreferences,
    });
    return nextPreferences;
  }

  globalThis.__OVD_BILIBILI_QUALITY_STORE__ = {
    DEFAULT_PREFERENCES,
    getCachedPreferences,
    getPreferences,
    init,
    updatePreferences,
  };
})();
