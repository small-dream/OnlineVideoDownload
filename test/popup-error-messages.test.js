'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule(globalKey, filePath) {
  delete globalThis[globalKey];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[globalKey];
}

const mod = () => loadModule('__OVD_POPUP__', path.resolve(__dirname, '../popup/popup-error-messages.js'));

// --- buildFriendlyErrorMessage: code mapping ---

test('buildFriendlyErrorMessage: maps YT_SIGNATURE_CIPHER_UNSUPPORTED to actionable text', () => {
  const { buildFriendlyErrorMessage } = mod();
  const result = buildFriendlyErrorMessage({ code: 'YT_SIGNATURE_CIPHER_UNSUPPORTED', message: 'sig cipher failed' });
  assert.equal(result.friendly, true);
  assert.equal(result.code, 'YT_SIGNATURE_CIPHER_UNSUPPORTED');
  assert.ok(result.text.includes('录制模式'));
});

test('buildFriendlyErrorMessage: maps all known YouTube codes', () => {
  const { buildFriendlyErrorMessage, ERROR_CODE_TEXT } = mod();
  const youtubeCodes = Object.keys(ERROR_CODE_TEXT).filter((code) => code.startsWith('YT_'));
  assert.ok(youtubeCodes.length >= 8);
  for (const code of youtubeCodes) {
    const result = buildFriendlyErrorMessage({ code, message: 'raw' });
    assert.equal(result.friendly, true, `expected friendly text for ${code}`);
    assert.ok(result.text.length > 0, `expected non-empty text for ${code}`);
    assert.notEqual(result.text, 'raw');
  }
});

test('buildFriendlyErrorMessage: maps all known HLS codes', () => {
  const { buildFriendlyErrorMessage, ERROR_CODE_TEXT } = mod();
  const hlsCodes = Object.keys(ERROR_CODE_TEXT).filter((code) => code.startsWith('HLS_'));
  assert.deepEqual(hlsCodes.sort(), [
    'HLS_CONTENT_SIZE_SKIP',
    'HLS_KEY_FETCH_FAILED',
    'HLS_OUTPUT_TOO_LARGE',
    'HLS_SEGMENT_DECRYPT_FAILED',
    'HLS_SEGMENT_DOWNLOAD_FAILED',
    'HLS_UNSUPPORTED_ENCRYPTION',
  ]);
  for (const code of hlsCodes) {
    const result = buildFriendlyErrorMessage({ code, message: 'raw' });
    assert.equal(result.friendly, true, `expected friendly text for ${code}`);
  }
});

test('buildFriendlyErrorMessage: unknown code falls back to raw message', () => {
  const { buildFriendlyErrorMessage } = mod();
  const result = buildFriendlyErrorMessage({ code: 'SOMETHING_NEW', message: 'raw failure' });
  assert.equal(result.friendly, false);
  assert.equal(result.text, 'raw failure');
  assert.equal(result.code, 'SOMETHING_NEW');
});

// --- buildFriendlyErrorMessage: keyword fallback ---

test('buildFriendlyErrorMessage: Bilibili API message maps to login hint', () => {
  const { buildFriendlyErrorMessage } = mod();
  const result = buildFriendlyErrorMessage({ message: 'B站 API 错误 -403: 访问权限不足' });
  assert.equal(result.friendly, true);
  assert.ok(result.text.includes('B 站'));
  assert.ok(result.text.includes('登录'));
});

test('buildFriendlyErrorMessage: receiving-end message maps to refresh hint', () => {
  const { buildFriendlyErrorMessage } = mod();
  const result = buildFriendlyErrorMessage({ message: 'Could not establish connection. Receiving end does not exist.' });
  assert.equal(result.friendly, true);
  assert.ok(result.text.includes('刷新页面'));
});

test('buildFriendlyErrorMessage: code wins over keyword fallback', () => {
  const { buildFriendlyErrorMessage } = mod();
  const result = buildFriendlyErrorMessage({ code: 'HLS_KEY_FETCH_FAILED', message: 'B站 API 错误 -403' });
  assert.equal(result.friendly, true);
  assert.equal(result.code, 'HLS_KEY_FETCH_FAILED');
  assert.ok(result.text.includes('密钥'));
});

// --- buildFriendlyErrorMessage: edge cases ---

test('buildFriendlyErrorMessage: empty input returns 未知错误', () => {
  const { buildFriendlyErrorMessage } = mod();
  assert.deepEqual(buildFriendlyErrorMessage(), { text: '未知错误', code: '', friendly: false });
  assert.deepEqual(buildFriendlyErrorMessage({}), { text: '未知错误', code: '', friendly: false });
});

test('buildFriendlyErrorMessage: real Error object with code works via destructuring', () => {
  const { buildFriendlyErrorMessage } = mod();
  const err = new Error('decrypt blew up');
  err.code = 'HLS_SEGMENT_DECRYPT_FAILED';
  const result = buildFriendlyErrorMessage(err);
  assert.equal(result.friendly, true);
  assert.equal(result.text, '视频分片解密失败，任务已中止。');
});

// --- namespace hygiene ---

test('__OVD_POPUP__ is frozen and does not double-register', () => {
  const first = mod();
  assert.ok(Object.isFrozen(first));
  require(path.resolve(__dirname, '../popup/popup-error-messages.js'));
  assert.equal(globalThis.__OVD_POPUP__, first);
});

// --- 4.4 phase C：错误目录补齐新错误码与英文关键词兜底 ---

test('新增错误码（体积超限 / OPFS 写入 / 取消）都有友好文案', () => {
  const { buildFriendlyErrorMessage } = mod();
  for (const code of ['HLS_OUTPUT_TOO_LARGE', 'HLS_CONTENT_SIZE_SKIP', 'DASH_OUTPUT_TOO_LARGE', 'OPFS_WRITE_FAILED', 'DOWNLOAD_ABORTED']) {
    const result = buildFriendlyErrorMessage({ code, message: 'raw' });
    assert.equal(result.friendly, true, 'expected friendly text for ' + code);
    assert.ok(result.text.length > 0);
  }
});

test('关键词兜底同时覆盖中文与英文原始错误', () => {
  const { buildFriendlyErrorMessage } = mod();

  const cases = [
    ['HTTP 403: https://cdn.example.com/x.m3u8', /403/],
    ['Failed to fetch: 403 Forbidden', /403/],
    ['Bilibili download failed: risk control', /Bilibili/],
    ['request timeout', /超时/],
    ['No segments found in m3u8 playlist', /分片/],
    ['DRM protected content', /DRM/],
    ['m3u8 中没有找到分片', /分片/],
  ];

  for (const [message, pattern] of cases) {
    const result = buildFriendlyErrorMessage({ message });
    assert.equal(result.friendly, true, 'expected keyword hit for: ' + message);
    assert.match(result.text, pattern, 'unexpected text for: ' + message);
  }
});
