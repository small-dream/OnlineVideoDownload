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

test('通知只显示文件名（chrome.downloads 给的是绝对路径）', () => {
  const completion = buildCompletionNotification({
    filename: 'C:\\Users\\me\\Downloads\\OVD\\白宫国宴，特朗普请了谁？.mp4',
    sizeBytes: 1024 * 1024,
  });
  assert.equal(completion.message, '白宫国宴，特朗普请了谁？.mp4（1.0 MB）');

  const failure = buildFailureNotification({
    filename: '/home/me/Downloads/OVD/clip.mp4',
    reason: 'NETWORK_FAILED',
  });
  assert.equal(failure.message, 'clip.mp4：NETWORK_FAILED');
});

test('设置开启时 create 通知（固定 id、图标、文案），同一 downloadId 只提示一次', async () => {
  const { calls, chromeApi, settingsStore } = createMockChrome();
  const manager = new DownloadNotificationManager({ chromeApi, settingsStore });

  await manager.notifyComplete(42, { filename: 'movie.mp4', fileSize: 1024 * 1024 });
  await manager.notifyComplete(42, { filename: 'movie.mp4', fileSize: 1024 * 1024 });

  // 重复的完成事件（如中断→续传→完成）不应重复弹横幅
  assert.equal(calls.create.length, 1);
  const [notificationId, options] = calls.create[0];
  assert.equal(notificationId, 'ovd-download-42');
  assert.equal(options.type, 'basic');
  assert.equal(options.iconUrl, 'chrome-extension://test-id/icons/icon128.png');
  assert.equal(options.title, '下载完成');
});

test('不同 downloadId 各自提示一次', async () => {
  const { calls, chromeApi, settingsStore } = createMockChrome();
  const manager = new DownloadNotificationManager({ chromeApi, settingsStore });

  await manager.notifyComplete(1, { filename: 'a.mp4' });
  await manager.notifyComplete(2, { filename: 'b.mp4' });
  await manager.notifyComplete(2, { filename: 'b.mp4' });

  assert.deepEqual(calls.create.map(([id]) => id), ['ovd-download-1', 'ovd-download-2']);
});

test('同一视频（taskKey）的重复下载只提示一次', async () => {
  const { calls, chromeApi, settingsStore } = createMockChrome();
  const manager = new DownloadNotificationManager({ chromeApi, settingsStore });

  // 同一次点击在不同时间/多个 frame 各下一份时，downloadId 不同但 taskKey 相同
  await manager.notifyComplete(8, { filename: 'video.mp4', fileSize: 1024 * 1024 }, { dedupeKey: 'BV1:42138208263' });
  await manager.notifyComplete(9, { filename: 'video (1).mp4', fileSize: 1024 * 1024 }, { dedupeKey: 'BV1:42138208263' });
  await manager.notifyComplete(10, { filename: 'other.mp4' }, { dedupeKey: 'BV2:99' });

  assert.deepEqual(calls.create.map(([id]) => id), ['ovd-download-8', 'ovd-download-10']);
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
