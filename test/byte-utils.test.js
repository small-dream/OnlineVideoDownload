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

const mod = () => loadModule('__OVD_BYTE_UTILS__', path.resolve(__dirname, '../lib/byte-utils.js'));

// --- uint8ArrayToBase64 / base64ToUint8Array ---

test('uint8ArrayToBase64 round-trips with base64ToUint8Array', () => {
  const { uint8ArrayToBase64, base64ToUint8Array } = mod();
  const original = new Uint8Array([72, 101, 108, 108, 111, 44, 32, 119, 111, 114, 108, 100]);
  const encoded = uint8ArrayToBase64(original);
  const decoded = base64ToUint8Array(encoded);
  assert.deepEqual(decoded, original);
});

test('uint8ArrayToBase64 round-trip with binary range bytes', () => {
  const { uint8ArrayToBase64, base64ToUint8Array } = mod();
  const original = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
  const encoded = uint8ArrayToBase64(original);
  const decoded = base64ToUint8Array(encoded);
  assert.deepEqual(decoded, original);
});

test('empty Uint8Array encodes to empty string', () => {
  const { uint8ArrayToBase64, base64ToUint8Array } = mod();
  const empty = new Uint8Array(0);
  assert.equal(uint8ArrayToBase64(empty), '');
  assert.deepEqual(base64ToUint8Array(''), empty);
});

// --- formatBytes ---

test('formatBytes: 0 returns empty string', () => {
  const { formatBytes } = mod();
  assert.equal(formatBytes(0), '');
});

test('formatBytes: 0 with alwaysShowUnit returns "0 B"', () => {
  const { formatBytes } = mod();
  assert.equal(formatBytes(0, { alwaysShowUnit: true }), '0 B');
});

test('formatBytes: 1024 returns "1.0 KB"', () => {
  const { formatBytes } = mod();
  assert.equal(formatBytes(1024), '1.0 KB');
});

test('formatBytes: 1048576 returns "1.0 MB"', () => {
  const { formatBytes } = mod();
  assert.equal(formatBytes(1048576), '1.0 MB');
});

test('formatBytes: 1073741824 returns "1.00 GB"', () => {
  const { formatBytes } = mod();
  assert.equal(formatBytes(1073741824), '1.00 GB');
});

test('formatBytes: negative returns formatted value with B unit', () => {
  const { formatBytes } = mod();
  assert.equal(formatBytes(-100), '-100 B');
});

test('formatBytes: small value returns bytes', () => {
  const { formatBytes } = mod();
  assert.equal(formatBytes(512), '512 B');
});

// --- concatUint8Arrays ---

test('concatUint8Arrays: empty array returns empty Uint8Array', () => {
  const { concatUint8Arrays } = mod();
  const result = concatUint8Arrays([]);
  assert.equal(result.length, 0);
  assert.ok(result instanceof Uint8Array);
});

test('concatUint8Arrays: single array returns identical copy', () => {
  const { concatUint8Arrays } = mod();
  const single = new Uint8Array([1, 2, 3]);
  const result = concatUint8Arrays([single]);
  assert.deepEqual(result, single);
});

test('concatUint8Arrays: multiple arrays concatenated in order', () => {
  const { concatUint8Arrays } = mod();
  const a = new Uint8Array([1, 2]);
  const b = new Uint8Array([3, 4, 5]);
  const c = new Uint8Array([6]);
  const result = concatUint8Arrays([a, b, c]);
  assert.deepEqual(result, new Uint8Array([1, 2, 3, 4, 5, 6]));
});

test('concatUint8Arrays: byte offsets are correct', () => {
  const { concatUint8Arrays } = mod();
  const a = new Uint8Array([10, 20]);
  const b = new Uint8Array([30, 40, 50]);
  const result = concatUint8Arrays([a, b]);
  assert.equal(result.length, 5);
  assert.equal(result[0], 10);
  assert.equal(result[2], 30);
  assert.equal(result[4], 50);
});
