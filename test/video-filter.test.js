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

// ---------------------------------------------------------------
// 列表去噪：MSE blob 重复项（B 站视频页曾出现 1 条结构化 + 多条同名 blob）
// ---------------------------------------------------------------

test('shouldHideRedundantDetection：B 站视频页有 bilibili 结构化结果时隐藏 blob / audio 噪声', () => {
  const mod = loadModule();
  const context = { hasBilibiliMeta: true, isBilibiliVideoPage: true };

  assert.equal(mod.shouldHideRedundantDetection({ type: 'blob', url: 'blob:https://www.bilibili.com/x' }, context), true);
  assert.equal(mod.shouldHideRedundantDetection({ type: 'audio', url: 'https://www.bilibili.com/s/search/audio/open.mp3' }, context), true);
  assert.equal(mod.shouldHideRedundantDetection({ type: 'bilibili-meta', url: 'https://www.bilibili.com/video/BV1' }, context), false);
});

test('shouldHideRedundantDetection：没有结构化结果时 blob 照常展示', () => {
  const mod = loadModule();
  assert.equal(
    mod.shouldHideRedundantDetection({ type: 'blob', url: 'blob:https://example.com/x' }, { isBilibiliVideoPage: true }),
    false
  );
  assert.equal(mod.shouldHideRedundantDetection({ type: 'blob', url: 'blob:https://example.com/x' }, {}), false);
});

test('shouldHideRedundantDetection：保留 YouTube 既有规则', () => {
  const mod = loadModule();

  // 非观看页整页噪声
  assert.equal(
    mod.shouldHideRedundantDetection({ type: 'direct', url: 'https://cdn/y.mp4' }, { isYouTubePage: true, isYouTubeWatchPage: false }),
    true
  );
  // 观看页 + 有解析结果：隐藏页面内音效与同源 blob
  const watch = { hasYouTubeAdaptive: true, isYouTubePage: true, isYouTubeWatchPage: true };
  assert.equal(mod.shouldHideRedundantDetection({ type: 'audio', url: 'https://www.youtube.com/s/search/audio/failure.mp3' }, watch), true);
  assert.equal(mod.shouldHideRedundantDetection({ type: 'blob', url: 'blob:https://www.youtube.com/abc' }, watch), true);
  assert.equal(mod.shouldHideRedundantDetection({ type: 'blob', url: 'blob:https://other.site/abc' }, watch), false);
  assert.equal(mod.shouldHideRedundantDetection({ type: 'youtube-adaptive', url: 'https://www.youtube.com/watch?v=1' }, watch), false);
});

test('collapseDuplicateBlobEntries：同 frame 同名 blob 只保留最新一条', () => {
  const mod = loadModule();
  const videos = [
    { frameId: 0, timestamp: 10, title: '同名视频', type: 'blob', url: 'blob:https://www.bilibili.com/old' },
    { frameId: 0, timestamp: 20, title: '同名视频', type: 'blob', url: 'blob:https://www.bilibili.com/new' },
    { frameId: 6, timestamp: 15, title: '同名视频', type: 'blob', url: 'blob:https://s1.hdslb.com/frame6' },
    { frameId: 0, timestamp: 5, title: '另一个视频', type: 'blob', url: 'blob:https://www.bilibili.com/other' },
    { frameId: 0, timestamp: 30, title: '同名视频', type: 'bilibili-meta', url: 'https://www.bilibili.com/video/BV1' },
  ];

  assert.deepEqual(mod.collapseDuplicateBlobEntries(videos).map((video) => video.url), [
    'blob:https://www.bilibili.com/new',
    'blob:https://s1.hdslb.com/frame6',
    'blob:https://www.bilibili.com/other',
    'https://www.bilibili.com/video/BV1',
  ]);
  assert.deepEqual(mod.collapseDuplicateBlobEntries([]), []);
});

// ---------------------------------------------------------------
// YouTube HLS 条目与 youtube-adaptive 条目去重（避免同一视频两行）
// ---------------------------------------------------------------

const YT_HLS_URL = 'https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1/id/gdpvo4w0mZc/itag/0/playlist/index.m3u8';
// 现场上报的是 hls_variant（master 清单），必须同样识别
const YT_HLS_VARIANT_URL = 'https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1/id/gdpvo4w0mZc/itag/0/playlist/index.m3u8';

test('isYouTubeHlsEntry / youtubeHlsVideoId 识别 YouTube HLS 清单', () => {
  const mod = loadModule();

  assert.equal(mod.isYouTubeHlsEntry({ type: 'hls', url: YT_HLS_URL }), true);
  assert.equal(mod.isYouTubeHlsEntry({ type: 'hls', url: YT_HLS_VARIANT_URL }), true);
  assert.equal(mod.isYouTubeHlsEntry({ type: 'hls', url: 'https://cdn.example.com/x.m3u8' }), false);
  assert.equal(mod.isYouTubeHlsEntry({ type: 'youtube-adaptive', url: YT_HLS_URL }), false);
  assert.equal(mod.youtubeHlsVideoId({ url: YT_HLS_URL }), 'gdpvo4w0mZc');
  assert.equal(mod.youtubeHlsVideoId({ videoId: 'explicit', url: YT_HLS_URL }), 'explicit');
});

