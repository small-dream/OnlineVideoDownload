'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildCompletionNotification,
  buildFailureNotification,
  buildNotificationId,
  DownloadNotificationManager,
  parseNotificationDownloadId,
} = require('../background/download-notification.js');

function createMockChrome({ downloadNotification = true } = {}) {
  const calls = { create: [], clear: [], show: [] };
  const clickListeners = [];
  const chromeApi = {
    downloads: {
      show(downloadId) {
        calls.show.push(downloadId);
      },
    },
    notifications: {
      create(notificationId, options) {
        calls.create.push([notificationId, options]);
      },
      clear(notificationId) {
        calls.clear.push(notificationId);
      },
      onClicked: {
        addListener(listener) {
          clickListeners.push(listener);
        },
      },
    },
    runtime: {
      getURL(path) {
        return `chrome-extension://test-id/${path}`;
      },
    },
  };

  const settingsStore = {
    getSettings: async () => ({ downloadNotification }),
  };

  return { calls, chromeApi, clickListeners, settingsStore };
}

test('buildNotificationId / parseNotificationDownloadId 往返一致', () => {
  assert.equal(buildNotificationId(42), 'ovd-download-42');
  assert.equal(parseNotificationDownloadId('ovd-download-42'), 42);
  assert.equal(parseNotificationDownloadId('other-notification'), null);
  assert.equal(parseNotificationDownloadId(''), null);
});

test('完成通知文案含文件名与大小', () => {
  const content = buildCompletionNotification({ filename: 'movie.mp4', sizeBytes: 2 * 1024 * 1024 * 1024 });
  assert.equal(content.title, '下载完成');
  assert.match(content.message, /movie\.mp4/);
  assert.match(content.message, /GB/);
});

test('完成通知缺大小/文件名时有兜底', () => {
  const noSize = buildCompletionNotification({ filename: 'movie.mp4' });
  assert.equal(noSize.message, 'movie.mp4');
  const noName = buildCompletionNotification({});
  assert.equal(noName.message, 'video');
});

test('失败通知文案含原因', () => {
  const content = buildFailureNotification({ filename: 'movie.mp4', reason: 'NETWORK_FAILED' });
  assert.equal(content.title, '下载失败');
  assert.equal(content.message, 'movie.mp4：NETWORK_FAILED');
});

test('设置开启时 create 通知（id 去重、图标、文案）', async () => {
  const { calls, chromeApi, settingsStore } = createMockChrome();
  const manager = new DownloadNotificationManager({ chromeApi, settingsStore });

  await manager.notifyComplete(42, { filename: 'movie.mp4', fileSize: 1024 * 1024 });
  await manager.notifyComplete(42, { filename: 'movie.mp4', fileSize: 1024 * 1024 });

  assert.equal(calls.create.length, 2);
  const [notificationId, options] = calls.create[0];
  assert.equal(notificationId, 'ovd-download-42');
  assert.equal(options.type, 'basic');
  assert.equal(options.iconUrl, 'chrome-extension://test-id/icons/icon128.png');
  assert.equal(options.title, '下载完成');
});

test('设置关闭时不创建通知', async () => {
  const { calls, chromeApi, settingsStore } = createMockChrome({ downloadNotification: false });
  const manager = new DownloadNotificationManager({ chromeApi, settingsStore });

  await manager.notifyComplete(42, { filename: 'movie.mp4' });
  assert.equal(calls.create.length, 0);
});

test('attach 后点击通知打开下载所在文件夹并清除通知', async () => {
  const { calls, chromeApi, clickListeners, settingsStore } = createMockChrome();
  const manager = new DownloadNotificationManager({ chromeApi, settingsStore });
  manager.attach();

  assert.equal(clickListeners.length, 1);
  clickListeners[0]('ovd-download-7');

  assert.deepEqual(calls.show, [7]);
  assert.deepEqual(calls.clear, ['ovd-download-7']);
});

test('点击非下载通知不触发 downloads.show', () => {
  const { calls, chromeApi, clickListeners, settingsStore } = createMockChrome();
  const manager = new DownloadNotificationManager({ chromeApi, settingsStore });
  manager.attach();

  clickListeners[0]('some-other-id');
  assert.equal(calls.show.length, 0);
});

test('notifyFailed 创建失败通知', async () => {
  const { calls, chromeApi, settingsStore } = createMockChrome();
  const manager = new DownloadNotificationManager({ chromeApi, settingsStore });

  await manager.notifyFailed(9, { filename: 'movie.mp4' }, 'NETWORK_FAILED');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0][1].title, '下载失败');
  assert.match(calls.create[0][1].message, /NETWORK_FAILED/);
});
