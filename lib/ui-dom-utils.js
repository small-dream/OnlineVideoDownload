'use strict';

(() => {
  if (globalThis.__OVD_UI_DOM_UTILS__) {
    return;
  }

  const elementTimers = new WeakMap();

  function clearElementTimer(element) {
    if (!element) {
      return;
    }

    const timerId = elementTimers.get(element);
    if (timerId) {
      clearTimeout(timerId);
      elementTimers.delete(element);
    }
  }

  function scheduleElementTimer(element, callback, delayMs) {
    if (!element || !(delayMs > 0)) {
      return null;
    }

    clearElementTimer(element);
    const timerId = setTimeout(() => {
      elementTimers.delete(element);
      callback?.();
    }, delayMs);
    elementTimers.set(element, timerId);
    return timerId;
  }

  function setHidden(element, hidden = true) {
    if (!element) {
      return;
    }

    element.hidden = !!hidden;
    if (hidden) {
      element.setAttribute('aria-hidden', 'true');
    } else {
      element.removeAttribute('aria-hidden');
    }
  }

  function showTimedMessage({
    element,
    text = '',
    type = 'info',
    baseClassName = '',
    durationMs = 5000,
  } = {}) {
    if (!element) {
      return;
    }

    clearElementTimer(element);
    element.textContent = text;
    element.className = [baseClassName, type].filter(Boolean).join(' ');
    setHidden(element, false);

    if (durationMs > 0) {
      scheduleElementTimer(element, () => {
        setHidden(element, true);
      }, durationMs);
    }
  }

  function setButtonState(button, state = 'idle', labels = {}) {
    if (!button) {
      return;
    }

    const mergedLabels = {
      completed: '已完成',
      downloading: '下载中...',
      idle: '下载',
      pending: '处理中...',
      ...labels,
    };

    clearElementTimer(button);

    const stateLabel = mergedLabels[state] || mergedLabels.idle;
    const disabled = state !== 'idle';

    button.disabled = disabled;
    button.dataset.state = state;

    const labelEl = button.querySelector?.(':scope > .dl-label');
    if (labelEl) {
      labelEl.textContent = stateLabel;
      const iconEl = button.querySelector?.(':scope > .dl-icon');
      if (iconEl) {
        iconEl.hidden = state !== 'idle';
      }
      return;
    }

    button.textContent = stateLabel;
  }

  function updateProgress({
    barElement,
    containerElement,
    hideDelayMs = 0,
    percent = 0,
    textElement,
  } = {}) {
    if (!containerElement || !barElement || !textElement) {
      return 0;
    }

    const safePercent = Number.isFinite(percent)
      ? Math.max(0, Math.min(100, Math.round(percent)))
      : 0;

    clearElementTimer(containerElement);
    setHidden(containerElement, false);
    barElement.style.width = `${safePercent}%`;
    textElement.textContent = `${safePercent}%`;

    if (hideDelayMs > 0 && safePercent >= 100) {
      scheduleElementTimer(containerElement, () => {
        setHidden(containerElement, true);
      }, hideDelayMs);
    }

    return safePercent;
  }

  function updateDownloadItemProgress({
    button,
    buttonLabels = {},
    item,
    percent = 0,
    progressBarSelector,
    progressTextSelector,
    progressWrapSelector,
    resetDelayMs = 3000,
  } = {}) {
    if (!item || !button) {
      return 0;
    }

    const progressWrap = item.querySelector(progressWrapSelector);
    const progressBar = progressWrap?.querySelector(progressBarSelector);
    const progressText = progressWrap?.querySelector(progressTextSelector);
    if (!progressWrap || !progressBar || !progressText) {
      return 0;
    }

    const safePercent = updateProgress({
      barElement: progressBar,
      containerElement: progressWrap,
      percent,
      textElement: progressText,
    });

    if (safePercent > 0 && safePercent < 100) {
      setButtonState(button, 'downloading', buttonLabels);
      return safePercent;
    }

    if (safePercent >= 100) {
      setButtonState(button, 'completed', buttonLabels);
      scheduleElementTimer(progressWrap, () => {
        setHidden(progressWrap, true);
      }, resetDelayMs);
      scheduleElementTimer(button, () => {
        setButtonState(button, 'idle', buttonLabels);
      }, resetDelayMs);
    }

    return safePercent;
  }

  function startInlineTitleEdit({
    buildDisplayElement,
    currentValue = '',
    inputClassName = '',
    onCommit,
    titleElement,
  } = {}) {
    if (!titleElement || typeof buildDisplayElement !== 'function') {
      return null;
    }

    const originalValue = String(currentValue || titleElement.textContent || '');
    const input = document.createElement('input');
    input.className = inputClassName;
    input.value = originalValue;
    titleElement.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = () => {
      if (committed) {
        return;
      }
      committed = true;

      const nextValue = input.value.trim() || originalValue;
      onCommit?.(nextValue);
      const replacement = buildDisplayElement(nextValue);
      if (replacement) {
        input.replaceWith(replacement);
      } else {
        input.remove();
      }
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }

      if (event.key === 'Escape') {
        input.value = originalValue;
        commit();
      }
    });

    return input;
  }

  globalThis.__OVD_UI_DOM_UTILS__ = Object.freeze({
    clearElementTimer,
    setButtonState,
    setHidden,
    showTimedMessage,
    startInlineTitleEdit,
    updateDownloadItemProgress,
    updateProgress,
  });
})();
