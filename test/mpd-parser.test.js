'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const HAS_DOM_PARSER = typeof DOMParser !== 'undefined';

function loadModule() {
  const key = '__OVD_MPD_PARSER__';
  const filePath = path.resolve(__dirname, '../lib/mpd-parser.js');
  delete globalThis[key];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[key];
}

// ---------------------------------------------------------------
// resolveSegmentUrl
// ---------------------------------------------------------------

test('resolveSegmentUrl passes through absolute URL', () => {
  const mod = loadModule();
  const result = mod.resolveSegmentUrl('https://cdn.example.com/base/', 'https://cdn.example.com/video/seg1.m4s');
  assert.equal(result, 'https://cdn.example.com/video/seg1.m4s');
});

test('resolveSegmentUrl resolves relative URL against base', () => {
  const mod = loadModule();
  const result = mod.resolveSegmentUrl('https://cdn.example.com/base/', 'seg1.m4s');
  assert.equal(result, 'https://cdn.example.com/base/seg1.m4s');
});

test('resolveSegmentUrl resolves relative path against non-trailing-slash base', () => {
  const mod = loadModule();
  const result = mod.resolveSegmentUrl('https://cdn.example.com/base', 'seg1.m4s');
  // URL constructor replaces last path segment with relative path
  assert.equal(result, 'https://cdn.example.com/seg1.m4s');
});

test('resolveSegmentUrl returns baseUrl when segmentPath is empty', () => {
  const mod = loadModule();
  const result = mod.resolveSegmentUrl('https://cdn.example.com/base/', '');
  assert.equal(result, 'https://cdn.example.com/base/');
});

test('resolveSegmentUrl returns empty string when both are null/empty', () => {
  const mod = loadModule();
  assert.equal(mod.resolveSegmentUrl(null, ''), '');
  assert.equal(mod.resolveSegmentUrl('', ''), '');
});

// ---------------------------------------------------------------
// selectBestVideoRepresentation
// ---------------------------------------------------------------

test('selectBestVideoRepresentation picks highest width*height', () => {
  const mod = loadModule();
  const adaptation = {
    representations: [
      { id: '1', width: 1280, height: 720, bandwidth: 2000000 },
      { id: '2', width: 1920, height: 1080, bandwidth: 4000000 },
      { id: '3', width: 854, height: 480, bandwidth: 1000000 },
    ],
  };
  const result = mod.selectBestVideoRepresentation(adaptation);
  assert.equal(result.id, '2');
});

test('selectBestVideoRepresentation tie-breaks by bandwidth', () => {
  const mod = loadModule();
  const adaptation = {
    representations: [
      { id: 'low', width: 1920, height: 1080, bandwidth: 3000000 },
      { id: 'high', width: 1920, height: 1080, bandwidth: 5000000 },
    ],
  };
  const result = mod.selectBestVideoRepresentation(adaptation);
  assert.equal(result.id, 'high');
});

test('selectBestVideoRepresentation returns null for empty representations', () => {
  const mod = loadModule();
  assert.equal(mod.selectBestVideoRepresentation({ representations: [] }), null);
});

test('selectBestVideoRepresentation returns null for null representations', () => {
  const mod = loadModule();
  assert.equal(mod.selectBestVideoRepresentation({ representations: null }), null);
});

// ---------------------------------------------------------------
// selectBestAudioRepresentation
// ---------------------------------------------------------------

test('selectBestAudioRepresentation picks highest bandwidth', () => {
  const mod = loadModule();
  const adaptation = {
    representations: [
      { id: 'a1', bandwidth: 64000 },
      { id: 'a2', bandwidth: 128000 },
      { id: 'a3', bandwidth: 96000 },
    ],
  };
  const result = mod.selectBestAudioRepresentation(adaptation);
  assert.equal(result.id, 'a2');
});

test('selectBestAudioRepresentation returns null for empty representations', () => {
  const mod = loadModule();
  assert.equal(mod.selectBestAudioRepresentation({ representations: [] }), null);
});

// ---------------------------------------------------------------
// parseMpdManifest (only if DOMParser available)
// ---------------------------------------------------------------

