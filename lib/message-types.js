'use strict';

(() => {
  if (globalThis.__OVD_MESSAGE_TYPES__) {
    return;
  }

  const MESSAGE_TYPES = Object.freeze({
    ABORT_SOURCE_DOWNLOAD: 'ABORT_SOURCE_DOWNLOAD',
    BILIBILI_DOWNLOAD_RESULT: 'BILIBILI_DOWNLOAD_RESULT',
    BILIBILI_DOWNLOAD_STARTED: 'BILIBILI_DOWNLOAD_STARTED',
    BILIBILI_FETCH_QUALITIES: 'BILIBILI_FETCH_QUALITIES',
    CLEAR_DOWNLOAD_HISTORY: 'CLEAR_DOWNLOAD_HISTORY',
    BILIBILI_MUXER_LOG: 'BILIBILI_MUXER_LOG',
    BILIBILI_STREAM_PROGRESS: 'BILIBILI_STREAM_PROGRESS',
    CLEAR_TAB_VIDEOS: 'CLEAR_TAB_VIDEOS',
    DASH_DOWNLOAD_DELEGATE: 'DASH_DOWNLOAD_DELEGATE',
    DOWNLOAD_BLOB_DATA: 'DOWNLOAD_BLOB_DATA',
    DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
    DOWNLOAD_VIDEO: 'DOWNLOAD_VIDEO',
    FETCH_BLOB: 'FETCH_BLOB',
    FETCH_MEDIA_STREAMS: 'FETCH_MEDIA_STREAMS',
    DOWNLOAD_TASKS_UPDATED: 'DOWNLOAD_TASKS_UPDATED',
    GET_DOWNLOAD_HISTORY: 'GET_DOWNLOAD_HISTORY',
    GET_DOWNLOAD_STATES: 'GET_DOWNLOAD_STATES',
    GET_DOWNLOAD_TASKS: 'GET_DOWNLOAD_TASKS',
    DELETE_DOWNLOAD_TASK: 'DELETE_DOWNLOAD_TASK',
    GET_VIDEOS: 'GET_VIDEOS',
    GET_VIDEOS_FOR_TAB: 'GET_VIDEOS_FOR_TAB',
    OFFSCREEN_BLOB_DOWNLOAD_ABORT: 'OFFSCREEN_BLOB_DOWNLOAD_ABORT',
    OFFSCREEN_BLOB_DOWNLOAD_CHUNK: 'OFFSCREEN_BLOB_DOWNLOAD_CHUNK',
    OFFSCREEN_BLOB_DOWNLOAD_FINISH: 'OFFSCREEN_BLOB_DOWNLOAD_FINISH',
    OFFSCREEN_BLOB_DOWNLOAD_START: 'OFFSCREEN_BLOB_DOWNLOAD_START',
    HLS_DOWNLOAD_BLOB: 'HLS_DOWNLOAD_BLOB',
    HLS_DOWNLOAD_BLOB_CHUNK: 'HLS_DOWNLOAD_BLOB_CHUNK',
    HLS_DOWNLOAD_BLOB_FINISH: 'HLS_DOWNLOAD_BLOB_FINISH',
    HLS_DOWNLOAD_BLOB_START: 'HLS_DOWNLOAD_BLOB_START',
    HLS_DOWNLOAD_DELEGATE: 'HLS_DOWNLOAD_DELEGATE',
    HLS_FETCH_QUALITIES: 'HLS_FETCH_QUALITIES',
    HLS_PROGRESS: 'HLS_PROGRESS',
    HLS_PROGRESS_UPDATE: 'HLS_PROGRESS_UPDATE',
    INJECT_DOWNLOAD_HEADERS: 'INJECT_DOWNLOAD_HEADERS',
    INJECT_PAGE_SCRIPTS: 'INJECT_PAGE_SCRIPTS',
    MEDIA_STREAM_CHUNK: 'MEDIA_STREAM_CHUNK',
    MEDIA_STREAM_ERROR: 'MEDIA_STREAM_ERROR',
    MEDIA_STREAM_FINISH: 'MEDIA_STREAM_FINISH',
    MEDIA_STREAM_START: 'MEDIA_STREAM_START',
    DELETE_DOWNLOAD_HISTORY_RECORD: 'DELETE_DOWNLOAD_HISTORY_RECORD',
    OPEN_DOWNLOAD_FOLDER: 'OPEN_DOWNLOAD_FOLDER',
    PAGE_CHANGED: 'page-changed',
    REVOKE_OBJECT_URL: 'REVOKE_OBJECT_URL',
    RELEASE_DOWNLOAD_HEADERS: 'RELEASE_DOWNLOAD_HEADERS',
    RETRY_DOWNLOAD_TASK: 'RETRY_DOWNLOAD_TASK',
    SET_TAB_MUTED: 'SET_TAB_MUTED',
    SOURCE_DOWNLOAD: 'SOURCE_DOWNLOAD',
    SOURCE_DOWNLOAD_PROGRESS: 'SOURCE_DOWNLOAD_PROGRESS',
    SOURCE_DOWNLOAD_RESULT: 'SOURCE_DOWNLOAD_RESULT',
    SOURCE_DOWNLOAD_STARTED: 'SOURCE_DOWNLOAD_STARTED',
    SOURCE_DOWNLOAD_STATUS: 'SOURCE_DOWNLOAD_STATUS',
    UPDATE_BUTTON: 'UPDATE_BUTTON',
    VIDEO_DETECTED: 'VIDEO_DETECTED',
    YOUTUBE_DIRECT_DOWNLOAD: 'YOUTUBE_DIRECT_DOWNLOAD',
    YOUTUBE_DIRECT_DOWNLOAD_RESULT: 'YOUTUBE_DIRECT_DOWNLOAD_RESULT',
    YOUTUBE_DOWNLOAD_RESULT: 'YOUTUBE_DOWNLOAD_RESULT',
    YOUTUBE_DOWNLOAD_STARTED: 'YOUTUBE_DOWNLOAD_STARTED',
    YOUTUBE_MEDIA_STREAM_CHUNK: 'YOUTUBE_MEDIA_STREAM_CHUNK',
    YOUTUBE_MEDIA_STREAM_ERROR: 'YOUTUBE_MEDIA_STREAM_ERROR',
    YOUTUBE_MEDIA_STREAM_FINISH: 'YOUTUBE_MEDIA_STREAM_FINISH',
    YOUTUBE_MEDIA_STREAM_PROGRESS: 'YOUTUBE_MEDIA_STREAM_PROGRESS',
    YOUTUBE_MEDIA_STREAM_START: 'YOUTUBE_MEDIA_STREAM_START',
    YOUTUBE_MEDIA_STREAMS_REQUEST: 'YOUTUBE_MEDIA_STREAMS_REQUEST',
  });

  const PAGE_CONTEXT_SOURCES = Object.freeze({
    CONTENT_SCRIPT: 'OVD_CONTENT_SCRIPT',
    PAGE_SCRIPT: 'OVD_PAGE_SCRIPT',
  });

  function getErrorMessage(error, fallback = 'Unknown error') {
    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }

    return fallback;
  }

  function isMessageObject(message) {
    return !!message && typeof message === 'object' && !Array.isArray(message);
  }

  function validateMessage(message, options = {}) {
    if (!isMessageObject(message)) {
      return { ok: false, error: 'Message payload must be an object' };
    }

    const {
      allowedTypes = null,
      requiredFields = [],
      requireType = true,
    } = options;

    const type = typeof message.type === 'string' ? message.type.trim() : '';
    if (requireType && !type) {
      return { ok: false, error: 'Message type is required' };
    }

    if (Array.isArray(allowedTypes) && type && !allowedTypes.includes(type)) {
      return { ok: false, error: `Unsupported message type: ${type}` };
    }

    for (const field of requiredFields) {
      if (message[field] == null) {
        return { ok: false, error: `Message field "${field}" is required` };
      }
    }

    return { ok: true };
  }

  function assertValidMessage(message, options = {}) {
    const validation = validateMessage(message, options);
    if (!validation.ok) {
      throw new Error(validation.error);
    }
    return message;
  }

  function toMessageResponse(result = undefined) {
    if (!isMessageObject(result)) {
      return { ok: true };
    }

    if (result.ok === false) {
      return {
        ...result,
        error: getErrorMessage(result.error),
        ok: false,
      };
    }

    if (result.ok === true) {
      const { error: _ignoredError, ...rest } = result;
      return { ok: true, ...rest };
    }

    return { ok: true, ...result };
  }

  function toErrorResponse(error, fallback = 'Unknown error') {
    return {
      ok: false,
      error: getErrorMessage(error, fallback),
    };
  }

  globalThis.__OVD_MESSAGE_TYPES__ = Object.freeze({
    MESSAGE_TYPES,
    PAGE_CONTEXT_SOURCES,
    assertValidMessage,
    getErrorMessage,
    isMessageObject,
    toErrorResponse,
    toMessageResponse,
    validateMessage,
  });
})();
