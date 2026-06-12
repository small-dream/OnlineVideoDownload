'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function loadModule() {
  const key = '__OVD_YOUTUBE_STREAM_UTILS__';
  const filePath = path.resolve(__dirname, '../lib/youtube-stream-utils.js');
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[key];
}

// ---------------------------------------------------------------
// parseResolutionHeight
// ---------------------------------------------------------------

test('parseResolutionHeight parses "1080p" to 1080', () => {
  const mod = loadModule();
  assert.equal(mod.parseResolutionHeight('1080p'), 1080);
});

test('parseResolutionHeight parses "720P" (uppercase) to 720', () => {
  const mod = loadModule();
  assert.equal(mod.parseResolutionHeight('720P'), 720);
});

test('parseResolutionHeight parses "480p" to 480', () => {
  const mod = loadModule();
  assert.equal(mod.parseResolutionHeight('480p'), 480);
});

test('parseResolutionHeight returns 0 for "auto"', () => {
  const mod = loadModule();
  assert.equal(mod.parseResolutionHeight('auto'), 0);
});

test('parseResolutionHeight returns 0 for non-string', () => {
  const mod = loadModule();
  assert.equal(mod.parseResolutionHeight(null), 0);
  assert.equal(mod.parseResolutionHeight(undefined), 0);
  assert.equal(mod.parseResolutionHeight(1080), 0);
});

test('parseResolutionHeight returns 0 for unparseable string', () => {
  const mod = loadModule();
  assert.equal(mod.parseResolutionHeight('hd'), 0);
  assert.equal(mod.parseResolutionHeight(''), 0);
});

// ---------------------------------------------------------------
// streamHasUsableUrl
// ---------------------------------------------------------------

test('streamHasUsableUrl returns true for stream with truthy url', () => {
  const mod = loadModule();
  assert.equal(mod.streamHasUsableUrl({ url: 'https://example.com/v.mp4' }), true);
});

test('streamHasUsableUrl returns false for missing url', () => {
  const mod = loadModule();
  assert.equal(mod.streamHasUsableUrl({}), false);
});

test('streamHasUsableUrl returns false for empty string url', () => {
  const mod = loadModule();
  assert.equal(mod.streamHasUsableUrl({ url: '' }), false);
});

test('streamHasUsableUrl returns false for null stream', () => {
  const mod = loadModule();
  assert.equal(mod.streamHasUsableUrl(null), false);
});

test('streamHasUsableUrl returns false for undefined stream', () => {
  const mod = loadModule();
  assert.equal(mod.streamHasUsableUrl(undefined), false);
});

// ---------------------------------------------------------------
// normalizeYouTubeStreams
// ---------------------------------------------------------------

test('normalizeYouTubeStreams normalizes streams with defaults and sets kind', () => {
  const mod = loadModule();
  const result = mod.normalizeYouTubeStreams({
    audioStreams: [{ itag: 140, mimeType: 'audio/mp4' }],
    videoStreams: [{ itag: 137, height: 1080, mimeType: 'video/mp4' }],
    combined: [{ itag: 22, height: 720, mimeType: 'video/mp4', url: 'https://example.com/v.mp4' }],
  });

  assert.equal(result.audio.length, 1);
  assert.equal(result.video.length, 1);
  assert.equal(result.combined.length, 1);

  assert.equal(result.audio[0].kind, 'audio');
  assert.equal(result.video[0].kind, 'video');
  assert.equal(result.combined[0].kind, 'combined');
});

test('normalizeYouTubeStreams computes hasSignatureCipher and hasUrl', () => {
  const mod = loadModule();
  const result = mod.normalizeYouTubeStreams({
    audioStreams: [],
    videoStreams: [
      { itag: 137, signatureCipher: 's=abc&sp=sig&url=...', mimeType: 'video/mp4' },
      { itag: 299, url: 'https://example.com/hd.mp4', mimeType: 'video/mp4' },
    ],
    combined: [],
  });

  assert.equal(result.video[0].hasSignatureCipher, true);
  assert.equal(result.video[0].hasUrl, false);
  assert.equal(result.video[1].hasSignatureCipher, false);
  assert.equal(result.video[1].hasUrl, true);
});

test('normalizeYouTubeStreams handles empty/null input', () => {
  const mod = loadModule();
  const result = mod.normalizeYouTubeStreams();
  assert.equal(result.audio.length, 0);
  assert.equal(result.video.length, 0);
  assert.equal(result.combined.length, 0);
});

