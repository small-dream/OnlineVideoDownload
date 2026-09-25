'use strict';

(() => {
  if (globalThis.__OVD_GENERIC_STRATEGY__) {
    return;
  }

  const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
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

        getFloatButton()?.showMessage(t('download_started_short', '下载已开始'));
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
