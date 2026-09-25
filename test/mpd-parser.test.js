'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

// lib/mpd-parser.js 内置了无 DOMParser 环境的回退 XML 解析器，
// 因此这些用例在 Node 下会真实执行（不再 skip）。
const HAS_DOM_PARSER = true;

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

// ---------------------------------------------------------------
// 第三波 3.4：MPD 解析补全
// ---------------------------------------------------------------

test('formatSegmentTemplate supports $Number%05d$ width formatting', () => {
  const mod = loadModule();
  const result = mod.formatSegmentTemplate('seg-$RepresentationID$-$Number%05d$.m4s', {
    Number: 42,
    RepresentationID: 'v1',
  });
  assert.equal(result, 'seg-v1-00042.m4s');
});

test('formatSegmentTemplate supports $Time%08d$ and leaves unknown variables intact', () => {
  const mod = loadModule();
  assert.equal(
    mod.formatSegmentTemplate('t-$Time%08d$.m4s', { Time: 1234 }),
    't-00001234.m4s'
  );
  assert.equal(
    mod.formatSegmentTemplate('x-$Unknown$.m4s', {}),
    'x-$Unknown$.m4s'
  );
});

test('parseMpdManifest resolves $Number%05d$ templates into real URLs', () => {
  const mod = loadModule();
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT20S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate media="chunk-$Number%05d$.m4s" initialization="init-$RepresentationID$.mp4"
                       startNumber="1" duration="10" timescale="1"/>
      <Representation id="v1" width="1920" height="1080" bandwidth="4000000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  const result = mod.parseMpdManifest(xml, 'https://cdn.example.com/');
  const rep = result.adaptations[0].representations[0];
  assert.deepEqual(rep.segments.map((segment) => segment.url), [
    'https://cdn.example.com/chunk-00001.m4s',
    'https://cdn.example.com/chunk-00002.m4s',
  ]);
  assert.equal(rep.initialization, 'https://cdn.example.com/init-v1.mp4');
  assert.ok(!rep.segments.some((segment) => segment.url.includes('$')), 'URL 中不得残留模板符');
});

test('parseSegmentTimeline expands r="-1" until the period ends', () => {
  const mod = loadModule();
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT30S">
  <Period duration="PT30S">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate media="seg-$Number$.m4s" timescale="1" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="10" r="-1"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v1" width="1280" height="720" bandwidth="2000000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  const result = mod.parseMpdManifest(xml, 'https://cdn.example.com/');
  const rep = result.adaptations[0].representations[0];
  assert.equal(rep.segments.length, 3);
  assert.equal(rep.segments[2].url, 'https://cdn.example.com/seg-3.m4s');
  assert.equal(rep.segments[2].time, 20);
});

test('parseMpdManifest keeps SegmentURL mediaRange and indexRange', () => {
  const mod = loadModule();
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT20S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1" width="1280" height="720" bandwidth="2000000">
        <SegmentList duration="10" timescale="1">
          <Initialization sourceURL="video.mp4" range="0-999"/>
          <SegmentURL media="video.mp4" mediaRange="1000-1999" indexRange="2000-2999"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  const result = mod.parseMpdManifest(xml, 'https://cdn.example.com/');
  const rep = result.adaptations[0].representations[0];
  assert.deepEqual(rep.initializationRange, { end: 999, length: 1000, start: 0 });
  assert.deepEqual(rep.segments[0].byteRange, { end: 1999, length: 1000, start: 1000 });
  assert.deepEqual(rep.segments[0].indexRange, { end: 2999, length: 1000, start: 2000 });
  assert.equal(mod.toRangeHeader(rep.segments[0].byteRange), 'bytes=1000-1999');
});

test('parseMpdManifest uses the open-ended media range for SegmentBase', () => {
  const mod = loadModule();
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1" width="1280" height="720" bandwidth="2000000">
        <SegmentBase indexRange="0-799">
          <Initialization range="800-1599"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  const result = mod.parseMpdManifest(xml, 'https://cdn.example.com/video.mp4');
  const rep = result.adaptations[0].representations[0];
  assert.deepEqual(rep.initializationRange, { end: 1599, length: 800, start: 800 });
  assert.deepEqual(rep.segments[0].byteRange, { end: null, length: null, start: 800 });
  assert.deepEqual(rep.segments[0].indexRange, { end: 799, length: 800, start: 0 });
  assert.equal(mod.toRangeHeader(rep.segments[0].byteRange), 'bytes=800-');
});

test('parseMpdManifest groups multiple periods and exposes period metadata', () => {
  const mod = loadModule();
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT20S">
  <Period id="p0" start="PT0S" duration="PT10S">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate media="p0-$Number$.m4s" initialization="p0-init.mp4" duration="5" timescale="1"/>
      <Representation id="v1" width="1280" height="720" bandwidth="2000000"/>
    </AdaptationSet>
  </Period>
  <Period id="p1" start="PT10S" duration="PT10S">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate media="p1-$Number$.m4s" initialization="p1-init.mp4" duration="5" timescale="1"/>
      <Representation id="v2" width="1920" height="1080" bandwidth="5000000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  const result = mod.parseMpdManifest(xml, 'https://cdn.example.com/');
  assert.equal(result.isMultiPeriod, true);
  assert.equal(result.periods.length, 2);
  assert.deepEqual(result.periods.map((period) => period.id), ['p0', 'p1']);
  assert.deepEqual(result.periods.map((period) => period.start), [0, 10]);
  assert.deepEqual(result.adaptations.map((item) => item.periodIndex), [0, 1]);
  assert.equal(result.adaptations[0].representations[0].segments.length, 2);
  assert.equal(result.adaptations[1].representations[0].segments.length, 2);

  const collected = mod.collectRepresentationsAcrossPeriods(result, 'video');
  assert.equal(collected.representations.length, 2);
  assert.equal(collected.hasMultipleInitializations, true);
  assert.deepEqual(
    collected.representations.map((rep) => rep.id),
    ['v1', 'v2']
  );
});

test('parseMpdManifest reports no cross-period initialization conflict for single-period manifests', () => {
  const mod = loadModule();
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate media="seg-$Number$.m4s" initialization="init.mp4" duration="5" timescale="1"/>
      <Representation id="v1" width="1280" height="720" bandwidth="2000000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  const result = mod.parseMpdManifest(xml, 'https://cdn.example.com/');
  assert.equal(result.isMultiPeriod, false);
  const collected = mod.collectRepresentationsAcrossPeriods(result, 'video');
  assert.equal(collected.hasMultipleInitializations, false);
  assert.equal(collected.representations.length, 1);
});
