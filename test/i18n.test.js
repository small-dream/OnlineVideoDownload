'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const MODULE_PATH = path.resolve(__dirname, '../lib/i18n.js');

function loadI18n() {
  const key = '__OVD_I18N__';
  delete globalThis[key];
  delete require.cache[require.resolve(MODULE_PATH)];
  require(MODULE_PATH);
  return globalThis[key];
}

function withChrome(mock, run) {
  const previous = globalThis.chrome;
  globalThis.chrome = mock;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previous;
    }
  }
}

test('t() 优先使用 chrome.i18n 并传递占位符', () => {
  const i18n = loadI18n();
  const calls = [];

  withChrome({ i18n: { getMessage(key, subs) { calls.push({ key, subs }); return 'Downloading 42%'; } } }, () => {
    assert.equal(i18n.t('download_percent', '下载中 $1%', ['42']), 'Downloading 42%');
  });

  assert.deepEqual(calls, [{ key: 'download_percent', subs: ['42'] }]);
});

test('t() 在缺少 chrome.i18n 或消息缺失时退回中文原文', () => {
  const i18n = loadI18n();

  assert.equal(i18n.t('download_started', '下载已开始。'), '下载已开始。');

  withChrome({ i18n: { getMessage: () => '' } }, () => {
    assert.equal(i18n.t('missing_key', '下载已开始。'), '下载已开始。');
  });
});

test('t() 对缺失 key 与异常都安全降级', () => {
  const i18n = loadI18n();
  assert.equal(i18n.t('', '原文'), '原文');
  assert.equal(i18n.t('x', ''), '');

  const throwing = { i18n: { getMessage() { throw new Error('boom'); } } };
  withChrome(throwing, () => {
    assert.equal(i18n.t('x', '原文'), '原文');
  });
});

test('applyI18n 就地替换 text/title/placeholder，未配置时保留原文', () => {
  const i18n = loadI18n();
  const text = { dataset: { i18n: 'list_none' }, textContent: '未检测到视频' };
  const title = {
    dataset: { i18nTitle: 'action_settings' },
    getAttribute: () => '设置',
    setAttribute(name, value) { this[name] = value; },
  };
  const placeholder = {
    dataset: { i18nPlaceholder: 'settings_subdirPlaceholder' },
    getAttribute: () => '留空为默认目录',
    setAttribute(name, value) { this[name] = value; },
  };
  const root = {
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return [text];
      if (selector === '[data-i18n-title]') return [title];
      if (selector === '[data-i18n-placeholder]') return [placeholder];
      return [];
    },
  };

  withChrome({ i18n: { getMessage: () => '' } }, () => {
    assert.equal(i18n.applyI18n(root), 3);
    assert.equal(text.textContent, '未检测到视频');
    assert.equal(title.title, '设置');
    assert.equal(placeholder.placeholder, '留空为默认目录');
  });

  withChrome({ i18n: { getMessage: () => 'No videos detected' } }, () => {
    i18n.applyI18n(root);
    assert.equal(text.textContent, 'No videos detected');
  });
});

test('applyI18n 在没有 document 的环境下安全返回', () => {
  const i18n = loadI18n();
  assert.equal(i18n.applyI18n(null), 0);
  assert.equal(i18n.applyI18n({}), 0);
});

test('_locales 中英 key 集合一致且 JSON 合法', () => {
  const load = (locale) => JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../_locales/${locale}/messages.json`), 'utf8')
  );
  const zh = load('zh_CN');
  const en = load('en');

  assert.ok(Object.keys(zh).length > 80, 'zh_CN 应覆盖主要界面文案');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), '中英 key 必须一一对应');
});
