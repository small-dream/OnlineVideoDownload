'use strict';

(() => {
  if (globalThis.__OVD_YOUTUBE_DOWNLOAD_ERRORS__) {
    return;
  }

  function createYouTubeDownloadError(code, message, details = {}) {
    const err = new Error(message || 'YouTube download failed');
    err.code = code || 'YT_UNKNOWN';
    err.details = details;
    return err;
  }

  function normalizeYouTubeDownloadError(err, fallbackCode = 'YT_UNKNOWN') {
    if (err?.code) {
      return err;
    }

    const normalized = new Error(err?.message || 'YouTube download failed');
    normalized.code = fallbackCode;
    normalized.details = err?.details || {};
    return normalized;
  }

  globalThis.__OVD_YOUTUBE_DOWNLOAD_ERRORS__ = {
    createYouTubeDownloadError,
    normalizeYouTubeDownloadError,
  };
})();
