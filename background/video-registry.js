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

function isNonEmptyObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

/**
 * 合并已注册条目与新上报信息：新值为空（空对象/空字符串/null/0）时保留旧值，
 * 避免后到的空 requestHeaders 等冲掉已捕获的 Origin/Referer/Cookie。
 */
function mergeVideoInfo(existing = {}, info = {}) {
  const merged = { ...existing, ...info };

  if (!isNonEmptyObject(info.requestHeaders) && isNonEmptyObject(existing.requestHeaders)) {
    merged.requestHeaders = existing.requestHeaders;
  }

  for (const key of ['title', 'mimeType', 'filename']) {
    if ((info[key] == null || info[key] === '') && existing[key]) {
      merged[key] = existing[key];
    }
  }

  for (const key of ['fileSize', 'size', 'duration']) {
    if (!(Number(info[key]) > 0) && Number(existing[key]) > 0) {
      merged[key] = existing[key];
    }
  }

  return merged;
}

export class VideoRegistry {
  constructor(snapshotMirror = null) {
    this._store = new Map();
    // SessionMirror 实例，检测列表镜像到 storage.session，SW 重启后 popup 仍可见
    this._mirror = snapshotMirror;
  }

  /** 注册表镜像到 storage.session（去抖写入） */
  _persist() {
    if (!this._mirror) return;
    const snapshot = {};
    for (const [tabId, tabStore] of this._store) {
      snapshot[tabId] = [...tabStore.values()];
    }
    this._mirror.scheduleSave(snapshot);
  }

  /** SW 启动时从快照恢复注册表 */
  restoreAll(snapshot = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    for (const [tabId, videos] of Object.entries(snapshot)) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId) || !Array.isArray(videos)) continue;
      const tabStore = new Map();
      for (const info of videos) {
        const key = getVideoRegistryKey(info);
        if (key) {
          tabStore.set(key, info);
        }
      }
      if (tabStore.size) {
        this._store.set(numericTabId, tabStore);
      }
    }
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
      const merged = { ...mergeVideoInfo(existing, info), tabId, timestamp: existing.timestamp || Date.now() };
      const changed = JSON.stringify(existing) !== JSON.stringify(merged);
      if (existingKey !== registryKey) {
        tabStore.delete(existingKey);
      }
      tabStore.set(registryKey, merged);
      const result = changed || existingKey !== registryKey ? 'updated' : 'unchanged';
      if (result === 'updated') {
        this._persist();
      }
      return result;
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

    this._persist();
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
    this._persist();
  }

  /**
   * 清理指定 tab 中某个 frame 上报的条目（iframe 导航/卸载时）
   * @param {number} tabId
   * @param {number} frameId
   */
  clearFrame(tabId, frameId) {
    const tabStore = this._store.get(tabId);
    if (!tabStore) return;

    for (const [key, info] of tabStore) {
      if (info?.frameId === frameId) {
        tabStore.delete(key);
      }
    }
    if (!tabStore.size) {
      this._store.delete(tabId);
    }
    this._persist();
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
    this._persist();
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
