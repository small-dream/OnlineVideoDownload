'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const MODULE_PATH = path.resolve(__dirname, '../lib/youtube-innertube-clients.js');

function loadModule() {
  const key = '__OVD_YT_INNERTUBE_CLIENTS__';
  delete globalThis[key];
  delete require.cache[require.resolve(MODULE_PATH)];
  require(MODULE_PATH);
  return globalThis[key];
}

test('优先客户端是不要求 pot 的类型（TVHTML5 / WEB_EMBEDDED_PLAYER）', () => {
  const mod = loadModule();
  const preferred = mod.getPreferredClient();

  assert.equal(preferred.key, 'tv');
  assert.equal(preferred.clientName, 'TVHTML5');
  assert.equal(preferred.requiresPot, false);

  const potFree = mod.CLIENTS.filter((client) => !client.requiresPot).map((client) => client.key);
  assert.deepEqual(potFree, ['tv', 'web_embedded']);

  // 列表顺序 = 尝试顺序：不要求 pot 的排前面
  assert.deepEqual(mod.CLIENTS.map((client) => client.key), ['tv', 'web_embedded', 'ios', 'android']);
});

test('客户端配置带齐 Innertube 需要的字段（版本号不能是过期的旧值）', () => {
  const mod = loadModule();

  for (const client of mod.CLIENTS) {
    assert.ok(client.clientName, `${client.key} 缺 clientName`);
    assert.ok(client.clientNameHeader, `${client.key} 缺 clientNameHeader`);
    assert.match(client.clientVersion, /^\d+\.\d+/, `${client.key} 版本号格式异常`);
    assert.equal(typeof client.requiresPot, 'boolean');
    // 版本号必须比此前写死的 1.60.19 / 19.09.37 新（否则 Innertube 会回 400）
    assert.notEqual(client.clientVersion, '1.60.19');
    assert.notEqual(client.clientVersion, '19.09.37');
  }

  assert.equal(mod.getClientByKey('tv').clientNameHeader, '7');
  assert.equal(mod.getClientByKey('web_embedded').clientNameHeader, '56');
  assert.equal(mod.getClientByKey('ios').clientNameHeader, '5');
  assert.equal(mod.getClientByKey('android').clientNameHeader, '3');
  assert.equal(mod.getClientByKey('nope'), null);
});

test('buildPlayerRequestBody 生成 context/playbackContext/videoId，并透传设备字段', () => {
  const mod = loadModule();
  const ios = mod.getClientByKey('ios');
  const body = mod.buildPlayerRequestBody(ios, 'VIDEO123', { gl: 'US', hl: 'zh-CN' });

  assert.equal(body.videoId, 'VIDEO123');
  assert.equal(body.context.client.clientName, 'IOS');
  assert.equal(body.context.client.clientVersion, ios.clientVersion);
  assert.equal(body.context.client.deviceModel, 'iPhone16,2');
  assert.equal(body.context.client.gl, 'US');
  assert.equal(body.playbackContext.contentPlaybackContext.html5Preference, 'HTML5_PREF_WANTS');
  assert.equal(body.contentCheckOk, true);
  assert.equal(body.racyCheckOk, true);

  // TV 客户端没有设备字段时不应凭空生成
  const tvBody = mod.buildPlayerRequestBody(mod.getClientByKey('tv'), 'VIDEO123');
  assert.equal('deviceModel' in tvBody.context.client, false);
  assert.equal('osName' in tvBody.context.client, false);
});

test('buildPlayerRequestBody 对缺参数返回 null', () => {
  const mod = loadModule();
  assert.equal(mod.buildPlayerRequestBody(null, 'VIDEO123'), null);
  assert.equal(mod.buildPlayerRequestBody(mod.getClientByKey('tv'), ''), null);
});

test('buildPlayerRequestHeaders 带上客户端标识与可选 visitor id', () => {
  const mod = loadModule();
  const tv = mod.getClientByKey('tv');

  assert.deepEqual(mod.buildPlayerRequestHeaders(tv), {
    'content-type': 'application/json',
    'x-youtube-client-name': '7',
    'x-youtube-client-version': tv.clientVersion,
  });

  assert.equal(
    mod.buildPlayerRequestHeaders(tv, 'visitor-1')['x-goog-visitor-id'],
    'visitor-1'
  );
});

test('countStreamingFormats 统计 formats + adaptiveFormats', () => {
  const mod = loadModule();

  assert.equal(mod.countStreamingFormats(null), 0);
  assert.equal(mod.countStreamingFormats({}), 0);
  assert.equal(mod.countStreamingFormats({ streamingData: {} }), 0);
  assert.equal(
    mod.countStreamingFormats({
      streamingData: { adaptiveFormats: [1, 2, 3], formats: [1] },
    }),
    4
  );
});

test('pickBestClientResult 按"可直接下载的最高分辨率"选，而不是第一个成功', () => {
  const mod = loadModule();

  const picked = mod.pickBestClientResult([
    // 先成功的客户端只有 360p progressive（现场问题：清晰度列表只剩 360p）
    { clientKey: 'tv', directAudioCount: 1, directVideoCount: 0, maxDirectHeight: 360, requiresPot: false },
    { clientKey: 'android', directAudioCount: 8, directVideoCount: 12, maxDirectHeight: 1080, requiresPot: true },
    { clientKey: 'ios', directAudioCount: 6, directVideoCount: 9, maxDirectHeight: 720, requiresPot: true },
  ]);

  assert.equal(picked.clientKey, 'android');
  assert.equal(picked.maxDirectHeight, 1080);
});

test('pickBestClientResult 同分时不要求 pot 的优先，且空输入安全', () => {
  const mod = loadModule();

  const sameQuality = [
    { clientKey: 'android', directAudioCount: 4, directVideoCount: 6, maxDirectHeight: 1080, requiresPot: true },
    { clientKey: 'tv', directAudioCount: 4, directVideoCount: 6, maxDirectHeight: 1080, requiresPot: false },
  ];
  assert.equal(mod.pickBestClientResult(sameQuality).clientKey, 'tv');
  assert.equal(mod.pickBestClientResult([]), null);
  assert.equal(mod.pickBestClientResult(null), null);
});

test('scorePlayerClientResult 分辨率权重高于条数', () => {
  const mod = loadModule();

  const lowButMany = { directAudioCount: 50, directVideoCount: 50, maxDirectHeight: 360 };
  const highButFew = { directAudioCount: 1, directVideoCount: 1, maxDirectHeight: 720 };
  assert.ok(mod.scorePlayerClientResult(highButFew) > mod.scorePlayerClientResult(lowButMany));
});
