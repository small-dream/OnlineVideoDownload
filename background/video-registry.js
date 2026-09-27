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

// 只有这些通用条目会因为「page 里唯一一个 <video>」的封面而受益：
// 结构化来源（YouTube / Bilibili）自带封面，audio 没有画面，DRM 只是提示。
const FRAME_THUMBNAIL_TYPES = new Set(['hls', 'dash', 'direct', 'blob']);

/** 页面只在 frame 内只有一个 <video> 时才允许把封面共享给同 frame 的其它条目 */
function frameThumbnailKey(tabId, frameId) {
  if (!Number.isFinite(tabId) || !Number.isInteger(frameId)) {
    return '';
  }
  return `${tabId}:${frameId}`;
}

function canShareFrameThumbnail(info = {}) {
  return !!info.thumbnail
    && info.thumbnailScope === 'frame'
    && FRAME_THUMBNAIL_TYPES.has(String(info.type || ''));
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

  // thumbnail 一族必须一起保留：页面封面是一次性上报的，后续同 URL 的网络拦截
  // 上报（不带 thumbnail）如果直接覆盖，列表里的封面就会闪一下又变回占位图。
    // captionTracks 只在 player response 解析时上报一次，网络拦截类上报不带它，
    // 直接覆盖会让 popup 的字幕语言列表闪一下又消失。
    for (const key of ['title', 'mimeType', 'filename', 'thumbnail', 'poster', 'cover', 'captionTracks']) {
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
    // `${tabId}:${frameId}` → 该 frame 唯一 <video> 的封面，供同 frame 的兄弟条目补全
    this._frameThumbnails = new Map();
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
      const sharedThumbnail = this._syncFrameThumbnail(tabStore, tabId, merged);
      if (changed || existingKey !== registryKey || sharedThumbnail) {
        this._persist();
        return 'updated';
      }
      return 'unchanged';
    }

    const created = {
      url: info.url,
      type: info.type || 'direct',
      title: info.title || '',
      requestHeaders: info.requestHeaders || {},
      tabId,
      timestamp: Date.now(),
      ...info,
    };
    tabStore.set(registryKey, created);
    this._syncFrameThumbnail(tabStore, tabId, created);

    this._persist();
    return 'new';
  }

  /**
   * 单一 <video> 的 frame：页面截到的封面可以代表该 frame 的所有通用条目
   * （m3u8 / mpd / 直链 / MSE blob 各自都会被单独登记），把它们缺的封面补齐。
   * @returns {boolean} 是否有兄弟条目被补上封面
   */
  _syncFrameThumbnail(tabStore, tabId, info) {
    const key = frameThumbnailKey(tabId, info?.frameId);
    if (!key) {
      return false;
    }

    if (canShareFrameThumbnail(info)) {
      this._frameThumbnails.set(key, info.thumbnail);
    }

    const thumbnail = this._frameThumbnails.get(key);
    if (!thumbnail) {
      return false;
    }

    let changed = false;
    for (const candidate of tabStore.values()) {
      // 只补同一个 frame 的兄弟条目：其它 frame（页面上的另一个播放器）有自己的画面
      if (candidate.frameId !== info?.frameId) {
        continue;
      }
      if (candidate.thumbnail || !FRAME_THUMBNAIL_TYPES.has(String(candidate.type || ''))) {
        continue;
      }
      candidate.thumbnail = thumbnail;
      changed = true;
    }
    return changed;
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
    for (const key of [...this._frameThumbnails.keys()]) {
      if (key.startsWith(`${tabId}:`)) {
        this._frameThumbnails.delete(key);
      }
    }
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
    this._frameThumbnails.delete(frameThumbnailKey(tabId, frameId));
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