test('listYouTubeHlsVideoIds 只收集 YouTube HLS 条目的 videoId', () => {
  const mod = loadModule();
  const ids = mod.listYouTubeHlsVideoIds([
    { type: 'hls', url: YT_HLS_URL },
    { type: 'hls', url: 'https://cdn.example.com/x.m3u8' },
    { type: 'youtube-adaptive', url: 'https://www.youtube.com/watch?v=gdpvo4w0mZc' },
  ]);

  assert.equal(ids.has('gdpvo4w0mZc'), true);
  assert.equal(ids.size, 1);
});

test('shouldHideRedundantDetection：同一视频有 HLS 条目时隐藏 youtube-adaptive 那一行', () => {
  const mod = loadModule();
  const context = {
    hasYouTubeAdaptive: true,
    isYouTubePage: true,
    isYouTubeWatchPage: true,
    youtubeHlsVideoIds: mod.listYouTubeHlsVideoIds([{ type: 'hls', url: YT_HLS_URL }]),
  };

  assert.equal(
    mod.shouldHideRedundantDetection({ type: 'youtube-adaptive', videoId: 'gdpvo4w0mZc' }, context),
    true
  );
  // 别的视频不受影响
  assert.equal(
    mod.shouldHideRedundantDetection({ type: 'youtube-adaptive', videoId: 'otherVideo' }, context),
    false
  );
  // 没有 HLS 条目时照常展示
  assert.equal(
    mod.shouldHideRedundantDetection(
      { type: 'youtube-adaptive', videoId: 'gdpvo4w0mZc' },
      { isYouTubePage: true, isYouTubeWatchPage: true }
    ),
    false
  );
  // HLS 条目自身保留
  assert.equal(
    mod.shouldHideRedundantDetection({ type: 'hls', url: YT_HLS_URL, videoId: 'gdpvo4w0mZc' }, context),
    false
  );
});

test('mergeYouTubeHlsEntries：同一视频合并成一条，HLS 清单挂到 youtube 条目上', () => {
  const mod = loadModule();
  const videos = [
    { type: 'youtube-adaptive', url: 'https://www.youtube.com/watch?v=gdpvo4w0mZc', videoId: 'gdpvo4w0mZc' },
    { type: 'hls', url: YT_HLS_URL },
  ];

  const merged = mod.mergeYouTubeHlsEntries(videos);
  assert.equal(merged.length, 1, '同一视频只保留一行');
  assert.equal(merged[0].type, 'youtube-adaptive');
  assert.equal(merged[0].hlsManifestUrl, YT_HLS_URL);

  // 现场实际形态：hls_variant master 清单同样要能合并
  const mergedVariant = mod.mergeYouTubeHlsEntries([
    { type: 'youtube-adaptive', url: 'https://www.youtube.com/watch?v=gdpvo4w0mZc', videoId: 'gdpvo4w0mZc' },
    { type: 'hls', url: YT_HLS_VARIANT_URL },
  ]);
  assert.equal(mergedVariant.length, 1);
  assert.equal(mergedVariant[0].hlsManifestUrl, YT_HLS_VARIANT_URL);
});

test('mergeYouTubeHlsEntries：不相关条目与无对应 youtube 条目的 HLS 都保持原样', () => {
  const mod = loadModule();
  const others = [
    { type: 'youtube-adaptive', url: 'https://www.youtube.com/watch?v=other1', videoId: 'other1' },
    { type: 'hls', url: YT_HLS_URL },
    { type: 'hls', url: 'https://cdn.example.com/x.m3u8' },
  ];

  const merged = mod.mergeYouTubeHlsEntries(others);
  // other1 没有对应 HLS；YouTube HLS 也找不到对应 youtube 条目 → 三条都保留
  assert.equal(merged.length, 3);
  assert.equal(merged[0].hlsManifestUrl, undefined);

  // 非数组输入安全
  assert.deepEqual(mod.mergeYouTubeHlsEntries(null), []);
});

// SW 侧顺序要求：必须先合并、再用合并后的列表构造过滤上下文，
// 否则被吸收的 HLS 条目仍会让 hide 规则把带"需合并"选项的 youtube 行整行隐藏。
test('合并后的列表不再包含 YouTube HLS 条目（hide 规则不会误伤 youtube 行）', () => {
  const mod = loadModule();
  const merged = mod.mergeYouTubeHlsEntries([
    { type: 'youtube-adaptive', url: 'https://www.youtube.com/watch?v=gdpvo4w0mZc', videoId: 'gdpvo4w0mZc' },
    { type: 'hls', url: YT_HLS_URL },
  ]);

  assert.equal(mod.listYouTubeHlsVideoIds(merged).size, 0);
  assert.equal(
    mod.shouldHideRedundantDetection(
      merged[0],
      {
        hasYouTubeAdaptive: true,
        isYouTubePage: true,
        isYouTubeWatchPage: true,
        youtubeHlsVideoIds: mod.listYouTubeHlsVideoIds(merged),
      }
    ),
    false
  );
});
