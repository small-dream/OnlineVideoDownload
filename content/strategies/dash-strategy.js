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
      injectRequestHeaders = null,
      sendMessageAsync = () => Promise.reject(new Error('sendMessageAsync unavailable')),
      triggerBlobDownload = () => {},
      videoUtils = {},
      mpdParser = {},
      progressReporter: defaultProgressReporter = null,
    } = options;

    async function fetchBuffer(url, headers, range) {
      if (hlsPipeline.hlsFetchBuffer) {
        return hlsPipeline.hlsFetchBuffer(url, headers, { range });
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

    async function fetchSegmentBuffers(segmentUrls, headers, label, progressReporter, signal = null) {
      if (segmentUrls.length === 0) {
        return [];
      }

      // 与 HLS 共用的 fail-fast 下载：分片重试 + 超阈值中止，不产出含空洞的文件
      const { buffers, failedCount, retriedCount } = await hlsPipeline.downloadHlsSegments(segmentUrls, {
        concurrency: SEGMENT_CONCURRENCY,
        fetchBuffer: (url, range) => fetchBuffer(url, headers, range),
        signal,
        onProgress: (done, total) => {
          const percent = Math.round((done / total) * 50);
          progressReporter?.progress(percent, { phase: `fetching-${label}` });
        },
      });

      if (failedCount > 0 || retriedCount > 0) {
        console.warn(`[OVD] DASH ${label} 分片下载完成 失败=${failedCount} 重试成功=${retriedCount}`);
        progressReporter?.status(`DASH ${label} 有 ${failedCount} 个分片下载失败（未超阈值），已跳过`);
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

    /**
     * 选取目标内容类型的表示：优先按 Period 分组收集（多 Period 清单），
     * 旧版解析器只返回扁平 adaptations 时退回单 Period 逻辑。
     */
    function pickRepresentations(manifest, contentType) {
      if (typeof mpdParser.collectRepresentationsAcrossPeriods === 'function') {
        const collected = mpdParser.collectRepresentationsAcrossPeriods(manifest, contentType);
        if (collected?.representations?.length) {
          return collected;
        }
      }

      const adaptation = (manifest?.adaptations || []).find((item) => item.contentType === contentType);
      if (!adaptation) {
        return { hasMultipleInitializations: false, representations: [] };
      }

      const rep = contentType === 'audio'
        ? mpdParser.selectBestAudioRepresentation?.(adaptation)
        : mpdParser.selectBestVideoRepresentation?.(adaptation);

      return {
        hasMultipleInitializations: false,
        representations: rep ? [rep] : [],
      };
    }

    /**
     * 把（可能跨多个 Period 的）表示展开为待下载条目。
     * 带 byteRange 的条目用对象形式透传 Range，其余保持字符串以兼容旧管线。
     */
    function buildSegmentEntries(representations) {
      const entries = [];
      const pushEntry = (url, byteRange) => {
        if (!url) {
          return;
        }
        entries.push(byteRange ? { byteRange, url } : url);
      };

      for (const rep of representations) {
        pushEntry(rep.initialization, rep.initializationRange || null);
        for (const segment of rep.segments || []) {
          pushEntry(segment?.url, segment?.byteRange || null);
        }
      }

      return entries;
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

      // 防盗链 CDN 需要 Referer/CORS：content script 无法直接写 DNR 规则，
      // 通过 background 注册临时规则并在下载结束后清理。
      const cleanupHeaderRules = injectRequestHeaders
        ? await injectRequestHeaders(mpdUrl, headers).catch((err) => {
          console.warn(`[OVD] DASH 请求头注入失败: ${err.message}`);
          return async () => {};
        })
        : async () => {};

      async function runDashDownload() {
        const signal = context.signal || null;
        if (signal?.aborted) {
          throw hlsPipeline.createAbortError?.() || Object.assign(new Error('下载已取消'), { code: 'DOWNLOAD_ABORTED' });
        }

        const mpdText = await fetchText(mpdUrl, headers);
      console.log(`[OVD] MPD 获取成功 长度=${mpdText.length}`);

      const manifest = mpdParser.parseMpdManifest(mpdText, mpdUrl);
      console.log(`[OVD] MPD 解析完成 adaptations=${manifest.adaptations.length} periods=${manifest.periods?.length || 1} duration=${manifest.duration}`);

      const videoPick = pickRepresentations(manifest, 'video');
      const audioPick = pickRepresentations(manifest, 'audio');
      const videoRep = videoPick.representations[0] || null;
      const audioRep = audioPick.representations[0] || null;

      if (!videoRep) {
        throw new Error('MPD 中未找到视频自适应集');
      }

      if (videoPick.hasMultipleInitializations || audioPick.hasMultipleInitializations) {
        reporter?.status('该清单包含多个 Period，已按顺序拼接分片；如播放不连续请下载分离文件');
      }

      console.log(`[OVD] DASH 选中视频: id=${videoRep.id} bandwidth=${videoRep.bandwidth} ` +
        `${videoRep.width || '?'}x${videoRep.height || '?'} codecs=${videoRep.codecs} ` +
        `periods=${videoPick.representations.length} segments=${videoPick.representations.reduce((sum, rep) => sum + (rep.segments?.length || 0), 0)}`);
      if (audioRep) {
        console.log(`[OVD] DASH 选中音频: id=${audioRep.id} bandwidth=${audioRep.bandwidth} ` +
          `codecs=${audioRep.codecs} periods=${audioPick.representations.length} segments=${audioPick.representations.reduce((sum, rep) => sum + (rep.segments?.length || 0), 0)}`);
      }

      reporter?.status('正在下载 DASH 视频分片...');

      const videoBuffers = await fetchSegmentBuffers(
        buildSegmentEntries(videoPick.representations),
        headers,
        'video',
        reporter,
        signal
      );
      const videoData = concatBuffers(videoBuffers);
      console.log(`[OVD] DASH 视频数据大小=${(videoData.byteLength / 1024 / 1024).toFixed(2)} MB`);

      if (!audioRep || audioPick.representations.every((rep) => (rep.segments || []).length === 0)) {
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

      const audioBuffers = await fetchSegmentBuffers(
        buildSegmentEntries(audioPick.representations),
        headers,
        'audio',
        reporter,
        signal
      );
      const audioData = concatBuffers(audioBuffers);
      console.log(`[OVD] DASH 音频数据大小=${(audioData.byteLength / 1024 / 1024).toFixed(2)} MB`);

      const estimatedTotal = videoData.byteLength + audioData.byteLength;
      if (estimatedTotal > MAX_MERGE_SIZE) {
        const tooLarge = new Error(
          `DASH 流总体积过大 (${(estimatedTotal / 1024 / 1024).toFixed(0)} MB)，` +
          `浏览器内合并可能失败。建议下载分离文件。`
        );
        tooLarge.code = 'DASH_OUTPUT_TOO_LARGE';
        throw tooLarge;
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

      try {
        return await runDashDownload();
      } finally {
        await cleanupHeaderRules();
      }
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
