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

const mod = () => loadModule('__OVD_VIDEO_UTILS__', path.resolve(__dirname, '../lib/video-utils.js'));

// --- deriveTitleFromUrl ---

test('deriveTitleFromUrl: extracts filename from URL path', () => {
  const { deriveTitleFromUrl } = mod();
  assert.equal(deriveTitleFromUrl('https://example.com/videos/my-video.mp4'), 'my-video');
});

test('deriveTitleFromUrl: strips extension', () => {
  const { deriveTitleFromUrl } = mod();
  assert.equal(deriveTitleFromUrl('https://example.com/path/file.webm'), 'file');
});

test('deriveTitleFromUrl: falls back to hostname for index/master/video', () => {
  const { deriveTitleFromUrl } = mod();
  assert.equal(deriveTitleFromUrl('https://cdn.example.com/index.m3u8'), 'cdn_example_com');
});

test('deriveTitleFromUrl: falls back to hostname for master', () => {
  const { deriveTitleFromUrl } = mod();
  assert.equal(deriveTitleFromUrl('https://cdn.example.com/master.m3u8'), 'cdn_example_com');
});

test('deriveTitleFromUrl: falls back to hostname for video', () => {
  const { deriveTitleFromUrl } = mod();
  assert.equal(deriveTitleFromUrl('https://cdn.example.com/video'), 'cdn_example_com');
});

test('deriveTitleFromUrl: uses parent segment when filename is a fallback name', () => {
  const { deriveTitleFromUrl } = mod();
  assert.equal(deriveTitleFromUrl('https://example.com/my-channel/index.m3u8'), 'my-channel');
});

test('deriveTitleFromUrl: empty input returns empty string', () => {
  const { deriveTitleFromUrl } = mod();
  assert.equal(deriveTitleFromUrl(''), '');
  assert.equal(deriveTitleFromUrl(null), '');
});

test('deriveTitleFromUrl: invalid URL returns empty string', () => {
  const { deriveTitleFromUrl } = mod();
  assert.equal(deriveTitleFromUrl('not-a-valid-url'), '');
});

test('deriveTitleFromUrl: playlist is also a fallback name', () => {
  const { deriveTitleFromUrl } = mod();
  assert.equal(deriveTitleFromUrl('https://example.com/show/playlist.m3u8'), 'show');
});

// --- sanitizeFilename ---

test('sanitizeFilename: replaces invalid characters with underscore', () => {
  const { sanitizeFilename } = mod();
  assert.equal(sanitizeFilename('file\\/:*?"<>|name'), 'file_________name');
});

test('sanitizeFilename: collapses whitespace', () => {
  const { sanitizeFilename } = mod();
  assert.equal(sanitizeFilename('hello   world'), 'hello world');
});

test('sanitizeFilename: truncates to 120 characters', () => {
  const { sanitizeFilename } = mod();
  const long = 'a'.repeat(200);
  assert.equal(sanitizeFilename(long).length, 120);
});

// --- 4.7 文件名健壮性 ---

test('sanitizeFilename: 规避 Windows 保留设备名（含带扩展名）', () => {
  const { sanitizeFilename } = mod();
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('con.mp4'), '_con.mp4');
  assert.equal(sanitizeFilename('NUL'), '_NUL');
  assert.equal(sanitizeFilename('lpt1.ts'), '_lpt1.ts');
  assert.equal(sanitizeFilename('COM9'), '_COM9');
  // 仅是前缀的名称不受影响
  assert.equal(sanitizeFilename('console.mp4'), 'console.mp4');
  assert.equal(sanitizeFilename('com10.mp4'), 'com10.mp4');
});

test('sanitizeFilename: 去掉结尾的点与空格（Windows 会静默剥离）', () => {
  const { sanitizeFilename } = mod();
  assert.equal(sanitizeFilename('report.'), 'report');
  assert.equal(sanitizeFilename('report...  '), 'report');
  assert.equal(sanitizeFilename('trailing '), 'trailing');
  assert.equal(sanitizeFilename('...'), 'video');
});

test('sanitizeFilename: 去掉控制字符', () => {
  const { sanitizeFilename } = mod();
  assert.equal(sanitizeFilename('a\u0000b\u001fc'), 'abc');
});

test('sanitizeFilename: 按码点截断，不切断 emoji 代理对', () => {
  const { sanitizeFilename } = mod();
  const emoji = '🎬'.repeat(200);
  const result = sanitizeFilename(emoji);

  assert.equal(Array.from(result).length, 120);
  assert.equal(result.includes('\uFFFD'), false);
  assert.equal(result.endsWith('🎬'), true);
});

