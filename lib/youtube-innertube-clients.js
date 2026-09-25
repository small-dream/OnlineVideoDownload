'use strict';

// YouTube 直链能不能下载，取决于**用哪个客户端**取到的 streamingData：
//
// - web / mweb / ios / android 客户端的地址带 GVS PO Token（`pot`）要求，
//   且 web 客户端返回的 `n` 参数还需要播放器 JS 做 nsig 转换。
//   我们拿到的是"半成品"地址：从 SW / 页面 / 下载管理器去请求都会被 googlevideo
//   回 403 SERVER_FORBIDDEN（现场日志里 SW、页面上下文、chrome.downloads 三条路全 403）。
// - TVHTML5 与 WEB_EMBEDDED_PLAYER 客户端在 yt-dlp 的 INNERTUBE_CLIENTS 里**没有**
//   GVS_PO_TOKEN_POLICY（即不要求 pot），它们返回的地址可以直接下载 —— 这也是其他
//   下载扩展能在同一浏览器里顺利下载的原因。
//
// 这里放一份与 yt-dlp 对齐的客户端配置 + 播放接口请求构造（纯函数，便于单测），
// 由页面侧 injected/page-youtube-parser.js 用来取"可直接下载"的流。

(() => {
  if (globalThis.__OVD_YT_INNERTUBE_CLIENTS__) {
    return;
  }

  /**
   * 顺序即优先级：先试不要求 pot 的客户端。
   * 版本号取自 yt-dlp INNERTUBE_CLIENTS（2026-09）；太旧会被 Innertube 直接回 400，
   * 这也是此前 ANDROID_VR 1.60.19 / ANDROID 19.09.37 一直失败的原因之一。
   */
  const CLIENTS = Object.freeze([
    Object.freeze({
      key: 'tv',
      clientName: 'TVHTML5',
      clientNameHeader: '7',
      clientVersion: '7.20260707.07.00',
      label: 'TV',
      requiresPot: false,
    }),
    Object.freeze({
      key: 'web_embedded',
      clientName: 'WEB_EMBEDDED_PLAYER',
      clientNameHeader: '56',
      clientVersion: '2.20260708.00.00',
      label: 'Web 嵌入播放器',
      requiresPot: false,
    }),
    Object.freeze({
      key: 'ios',
      clientName: 'IOS',
      clientNameHeader: '5',
      clientVersion: '21.26.4',
      label: 'iOS',
      requiresPot: true,
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
    }),
    Object.freeze({
      key: 'android',
      clientName: 'ANDROID',
      clientNameHeader: '3',
      clientVersion: '21.26.364',
      label: 'Android',
      requiresPot: true,
      androidSdkVersion: 30,
      osName: 'Android',
      osVersion: '11',
    }),
  ]);

  const CONTEXT_FIELDS = Object.freeze([
    'androidSdkVersion',
    'deviceMake',
    'deviceModel',
    'osName',
    'osVersion',
  ]);

  function getClientByKey(key) {
    return CLIENTS.find((client) => client.key === key) || null;
  }

  /** 列表里第一个"不要求 pot"的客户端（没有则回退到第一个） */
  function getPreferredClient() {
    return CLIENTS.find((client) => !client.requiresPot) || CLIENTS[0] || null;
  }

  function buildClientContext(client, { gl = 'US', hl = 'zh-CN' } = {}) {
    if (!client?.clientName || !client?.clientVersion) {
      return null;
    }

    const context = {
      clientName: client.clientName,
      clientVersion: client.clientVersion,
      gl,
      hl,
    };
    for (const field of CONTEXT_FIELDS) {
      if (client[field] != null) {
        context[field] = client[field];
      }
    }
    return context;
  }

  /** Innertube /youtubei/v1/player 请求体 */
  function buildPlayerRequestBody(client, videoId, options = {}) {
    const clientContext = buildClientContext(client, options);
    if (!clientContext || !videoId) {
      return null;
    }

    return {
      context: {
        client: clientContext,
        request: { useSsl: true },
        user: { lockedSafetyMode: false },
      },
      contentCheckOk: true,
      playbackContext: {
        contentPlaybackContext: {
          html5Preference: 'HTML5_PREF_WANTS',
        },
      },
      racyCheckOk: true,
      videoId,
    };
  }

  /** Innertube /youtubei/v1/player 请求头（Origin/User-Agent 由浏览器决定，不能在此设置） */
  function buildPlayerRequestHeaders(client, visitorData = '') {
    const headers = {
      'content-type': 'application/json',
    };
    if (visitorData) {
      headers['x-goog-visitor-id'] = visitorData;
    }
    if (client?.clientNameHeader) {
      headers['x-youtube-client-name'] = String(client.clientNameHeader);
    }
    if (client?.clientVersion) {
      headers['x-youtube-client-version'] = String(client.clientVersion);
    }
    return headers;
  }

  /** 从 player 响应里数出可用的流数量（用于判断这次客户端调用是否有意义） */
  function countStreamingFormats(playerResponse) {
    const streamingData = playerResponse?.streamingData;
    if (!streamingData) {
      return 0;
    }
    const formats = Array.isArray(streamingData.formats) ? streamingData.formats.length : 0;
    const adaptive = Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats.length : 0;
    return formats + adaptive;
  }

  /**
   * 客户端结果打分：只看**可直接下载**（带 url）的部分，分辨率优先，其次条数。
   * 同一客户端可能只返回 360p 的 progressive，另一个客户端却能给 1080p 自适应流，
   * 所以要比较后再选，而不是"第一个成功就用"。
   */
  function scorePlayerClientResult(result = {}) {
    return (
      (Number(result.maxDirectHeight) || 0) * 1000
      + (Number(result.directVideoCount) || 0) * 10
      + (Number(result.directAudioCount) || 0)
    );
  }

  /**
   * 从多个客户端结果里挑最好的一个；同分时不要求 pot 的优先，其次保持列表顺序（越靠前越优先）。
   * @param {Array<{clientKey: string, requiresPot?: boolean, maxDirectHeight?: number, directVideoCount?: number, directAudioCount?: number}>} results
   */
  function pickBestClientResult(results = []) {
    const list = Array.isArray(results) ? results.filter(Boolean) : [];
    let best = null;

    for (const candidate of list) {
      if (!best) {
        best = candidate;
        continue;
      }

      const diff = scorePlayerClientResult(candidate) - scorePlayerClientResult(best);
      if (diff > 0) {
        best = candidate;
        continue;
      }
      if (diff < 0) {
        continue;
      }

      // 同分：不要求 pot 的更可靠（不受 GVS PO Token 策略影响）
      if (best.requiresPot && !candidate.requiresPot) {
        best = candidate;
      }
    }

    return best;
  }

  globalThis.__OVD_YT_INNERTUBE_CLIENTS__ = Object.freeze({
    CLIENTS,
    buildClientContext,
    buildPlayerRequestBody,
    buildPlayerRequestHeaders,
    countStreamingFormats,
    getClientByKey,
    getPreferredClient,
    pickBestClientResult,
    scorePlayerClientResult,
  });
})();
