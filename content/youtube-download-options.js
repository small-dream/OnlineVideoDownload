'use strict';

(() => {
  if (globalThis.__OVD_YOUTUBE_DOWNLOAD_OPTIONS__) {
    return;
  }

  const modeStore = globalThis.__OVD_YOUTUBE_DOWNLOAD_MODE_STORE__ || {};

  const DEFAULT_OPTIONS = {
    fallbackToLowerQuality: true,
    mode: 'capture',
    preferCombined: true,
    resolution: 'auto',
  };

  function normalizeYouTubeDownloadOptions(videoInfo = {}) {
    const storedPreferences = modeStore.getCachedPreferences?.() || {};
    const requestOptions = videoInfo?.downloadOptions || {};

    return {
      ...DEFAULT_OPTIONS,
      ...storedPreferences,
      ...requestOptions,
      mode: requestOptions.mode || storedPreferences.mode || DEFAULT_OPTIONS.mode,
      resolution: requestOptions.resolution || storedPreferences.resolution || DEFAULT_OPTIONS.resolution,
    };
  }

  globalThis.__OVD_YOUTUBE_DOWNLOAD_OPTIONS__ = {
    DEFAULT_OPTIONS,
    normalizeYouTubeDownloadOptions,
  };
})();
