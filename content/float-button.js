// content/float-button.js
// 页面内长任务浮动反馈条：右下角小浮动条，显示 icon + 文本 + 可选进度。
// showMessage(text, isError, durationMs) 短暂显示后自动消失（默认 4 秒，0 表示常驻）；
// showProgress(percent) 显示进度，100 后短暂停留再消失；同一时间最多一条。

'use strict';

(() => {
  if (globalThis.__OVD_FLOAT_BUTTON__) {
    return;
  }

  const DEFAULT_MESSAGE_DURATION_MS = 4000;
  const PROGRESS_DONE_HIDE_DELAY_MS = 1500;
  const STYLE_ELEMENT_ID = 'ovd-float-button-style';
  const CSS_TEXT = [
    '.ovd-float-button{position:fixed;right:16px;bottom:16px;z-index:2147483000;',
    'display:flex;align-items:center;gap:8px;max-width:320px;',
    'padding:8px 12px;border-radius:8px;background:#1f2329;color:#e8eaed;',
    'font:13px/1.4 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;',
    'box-shadow:0 2px 10px rgba(0,0,0,.4);pointer-events:auto;}',
    '.ovd-float-button[hidden]{display:none;}',
    '.ovd-float-button-icon{width:16px;height:16px;flex:none;}',
    '.ovd-float-button-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.ovd-float-button.ovd-float-error .ovd-float-button-text{color:#ff6b6b;}',
    '.ovd-float-button-progress{display:flex;align-items:center;gap:8px;width:160px;height:8px;',
    'border-radius:4px;background:#3a3f45;overflow:hidden;position:relative;}',
    '.ovd-float-button-progress[hidden]{display:none;}',
    '.ovd-float-button-progress-bar{height:100%;width:0;background:#0d8fd3;transition:width .2s ease;}',
    '.ovd-float-button-progress-text{position:absolute;right:6px;font-size:10px;color:#e8eaed;}',
  ].join('');

  function clampPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return 0;
    }
    return numeric >= 100 ? 100 : Math.round(numeric);
  }

  function resolveMessageDuration(durationMs) {
    const numeric = Number(durationMs);
    return Number.isFinite(numeric) && numeric >= 0
      ? numeric
      : DEFAULT_MESSAGE_DURATION_MS;
  }

  function createFloatButton(options = {}) {
    const rootDocument = options.document || globalThis.document;
    if (!rootDocument?.createElement) {
      return null;
    }

    const iconUrl = options.iconUrl || '';
    let container = null;
    let iconElement = null;
    let messageElement = null;
    let progressWrap = null;
    let progressBar = null;
    let progressText = null;
    let hideTimer = null;

    function injectStyles() {
      if (rootDocument.getElementById?.(STYLE_ELEMENT_ID)) {
        return;
      }
      const styleElement = rootDocument.createElement('style');
      styleElement.id = STYLE_ELEMENT_ID;
      styleElement.textContent = CSS_TEXT;
      (rootDocument.head || rootDocument.documentElement)?.appendChild?.(styleElement);
    }

    function build() {
      injectStyles();

      container = rootDocument.createElement('div');
      container.className = 'ovd-float-button';
      container.setAttribute('role', 'status');
      container.hidden = true;

      iconElement = rootDocument.createElement('img');
      iconElement.className = 'ovd-float-button-icon';
      iconElement.setAttribute('alt', '');
      if (iconUrl) {
        iconElement.src = iconUrl;
      }

      messageElement = rootDocument.createElement('span');
      messageElement.className = 'ovd-float-button-text';

      progressWrap = rootDocument.createElement('div');
      progressWrap.className = 'ovd-float-button-progress';
      progressWrap.hidden = true;

      progressBar = rootDocument.createElement('div');
      progressBar.className = 'ovd-float-button-progress-bar';

      progressText = rootDocument.createElement('span');
      progressText.className = 'ovd-float-button-progress-text';

      progressWrap.appendChild(progressBar);
      progressWrap.appendChild(progressText);
      container.appendChild(iconElement);
      container.appendChild(messageElement);
      container.appendChild(progressWrap);
      (rootDocument.body || rootDocument.documentElement).appendChild(container);
    }

    function ensureMounted() {
      if (!container) {
        build();
      }
    }

    function clearHideTimer() {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    }

    function hide() {
      clearHideTimer();
      if (container) {
        container.hidden = true;
      }
    }

    function show() {
      container.hidden = false;
    }

    function showMessage(text, isError = false, durationMs = DEFAULT_MESSAGE_DURATION_MS) {
      ensureMounted();
      clearHideTimer();

      container.className = isError ? 'ovd-float-button ovd-float-error' : 'ovd-float-button';
      messageElement.textContent = String(text || '');
      progressWrap.hidden = true;
      show();

      const duration = resolveMessageDuration(durationMs);
      if (duration > 0) {
        hideTimer = setTimeout(hide, duration);
      }
    }

    function showProgress(percent) {
      ensureMounted();
      clearHideTimer();

      const safePercent = clampPercent(percent);
      container.className = 'ovd-float-button';
      messageElement.textContent = `视频下载中... ${safePercent}%`;
      progressWrap.hidden = false;
      progressBar.style.width = `${safePercent}%`;
      progressText.textContent = `${safePercent}%`;
      show();

      if (safePercent >= 100) {
        hideTimer = setTimeout(hide, PROGRESS_DONE_HIDE_DELAY_MS);
      }
    }

    return {
      hide,
      mount: ensureMounted,
      showMessage,
      showProgress,
    };
  }

  globalThis.__OVD_FLOAT_BUTTON__ = {
    clampPercent,
    createFloatButton,
    resolveMessageDuration,
  };
})();
