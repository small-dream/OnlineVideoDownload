'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule() {
  const key = '__OVD_PREVIEW_UTILS__';
  const filePath = path.resolve(__dirname, '../lib/preview-utils.js');
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[key];
}

// --- isHttpUrl / isPreviewableType / shouldMaterializePreview ---

test('isHttpUrl 只认 http(s)', () => {
  const mod = loadModule();
  assert.equal(mod.isHttpUrl('https://cdn.example.com/v.mp4'), true);
  assert.equal(mod.isHttpUrl(' http://cdn.example.com/v.mp4 '), true);
  assert.equal(mod.isHttpUrl('blob:https://site.example/u'), false);
  assert.equal(mod.isHttpUrl('//cdn.example.com/v.mp4'), false);
  assert.equal(mod.isHttpUrl(''), false);
  assert.equal(mod.isHttpUrl(null), false);
});

test('shouldMaterializePreview 只对超时未加载的直链补全', () => {
  const mod = loadModule();
  assert.equal(mod.shouldMaterializePreview({ type: 'direct', url: 'https://cdn.example.com/v.mp4' }), true);
  assert.equal(mod.shouldMaterializePreview({ type: 'direct', url: 'https://cdn.example.com/v.mp4' }, { directPreviewFailed: false }), false);
  assert.equal(mod.shouldMaterializePreview({ type: 'hls', url: 'https://cdn.example.com/i.m3u8' }), false);
  assert.equal(mod.shouldMaterializePreview({ type: 'blob', url: 'blob:https://site.example/u' }), false);
  assert.equal(mod.shouldMaterializePreview({ type: 'direct', url: 'blob:https://site.example/u' }), false);
  assert.equal(mod.shouldMaterializePreview(null), false);
});

test('previewCacheKey 以 URL 为键', () => {
  const mod = loadModule();
  assert.equal(mod.previewCacheKey({ url: 'https://cdn.example.com/v.mp4' }), 'https://cdn.example.com/v.mp4');
  assert.equal(mod.previewCacheKey({}), '');
});

// --- MIME 推断 ---

test('resolvePreviewMimeType 优先响应头并过滤非媒体类型', () => {
  const mod = loadModule();
  assert.equal(mod.resolvePreviewMimeType({ mimeType: 'video/webm' }, 'video/mp4; charset=utf-8'), 'video/mp4');
  assert.equal(mod.resolvePreviewMimeType({ mimeType: 'video/webm' }, 'text/html'), 'video/webm');
  assert.equal(mod.resolvePreviewMimeType({ mimeType: 'application/octet-stream' }, ''), 'video/mp4');
  assert.equal(mod.resolvePreviewMimeType({}, ''), 'video/mp4');
  assert.equal(mod.resolvePreviewMimeType({ mimeType: 'audio/mpeg' }, null), 'audio/mpeg');
});

test('resolvePreviewSourceType 给 HLS 清单单独的 MIME', () => {
  const mod = loadModule();
  assert.equal(mod.resolvePreviewSourceType({ type: 'hls' }), 'application/vnd.apple.mpegurl');
  assert.equal(mod.resolvePreviewSourceType({ type: 'direct', mimeType: 'video/webm' }), 'video/webm');
  assert.equal(mod.resolvePreviewSourceType({ type: 'direct' }), 'video/mp4');
  assert.equal(mod.resolvePreviewSourceType({ type: 'direct', mimeType: 'text/plain' }), 'video/mp4');
});

// --- readPrefixBlob ---

function streamingResponse(chunks, contentType = 'video/mp4', contentLength = null) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new Uint8Array(chunk));
      }
      controller.close();
    },
  });

  return {
    body: stream,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-type') return contentType;
        if (String(name).toLowerCase() === 'content-length') return contentLength == null ? null : String(contentLength);
        return null;
      },
    },
  };
}

