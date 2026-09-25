'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BADGE_BACKGROUND_COLOR,
  createTabBadgeManager,
  formatBadgeCount,
} = require('../background/action-badge.js');

test('formatBadgeCount: 0/非法值清空，1-99 原样，>99 封顶 99+', () => {
  assert.equal(formatBadgeCount(0), '');
  assert.equal(formatBadgeCount(-3), '');
  assert.equal(formatBadgeCount(NaN), '');
  assert.equal(formatBadgeCount(undefined), '');
  assert.equal(formatBadgeCount(1), '1');
  assert.equal(formatBadgeCount(99), '99');
  assert.equal(formatBadgeCount(100), '99+');
  assert.equal(formatBadgeCount(9999), '99+');
});

test('refresh 按 tab 写入徽章文本与背景色', () => {
  const calls = { setBadgeText: [], setBadgeBackgroundColor: [] };
  const action = {
    setBadgeText(options) {
      calls.setBadgeText.push(options);
    },
    setBadgeBackgroundColor(options) {
      calls.setBadgeBackgroundColor.push(options);
    },
  };
  const manager = createTabBadgeManager({ action });

  manager.refresh(12, 5);
  assert.deepEqual(calls.setBadgeText, [{ tabId: 12, text: '5' }]);
  assert.deepEqual(calls.setBadgeBackgroundColor, [{ tabId: 12, color: BADGE_BACKGROUND_COLOR }]);

  manager.refresh(12, 120);
  assert.deepEqual(calls.setBadgeText[1], { tabId: 12, text: '99+' });
});

test('clear 清空指定 tab 的徽章', () => {
  const calls = [];
  const manager = createTabBadgeManager({
    action: { setBadgeText(options) { calls.push(options); } },
  });

  manager.clear(12);
  assert.deepEqual(calls, [{ tabId: 12, text: '' }]);
});

test('action 不可用时静默降级', () => {
  const manager = createTabBadgeManager({ action: undefined });
  manager.refresh(1, 3);
  manager.clear(1);
});
