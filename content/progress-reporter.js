'use strict';

(() => {
  if (globalThis.__OVD_PROGRESS_REPORTER__) {
    return;
  }

  const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
  const MSG = messageTypes;

  function createProgressReporter(options = {}) {
    const {
      emitRuntimeMessage = () => {},
      sourceId = 'source',
      taskKey = '',
      title = '',
      traceId = '',
    } = options;

    function emit(type, payload = {}) {
      emitRuntimeMessage({
        ...(traceId ? { traceId } : {}),
        ...(taskKey ? { taskKey } : {}),
        ...(sourceId ? { sourceId } : {}),
        ...(title ? { title } : {}),
        ...payload,
        type,
      });
    }

    function progress(percent, payload = {}) {
      const safePercent = Number.isFinite(percent)
        ? Math.max(0, Math.min(100, Math.round(percent)))
        : 0;

      emit(MSG.SOURCE_DOWNLOAD_PROGRESS || 'SOURCE_DOWNLOAD_PROGRESS', {
        ...payload,
        percent: safePercent,
      });

      return safePercent;
    }

    function status(message, payload = {}) {
      emit(MSG.SOURCE_DOWNLOAD_STATUS || 'SOURCE_DOWNLOAD_STATUS', {
        ...payload,
        message: String(message || ''),
      });
    }

    return {
      progress,
      status,
    };
  }

  globalThis.__OVD_PROGRESS_REPORTER__ = {
    createProgressReporter,
  };
})();
