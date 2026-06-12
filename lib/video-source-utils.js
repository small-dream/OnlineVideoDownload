'use strict';

(() => {
  function getSourceId(videoInfo = {}) {
    const type = videoInfo?.type || '';
    if (type === 'youtube-adaptive') return 'youtube';
    if (type === 'bilibili-meta' || type === 'bilibili-dash') return 'bilibili';
    if (type === 'blob') return 'blob';
    if (type === 'dash') return 'dash';
    return 'generic';
  }

  function getExecutionMode(videoInfo = {}) {
    const sourceId = getSourceId(videoInfo);
    // YouTube parse 模式在 Service Worker 中独立下载，不依赖标签页
    if (sourceId === 'youtube' && videoInfo?.downloadOptions?.mode === 'parse') {
      return 'background';
    }
    if (sourceId === 'youtube' || sourceId === 'bilibili' || sourceId === 'blob' || sourceId === 'dash') {
      return 'content';
    }
    return 'background';
  }

  function buildTaskKey(videoInfo = {}) {
    const sourceId = getSourceId(videoInfo);

    switch (sourceId) {
      case 'youtube':
        return videoInfo?.videoId || videoInfo?.url || videoInfo?.title || 'youtube';
      case 'bilibili':
        return [
          videoInfo?.bvid || videoInfo?.aid || videoInfo?.url || 'bilibili',
          videoInfo?.cid || 'no-cid',
        ].join(':');
      case 'blob':
        return videoInfo?.url || videoInfo?.title || 'blob';
      case 'dash':
        return videoInfo?.url || 'dash';
      default:
        return videoInfo?.url || videoInfo?.title || videoInfo?.type || 'video';
    }
  }

  function getSourceLabel(videoInfo = {}) {
    if (getSourceId(videoInfo) === 'generic') {
      return videoInfo?.type === 'audio' ? 'Audio' : 'Video';
    }

    const labels = {
      youtube: 'YouTube',
      bilibili: 'Bilibili',
      blob: 'Blob',
      dash: 'DASH',
      generic: 'Video',
    };

    return labels[getSourceId(videoInfo)] || 'Video';
  }

  globalThis.__OVD_VIDEO_SOURCE_UTILS__ = {
    buildTaskKey,
    getExecutionMode,
    getSourceId,
    getSourceLabel,
  };
})();