test('readPrefixBlob 未超上限时完整读取', async () => {
  const mod = loadModule();
  const response = streamingResponse([[1, 2, 3], [4, 5]]);
  const result = await mod.readPrefixBlob(response, { limit: 10, mimeType: 'video/mp4' });

  assert.equal(result.bytes, 5);
  assert.equal(result.truncated, false);
  assert.equal(result.blob.size, 5);
  assert.equal(result.blob.type, 'video/mp4');
});

test('readPrefixBlob 达到上限即截断并停止读取', async () => {
  const mod = loadModule();
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.enqueue(new Uint8Array([5, 6, 7, 8]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = {
    body: stream,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'video/mp4' : null) },
  };

  const result = await mod.readPrefixBlob(response, { limit: 6 });
  assert.equal(result.bytes, 6);
  assert.equal(result.truncated, true);
  assert.equal(result.blob.size, 6);
  assert.equal(cancelled, true);
});

test('readPrefixBlob 用 content-length 标记截断并支持无流式 body', async () => {
  const mod = loadModule();

  const byLength = await mod.readPrefixBlob(streamingResponse([[1, 2, 3]], 'video/mp4', 999), { limit: 10 });
  assert.equal(byLength.bytes, 3);
  assert.equal(byLength.truncated, true);

  const buffered = await mod.readPrefixBlob({
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    headers: { get: () => 'video/mp4' },
  }, { limit: 2 });
  assert.equal(buffered.bytes, 2);
  assert.equal(buffered.truncated, true);

  const empty = await mod.readPrefixBlob(null, { limit: 2 });
  assert.equal(empty.blob, null);
  assert.equal(empty.bytes, 0);
});

test('normalizePreviewByteLimit 对非法值回落到默认上限', () => {
  const mod = loadModule();
  assert.equal(mod.normalizePreviewByteLimit(1024), 1024);
  assert.equal(mod.normalizePreviewByteLimit(1024.7), 1024);
  assert.equal(mod.normalizePreviewByteLimit(0), mod.DEFAULT_PREVIEW_MAX_BYTES);
  assert.equal(mod.normalizePreviewByteLimit(-5), mod.DEFAULT_PREVIEW_MAX_BYTES);
  assert.equal(mod.normalizePreviewByteLimit('abc'), mod.DEFAULT_PREVIEW_MAX_BYTES);
  assert.equal(mod.normalizePreviewByteLimit(undefined), mod.DEFAULT_PREVIEW_MAX_BYTES);
});

// --- isSafeThumbnail / escapeCssUrl ---

test('isSafeThumbnail 只放行图片地址与 base64 图片', () => {
  const mod = loadModule();
  assert.equal(mod.isSafeThumbnail('https://i.ytimg.com/vi/a/hq.jpg'), true);
  assert.equal(mod.isSafeThumbnail('data:image/png;base64,AAAA'), true);
  assert.equal(mod.isSafeThumbnail('data:image/webp;base64,AAAA'), true);
  assert.equal(mod.isSafeThumbnail('javascript:alert(1)'), false);
  assert.equal(mod.isSafeThumbnail('data:text/html;base64,AAAA'), false);
  assert.equal(mod.isSafeThumbnail(''), false);
  assert.equal(mod.isSafeThumbnail(null), false);
});

test('escapeCssUrl 转义会截断样式的字符', () => {
  const mod = loadModule();
  assert.equal(mod.escapeCssUrl("https://x/a'b\").jpg"), 'https://x/a%27b%22%29.jpg');
  assert.equal(mod.escapeCssUrl('https://x/a(b).jpg'), 'https://x/a%28b%29.jpg');
  assert.equal(mod.escapeCssUrl('https://x/a\\b.jpg'), 'https://x/a%5Cb.jpg');
  assert.equal(mod.escapeCssUrl('data:image/jpeg;base64,AAA+/='), 'data:image/jpeg;base64,AAA+/=');
  assert.equal(mod.escapeCssUrl(null), '');
});
