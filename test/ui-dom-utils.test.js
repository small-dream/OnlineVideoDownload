'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadUtils() {
  delete globalThis.__OVD_UI_DOM_UTILS__;
  const filePath = path.resolve(__dirname, '../lib/ui-dom-utils.js');
  delete require.cache[filePath];
  require(filePath);
  return globalThis.__OVD_UI_DOM_UTILS__;
}

function mockElement(tag = 'div') {
  const attrs = {};
  const listeners = {};
  const children = [];
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    hidden: false,
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    childNodes: children,
    getAttribute(key) { return attrs[key] ?? null; },
    setAttribute(key, val) { attrs[key] = String(val); },
    removeAttribute(key) { delete attrs[key]; },
    addEventListener(event, fn) { listeners[event] = fn; },
    removeEventListener(event) { delete listeners[event]; },
    querySelector(sel) { return null; },
    querySelectorAll(sel) { return []; },
    closest(sel) { return null; },
    appendChild(child) { children.push(child); return child; },
    removeChild(child) { const i = children.indexOf(child); if (i >= 0) children.splice(i, 1); return child; },
    insertBefore(newChild, ref) { children.unshift(newChild); return newChild; },
    replaceChild(newChild, oldChild) { const i = children.indexOf(oldChild); if (i >= 0) children[i] = newChild; return oldChild; },
    contains(child) { return children.includes(child); },
    remove() {},
    focus() {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    parentNode: null,
    nextSibling: null,
    previousSibling: null,
    firstChild: null,
    lastChild: null,
    ownerDocument: null,
    cloneNode() { return mockElement(tag); },
  };
  return el;
}

test('setHidden true sets hidden and aria-hidden', () => {
  const utils = loadUtils();
  const el = mockElement();
  utils.setHidden(el, true);
  assert.equal(el.hidden, true);
  assert.equal(el.getAttribute('aria-hidden'), 'true');
});

test('setHidden false clears hidden and removes aria-hidden', () => {
  const utils = loadUtils();
  const el = mockElement();
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
  utils.setHidden(el, false);
  assert.equal(el.hidden, false);
  assert.equal(el.getAttribute('aria-hidden'), null);
});

test('setButtonState idle enables button', () => {
  const utils = loadUtils();
  const btn = mockElement('button');
  btn.disabled = true;
  const labels = { idle: '下载', downloading: '下载中...', pending: '处理中...', completed: '已完成' };
  utils.setButtonState(btn, 'idle', labels);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, '下载');
});

test('setButtonState downloading disables button', () => {
  const utils = loadUtils();
  const btn = mockElement('button');
  const labels = { idle: '下载', downloading: '下载中...' };
  utils.setButtonState(btn, 'downloading', labels);
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, '下载中...');
});

test('setButtonState completed disables button', () => {
  const utils = loadUtils();
  const btn = mockElement('button');
  const labels = { idle: '下载', completed: '已完成' };
  utils.setButtonState(btn, 'completed', labels);
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, '已完成');
});

test('setButtonState updates structured download label and hides icon while active', () => {
  const utils = loadUtils();
  const label = mockElement('span');
  const icon = mockElement('span');
  const btn = mockElement('button');
  btn.querySelector = (sel) => {
    if (sel === ':scope > .dl-label') return label;
    if (sel === ':scope > .dl-icon') return icon;
    return null;
  };

  utils.setButtonState(btn, 'downloading', { downloading: '下载中' });

  assert.equal(btn.disabled, true);
  assert.equal(btn.dataset.state, 'downloading');
  assert.equal(label.textContent, '下载中');
  assert.equal(icon.hidden, true);
});

test('updateProgress clamps percent to 0-100', () => {
  const utils = loadUtils();
  const bar = mockElement();
  const text = mockElement();
  const container = mockElement();

  bar.style = {};
  const result = utils.updateProgress({
    barElement: bar,
    containerElement: container,
    percent: 150,
    textElement: text,
  });
  assert.equal(bar.style.width, '100%');
  assert.equal(text.textContent, '100%');
});

test('updateProgress with negative percent clamps to 0', () => {
  const utils = loadUtils();
  const bar = mockElement();
  const text = mockElement();
  const container = mockElement();
  bar.style = {};

  utils.updateProgress({
    barElement: bar,
    containerElement: container,
    percent: -20,
    textElement: text,
  });
  assert.equal(bar.style.width, '0%');
  assert.equal(text.textContent, '0%');
});

test('updateProgress with valid percent sets width and text', () => {
  const utils = loadUtils();
  const bar = mockElement();
  const text = mockElement();
  const container = mockElement();
  bar.style = {};

  utils.updateProgress({
    barElement: bar,
    containerElement: container,
    percent: 42,
    textElement: text,
  });
  assert.equal(bar.style.width, '42%');
  assert.equal(text.textContent, '42%');
});
