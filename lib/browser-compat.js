// lib/browser-compat.js
// Browser compatibility layer for Chrome and Edge.
// Exposes globals so it can be loaded safely in classic content-script contexts.

'use strict';

(() => {
  function detectBrowser() {
    const ua = navigator?.userAgent || '';
    const isEdge = /Edg\//.test(ua) && !/Edge\//.test(ua);
    const isChrome = /Chrome\//.test(ua) && !isEdge;
    const isFirefox = /Firefox\//.test(ua);
    return {
      isChrome,
      isEdge,
      isFirefox,
      name: isEdge ? 'Edge' : isChrome ? 'Chrome' : isFirefox ? 'Firefox' : 'Unknown',
    };
  }

  // 多 frame 注入下，委托类消息按 frameId 定向发送，避免所有 frame 重复执行
  function resolveFrameOptions(message, options) {
    if (options && Number.isInteger(options.frameId)) return options;
    const frameId = message?.frameId ?? message?.meta?.frameId ?? message?.taskMeta?.frameId ?? message?.taskMeta?.videoInfo?.frameId;
    return Number.isInteger(frameId) ? { frameId } : undefined;
  }

  function safeTabMessage(tabId, message, callback, options) {
    return new Promise((resolve) => {
      try {
        const sendOptions = resolveFrameOptions(message, options);
        const args = sendOptions ? [tabId, message, sendOptions] : [tabId, message];
        chrome.tabs.sendMessage(...args, (response) => {
          if (chrome.runtime.lastError) {
            if (callback) callback(undefined);
            resolve(undefined);
            return;
          }

          if (callback) callback(response);
          resolve(response);
        });
      } catch {
        if (callback) callback(undefined);
        resolve(undefined);
      }
    });
  }

  function safeRuntimeMessage(message, callback) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            if (callback) callback(undefined);
            resolve(undefined);
            return;
          }

          if (callback) callback(response);
          resolve(response);
        });
      } catch {
        if (callback) callback(undefined);
        resolve(undefined);
      }
    });
  }

  function sendRuntimeMessageAsync(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function sendTabMessageAsync(tabId, message, options) {
    return new Promise((resolve, reject) => {
      try {
        const sendOptions = resolveFrameOptions(message, options);
        const args = sendOptions ? [tabId, message, sendOptions] : [tabId, message];
        chrome.tabs.sendMessage(...args, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function supportsDownloadResume() {
    const downloadsApi = globalThis.browser?.downloads || globalThis.chrome?.downloads;
    return typeof downloadsApi?.resume === 'function';
  }

  function resumeDownloadAsync(downloadId) {
    return new Promise((resolve, reject) => {
      const downloadsApi = globalThis.browser?.downloads || globalThis.chrome?.downloads;
      const runtimeApi = globalThis.chrome?.runtime || globalThis.browser?.runtime;

      if (typeof downloadsApi?.resume !== 'function') {
        reject(new Error('downloads.resume unavailable'));
        return;
      }

      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleReject = (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      try {
        if (downloadsApi.resume.length >= 2) {
          downloadsApi.resume.call(downloadsApi, downloadId, () => {
            const lastError = runtimeApi?.lastError;
            if (lastError) {
              settleReject(new Error(lastError.message));
              return;
            }
            settleResolve();
          });
          return;
        }

        const maybePromise = downloadsApi.resume.call(downloadsApi, downloadId);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(() => settleResolve()).catch((err) => settleReject(err));
          return;
        }

        settleResolve();
      } catch (err) {
        settleReject(err);
      }
    });
  }

  const browserInfo = detectBrowser();
  const compatApi = {
    browserInfo,
    detectBrowser,
    resumeDownloadAsync,
    safeRuntimeMessage,
    safeTabMessage,
    sendRuntimeMessageAsync,
    sendTabMessageAsync,
    supportsDownloadResume,
  };

  globalThis.__OVD_BROWSER__ = browserInfo;
  globalThis.__OVD_BROWSER_COMPAT__ = compatApi;
  globalThis.__OVD_safeTabMessage = safeTabMessage;
  globalThis.__OVD_safeRuntimeMessage = safeRuntimeMessage;
  globalThis.__OVD_resumeDownloadAsync = resumeDownloadAsync;
  globalThis.__OVD_sendRuntimeMessageAsync = sendRuntimeMessageAsync;
  globalThis.__OVD_sendTabMessageAsync = sendTabMessageAsync;
  globalThis.__OVD_supportsDownloadResume = supportsDownloadResume;
})();
