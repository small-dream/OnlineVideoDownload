'use strict';

(() => {
  if (globalThis.__OVD_BLOB_STRATEGY__) {
    return;
  }

  // 国际化：优先 chrome.i18n（见 lib/i18n.js）；未加载时本地退回中文原文，
  // 并同样处理 $1..$9 占位符，避免出现裸露的占位符。
  const i18n = globalThis.__OVD_I18N__ || {};
  const t = typeof i18n.t === 'function'
    ? i18n.t
    : (_key, fallback, subs) => {
      if (!fallback || !subs) {
        return fallback;
      }
      const list = Array.isArray(subs) ? subs : [subs];
      return String(fallback).replace(/\$(\d)/g, (match, index) => {
        const value = list[Number(index) - 1];
        return value == null ? match : String(value);
      });
    };
  function createBlobStrategy(options = {}) {
    const {
      getFloatButton = () => null,
      triggerBlobDownload = () => {},
    } = options;

    async function handleBlobFetch(blobUrl, filename, taskMeta = {}) {
      try {
        const response = await fetch(blobUrl);
        const blob = await response.blob();

        const mimeToExt = {
          'video/flv': '.flv',
          'video/mp2t': '.ts',
          'video/mp4': '.mp4',
          'video/webm': '.webm',
          'video/x-flv': '.flv',
        };

        const ext = mimeToExt[blob.type] || '.mp4';
        const finalFilename = (filename || 'video').replace(/\.[^.]+$/, '') + ext;
        triggerBlobDownload(blob, finalFilename, taskMeta);
        getFloatButton()?.showMessage(t('blob_started', 'Blob 视频下载已开始'));
        return { downloadId: null, ok: true };
      } catch (err) {
        throw new Error(`Blob 下载失败: ${err.message}`);
      }
    }

    return {
      download(meta) {
        return handleBlobFetch(meta?.url, meta?.title || 'video', {
          sourceId: 'blob',
          title: meta?.title || '',
          videoInfo: meta || null,
          videoUrl: meta?.url || '',
        });
      },
      handleFetch: handleBlobFetch,
      id: 'blob-fetch',
      priority: 100,
    };
  }

  globalThis.__OVD_BLOB_STRATEGY__ = {
    createBlobStrategy,
  };
})();
