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

    /**
     * MSE 播放流的 blob: 地址由 MediaSource 创建，本身没有文件数据（fetch 必失败），
     * 页面侧已在上报时用 `mse: true` 标记（见 injected/page-interceptor.js）。
     * 这里提前报错，避免先 fetch 一次再抛浏览器原生的 `net::ERR_FILE_NOT_FOUND`。
     */
    function isMseBlob(taskMeta = {}) {
      return taskMeta?.mse === true || taskMeta?.videoInfo?.mse === true;
    }

    async function handleBlobFetch(blobUrl, filename, taskMeta = {}) {
      if (isMseBlob(taskMeta)) {
        const error = new Error(t(
          'blob_mseUnsupported',
          '该条目的 blob 地址属于 MSE 流式播放（没有文件数据），无法直接保存；请改用同页的 HLS / DASH 条目下载。'
        ));
        error.code = 'BLOB_MSE_UNSUPPORTED';
        throw error;
      }

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
        // blob 地址只在其创建它的文档里有效，播放器重建/切流会 revoke；
        // 也可能是本扩展没赶上的 MSE 地址，两种都只能明确告诉用户原因。
        const error = new Error(t(
          'blob_unreadable',
          'Blob 下载失败: $1（该 blob 地址可能已被页面回收，或属于 MSE 流式播放，无法直接读取）',
          [err.message]
        ));
        error.code = 'BLOB_UNREADABLE';
        throw error;
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