test('sanitizeFilename: empty input returns fallback', () => {
  const { sanitizeFilename } = mod();
  assert.equal(sanitizeFilename(''), 'video');
  assert.equal(sanitizeFilename(null), 'video');
});

test('sanitizeFilename: custom fallback', () => {
  const { sanitizeFilename } = mod();
  assert.equal(sanitizeFilename('', 'audio'), 'audio');
});

test('sanitizeFilename: whitespace-only returns fallback', () => {
  const { sanitizeFilename } = mod();
  assert.equal(sanitizeFilename('   '), 'video');
});

// --- buildMediaFilename ---

test('buildMediaFilename: builds filename with extension', () => {
  const { buildMediaFilename } = mod();
  assert.equal(buildMediaFilename({ title: 'My Video', ext: '.mp4' }), 'My Video.mp4');
});

test('buildMediaFilename: empty title uses fallback', () => {
  const { buildMediaFilename } = mod();
  assert.equal(buildMediaFilename({ title: '', ext: '.ts' }), 'video.ts');
});

test('buildMediaFilename: custom fallback', () => {
  const { buildMediaFilename } = mod();
  assert.equal(buildMediaFilename({ title: '', fallback: 'clip', ext: '.mp4' }), 'clip.mp4');
});

test('buildMediaFilename: uses tabTitle when title is empty', () => {
  const { buildMediaFilename } = mod();
  assert.equal(
    buildMediaFilename({ title: '', tabTitle: 'Tab Title', ext: '.mp4' }),
    'Tab Title.mp4',
  );
});

test('buildMediaFilename: audio type with no title uses audio fallback', () => {
  const { buildMediaFilename } = mod();
  assert.equal(buildMediaFilename({ type: 'audio', ext: '.mp3' }), 'audio.mp3');
});

// --- formatDuration ---

test('formatDuration: 3661 seconds formats as "1:01:01"', () => {
  const { formatDuration } = mod();
  assert.equal(formatDuration(3661), '1:01:01');
});

test('formatDuration: 65 seconds formats as "1:05"', () => {
  const { formatDuration } = mod();
  assert.equal(formatDuration(65), '1:05');
});

test('formatDuration: 0 returns empty string', () => {
  const { formatDuration } = mod();
  assert.equal(formatDuration(0), '');
});

test('formatDuration: negative returns empty string', () => {
  const { formatDuration } = mod();
  assert.equal(formatDuration(-10), '');
});

test('formatDuration: 45 seconds formats as "0:45"', () => {
  const { formatDuration } = mod();
  assert.equal(formatDuration(45), '0:45');
});

test('formatDuration: 3600 seconds formats as "1:00:00"', () => {
  const { formatDuration } = mod();
  assert.equal(formatDuration(3600), '1:00:00');
});

// --- formatSize ---

test('formatSize: 1073741824 bytes returns "1.0 GB"', () => {
  const { formatSize } = mod();
  assert.equal(formatSize(1073741824), '1.0 GB');
});

test('formatSize: 1048576 bytes returns "1.0 MB"', () => {
  const { formatSize } = mod();
  assert.equal(formatSize(1048576), '1.0 MB');
});

test('formatSize: 1024 bytes returns "1 KB"', () => {
  const { formatSize } = mod();
  assert.equal(formatSize(1024), '1 KB');
});

test('formatSize: 0 returns empty string', () => {
  const { formatSize } = mod();
  assert.equal(formatSize(0), '');
});

test('formatSize: negative returns empty string', () => {
  const { formatSize } = mod();
  assert.equal(formatSize(-500), '');
});

test('formatSize: small value shows bytes', () => {
  const { formatSize } = mod();
  assert.equal(formatSize(100), '100 B');
});

// --- shortenUrl ---

test('shortenUrl: short path kept intact', () => {
  const { shortenUrl } = mod();
  assert.equal(shortenUrl('https://example.com/short/path'), 'example.com/short/path');
});

test('shortenUrl: long path gets truncated', () => {
  const { shortenUrl } = mod();
  const long = 'https://example.com/' + 'a'.repeat(50);
  const result = shortenUrl(long);
  assert.ok(result.startsWith('example.com...'));
  assert.ok(result.length < 80);
});