test('parseMpdManifest extracts duration and adaptations from valid MPD', { skip: !HAS_DOM_PARSER }, () => {
  const mod = loadModule();
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT1M30.5S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="1" width="1920" height="1080" bandwidth="4000000" codecs="avc1.640028"/>
      <Representation id="2" width="1280" height="720" bandwidth="2000000" codecs="avc1.64001f"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  const result = mod.parseMpdManifest(xml, 'https://cdn.example.com/');
  assert.equal(result.duration, 90.5);
  assert.equal(result.adaptations.length, 2);

  const videoAdaptation = result.adaptations.find((a) => a.contentType === 'video');
  assert.ok(videoAdaptation);
  assert.equal(videoAdaptation.representations.length, 2);

  const audioAdaptation = result.adaptations.find((a) => a.contentType === 'audio');
  assert.ok(audioAdaptation);
  assert.equal(audioAdaptation.representations.length, 1);
});

test('parseMpdManifest handles SegmentTemplate with $Number$ substitution', { skip: !HAS_DOM_PARSER }, () => {
  const mod = loadModule();
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT30S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate media="seg_$RepresentationID$_$Number$.m4s" initialization="init_$RepresentationID$.m4s"
                       startNumber="1" duration="10" timescale="1"/>
      <Representation id="v1" width="1920" height="1080" bandwidth="4000000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  const result = mod.parseMpdManifest(xml, 'https://cdn.example.com/');
  const rep = result.adaptations[0].representations[0];
  assert.ok(rep.initialization.includes('init_v1.m4s'));
  assert.equal(rep.segments.length, 3); // 30s / 10s = 3 segments
  assert.ok(rep.segments[0].url.includes('seg_v1_1.m4s'));
  assert.ok(rep.segments[1].url.includes('seg_v1_2.m4s'));
  assert.ok(rep.segments[2].url.includes('seg_v1_3.m4s'));
});

test('parseMpdManifest handles SegmentList with segment URLs', { skip: !HAS_DOM_PARSER }, () => {
  const mod = loadModule();
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT20S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1" width="1280" height="720" bandwidth="2000000">
        <SegmentList duration="10" timescale="1">
          <Initialization sourceURL="init.mp4"/>
          <SegmentURL media="seg1.m4s"/>
          <SegmentURL media="seg2.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  const result = mod.parseMpdManifest(xml, 'https://cdn.example.com/');
  const rep = result.adaptations[0].representations[0];
  assert.ok(rep.initialization.includes('init.mp4'));
  assert.equal(rep.segments.length, 2);
  assert.ok(rep.segments[0].url.includes('seg1.m4s'));
  assert.ok(rep.segments[1].url.includes('seg2.m4s'));
});

test('parseMpdManifest handles BaseURL-only representation', { skip: !HAS_DOM_PARSER }, () => {
  const mod = loadModule();
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1" width="1920" height="1080" bandwidth="5000000">
        <BaseURL>https://cdn.example.com/video.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  const result = mod.parseMpdManifest(xml, 'https://cdn.example.com/');
  const rep = result.adaptations[0].representations[0];
  assert.equal(rep.segments.length, 1);
  assert.equal(rep.segments[0].url, 'https://cdn.example.com/video.mp4');
});

test('parseMpdManifest throws on invalid XML', { skip: !HAS_DOM_PARSER }, () => {
  const mod = loadModule();
  assert.throws(() => mod.parseMpdManifest('<not valid xml<<<', 'https://cdn.example.com/'), {
    message: 'MPD XML parse error',
  });
});

test('parseMpdManifest throws when MPD element is missing', { skip: !HAS_DOM_PARSER }, () => {
  const mod = loadModule();
  assert.throws(() => mod.parseMpdManifest('<root><child/></root>', 'https://cdn.example.com/'), {
    message: 'No MPD element found',
  });
});

test('parseMpdManifest skipped when DOMParser unavailable', { skip: HAS_DOM_PARSER }, () => {
  // This test only runs when DOMParser is NOT available
  assert.ok(true, 'DOMParser not available; parseMpdManifest tests skipped');
});
