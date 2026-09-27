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

const utils = () => loadModule('__OVD_SUBTITLE_UTILS__', path.resolve(__dirname, '../lib/subtitle-utils.js'));

// --- 时间戳 ---

test('formatSrtTimestamp 补零到毫秒且不丢进位', () => {
  const { formatSrtTimestamp } = utils();
  assert.equal(formatSrtTimestamp(0), '00:00:00,000');
  assert.equal(formatSrtTimestamp(1.5), '00:00:01,500');
  assert.equal(formatSrtTimestamp(3723.456), '01:02:03,456');
  assert.equal(formatSrtTimestamp(59.9995), '00:01:00,000');
  assert.equal(formatSrtTimestamp(-5), '00:00:00,000');
});

test('parseTimestampToSeconds 支持 SRT / VTT / 秒数三种写法', () => {
  const { parseTimestampToSeconds } = utils();
  assert.equal(parseTimestampToSeconds('01:02:03,500'), 3723.5);
  assert.equal(parseTimestampToSeconds('00:00:02.250'), 2.25);
  assert.equal(parseTimestampToSeconds('02:03.5'), 123.5);
  assert.equal(parseTimestampToSeconds('12.5'), 12.5);
  assert.ok(Number.isNaN(parseTimestampToSeconds('')));
  assert.ok(Number.isNaN(parseTimestampToSeconds('abc')));
});

// --- 文本清洗 ---

test('stripCaptionMarkup 去除标签、解码实体、保留换行', () => {
  const { stripCaptionMarkup } = utils();
  assert.equal(stripCaptionMarkup('<c.color>a</c> &amp; b'), 'a & b');
  assert.equal(stripCaptionMarkup('line1<br>line2'), 'line1\nline2');
  assert.equal(stripCaptionMarkup('<00:00:01.000><v Fred>Hi'), 'Hi');
  assert.equal(stripCaptionMarkup('   '), '');
  assert.equal(stripCaptionMarkup('&amp;lt;'), '&lt;');
});

test('normalizeCues 丢弃空文本并按开始时间排序', () => {
  const { normalizeCues } = utils();
  const cues = normalizeCues([
    { end: 6, start: 5, text: 'second' },
    { end: 2, start: 1, text: '  ' },
    { end: 1, start: 0, text: 'first' },
    { start: 7, text: 'no-end' },
  ]);
  assert.deepEqual(cues.map((cue) => cue.text), ['first', 'second', 'no-end']);
  assert.equal(cues[2].end, 9);
});

test('cuesToSrt 输出序号块并保持块间空行', () => {
  const { cuesToSrt } = utils();
  const srt = cuesToSrt([{ end: 1, start: 0, text: 'hello' }, { end: 2, start: 1, text: 'world' }]);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,000\nhello\n\n2\n00:00:01,000 --> 00:00:02,000\nworld\n');
});

// --- YouTube ---

test('parseYouTubeJson3Captions 解析事件、用下一条起点补结束时间', () => {
  const { parseYouTubeJson3Captions } = utils();
  const cues = parseYouTubeJson3Captions({
    events: [
      { dDurationMs: 1500, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }], tStartMs: 0 },
      { segs: [{ utf8: 'no duration' }], tStartMs: 1500 },
      { dDurationMs: 500, segs: [], tStartMs: 3000 },
    ],
  });
  assert.deepEqual(cues, [
    { end: 1.5, start: 0, text: 'Hello world' },
    { end: 3, start: 1.5, text: 'no duration' },
  ]);
});

test('parseYouTubeJson3Captions 接受 JSON 字符串并容忍空输入', () => {
  const { parseYouTubeJson3Captions } = utils();
  assert.deepEqual(parseYouTubeJson3Captions('{"events":[]}'), []);
  assert.deepEqual(parseYouTubeJson3Captions('not json'), []);
  assert.deepEqual(parseYouTubeJson3Captions(null), []);
});

test('parseYouTubeXmlCaptions 支持 srv3 与 srv1 两种标签', () => {
  const { parseYouTubeXmlCaptions } = utils();
  const srv3 = '<timedtext><body><p t="1000" d="2000"><s>你好</s></p><p t="3000" d="1000"><s>世界</s></p></body></timedtext>';
  assert.deepEqual(parseYouTubeXmlCaptions(srv3), [
    { end: 3, start: 1, text: '你好' },
    { end: 4, start: 3, text: '世界' },
  ]);

  const srv1 = '<transcript><text start="1.5" dur="2.5">one</text><text start="4">two</text></transcript>';
  assert.deepEqual(parseYouTubeXmlCaptions(srv1), [
    { end: 4, start: 1.5, text: 'one' },
    { end: 6, start: 4, text: 'two' },
  ]);
});