test('shortenUrl: invalid URL falls back to substring', () => {
  const { shortenUrl } = mod();
  const result = shortenUrl('not-a-url');
  assert.equal(result, 'not-a-url');
});

test('shortenUrl: empty input returns empty string', () => {
  const { shortenUrl } = mod();
  assert.equal(shortenUrl(''), '');
});

// --- escapeHtml ---

test('escapeHtml: escapes ampersand', () => {
  const { escapeHtml } = mod();
  assert.equal(escapeHtml('a&b'), 'a&amp;b');
});

test('escapeHtml: escapes less-than', () => {
  const { escapeHtml } = mod();
  assert.equal(escapeHtml('a<b'), 'a&lt;b');
});

test('escapeHtml: escapes greater-than', () => {
  const { escapeHtml } = mod();
  assert.equal(escapeHtml('a>b'), 'a&gt;b');
});

test('escapeHtml: escapes double quote', () => {
  const { escapeHtml } = mod();
  assert.equal(escapeHtml('a"b'), 'a&quot;b');
});

test('escapeHtml: escapes single quote', () => {
  const { escapeHtml } = mod();
  assert.equal(escapeHtml("a'b"), 'a&#39;b');
});

test('escapeHtml: escapes all special characters at once', () => {
  const { escapeHtml } = mod();
  assert.equal(escapeHtml('<script>"alert(\'xss\')&"</script>'), '&lt;script&gt;&quot;alert(&#39;xss&#39;)&amp;&quot;&lt;/script&gt;');
});

test('escapeHtml: null/undefined returns empty string', () => {
  const { escapeHtml } = mod();
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

// --- getVideoTypeLabel ---

test('getVideoTypeLabel: "hls" returns "HLS"', () => {
  const { getVideoTypeLabel } = mod();
  assert.equal(getVideoTypeLabel('hls'), 'HLS');
});

test('getVideoTypeLabel: "dash" returns "DASH"', () => {
  const { getVideoTypeLabel } = mod();
  assert.equal(getVideoTypeLabel('dash'), 'DASH');
});

test('getVideoTypeLabel: empty string returns "VIDEO"', () => {
  const { getVideoTypeLabel } = mod();
  assert.equal(getVideoTypeLabel(''), 'VIDEO');
});

test('getVideoTypeLabel: "direct" returns "MP4"', () => {
  const { getVideoTypeLabel } = mod();
  assert.equal(getVideoTypeLabel('direct'), 'MP4');
});

test('getVideoTypeLabel: "youtube-adaptive" returns "YouTube"', () => {
  const { getVideoTypeLabel } = mod();
  assert.equal(getVideoTypeLabel('youtube-adaptive'), 'YouTube');
});

test('getVideoTypeLabel: unknown type uppercases it', () => {
  const { getVideoTypeLabel } = mod();
  assert.equal(getVideoTypeLabel('custom'), 'CUSTOM');
});

// --- inferExtensionFromMimeType ---

test('inferExtensionFromMimeType: "video/mp4" returns ".mp4"', () => {
  const { inferExtensionFromMimeType } = mod();
  assert.equal(inferExtensionFromMimeType('video/mp4'), '.mp4');
});

test('inferExtensionFromMimeType: null returns ".ts"', () => {
  const { inferExtensionFromMimeType } = mod();
  assert.equal(inferExtensionFromMimeType(null), '.ts');
});

test('inferExtensionFromMimeType: "audio/mpeg" returns ".mp3"', () => {
  const { inferExtensionFromMimeType } = mod();
  assert.equal(inferExtensionFromMimeType('audio/mpeg'), '.mp3');
});

test('inferExtensionFromMimeType: "video/webm" returns ".webm"', () => {
  const { inferExtensionFromMimeType } = mod();
  assert.equal(inferExtensionFromMimeType('video/webm'), '.webm');
});

test('inferExtensionFromMimeType: "application/x-mpegURL" returns ".ts"', () => {
  const { inferExtensionFromMimeType } = mod();
  assert.equal(inferExtensionFromMimeType('application/x-mpegURL'), '.ts');
});

test('inferExtensionFromMimeType: "audio/mp4" returns ".m4a"', () => {
  const { inferExtensionFromMimeType } = mod();
  assert.equal(inferExtensionFromMimeType('audio/mp4'), '.m4a');
});

test('inferExtensionFromMimeType: "audio/flac" returns ".flac"', () => {
  const { inferExtensionFromMimeType } = mod();
  assert.equal(inferExtensionFromMimeType('audio/flac'), '.flac');
});
