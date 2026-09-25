'use strict';

(() => {
  if (globalThis.__OVD_MESSAGE_ROUTER__) {
    return;
  }

  const messageRuntime = globalThis.__OVD_MESSAGE_TYPES__ || {};
  const messageTypes = messageRuntime.MESSAGE_TYPES || {};
  const pageContextSources = messageRuntime.PAGE_CONTEXT_SOURCES || {};
  const toErrorResponse = messageRuntime.toErrorResponse || ((error) => ({ ok: false, error: error?.message || String(error) }));
  const toMessageResponse = messageRuntime.toMessageResponse || ((result) => ({ ok: true, ...(result || {}) }));
  const validateMessage = messageRuntime.validateMessage || (() => ({ ok: true }));
  const MSG = messageTypes;

  function createMessageRouter(options = {}) {
    const {
      bilibiliStrategy = null,
      blobStrategy = null,
      ensureUi = () => {},
      getFloatButton = () => null,
      hlsDelegateHandler = null,
      hlsStrategy = null,
      cancelSourceDownload = () => ({ cancelled: false, ok: false, error: '取消通道不可用' }),
      startSourceDownload = () => ({ ok: false, error: 'not initialized' }),
      streamTransferManager = null,
    } = options;

    // 页面方向的消息一律当不可信数据处理（MAIN world 无法对页面保密）
    const pageMessageGuard = globalThis.__OVD_PAGE_MESSAGE_GUARD__ || {};

    let started = false;
    // HLS 委托下载（SW 发起）的取消控制器：taskKey/taskId → AbortController
    const hlsAbortControllers = new Map();

    function hlsTaskKeyOf(msg = {}) {
      return msg.taskMeta?.taskKey || msg.taskMeta?.taskId || msg.videoUrl || '';
    }

    function cancelHlsTask(target = {}) {
      let cancelled = false;
      for (const key of [target.taskKey, target.traceId, target.videoUrl]) {
        if (!key) {
          continue;
        }
        const controller = hlsAbortControllers.get(key);
        if (controller) {
          controller.abort();
          hlsAbortControllers.delete(key);
          cancelled = true;
        }
      }
      return cancelled;
    }

    function emitRuntimeMessage(message) {
      __OVD_safeRuntimeMessage(message);
    }

    function getMediaStreamTaskMeta(transferId) {
      return streamTransferManager?.getMediaStreamTaskMeta?.(transferId) || {};
    }

    function emitYouTubeStreamProgress(transferId, progressPayload = {}) {
      const taskMeta = getMediaStreamTaskMeta(transferId);
      emitRuntimeMessage({
        ...taskMeta,
        phase: 'fetching',
        sourceId: taskMeta.sourceId || 'youtube',
        type: MSG.SOURCE_DOWNLOAD_PROGRESS || 'SOURCE_DOWNLOAD_PROGRESS',
        ...progressPayload,
      });
    }

    function routePageMessage(event) {
      if (event.source !== window || event.data?.from !== (pageContextSources.PAGE_SCRIPT || 'OVD_PAGE_SCRIPT')) {
        return;
      }

      const payload = event.data.payload;
      if (!payload) {
        return;
      }

      const validation = validateMessage(payload);
      if (!validation.ok) {
        console.warn(`[OVD] ignored invalid page message: ${validation.error}`);
        return;
      }

      switch (payload.type) {
        case MSG.PAGE_CHANGED || 'page-changed':
          __OVD_safeRuntimeMessage({
            type: MSG.CLEAR_TAB_VIDEOS || 'CLEAR_TAB_VIDEOS',
            url: payload.url || '',
          });
          return;

        case MSG.YOUTUBE_DIRECT_DOWNLOAD_RESULT || 'YOUTUBE_DIRECT_DOWNLOAD_RESULT':
          streamTransferManager?.finishPageDirectDownloadTransfer(payload);
          return;

        case MSG.YOUTUBE_MEDIA_STREAM_START || 'YOUTUBE_MEDIA_STREAM_START':
          streamTransferManager?.startMediaStreamTransfer(payload.transferId);
          emitYouTubeStreamProgress(payload.transferId, {
            percent: 0,
          });
          return;

        case MSG.YOUTUBE_MEDIA_STREAM_PROGRESS || 'YOUTUBE_MEDIA_STREAM_PROGRESS': {
          const progress = streamTransferManager?.updateMediaStreamProgress(
            payload.transferId,
            payload.label,
            payload.loadedBytes,
            payload.totalBytes
          );
          if (progress) {
            const percent = progress.percent ?? 0;
            emitYouTubeStreamProgress(payload.transferId, {
              hasKnownTotal: progress.hasKnownTotal,
              loadedBytes: progress.loadedBytes,
              totalBytes: progress.totalBytes,
              percent,
            });
          }
          return;
        }

        case MSG.YOUTUBE_MEDIA_STREAM_CHUNK || 'YOUTUBE_MEDIA_STREAM_CHUNK':
          streamTransferManager?.appendMediaStreamChunk(
            payload.transferId,
            payload.label,
            payload.chunkBase64,
            payload.seq
          );
          return;

        case MSG.YOUTUBE_MEDIA_STREAM_FINISH || 'YOUTUBE_MEDIA_STREAM_FINISH':
          const taskMeta = getMediaStreamTaskMeta(payload.transferId);
          streamTransferManager?.finishMediaStreamTransfer(payload.transferId);
          emitRuntimeMessage({
            ...taskMeta,
            phase: 'fetching',
            sourceId: taskMeta.sourceId || 'youtube',
            type: MSG.SOURCE_DOWNLOAD_PROGRESS || 'SOURCE_DOWNLOAD_PROGRESS',
            percent: 100,
          });
          return;

        case MSG.YOUTUBE_MEDIA_STREAM_ERROR || 'YOUTUBE_MEDIA_STREAM_ERROR':
          streamTransferManager?.failMediaStreamTransfer(payload.transferId, payload.error);
          return;

        default:
          break;
      }

      console.log('[OVD][YT-DEBUG] page script reported video', {
        availableCombinedHeights: (payload.combined || []).filter((stream) => !!stream.url).map((stream) => stream.height).filter(Boolean),
        availableDirectVideoHeights: (payload.videoStreams || []).filter((stream) => !!stream.url).map((stream) => stream.height).filter(Boolean),
        availableSignatureCipherHeights: (payload.videoStreams || []).filter((stream) => !stream.url && !!(stream.signatureCipher || stream.cipher)).map((stream) => stream.height).filter(Boolean),
        audioStreamsCount: payload.audioStreams?.length || 0,
        combinedCount: payload.combined?.length || 0,
        title: payload.title,
        type: payload.type,
        url: typeof payload.url === 'string'
          ? (payload.url.length > 100 ? `${payload.url.substring(0, 100)}...` : payload.url)
          : payload.url,
        videoId: payload.videoId,
        videoStreamsCount: payload.videoStreams?.length || 0,
      });

      // 伪造的页面消息可以塞进任意 URL（含 file:/data:）或伪造媒体类型，
      // 校验不通过直接丢弃，避免污染注册表并诱导用户下载非媒体内容。
      const guardResult = pageMessageGuard.validateDetectedPayload?.(payload);
      if (guardResult && !guardResult.ok) {
        console.warn(`[OVD] 丢弃可疑的页面检测结果: ${guardResult.reason}`);
        return;
      }

      chrome.runtime.sendMessage({ type: MSG.VIDEO_DETECTED || 'VIDEO_DETECTED', payload }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[OVD][YT-DEBUG] VIDEO_DETECTED send failed:', chrome.runtime.lastError.message);
          return;
        }

        console.log('[OVD][YT-DEBUG] VIDEO_DETECTED background response:', response);
      });
    }

    function routeBackgroundMessage(msg, sender, sendResponse) {
      const validation = validateMessage(msg);
      if (!validation.ok) {
        console.warn(`[OVD] ignored invalid content message: ${validation.error}`);
        sendResponse(toErrorResponse(new Error(validation.error)));
        return false;
      }

      console.log(`[OVD] content script received message type=${msg.type}`);

      const respond = (result) => {
        sendResponse(toMessageResponse(result));
      };
      const respondAsync = (promise, contextLabel) => {
        Promise.resolve(promise)
          .then((result) => respond(result))
          .catch((err) => {
            console.error(`[OVD] ${contextLabel}: ${err.message}`);
            sendResponse(toErrorResponse(err));
          });
        return true;
      };

      try {
        switch (msg.type) {
          case MSG.UPDATE_BUTTON || 'UPDATE_BUTTON':
            ensureUi();
            respond();
            break;

          case MSG.HLS_PROGRESS || 'HLS_PROGRESS':
            respond();
            break;

          case MSG.DOWNLOAD_PROGRESS || 'DOWNLOAD_PROGRESS':
            respond();
            break;

          case MSG.FETCH_BLOB || 'FETCH_BLOB':
            return respondAsync(blobStrategy.handleFetch(msg.blobUrl, msg.filename, msg.taskMeta || {}), 'FETCH_BLOB failed');

          case MSG.HLS_DOWNLOAD_BLOB || 'HLS_DOWNLOAD_BLOB':
            return respondAsync(
              streamTransferManager.hlsDownloadBlob(msg.buffer, msg.filename, msg.mimeType, msg.taskMeta || {})
                .then((downloadId) => ({ downloadId })),
              'HLS blob download failed'
            );

          case MSG.HLS_DOWNLOAD_BLOB_START || 'HLS_DOWNLOAD_BLOB_START':
            streamTransferManager.startHlsBlobTransfer(msg.transferId, msg.filename, msg.mimeType, msg.taskMeta || {});
            respond();
            break;

          case MSG.HLS_DOWNLOAD_BLOB_CHUNK || 'HLS_DOWNLOAD_BLOB_CHUNK':
            streamTransferManager.appendHlsBlobChunk(msg.transferId, msg.chunkBase64);
            respond();
            break;

          case MSG.HLS_DOWNLOAD_BLOB_FINISH || 'HLS_DOWNLOAD_BLOB_FINISH':
            return respondAsync(
              streamTransferManager.finishHlsBlobTransfer(msg.transferId)
                .then((downloadId) => ({ downloadId })),
              'HLS blob finalize failed'
            );

          case MSG.HLS_DOWNLOAD_DELEGATE || 'HLS_DOWNLOAD_DELEGATE':
            if (!hlsDelegateHandler?.handle) {
              sendResponse(toErrorResponse(new Error('HLS 委托下载不可用')));
              break;
            }
            {
              const taskKey = hlsTaskKeyOf(msg);
              const controller = typeof AbortController === 'function' ? new AbortController() : null;
              if (controller && taskKey) {
                hlsAbortControllers.set(taskKey, controller);
              }
              const promise = hlsDelegateHandler.handle(
                msg.m3u8Url,
                msg.filename,
                msg.headers,
                msg.taskMeta || {},
                { ...(msg.options || {}), signal: controller?.signal }
              ).finally(() => {
                if (taskKey) {
                  hlsAbortControllers.delete(taskKey);
                }
              });
              return respondAsync(promise, 'HLS delegated download failed');
            }

          case MSG.ABORT_SOURCE_DOWNLOAD || 'ABORT_SOURCE_DOWNLOAD':
            respond({
              ...cancelSourceDownload({
                taskKey: msg.taskKey,
                traceId: msg.traceId,
                videoUrl: msg.videoUrl,
              }),
              ...(cancelHlsTask(msg) ? { hlsCancelled: true } : {}),
            });
            break;

          case MSG.BILIBILI_FETCH_QUALITIES || 'BILIBILI_FETCH_QUALITIES':
            if (!bilibiliStrategy?.fetchQualities) {
              respond(toErrorResponse(new Error('Bilibili 策略未就绪')));
              break;
            }
            return respondAsync(
              bilibiliStrategy.fetchQualities(msg.meta),
              'Bilibili 画质获取失败'
            );

          case MSG.HLS_FETCH_QUALITIES || 'HLS_FETCH_QUALITIES': {
            const hlsQualitiesHandler = hlsStrategy?.fetchQualities || hlsDelegateHandler?.fetchQualities;
            if (!hlsQualitiesHandler || !msg.m3u8Url) {
              respond(toErrorResponse(new Error('HLS 画质获取不可用')));
              break;
            }
            return respondAsync(
              hlsQualitiesHandler(msg.m3u8Url, msg.headers || {}, msg.options || {}),
              'HLS 画质获取失败'
            );
          }

          case MSG.BILIBILI_STREAM_PROGRESS || 'BILIBILI_STREAM_PROGRESS':
            respond();
            break;

          case MSG.SOURCE_DOWNLOAD || 'SOURCE_DOWNLOAD':
          case 'YOUTUBE_DOWNLOAD':
          case 'BILIBILI_DOWNLOAD':
            respond(startSourceDownload(msg.meta));
            break;

          case MSG.MEDIA_STREAM_START || 'MEDIA_STREAM_START':
            streamTransferManager.startMediaStreamTransfer(msg.transferId);
            respond();
            break;

          case MSG.MEDIA_STREAM_CHUNK || 'MEDIA_STREAM_CHUNK':
            streamTransferManager.appendMediaStreamChunk(msg.transferId, msg.label, msg.chunkBase64, msg.seq);
            respond();
            break;

          case MSG.MEDIA_STREAM_FINISH || 'MEDIA_STREAM_FINISH':
            streamTransferManager.finishMediaStreamTransfer(msg.transferId);
            respond();
            break;

          case MSG.MEDIA_STREAM_ERROR || 'MEDIA_STREAM_ERROR':
            streamTransferManager.failMediaStreamTransfer(msg.transferId, msg.error);
            respond();
            break;

          case MSG.REVOKE_OBJECT_URL || 'REVOKE_OBJECT_URL':
            if (msg.objectUrl) {
              try {
                URL.revokeObjectURL(msg.objectUrl);
              } catch (err) {
                console.warn(`[OVD] failed to revoke object URL in content script: ${err.message}`);
              }
            }
            respond();
            break;

          default:
            throw new Error(`Unknown content message type: ${msg.type}`);
        }
      } catch (err) {
        console.error(`[OVD] content message handling failed type=${msg.type}: ${err.message}`);
        sendResponse(toErrorResponse(err));
      }

      return false;
    }

    function start() {
      if (started) {
        return;
      }

      started = true;
      window.addEventListener('message', routePageMessage);
      chrome.runtime.onMessage.addListener(routeBackgroundMessage);
    }

    return {
      start,
    };
  }

  globalThis.__OVD_MESSAGE_ROUTER__ = {
    createMessageRouter,
  };
})();
