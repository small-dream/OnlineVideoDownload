'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule() {
  const key = '__OVD_VIDEO_FILTER__';
  const filePath = path.resolve(__dirname, '../lib/video-filter.js');
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[key];
}

test('parseDomainList 解析逗号/换行/分号分隔并归一化 URL', () => {
  const mod = loadModule();
  assert.deepEqual(
    mod.parseDomainList('ads.example.com, https://spam.test/path;  .noise.io\n')
      .sort(),
    ['ads.example.com', 'noise.io', 'spam.test'].sort()
  );
  assert.deepEqual(mod.parseDomainList(['cdn.a.com']), ['cdn.a.com']);
  assert.deepEqual(mod.parseDomainList(''), []);
});

test('isBlacklistedHost 支持子域名匹配但不误伤相似域名', () => {
  const mod = loadModule();
  const domains = mod.parseDomainList('example.com');
  assert.equal(mod.isBlacklistedHost('example.com', domains), true);
  assert.equal(mod.isBlacklistedHost('cdn.example.com', domains), true);
  assert.equal(mod.isBlacklistedHost('notexample.com', domains), false);
  assert.equal(mod.isBlacklistedHost('', domains), false);
});

test('域名黑名单过滤命中视频 URL 主机', () => {
  const mod = loadModule();
  const video = { type: 'direct', url: 'https://ads.example.com/promo.mp4' };
  assert.equal(mod.shouldFilterVideo(video, { domainBlacklist: 'example.com' }).filtered, true);
  assert.equal(mod.shouldFilterVideo(video, { domainBlacklist: 'other.com' }).filtered, false);
});

test('blob 条目用所属页面域名判断黑名单', () => {
  const mod = loadModule();
  const video = { type: 'blob', url: 'blob:https://page.example.com/abc' };
  assert.equal(
    mod.shouldFilterVideo(video, { domainBlacklist: 'page.example.com' }, { tabUrl: 'https://page.example.com/watch' }).filtered,
    true
  );
  // blob URL 自身不带 hostname 时退回 tabUrl 判定
  const opaque = { type: 'blob', url: 'blob:null/abc' };
  assert.equal(
    mod.shouldFilterVideo(opaque, { domainBlacklist: 'page.example.com' }, { tabUrl: 'https://page.example.com/watch' }).filtered,
    true
  );
});

test('最小时长与最小体积只过滤通用嗅探条目', () => {
  const mod = loadModule();
  const settings = { minVideoDurationSec: 30, minVideoSizeMb: 5 };

  assert.equal(mod.shouldFilterVideo({ duration: 10, type: 'direct', url: 'https://a.com/v.mp4' }, settings).filtered, true);
  assert.equal(mod.shouldFilterVideo({ duration: 60, type: 'direct', url: 'https://a.com/v.mp4' }, settings).filtered, false);
  assert.equal(
    mod.shouldFilterVideo({ fileSize: 1024 * 1024, type: 'hls', url: 'https://a.com/v.m3u8' }, settings).filtered,
    true
  );
  assert.equal(
    mod.shouldFilterVideo({ fileSize: 20 * 1024 * 1024, type: 'hls', url: 'https://a.com/v.m3u8' }, settings).filtered,
    false
  );
  // 未知时长/体积时不过滤，避免误杀
  assert.equal(mod.shouldFilterVideo({ type: 'direct', url: 'https://a.com/v.mp4' }, settings).filtered, false);
});

test('结构化来源不受阈值过滤影响', () => {
  const mod = loadModule();
  const settings = { minVideoDurationSec: 300, minVideoSizeMb: 50 };
  assert.equal(
    mod.shouldFilterVideo({ duration: 12, type: 'youtube-adaptive', url: 'https://youtube.com/watch?v=1' }, settings).filtered,
    false
  );
  assert.equal(
    mod.shouldFilterVideo({ duration: 12, type: 'bilibili-meta', url: 'https://bilibili.com/video/BV1' }, settings).filtered,
    false
  );
});

test('filterVideos 返回保留项并支持空列表', () => {
  const mod = loadModule();
  const videos = [
    { duration: 5, type: 'direct', url: 'https://a.com/short.mp4' },
    { duration: 120, type: 'direct', url: 'https://a.com/long.mp4' },
    { duration: 3, type: 'youtube-adaptive', url: 'https://youtube.com/watch?v=1' },
  ];
  const kept = mod.filterVideos(videos, { minVideoDurationSec: 30 });
  assert.deepEqual(kept.map((video) => video.url), [
    'https://a.com/long.mp4',
    'https://youtube.com/watch?v=1',
  ]);
  assert.deepEqual(mod.filterVideos(null, {}), []);
});
