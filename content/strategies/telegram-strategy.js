'use strict';

(() => {
  if (globalThis.__OVD_TELEGRAM_STRATEGY__) {
    return;
  }

  const telegramUtils = globalThis.__OVD_TELEGRAM_UTILS__ || {};
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

  function createTelegramStrategy(options = {}) {
    const {
      fetchPageStreamInPage = null,
      getFloatButton = () => null,
      videoUtils = {},
    } = options;

    function buildTaskMeta(meta, context) {
      return {
        sourceId: context.sourceId || 'telegram',
        strategyId: context.strategyId || 'page-stream',
        taskKey: context.taskKey || '',
        title: meta?.title || context.title || '',
        traceId: context.traceId || '',
        videoInfo: meta || null,
        videoUrl: meta?.url || '',
      };
    }

    /**
     * 实际抓取在**页面上下文**完成（见 injected/page-http-utils.js 的 PAGE_STREAM_FETCH_*）。
     * WebK 的 `/stream/` 端点由页面自己的 Service Worker 生成，而该 SW 用
     * `self.clients.get(e.clientId)` 找页面客户端——内容脚本的 fetch 没有 clientId，
     * 不被接管，会落到真实服务器并拿到 302。这里只负责文件名、进度与结果。
     */
    async function handleTelegramDownload(meta, context = {}) {
      const url = meta?.url || '';
      if (!url) {
        throw new Error('缺少视频地址');
      }
      if (typeof fetchPageStreamInPage !== 'function') {
        throw new Error('页面侧抓流不可用');
      }

      const streamInfo = telegramUtils.parseTelegramStreamInfo?.(url) || null;
      const mimeType = meta?.mimeType || streamInfo?.mimeType || '';
      const fallbackExt = telegramUtils.isTelegramStreamUrl?.(url) ? '.mp4' : '.bin';
      const ext = telegramUtils.guessMediaExtension?.(mimeType, fallbackExt) || fallbackExt;
      const filenameBase = videoUtils.buildFilenameBase?.({
        fallback: 'telegram-video',
        title: meta?.title || context.title || '',
        type: meta?.type || 'telegram',
        url,
      }) || 'telegram-video';
      const filename = videoUtils.ensureExtension?.(filenameBase, ext) || `${filenameBase}${ext}`;
      const totalHint = Number(meta?.fileSize) > 0 ? Number(meta.fileSize) : (streamInfo?.size || 0);
      const taskMeta = buildTaskMeta(meta, context);
      const progressReporter = context.progressReporter || null;

      console.log(`[OVD] Telegram 页面侧抓流开始 filename="${filename}" total=${totalHint || '?'} url=${url.substring(0, 120)}`);
      progressReporter?.status(t('telegram_fetching', '正在从 Telegram 拉取视频数据…'));

      const reportedPercent = new Set();
      const onProgress = (receivedBytes, total) => {
        if (!progressReporter) {
          return;
        }
        if (total > 0) {
          const percent = Math.min(99, Math.floor((receivedBytes / total) * 100));
          if (percent !== 0 && reportedPercent.has(percent)) {
            return;
          }
          reportedPercent.add(percent);
          progressReporter.progress(percent, { phase: 'fetching' });
          return;
        }
        progressReporter.status(
          t('telegram_fetchingBytes', '正在拉取视频数据…（已获取 $1）', [
            videoUtils.formatSize?.(receivedBytes) || `${receivedBytes} B`,
          ])
        );
      };

      let result;
      try {
        result = await fetchPageStreamInPage({
          fileSize: totalHint,
          filename,
          mimeType: mimeType || 'video/mp4',
          onProgress,
          signal: context.signal || null,
          taskMeta,
          url,
        });
      } catch (error) {
        if (error?.code === 'EMPTY_MEDIA_STREAM') {
          throw new Error(t('telegram_noData', '未取到任何视频数据（视频可能已被页面回收，请刷新页面后重试）'));
        }
        throw error;
      }

      progressReporter?.progress(100, { phase: 'complete' });
      getFloatButton()?.showMessage?.(t('telegram_started', 'Telegram 视频下载已开始'));

      return {
        downloadId: result?.downloadId ?? null,
        filename: result?.filename || filename,
        ok: true,
        size: result?.size ?? (totalHint || null),
      };
    }

    return {
      download(meta, context = {}) {
        return handleTelegramDownload(meta, context);
      },
      id: 'page-stream',
      priority: 100,
      supports(meta) {
        if (meta?.type === 'telegram') {
          return true;
        }
        return telegramUtils.isTelegramMediaUrl?.(meta?.url) === true;
      },
    };
  }

  globalThis.__OVD_TELEGRAM_STRATEGY__ = {
    createTelegramStrategy,
  };
})();
