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

  /**
   * 页面播放器内部的 MSE blob 流与结构化检测（YouTube 解析 / B 站 page API）指向同一条视频：
   * blob: URL 在播放器每次重建/切流时都会变，于是列表里会堆出多条标题相同的重复项，
   * 既干扰用户也很容易连带触发重复下载与重复通知。
   * 因此存在结构化检测结果时隐藏这些噪声条目；没有结构化结果时 blob 仍照常展示。
   * @param {Object} video
   * @param {{ isBilibiliVideoPage?: boolean, isYouTubePage?: boolean, isYouTubeWatchPage?: boolean, hasBilibiliMeta?: boolean, hasYouTubeAdaptive?: boolean }} context
   */
  function shouldHideRedundantDetection(video, context = {}) {
    const {
      hasBilibiliMeta = false,
      hasYouTubeAdaptive = false,
      isBilibiliVideoPage = false,
      isYouTubePage = false,
      isYouTubeWatchPage = false,
    } = context;

    // YouTube 非观看页（首页/推荐流）整页噪声不展示
    if (isYouTubePage && !isYouTubeWatchPage) {
      return true;
    }

    if (hasYouTubeAdaptive && isYouTubeWatchPage) {
      if (video?.type === 'audio') {
        return true;
      }
      if (video?.type === 'blob') {
        return String(video?.url || '').startsWith('blob:https://www.youtube.com/');
      }
    }

    if (hasBilibiliMeta && isBilibiliVideoPage) {
      // B 站视频页的 blob（MSE 播放流）与页面内部音效都不该出现在列表里
      return video?.type === 'blob' || video?.type === 'audio';
    }

    return false;
  }

  /**
   * 同一 frame 内标题相同的多个 blob 条目只是同一个 MSE 播放器反复重建的产物，只保留最新一条。
   */
  function collapseDuplicateBlobEntries(videos = []) {
    const blobKeyOf = (video) => `${video?.frameId ?? 'main'}|${video?.title || ''}`;
    const newestBlobByFrame = new Map();

    for (const video of videos) {
      if (video?.type !== 'blob') {
        continue;
      }
      const key = blobKeyOf(video);
      const previous = newestBlobByFrame.get(key);
      if (!previous || (Number(video.timestamp) || 0) >= (Number(previous.timestamp) || 0)) {
        newestBlobByFrame.set(key, video);
      }
    }

    return videos.filter((video) => (
      video?.type !== 'blob' || newestBlobByFrame.get(blobKeyOf(video)) === video
    ));
  }

  globalThis.__OVD_VIDEO_FILTER__ = {
    collapseDuplicateBlobEntries,
    filterVideos,
    hostOf,
    isBlacklistedHost,
    normalizeDomain,
    parseDomainList,
    shouldHideRedundantDetection,
    shouldFilterVideo,
  };
})();