test('normalizeYouTubeStreams handles cipher alias for signatureCipher', () => {
  const mod = loadModule();
  const result = mod.normalizeYouTubeStreams({
    videoStreams: [{ itag: 137, cipher: 's=xyz&sp=sig&url=...', mimeType: 'video/mp4' }],
    audioStreams: [],
    combined: [],
  });
  assert.equal(result.video[0].hasSignatureCipher, true);
  assert.equal(result.video[0].signatureCipher, 's=xyz&sp=sig&url=...');
});

// ---------------------------------------------------------------
// pickCombinedStream
// ---------------------------------------------------------------

test('pickCombinedStream exact resolution match', () => {
  const mod = loadModule();
  const result = mod.pickCombinedStream(
    {
      combined: [
        { itag: 22, height: 720, mimeType: 'video/mp4', url: 'https://example.com/720.mp4' },
        { itag: 18, height: 360, mimeType: 'video/mp4', url: 'https://example.com/360.mp4' },
      ],
    },
    { resolution: '720p' },
  );
  assert.equal(result.itag, 22);
  assert.equal(result.height, 720);
});

test('pickCombinedStream "auto" returns best quality', () => {
  const mod = loadModule();
  const result = mod.pickCombinedStream(
    {
      combined: [
        { itag: 18, height: 360, mimeType: 'video/mp4', url: 'https://example.com/360.mp4' },
        { itag: 22, height: 720, mimeType: 'video/mp4', url: 'https://example.com/720.mp4' },
      ],
    },
    { resolution: 'auto' },
  );
  assert.equal(result.height, 720);
});

test('pickCombinedStream fallbackToLowerQuality=true (default) picks lower quality', () => {
  const mod = loadModule();
  const result = mod.pickCombinedStream(
    {
      combined: [
        { itag: 18, height: 360, mimeType: 'video/mp4', url: 'https://example.com/360.mp4' },
        { itag: 22, height: 720, mimeType: 'video/mp4', url: 'https://example.com/720.mp4' },
      ],
    },
    { resolution: '480p', fallbackToLowerQuality: true },
  );
  assert.equal(result.height, 360);
});

test('pickCombinedStream fallbackToLowerQuality=false returns null when no exact match', () => {
  const mod = loadModule();
  const result = mod.pickCombinedStream(
    {
      combined: [
        { itag: 18, height: 360, mimeType: 'video/mp4', url: 'https://example.com/360.mp4' },
        { itag: 22, height: 720, mimeType: 'video/mp4', url: 'https://example.com/720.mp4' },
      ],
    },
    { resolution: '480p', fallbackToLowerQuality: false },
  );
  assert.equal(result, null);
});

test('pickCombinedStream returns null when no combined streams', () => {
  const mod = loadModule();
  const result = mod.pickCombinedStream({ combined: [] }, { resolution: '720p' });
  assert.equal(result, null);
});

test('pickCombinedStream filters out non-mp4 video streams', () => {
  const mod = loadModule();
  const result = mod.pickCombinedStream(
    {
      combined: [
        { itag: 999, height: 1080, mimeType: 'video/webm', url: 'https://example.com/webm' },
        { itag: 22, height: 720, mimeType: 'video/mp4', url: 'https://example.com/mp4' },
      ],
    },
    { resolution: 'auto' },
  );
  assert.equal(result.itag, 22);
});

// ---------------------------------------------------------------
// pickAdaptiveVideoStream
// ---------------------------------------------------------------

test('pickAdaptiveVideoStream resolution targeting exact match', () => {
  const mod = loadModule();
  const result = mod.pickAdaptiveVideoStream(
    {
      videoStreams: [
        { itag: 137, height: 1080, mimeType: 'video/mp4', url: 'https://example.com/1080.mp4' },
        { itag: 136, height: 720, mimeType: 'video/mp4', url: 'https://example.com/720.mp4' },
      ],
    },
    { resolution: '720p' },
  );
  assert.equal(result.itag, 136);
});

test('pickAdaptiveVideoStream "auto" returns best quality', () => {
  const mod = loadModule();
  const result = mod.pickAdaptiveVideoStream(
    {
      videoStreams: [
        { itag: 136, height: 720, mimeType: 'video/mp4', url: 'https://example.com/720.mp4' },
        { itag: 137, height: 1080, mimeType: 'video/mp4', url: 'https://example.com/1080.mp4' },
      ],
    },
    { resolution: 'auto' },
  );
  assert.equal(result.height, 1080);
});

test('pickAdaptiveVideoStream fallback to lower quality', () => {
  const mod = loadModule();
  const result = mod.pickAdaptiveVideoStream(
    {
      videoStreams: [
        { itag: 137, height: 1080, mimeType: 'video/mp4', url: 'https://example.com/1080.mp4' },
        { itag: 136, height: 720, mimeType: 'video/mp4', url: 'https://example.com/720.mp4' },
        { itag: 135, height: 480, mimeType: 'video/mp4', url: 'https://example.com/480.mp4' },
      ],
    },
    { resolution: '900p', fallbackToLowerQuality: true },
  );
  // 900p not available; fallback picks the highest <= 900 → 720
  assert.equal(result.height, 720);
});

