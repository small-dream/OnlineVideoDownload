'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '../background/subtitle-downloader.js');

// 保存成功后会挂一个"延迟撤销 object URL"的定时器（真实值 60s），
// 不缩短会把测试进程拖到一分钟；constants 模块有 guard，预置即可生效。
globalThis.__OVD_CONSTANTS__ = { OBJECT_URL_REVOKE_DELAY: 1 };

let importCounter = 0;

async function loadModule() {
  globalThis.chrome = globalThis.chrome || {};
  importCounter += 1;
  return import(`${pathToFileURL(MODULE_PATH).href}?test=${importCounter}`);
}

function textResponse(body, { contentType = 'text/plain', status = 200 } = {}) {
  return {
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function withFetchStub(handler, run) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push({ credentials: undefined, url: String(url) });
    return handler(String(url));
  };
  return run(calls).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test('fetchSubtitleCues：YouTube 首个 fmt 被拒时回退到下一种格式', async () => {
  const { fetchSubtitleCues } = await loadModule();
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello\n';

  await withFetchStub(
    (url) => (url.includes('fmt=json3') ? textResponse('', { status: 403 }) : textResponse(vtt, { contentType: 'text/vtt' })),
    async (calls) => {
      const result = await fetchSubtitleCues({ url: 'https://www.youtube.com/api/timedtext?v=abc' });
      assert.equal(result.format, 'vtt');
      assert.deepEqual(result.cues, [{ end: 2, start: 0, text: 'Hello' }]);
      assert.equal(calls.length, 2);
      assert.ok(calls[0].url.endsWith('&fmt=json3'));
      assert.ok(calls[1].url.endsWith('&fmt=vtt'));
    }
  );
});

test('fetchSubtitleCues：响应 200 但没有内容时继续尝试下一种格式', async () => {
  const { fetchSubtitleCues } = await loadModule();
  const srv3 = '<timedtext><body><p t="500" d="1500"><s>你好</s></p></body></timedtext>';

  await withFetchStub(
    (url) => {
      if (url.includes('fmt=json3')) return textResponse('{"events":[]}');
      if (url.includes('fmt=vtt')) return textResponse('WEBVTT\n');
      return textResponse(srv3, { contentType: 'application/xml' });
    },
    async (calls) => {
      const result = await fetchSubtitleCues({ url: 'https://www.youtube.com/api/timedtext?v=abc' });
      assert.equal(result.format, 'srv3');
      assert.deepEqual(result.cues, [{ end: 2, start: 0.5, text: '你好' }]);
      assert.equal(calls.length, 3);
    }
  );
});

test('fetchSubtitleCues：非 YouTube 地址单次请求并自动识别 Bilibili JSON', async () => {
  const { fetchSubtitleCues } = await loadModule();
  const body = JSON.stringify({ body: [{ content: 'abc', from: 0, to: 1.5 }] });

  await withFetchStub(() => textResponse(body, { contentType: 'application/json' }), async (calls) => {
    const result = await fetchSubtitleCues({ url: 'https://aisubtitle.hdslb.com/bfs/subtitle/x.json' });
    assert.equal(result.format, 'auto');
    assert.deepEqual(result.cues, [{ end: 1.5, start: 0, text: 'abc' }]);
    assert.equal(calls.length, 1);
  });
});

test('fetchSubtitleCues：全部尝试失败时抛出错误，空地址先拦下', async () => {
  const { fetchSubtitleCues } = await loadModule();

  await assert.rejects(() => fetchSubtitleCues({ url: '   ' }), /字幕地址为空/);
  await withFetchStub(() => textResponse('nope', { status: 404 }), async () => {
    await assert.rejects(
      () => fetchSubtitleCues({ url: 'https://aisubtitle.hdslb.com/bfs/subtitle/x.json' }),
      /HTTP 404/
    );
  });
});

// ---------------------------------------------------------------
// downloadSubtitle：转 SRT + 侧车命名 + 交给浏览器下载
// ---------------------------------------------------------------

function installChromeStub() {
  const downloads = [];
  const transfers = new Map();
  globalThis.chrome = {
    downloads: {
      download(options, callback) {
        downloads.push(options);
        callback(downloads.length);
      },
      onChanged: { addListener() {} },
    },
    offscreen: {
      createDocument: async () => {},
      hasDocument: async () => true,
    },
    runtime: {
      getContexts: async () => [{ contextTypes: ['OFFSCREEN_DOCUMENT'] }],
      getURL: (resource) => `chrome-extension://ovd-test/${resource}`,
      lastError: null,
      sendMessage(message, callback) {
        if (message?.type === 'OFFSCREEN_BLOB_DOWNLOAD_START') {
          transfers.set(message.transferId, { chunks: [], filename: message.filename });
        }
        if (message?.type === 'OFFSCREEN_BLOB_DOWNLOAD_CHUNK') {
          transfers.get(message.transferId)?.chunks.push(message.chunkBase64);
        }
        let response = { ok: true };
        if (message?.type === 'OFFSCREEN_BLOB_DOWNLOAD_FINISH') {
          const transfer = transfers.get(message.transferId) || { chunks: [], filename: '' };
          response = { filename: transfer.filename, objectUrl: 'blob:ovd-test', ok: true };
        }
        if (callback) callback(response);
        return undefined;
      },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} },
    },
  };

  return {
    decode(transferId) {
      const transfer = transfers.get(transferId);
      return Buffer.from((transfer?.chunks || []).join(''), 'base64').toString('utf8');
    },
    downloads,
    listTransfers: () => [...transfers.entries()],
  };
}

