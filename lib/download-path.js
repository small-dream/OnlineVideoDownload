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

  // 本地时区 YYYYMMDD
  function formatDateStamp(date = new Date()) {
    const parsed = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(parsed.getTime())) {
      return '';
    }
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  // 画质/清晰度后缀：显式标签 > 分辨率 > 高度 > 平台画质 id
  function pickFilenameQualitySuffix(videoInfo = {}) {
    const candidates = [
      videoInfo?.qualityLabel,
      videoInfo?.resolution,
      videoInfo?.downloadOptions?.resolution,
    ];
    for (const candidate of candidates) {
      const label = String(candidate || '').trim();
      if (label && label !== 'auto') {
        return label;
      }
    }

    const height = Number(videoInfo?.height);
    if (height > 0) {
      return `${height}p`;
    }

    const qualityId = Number(videoInfo?.downloadOptions?.qualityId);
    if (Number.isFinite(qualityId) && qualityId > 0) {
      return `${qualityId}P`;
    }

    return '';
  }

  function sanitizeFilenameSuffix(suffix) {
    return String(suffix || '')
      .replace(/[\\/:*?"<>|\s]+/g, '')
      .substring(0, 30);
  }

  // 按 filenameFormat 设置组装文件名主干：title / title-quality / title-date
  function composeFilenameBase(filenameBase, videoInfo = {}, settings = {}, { now = new Date() } = {}) {
    const safeBase = String(filenameBase || '').trim() || 'video';
    const format = String(settings?.filenameFormat || 'title').trim() || 'title';

    if (format === 'title-quality') {
      const suffix = sanitizeFilenameSuffix(pickFilenameQualitySuffix(videoInfo));
      return suffix ? `${safeBase}-${suffix}` : safeBase;
    }

    if (format === 'title-date') {
      const stamp = formatDateStamp(now);
      return stamp ? `${safeBase}-${stamp}` : safeBase;
    }

    return safeBase;
  }

  // 读设置后依次应用命名规则与下载子目录（chrome.downloads 直下路径统一入口）
  async function applyDownloadNaming(filenameBase, videoInfo = {}, settingsStore = globalThis.__OVD_GENERAL_SETTINGS_STORE__) {
    const safeFilenameBase = String(filenameBase || '').trim() || 'video';
    if (!settingsStore?.getSettings) {
      return safeFilenameBase;
    }

    const settings = await settingsStore.getSettings();
    const composed = composeFilenameBase(safeFilenameBase, videoInfo, settings);
    return joinDownloadSubdir(composed, settings?.downloadSubdir);
  }

  globalThis.__OVD_DOWNLOAD_PATH__ = Object.freeze({
    applyDownloadNaming,
    applyDownloadSubdir,
    composeFilenameBase,
    formatDateStamp,
    joinDownloadSubdir,
    normalizeDownloadSubdir,
    pickFilenameQualitySuffix,
  });
})();