test('pickAdaptiveVideoStream fallbackToLowerQuality=false returns null for missing resolution', () => {
  const mod = loadModule();
  const result = mod.pickAdaptiveVideoStream(
    {
      videoStreams: [
        { itag: 137, height: 1080, mimeType: 'video/mp4', url: 'https://example.com/1080.mp4' },
      ],
    },
    { resolution: '720p', fallbackToLowerQuality: false },
  );
  assert.equal(result, null);
});

test('pickAdaptiveVideoStream returns null when no video streams', () => {
  const mod = loadModule();
  const result = mod.pickAdaptiveVideoStream({ videoStreams: [] });
  assert.equal(result, null);
});

// ---------------------------------------------------------------
// pickAdaptiveAudioStream
// ---------------------------------------------------------------

test('pickAdaptiveAudioStream returns first audio stream (sorted by bitrate)', () => {
  const mod = loadModule();
  const result = mod.pickAdaptiveAudioStream({
    audioStreams: [
      { itag: 140, bitrate: 128000, mimeType: 'audio/mp4', url: 'https://example.com/a1.mp4' },
      { itag: 251, bitrate: 64000, mimeType: 'audio/mp4', url: 'https://example.com/a2.mp4' },
    ],
  });
  assert.equal(result.itag, 140);
  assert.equal(result.bitrate, 128000);
});

test('pickAdaptiveAudioStream returns null when no audio streams', () => {
  const mod = loadModule();
  assert.equal(mod.pickAdaptiveAudioStream({ audioStreams: [] }), null);
});

test('pickAdaptiveAudioStream returns null for empty meta', () => {
  const mod = loadModule();
  assert.equal(mod.pickAdaptiveAudioStream({}), null);
  assert.equal(mod.pickAdaptiveAudioStream(), null);
});

// ---------------------------------------------------------------
// estimateYouTubeDownloadSize
// ---------------------------------------------------------------

test('estimateYouTubeDownloadSize uses combined stream for fixed resolution when available', () => {
  const mod = loadModule();
  const result = mod.estimateYouTubeDownloadSize(
    {
      combined: [
        { height: 1080, contentLength: 250000000, mimeType: 'video/mp4', url: 'https://example.com/1080.mp4' },
      ],
      videoStreams: [
        { height: 1080, contentLength: 180000000, mimeType: 'video/mp4', url: 'https://example.com/v1080.mp4' },
      ],
      audioStreams: [
        { bitrate: 128000, contentLength: 7000000, mimeType: 'audio/mp4', url: 'https://example.com/a.mp4' },
      ],
    },
    { preferCombined: true, resolution: '1080p' },
  );

  assert.equal(result.kind, 'combined');
  assert.equal(result.bytes, 250000000);
});

test('estimateYouTubeDownloadSize estimates bytes from bitrate and duration when contentLength is missing', () => {
  const mod = loadModule();
  const result = mod.estimateYouTubeDownloadSize(
    {
      duration: 100,
      videoStreams: [
        { height: 1080, bitrate: 8000000, mimeType: 'video/mp4', url: 'https://example.com/v1080.mp4' },
        { height: 720, bitrate: 4000000, mimeType: 'video/mp4', url: 'https://example.com/v720.mp4' },
      ],
      audioStreams: [
        { bitrate: 128000, mimeType: 'audio/mp4', url: 'https://example.com/a.mp4' },
      ],
      combined: [],
    },
    { preferCombined: false, resolution: '1080p' },
  );

  assert.equal(result.kind, 'adaptive');
  assert.equal(result.bytes, 101600000);
});

test('estimateYouTubeDownloadSize falls back to adaptive when exact combined resolution is missing', () => {
  const mod = loadModule();
  const result = mod.estimateYouTubeDownloadSize(
    {
      combined: [
        { height: 720, contentLength: 140000000, mimeType: 'video/mp4', url: 'https://example.com/720.mp4' },
      ],
      videoStreams: [
        { height: 1080, contentLength: 180000000, mimeType: 'video/mp4', url: 'https://example.com/v1080.mp4' },
      ],
      audioStreams: [
        { bitrate: 128000, contentLength: 7000000, mimeType: 'audio/mp4', url: 'https://example.com/a.mp4' },
      ],
    },
    { preferCombined: true, resolution: '1080p' },
  );

  assert.equal(result.kind, 'adaptive');
  assert.equal(result.bytes, 187000000);
});

