'use strict';

(() => {
  if (window.__OVD_PAGE_CORE__) {
    return;
  }

  const messageRuntime = globalThis.__OVD_MESSAGE_TYPES__ || {};
  const messageTypes = messageRuntime.MESSAGE_TYPES || {};
  const pageContextSources = messageRuntime.PAGE_CONTEXT_SOURCES || {};
  const validateMessage = messageRuntime.validateMessage || (() => ({ ok: true }));

  const MSG = messageTypes;
  const MSG_FROM = pageContextSources.PAGE_SCRIPT || 'OVD_PAGE_SCRIPT';
  const MSG_FROM_CONTENT = pageContextSources.CONTENT_SCRIPT || 'OVD_CONTENT_SCRIPT';
  const PAGE_FETCH_RETRY_DELAYS = [0, 1000, 2500, 5000];
  const YOUTUBE_PARALLEL_MIN_BYTES = 16 * 1024 * 1024;
  const YOUTUBE_PARALLEL_AUDIO_MIN_BYTES = 1 * 1024 * 1024;
  const YOUTUBE_PARALLEL_AUDIO_CHUNK_BYTES = 1 * 1024 * 1024;
  const YOUTUBE_PARALLEL_CHUNK_BYTES = 8 * 1024 * 1024;
  const YOUTUBE_PARALLEL_MAX_CONCURRENCY = 4;

  const messageHandlers = new Map();
  const resetters = new Set();

  function sendToExtension(payload) {
    if (
      payload?.type === (MSG.YOUTUBE_MEDIA_STREAM_CHUNK || 'YOUTUBE_MEDIA_STREAM_CHUNK') ||
      payload?.type === (MSG.YOUTUBE_MEDIA_STREAM_PROGRESS || 'YOUTUBE_MEDIA_STREAM_PROGRESS')
    ) {
      window.postMessage({ from: MSG_FROM, payload }, '*');
      return;
    }

    console.log('[OVD][PAGE] sendToExtension', {
      type: payload?.type || '',
      title: payload?.title || '',
      url: typeof payload?.url === 'string'
        ? (payload.url.length > 120 ? `${payload.url.substring(0, 120)}...` : payload.url)
        : payload?.url,
    });
    window.postMessage({ from: MSG_FROM, payload }, '*');
  }

  function registerMessageHandler(type, handler) {
    if (!type || typeof handler !== 'function') {
      return;
    }
    messageHandlers.set(type, handler);
  }

  function registerResetter(resetter) {
    if (typeof resetter !== 'function') {
      return;
    }
    resetters.add(resetter);
  }

  function resetForUrlChange() {
    for (const resetter of resetters) {
      try {
        resetter();
      } catch (error) {
        console.warn('[OVD][PAGE] resetter failed:', error);
      }
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) {
      return;
    }
    if (event.data?.from !== MSG_FROM_CONTENT) {
      return;
    }

    const payload = event.data?.payload;
    const validation = validateMessage(payload);
    if (!validation.ok) {
      console.warn(`[OVD][PAGE] ignored invalid content message: ${validation.error}`);
      return;
    }

    const handler = payload?.type ? messageHandlers.get(payload.type) : null;
    if (!handler) {
      return;
    }

    Promise.resolve(handler(payload)).catch((error) => {
      console.error('[OVD][PAGE] content message handler failed:', {
        error: error?.message || String(error),
        type: payload?.type || '',
      });
    });
  });

  window.__OVD_PAGE_CORE__ = {
    MSG,
    MSG_FROM,
    MSG_FROM_CONTENT,
    PAGE_FETCH_RETRY_DELAYS,
    YOUTUBE_PARALLEL_AUDIO_CHUNK_BYTES,
    YOUTUBE_PARALLEL_AUDIO_MIN_BYTES,
    YOUTUBE_PARALLEL_MIN_BYTES,
    YOUTUBE_PARALLEL_CHUNK_BYTES,
    YOUTUBE_PARALLEL_MAX_CONCURRENCY,
    registerMessageHandler,
    registerResetter,
    resetForUrlChange,
    sendToExtension,
  };
})();
