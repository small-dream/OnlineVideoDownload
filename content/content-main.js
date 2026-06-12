// content/content-main.js
// Content Script main entry.

(() => {
  if (globalThis.__OVD_CONTENT_MAIN_LOADED__) {
    return;
  }
  globalThis.__OVD_CONTENT_MAIN_LOADED__ = true;

  const constants = globalThis.__OVD_CONSTANTS__ || {};
  const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
  const pageContextSources = globalThis.__OVD_MESSAGE_TYPES__?.PAGE_CONTEXT_SOURCES || {};
  const MSG = messageTypes;
  const OBJECT_URL_REVOKE_DELAY = constants.OBJECT_URL_REVOKE_DELAY || 60000;

  async function injectPageScript() {
    try {
      const injectOne = (path) => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL(path);
        script.type = 'text/javascript';
        script.onload = () => {
          script.remove();
          resolve();
        };
        script.onerror = () => {
          script.remove();
          reject(new Error(`Failed to inject ${path}`));
        };
        (document.head || document.documentElement).appendChild(script);
      });

      const pageScripts = [
        'lib/message-types.js',
        'injected/page-core.js',
        'injected/page-http-utils.js',
        'injected/page-youtube-parser.js',
        'injected/page-bilibili-parser.js',
        'injected/page-interceptor.js',
        'injected/page-context-script.js',
      ];

      for (const path of pageScripts) {
        await injectOne(path);
      }

      console.log('[OVD] page context scripts injected');
    } catch (err) {
      console.error('[OVD] Failed to inject page scripts:', err);
    }
  }

  function emitRuntimeMessage(message) {
    __OVD_safeRuntimeMessage(message);
  }

  function sendMessageAsync(message) {
    return __OVD_sendRuntimeMessageAsync(message);
  }

  function postMessageToPage(payload) {
    window.postMessage({ from: pageContextSources.CONTENT_SCRIPT || 'OVD_CONTENT_SCRIPT', payload }, '*');
  }

  /**
   * 通过 service worker 下载 blob 数据，支持子目录设置。
   * 使用 chrome.downloads.download API（支持子目录路径），
   * 仅在 service worker 不可用时回退到 <a download> 方式。
   */
  function triggerBlobDownload(blob, filename, taskMeta = {}) {
    const objectUrl = URL.createObjectURL(blob);

    sendMessageAsync({
      filename: filename || 'video.ts',
      objectUrl,
      ...taskMeta,
      type: MSG.DOWNLOAD_BLOB_DATA || 'DOWNLOAD_BLOB_DATA',
    }).then((response) => {
      if (response?.ok) {
        // service worker 会通过 REVOKE_OBJECT_URL 消息清理 objectUrl
        return;
      }
      console.warn(`[OVD] SW blob download failed: ${response?.error || 'unknown'}, fallback to <a download>`);
      URL.revokeObjectURL(objectUrl);
      triggerBlobFallbackDownload(blob, filename);
    }).catch((err) => {
      console.warn(`[OVD] SW blob download error: ${err.message}, fallback to <a download>`);
      try { URL.revokeObjectURL(objectUrl); } catch (_) { /* ignore */ }
      triggerBlobFallbackDownload(blob, filename);
    });
  }

  /**
   * 备用下载方式：使用 <a download> 标签触发下载。
   * 不支持子目录，仅在 service worker 不可用时使用。
   */
  function triggerBlobFallbackDownload(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename || 'video.ts';
    link.style.display = 'none';
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (err) {
        console.warn(`[OVD] failed to revoke object URL after blob download: ${err.message}`);
      }
    }, OBJECT_URL_REVOKE_DELAY);
  }

  void injectPageScript();

  const videoUtils = globalThis.__OVD_VIDEO_UTILS__ || {};
  const sourceUtils = globalThis.__OVD_VIDEO_SOURCE_UTILS__ || {};
  const sourceHandlers = globalThis.__OVD_SOURCE_HANDLERS__ || {};
  const wbiSigner = globalThis.__OVD_WBI_SIGNER__ || {};
  const hlsPipeline = globalThis.__OVD_HLS_PIPELINE__ || {};
  const youtubeModeStore = globalThis.__OVD_YOUTUBE_DOWNLOAD_MODE_STORE__ || {};
  const blobStrategyFactory = globalThis.__OVD_BLOB_STRATEGY__ || {};
  const youtubeCaptureStrategyFactory = globalThis.__OVD_YOUTUBE_CAPTURE_STRATEGY__ || {};
  const youtubeParseStrategyFactory = globalThis.__OVD_YOUTUBE_PARSE_DOWNLOAD_STRATEGY__ || {};
  const bilibiliStrategyFactory = globalThis.__OVD_BILIBILI_STRATEGY__ || {};
  const hlsStrategyFactory = globalThis.__OVD_HLS_STRATEGY__ || {};
  const genericStrategyFactory = globalThis.__OVD_GENERIC_STRATEGY__ || {};
  const dashStrategyFactory = globalThis.__OVD_DASH_STRATEGY__ || {};
  const mpdParser = globalThis.__OVD_MPD_PARSER__ || {};
  const streamTransferManagerFactory = globalThis.__OVD_STREAM_TRANSFER_MANAGER__ || {};
  const downloadCoordinatorFactory = globalThis.__OVD_DOWNLOAD_COORDINATOR__ || {};
  const messageRouterFactory = globalThis.__OVD_MESSAGE_ROUTER__ || {};
  const progressReporterFactory = globalThis.__OVD_PROGRESS_REPORTER__ || {};

  globalThis.__OVD_MUXER_LOG__ = (level, message) => {
    try {
      emitRuntimeMessage({
        level: level || 'log',
        message: String(message || ''),
        type: MSG.BILIBILI_MUXER_LOG || 'BILIBILI_MUXER_LOG',
      });
    } catch (err) {
      console.warn(`[OVD] failed to forward muxer log to background: ${err.message}`);
    }
  };

  let downloadCoordinator = null;

  Promise.resolve(youtubeModeStore.init?.()).catch((err) => {
    console.warn('[OVD] Failed to initialize YouTube mode store:', err);
  });

  const getFloatButton = () => null;
  const streamTransferManager = streamTransferManagerFactory.createStreamTransferManager({
    postMessageToPage,
    sendMessageAsync,
    triggerBlobDownload,
    videoUtils,
  });

  const blobStrategy = blobStrategyFactory.createBlobStrategy({
    getFloatButton,
    triggerBlobDownload,
  });
  const youtubeCaptureStrategy = youtubeCaptureStrategyFactory.createYouTubeCaptureStrategy({
    getFloatButton,
    sendMessageAsync,
    triggerBlobDownload,
    videoUtils,
  });
  const youtubeParseStrategy = youtubeParseStrategyFactory.createYouTubeParseDownloadStrategy({
    createPageDirectDownloadTransfer: streamTransferManager.createPageDirectDownloadTransfer,
    fetchYouTubeMediaStreamsInPage: streamTransferManager.fetchYouTubeMediaStreamsInPage,
    getFloatButton,
    sendMessageAsync,
    triggerBlobDownload,
    videoUtils,
  });
  const bilibiliStrategy = bilibiliStrategyFactory.createBilibiliStrategy({
    calcWrid: wbiSigner.calcWrid,
    fetchMediaStreamsAndWait: streamTransferManager.fetchMediaStreamsAndWait,
    getFloatButton,
    sendMessageAsync,
    triggerBlobDownload,
    videoUtils,
  });
  const genericStrategy = genericStrategyFactory.createGenericStrategy({
    getFloatButton,
    sendMessageAsync,
  });
  const dashStrategy = dashStrategyFactory.createDashStrategy({
    getFloatButton,
    hlsPipeline,
    sendMessageAsync,
    triggerBlobDownload,
    videoUtils,
    mpdParser,
  });
  const hlsDelegateHandler = hlsStrategyFactory.createHlsDelegateHandler({
    emitRuntimeMessage,
    getFloatButton,
    hlsPipeline,
    triggerBlobDownload,
  });

  const sourceRegistry = sourceHandlers.createDefaultSourceRegistry?.({
    strategies: {
      bilibili: [bilibiliStrategy],
      blob: [blobStrategy],
      dash: [dashStrategy],
      generic: [genericStrategy],
      youtube: [youtubeParseStrategy, youtubeCaptureStrategy],
    },
  }) || null;

  downloadCoordinator = downloadCoordinatorFactory.createDownloadCoordinator({
    actions: {
      downloadViaBackground: (videoInfo, buttonElement) => genericStrategy.downloadViaBackground(videoInfo, buttonElement),
    },
    emitRuntimeMessage,
    getFloatButton,
    progressReporterFactory,
    sourceRegistry,
    sourceUtils,
  });

  const messageRouter = messageRouterFactory.createMessageRouter({
    bilibiliStrategy,
    blobStrategy,
    ensureUi: () => {},
    getFloatButton,
    hlsDelegateHandler,
    startSourceDownload: (meta) => downloadCoordinator.startSourceDownload(meta),
    streamTransferManager,
  });

  messageRouter.start();
})();