test('estimateYouTubeDownloadSize sums adaptive streams when combined is not selected', () => {
  const mod = loadModule();
  const result = mod.estimateYouTubeDownloadSize(
    {
      combined: [],
      videoStreams: [
        { height: 720, contentLength: 180000000, mimeType: 'video/mp4', url: 'https://example.com/v720.mp4' },
      ],
      audioStreams: [
        { bitrate: 128000, contentLength: 7000000, mimeType: 'audio/mp4', url: 'https://example.com/a.mp4' },
      ],
    },
    { preferCombined: true, resolution: '720p' },
  );

  assert.equal(result.kind, 'adaptive');
  assert.equal(result.bytes, 187000000);
});

test('buildYouTubeSelectionSnapshot includes selectedSize fields', () => {
  const mod = loadModule();
  const snapshot = mod.buildYouTubeSelectionSnapshot(
    {
      combined: [
        { height: 720, contentLength: 100000000, mimeType: 'video/mp4', url: 'https://example.com/720.mp4' },
      ],
      videoStreams: [],
      audioStreams: [],
    },
    { preferCombined: true, resolution: '720p' },
  );

  assert.equal(snapshot.selectedSizeKind, 'combined');
  assert.equal(snapshot.selectedSizeBytes, 100000000);
});

// ---------------------------------------------------------------
// listAvailableVideoQualities
// ---------------------------------------------------------------

test('listAvailableVideoQualities deduplicates by height', () => {
  const mod = loadModule();
  const result = mod.listAvailableVideoQualities({
    combined: [
      { height: 720, mimeType: 'video/mp4', url: 'https://example.com/c1.mp4' },
      { height: 720, mimeType: 'video/mp4', url: 'https://example.com/c2.mp4' },
    ],
    videoStreams: [],
    audioStreams: [],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].label, '720p');
});

test('listAvailableVideoQualities tracks hasAdaptive and hasCombined flags', () => {
  const mod = loadModule();
  const result = mod.listAvailableVideoQualities({
    combined: [
      { height: 720, mimeType: 'video/mp4', url: 'https://example.com/c.mp4' },
    ],
    videoStreams: [
      { height: 720, mimeType: 'video/mp4', url: 'https://example.com/v.mp4' },
      { height: 1080, mimeType: 'video/mp4', url: 'https://example.com/hd.mp4' },
    ],
    audioStreams: [],
  });

  // Sorted descending: 1080p first, then 720p
  assert.equal(result.length, 2);
  assert.equal(result[0].height, 1080);
  assert.equal(result[0].hasAdaptive, true);
  assert.equal(result[0].hasCombined, false);

  assert.equal(result[1].height, 720);
  assert.equal(result[1].hasAdaptive, true);
  assert.equal(result[1].hasCombined, true);
});

test('listAvailableVideoQualities tracks hasDirectUrl and hasSignatureCipherOnly flags', () => {
  const mod = loadModule();
  const result = mod.listAvailableVideoQualities({
    combined: [],
    videoStreams: [
      { height: 1080, mimeType: 'video/mp4', url: 'https://example.com/hd.mp4' },
      { height: 720, mimeType: 'video/mp4', signatureCipher: 's=abc' },
    ],
    audioStreams: [],
  });

  assert.equal(result[0].height, 1080);
  assert.equal(result[0].hasDirectUrl, true);
  assert.equal(result[0].hasSignatureCipherOnly, false);

  assert.equal(result[1].height, 720);
  assert.equal(result[1].hasDirectUrl, false);
  assert.equal(result[1].hasSignatureCipherOnly, true);
});

test('listAvailableVideoQualities returns empty for no streams', () => {
  const mod = loadModule();
  assert.deepEqual(mod.listAvailableVideoQualities(), []);
  assert.deepEqual(mod.listAvailableVideoQualities({}), []);
});

test('listAvailableVideoQualities skips streams with no url and no signatureCipher', () => {
  const mod = loadModule();
  const result = mod.listAvailableVideoQualities({
    combined: [{ height: 720, mimeType: 'video/mp4' }],
    videoStreams: [],
    audioStreams: [],
  });
  assert.equal(result.length, 0);
});

test('listAvailableVideoQualities sorts descending by height', () => {
  const mod = loadModule();
  const result = mod.listAvailableVideoQualities({
    combined: [
      { height: 360, mimeType: 'video/mp4', url: 'https://example.com/360.mp4' },
      { height: 720, mimeType: 'video/mp4', url: 'https://example.com/720.mp4' },
      { height: 1080, mimeType: 'video/mp4', url: 'https://example.com/1080.mp4' },
    ],
    videoStreams: [],
    audioStreams: [],
  });
  assert.deepEqual(result.map((q) => q.height), [1080, 720, 360]);
});
