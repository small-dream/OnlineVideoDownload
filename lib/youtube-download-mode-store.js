'use strict';

(() => {
  if (globalThis.__OVD_YOUTUBE_DOWNLOAD_MODE_STORE__) {
    return;
  }

  const STORAGE_KEY = 'ovd.youtubeDownloadPrefs';
  const DEBUG_STORAGE_KEY = 'ovd.debug';
  const DEFAULT_PREFERENCES = Object.freeze({
    fallbackToLowerQuality: true,
    mode: 'capture',
    preferCombined: true,
    resolution: 'auto',
  });
  const DEFAULT_DEBUG_SETTINGS = Object.freeze({
    youtube: false,
  });

  let initialized = false;
  let initPromise = null;
  let preferenceCache = { ...DEFAULT_PREFERENCES };
  let debugCache = { ...DEFAULT_DEBUG_SETTINGS };

  function syncCaches(items = {}) {
    if (items[STORAGE_KEY] && typeof items[STORAGE_KEY] === 'object') {
      preferenceCache = {
        ...DEFAULT_PREFERENCES,
        ...items[STORAGE_KEY],
      };
    }

    if (items[DEBUG_STORAGE_KEY] && typeof items[DEBUG_STORAGE_KEY] === 'object') {
      debugCache = {
        ...DEFAULT_DEBUG_SETTINGS,
        ...items[DEBUG_STORAGE_KEY],
      };
    }
  }

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

      if (changes[DEBUG_STORAGE_KEY]) {
        debugCache = {
          ...DEFAULT_DEBUG_SETTINGS,
          ...(changes[DEBUG_STORAGE_KEY].newValue || {}),
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
      initPromise = chrome.storage.local.get([STORAGE_KEY, DEBUG_STORAGE_KEY])
        .then((items) => {
          syncCaches(items);
          initialized = true;
          listenStorageChanges();
          return getCachedPreferences();
        })
        .catch((err) => {
          console.warn('[OVD][youtube-store] init failed', err);
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

  function getDefaultMode() {
    return getCachedPreferences().mode || DEFAULT_PREFERENCES.mode;
  }

  function getDefaultResolution() {
    return getCachedPreferences().resolution || DEFAULT_PREFERENCES.resolution;
  }

  function getDebugSettings() {
    return {
      ...DEFAULT_DEBUG_SETTINGS,
      ...debugCache,
    };
  }

  function isDebugEnabled(scope) {
    return !!getDebugSettings()?.[scope];
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

  globalThis.__OVD_YOUTUBE_DOWNLOAD_MODE_STORE__ = {
    DEFAULT_PREFERENCES,
    getCachedPreferences,
    getDebugSettings,
    getDefaultMode,
    getDefaultResolution,
    getPreferences,
    init,
    isDebugEnabled,
    updatePreferences,
  };
})();
