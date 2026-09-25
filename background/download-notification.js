// background/download-notification.js
// 下载完成/失败通知：消费 settings.downloadNotification，点击通知打开下载所在文件夹。
// 纯函数（id / 文案组装）与 chrome 调用分层，便于单测。

export const NOTIFICATION_ICON_PATH = 'icons/icon128.png';

/** 文案走 _locales；chrome.i18n 不可用时退回中文（见 lib/i18n.js 的同一约定） */
function translate(key, fallback, subs) {
  try {
    const message = globalThis.chrome?.i18n?.getMessage?.(key, subs);
    if (message) {
      return message;
    }
  } catch (_err) {
    // 忽略并退回中文
  }
  // fallback 也要走占位符替换，否则缺 chrome.i18n 时会把 $1 原样显示出来
  if (fallback == null || !subs) {
    return fallback;
  }
  const list = Array.isArray(subs) ? subs : [subs];
  return String(fallback).replace(/\$(\d)/g, (match, index) => {
    const value = list[Number(index) - 1];
    return value == null ? match : String(value);
  });
}

export function buildNotificationId(downloadId) {
  return `ovd-download-${downloadId}`;
}

export function parseNotificationDownloadId(notificationId) {
  const match = String(notificationId || '').match(/^ovd-download-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '';
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

/** 通知里只展示文件名：chrome.downloads 给的是绝对路径，整条路径对用户没有意义 */
function displayNameOf(filename) {
  const value = String(filename || '').trim();
  if (!value) {
    return '';
  }
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || value;
}

export function buildCompletionNotification({ filename = '', sizeBytes = null } = {}) {
  const name = displayNameOf(filename) || 'video';
  const sizeLabel = formatBytes(sizeBytes);
  const body = sizeLabel
    ? translate('notify_completeBody', '$1（$2）', [name, sizeLabel])
    : name;
  return {
    title: translate('notify_completeTitle', '下载完成'),
    message: body,
  };
}

export function buildFailureNotification({ filename = '', reason = '' } = {}) {
  const name = displayNameOf(filename) || 'video';
  const reasonLabel = String(reason || '').trim();
  return {
    title: translate('notify_failedTitle', '下载失败'),
    message: reasonLabel
      ? translate('notify_failedBody', '$1：$2', [name, reasonLabel])
      : name,
  };
}

export class DownloadNotificationManager {
  constructor({
    chromeApi = globalThis.chrome,
    settingsStore = globalThis.__OVD_GENERAL_SETTINGS_STORE__,
  } = {}) {
    this._chrome = chromeApi;
    this._settingsStore = settingsStore;
    this._attached = false;
    // 已提示过的下载：完成事件可能在「中断→自动续传→完成」等场景重复到达，
    // 同一条视频（taskKey）重复下载也会各自产生 downloadId ——
    // Windows 上每次 create 都会再弹一条横幅，所以按「逻辑视频」去重，
    // 让用户点一次下载只看到一条「下载完成」。
    this._completedNotified = new Set();
  }

  attach() {
    if (this._attached || !this._chrome?.notifications?.onClicked) {
      return;
    }
    this._attached = true;
    this._chrome.notifications.onClicked.addListener((notificationId) => {
      this._handleClicked(notificationId);
    });
  }

  /**
   * @param {number} downloadId - chrome 下载 id（同时用作通知 id，点击可定位文件）
   * @param {Object} [item] - chrome.downloads 条目
   * @param {{ dedupeKey?: string }} [options] - 去重键，默认按 downloadId；
   *   传入 taskKey 时，同一视频的多次下载只提示一次
   */
  async notifyComplete(downloadId, item = {}, options = {}) {
    const dedupeKey = options?.dedupeKey || downloadId;
    if (downloadId == null || this._completedNotified.has(dedupeKey)) {
      return;
    }
    this._completedNotified.add(dedupeKey);

    await this._notify(downloadId, buildCompletionNotification({
      filename: item?.filename,
      sizeBytes: item?.fileSize ?? item?.totalBytes ?? null,
    }));
  }

  async notifyFailed(downloadId, item = {}, reason = '') {
    await this._notify(downloadId, buildFailureNotification({
      filename: item?.filename,
      reason,
    }));
  }

  async _notify(downloadId, content) {
    if (!this._chrome?.notifications?.create || downloadId == null) {
      return;
    }
    if (!(await this._isEnabled())) {
      return;
    }

    // 固定 id 去重：同一 downloadId 重复 create 会替换旧通知
    try {
      this._chrome.notifications.create(buildNotificationId(downloadId), {
        type: 'basic',
        iconUrl: this._chrome.runtime?.getURL?.(NOTIFICATION_ICON_PATH) || NOTIFICATION_ICON_PATH,
        title: content.title,
        message: content.message,
      });
    } catch (err) {
      console.warn(`[OVD] failed to create download notification: ${err.message}`);
    }
  }

  async _isEnabled() {
    try {
      const settings = await this._settingsStore?.getSettings?.();
      return settings?.downloadNotification !== false;
    } catch (_err) {
      return true;
    }
  }

  _handleClicked(notificationId) {
    const downloadId = parseNotificationDownloadId(notificationId);
    if (downloadId == null) {
      return;
    }

    try {
      this._chrome.downloads?.show?.(downloadId);
    } catch (err) {
      console.warn(`[OVD] failed to reveal download ${downloadId}: ${err.message}`);
    }
    try {
      this._chrome.notifications?.clear?.(notificationId);
    } catch (_err) {}
  }
}
