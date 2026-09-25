'use strict';

(() => {
  if (globalThis.__OVD_HLS_STRATEGY__) {
    return;
  }

  const constants = globalThis.__OVD_CONSTANTS__ || {};
  const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
  const MSG = messageTypes;

  function createHlsDelegateHandler(options = {}) {
    const {
      emitRuntimeMessage = () => {},
      getFloatButton = () => null,
      hlsPipeline = {},
      triggerBlobDownload = () => {},
    } = options;

    function concatBuffers(buffers) {
      const totalSize = buffers.reduce((sum, buffer) => sum + (buffer?.byteLength || 0), 0);
      const merged = new Uint8Array(totalSize);
      let offset = 0;
      for (const buffer of buffers) {
        if (buffer?.byteLength > 0) {
          merged.set(new Uint8Array(buffer), offset);
          offset += buffer.byteLength;
        }
      }
      return merged;
    }

    async function handle(m3u8Url, filename, headers, taskMeta = {}, requestOptions = {}) {
      console.log(`[OVD] HLS 委托下载开始 url=${m3u8Url} filename=${filename}`);
      const sourceUrl = m3u8Url;

      // 页面上下文请求带上站点 Cookie（Cloudflare 等 CDN 防护的常见校验项），
      // 若目标站点不接受带凭证的跨域请求，pipeline 会自动退化为默认凭证模式。
      const fetchOptions = requestOptions?.fetchOptions || { credentials: 'include' };
      const requestedQuality = requestOptions?.quality || requestOptions?.variantUrl || '';

      const reportStatus = (message, level = 'info') => {
        emitRuntimeMessage({
          level,
          message,
          taskMeta,
          type: MSG.SOURCE_DOWNLOAD_STATUS || 'SOURCE_DOWNLOAD_STATUS',
          videoUrl: taskMeta.videoUrl || sourceUrl,
        });
        getFloatButton()?.showMessage?.(message, level === 'error');
      };

      let m3u8Text = await hlsPipeline.hlsFetchText(m3u8Url, headers, fetchOptions);
      console.log(`[OVD] m3u8 获取成功 长度=${m3u8Text.length}`);

      let audioRenditionUrl = null;
      let selectedQuality = '';

      if (m3u8Text.includes('#EXT-X-STREAM-INF')) {
        const master = hlsPipeline.parseHlsMasterPlaylist?.(m3u8Text, m3u8Url)
          || { audioRenditions: [], isMaster: false, variants: [] };
        const variant = hlsPipeline.selectHlsVariant?.(master.variants, m3u8Url, { quality: requestedQuality });

        if (!variant) {
          throw new Error('Master Playlist 中没有可用画质');
        }

        selectedQuality = variant.label || '';
        console.log(`[OVD] Master Playlist 选中画质=${selectedQuality} 带宽=${variant.bandwidth} url=${variant.url}`);

        const audioRendition = hlsPipeline.findMatchingAudioRendition?.(master, variant);
        if (audioRendition?.uri) {
          audioRenditionUrl = audioRendition.uri;
          console.log(`[OVD] 检测到独立音轨 group=${audioRendition.groupId} url=${audioRenditionUrl}`);
        }

        m3u8Url = variant.url;
        m3u8Text = await hlsPipeline.hlsFetchText(m3u8Url, headers, fetchOptions);
      }

      const playlist = hlsPipeline.parseHlsPlaylist(m3u8Text, m3u8Url);
      const { segments } = playlist;
      const output = hlsPipeline.inferHlsOutputProfile(playlist);
      console.log(`[OVD] 分片数 ${segments.length} 格式=${output.ext} initSegment=${!!playlist.initSegmentUrl} live=${!!playlist.isLive}`);

      if (segments.length === 0) {
        throw new Error('m3u8 中没有找到分片');
      }

      if (playlist.isLive) {
        // 直播流没有 ENDLIST，只能下载当前窗口，必须显式告知用户而不是静默产出残片
        reportStatus(`检测到直播流，仅能下载当前播放窗口的 ${segments.length} 个分片`, 'info');
        emitRuntimeMessage({
          isLive: true,
          live: true,
          taskMeta,
          type: MSG.HLS_PROGRESS_UPDATE || 'HLS_PROGRESS_UPDATE',
          percent: 0,
          phase: 'live-window',
          videoUrl: taskMeta.videoUrl || sourceUrl,
        });
      }

      if (playlist.discontinuityCount > 0) {
        console.log(`[OVD] 播放列表包含 ${playlist.discontinuityCount} 个 discontinuity 标记`);
      }

      const keyInfo = await resolveKeyInfo(playlist, m3u8Text, m3u8Url, headers, fetchOptions);
      if (keyInfo) {
        console.log(`[OVD] 检测到 AES-128 加密（${playlist.keys?.length || 1} 个密钥）`);
      }

      const decryptor = keyInfo && typeof hlsPipeline.createSegmentDecryptor === 'function'
        ? hlsPipeline.createSegmentDecryptor(keyInfo)
        : null;

      // 需要把独立音轨合并进视频时必须整体持有视频数据（fMP4 muxer 接口所限）；
      // 其余情况走顺序写入 sink，避免再拼一份全量 Uint8Array。
      const audioMergePlanned = !!audioRenditionUrl
        && output.ext === '.mp4'
        && typeof globalThis.BilibiliMuxer?.mergeFmp4Streams === 'function';
      // 独立音轨：能合并就合并（需要整体持有视频数据），否则单独落盘
      const audioHandling = !audioRenditionUrl
        ? 'none'
        : (audioMergePlanned ? 'merge' : 'separate');
      const sink = audioHandling !== 'merge' && typeof hlsPipeline.createInMemorySink === 'function'
        ? hlsPipeline.createInMemorySink()
        : null;

      const prefixBuffers = [];
      if (playlist.initSegmentUrl) {
        const initBuffer = await hlsPipeline.hlsFetchBuffer(playlist.initSegmentUrl, headers, {
          ...fetchOptions,
          range: playlist.initSegmentByteRange,
        });
        if (sink) {
          await sink.write(initBuffer);
        } else {
          prefixBuffers.push(initBuffer);
        }
      }

      const { buffers, failedCount, retriedCount } = await downloadSegments(
        playlist,
        headers,
        fetchOptions,
        taskMeta,
        sourceUrl,
        requestOptions,
        { sink, transform: decryptor }
      );
      console.log(`[OVD] 分片下载完成 总数=${segments.length} 失败=${failedCount} 重试成功=${retriedCount}`);

      let blob;
      let mergedBytes = 0;
      let mergedAudio = false;
      let audioSavedSeparately = false;
      let audioSeparateFilename = '';

      if (audioMergePlanned) {
        let finalBuffers = buffers || [];
        if (keyInfo && !decryptor) {
          finalBuffers = await hlsPipeline.decryptHlsSegments(finalBuffers, keyInfo);
        }
        finalBuffers = prefixBuffers.concat(finalBuffers);
        let merged = concatBuffers(finalBuffers);
        mergedBytes = merged.byteLength;

        try {
          const audioResult = await downloadAudioRendition(
            audioRenditionUrl,
            headers,
            fetchOptions,
            taskMeta,
            merged,
            output,
            filename,
            'merge'
          );
          if (audioResult) {
            if (audioResult.separate) {
              // 无法合并时不丢音轨：视频保持纯画面，音轨单独落盘
              audioSavedSeparately = true;
              audioSeparateFilename = audioResult.filename;
            } else {
              merged = audioResult;
              mergedBytes = audioResult.byteLength;
              mergedAudio = true;
            }
          }
        } catch (err) {
          console.warn(`[OVD] 独立音轨合并失败，回退为纯视频文件: ${err.message}`);
          reportStatus(`独立音轨合并失败（${err.message}），将只保存视频画面`, 'info');
        }

        blob = new Blob([merged], { type: output.mimeType });
      } else if (sink && sink.byteLength > 0 && typeof sink.toBlob === 'function') {
        mergedBytes = sink.byteLength;
        blob = sink.toBlob(output.mimeType);
      } else {
        // 兜底：下载管线未使用 sink（旧实现）时仍按缓冲数组拼接
        let finalBuffers = buffers || [];
        if (keyInfo && !decryptor) {
          finalBuffers = await hlsPipeline.decryptHlsSegments(finalBuffers, keyInfo);
        }
        finalBuffers = prefixBuffers.concat(finalBuffers);
        const merged = concatBuffers(finalBuffers);
        mergedBytes = merged.byteLength;
        blob = new Blob([merged], { type: output.mimeType });
      }

      const finalFilename = hlsPipeline.ensureExtension(filename, output.ext);

      // 无法合并（视频非 fMP4）时把音轨单独保存，避免整条音轨被静默丢弃
      if (audioHandling === 'separate') {
        const separateResult = await downloadAudioRendition(
          audioRenditionUrl,
          headers,
          fetchOptions,
          taskMeta,
          null,
          output,
          filename,
          'separate'
        ).catch((err) => {
          console.warn(`[OVD] 独立音轨单独保存失败: ${err.message}`);
          return null;
        });

        if (separateResult?.separate) {
          audioSavedSeparately = true;
          audioSeparateFilename = separateResult.filename;
        }
      }

      console.log(`[OVD] 委托下载完成 合并大小=${(mergedBytes / 1024 / 1024).toFixed(2)} MB 触发下载 filename=${finalFilename}`);

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
        audioSavedSeparately,
        audioSeparateFilename,
        audioMerged: mergedAudio,
        downloadId: downloadResult?.downloadId ?? null,
        failedCount,
        filename: finalFilename,
        isLive: !!playlist.isLive,
        quality: selectedQuality,
        segmentCount: segments.length,
      };
    }

    /**
     * 读取 Master Playlist 的可用画质，供 popup 的画质下拉框使用。
     * 非 Master Playlist（单码率流）返回空列表，由调用方显示"自动"。
     */
    async function fetchQualities(m3u8Url, headers = {}, requestOptions = {}) {
      const fetchOptions = requestOptions?.fetchOptions || { credentials: 'include' };
      const text = await hlsPipeline.hlsFetchText(m3u8Url, headers, fetchOptions);
      const master = hlsPipeline.parseHlsMasterPlaylist?.(text, m3u8Url) || null;

      if (!master?.isMaster) {
        return { isMaster: false, qualities: [] };
      }

      return {
        isMaster: true,
        qualities: master.variants.map((variant) => ({
          bandwidth: variant.bandwidth,
          detail: variant.detail,
          height: variant.height,
          label: variant.label,
          url: variant.url,
        })),
      };
    }

    /**
     * 解析并抓取解密密钥。
     * 优先使用支持密钥轮换的 resolveHlsKeys，旧管线缺少该能力时退回单密钥接口。
     */
    async function resolveKeyInfo(playlist, playlistText, playlistUrl, headers, fetchOptions) {
      const keyEntries = playlist.keys || [];
      if (keyEntries.length > 0 && typeof hlsPipeline.resolveHlsKeys === 'function') {
        return {
          keys: await hlsPipeline.resolveHlsKeys(keyEntries, headers, fetchOptions),
          segments: playlist.segments,
        };
      }

      if (!playlist.isEncrypted) {
        return null;
      }

      const legacy = await hlsPipeline.parseHlsEncryption?.(playlistText, playlistUrl, headers, fetchOptions);
      return legacy || null;
    }

    async function downloadSegments(playlist, headers, fetchOptions, taskMeta, sourceUrl, requestOptions = {}, sinkOptions = {}) {
      const total = playlist.segments.length;
      return hlsPipeline.downloadHlsSegments(playlist.segments, {
        concurrency: constants.HLS_SEGMENT_CONCURRENCY || 5,
        fetchBuffer: (url, range) => hlsPipeline.hlsFetchBuffer(url, headers, { ...fetchOptions, range }),
        maxTotalBytes: constants.MAX_IN_PAGE_MERGE_BYTES || 1500 * 1024 * 1024,
        signal: requestOptions.signal || null,
        sink: sinkOptions.sink || null,
        transform: sinkOptions.transform || null,
        onProgress: (done, totalCount, stats) => {
          const percent = Math.min(95, Math.round((done / totalCount) * 95));
          const message = {
            percent,
            phase: 'segments',
            taskMeta,
            type: 'HLS_PROGRESS_UPDATE',
            videoUrl: taskMeta.videoUrl || sourceUrl,
          };
          // 分片失败/重试未超阈值时通过进度消息告知用户
          if (stats?.failedCount > 0 || stats?.retriedCount > 0) {
            message.failedCount = stats.failedCount;
            message.retriedCount = stats.retriedCount;
            message.warning = `${stats.failedCount}/${totalCount} 个分片下载失败，${stats.retriedCount} 个分片重试后成功`;
          }
          emitRuntimeMessage(message);
          getFloatButton()?.showProgress(percent);
        },
        retryDelays: constants.HLS_SEGMENT_RETRY_DELAYS,
      }).then((result) => result || {
        buffers: [],
        failedCount: 0,
        retriedCount: 0,
        segments: playlist.segments,
        sink: null,
      })
        .catch((err) => {
          if (err?.code === 'HLS_SEGMENT_DOWNLOAD_FAILED') {
            err.totalSegments = err.totalSegments ?? total;
          }
          throw err;
        });
    }

    /**
     * 下载独立音轨并按 fMP4 合并进视频数据。
     * 仅当两路都是带 init segment 的 fMP4（.m4s/.mp4）且 muxer 可用时才合并，
     * 否则回退为纯视频并提示用户。
     */
    async function downloadAudioRendition(audioUrl, headers, fetchOptions, taskMeta, videoBytes, output, filename, mode = 'merge') {
      const muxer = globalThis.BilibiliMuxer || {};
      const audioText = await hlsPipeline.hlsFetchText(audioUrl, headers, fetchOptions);
      const audioPlaylist = hlsPipeline.parseHlsPlaylist(audioText, audioUrl);
      if (!audioPlaylist.segments.length) {
        console.warn('[OVD] 独立音轨播放列表为空，跳过合并');
        return null;
      }

      const keyInfo = await resolveKeyInfo(audioPlaylist, audioText, audioUrl, headers, fetchOptions);
      const prefixBuffers = [];
      if (audioPlaylist.initSegmentUrl) {
        prefixBuffers.push(await hlsPipeline.hlsFetchBuffer(audioPlaylist.initSegmentUrl, headers, {
          ...fetchOptions,
          range: audioPlaylist.initSegmentByteRange,
        }));
      }

      const { buffers } = await hlsPipeline.downloadHlsSegments(audioPlaylist.segments, {
        concurrency: constants.HLS_SEGMENT_CONCURRENCY || 5,
        fetchBuffer: (url, range) => hlsPipeline.hlsFetchBuffer(url, headers, { ...fetchOptions, range }),
        maxTotalBytes: constants.MAX_IN_PAGE_MERGE_BYTES || 1500 * 1024 * 1024,
        retryDelays: constants.HLS_SEGMENT_RETRY_DELAYS,
      });

      let audioBuffers = buffers;
      if (keyInfo) {
        audioBuffers = await hlsPipeline.decryptHlsSegments(buffers, keyInfo);
      }

      const audioBytes = concatBuffers(prefixBuffers.concat(audioBuffers));

      // 无法在浏览器内合并时不丢音轨：把音轨单独保存为 _audio 文件
      if (mode === 'separate' || output.ext !== '.mp4' || typeof muxer.mergeFmp4Streams !== 'function') {
        return saveAudioSeparately(audioBytes, audioPlaylist, filename, taskMeta, audioUrl);
      }

      try {
        const blob = await muxer.mergeFmp4Streams(
          videoBytes.buffer.slice(videoBytes.byteOffset, videoBytes.byteOffset + videoBytes.byteLength),
          audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength),
          (percent) => getFloatButton()?.showProgress(percent)
        );
        const mergedBuffer = await blob.arrayBuffer();
        console.log(`[OVD] 独立音轨合并完成 大小=${(mergedBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
        return new Uint8Array(mergedBuffer);
      } catch (err) {
        // 合并失败也不再丢音轨：降级为单独保存
        console.warn(`[OVD] 独立音轨合并失败（${err.message}），改为单独保存音轨文件`);
        return saveAudioSeparately(audioBytes, audioPlaylist, filename, taskMeta, audioUrl);
      }
    }

    /** 分离文件降级：音轨单独落盘，返回 { separate: true, filename } */
    async function saveAudioSeparately(audioBytes, audioPlaylist, filename, taskMeta, audioUrl) {
      const audioOutput = hlsPipeline.inferHlsOutputProfile(audioPlaylist);
      const audioFilename = hlsPipeline.ensureExtension(`${filename}_audio`, audioOutput.ext);
      const audioBlob = new Blob([audioBytes], { type: audioOutput.mimeType });

      emitRuntimeMessage({
        message: '独立音轨无法在浏览器内合并，已单独保存为 _audio 文件',
        taskMeta,
        type: MSG.SOURCE_DOWNLOAD_STATUS || 'SOURCE_DOWNLOAD_STATUS',
        videoUrl: taskMeta.videoUrl || audioUrl,
      });

      const audioResult = await Promise.resolve(triggerBlobDownload(audioBlob, audioFilename, taskMeta))
        .catch((err) => ({ error: err.message, ok: false }));
      if (audioResult?.ok === false) {
        console.warn(`[OVD] 独立音轨单独保存失败: ${audioResult.error}`);
        return null;
      }

      console.log(`[OVD] 独立音轨已单独保存 filename=${audioFilename} size=${(audioBytes.byteLength / 1024 / 1024).toFixed(2)} MB`);
      return { filename: audioFilename, separate: true };
    }

    return {
      fetchQualities,
      handle,
    };
  }

  globalThis.__OVD_HLS_STRATEGY__ = {
    createHlsDelegateHandler,
  };
})();
