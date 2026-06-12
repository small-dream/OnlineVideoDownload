'use strict';

(() => {
  if (globalThis.__OVD_DOWNLOAD_PATH__) {
    return;
  }

  function normalizeDownloadSubdir(subdir = '') {
    return String(subdir || '')
      .replace(/^[\\/]+|[\\/]+$/g, '')
      .replace(/\\/g, '/');
  }

  function joinDownloadSubdir(filename, subdir = '') {
    const safeFilename = String(filename || 'video.mp4');
    const dir = normalizeDownloadSubdir(subdir);
    if (!dir || safeFilename.startsWith(`${dir}/`)) {
      return safeFilename;
    }
    return `${dir}/${safeFilename}`;
  }

  async function applyDownloadSubdir(filename, settingsStore = globalThis.__OVD_GENERAL_SETTINGS_STORE__) {
    const safeFilename = String(filename || 'video.mp4');
    if (!settingsStore?.getSettings) {
      return safeFilename;
    }

    const settings = await settingsStore.getSettings();
    return joinDownloadSubdir(safeFilename, settings?.downloadSubdir);
  }

  globalThis.__OVD_DOWNLOAD_PATH__ = Object.freeze({
    applyDownloadSubdir,
    joinDownloadSubdir,
    normalizeDownloadSubdir,
  });
})();
