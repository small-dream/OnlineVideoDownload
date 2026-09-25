'use strict';

(() => {
  if (globalThis.__OVD_DOWNLOAD_COORDINATOR__) {
    return;
  }

  const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
  const MSG = messageTypes;

  function createDownloadCoordinator(options = {}) {
    const {
      actions = {},
      emitRuntimeMessage = () => {},
      getFloatButton = () => null,
      progressReporterFactory = {},
      sourceRegistry = null,
      sourceUtils = {},
    } = options;

    const activeSourceDownloads = new Set();
    // 内容侧任务取消通道：taskKey/traceId/videoUrl → AbortController
    const activeAbortControllers = new Map();

    function createTraceId(sourceId = 'source') {
      return `${sourceId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function createSourceContext({
      buttonElement = null,
      sourceId = 'source',
      taskKey = '',
      title = '',
      traceId = '',
    } = {}) {
      return {
        actions,
        buttonElement,
        floatButton: getFloatButton(),
        progressReporter: progressReporterFactory.createProgressReporter?.({
          emitRuntimeMessage,
          sourceId,
          taskKey,
          title,
          traceId,
        }) || null,
        sourceId,
        sourceUtils,
        taskKey,
        title,
        traceId,
      };
    }

    function emitSourceLifecycleMessage({
      downloadId = null,
      error = '',
      filename = '',
      ok,
      phase,
      size = null,
      sourceId,
      strategyId,
      taskKey = '',
      title = '',
      traceId = '',
      videoInfo = null,
      videoUrl = '',
    }) {
      const payload = {
        ...(traceId ? { traceId } : {}),
        ...(taskKey ? { taskKey } : {}),
        ...(videoUrl ? { videoUrl } : {}),
        ...(videoInfo ? { videoInfo } : {}),
        sourceId,
        strategyId,
        title,
        ...(phase === 'RESULT' ? { downloadId, error, filename, ok, size } : {}),
      };

      emitRuntimeMessage({
        type: phase === 'STARTED'
          ? (MSG.SOURCE_DOWNLOAD_STARTED || 'SOURCE_DOWNLOAD_STARTED')
          : (MSG.SOURCE_DOWNLOAD_RESULT || 'SOURCE_DOWNLOAD_RESULT'),
        ...payload,
      });

      const legacyTypeMap = {
        bilibili: {
          RESULT: MSG.BILIBILI_DOWNLOAD_RESULT || 'BILIBILI_DOWNLOAD_RESULT',
          STARTED: MSG.BILIBILI_DOWNLOAD_STARTED || 'BILIBILI_DOWNLOAD_STARTED',
        },
        youtube: {
          RESULT: MSG.YOUTUBE_DOWNLOAD_RESULT || 'YOUTUBE_DOWNLOAD_RESULT',
          STARTED: MSG.YOUTUBE_DOWNLOAD_STARTED || 'YOUTUBE_DOWNLOAD_STARTED',
        },
      };

      const legacyType = legacyTypeMap[sourceId]?.[phase];
      if (legacyType) {
        emitRuntimeMessage({ type: legacyType, ...payload });
      }
    }

    function startSourceDownload(meta, options = {}) {
      const traceId = options.traceId || createTraceId(sourceUtils.getSourceId?.(meta) || 'source');
      const context = createSourceContext({ ...options, traceId });
      const resolvedDownload = sourceRegistry?.resolveDownload(meta, context);
      if (!resolvedDownload) {
        return { ok: false, error: '未找到可用的来源处理器' };
      }

      const { handler, sourceId, strategyId } = resolvedDownload;
      const taskKey = handler.getTaskKey?.(meta) || sourceUtils.buildTaskKey?.(meta) || meta?.url || sourceId;
      context.progressReporter = progressReporterFactory.createProgressReporter?.({
        emitRuntimeMessage,
        sourceId,
        taskKey,
        title: meta?.title || '',
        traceId,
      }) || null;
      context.sourceId = sourceId;
      context.strategyId = strategyId;
      context.taskKey = taskKey;
      context.title = meta?.title || '';
      context.videoInfo = meta || null;
      context.videoUrl = meta?.url || '';
      const activeKey = `${sourceId}:${strategyId || 'default'}:${taskKey}`;

      if (activeSourceDownloads.has(activeKey)) {
        return { ok: true, alreadyRunning: true, sourceId, started: false, strategyId, taskKey, traceId };
      }

      activeSourceDownloads.add(activeKey);
      const abortController = typeof AbortController === 'function' ? new AbortController() : null;
      if (abortController) {
        context.signal = abortController.signal;
        activeAbortControllers.set(activeKey, {
          abortController,
          sourceId,
          strategyId,
          taskKey,
          traceId,
          videoUrl: meta?.url || '',
        });
      }
      emitSourceLifecycleMessage({
        phase: 'STARTED',
        sourceId,
        strategyId,
        taskKey,
        title: meta?.title || '',
        traceId,
        videoInfo: meta || null,
        videoUrl: meta?.url || '',
      });

      sourceRegistry.download(meta, context)
        .then((result) => {
          emitSourceLifecycleMessage({
            ok: true,
            phase: 'RESULT',
            sourceId,
            strategyId,
            taskKey,
            title: meta?.title || '',
            traceId,
            videoUrl: meta?.url || '',
            videoInfo: meta || null,
            filename: result?.filename || '',
            size: result?.size ?? null,
            downloadId: result?.downloadId ?? null,
          });
        })
        .catch((err) => {
          const aborted = err?.code === 'DOWNLOAD_ABORTED';
          emitSourceLifecycleMessage({
            error: aborted ? '已取消' : err.message,
            ok: false,
            phase: 'RESULT',
            sourceId,
            strategyId,
            taskKey,
            title: meta?.title || '',
            traceId,
            videoInfo: meta || null,
            videoUrl: meta?.url || '',
          });
        })
        .finally(() => {
          activeSourceDownloads.delete(activeKey);
          activeAbortControllers.delete(activeKey);
        });

      return { ok: true, sourceId, started: true, strategyId, taskKey, traceId };
    }

    /**
     * 取消内容侧任务。
     * 可仅凭 taskKey / traceId / videoUrl 任一匹配（当前 SW 对无 downloadId 的任务
     * 无法取消，这条通道补齐该能力）。
     */
    function cancelSourceDownload(target = {}) {
      const { taskKey = '', traceId = '', videoUrl = '' } = target;
      let matched = null;

      for (const [activeKey, entry] of activeAbortControllers) {
        if (
          (taskKey && entry.taskKey === taskKey)
          || (traceId && entry.traceId === traceId)
          || (videoUrl && entry.videoUrl === videoUrl)
        ) {
          matched = { activeKey, entry };
          break;
        }
      }

      if (!matched) {
        return { cancelled: false, ok: false, error: '未找到可取消的任务' };
      }

      const { activeKey, entry } = matched;
      console.log(`[OVD] 取消内容侧任务 taskKey=${entry.taskKey} traceId=${entry.traceId}`);
      try {
        entry.abortController.abort();
      } catch (err) {
        console.warn(`[OVD] 取消任务失败: ${err.message}`);
      }

      activeAbortControllers.delete(activeKey);
      activeSourceDownloads.delete(activeKey);
      emitSourceLifecycleMessage({
        error: '已取消',
        ok: false,
        phase: 'RESULT',
        sourceId: entry.sourceId,
        strategyId: entry.strategyId,
        taskKey: entry.taskKey,
        traceId: entry.traceId,
        videoUrl: entry.videoUrl,
      });

      return { cancelled: true, ok: true, taskKey: entry.taskKey, traceId: entry.traceId };
    }

    async function handleDownload(video, buttonElement) {
      try {
        const response = startSourceDownload(video, { buttonElement });
        if (!response?.ok) {
          throw new Error(response?.error || '下载启动失败');
        }

        if (response.alreadyRunning) {
          getFloatButton()?.showMessage('当前视频已在下载中');
        }
      } catch (err) {
        getFloatButton()?.showMessage(`下载失败: ${err.message}`, true);
        console.error('[OVD] Download error:', err);
      } finally {
        if (buttonElement) {
          buttonElement.textContent = '下载';
          buttonElement.disabled = false;
        }
      }
    }

    return {
      cancelSourceDownload,
      createSourceContext,
      emitSourceLifecycleMessage,
      handleDownload,
      startSourceDownload,
    };
  }

  globalThis.__OVD_DOWNLOAD_COORDINATOR__ = {
    createDownloadCoordinator,
  };
})();
