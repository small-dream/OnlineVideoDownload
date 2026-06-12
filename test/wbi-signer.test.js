'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule() {
  const key = '__OVD_WBI_SIGNER__';
  const filePath = path.resolve(__dirname, '../lib/wbi-signer.js');
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[key];
}

// ---------------------------------------------------------------
// md5
// ---------------------------------------------------------------

test('md5("") returns d41d8cd98f00b204e9800998ecf8427e', () => {
  const mod = loadModule();
  assert.equal(mod.md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
});

test('md5("hello") returns 5d41402abc4b2a76b9719d911017c592', () => {
  const mod = loadModule();
  assert.equal(mod.md5('hello'), '5d41402abc4b2a76b9719d911017c592');
});

test('md5("The quick brown fox jumps over the lazy dog") returns known hash', () => {
  const mod = loadModule();
  assert.equal(
    mod.md5('The quick brown fox jumps over the lazy dog'),
    '9e107d9d372bb6826bd81d3542a419d6',
  );
});

test('md5 handles unicode input', () => {
  const mod = loadModule();
  const result = mod.md5('你好'); // "你好"
  assert.equal(result.length, 32);
  assert.ok(/^[0-9a-f]{32}$/.test(result));
});

test('md5 always returns 32-char hex string', () => {
  const mod = loadModule();
  for (const input of ['test', 'a', 'longer string with spaces and symbols !@#$%']) {
    const result = mod.md5(input);
    assert.equal(result.length, 32, `md5(${JSON.stringify(input)}) length`);
    assert.ok(/^[0-9a-f]{32}$/.test(result), `md5(${JSON.stringify(input)}) format`);
  }
});

// ---------------------------------------------------------------
// calcWrid
// ---------------------------------------------------------------

test('calcWrid returns a 32-char hex string', async () => {
  const mod = loadModule();
  const result = await mod.calcWrid(
    { foo: 'bar', baz: 'qux' },
    '0123456789abcdef',
    'fedcba9876543210',
  );
  assert.equal(result.length, 32);
  assert.ok(/^[0-9a-f]{32}$/.test(result));
});

test('calcWrid produces deterministic output for same inputs', async () => {
  const mod = loadModule();
  const params = { b: '2', a: '1' };
  const imgKey = 'imgkey123';
  const subKey = 'subkey456';

  const result1 = await mod.calcWrid(params, imgKey, subKey);
  const result2 = await mod.calcWrid(params, imgKey, subKey);
  assert.equal(result1, result2);
});

test('calcWrid handles empty params', async () => {
  const mod = loadModule();
  const result = await mod.calcWrid({}, 'key1', 'key2');
  assert.equal(result.length, 32);
  assert.ok(/^[0-9a-f]{32}$/.test(result));
});

test('calcWrid handles null/undefined params gracefully', async () => {
  const mod = loadModule();
  const result = await mod.calcWrid(null, 'key1', 'key2');
  assert.equal(result.length, 32);
  assert.ok(/^[0-9a-f]{32}$/.test(result));
});

test('calcWrid strips special characters from param values', async () => {
  const mod = loadModule();
  const result1 = await mod.calcWrid({ q: "hello'world" }, 'key1', 'key2');
  const result2 = await mod.calcWrid({ q: 'helloworld' }, 'key1', 'key2');
  assert.equal(result1, result2);
});

test('calcWrid sorts params alphabetically', async () => {
  const mod = loadModule();
  const result1 = await mod.calcWrid({ b: '2', a: '1' }, 'k1', 'k2');
  const result2 = await mod.calcWrid({ a: '1', b: '2' }, 'k1', 'k2');
  assert.equal(result1, result2);
});
