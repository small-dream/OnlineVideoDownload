// background/video-registry.js
// 内存存储：Map<tabId, Map<url, VideoInfo>>
// Service Worker 生命周期内有效，tab 关闭/刷新时清理

import '../lib/video-utils.js';

const { pickDisplayName } = globalThis.__OVD_VIDEO_UTILS__;

function parseYouTubeVideoIdFromUrl(url = '') {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.split('/').filter(Boolean)[0] || '';
    }

    if (!parsed.hostname.includes('youtube.com')) {
      return '';
    }

    if (parsed.pathname === '/watch') {
      return parsed.searchParams.get('v') || '';
    }

    if (
      parsed.pathname.startsWith('/shorts/') ||
      parsed.pathname.startsWith('/live/') ||
      parsed.pathname.startsWith('/embed/')
    ) {
      return parsed.pathname.split('/').filter(Boolean)[1] || '';
    }
  } catch {
    return '';
  }

  return '';
}

function getVideoRegistryKey(info = {}) {
  if (info?.type === 'youtube-adaptive') {
    const videoId = info.videoId || parseYouTubeVideoIdFromUrl(info.url || '');
    if (videoId) {
      return `youtube:${videoId}`;
    }
  }

  return info?.url || '';
}

function isSameYouTubeVideo(left = {}, right = {}) {
  if (left?.type !== 'youtube-adaptive' || right?.type !== 'youtube-adaptive') {
    return false;
  }

  const leftVideoId = left.videoId || parseYouTubeVideoIdFromUrl(left.url || '');
  const rightVideoId = right.videoId || parseYouTubeVideoIdFromUrl(right.url || '');
  return !!leftVideoId && leftVideoId === rightVideoId;
}

export class VideoRegistry {
  constructor() {
    this._store = new Map();
  }

  /**
   * @param {number} tabId
   * @param {Object} info - { url, type, title, requestHeaders, ... }
   */
  add(tabId, info) {
    if (!tabId || tabId < 0 || !info?.url) return 'ignored';

    if (!this._store.has(tabId)) {
      this._store.set(tabId, new Map());
    }

    const tabStore = this._store.get(tabId);
    const registryKey = getVideoRegistryKey(info);
    if (!registryKey) return 'ignored';

    let existingKey = registryKey;
    let existing = tabStore.get(registryKey);

    if (!existing && info.type === 'youtube-adaptive') {
      for (const [key, candidate] of tabStore) {
        if (isSameYouTubeVideo(candidate, info)) {
          existingKey = key;
          existing = candidate;
          break;
        }
      }
    }

    if (existing) {
      const merged = { ...existing, ...info, tabId, timestamp: existing.timestamp || Date.now() };
      const changed = JSON.stringify(existing) !== JSON.stringify(merged);
      if (existingKey !== registryKey) {
        tabStore.delete(existingKey);
      }
      tabStore.set(registryKey, merged);
      return changed || existingKey !== registryKey ? 'updated' : 'unchanged';
    }

    tabStore.set(registryKey, {
      url: info.url,
      type: info.type || 'direct',
      title: info.title || '',
      requestHeaders: info.requestHeaders || {},
      tabId,
      timestamp: Date.now(),
      ...info,
    });

    return 'new';
  }

  /**
   * @param {number} tabId
   * @returns {VideoInfo[]}
   */
  getForTab(tabId) {
    return Array.from(this._store.get(tabId)?.values() || []);
  }

  /**
   * @param {number} tabId
   * @returns {number}
   */
  countForTab(tabId) {
    return this._store.get(tabId)?.size || 0;
  }

  /**
   * 清理指定 tab 的数据
   * @param {number} tabId
   */
  clearTab(tabId) {
    this._store.delete(tabId);
  }

  /**
   * 为指定 tab 的视频列表补全缺失的标题
   * @param {number} tabId
   * @param {string} tabTitle
   */
  enrichTitles(tabId, tabTitle) {
    const tabStore = this._store.get(tabId);
    if (!tabStore) return;

    for (const [url, info] of tabStore) {
      if (!info.title || info.title.trim() === '') {
        info.title = pickDisplayName({ tabTitle, url, fallback: '' });
      }
    }
  }

  /**
   * @param {number} tabId
   * @param {string} url
   * @returns {VideoInfo|undefined}
   */
  getByUrl(tabId, url) {
    const tabStore = this._store.get(tabId);
    if (!tabStore) return undefined;
    return tabStore.get(url) || Array.from(tabStore.values()).find((info) => info?.url === url);
  }
}