test('youTubeCaptionUrlWithFormat 替换 fmt 且不重新编码签名参数', () => {
  const { youTubeCaptionUrlWithFormat } = utils();
  assert.equal(
    youTubeCaptionUrlWithFormat('https://www.youtube.com/api/timedtext?v=1&fmt=srv1&signature=ab,cd&x=1', 'json3'),
    'https://www.youtube.com/api/timedtext?v=1&signature=ab,cd&x=1&fmt=json3'
  );
  assert.equal(
    youTubeCaptionUrlWithFormat('https://www.youtube.com/api/timedtext?v=1', 'vtt'),
    'https://www.youtube.com/api/timedtext?v=1&fmt=vtt'
  );
  assert.equal(youTubeCaptionUrlWithFormat('', 'json3'), '');
});

test('isYouTubeCaptionUrl 只认 timedtext 字幕接口', () => {
  const { isYouTubeCaptionUrl } = utils();
  assert.equal(isYouTubeCaptionUrl('https://www.youtube.com/api/timedtext?v=1'), true);
  assert.equal(isYouTubeCaptionUrl('https://m.youtube.com/api/timedtext?v=1'), true);
  assert.equal(isYouTubeCaptionUrl('https://www.youtube.com/watch?v=1'), false);
  assert.equal(isYouTubeCaptionUrl('https://evil-youtube.com/api/timedtext'), false);
  assert.equal(isYouTubeCaptionUrl(''), false);
});

test('buildSubtitleFetchAttempts：YouTube 按 fmt 回退，其它来源单次请求', () => {
  const { buildSubtitleFetchAttempts } = utils();

  const youtube = buildSubtitleFetchAttempts('https://www.youtube.com/api/timedtext?v=1&fmt=srv1', 'json3');
  assert.equal(youtube.length, 3);
  assert.equal(youtube[0].format, 'json3');
  assert.ok(youtube[0].url.endsWith('&fmt=json3'));
  assert.equal(youtube[0].credentials, 'include');
  assert.ok(youtube.some((attempt) => attempt.format === 'vtt' && attempt.contentType === 'text/vtt'));
  assert.ok(youtube.some((attempt) => attempt.format === 'srv3'));

  assert.deepEqual(
    buildSubtitleFetchAttempts('https://aisubtitle.hdslb.com/bfs/subtitle/x.json', ''),
    [{ credentials: 'omit', format: 'auto', url: 'https://aisubtitle.hdslb.com/bfs/subtitle/x.json' }]
  );
});

// --- Bilibili ---

test('parseBilibiliSubtitleJson 解析 body 数组', () => {
  const { parseBilibiliSubtitleJson } = utils();
  const cues = parseBilibiliSubtitleJson({
    body: [
      { content: 'abc', from: 0, to: 1.5 },
      { content: 'def', from: 1.6, to: 3 },
    ],
  });
  assert.deepEqual(cues, [
    { end: 1.5, start: 0, text: 'abc' },
    { end: 3, start: 1.6, text: 'def' },
  ]);
  assert.deepEqual(parseBilibiliSubtitleJson({}), []);
});

// --- WebVTT / SRT ---

test('parseVttSubtitles 跳过头部与 NOTE、保留多行文本与 cue 设置', () => {
  const { parseVttSubtitles } = utils();
  const vtt = [
    'WEBVTT',
    'Kind: captions',
    'Language: en',
    '',
    'NOTE 这是注释',
    '',
    '1',
    '00:00:01.000 --> 00:00:03.000 align:start position:0%',
    '<v Fred>Hello',
    'World',
    '',
    '00:04.500 --> 00:06.000',
    'Second',
    '',
  ].join('\n');
  assert.deepEqual(parseVttSubtitles(vtt), [
    { end: 3, start: 1, text: 'Hello\nWorld' },
    { end: 6, start: 4.5, text: 'Second' },
  ]);
});

test('parseSrtSubtitles 解析带序号/无序号块', () => {
  const { parseSrtSubtitles } = utils();
  const srt = '1\n00:00:00,000 --> 00:00:01,000\nhello\n\n00:00:01,000 --> 00:00:02,000\nworld\n';
  assert.deepEqual(parseSrtSubtitles(srt), [
    { end: 1, start: 0, text: 'hello' },
    { end: 2, start: 1, text: 'world' },
  ]);
});

// --- 统一入口 ---

test('detectSubtitleFormat 识别 vtt / json3 / bilibili / srv3 / srt', () => {
  const { detectSubtitleFormat } = utils();
  assert.equal(detectSubtitleFormat('WEBVTT\n'), 'vtt');
  assert.equal(detectSubtitleFormat('{"events":[]}'), 'json3');
  assert.equal(detectSubtitleFormat('{"body":[]}'), 'bilibili');
  assert.equal(detectSubtitleFormat('<timedtext>'), 'srv3');
  assert.equal(detectSubtitleFormat('1\n00:00:01,000 --> 00:00:02,000\nx\n'), 'srt');
});

