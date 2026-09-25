// lib/video-filter.js
// 检测结果过滤：域名黑名单、最小时长、最小体积
// 以 <script> 方式加载，暴露全局 __OVD_VIDEO_FILTER__

'use strict';

(() => {
  if (globalThis.__OVD_VIDEO_FILTER__) {
    return;
  }

  /** 结构化来源（YouTube/Bilibili）永远显示，阈值过滤只针对通用嗅探结果 */
  const STRUCTURED_TYPES = new Set(['youtube-adaptive', 'bilibili-meta', 'bilibili-dash']);

  function normalizeDomain(input) {
    let host = String(input || '').trim().toLowerCase();
    if (!host) {
      return '';
    }

    if (host.includes('://')) {
      try {
        host = new URL(host).hostname;
      } catch (_err) {
        return '';
      }
    }

    return host.replace(/^\.+/, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  }

  function parseDomainList(value) {
    if (Array.isArray(value)) {
      return value.map(normalizeDomain).filter(Boolean);
    }
    return String(value || '')
      .split(/[\s,;]+/)
      .map(normalizeDomain)
      .filter(Boolean);
  }

  function hostOf(url) {
    try {
      return new URL(String(url || '')).hostname.toLowerCase();
    } catch (_err) {
      return '';
    }
  }

  function isBlacklistedHost(host, domains) {
    if (!host) {
      return false;
    }
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  }

  /**
   * @returns {{ filtered: boolean, reason: string }}
   */
  function shouldFilterVideo(video, settings = {}, context = {}) {
    const domains = parseDomainList(settings.domainBlacklist);
    if (domains.length > 0) {
      const videoUrl = String(video?.url || '');
      // blob: URL 无 hostname，用所属页面域名兜底
      const host = videoUrl.startsWith('blob:') || !videoUrl
        ? hostOf(context.tabUrl)
        : (hostOf(videoUrl) || hostOf(context.tabUrl));
      if (isBlacklistedHost(host, domains)) {
        return { filtered: true, reason: `域名 ${host} 在黑名单中` };
      }
    }

    if (STRUCTURED_TYPES.has(video?.type)) {
      return { filtered: false, reason: '' };
    }

    const minDuration = Number(settings.minVideoDurationSec) || 0;
    const duration = Number(video?.duration) || 0;
    if (minDuration > 0 && duration > 0 && duration < minDuration) {
      return { filtered: true, reason: `时长 ${duration}s 低于阈值 ${minDuration}s` };
    }

    const minSizeMb = Number(settings.minVideoSizeMb) || 0;
    const sizeBytes = Number(video?.fileSize ?? video?.size) || 0;
    if (minSizeMb > 0 && sizeBytes > 0 && sizeBytes < minSizeMb * 1024 * 1024) {
      return { filtered: true, reason: `体积 ${(sizeBytes / 1024).toFixed(0)} KB 低于阈值 ${minSizeMb} MB` };
    }

    return { filtered: false, reason: '' };
  }

  function filterVideos(videos, settings = {}, context = {}) {
    return (videos || []).filter((video) => !shouldFilterVideo(video, settings, context).filtered);
  }

  globalThis.__OVD_VIDEO_FILTER__ = {
    filterVideos,
    hostOf,
    isBlacklistedHost,
    normalizeDomain,
    parseDomainList,
    shouldFilterVideo,
  };
})();
