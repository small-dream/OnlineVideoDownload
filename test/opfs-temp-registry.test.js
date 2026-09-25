'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '../background/opfs-temp-registry.js');

let importCounter = 0;

function loadRegistry() {
  importCounter += 1;
  return import(`${pathToFileURL(MODULE_PATH).href}?test=${importCounter}`);
}

test('registerOpfsTempFile 登记 downloadId → 文件名', async () => {
  const registry = await loadRegistry();
  assert.equal(registry.registerOpfsTempFile(42, 'ovd-stream-a'), true);

  assert.deepEqual(registry.listOpfsTempFiles().map((entry) => entry.name), ['ovd-stream-a']);
  assert.ok(registry.listOpfsTempFiles()[0].createdAt > 0);
});

test('takeOpfsTempFile 取出后即移除，重复取返回 null', async () => {
  const registry = await loadRegistry();
  registry.registerOpfsTempFile('d1', 'ovd-stream-b');

  assert.deepEqual(registry.takeOpfsTempFile('d1')?.name, 'ovd-stream-b');
  assert.equal(registry.takeOpfsTempFile('d1'), null);
  assert.deepEqual(registry.listOpfsTempFiles(), []);
});

test('downloadId 或文件名缺失时不登记', async () => {
  const registry = await loadRegistry();
  assert.equal(registry.registerOpfsTempFile(null, 'ovd-stream-c'), false);
  assert.equal(registry.registerOpfsTempFile(7, ''), false);
  assert.deepEqual(registry.listOpfsTempFiles(), []);
});

test('clearOpfsTempFiles 清空全部登记', async () => {
  const registry = await loadRegistry();
  registry.registerOpfsTempFile(1, 'ovd-stream-1');
  registry.registerOpfsTempFile(2, 'ovd-stream-2');

  registry.clearOpfsTempFiles();
  assert.deepEqual(registry.listOpfsTempFiles(), []);
});
