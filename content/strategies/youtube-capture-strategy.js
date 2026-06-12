'use strict';

(() => {
  if (globalThis.__OVD_YOUTUBE_CAPTURE_STRATEGY__) {
    return;
  }

  const loggerFactory = globalThis.__OVD_LOGGER__ || {};
  const optionsFactory = globalThis.__OVD_YOUTUBE_DOWNLOAD_OPTIONS__ || {};
  const errorFactory = globalThis.__OVD_YOUTUBE_DOWNLOAD_ERRORS__ || {};
  const modeStore = globalThis.__OVD_YOUTUBE_DOWNLOAD_MODE_STORE__ || {};

  function createYouTubeCaptureStrategy(options = {}) {
    const {
      getFloatButton = () => null,
      sendMessageAsync = () => Promise.reject(new Error('sendMessageAsync unavailable')),
      triggerBlobDownload = () => {},
      videoUtils = {},
    } = options;

    function createLogger(traceId, meta, downloadOptions) {
      return loggerFactory.createLogger?.('youtube-capture', {
        mode: downloadOptions?.mode || 'capture',
        trace: traceId,
        videoId: meta?.videoId || '',
      }, {
        isDebugEnabled: () => modeStore.isDebugEnabled?.('youtube'),
      }) || console;
    }

    async function saveBlobViaBrowserDownload(blob, filename, log, context = {}, meta = {}) {
      const objectUrl = URL.createObjectURL(blob);

      try {
        const response = await sendMessageAsync({
          filename,
          objectUrl,
          sourceId: context.sourceId || 'youtube',
          strategyId: context.strategyId || 'youtube-capture',
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
          console.warn(`[OVD][YT] failed to revoke capture object URL: ${revokeErr.message}`);
        }

        log?.warn?.('browser save failed, fallback to in-page blob download', { filename }, err);
        triggerBlobDownload(blob, filename, {
          sourceId: context.sourceId || 'youtube',
          strategyId: context.strategyId || 'youtube-capture',
          taskKey: context.taskKey || '',
          title: context.title || meta?.title || '',
          traceId: context.traceId || '',
          videoInfo: context.videoInfo || meta || null,
          videoUrl: context.videoUrl || meta?.url || '',
        });
        return { error: err.message, fallback: true, ok: true };
      }
    }

    function getVideoDuration(video, meta) {
      if (Number.isFinite(video?.duration) && video.duration > 0) {
        return video.duration;
      }
      if (Number.isFinite(meta?.duration) && meta.duration > 0) {
        return meta.duration;
      }
      return 0;
    }

    function pickMediaRecorderMimeType() {
      const candidates = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=h264,aac',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ];

      return candidates.find((mimeType) => {
        try {
          return MediaRecorder.isTypeSupported(mimeType);
        } catch (err) {
          console.warn(`[OVD][YT] failed to check MediaRecorder support for ${mimeType}: ${err.message}`);
          return false;
        }
      }) || '';
    }

    async function waitForYouTubeVideoElement(meta, timeoutMs, log) {
      const immediate = findPrimaryYouTubeVideoElement(meta);
      if (immediate) {
        log?.debug?.('using immediate video element');
        return immediate;
      }

      return new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
          const candidate = findPrimaryYouTubeVideoElement(meta);
          if (!candidate) {
            return;
          }

          clearTimeout(timeoutId);
          observer.disconnect();
          log?.debug?.('video element found via observer');
          resolve(candidate);
        });

        const timeoutId = setTimeout(() => {
          observer.disconnect();
          reject(errorFactory.createYouTubeDownloadError?.(
            'YT_CAPTURE_VIDEO_NOT_FOUND',
            '未找到可录制的 YouTube 播放器',
            { timeoutMs }
          ) || new Error('未找到可录制的 YouTube 播放器'));
        }, timeoutMs);

        observer.observe(document.documentElement, { childList: true, subtree: true });
      });
    }

    function findPrimaryYouTubeVideoElement(meta) {
      const expectedDuration = Number.isFinite(meta?.duration) ? meta.duration : 0;
      const candidates = Array.from(document.querySelectorAll('video'))
        .filter((video) => video instanceof HTMLVideoElement)
        .filter((video) => video.isConnected)
        .filter((video) => {
          const rect = video.getBoundingClientRect();
          return rect.width > 200 && rect.height > 120;
        });

      candidates.sort((left, right) => {
        const areaDiff = (right.clientWidth * right.clientHeight) - (left.clientWidth * left.clientHeight);
        if (areaDiff !== 0) {
          return areaDiff;
        }

        if (expectedDuration > 0) {
          const leftDiff = Math.abs((left.duration || expectedDuration) - expectedDuration);
          const rightDiff = Math.abs((right.duration || expectedDuration) - expectedDuration);
          return leftDiff - rightDiff;
        }

        return 0;
      });

      return candidates[0] || null;
    }

    async function waitForVideoMetadata(video, timeoutMs) {
      if (video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0) {
        return;
      }

      await waitForEvent(video, 'loadedmetadata', timeoutMs, '等待 YouTube 视频元数据超时');
    }

    function waitForVideoEnded(video, fallbackDuration) {
      return new Promise((resolve, reject) => {
        let stalledTimer = null;

        const cleanup = () => {
          video.removeEventListener('ended', handleEnded);
          video.removeEventListener('error', handleError);
          if (stalledTimer) {
            clearTimeout(stalledTimer);
          }
        };

        const handleEnded = () => {
          cleanup();
          resolve();
        };

        const handleError = () => {
          cleanup();
          reject(errorFactory.createYouTubeDownloadError?.(
            'YT_CAPTURE_PLAYBACK_FAILED',
            'YouTube 播放过程中发生错误'
          ) || new Error('YouTube 播放过程中发生错误'));
        };

        const tick = () => {
          if (video.ended) {
            cleanup();
            resolve();
            return;
          }

          const duration = getVideoDuration(video, { duration: fallbackDuration });
          if (duration > 0 && video.currentTime >= duration - 0.2) {
            cleanup();
            resolve();
            return;
          }

          stalledTimer = setTimeout(tick, 500);
        };

        video.addEventListener('ended', handleEnded, { once: true });
        video.addEventListener('error', handleError, { once: true });
        tick();
      });
    }

    async function seekVideo(video, time) {
      if (!Number.isFinite(time) || time < 0) {
        return;
      }
      if (Math.abs((video.currentTime || 0) - time) < 0.1) {
        return;
      }

      const waitPromise = waitForEvent(video, 'seeked', 10000, '调整 YouTube 播放位置超时');
      video.currentTime = time;
      await waitPromise;
    }

    function waitForEvent(target, eventName, timeoutMs, timeoutMessage) {
      return new Promise((resolve, reject) => {
        const handleEvent = () => {
          clearTimeout(timeoutId);
          target.removeEventListener(eventName, handleEvent);
          resolve();
        };

        const timeoutId = setTimeout(() => {
          target.removeEventListener(eventName, handleEvent);
          reject(new Error(timeoutMessage));
        }, timeoutMs);

        target.addEventListener(eventName, handleEvent, { once: true });
      });
    }

    async function captureYouTubePlaybackAndDownload(meta, context = {}) {
      const downloadOptions = optionsFactory.normalizeYouTubeDownloadOptions?.(meta) || { mode: 'capture' };
      const traceId = context.traceId || `yt-${Date.now()}`;
      const log = createLogger(traceId, meta, downloadOptions);
      const floatButton = context.floatButton || getFloatButton();
      const progressReporter = context.progressReporter;

      log.info('capture workflow started', {
        title: meta?.title || '',
      });

      const video = await waitForYouTubeVideoElement(meta, 15000, log);
      log.debug('video element selected', {
        currentTime: Number(video.currentTime || 0).toFixed(2),
        duration: Number(video.duration || 0).toFixed(2),
        height: video.clientHeight,
        width: video.clientWidth,
      });

      await waitForVideoMetadata(video, 15000);

      const mimeType = pickMediaRecorderMimeType();
      if (!mimeType) {
        throw errorFactory.createYouTubeDownloadError?.(
          'YT_CAPTURE_UNSUPPORTED',
          '当前浏览器不支持录制 YouTube 页面媒体流'
        ) || new Error('当前浏览器不支持录制 YouTube 页面媒体流');
      }

      const extension = mimeType.includes('mp4') ? '.mp4' : '.webm';
      const filename = videoUtils.buildMediaFilename({
        ext: extension,
        fallback: 'youtube_capture',
        title: meta?.title,
      });

      floatButton?.showMessage(
        extension === '.mp4'
          ? '正在实时录制 YouTube 视频，请保持页面打开...'
          : '当前浏览器仅支持 WebM 录制，正在实时保存为 WebM...',
        false,
        0
      );
      progressReporter?.status(
        extension === '.mp4'
          ? '正在实时录制 YouTube 视频，请保持页面打开...'
          : '当前浏览器仅支持 WebM 录制，正在实时保存为 WebM...'
      );

      const originalState = {
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        defaultPlaybackRate: video.defaultPlaybackRate || 1,
        loop: !!video.loop,
        paused: !!video.paused,
        playbackRate: video.playbackRate || 1,
      };

      let previousMuted = null;
      let progressTimer = null;

      try {
        const muteResponse = await sendMessageAsync({ muted: true, type: 'SET_TAB_MUTED' });
        previousMuted = typeof muteResponse?.previousMuted === 'boolean' ? muteResponse.previousMuted : null;
        log.debug('tab mute updated', { previousMuted: previousMuted == null ? '' : String(previousMuted) });
      } catch (err) {
        log.warn('failed to mute tab before capture', {}, err);
      }

      try {
        if (Math.abs(originalState.currentTime) > 0.25) {
          await seekVideo(video, 0);
          log.debug('video seeked to start for capture');
        }

        video.loop = false;
        video.defaultPlaybackRate = 1;
        video.playbackRate = 1;

        const stream = typeof video.captureStream === 'function'
          ? video.captureStream()
          : (typeof video.mozCaptureStream === 'function' ? video.mozCaptureStream() : null);

        if (!stream) {
          throw errorFactory.createYouTubeDownloadError?.(
            'YT_CAPTURE_UNSUPPORTED',
            '当前页面视频不支持 captureStream'
          ) || new Error('当前页面视频不支持 captureStream');
        }

        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks = [];
        const stopPromise = new Promise((resolve, reject) => {
          recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
              chunks.push(event.data);
            }
          };
          recorder.onerror = () => reject(errorFactory.createYouTubeDownloadError?.(
            'YT_CAPTURE_UNSUPPORTED',
            recorder.error?.message || '页面录制失败'
          ) || new Error(recorder.error?.message || '页面录制失败'));
          recorder.onstop = resolve;
        });

        const duration = getVideoDuration(video, meta);
        progressTimer = setInterval(() => {
          const total = duration || getVideoDuration(video, meta);
          if (!total) {
            return;
          }

          const percent = Math.max(0, Math.min(100, Math.round((video.currentTime / total) * 100)));
          floatButton?.showProgress(percent);
          progressReporter?.progress(percent, { phase: 'recording' });
        }, 500);

        const endedPromise = waitForVideoEnded(video, duration);
        recorder.start(1000);
        log.info('media recorder started', { mimeType });

        try {
          await video.play();
          log.debug('video playback started for capture');
        } catch (err) {
          console.warn(`[OVD][YT] failed to autoplay YouTube video before capture: ${err.message}`);
          throw errorFactory.createYouTubeDownloadError?.(
            'YT_CAPTURE_PLAYBACK_FAILED',
            '无法自动播放，请先手动播放视频后再下载'
          ) || new Error('无法自动播放，请先手动播放视频后再下载');
        }

        await endedPromise;
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
        await stopPromise;

        const blob = new Blob(chunks, { type: mimeType });
        log.info('capture finished', {
          filename,
          sizeMb: (blob.size / 1024 / 1024).toFixed(2),
        });

        const saveResult = await saveBlobViaBrowserDownload(blob, filename, log, context, meta);
        floatButton?.showProgress(100);
        floatButton?.showMessage(`下载完成: ${filename}`);
        progressReporter?.progress(100, { phase: 'complete' });
        return { ...saveResult, filename, ok: true };
      } finally {
        if (progressTimer) {
          clearInterval(progressTimer);
        }

        try {
          video.loop = originalState.loop;
          video.defaultPlaybackRate = originalState.defaultPlaybackRate;
          video.playbackRate = originalState.playbackRate;
          if (Math.abs(video.currentTime - originalState.currentTime) > 0.25) {
            await seekVideo(video, originalState.currentTime);
          }
          if (originalState.paused) {
            video.pause();
          }
          log.debug('video state restored after capture');
        } catch (err) {
          log.warn('failed to restore video state after capture', {}, err);
        }

        if (previousMuted != null) {
          try {
            await sendMessageAsync({ muted: previousMuted, type: 'SET_TAB_MUTED' });
            log.debug('tab mute restored', { muted: previousMuted ? 'true' : 'false' });
          } catch (err) {
            log.warn('failed to restore tab mute state', {}, err);
          }
        }
      }
    }

    return {
      async download(meta, context) {
        const traceId = context.traceId || `yt-${Date.now()}`;
        const downloadOptions = optionsFactory.normalizeYouTubeDownloadOptions?.(meta) || { mode: 'capture' };
        const log = createLogger(traceId, meta, downloadOptions);
        const floatButton = context.floatButton || getFloatButton();
        const progressReporter = context.progressReporter;

        floatButton?.showMessage('正在准备 YouTube 页面录制下载...', false, 0);
        progressReporter?.status('正在准备 YouTube 页面录制下载...');

        try {
          return await captureYouTubePlaybackAndDownload(meta, context);
        } catch (err) {
          const normalizedError = errorFactory.normalizeYouTubeDownloadError?.(err, 'YT_CAPTURE_FAILED') || err;
          floatButton?.showMessage(`YouTube 下载失败: ${normalizedError.message}`, true);
          progressReporter?.status(`YouTube 下载失败: ${normalizedError.message}`, { level: 'error' });
          log.error('capture workflow failed', {
            code: normalizedError.code || '',
          }, normalizedError);
          throw normalizedError;
        } finally {
          if (context.buttonElement) {
            context.buttonElement.disabled = false;
            context.buttonElement.textContent = '下载';
          }
        }
      },
      id: 'youtube-capture',
      priority: 100,
      supports(videoInfo) {
        if (videoInfo?.type !== 'youtube-adaptive') {
          return false;
        }

        return videoInfo?.downloadOptions?.mode !== 'parse';
      },
    };
  }

  globalThis.__OVD_YOUTUBE_CAPTURE_STRATEGY__ = {
    createYouTubeCaptureStrategy,
  };
})();
