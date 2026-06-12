'use strict';

(() => {
  if (globalThis.__OVD_YOUTUBE_PARSE_DOWNLOAD_STRATEGY__) {
    return;
  }

  const loggerFactory = globalThis.__OVD_LOGGER__ || {};
  const optionsFactory = globalThis.__OVD_YOUTUBE_DOWNLOAD_OPTIONS__ || {};
  const streamUtils = globalThis.__OVD_YOUTUBE_STREAM_UTILS__ || {};
  const errorFactory = globalThis.__OVD_YOUTUBE_DOWNLOAD_ERRORS__ || {};
  const modeStore = globalThis.__OVD_YOUTUBE_DOWNLOAD_MODE_STORE__ || {};
  const byteUtils = globalThis.__OVD_BYTE_UTILS__ || {};
  const constants = globalThis.__OVD_CONSTANTS__ || {};

  function createYouTubeParseDownloadStrategy(options = {}) {
    const {
      createPageDirectDownloadTransfer = () => Promise.reject(new Error('createPageDirectDownloadTransfer unavailable')),
      fetchYouTubeMediaStreamsInPage = () => Promise.reject(new Error('fetchYouTubeMediaStreamsInPage unavailable')),
      getFloatButton = () => null,
      sendMessageAsync = () => Promise.reject(new Error('sendMessageAsync unavailable')),
      triggerBlobDownload = () => {},
      videoUtils = {},
    } = options;

    const MAX_IN_PAGE_MERGE_BYTES = constants.MAX_IN_PAGE_MERGE_BYTES || 1.5 * 1024 * 1024 * 1024;

    function createLogger(traceId, meta, downloadOptions) {
      return loggerFactory.createLogger?.('youtube-parse', {
        mode: downloadOptions?.mode || 'parse',
        resolution: downloadOptions?.resolution || 'auto',
        trace: traceId,
        videoId: meta?.videoId || '',
      }, {
        isDebugEnabled: () => modeStore.isDebugEnabled?.('youtube'),
      }) || console;
    }

    const formatBytes = byteUtils.formatBytes || ((bytes) => {
      const value = Number(bytes) || 0;
      if (!value) return '';
      if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
      return `${(value / 1024 / 1024).toFixed(0)} MB`;
    });

    function extFromUrl(url) {
      try {
        const pathname = new URL(url).pathname.toLowerCase();
        const match = pathname.match(/\.([a-z0-9]+)$/);
        return match ? `.${match[1]}` : '';
      } catch {
        return '';
      }
    }

    function inferMediaExtension(url, mimeType) {
      const extFromPath = extFromUrl(url);
      if (extFromPath) {
        return extFromPath;
      }
      return videoUtils.inferExtensionFromMimeType?.(mimeType || 'video/mp4') || '.mp4';
    }

    function buildDirectFilename(meta, target) {
      const ext = inferMediaExtension(target?.url, target?.mimeType) || '.mp4';
      const heightLabel = target?.height ? `_${target.height}p` : '';
      return videoUtils.buildMediaFilename({
        ext,
        fallback: 'youtube_video',
        title: `${meta?.title || 'youtube_video'}${heightLabel}`,
      });
    }

    async function saveBlobViaBrowserDownload(blob, filename, log, context = {}, meta = {}) {
      const objectUrl = URL.createObjectURL(blob);

      try {
        const response = await sendMessageAsync({
          filename,
          objectUrl,
          sourceId: context.sourceId || 'youtube',
          strategyId: context.strategyId || 'youtube-parse',
          taskKey: context.taskKey || '',
          title: context.title || meta?.title || '',
          type: 'DOWNLOAD_BLOB_DATA',
          traceId: context.traceId || '',
          videoInfo: context.videoInfo || meta || null,
          videoUrl: context.videoUrl || meta?.url || '',
        });

        if (response?.ok) {
          log?.info?.('blob handed to browser download', { downloadId: response.downloadId || '', filename });
          return response;
        }

        throw errorFactory.createYouTubeDownloadError?.(
          'YT_SAVE_FAILED',
          response?.error || 'Browser save failed',
          { filename }
        ) || new Error(response?.error || 'Browser save failed');
      } catch (err) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch (revokeErr) {
          console.warn(`[OVD][YT] failed to revoke parse object URL: ${revokeErr.message}`);
        }

        log?.warn?.('browser save failed, fallback to in-page blob download', { filename }, err);
        triggerBlobDownload(blob, filename, {
          sourceId: context.sourceId || 'youtube',
          strategyId: context.strategyId || 'youtube-parse',
          taskKey: context.taskKey || '',
          title: context.title || meta?.title || '',
          traceId: context.traceId || '',
          videoInfo: context.videoInfo || meta || null,
          videoUrl: context.videoUrl || meta?.url || '',
        });
        return { error: err.message, fallback: true, ok: true };
      }
    }

    function selectTarget(meta, downloadOptions) {
      const exactCombinedTarget = downloadOptions.preferCombined && downloadOptions.resolution !== 'auto'
        ? streamUtils.pickCombinedStream?.(meta, {
          ...downloadOptions,
          fallbackToLowerQuality: false,
        })
        : null;
      if (exactCombinedTarget) {
        return {
          kind: 'combined',
          stream: exactCombinedTarget,
        };
      }

      const videoStream = streamUtils.pickAdaptiveVideoStream?.(meta, downloadOptions);
      const audioStream = streamUtils.pickAdaptiveAudioStream?.(meta, downloadOptions);

      if (videoStream && audioStream) {
        return {
          audioStream,
          kind: 'adaptive',
          videoStream,
        };
      }

      const fallbackCombinedTarget = downloadOptions.preferCombined
        ? streamUtils.pickCombinedStream?.(meta, downloadOptions)
        : null;
      if (fallbackCombinedTarget) {
        return {
          kind: 'combined',
          stream: fallbackCombinedTarget,
        };
      }

      if (!videoStream) {
        const hasCipherVideo = (meta?.videoStreams || []).some((stream) => !stream.url && (stream.signatureCipher || stream.cipher));
        if (hasCipherVideo) {
          throw errorFactory.createYouTubeDownloadError?.(
            'YT_SIGNATURE_CIPHER_UNSUPPORTED',
            '当前视频分辨率需要 signatureCipher 解析，暂未支持',
            { requestedResolution: downloadOptions.resolution }
          ) || new Error('当前视频分辨率需要 signatureCipher 解析，暂未支持');
        }

        throw errorFactory.createYouTubeDownloadError?.(
          'YT_NO_DOWNLOADABLE_MP4_VIDEO',
          '未找到可下载的 MP4 视频流',
          { requestedResolution: downloadOptions.resolution }
        ) || new Error('未找到可下载的 MP4 视频流');
      }

      if (!audioStream) {
        const hasCipherAudio = (meta?.audioStreams || []).some((stream) => !stream.url && (stream.signatureCipher || stream.cipher));
        if (hasCipherAudio) {
          throw errorFactory.createYouTubeDownloadError?.(
            'YT_SIGNATURE_CIPHER_UNSUPPORTED',
            '当前音频流需要 signatureCipher 解析，暂未支持'
          ) || new Error('当前音频流需要 signatureCipher 解析，暂未支持');
        }

        throw errorFactory.createYouTubeDownloadError?.(
          'YT_NO_DOWNLOADABLE_MP4_AUDIO',
          '未找到可下载的 MP4 音频流'
        ) || new Error('未找到可下载的 MP4 音频流');
      }

      throw errorFactory.createYouTubeDownloadError?.(
        'YT_NO_STREAMS',
        '当前页面没有可用的 YouTube 下载流'
      ) || new Error('当前页面没有可用的 YouTube 下载流');
    }

    async function downloadCombinedInPage(meta, target, context, log) {
      const filename = buildDirectFilename(meta, target.stream);
      log.info('starting combined stream download', {
        filename,
        height: target.stream?.height || '',
        itag: target.stream?.itag || '',
      });

      return createPageDirectDownloadTransfer({
        filename,
        headers: meta?.requestHeaders || {},
        timeoutMessage: '等待页面内 YouTube 直链下载超时',
        traceId: context.traceId,
        transferPrefix: 'yt-direct',
        type: 'YOUTUBE_DIRECT_DOWNLOAD',
        url: target.stream.url,
      });
    }

    async function mergeAdaptiveStreams(meta, target, context, log) {
      const floatButton = context.floatButton || getFloatButton();
      const progressReporter = context.progressReporter;
      const videoStream = target.videoStream;
      const audioStream = target.audioStream;
      const estimatedVideoBytes = Number(videoStream?.contentLength) || 0;
      const estimatedAudioBytes = Number(audioStream?.contentLength) || 0;
      const estimatedTotalBytes = estimatedVideoBytes + estimatedAudioBytes;
      const estimatedLabel = formatBytes(estimatedTotalBytes);

      if (estimatedTotalBytes > MAX_IN_PAGE_MERGE_BYTES) {
        throw errorFactory.createYouTubeDownloadError?.(
          'YT_PARSE_TOO_LARGE',
          `当前清晰度预计需要抓取约 ${estimatedLabel}，浏览器内合并不稳定，请改用更低清晰度或录制模式`,
          {
            audioBytes: estimatedAudioBytes,
            estimatedTotalBytes,
            videoBytes: estimatedVideoBytes,
          }
        ) || new Error(`当前清晰度预计需要抓取约 ${estimatedLabel}，浏览器内合并不稳定，请改用更低清晰度或录制模式`);
      }

      floatButton?.showMessage(
        estimatedLabel
          ? `正在获取 YouTube 视音频数据... 预计 ${estimatedLabel}`
          : '正在获取 YouTube 视音频数据...',
        false,
        0
      );
      progressReporter?.status(
        estimatedLabel
          ? `正在获取 YouTube 视音频数据... 预计 ${estimatedLabel}`
          : '正在获取 YouTube 视音频数据...'
      );
      log.info('starting adaptive stream fetch', {
        audioBytes: estimatedAudioBytes || '',
        audioItag: audioStream?.itag || '',
        estimatedTotalBytes: estimatedTotalBytes || '',
        videoBytes: estimatedVideoBytes || '',
        videoItag: videoStream?.itag || '',
      });

      const { videoBuffer, audioBuffer } = await fetchYouTubeMediaStreamsInPage(
        videoStream.url,
        audioStream.url,
        meta?.requestHeaders || {},
        '等待 YouTube 视音频数据回传超时',
        context.traceId,
        {
          audio: {
            contentLength: estimatedAudioBytes,
            itag: audioStream?.itag || '',
          },
          video: {
            contentLength: estimatedVideoBytes,
            itag: videoStream?.itag || '',
          },
        },
        {
          sourceId: context.sourceId || 'youtube',
          strategyId: context.strategyId || 'youtube-parse',
          taskKey: context.taskKey || '',
          title: context.title || meta?.title || '',
          traceId: context.traceId || '',
          videoUrl: context.videoUrl || meta?.url || '',
        }
      );

      log.info('adaptive stream fetch completed', {
        audioMb: (audioBuffer.byteLength / 1024 / 1024).toFixed(2),
        videoMb: (videoBuffer.byteLength / 1024 / 1024).toFixed(2),
      });

      floatButton?.showMessage('正在合并 YouTube 视音频...', false, 0);
      progressReporter?.status('正在合并 YouTube 视音频...');
      const blob = await BilibiliMuxer.mergeFmp4Streams(videoBuffer, audioBuffer, (percent) => {
        floatButton?.showMessage(`正在合并 YouTube 视音频... ${percent}%`, false, 0);
        floatButton?.showProgress(percent);
        progressReporter?.progress(percent, { phase: 'merging' });
      });

      const filename = videoUtils.buildMediaFilename({
        ext: '.mp4',
        fallback: 'youtube_video',
        title: `${meta?.title || 'youtube_video'}_${videoStream?.height || 'video'}p`,
      });

      log.info('adaptive merge completed', {
        filename,
        outputMb: (blob.size / 1024 / 1024).toFixed(2),
      });

      return saveBlobViaBrowserDownload(blob, filename, log, context, meta);
    }

    return {
      async download(meta, context) {
        const downloadOptions = optionsFactory.normalizeYouTubeDownloadOptions?.(meta) || { mode: 'parse', resolution: 'auto' };
        const traceId = context.traceId || `yt-${Date.now()}`;
        const floatButton = context.floatButton || getFloatButton();
        const progressReporter = context.progressReporter;
        const log = createLogger(traceId, meta, downloadOptions);
        const snapshot = streamUtils.buildYouTubeSelectionSnapshot?.(meta, downloadOptions) || {};

        floatButton?.showMessage('正在准备 YouTube 解析下载...', false, 0);
        progressReporter?.status('正在准备 YouTube 解析下载...');
        log.info('parse workflow started', {
          fallbackToLowerQuality: downloadOptions.fallbackToLowerQuality ? 'true' : 'false',
          preferCombined: downloadOptions.preferCombined ? 'true' : 'false',
        }, snapshot);

        try {
          const target = selectTarget(meta, downloadOptions);
          log.info('stream target selected', {
            kind: target.kind,
          }, {
            ...snapshot,
            selectedKind: target.kind,
          });

          let result;
          if (target.kind === 'combined') {
            result = await downloadCombinedInPage(meta, target, context, log);
          } else {
            result = await mergeAdaptiveStreams(meta, target, context, log);
          }

          floatButton?.showProgress(100);
          floatButton?.showMessage(`下载完成: ${meta?.title || 'YouTube 视频'}`);
          progressReporter?.progress(100, { phase: 'complete' });
          return { ...result, ok: true };
        } catch (err) {
          const normalizedError = errorFactory.normalizeYouTubeDownloadError?.(err, 'YT_PARSE_FAILED') || err;
          floatButton?.showMessage(`YouTube 下载失败: ${normalizedError.message}`, true);
          progressReporter?.status(`YouTube 下载失败: ${normalizedError.message}`, { level: 'error' });
          log.error('parse workflow failed', {
            code: normalizedError.code || '',
          }, {
            error: normalizedError.message,
            snapshot,
          });
          throw normalizedError;
        } finally {
          if (context.buttonElement) {
            context.buttonElement.disabled = false;
            context.buttonElement.textContent = '下载';
          }
        }
      },
      id: 'youtube-parse',
      priority: 200,
      supports(videoInfo) {
        if (videoInfo?.type !== 'youtube-adaptive') {
          return false;
        }

        return videoInfo?.downloadOptions?.mode === 'parse';
      },
    };
  }

  globalThis.__OVD_YOUTUBE_PARSE_DOWNLOAD_STRATEGY__ = {
    createYouTubeParseDownloadStrategy,
  };
})();
