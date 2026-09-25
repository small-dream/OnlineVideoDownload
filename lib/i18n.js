// lib/i18n.js
// 轻量国际化封装：优先 chrome.i18n（_locales），缺失时退回调用方给出的中文原文。
// 设计要点：调用方必须传 fallback（中文原文），因此任何 key 漏配都退化为
// 改动前的行为，不会在界面里露出 'popup.xxx' 这类原始 key。
// 以 <script> 方式加载，暴露全局 __OVD_I18N__。

'use strict';

(() => {
  if (globalThis.__OVD_I18N__) {
    return;
  }

  function runtime() {
    try {
      return typeof chrome !== 'undefined' ? chrome : null;
    } catch (_err) {
      return null;
    }
  }

  /** 与 chrome.i18n 相同的 $1..$9 占位符，用于 fallback 路径（否则缺 key 时占位符会裸露） */
  function substitute(text, subs) {
    if (!text || subs == null) {
      return text;
    }
    const list = Array.isArray(subs) ? subs : [subs];
    return String(text).replace(/\$(\d)/g, (match, index) => {
      const value = list[Number(index) - 1];
      return value == null ? match : String(value);
    });
  }

  /**
   * @param {string} key - _locales 中的消息名
   * @param {string} [fallback] - 缺失时的中文原文
   * @param {string[]} [subs] - chrome.i18n 占位符（$1、$2…）
   */
  function t(key, fallback = '', subs = undefined) {
    if (!key) {
      return fallback;
    }

    try {
      const message = runtime()?.i18n?.getMessage?.(key, subs);
      if (message) {
        return message;
      }
    } catch (_err) {
      // 忽略：退回中文原文
    }

    return substitute(fallback, subs);
  }

  /**
   * 按 data-i18n / data-i18n-title / data-i18n-placeholder 就地替换文本。
   * 属性值存的是 key；未配置翻译时保留元素原有中文，不做任何破坏性清空。
   */
  function applyI18n(root = typeof document !== 'undefined' ? document : null) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return 0;
    }

    let applied = 0;

    for (const element of root.querySelectorAll('[data-i18n]')) {
      const key = element.dataset?.i18n;
      const next = t(key, element.textContent || '');
      if (next && next !== element.textContent) {
        element.textContent = next;
      }
      applied += 1;
    }

    for (const element of root.querySelectorAll('[data-i18n-title]')) {
      const key = element.dataset?.i18nTitle;
      const next = t(key, element.getAttribute('title') || '');
      if (next) {
        element.setAttribute('title', next);
      }
      applied += 1;
    }

    for (const element of root.querySelectorAll('[data-i18n-placeholder]')) {
      const key = element.dataset?.i18nPlaceholder;
      const next = t(key, element.getAttribute('placeholder') || '');
      if (next) {
        element.setAttribute('placeholder', next);
      }
      applied += 1;
    }

    return applied;
  }

  globalThis.__OVD_I18N__ = {
    applyI18n,
    t,
  };
})();
