'use strict';

(() => {
  if (globalThis.__OVD_HLS_STRATEGY__) {
    return;
  }

  const constants = globalThis.__OVD_CONSTANTS__ || {};

  function createHlsDelegateHandler(options = {}) {
    const {
      emitRuntimeMessage = () => {},
      getFloatButton = () => null,
      hlsPipeline = {},
      triggerBlobDownload = () => {},
    } = options;

    async function handle(m3u8Url, filename, headers, taskMeta = {}, requestOptions = {}) {
      console.log(`[OVD] HLS 委托下载开始 url=${m3u8Url} filename=${filename}`);
      const sourceUrl = m3u8Url;

      // 页面上下文请求带上站点 Cookie（Cloudflare 等 CDN 防护的常见校验项），
      // 若目标站点不接受带凭证的跨域请求，pipeline 会自动退化为默认凭证模式。
      const fetchOptions = requestOptions?.fetchOptions || { credentials: 'include' };

      let m3u8Text = await hlsPipeline.hlsFetchText(m3u8Url, headers, fetchOptions);
      console.log(`[OVD] m3u8 获取成功 长度=${m3u8Text.length}`);

      if (m3u8Text.includes('#EXT-X-STREAM-INF')) {
        const mediaUrl = hlsPipeline.selectBestHlsStream(m3u8Text, m3u8Url);
        console.log(`[OVD] Master Playlist，选择最优流: ${mediaUrl}`);
        m3u8Text = await hlsPipeline.hlsFetchText(mediaUrl, headers, fetchOptions);
        m3u8Url = mediaUrl;
      }

      const keyInfo = await hlsPipeline.parseHlsEncryption(m3u8Text, m3u8Url, headers, fetchOptions);
      if (keyInfo) {
        console.log('[OVD] 检测到 AES-128 加密');
      }

      const playlist = hlsPipeline.parseHlsPlaylist(m3u8Text, m3u8Url);
      const { segments } = playlist;
      const output = hlsPipeline.inferHlsOutputProfile(playlist);
      console.log(`[OVD] 分片数 ${segments.length} 格式=${output.ext} initSegment=${!!playlist.initSegmentUrl}`);

      if (segments.length === 0) {
        throw new Error('m3u8 中没有找到分片');
      }

      const prefixBuffers = [];
      if (playlist.initSegmentUrl) {
        prefixBuffers.push(await hlsPipeline.hlsFetchBuffer(playlist.initSegmentUrl, headers, fetchOptions));
      }

      const concurrency = constants.HLS_SEGMENT_CONCURRENCY || 5;
      const buffers = new Array(segments.length).fill(null);
      let done = 0;
      let failedCount = 0;

      for (let i = 0; i < segments.length; i += concurrency) {
        const batch = segments.slice(i, Math.min(i + concurrency, segments.length));
        const results = await Promise.all(
          batch.map((url, index) => hlsPipeline.hlsFetchBuffer(url, headers, fetchOptions)
            .then((buffer) => ({ buffer, idx: i + index }))
            .catch((err) => {
              console.warn(`[OVD] 分片 ${i + index} 下载失败: ${err.message}`);
              failedCount++;
              return { buffer: new ArrayBuffer(0), idx: i + index };
            }))
        );

        for (const result of results) {
          buffers[result.idx] = result.buffer;
          done++;
        }

        const percent = Math.min(95, Math.round((done / segments.length) * 95));
        if (i % (concurrency * 4) === 0) {
          console.log(`[OVD] 委托下载进度 ${done}/${segments.length} 失败=${failedCount}`);
        }

        emitRuntimeMessage({
          percent,
          phase: 'segments',
          taskMeta,
          type: 'HLS_PROGRESS_UPDATE',
          videoUrl: taskMeta.videoUrl || sourceUrl,
        });
        getFloatButton()?.showProgress(percent);
      }

      let finalBuffers = buffers;
      if (keyInfo) {
        finalBuffers = await hlsPipeline.decryptHlsSegments(buffers, keyInfo);
      }
      finalBuffers = prefixBuffers.concat(finalBuffers);

      const totalSize = finalBuffers.reduce((sum, buffer) => sum + (buffer?.byteLength || 0), 0);
      const merged = new Uint8Array(totalSize);
      let offset = 0;

      for (const buffer of finalBuffers) {
        if (buffer?.byteLength > 0) {
          merged.set(new Uint8Array(buffer), offset);
          offset += buffer.byteLength;
        }
      }

      const blob = new Blob([merged], { type: output.mimeType });
      const finalFilename = hlsPipeline.ensureExtension(filename, output.ext);
      console.log(`[OVD] 委托下载完成 合并大小=${(merged.byteLength / 1024 / 1024).toFixed(2)} MB 触发下载 filename=${finalFilename}`);

      const downloadResult = await Promise.resolve(triggerBlobDownload(blob, finalFilename, taskMeta))
        .catch((err) => {
          console.warn(`[OVD] 触发浏览器下载失败: ${err.message}`);
          return { ok: false, error: err.message };
        });

      if (downloadResult?.ok === false) {
        throw new Error(downloadResult.error || '浏览器下载提交失败');
      }

      emitRuntimeMessage({
        percent: 100,
        phase: 'browser-handoff',
        taskMeta,
        type: 'HLS_PROGRESS_UPDATE',
        videoUrl: taskMeta.videoUrl || sourceUrl,
      });
      getFloatButton()?.showProgress(100);
      return {
        downloadId: downloadResult?.downloadId ?? null,
        failedCount,
        filename: finalFilename,
        segmentCount: segments.length,
      };
    }

    return {
      handle,
    };
  }

  globalThis.__OVD_HLS_STRATEGY__ = {
    createHlsDelegateHandler,
  };
})();
