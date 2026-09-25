// background/download-notification.js
// 下载完成/失败通知：消费 settings.downloadNotification，点击通知打开下载所在文件夹。
// 纯函数（id / 文案组装）与 chrome 调用分层，便于单测。

export const NOTIFICATION_ICON_PATH = 'icons/icon128.png';

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

export function buildCompletionNotification({ filename = '', sizeBytes = null } = {}) {
  const name = filename || 'video';
  const sizeLabel = formatBytes(sizeBytes);
  return {
    title: '下载完成',
    message: sizeLabel ? `${name}（${sizeLabel}）` : name,
  };
}

export function buildFailureNotification({ filename = '', reason = '' } = {}) {
  const name = filename || 'video';
  const reasonLabel = String(reason || '').trim();
  return {
    title: '下载失败',
    message: reasonLabel ? `${name}：${reasonLabel}` : name,
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

  async notifyComplete(downloadId, item = {}) {
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
