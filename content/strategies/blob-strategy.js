'use strict';

(() => {
  if (globalThis.__OVD_BLOB_STRATEGY__) {
    return;
  }

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
        getFloatButton()?.showMessage('Blob 视频下载已开始');
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
