'use strict';

(() => {
  if (window.__OVD_PAGE_HTTP_UTILS__) {
    return;
  }

  const core = window.__OVD_PAGE_CORE__;
  if (!core) {
    console.error('[OVD][PAGE] page-http-utils loaded before page-core');
    return;
  }

  const {
    MSG,
    PAGE_FETCH_RETRY_DELAYS,
    YOUTUBE_PARALLEL_AUDIO_CHUNK_BYTES,
    YOUTUBE_PARALLEL_AUDIO_MIN_BYTES,
    YOUTUBE_PARALLEL_CHUNK_BYTES,
    YOUTUBE_PARALLEL_MAX_CONCURRENCY,
    YOUTUBE_PARALLEL_MIN_BYTES,
    registerMessageHandler,
    sendToExtension,
  } = core;

  const originalFetch = window.fetch.bind(window);

  function isYouTubeMediaUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.hostname.includes('googlevideo.com') || parsed.pathname.includes('/videoplayback');
    } catch {
      return false;
    }
  }

  function formatProgressBytes(bytes) {
    const value = Number(bytes) || 0;
    if (!value) return '0 B';
    if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
  }

  function mergeUint8Chunks(chunks, totalBytes = 0) {
    const size = totalBytes || chunks.reduce((sum, chunk) => sum + (chunk?.length || 0), 0);
    const merged = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      if (!chunk?.length) {
        continue;
      }
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    return merged.buffer;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseContentRangeTotal(contentRange) {
    const match = String(contentRange || '').match(/\/(\d+)$/);
    return match ? Number(match[1]) || 0 : 0;
  }

  function parseTotalBytesHintFromUrl(url) {
    if (typeof url !== 'string' || !url) {
      return 0;
    }

    try {
      const parsedUrl = new URL(url, location.href);
      const clen = Number(parsedUrl.searchParams.get('clen')) || 0;
      return clen > 0 ? clen : 0;
    } catch {
      return 0;
    }
  }

  function inferTotalBytesFromResponse(response, loadedBytesBefore = 0, fallbackTotal = 0, requestUrl = '') {
    const contentRangeTotal = parseContentRangeTotal(response?.headers?.get?.('content-range'));
    const urlTotal = parseTotalBytesHintFromUrl(requestUrl);
    if (contentRangeTotal > 0) {
      return Math.max(contentRangeTotal, urlTotal, fallbackTotal, 0);
    }

    const status = response?.status || 0;
    const contentLength = Number(response?.headers?.get?.('content-length')) || 0;
    if (status === 206 && loadedBytesBefore > 0 && contentLength > 0) {
      return Math.max(loadedBytesBefore + contentLength, urlTotal, fallbackTotal, 0);
    }

    if (status === 206) {
      return Math.max(contentLength, urlTotal, fallbackTotal, 0);
    }

    return Math.max(contentLength, urlTotal, fallbackTotal, 0);
  }

  function createRangeHeaderValue(start, end = null) {
    const offset = Math.max(0, Number(start) || 0);
    if (offset <= 0 && !Number.isFinite(end)) {
      return '';
    }

    if (Number.isFinite(end) && Number(end) >= offset) {
      return `bytes=${offset}-${Math.max(offset, Number(end) || 0)}`;
    }

    return `bytes=${offset}-`;
  }

  function createMediaProgressReporter(progressContext = null) {
    const transferId = progressContext?.transferId;
    const streamLabel = progressContext?.streamLabel || 'stream';
    const traceId = progressContext?.traceId || '';
    const itag = progressContext?.itag || '';
    const totalBytesHint = Number(progressContext?.totalBytesHint) || 0;

    if (!transferId) {
      return { report() {} };
    }

    let lastLoggedBytes = 0;
    let lastLoggedPercent = -10;
    let lastSentBytes = -1;
    let lastSentPercent = -1;

    return {
      report(loadedBytes, totalBytes, options = {}) {
        const normalizedLoaded = Math.max(0, Number(loadedBytes) || 0);
        const normalizedTotal = Math.max(0, Number(totalBytes) || totalBytesHint || 0);
        const percent = normalizedTotal > 0
          ? Math.min(100, Math.round((normalizedLoaded / normalizedTotal) * 100))
          : null;
        const force = !!options.force;

        const shouldSend =
          force ||
          normalizedLoaded === 0 ||
          normalizedLoaded === normalizedTotal ||
          normalizedLoaded - lastSentBytes >= 4 * 1024 * 1024 ||
          (percent != null && percent >= lastSentPercent + 2);

        if (shouldSend) {
          lastSentBytes = normalizedLoaded;
          if (percent != null) {
            lastSentPercent = percent;
          }

          sendToExtension({
            type: MSG.YOUTUBE_MEDIA_STREAM_PROGRESS || 'YOUTUBE_MEDIA_STREAM_PROGRESS',
            transferId,
            label: streamLabel,
            loadedBytes: normalizedLoaded,
            totalBytes: normalizedTotal,
          });
        }

        const shouldLog =
          force ||
          normalizedLoaded === 0 ||
          normalizedLoaded === normalizedTotal ||
          normalizedLoaded - lastLoggedBytes >= 32 * 1024 * 1024 ||
          (percent != null && percent >= lastLoggedPercent + 10);

        if (shouldLog) {
          lastLoggedBytes = normalizedLoaded;
          if (percent != null) {
            lastLoggedPercent = percent;
          }

          const percentLabel = percent == null ? '' : ` percent=${percent}%`;
          const totalLabel = normalizedTotal > 0
            ? ` ${formatProgressBytes(normalizedLoaded)}/${formatProgressBytes(normalizedTotal)}`
            : ` ${formatProgressBytes(normalizedLoaded)}`;
          console.log(
            `[OVD][PAGE] ${streamLabel} progress traceId=${traceId || '-'} transferId=${transferId} itag=${itag || '-'}${percentLabel}${totalLabel}`
          );
        }
      },
    };
  }

  function getParallelFetchConfig(progressContext = null) {
    const isAudioStream = progressContext?.streamLabel === 'audio';
    return {
      chunkSize: isAudioStream
        ? YOUTUBE_PARALLEL_AUDIO_CHUNK_BYTES || YOUTUBE_PARALLEL_CHUNK_BYTES
        : YOUTUBE_PARALLEL_CHUNK_BYTES,
      concurrency: YOUTUBE_PARALLEL_MAX_CONCURRENCY,
      minBytes: isAudioStream
        ? YOUTUBE_PARALLEL_AUDIO_MIN_BYTES || YOUTUBE_PARALLEL_MIN_BYTES
        : YOUTUBE_PARALLEL_MIN_BYTES,
    };
  }

  async function fetchPageBlob(url, headers) {
    return fetchPageBinary(url, headers, 'blob', 'YouTube media');
  }

  async function fetchPageArrayBuffer(url, headers, label, progressContext = null) {
    return fetchPageBinary(url, headers, 'arrayBuffer', label, progressContext);
  }

  async function fetchPageBinary(url, headers, responseType, label, progressContext = null) {
    try {
      if (isYouTubeMediaUrl(url)) {
        try {
          return await fetchPageBinaryWithParallelRanges(url, headers, responseType, label, progressContext);
        } catch (parallelError) {
          console.warn(
            `[OVD][PAGE] parallel fetch fallback label=${progressContext?.streamLabel || label} error=${parallelError.message}`
          );
        }
      }

      return await fetchPageBinaryWithFetchResumable(url, headers, responseType, label, progressContext);
    } catch (fetchError) {
      console.warn(`[OVD][PAGE] fetch failed, fallback to XHR label=${label} error=${fetchError.message}`);
      return fetchPageBinaryWithXhrRetry(url, headers, responseType, label, progressContext);
    }
  }

  async function fetchPageBinaryWithParallelRanges(url, headers, responseType, label, progressContext = null) {
    const reporter = createMediaProgressReporter(progressContext);
    const requestUrl = typeof url === 'string' && url.length > 160 ? `${url.substring(0, 160)}...` : url;
    const hintedTotalBytes = Number(progressContext?.totalBytesHint) || 0;
    const { chunkSize, concurrency, minBytes } = getParallelFetchConfig(progressContext);
    let mimeType = '';

    if (hintedTotalBytes > 0 && hintedTotalBytes < minBytes) {
      throw new Error(`size ${hintedTotalBytes} below parallel threshold`);
    }

    reporter.report(0, hintedTotalBytes, { force: true });
    console.log(
      `[OVD][PAGE] parallel fetch probe label=${progressContext?.streamLabel || label} traceId=${progressContext?.traceId || '-'} transferId=${progressContext?.transferId || '-'} itag=${progressContext?.itag || '-'} url=${requestUrl}`
    );

    const probeResponse = await originalFetch(url, {
      credentials: 'include',
      headers: buildResumablePageRequestHeaders(headers, 0, 0),
      mode: 'cors',
    });

    mimeType = probeResponse.headers?.get?.('content-type') || '';
    const totalBytes = inferTotalBytesFromResponse(probeResponse, 0, hintedTotalBytes, url);

    try {
      await probeResponse.body?.cancel?.();
    } catch (err) {
      console.warn(`[OVD][PAGE] failed to cancel probe response body: ${err.message}`);
    }

    if (probeResponse.status !== 206 || totalBytes <= 0 || totalBytes < minBytes) {
      throw new Error(`range probe unsupported status=${probeResponse.status} total=${totalBytes}`);
    }

    const segments = [];
    for (let start = 0; start < totalBytes; start += chunkSize) {
      segments.push({
        end: Math.min(totalBytes - 1, start + chunkSize - 1),
        start,
      });
    }

    const buffers = new Array(segments.length);
    let nextIndex = 0;
    let loadedBytes = 0;

    async function fetchSegment(index) {
      const segment = segments[index];
      for (let attemptIndex = 0; attemptIndex < PAGE_FETCH_RETRY_DELAYS.length; attemptIndex += 1) {
        const retryDelay = PAGE_FETCH_RETRY_DELAYS[attemptIndex];
        if (retryDelay > 0) {
          await delay(retryDelay);
        }

        try {
          const response = await originalFetch(url, {
            credentials: 'include',
            headers: buildResumablePageRequestHeaders(headers, segment.start, segment.end),
            mode: 'cors',
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }

          if (response.status !== 206) {
            throw new Error(`expected 206, got ${response.status}`);
          }

          const buffer = await response.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          buffers[index] = bytes;
          loadedBytes += bytes.byteLength;
          reporter.report(loadedBytes, totalBytes);
          return;
        } catch (error) {
          if (attemptIndex === PAGE_FETCH_RETRY_DELAYS.length - 1) {
            throw new Error(`segment ${index} failed: ${error.message}`);
          }
        }
      }
    }

    async function worker() {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= segments.length) {
          return;
        }
        await fetchSegment(index);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, segments.length) }, () => worker())
    );

    reporter.report(totalBytes, totalBytes, { force: true });
    console.log(
      `[OVD][PAGE] parallel fetch complete label=${progressContext?.streamLabel || label} traceId=${progressContext?.traceId || '-'} transferId=${progressContext?.transferId || '-'} size=${formatProgressBytes(totalBytes)} segments=${segments.length} concurrency=${Math.min(concurrency, segments.length)}`
    );

    if (responseType === 'blob') {
      return new Blob(buffers, { type: mimeType || 'application/octet-stream' });
    }

    return mergeUint8Chunks(buffers, totalBytes);
  }

  async function fetchPageBinaryWithFetchResumable(url, headers, responseType, label, progressContext = null) {
    const reporter = createMediaProgressReporter(progressContext);
    const requestUrl = typeof url === 'string' && url.length > 160 ? `${url.substring(0, 160)}...` : url;
    console.log(
      `[OVD][PAGE] resumable fetch start label=${progressContext?.streamLabel || label} traceId=${progressContext?.traceId || '-'} transferId=${progressContext?.transferId || '-'} itag=${progressContext?.itag || '-'} url=${requestUrl}`
    );

    const chunks = [];
    let loadedBytes = 0;
    let totalBytes = Number(progressContext?.totalBytesHint) || 0;
    let mimeType = '';
    reporter.report(0, totalBytes, { force: true });

    for (let attemptIndex = 0; attemptIndex < PAGE_FETCH_RETRY_DELAYS.length; attemptIndex += 1) {
      const retryDelay = PAGE_FETCH_RETRY_DELAYS[attemptIndex];
      if (retryDelay > 0) {
        console.warn(
          `[OVD][PAGE] resumable fetch retry #${attemptIndex} label=${progressContext?.streamLabel || label} traceId=${progressContext?.traceId || '-'} transferId=${progressContext?.transferId || '-'} loaded=${formatProgressBytes(loadedBytes)}`
        );
        await delay(retryDelay);
      }

      const rangeStart = loadedBytes;

      try {
        const response = await originalFetch(url, {
          credentials: 'include',
          headers: buildResumablePageRequestHeaders(headers, rangeStart),
          mode: 'cors',
        });

        if (rangeStart > 0 && response.status === 200) {
          console.warn(
            `[OVD][PAGE] resumable fetch fell back to full download label=${progressContext?.streamLabel || label} traceId=${progressContext?.traceId || '-'} transferId=${progressContext?.transferId || '-'}`
          );
          chunks.length = 0;
          loadedBytes = 0;
        }

        if (!response.ok) {
          throw new Error(`${label} fetch failed: HTTP ${response.status} ${response.statusText}`);
        }

        totalBytes = inferTotalBytesFromResponse(response, rangeStart, totalBytes, url);
        mimeType = response.headers?.get?.('content-type') || mimeType || '';

        if (!response.body || typeof response.body.getReader !== 'function') {
          const buffer = await response.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          if (rangeStart > 0 && response.status !== 206) {
            chunks.length = 0;
            loadedBytes = 0;
          }
          chunks.push(bytes);
          loadedBytes += bytes.byteLength;
          break;
        }

        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          if (value?.length) {
            chunks.push(value);
            loadedBytes += value.length;
            reporter.report(loadedBytes, totalBytes);
          }
        }

        break;
      } catch (error) {
        if (attemptIndex === PAGE_FETCH_RETRY_DELAYS.length - 1) {
          throw error;
        }
      }
    }

    const finalTotalBytes = totalBytes || loadedBytes;
    reporter.report(loadedBytes, finalTotalBytes, { force: true });
    console.log(
      `[OVD][PAGE] resumable fetch complete label=${progressContext?.streamLabel || label} traceId=${progressContext?.traceId || '-'} transferId=${progressContext?.transferId || '-'} size=${formatProgressBytes(loadedBytes)}`
    );

    if (responseType === 'blob') {
      return new Blob(chunks, { type: mimeType || 'application/octet-stream' });
    }

    return mergeUint8Chunks(chunks, loadedBytes);
  }

  function fetchPageBinaryWithXhrRetry(url, headers, responseType, label, progressContext = null) {
    return new Promise((resolve, reject) => {
      const reporter = createMediaProgressReporter(progressContext);
      let attemptIndex = 0;

      const runAttempt = () => {
        const retryDelay = PAGE_FETCH_RETRY_DELAYS[attemptIndex] || 0;
        setTimeout(() => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.responseType = responseType === 'blob' ? 'blob' : 'arraybuffer';
          xhr.withCredentials = true;

          const safeHeaders = buildPageRequestHeaders(headers);
          Object.entries(safeHeaders).forEach(([name, value]) => {
            try {
              xhr.setRequestHeader(name, value);
            } catch (err) {
              console.warn(`[OVD][PAGE] failed to set XHR header ${name}: ${err.message}`);
            }
          });

          if (responseType !== 'blob') {
            reporter.report(0, Number(progressContext?.totalBytesHint) || 0, { force: true });
            xhr.onprogress = (event) => {
              reporter.report(
                event.loaded || 0,
                event.lengthComputable ? event.total : Number(progressContext?.totalBytesHint) || 0
              );
            };
          }

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              if (responseType !== 'blob' && xhr.response) {
                const finalBytes = xhr.response?.byteLength || 0;
                reporter.report(finalBytes, finalBytes || Number(progressContext?.totalBytesHint) || 0, { force: true });
              }
              resolve(xhr.response);
              return;
            }

            if (attemptIndex >= PAGE_FETCH_RETRY_DELAYS.length - 1) {
              reject(new Error(`${label} XHR failed: HTTP ${xhr.status} ${xhr.statusText || ''}`.trim()));
              return;
            }

            attemptIndex += 1;
            runAttempt();
          };

          xhr.onerror = () => {
            if (attemptIndex >= PAGE_FETCH_RETRY_DELAYS.length - 1) {
              reject(new Error(`${label} XHR network error`));
              return;
            }

            attemptIndex += 1;
            runAttempt();
          };

          xhr.send();
        }, retryDelay);
      };

      runAttempt();
    });
  }

  function buildPageRequestHeaders(headers) {
    const safeHeaders = {};
    const blockedHeaders = new Set([
      'accept-encoding',
      'content-length',
      'host',
      'origin',
      'referer',
      'user-agent',
    ]);

    Object.entries(headers || {}).forEach(([name, value]) => {
      const key = String(name || '').toLowerCase();
      if (!key || blockedHeaders.has(key)) {
        return;
      }
      safeHeaders[name] = value;
    });

    return safeHeaders;
  }

  function buildResumablePageRequestHeaders(headers, rangeStart = 0, rangeEnd = null) {
    const requestHeaders = buildPageRequestHeaders(headers);
    const rangeValue = createRangeHeaderValue(rangeStart, rangeEnd);
    if (rangeValue) {
      requestHeaders.Range = rangeValue;
    }
    return requestHeaders;
  }

  function triggerPageBlobDownload(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename || 'youtube-video.mp4';
    link.style.display = 'none';
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (err) {
        console.warn(`[OVD][PAGE] failed to revoke page object URL: ${err.message}`);
      }
    }, 60000);
  }

  function safeUrlPathname(url) {
    try {
      return new URL(url, location.href).pathname || '';
    } catch {
      return '';
    }
  }

  function inferExtension(url, mimeType) {
    const pathname = safeUrlPathname(url).toLowerCase();
    if (/\.(mp4|webm|m4a|mp3|aac|ogg|wav|flv|m4v|mkv)$/.test(pathname)) {
      return pathname.split('.').pop();
    }

    const normalizedMimeType = String(mimeType || '').toLowerCase();
    if (normalizedMimeType.includes('mp4')) return 'mp4';
    if (normalizedMimeType.includes('webm')) return 'webm';
    if (normalizedMimeType.includes('mpeg')) return 'mp3';
    if (normalizedMimeType.includes('ogg')) return 'ogg';
    if (normalizedMimeType.includes('wav')) return 'wav';
    return 'mp4';
  }

  function inferDownloadFilename(url, mimeType) {
    const extension = inferExtension(url, mimeType);
    const pathname = safeUrlPathname(url);
    const baseName = pathname.split('/').filter(Boolean).pop()?.replace(/\.[a-z0-9]+$/i, '') || 'youtube-video';
    return `${baseName}.${extension}`;
  }

  function uint8ArrayToBase64(uint8Array) {
    let binary = '';
    const step = 0x8000;

    for (let i = 0; i < uint8Array.length; i += step) {
      const slice = uint8Array.subarray(i, i + step);
      binary += String.fromCharCode(...slice);
    }

    return btoa(binary);
  }

  function sendArrayBufferChunks(transferId, label, buffer) {
    const chunkSize = 256 * 1024;
    const bytes = new Uint8Array(buffer);

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      sendToExtension({
        type: MSG.YOUTUBE_MEDIA_STREAM_CHUNK || 'YOUTUBE_MEDIA_STREAM_CHUNK',
        transferId,
        label,
        chunkBase64: uint8ArrayToBase64(chunk),
      });
    }
  }

  async function handleYouTubeDirectDownload(payload) {
    const { traceId = '', transferId, url, filename, headers } = payload || {};
    if (!transferId || !url) {
      sendToExtension({
        type: MSG.YOUTUBE_DIRECT_DOWNLOAD_RESULT || 'YOUTUBE_DIRECT_DOWNLOAD_RESULT',
        transferId,
        ok: false,
        error: 'Missing YouTube download params',
      });
      return;
    }

    console.log(
      `[OVD][PAGE] direct download start traceId=${traceId || '-'} transferId=${transferId} url=${url}`
    );

    try {
      const blob = await fetchPageBlob(url, headers);
      triggerPageBlobDownload(blob, filename || inferDownloadFilename(url, blob.type));
      sendToExtension({
        type: MSG.YOUTUBE_DIRECT_DOWNLOAD_RESULT || 'YOUTUBE_DIRECT_DOWNLOAD_RESULT',
        transferId,
        ok: true,
        filename,
      });
    } catch (error) {
      console.error(
        `[OVD][PAGE] direct download failed traceId=${traceId || '-'} transferId=${transferId}: ${error.message}`
      );
      sendToExtension({
        type: MSG.YOUTUBE_DIRECT_DOWNLOAD_RESULT || 'YOUTUBE_DIRECT_DOWNLOAD_RESULT',
        transferId,
        ok: false,
        error: error.message,
      });
    }
  }

  async function handleYouTubeMediaStreamsRequest(payload) {
    const { traceId = '', transferId, videoUrl, audioUrl, headers, videoInfo, audioInfo } = payload || {};
    if (!transferId || !videoUrl || !audioUrl) {
      sendToExtension({
        type: MSG.YOUTUBE_MEDIA_STREAM_ERROR || 'YOUTUBE_MEDIA_STREAM_ERROR',
        transferId,
        error: 'Missing YouTube stream urls',
      });
      return;
    }

    console.log(`[OVD][PAGE] stream fetch start traceId=${traceId || '-'} transferId=${transferId}`);
    sendToExtension({ type: MSG.YOUTUBE_MEDIA_STREAM_START || 'YOUTUBE_MEDIA_STREAM_START', transferId });

    try {
      const [videoBuffer, audioBuffer] = await Promise.all([
        fetchPageArrayBuffer(videoUrl, headers, 'YouTube video stream', {
          itag: videoInfo?.itag || '',
          streamLabel: 'video',
          totalBytesHint: Number(videoInfo?.contentLength) || 0,
          traceId,
          transferId,
        }),
        fetchPageArrayBuffer(audioUrl, headers, 'YouTube audio stream', {
          itag: audioInfo?.itag || '',
          streamLabel: 'audio',
          totalBytesHint: Number(audioInfo?.contentLength) || 0,
          traceId,
          transferId,
        }),
      ]);

      sendArrayBufferChunks(transferId, 'video', videoBuffer);
      sendArrayBufferChunks(transferId, 'audio', audioBuffer);
      sendToExtension({ type: MSG.YOUTUBE_MEDIA_STREAM_FINISH || 'YOUTUBE_MEDIA_STREAM_FINISH', transferId });
      console.log(
        `[OVD][PAGE] stream fetch complete traceId=${traceId || '-'} transferId=${transferId} video=${(videoBuffer.byteLength / 1024 / 1024).toFixed(2)}MB audio=${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)}MB`
      );
    } catch (error) {
      console.error(
        `[OVD][PAGE] stream fetch failed traceId=${traceId || '-'} transferId=${transferId}: ${error.message}`
      );
      sendToExtension({
        type: MSG.YOUTUBE_MEDIA_STREAM_ERROR || 'YOUTUBE_MEDIA_STREAM_ERROR',
        transferId,
        error: error.message,
      });
    }
  }

  registerMessageHandler(MSG.YOUTUBE_DIRECT_DOWNLOAD || 'YOUTUBE_DIRECT_DOWNLOAD', handleYouTubeDirectDownload);
  registerMessageHandler(
    MSG.YOUTUBE_MEDIA_STREAMS_REQUEST || 'YOUTUBE_MEDIA_STREAMS_REQUEST',
    handleYouTubeMediaStreamsRequest
  );

  window.__OVD_PAGE_HTTP_UTILS__ = {
    buildPageRequestHeaders,
    buildResumablePageRequestHeaders,
    fetchPageArrayBuffer,
    fetchPageBinary,
    fetchPageBlob,
    formatProgressBytes,
    inferDownloadFilename,
    originalFetch,
    triggerPageBlobDownload,
    uint8ArrayToBase64,
  };
})();
