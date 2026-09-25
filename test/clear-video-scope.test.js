'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveClearVideoScope } = require('../background/clear-video-scope.js');

test('popup 来源（sender.tab 为空）：整 tab 清理', () => {
  const scope = resolveClearVideoScope({ sender: {}, msg: { tabId: 9 } });
  assert.equal(scope.tabId, 9);
  assert.equal(scope.frameId, null);
});

test('popup 来源带 frameId: undefined 不会走 clearFrame 出错路径', () => {
  const scope = resolveClearVideoScope({ sender: { tab: undefined, frameId: undefined }, msg: { tabId: 9 } });
  assert.equal(scope.tabId, 9);
  assert.equal(scope.frameId, null);
});

test('content 主框架（frameId=0）：tab 级清理', () => {
  const scope = resolveClearVideoScope({ sender: { tab: { id: 9 }, frameId: 0 }, msg: {} });
  assert.equal(scope.tabId, 9);
  assert.equal(scope.frameId, null);
});

test('content 子框架（frameId>0）：仅清该 frame', () => {
  const scope = resolveClearVideoScope({ sender: { tab: { id: 9 }, frameId: 7 }, msg: {} });
  assert.equal(scope.tabId, 9);
  assert.equal(scope.frameId, 7);
});

test('无法解析 tabId 时返回 null', () => {
  const scope = resolveClearVideoScope({ sender: {}, msg: {} });
  assert.equal(scope.tabId, null);
  assert.equal(scope.frameId, null);
});
