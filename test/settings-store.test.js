'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadStore() {
  delete globalThis.__OVD_GENERAL_SETTINGS_STORE__;
  delete require.cache[require.resolve(path.resolve(__dirname, '../lib/settings-store.js'))];
  require(path.resolve(__dirname, '../lib/settings-store.js'));
  return globalThis.__OVD_GENERAL_SETTINGS_STORE__;
}

test('getCachedSettings returns defaults before init', () => {
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } } };
  const store = loadStore();
  const settings = store.getCachedSettings();

  assert.equal(settings.concurrentDownloadLimit, 3);
  assert.equal(settings.downloadNotification, true);
  assert.equal(settings.debugLogging, false);
  assert.equal(settings.youtubeDefaultMode, 'capture');
  assert.equal(settings.bilibiliDefaultQuality, 'auto');
  assert.equal(settings.filenameFormat, 'title');
  assert.equal(settings.downloadSubdir, 'OnlineVideoDownload');
  assert.equal(settings.historyRetentionDays, 30);
});

test('init loads from chrome.storage.local and merges with defaults', async () => {
  const stored = {
    'ovd.generalSettings': {
      concurrentDownloadLimit: 5,
      debugLogging: true,
    },
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => stored,
        set: async () => {},
      },
      onChanged: { addListener: () => {} },
    },
  };
  const store = loadStore();
  const result = await store.init();

  assert.equal(result.concurrentDownloadLimit, 5);
  assert.equal(result.debugLogging, true);
  // Defaults preserved for unoverridden keys
  assert.equal(result.downloadNotification, true);
  assert.equal(result.youtubeDefaultMode, 'capture');
  assert.equal(result.bilibiliDefaultQuality, 'auto');
  assert.equal(result.filenameFormat, 'title');
  assert.equal(result.historyRetentionDays, 30);
});

test('init without chrome.storage returns defaults', async () => {
  // Set chrome to undefined so chrome?.storage?.local?.get is falsy
  globalThis.chrome = undefined;
  const store = loadStore();
  const result = await store.init();

  assert.equal(result.concurrentDownloadLimit, 3);
  assert.equal(result.downloadNotification, true);
  // Restore chrome for subsequent tests
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } } };
});

test('updateSettings merges partial and persists to storage', async () => {
  let persisted = null;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async (data) => { persisted = data; },
      },
      onChanged: { addListener: () => {} },
    },
  };
  const store = loadStore();
  await store.init();

  const updated = await store.updateSettings({ concurrentDownloadLimit: 10, debugLogging: true });

  assert.equal(updated.concurrentDownloadLimit, 10);
  assert.equal(updated.debugLogging, true);
  assert.equal(updated.downloadNotification, true);
  assert.ok(persisted);
  assert.equal(persisted['ovd.generalSettings'].concurrentDownloadLimit, 10);
  assert.equal(persisted['ovd.generalSettings'].debugLogging, true);
});

test('updateSettings({}) returns current unchanged', async () => {
  let persisted = null;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async (data) => { persisted = data; },
      },
      onChanged: { addListener: () => {} },
    },
  };
  const store = loadStore();
  await store.init();

  const before = store.getCachedSettings();
  const updated = await store.updateSettings({});

  assert.equal(updated.concurrentDownloadLimit, before.concurrentDownloadLimit);
  assert.equal(updated.downloadNotification, before.downloadNotification);
  assert.ok(persisted);
});

test('storage change listener updates cache', async () => {
  let changeListener = null;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
      onChanged: {
        addListener: (fn) => { changeListener = fn; },
      },
    },
  };
  const store = loadStore();
  await store.init();

  assert.ok(changeListener, 'storage.onChanged listener should be registered');

  changeListener(
    { 'ovd.generalSettings': { newValue: { concurrentDownloadLimit: 7, debugLogging: true } } },
    'local',
  );

  const cached = store.getCachedSettings();
  assert.equal(cached.concurrentDownloadLimit, 7);
  assert.equal(cached.debugLogging, true);
  // Defaults still present for untouched keys
  assert.equal(cached.downloadNotification, true);

  // Non-local area changes are ignored
  changeListener(
    { 'ovd.generalSettings': { newValue: { concurrentDownloadLimit: 99 } } },
    'sync',
  );
  assert.equal(store.getCachedSettings().concurrentDownloadLimit, 7);
});

test('DEFAULT_SETTINGS is frozen', () => {
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } } };
  const store = loadStore();

  assert.ok(Object.isFrozen(store.DEFAULT_SETTINGS));

  assert.throws(() => {
    store.DEFAULT_SETTINGS.concurrentDownloadLimit = 999;
  }, /Cannot assign to read only property/);
});
