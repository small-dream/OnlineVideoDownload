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

const mod = () => loadModule('__OVD_CONSTANTS__', path.resolve(__dirname, '../lib/constants.js'));

test('constants object is frozen', () => {
  const constants = mod();
  assert.ok(Object.isFrozen(constants));
});

test('HLS_SEGMENT_CONCURRENCY is 5', () => {
  const constants = mod();
  assert.equal(constants.HLS_SEGMENT_CONCURRENCY, 5);
  assert.ok(typeof constants.HLS_SEGMENT_CONCURRENCY === 'number');
});

test('BLOB_TRANSFER_CHUNK_SIZE is 262144', () => {
  const constants = mod();
  assert.equal(constants.BLOB_TRANSFER_CHUNK_SIZE, 262144);
  assert.ok(typeof constants.BLOB_TRANSFER_CHUNK_SIZE === 'number');
});

test('MAX_IN_PAGE_MERGE_BYTES is 2GB（muxer 零拷贝后放宽）', () => {
  const constants = mod();
  assert.equal(constants.MAX_IN_PAGE_MERGE_BYTES, 2147483648);
  assert.ok(typeof constants.MAX_IN_PAGE_MERGE_BYTES === 'number');
});

test('STREAM_FETCH_RETRY_DELAYS is an array of numbers', () => {
  const constants = mod();
  assert.ok(Array.isArray(constants.STREAM_FETCH_RETRY_DELAYS));
  assert.ok(constants.STREAM_FETCH_RETRY_DELAYS.every(d => typeof d === 'number'));
  assert.ok(constants.STREAM_FETCH_RETRY_DELAYS.length > 0);
});

test('DOWNLOAD_RESUME_RETRY_DELAYS is an array of numbers', () => {
  const constants = mod();
  assert.ok(Array.isArray(constants.DOWNLOAD_RESUME_RETRY_DELAYS));
  assert.ok(constants.DOWNLOAD_RESUME_RETRY_DELAYS.every(d => typeof d === 'number'));
  assert.ok(constants.DOWNLOAD_RESUME_RETRY_DELAYS.length > 0);
});

test('MEDIA_STREAM_TIMEOUT is a positive number', () => {
  const constants = mod();
  assert.ok(typeof constants.MEDIA_STREAM_TIMEOUT === 'number');
  assert.ok(constants.MEDIA_STREAM_TIMEOUT > 0);
});

test('PAGE_DIRECT_DOWNLOAD_TIMEOUT is a positive number', () => {
  const constants = mod();
  assert.ok(typeof constants.PAGE_DIRECT_DOWNLOAD_TIMEOUT === 'number');
  assert.ok(constants.PAGE_DIRECT_DOWNLOAD_TIMEOUT > 0);
});

test('SCRIPT_INJECTION_DELAY is a positive number', () => {
  const constants = mod();
  assert.ok(typeof constants.SCRIPT_INJECTION_DELAY === 'number');
  assert.ok(constants.SCRIPT_INJECTION_DELAY > 0);
});

test('OBJECT_URL_REVOKE_DELAY is a positive number', () => {
  const constants = mod();
  assert.ok(typeof constants.OBJECT_URL_REVOKE_DELAY === 'number');
  assert.ok(constants.OBJECT_URL_REVOKE_DELAY > 0);
});

test('HLS_MAX_FAILED_RATIO is a number between 0 and 1', () => {
  const constants = mod();
  assert.ok(typeof constants.HLS_MAX_FAILED_RATIO === 'number');
  assert.ok(constants.HLS_MAX_FAILED_RATIO > 0);
  assert.ok(constants.HLS_MAX_FAILED_RATIO <= 1);
});

test('all expected keys exist', () => {
  const constants = mod();
  const expectedKeys = [
    'STREAM_FETCH_RETRY_DELAYS',
    'DOWNLOAD_RESUME_RETRY_DELAYS',
    'HLS_SEGMENT_CONCURRENCY',
    'BLOB_TRANSFER_CHUNK_SIZE',
    'MEDIA_STREAM_TIMEOUT',
    'PAGE_DIRECT_DOWNLOAD_TIMEOUT',
    'MAX_IN_PAGE_MERGE_BYTES',
    'SCRIPT_INJECTION_DELAY',
    'OBJECT_URL_REVOKE_DELAY',
    'HLS_MAX_FAILED_RATIO',
  ];
  for (const key of expectedKeys) {
    assert.ok(key in constants, `Missing key: ${key}`);
  }
});