test('downloadSubtitle 把字幕转成 SRT 并保存为「标题.语言.srt」侧车文件', async () => {
  const { downloadSubtitle } = await loadModule();
  const stub = installChromeStub();
  const body = JSON.stringify({
    body: [
      { content: '第一句', from: 0, to: 1.5 },
      { content: '第二句', from: 1.6, to: 3 },
    ],
  });

  await withFetchStub(() => textResponse(body), async () => {
    const result = await downloadSubtitle(
      { isAsr: false, languageCode: 'zh-Hans', languageName: '简体中文', url: 'https://aisubtitle.hdslb.com/bfs/subtitle/x.json' },
      { sourceId: 'bilibili', title: 'My Video: Part 1', videoUrl: 'https://www.bilibili.com/video/BV1' }
    );

    assert.equal(result.ok, true);
    // 返回/提交的文件名会带上用户设置的下载子目录（download-path.js），只校验文件名本身
    assert.ok(result.filename.endsWith('/My Video_ Part 1.zh-Hans.srt'));
    assert.equal(result.cues, 2);
  });

  // 提交给下载管理器的文件名与 MIME 正确，落盘内容就是 SRT
  assert.equal(stub.downloads.length, 1);
  assert.ok(stub.downloads[0].filename.endsWith('/My Video_ Part 1.zh-Hans.srt'));
  assert.equal(stub.downloads[0].url, 'blob:ovd-test');

  const transferId = stub.listTransfers()[0][0];
  assert.equal(
    stub.decode(transferId),
    '1\n00:00:00,000 --> 00:00:01,500\n第一句\n\n2\n00:00:01,600 --> 00:00:03,000\n第二句\n'
  );
});

test('downloadSubtitle 自动字幕在文件名里标注 auto', async () => {
  const { downloadSubtitle } = await loadModule();
  const stub = installChromeStub();
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n';

  await withFetchStub(() => textResponse(vtt, { contentType: 'text/vtt' }), async () => {
    const result = await downloadSubtitle(
      { isAsr: true, languageCode: 'en', url: 'https://cdn.example.com/subs/en.vtt' },
      { sourceId: 'generic', title: 'Demo' }
    );
    assert.ok(result.filename.endsWith('/Demo.en.auto.srt'));
  });

  assert.ok(stub.downloads[0].filename.endsWith('/Demo.en.auto.srt'));
});

test('downloadSubtitle 保存失败时抛出可读错误', async () => {
  const { downloadSubtitle } = await loadModule();
  installChromeStub();
  globalThis.chrome.downloads.download = (options, callback) => {
    globalThis.chrome.runtime.lastError = { message: 'disk full' };
    callback(undefined);
    globalThis.chrome.runtime.lastError = null;
  };

  await withFetchStub(
    () => textResponse('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n', { contentType: 'text/vtt' }),
    async () => {
      await assert.rejects(
        () => downloadSubtitle({ languageCode: 'en', url: 'https://cdn.example.com/subs/en.vtt' }, { title: 'Demo' }),
        /disk full/
      );
    }
  );
});