test('parseSubtitleText 按指定 format 或自动识别解析', () => {
  const { parseSubtitleText } = utils();
  assert.deepEqual(
    parseSubtitleText('{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"hi"}]}]}'),
    [{ end: 1, start: 0, text: 'hi' }]
  );
  assert.deepEqual(
    parseSubtitleText('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n'),
    [{ end: 1, start: 0, text: 'hi' }]
  );
  assert.deepEqual(parseSubtitleText('<body><p t="0" d="1000">hi</p></body>', { format: 'auto' }), [
    { end: 1, start: 0, text: 'hi' },
  ]);
  assert.deepEqual(parseSubtitleText('whatever', { format: 'unknown' }), []);
});

// --- 轨道列表 ---

test('normalizeSubtitleTracks 兼容 YouTube 与 Bilibili 形状并去重', () => {
  const { normalizeSubtitleTracks } = utils();
  const tracks = normalizeSubtitleTracks([
    { baseUrl: 'u1', kind: 'asr', languageCode: 'zh-Hans', name: { simpleText: '中文（简体）' } },
    { ai_status: 1, base_url: 'u2', lan: 'en', lan_doc: 'English' },
    { baseUrl: 'u1', kind: 'asr', languageCode: 'zh-Hans' },
    { languageCode: 'no-url' },
  ]);
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks[0], {
    id: 'zh-Hans|asr',
    isAsr: true,
    languageCode: 'zh-Hans',
    languageName: '中文（简体）',
    url: 'u1',
  });
  assert.equal(tracks[1].isAsr, true);
  assert.equal(tracks[1].languageName, 'English');
});

test('normalizeSubtitleTracks 兼容 name.runs 与字符串 name', () => {
  const { normalizeSubtitleTracks } = utils();
  const [withRuns] = normalizeSubtitleTracks([
    { baseUrl: 'u', languageCode: 'ja', name: { runs: [{ text: '日' }, { text: '本語' }] } },
  ]);
  assert.equal(withRuns.languageName, '日本語');
  const [withLabel] = normalizeSubtitleTracks([{ label: 'Deutsch', languageCode: 'de', url: 'x' }]);
  assert.equal(withLabel.languageName, 'Deutsch');
  assert.equal(withLabel.isAsr, false);
});

test('selectSubtitleTrack 优先命中偏好语言', () => {
  const { selectSubtitleTrack } = utils();
  const tracks = [
    { baseUrl: 'u-en', languageCode: 'en' },
    { baseUrl: 'u-zh', languageCode: 'zh-Hans' },
  ];
  assert.equal(selectSubtitleTrack(tracks, 'zh').url, 'u-zh');
  assert.equal(selectSubtitleTrack(tracks, 'en-US').url, 'u-en');
  assert.equal(selectSubtitleTrack(tracks, 'ja').url, 'u-zh');
});

test('selectSubtitleTrack 无偏好时偏向人工中文/英文，其次任意人工', () => {
  const { selectSubtitleTrack } = utils();
  assert.equal(
    selectSubtitleTrack([
      { baseUrl: 'u-fr', kind: 'asr', languageCode: 'fr' },
      { baseUrl: 'u-zh', languageCode: 'zh-CN' },
    ]).url,
    'u-zh'
  );
  assert.equal(
    selectSubtitleTrack([
      { baseUrl: 'u-fr', kind: 'asr', languageCode: 'fr' },
      { baseUrl: 'u-de', languageCode: 'de' },
    ]).url,
    'u-de'
  );
  assert.equal(selectSubtitleTrack([], 'zh'), null);
});

// --- 文件名 / MIME ---

test('buildSubtitleFilename 生成侧车文件名并清洗非法字符', () => {
  const { buildSubtitleFilename } = utils();
  assert.equal(buildSubtitleFilename('My/Video: 1', { languageCode: 'zh-Hans' }), 'My_Video_ 1.zh-Hans.srt');
  assert.equal(buildSubtitleFilename('T', { isAsr: true, languageCode: 'en' }), 'T.en.auto.srt');
  assert.equal(buildSubtitleFilename('', { languageCode: '' }), 'subtitle.und.srt');
  assert.equal(buildSubtitleFilename('T', { languageCode: 'en' }, 'vtt'), 'T.en.vtt');
});

test('subtitleMimeTypeForExtension 覆盖 srt/vtt/未知', () => {
  const { subtitleMimeTypeForExtension } = utils();
  assert.equal(subtitleMimeTypeForExtension('.srt'), 'application/x-subrip');
  assert.equal(subtitleMimeTypeForExtension('vtt'), 'text/vtt');
  assert.equal(subtitleMimeTypeForExtension('.ass'), 'text/x-ssa');
  assert.equal(subtitleMimeTypeForExtension('.nope'), 'application/octet-stream');
});
