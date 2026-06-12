// content/strategies/dash-strategy.js
// DASH 流下载策略：解析 MPD manifest，获取音视频分片，合并为单文件
// 复用 BilibiliMuxer.mergeFmp4Streams 进行 fMP4 合并

'use strict';

(() => {
  if (globalThis.__OVD_DASH_STRATEGY__) {
    return;
  }

  const constants = globalThis.__OVD_CONSTANTS__ || {};
  const SEGMENT_CONCURRENCY = constants.HLS_SEGMENT_CONCURRENCY || 5;
  const MAX_MERGE_SIZE = 1500 * 1024 * 1024;

  function createDashStrategy(options = {}) {
    const {
      getFloatButton = () => null,
      hlsPipeline = {},
      sendMessageAsync = () => Promise.reject(new Error('sendMessageAsync unavailable')),
      triggerBlobDownload = () => {},
      videoUtils = {},
      mpdParser = {},
      progressReporter: defaultProgressReporter = null,
    } = options;

    async function fetchBuffer(url, headers) {
      if (hlsPipeline.hlsFetchBuffer) {
        return hlsPipeline.hlsFetchBuffer(url, headers);
      }

      const response = await fetch(url, {
        headers: headers || {},
        mode: 'cors',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }

      return response.arrayBuffer();
    }

    async function fetchText(url, headers) {
      if (hlsPipeline.hlsFetchText) {
        return hlsPipeline.hlsFetchText(url, headers);
      }

      const response = await fetch(url, {
        headers: headers || {},
        mode: 'cors',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }

      return response.text();
    }

    async function fetchSegmentBuffers(segmentUrls, headers, label, progressReporter) {
      if (segmentUrls.length === 0) {
        return [];
      }

      const buffers = new Array(segmentUrls.length).fill(null);
      let done = 0;
      let failedCount = 0;

      for (let i = 0; i < segmentUrls.length; i += SEGMENT_CONCURRENCY) {
        const batch = segmentUrls.slice(i, Math.min(i + SEGMENT_CONCURRENCY, segmentUrls.length));
        const results = await Promise.all(
          batch.map((url, index) => fetchBuffer(url, headers)
            .then((buffer) => ({ buffer, idx: i + index }))
            .catch((err) => {
              console.warn(`[OVD] DASH ${label} 分片 ${i + index} 下载失败: ${err.message}`);
              failedCount++;
              return { buffer: new ArrayBuffer(0), idx: i + index };
            }))
        );

        for (const result of results) {
          buffers[result.idx] = result.buffer;
          done++;
        }

        const percent = Math.round((done / segmentUrls.length) * 50);
        progressReporter?.progress(percent, { phase: `fetching-${label}` });

        if (i % (SEGMENT_CONCURRENCY * 4) === 0) {
          console.log(`[OVD] DASH ${label} 下载进度 ${done}/${segmentUrls.length} 失败=${failedCount}`);
        }
      }

      return buffers.filter((b) => b && b.byteLength > 0);
    }

    function concatBuffers(buffers) {
      const totalSize = buffers.reduce((sum, b) => sum + (b?.byteLength || 0), 0);
      const merged = new Uint8Array(totalSize);
      let offset = 0;
      for (const buffer of buffers) {
        if (buffer?.byteLength > 0) {
          merged.set(new Uint8Array(buffer), offset);
          offset += buffer.byteLength;
        }
      }
      return merged.buffer;
    }

    async function handleDashDownload(meta, buttonElement, progressReporter, context = {}) {
      const reporter = progressReporter || defaultProgressReporter;
      reporter?.status('正在获取 DASH manifest...');

      const mpdUrl = meta?.url;
      if (!mpdUrl) {
        throw new Error('DASH manifest URL 为空');
      }

      const headers = meta?.requestHeaders || meta?.requiredHeaders || {};
      const taskMeta = {
        sourceId: context.sourceId || 'dash',
        strategyId: context.strategyId || 'dash-merge',
        taskKey: context.taskKey || '',
        title: context.title || meta?.title || '',
        traceId: context.traceId || '',
        videoUrl: context.videoUrl || meta?.url || mpdUrl,
      };
      console.log(`[OVD] DASH 下载开始 mpdUrl=${mpdUrl}`);

      const mpdText = await fetchText(mpdUrl, headers);
      console.log(`[OVD] MPD 获取成功 长度=${mpdText.length}`);

      const manifest = mpdParser.parseMpdManifest(mpdText, mpdUrl);
      console.log(`[OVD] MPD 解析完成 adaptations=${manifest.adaptations.length} duration=${manifest.duration}`);

      const videoAdaptation = manifest.adaptations.find((a) => a.contentType === 'video');
      const audioAdaptation = manifest.adaptations.find((a) => a.contentType === 'audio');

      if (!videoAdaptation) {
        throw new Error('MPD 中未找到视频自适应集');
      }

      const videoRep = mpdParser.selectBestVideoRepresentation(videoAdaptation);
      const audioRep = audioAdaptation
        ? mpdParser.selectBestAudioRepresentation(audioAdaptation)
        : null;

      if (!videoRep) {
        throw new Error('未找到可用的视频表示');
      }

      console.log(`[OVD] DASH 选中视频: id=${videoRep.id} bandwidth=${videoRep.bandwidth} ` +
        `${videoRep.width || '?'}x${videoRep.height || '?'} codecs=${videoRep.codecs} ` +
        `segments=${videoRep.segments.length}`);
      if (audioRep) {
        console.log(`[OVD] DASH 选中音频: id=${audioRep.id} bandwidth=${audioRep.bandwidth} ` +
          `codecs=${audioRep.codecs} segments=${audioRep.segments.length}`);
      }

      reporter?.status('正在下载 DASH 视频分片...');

      let videoSegmentUrls = videoRep.segments.map((s) => s.url);
      if (videoRep.initialization) {
        videoSegmentUrls = [videoRep.initialization, ...videoSegmentUrls];
      }

      const videoBuffers = await fetchSegmentBuffers(videoSegmentUrls, headers, 'video', reporter);
      const videoData = concatBuffers(videoBuffers);
      console.log(`[OVD] DASH 视频数据大小=${(videoData.byteLength / 1024 / 1024).toFixed(2)} MB`);

      if (!audioRep || audioRep.segments.length === 0) {
        const blob = new Blob([videoData], { type: 'video/mp4' });
        const filename = videoUtils.buildMediaFilename?.({
          ext: '.mp4',
          fallback: 'dash_video',
          title: meta?.title,
        }) || 'dash_video.mp4';

        triggerBlobDownload(blob, filename, taskMeta);
        reporter?.progress(100, { phase: 'complete' });
        return { ok: true, filename };
      }

      reporter?.status('正在下载 DASH 音频分片...');

      let audioSegmentUrls = audioRep.segments.map((s) => s.url);
      if (audioRep.initialization) {
        audioSegmentUrls = [audioRep.initialization, ...audioSegmentUrls];
      }

      const audioBuffers = await fetchSegmentBuffers(audioSegmentUrls, headers, 'audio', reporter);
      const audioData = concatBuffers(audioBuffers);
      console.log(`[OVD] DASH 音频数据大小=${(audioData.byteLength / 1024 / 1024).toFixed(2)} MB`);

      const estimatedTotal = videoData.byteLength + audioData.byteLength;
      if (estimatedTotal > MAX_MERGE_SIZE) {
        throw new Error(
          `DASH 流总体积过大 (${(estimatedTotal / 1024 / 1024).toFixed(0)} MB)，` +
          `浏览器内合并可能失败。建议下载分离文件。`
        );
      }

      reporter?.status('正在合并 DASH 视音频...');
      console.log('[OVD] 开始合并 DASH 视音频');

      const muxer = globalThis.BilibiliMuxer || {};
      if (!muxer.mergeFmp4Streams) {
        throw new Error('合并工具未加载');
      }

      const blob = await muxer.mergeFmp4Streams(videoData, audioData, (percent) => {
        const adjustedPercent = 50 + Math.round(percent * 0.5);
        reporter?.progress(adjustedPercent, { phase: 'merging' });

        sendMessageAsync({
          phase: 'merging',
          type: 'HLS_PROGRESS_UPDATE',
          percent: adjustedPercent,
          taskMeta,
          videoUrl: taskMeta.videoUrl,
        }).catch(() => {});
      });

      const filename = videoUtils.buildMediaFilename?.({
        ext: '.mp4',
        fallback: 'dash_video',
        title: meta?.title,
      }) || 'dash_video.mp4';

      triggerBlobDownload(blob, filename, taskMeta);
      reporter?.progress(100, { phase: 'complete' });
      console.log(`[OVD] DASH 合并完成 filename=${filename} size=${(blob.size / 1024 / 1024).toFixed(2)} MB`);
      return { ok: true, filename };
    }

    return {
      download(meta, context) {
        return handleDashDownload(
          meta,
          context.buttonElement,
          context.progressReporter,
          context
        );
      },
      handleDashDownload,
      id: 'dash-merge',
      priority: 100,
    };
  }

  globalThis.__OVD_DASH_STRATEGY__ = {
    createDashStrategy,
  };
})();
