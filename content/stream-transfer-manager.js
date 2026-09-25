'use strict';

(() => {
  if (globalThis.__OVD_STREAM_TRANSFER_MANAGER__) {
    return;
  }

  const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
  const MSG = messageTypes;

  function createStreamTransferManager(options = {}) {
    const {
      postMessageToPage = () => {},
      sendMessageAsync = () => Promise.reject(new Error('sendMessageAsync unavailable')),
      triggerBlobDownload = () => {},
      videoUtils = {},
    } = options;

    const hlsBlobTransfers = new Map();
    const mediaStreamTransfers = new Map();
    const pageDirectDownloadTransfers = new Map();
    const constants = globalThis.__OVD_CONSTANTS__ || {};
    const MEDIA_STREAM_TIMEOUT = constants.MEDIA_STREAM_TIMEOUT || 120000;
    const PAGE_DIRECT_DOWNLOAD_TIMEOUT = constants.PAGE_DIRECT_DOWNLOAD_TIMEOUT || 600000;

    function normalizeTaskMeta(taskMeta = {}) {
      const normalized = {};
      for (const key of ['sourceId', 'strategyId', 'taskKey', 'title', 'traceId', 'videoUrl']) {
        if (taskMeta[key]) {
          normalized[key] = taskMeta[key];
        }
      }
      return normalized;
    }

    function withTimeout(promise, timeoutMs, timeoutMessage) {
      let timer = null;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      });

      return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
      });
    }

    function ensureExtension(filename, ext) {
      const safeName = typeof filename === 'string' ? filename.trim() : '';
      const base = safeName || 'video';
      return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
    }

    function normalizeDownloadFilename(filename, mimeType) {
      const inferredExt = videoUtils.inferExtensionFromMimeType?.(mimeType || 'video/mp2t') || '.ts';
      if (typeof filename === 'string' && /\.[a-z0-9]{2,5}$/i.test(filename.trim())) {
        return filename.trim();
      }
      return ensureExtension(filename, inferredExt);
    }

    function normalizeBinaryPayload(payload) {
      if (payload instanceof ArrayBuffer) {
        return payload;
      }

      if (ArrayBuffer.isView(payload)) {
        return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
      }

      if (Array.isArray(payload)) {
        return Uint8Array.from(payload).buffer;
      }

      if (payload && typeof payload === 'object') {
        if (payload.data && Array.isArray(payload.data)) {
          return Uint8Array.from(payload.data).buffer;
        }

        const numericKeys = Object.keys(payload)
          .filter((key) => /^\d+$/.test(key))
          .sort((left, right) => Number(left) - Number(right));

        if (numericKeys.length > 0) {
          return Uint8Array.from(numericKeys.map((key) => Number(payload[key]) || 0)).buffer;
        }
      }

      throw new Error('无法恢复 HLS 二进制数据');
    }

    const byteUtils = globalThis.__OVD_BYTE_UTILS__ || {};
    const _concatUint8Arrays = byteUtils.concatUint8Arrays || ((arrays) => {
      const total = arrays.reduce((sum, chunk) => sum + chunk.length, 0);
      const output = new Uint8Array(total);
      let offset = 0;
      for (const chunk of arrays) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      return output;
    });
    const base64ToUint8Array = byteUtils.base64ToUint8Array;

    async function hlsDownloadBlob(buffer, filename, mimeType, taskMeta = {}) {
      const normalized = normalizeBinaryPayload(buffer);
      const blob = new Blob([normalized], { type: mimeType || 'video/mp2t' });
      triggerBlobDownload(blob, normalizeDownloadFilename(filename, mimeType), taskMeta);
      return null;
    }

    function startHlsBlobTransfer(transferId, filename, mimeType, taskMeta = {}) {
      if (!transferId) {
        throw new Error('缺少 HLS 传输 ID');
      }

      hlsBlobTransfers.set(transferId, {
        chunks: [],
        filename: normalizeDownloadFilename(filename, mimeType),
        mimeType: mimeType || 'video/mp2t',
        taskMeta: taskMeta || {},
      });
    }

    function appendHlsBlobChunk(transferId, chunkBase64) {
      const transfer = hlsBlobTransfers.get(transferId);
      if (!transfer) {
        throw new Error('HLS 传输不存在或已过期');
      }
      if (!chunkBase64) {
        throw new Error('HLS 分段为空');
      }

      transfer.chunks.push(base64ToUint8Array(chunkBase64));
    }

    async function finishHlsBlobTransfer(transferId) {
      const transfer = hlsBlobTransfers.get(transferId);
      if (!transfer) {
        throw new Error('HLS 传输不存在或已过期');
      }

      hlsBlobTransfers.delete(transferId);
      const blob = new Blob(transfer.chunks, { type: transfer.mimeType });
      triggerBlobDownload(blob, transfer.filename, transfer.taskMeta);
      return null;
    }

    function startMediaStreamTransfer(transferId, taskMeta = {}) {
      if (!transferId) {
        return;
      }

      const nextTaskMeta = normalizeTaskMeta(taskMeta);
      const existing = mediaStreamTransfers.get(transferId);
      if (existing) {
        existing.videoChunks = [];
        existing.audioChunks = [];
        existing.videoProgress = { loadedBytes: 0, totalBytes: 0 };
        existing.audioProgress = { loadedBytes: 0, totalBytes: 0 };
        existing.taskMeta = {
          ...(existing.taskMeta || {}),
          ...nextTaskMeta,
        };
        return;
      }

      mediaStreamTransfers.set(transferId, {
        audioChunks: [],
        audioProgress: { loadedBytes: 0, totalBytes: 0 },
        taskMeta: nextTaskMeta,
        videoChunks: [],
        videoProgress: { loadedBytes: 0, totalBytes: 0 },
      });
    }

    function getMediaStreamTaskMeta(transferId) {
      const transfer = mediaStreamTransfers.get(transferId);
      return transfer?.taskMeta ? { ...transfer.taskMeta } : {};
    }

    /**
     * 追加媒体流分片。
     * seq 由后台按发送顺序给出：回传现在是流水线（多条消息在途），
     * 到达顺序不保证，因此按 seq 落位而不是 push；
     * 旧调用方不带 seq 时退化为顺序追加。
     */
    function appendMediaStreamChunk(transferId, label, chunkBase64, seq) {
      const transfer = mediaStreamTransfers.get(transferId);
      if (!transfer || !chunkBase64) {
        return;
      }

      const bytes = base64ToUint8Array(chunkBase64);
      const key = label === 'video' ? 'videoChunks' : 'audioChunks';
      const chunks = transfer[key];
      const index = Number.isInteger(seq) && seq >= 0 ? seq : chunks.length;

      if (index === chunks.length || chunks[index] === undefined) {
        chunks[index] = bytes;
      } else {
        // 同一位置重复到达：保留先到的分片，避免覆盖成乱序数据
        console.warn(`[OVD] 忽略重复的 ${label} 分片 #${index}`);
      }
    }

    /**
     * 按序压缩分片数组；出现空洞说明有分片丢失，
     * 直接 fail-fast，绝不产出缺片/错序的损坏文件。
     */
    function compactOrderedChunks(chunks, label) {
      if (!Array.isArray(chunks) || chunks.length === 0) {
        return [];
      }

      const ordered = [];
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        if (!chunk || chunk.length === 0) {
          const err = new Error(`${label}流分片 #${index} 缺失，已中止以避免产出损坏文件`);
          err.code = 'MEDIA_STREAM_CHUNK_MISSING';
          err.label = label;
          err.index = index;
          throw err;
        }
        ordered.push(chunk);
      }
      return ordered;
    }

    function updateMediaStreamProgress(transferId, label, loadedBytes, totalBytes) {
      const transfer = mediaStreamTransfers.get(transferId);
      if (!transfer) {
        return null;
      }

      const progressKey = label === 'video' ? 'videoProgress' : 'audioProgress';
      const progress = transfer[progressKey] || { loadedBytes: 0, totalBytes: 0 };
      progress.loadedBytes = Math.max(progress.loadedBytes || 0, Number(loadedBytes) || 0);
      if (Number(totalBytes) > 0) {
        progress.totalBytes = Math.max(progress.totalBytes || 0, Number(totalBytes) || 0);
      }
      transfer[progressKey] = progress;

      const videoLoadedBytes = transfer.videoProgress?.loadedBytes || 0;
      const audioLoadedBytes = transfer.audioProgress?.loadedBytes || 0;
      const videoTotalBytes = transfer.videoProgress?.totalBytes || 0;
      const audioTotalBytes = transfer.audioProgress?.totalBytes || 0;
      const totalBytesCombined = videoTotalBytes + audioTotalBytes;
      const loadedBytesCombined = videoLoadedBytes + audioLoadedBytes;
      const percent = totalBytesCombined > 0
        ? Math.min(100, Math.round((loadedBytesCombined / totalBytesCombined) * 100))
        : null;

      return {
        audioLoadedBytes,
        audioTotalBytes,
        hasKnownTotal: totalBytesCombined > 0,
        label: label === 'video' ? 'video' : 'audio',
        loadedBytes: loadedBytesCombined,
        percent,
        totalBytes: totalBytesCombined,
        videoLoadedBytes,
        videoTotalBytes,
      };
    }

    function finishMediaStreamTransfer(transferId) {
      const transfer = mediaStreamTransfers.get(transferId);
      mediaStreamTransfers.delete(transferId);
      if (!transfer) {
        return;
      }

      try {
        const videoChunks = compactOrderedChunks(transfer.videoChunks, '视频');
        const audioChunks = compactOrderedChunks(transfer.audioChunks, '音频');
        const videoBuffer = _concatUint8Arrays(videoChunks).buffer;
        const audioBuffer = _concatUint8Arrays(audioChunks).buffer;
        transfer.resolve?.({ audioBuffer, videoBuffer });
      } catch (err) {
        console.error(`[OVD] 媒体流分片校验失败: ${err.message}`);
        transfer.reject?.(err);
      }
    }

    function failMediaStreamTransfer(transferId, errorMessage) {
      const transfer = mediaStreamTransfers.get(transferId);
      mediaStreamTransfers.delete(transferId);
      if (!transfer) {
        return;
      }

      transfer.reject?.(new Error(errorMessage || '页面内媒体流抓取失败'));
    }

    function finishPageDirectDownloadTransfer(payload) {
      const transferId = payload?.transferId;
      const transfer = pageDirectDownloadTransfers.get(transferId);
      pageDirectDownloadTransfers.delete(transferId);
      if (!transfer) {
        return;
      }

      if (payload?.ok) {
        transfer.resolve(payload);
        return;
      }

      transfer.reject(new Error(payload?.error || '页面内直链下载失败'));
    }

    function normalizeStreamUrlList(input) {
      return (Array.isArray(input) ? input : [input])
        .filter((url) => typeof url === 'string' && url.trim());
    }

    /**
     * 让后台抓取视音频流。两个参数都接受候选地址数组：
     * 后台会按顺序尝试（主地址 → 备用 CDN），单个节点不可达时自动切换。
     */
    async function fetchMediaStreamsAndWait(videoUrls, audioUrls, headers, transferPrefix, timeoutMessage) {
      const transferId = `${transferPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const videoCandidates = normalizeStreamUrlList(videoUrls);
      const audioCandidates = normalizeStreamUrlList(audioUrls);
      const streamsReady = new Promise((resolve, reject) => {
        mediaStreamTransfers.set(transferId, { audioChunks: [], videoChunks: [], resolve, reject });
      });

      let result;
      try {
        result = await sendMessageAsync({
          type: MSG.FETCH_MEDIA_STREAMS || 'FETCH_MEDIA_STREAMS',
          audioUrl: audioCandidates[0] || '',
          audioUrls: audioCandidates,
          headers,
          transferId,
          videoUrl: videoCandidates[0] || '',
          videoUrls: videoCandidates,
        });
      } catch (err) {
        mediaStreamTransfers.delete(transferId);
        throw new Error(`请求扩展后台抓取流失败: ${err.message}`);
      }

      if (!result?.ok) {
        mediaStreamTransfers.delete(transferId);
        throw new Error(result?.error || '视音频流获取失败');
      }

      try {
        return await withTimeout(streamsReady, MEDIA_STREAM_TIMEOUT, timeoutMessage);
      } catch (err) {
        mediaStreamTransfers.delete(transferId);
        throw err;
      }
    }

    async function fetchYouTubeMediaStreamsInPage(videoUrl, audioUrl, headers, timeoutMessage, traceId = '', streamInfo = {}, taskMeta = {}) {
      const transferId = `yt-page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const streamsReady = new Promise((resolve, reject) => {
        mediaStreamTransfers.set(transferId, {
          audioChunks: [],
          audioProgress: { loadedBytes: 0, totalBytes: 0 },
          taskMeta: normalizeTaskMeta({
            sourceId: 'youtube',
            traceId,
            ...taskMeta,
          }),
          videoChunks: [],
          videoProgress: { loadedBytes: 0, totalBytes: 0 },
          resolve,
          reject,
        });
      });

      postMessageToPage({
        type: MSG.YOUTUBE_MEDIA_STREAMS_REQUEST || 'YOUTUBE_MEDIA_STREAMS_REQUEST',
        audioInfo: streamInfo?.audio || null,
        audioUrl,
        headers,
        traceId,
        transferId,
        videoInfo: streamInfo?.video || null,
        videoUrl,
      });

      try {
        return await withTimeout(streamsReady, PAGE_DIRECT_DOWNLOAD_TIMEOUT, timeoutMessage);
      } catch (err) {
        failMediaStreamTransfer(transferId, err.message);
        throw err;
      }
    }

    async function createPageDirectDownloadTransfer({
      filename,
      headers,
      traceId = '',
      timeoutMessage = '等待页面内直链下载超时',
      transferPrefix = 'page-direct',
      type,
      url,
    }) {
      const transferId = `${transferPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const completion = new Promise((resolve, reject) => {
        pageDirectDownloadTransfers.set(transferId, { reject, resolve });
      });

      postMessageToPage({
        type,
        filename,
        headers,
        traceId,
        transferId,
        url,
      });

      try {
        return await withTimeout(completion, PAGE_DIRECT_DOWNLOAD_TIMEOUT, timeoutMessage);
      } catch (err) {
        finishPageDirectDownloadTransfer({ error: err.message, ok: false, transferId });
        throw err;
      }
    }

    return {
      _concatUint8Arrays,
      appendHlsBlobChunk,
      appendMediaStreamChunk,
      base64ToUint8Array,
      createPageDirectDownloadTransfer,
      failMediaStreamTransfer,
      fetchMediaStreamsAndWait,
      fetchYouTubeMediaStreamsInPage,
      finishHlsBlobTransfer,
      finishMediaStreamTransfer,
      finishPageDirectDownloadTransfer,
      getMediaStreamTaskMeta,
      hlsDownloadBlob,
      normalizeBinaryPayload,
      normalizeDownloadFilename,
      startHlsBlobTransfer,
      startMediaStreamTransfer,
      updateMediaStreamProgress,
      withTimeout,
    };
  }

  globalThis.__OVD_STREAM_TRANSFER_MANAGER__ = {
    createStreamTransferManager,
  };
})();
