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

const mod = () => loadModule('__OVD_MESSAGE_TYPES__', path.resolve(__dirname, '../lib/message-types.js'));

// --- getErrorMessage ---

test('getErrorMessage: string pass-through', () => {
  const { getErrorMessage } = mod();
  assert.equal(getErrorMessage('some error'), 'some error');
});

test('getErrorMessage: trims whitespace from string', () => {
  const { getErrorMessage } = mod();
  assert.equal(getErrorMessage('  padded  '), 'padded');
});

test('getErrorMessage: Error instance returns message', () => {
  const { getErrorMessage } = mod();
  assert.equal(getErrorMessage(new Error('fail')), 'fail');
});

test('getErrorMessage: null returns fallback', () => {
  const { getErrorMessage } = mod();
  assert.equal(getErrorMessage(null), 'Unknown error');
});

test('getErrorMessage: empty string returns fallback', () => {
  const { getErrorMessage } = mod();
  assert.equal(getErrorMessage(''), 'Unknown error');
});

test('getErrorMessage: object with message property', () => {
  const { getErrorMessage } = mod();
  assert.equal(getErrorMessage({ message: 'obj error' }), 'obj error');
});

test('getErrorMessage: custom fallback', () => {
  const { getErrorMessage } = mod();
  assert.equal(getErrorMessage(null, 'custom fallback'), 'custom fallback');
});

// --- isMessageObject ---

test('isMessageObject: plain object returns true', () => {
  const { isMessageObject } = mod();
  assert.equal(isMessageObject({}), true);
  assert.equal(isMessageObject({ type: 'FOO' }), true);
});

test('isMessageObject: array returns false', () => {
  const { isMessageObject } = mod();
  assert.equal(isMessageObject([]), false);
});

test('isMessageObject: null returns false', () => {
  const { isMessageObject } = mod();
  assert.equal(isMessageObject(null), false);
});

test('isMessageObject: string returns false', () => {
  const { isMessageObject } = mod();
  assert.equal(isMessageObject('hello'), false);
});

test('isMessageObject: number returns false', () => {
  const { isMessageObject } = mod();
  assert.equal(isMessageObject(42), false);
});

// --- validateMessage ---

test('validateMessage: valid message returns ok:true', () => {
  const { validateMessage } = mod();
  const result = validateMessage({ type: 'DOWNLOAD_VIDEO' });
  assert.deepEqual(result, { ok: true });
});

test('validateMessage: missing type returns error', () => {
  const { validateMessage } = mod();
  const result = validateMessage({});
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('type'));
});

test('validateMessage: missing required field returns error', () => {
  const { validateMessage } = mod();
  const result = validateMessage({ type: 'FOO' }, { requiredFields: ['url'] });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('url'));
});

test('validateMessage: allowedTypes whitelist accepts valid type', () => {
  const { validateMessage } = mod();
  const result = validateMessage(
    { type: 'DOWNLOAD_VIDEO' },
    { allowedTypes: ['DOWNLOAD_VIDEO', 'FETCH_BLOB'] },
  );
  assert.equal(result.ok, true);
});

test('validateMessage: allowedTypes rejects unsupported type', () => {
  const { validateMessage } = mod();
  const result = validateMessage(
    { type: 'UNKNOWN_TYPE' },
    { allowedTypes: ['DOWNLOAD_VIDEO', 'FETCH_BLOB'] },
  );
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('UNKNOWN_TYPE'));
});

test('validateMessage: non-object returns error', () => {
  const { validateMessage } = mod();
  const result = validateMessage('not an object');
  assert.equal(result.ok, false);
});

test('validateMessage: requireType=false skips type check', () => {
  const { validateMessage } = mod();
  const result = validateMessage({ data: 123 }, { requireType: false });
  assert.equal(result.ok, true);
});

// --- assertValidMessage ---

test('assertValidMessage: valid message returns the message', () => {
  const { assertValidMessage } = mod();
  const msg = { type: 'DOWNLOAD_VIDEO' };
  assert.equal(assertValidMessage(msg), msg);
});

test('assertValidMessage: invalid message throws', () => {
  const { assertValidMessage } = mod();
  assert.throws(() => assertValidMessage({}), { name: 'Error' });
});

test('assertValidMessage: non-object throws', () => {
  const { assertValidMessage } = mod();
  assert.throws(() => assertValidMessage(null), { name: 'Error' });
});

// --- toMessageResponse ---

test('toMessageResponse: ok:false with error normalizes', () => {
  const { toMessageResponse } = mod();
  const result = toMessageResponse({ ok: false, error: 'bad' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'bad');
});

test('toMessageResponse: ok:true strips error field', () => {
  const { toMessageResponse } = mod();
  const result = toMessageResponse({ ok: true, error: 'ignored', data: 42 });
  assert.equal(result.ok, true);
  assert.equal(result.data, 42);
  assert.ok(!('error' in result));
});

test('toMessageResponse: plain object wraps with ok:true', () => {
  const { toMessageResponse } = mod();
  const result = toMessageResponse({ items: [1, 2] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items, [1, 2]);
});

test('toMessageResponse: undefined returns {ok:true}', () => {
  const { toMessageResponse } = mod();
  assert.deepEqual(toMessageResponse(undefined), { ok: true });
});

test('toMessageResponse: non-object returns {ok:true}', () => {
  const { toMessageResponse } = mod();
  assert.deepEqual(toMessageResponse('string'), { ok: true });
});

// --- toErrorResponse ---

test('toErrorResponse: returns {ok:false, error:string}', () => {
  const { toErrorResponse } = mod();
  const result = toErrorResponse('something broke');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'something broke');
});

test('toErrorResponse: Error instance', () => {
  const { toErrorResponse } = mod();
  const result = toErrorResponse(new Error('crash'));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'crash');
});

test('toErrorResponse: null uses fallback', () => {
  const { toErrorResponse } = mod();
  const result = toErrorResponse(null);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Unknown error');
});

// --- MESSAGE_TYPES is frozen ---

test('MESSAGE_TYPES is frozen', () => {
  const { MESSAGE_TYPES } = mod();
  assert.ok(Object.isFrozen(MESSAGE_TYPES));
});

test('MESSAGE_TYPES contains expected keys', () => {
  const { MESSAGE_TYPES } = mod();
  assert.ok('DOWNLOAD_VIDEO' in MESSAGE_TYPES);
  assert.ok('VIDEO_DETECTED' in MESSAGE_TYPES);
  assert.ok('DOWNLOAD_PROGRESS' in MESSAGE_TYPES);
  assert.ok('DOWNLOAD_TASKS_UPDATED' in MESSAGE_TYPES);
  assert.ok('GET_DOWNLOAD_TASKS' in MESSAGE_TYPES);
  assert.ok('RETRY_DOWNLOAD_TASK' in MESSAGE_TYPES);
  assert.ok('DELETE_DOWNLOAD_TASK' in MESSAGE_TYPES);
  assert.equal(MESSAGE_TYPES.DOWNLOAD_VIDEO, 'DOWNLOAD_VIDEO');
});

// --- PAGE_CONTEXT_SOURCES is frozen ---

test('PAGE_CONTEXT_SOURCES is frozen', () => {
  const { PAGE_CONTEXT_SOURCES } = mod();
  assert.ok(Object.isFrozen(PAGE_CONTEXT_SOURCES));
});
