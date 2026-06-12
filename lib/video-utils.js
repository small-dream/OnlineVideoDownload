'use strict';

(() => {
  const FALLBACK_NAMES = new Set(['index', 'master', 'playlist', 'video']);

  function resolveMediaFallback(type, fallback = 'video') {
    if (type === 'audio' && (!fallback || fallback === 'video')) {
      return 'audio';
    }
    return fallback || 'video';
  }

  function deriveTitleFromUrl(url) {
    if (!url) return '';

    try {
      const parsed = new URL(url);
      const pathname = decodeURIComponent(parsed.pathname || '');
      const segments = pathname.split('/').filter(Boolean);
      const rawName = segments[segments.length - 1] || '';
      const baseName = rawName.replace(/\.[^.]+$/, '').trim();

      if (baseName && !FALLBACK_NAMES.has(baseName.toLowerCase())) {
        return baseName;
      }

      const parentName = segments[segments.length - 2];
      if (parentName) return parentName;

      return parsed.hostname.replace(/\./g, '_');
    } catch {
      return '';
    }
  }

  function pickDisplayName({ title = '', tabTitle = '', url = '', fallback = 'video' } = {}) {
    const preferredTitle = typeof title === 'string' ? title.trim() : '';
    if (preferredTitle) return preferredTitle;

    const preferredTabTitle = typeof tabTitle === 'string' ? tabTitle.trim() : '';
    if (preferredTabTitle) return preferredTabTitle;

    return deriveTitleFromUrl(url) || fallback;
  }

  function sanitizeFilename(name, fallback = 'video') {
    const safeName = String(name || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 120);

    return safeName || fallback;
  }

  function buildFilenameBase(options = {}) {
    const fallback = resolveMediaFallback(options.type, options.fallback);
    return sanitizeFilename(pickDisplayName({ ...options, fallback }), fallback);
  }

  function ensureExtension(filename, ext) {
    const safeName = typeof filename === 'string' ? filename.trim() : '';
    const base = safeName || 'video';
    return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
  }

  function buildMediaFilename({ title = '', tabTitle = '', url = '', fallback = 'video', ext = '.mp4', type = '' } = {}) {
    return ensureExtension(buildFilenameBase({ title, tabTitle, url, fallback, type }), ext);
  }

  function inferExtensionFromMimeType(mimeType) {
    const normalized = String(mimeType || '').toLowerCase();
    if (normalized.includes('audio/mpeg')) return '.mp3';
    if (normalized.includes('audio/flac')) return '.flac';
    if (normalized.includes('audio/ogg')) return '.oga';
    if (normalized.includes('audio/mp4')) return '.m4a';
    if (normalized.includes('audio/aac')) return '.aac';
    if (normalized.includes('audio/wav') || normalized.includes('audio/x-wav')) return '.wav';
    if (normalized.includes('mp4')) return '.mp4';
    if (normalized.includes('webm')) return '.webm';
    if (normalized.includes('mpegurl') || normalized.includes('mp2t')) return '.ts';
    return '.ts';
  }

  function inferExtensionFromUrl(url) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      const match = pathname.match(/\.(mp3|flac|oga|ogg|m4a|aac|wav|mp4|webm|mkv|flv|m4v)(\?|$)?/);
      return match ? `.${match[1]}` : '';
    } catch {
      return '';
    }
  }

  function extensionToFormatLabel(ext) {
    const normalized = String(ext || '').toLowerCase().replace(/^\./, '');
    if (!normalized) return '';

    const labels = {
      mp3: 'MP3',
      flac: 'FLAC',
      oga: 'OGA',
      ogg: 'OGG',
      m4a: 'M4A',
      aac: 'AAC',
      wav: 'WAV',
      mp4: 'MP4',
      webm: 'WEBM',
      mkv: 'MKV',
      flv: 'FLV',
      m4v: 'M4V',
      ts: 'TS',
    };

    return labels[normalized] || normalized.toUpperCase();
  }

  function getMediaFormatLabel(videoInfo = {}) {
    const extFromUrl = inferExtensionFromUrl(videoInfo?.url || '');
    if (extFromUrl) {
      return extensionToFormatLabel(extFromUrl);
    }

    const extFromMime = inferExtensionFromMimeType(videoInfo?.mimeType || '');
    if (extFromMime && extFromMime !== '.ts') {
      return extensionToFormatLabel(extFromMime);
    }

    return getVideoTypeLabel(videoInfo?.type);
  }

  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '';

    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
  }

  function getVideoTypeLabel(type) {
    const labels = {
      hls: 'HLS',
      dash: 'DASH',
      direct: 'MP4',
      audio: 'Music',
      blob: 'Blob',
      'youtube-adaptive': 'YouTube',
      'bilibili-meta': 'Bilibili',
      'bilibili-dash': 'Bilibili DASH',
      'drm-detected': 'DRM',
    };

    return labels[type] || (type ? String(type).toUpperCase() : 'VIDEO');
  }

  function shortenUrl(url, pathThreshold = 30, tailLength = 20) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      return parsed.hostname + (path.length > pathThreshold ? `...${path.slice(-tailLength)}` : path);
    } catch {
      return String(url || '').substring(0, 50);
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  globalThis.__OVD_VIDEO_UTILS__ = {
    buildFilenameBase,
    buildMediaFilename,
    deriveTitleFromUrl,
    ensureExtension,
    escapeHtml,
    formatDuration,
    formatSize,
    getMediaFormatLabel,
    getVideoTypeLabel,
    inferExtensionFromUrl,
    inferExtensionFromMimeType,
    pickDisplayName,
    sanitizeFilename,
    shortenUrl,
  };
})();
