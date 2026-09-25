'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadGuard() {
  const key = '__OVD_PAGE_MESSAGE_GUARD__';
  const filePath = path.resolve(__dirname, '../lib/page-message-guard.js');
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[key];
}

// ---------------------------------------------------------------
// 4.6：页面上报数据的协议/类型白名单
// ---------------------------------------------------------------

test('isAllowedMediaUrl 只放行 http(s) 与带 origin 的 blob:', () => {
  const guard = loadGuard();

  assert.equal(guard.isAllowedMediaUrl('https://cdn.example.com/v.mp4'), true);
  assert.equal(guard.isAllowedMediaUrl('http://cdn.example.com/v.m3u8'), true);
  assert.equal(guard.isAllowedMediaUrl('blob:https://site.example/uuid-1'), true);

  assert.equal(guard.isAllowedMediaUrl('file:///etc/passwd'), false);
  assert.equal(guard.isAllowedMediaUrl('data:video/mp4;base64,AAAA'), false);
  assert.equal(guard.isAllowedMediaUrl('javascript:alert(1)'), false);
  assert.equal(guard.isAllowedMediaUrl('chrome-extension://abc/secret.js'), false);
  assert.equal(guard.isAllowedMediaUrl('blob:uuid-without-origin'), false);
  assert.equal(guard.isAllowedMediaUrl(''), false);
  assert.equal(guard.isAllowedMediaUrl(null), false);
  // 上限 16K：YouTube HLS 清单地址本身就带完整签名参数（可达数千字符），但仍要挡掉超长载荷
  assert.equal(guard.isAllowedMediaUrl(`https://x/${'a'.repeat(9000)}`), true);
  assert.equal(guard.isAllowedMediaUrl(`https://x/${'a'.repeat(17000)}`), false);
});

test('validateDetectedPayload 校验类型与 URL', () => {
  const guard = loadGuard();

  assert.equal(guard.validateDetectedPayload({
    type: 'youtube-adaptive',
    url: 'https://www.youtube.com/watch?v=abc',
  }).ok, true);
  assert.equal(guard.validateDetectedPayload({ type: 'hls', url: 'https://cdn.example.com/i.m3u8' }).ok, true);
  assert.equal(guard.validateDetectedPayload({ type: 'blob', url: 'blob:https://site.example/u' }).ok, true);
  assert.equal(guard.validateDetectedPayload({ type: 'drm-detected', url: 'https://site.example/w' }).ok, true);
});

test('validateDetectedPayload 拒绝伪造类型、危险协议与异常字段', () => {
  const guard = loadGuard();

  // 页面可以自造任意 type，未在白名单内的一律丢弃
  const unknownType = guard.validateDetectedPayload({ type: 'exec', url: 'https://site.example/v.mp4' });
  assert.equal(unknownType.ok, false);
  assert.match(unknownType.reason, /未知媒体类型/);

  const badScheme = guard.validateDetectedPayload({ type: 'direct', url: 'file:///C:/secret.mp4' });
  assert.equal(badScheme.ok, false);
  assert.match(badScheme.reason, /URL/);

  assert.equal(guard.validateDetectedPayload(null).ok, false);
  assert.equal(guard.validateDetectedPayload([]).ok, false);
  assert.equal(guard.validateDetectedPayload('string').ok, false);

  const longTitle = guard.validateDetectedPayload({
    title: 'x'.repeat(600),
    type: 'direct',
    url: 'https://site.example/v.mp4',
  });
  assert.equal(longTitle.ok, false);
  assert.match(longTitle.reason, /title/);
});
