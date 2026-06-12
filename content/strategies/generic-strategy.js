'use strict';

(() => {
  if (globalThis.__OVD_GENERIC_STRATEGY__) {
    return;
  }

  const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
  const MSG = messageTypes;

  function createGenericStrategy(options = {}) {
    const {
      getFloatButton = () => null,
      sendMessageAsync = () => Promise.reject(new Error('sendMessageAsync unavailable')),
    } = options;

    async function downloadViaBackground(video, buttonElement) {
      const response = await sendMessageAsync({
        payload: video,
        tabId: null,
        type: MSG.DOWNLOAD_VIDEO || 'DOWNLOAD_VIDEO',
      });

      if (response?.ok) {
        if (response.downloadId != null && buttonElement) {
          buttonElement.dataset.downloadId = response.downloadId;
        } else if (response.results?.length && buttonElement) {
          const firstId = response.results[0]?.downloadId;
          if (firstId != null) {
            buttonElement.dataset.downloadId = firstId;
          }
        }

        getFloatButton()?.showMessage('下载已开始');
        return response;
      }

      const rawMessage = response?.error || '未知错误';
      const friendlyMessage = rawMessage.includes('Receiving end does not exist')
        ? '当前页面下载脚本未就绪，请刷新页面后重试'
        : rawMessage;
      throw new Error(friendlyMessage);
    }

    return {
      download(meta, context) {
        return downloadViaBackground(meta, context.buttonElement);
      },
      downloadViaBackground,
      id: 'background-download',
      priority: 0,
    };
  }

  globalThis.__OVD_GENERIC_STRATEGY__ = {
    createGenericStrategy,
  };
})();
