'use strict';

(() => {
  if (globalThis.__OVD_LOGGER__) {
    return;
  }

  function formatContext(context = {}) {
    return Object.entries(context)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
  }

  function createLogger(scope = 'app', baseContext = {}, options = {}) {
    const {
      isDebugEnabled = () => false,
      prefix = 'OVD',
    } = options;

    function emit(level, message, extraContext = {}, extraPayload = undefined) {
      const contextText = formatContext({ ...baseContext, ...extraContext });
      const line = `[${prefix}][${scope}]${contextText ? ` ${contextText}` : ''} ${String(message || '')}`.trim();

      if (level === 'debug' && !isDebugEnabled()) {
        return;
      }

      if (extraPayload !== undefined) {
        if (level === 'warn') {
          console.warn(line, extraPayload);
          return;
        }
        if (level === 'error') {
          console.error(line, extraPayload);
          return;
        }
        console.log(line, extraPayload);
        return;
      }

      if (level === 'warn') {
        console.warn(line);
        return;
      }
      if (level === 'error') {
        console.error(line);
        return;
      }
      console.log(line);
    }

    return {
      child(extraContext = {}) {
        return createLogger(scope, { ...baseContext, ...extraContext }, options);
      },
      debug(message, extraContext, extraPayload) {
        emit('debug', message, extraContext, extraPayload);
      },
      error(message, extraContext, extraPayload) {
        emit('error', message, extraContext, extraPayload);
      },
      info(message, extraContext, extraPayload) {
        emit('info', message, extraContext, extraPayload);
      },
      warn(message, extraContext, extraPayload) {
        emit('warn', message, extraContext, extraPayload);
      },
    };
  }

  globalThis.__OVD_LOGGER__ = {
    createLogger,
  };
})();
