'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule() {
  delete globalThis.__OVD_FLOAT_BUTTON__;
  const filePath = path.resolve(__dirname, '../content/float-button.js');
  delete require.cache[filePath];
  require(filePath);
  return globalThis.__OVD_FLOAT_BUTTON__;
}

function mockDocument() {
  const created = [];
  const document = {
    head: null,
    documentElement: null,
    body: null,
    createElement(tag) {
      const children = [];
      const el = {
        tagName: String(tag).toUpperCase(),
        hidden: false,
        textContent: '',
        className: '',
        src: '',
        style: {},
        children,
        setAttribute() {},
        appendChild(child) {
          children.push(child);
          return child;
        },
        remove() {},
      };
      created.push(el);
      return el;
    },
    getElementById() {
      return null;
    },
  };
  document.head = { appendChild() {} };
  document.documentElement = { appendChild() {} };
  document.body = { appendChild() {} };
  return { created, document };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('clampPercent 边界处理', () => {
  const mod = loadModule();
  assert.equal(mod.clampPercent(0), 0);
  assert.equal(mod.clampPercent(-5), 0);
  assert.equal(mod.clampPercent(NaN), 0);
  assert.equal(mod.clampPercent(37.6), 38);
  assert.equal(mod.clampPercent(100), 100);
  assert.equal(mod.clampPercent(150), 100);
});

test('resolveMessageDuration 默认值与 0 常驻', () => {
  const mod = loadModule();
  assert.equal(mod.resolveMessageDuration(undefined), 4000);
  assert.equal(mod.resolveMessageDuration(-1), 4000);
  assert.equal(mod.resolveMessageDuration(0), 0);
  assert.equal(mod.resolveMessageDuration(2500), 2500);
});

test('showMessage 显示文本、隐藏进度条，duration 后自动消失', async () => {
  const mod = loadModule();
  const { created, document } = mockDocument();
  const button = mod.createFloatButton({ document, iconUrl: 'icon.png' });

  button.showMessage('下载已开始', false, 10);
  const container = created.find((el) => el.tagName === 'DIV');
  assert.equal(container.hidden, false);
  assert.equal(container.className, 'ovd-float-button');
  assert.equal(container.children[1].textContent, '下载已开始');
  assert.equal(container.children[2].hidden, true); // progressWrap

  await delay(60);
  assert.equal(container.hidden, true);
});

test('showMessage isError 应用错误样式，duration=0 常驻', async () => {
  const mod = loadModule();
  const { created, document } = mockDocument();
  const button = mod.createFloatButton({ document });

  button.showMessage('下载失败: 网络错误', true, 0);
  const container = created.find((el) => el.tagName === 'DIV');
  assert.equal(container.className, 'ovd-float-button ovd-float-error');

  await delay(20);
  assert.equal(container.hidden, false);
  button.hide();
  assert.equal(container.hidden, true);
});

test('showProgress 更新进度条与百分比，100 后自动消失', async () => {
  const mod = loadModule();
  const { created, document } = mockDocument();
  const button = mod.createFloatButton({ document });

  button.showProgress(42);
  const container = created.find((el) => el.tagName === 'DIV');
  const progressWrap = container.children[2];
  assert.equal(progressWrap.hidden, false);
  assert.equal(progressWrap.children[0].style.width, '42%');
  assert.equal(progressWrap.children[1].textContent, '42%');
  assert.equal(container.children[1].textContent, '视频下载中... 42%');

  button.showProgress(100);
  await delay(1700);
  assert.equal(container.hidden, true);
});

test('无 document 环境返回 null', () => {
  const mod = loadModule();
  assert.equal(mod.createFloatButton({ document: null }), null);
});
