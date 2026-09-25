// lib/bilibili-quality-utils.js
// B站视频清晰度工具：画质 ID 映射、可用清晰度列表、流选择
// 以 <script> 方式加载，暴露全局 BilibiliQualityUtils

'use strict';

(() => {
  if (globalThis.__OVD_BILIBILI_QUALITY_UTILS__) {
    return;
  }

  // ============================================================
  // Bilibili 画质 ID → 中文标签
  // 来源：https://github.com/SocialSisterYi/bilibili-API-collect
  // ============================================================

  const BILIBILI_QUALITY_LABELS = Object.freeze({
    127: '8K 超高清',
    126: 'Dolby Vision',
    125: 'HDR 真彩',
    120: '4K 超清',
    116: '1080P 60帧',
    112: '1080P 高码率',
    80: '1080P',
    74: '720P 60帧',
    64: '720P',
    48: '720P 高清',
    32: '480P',
    16: '360P',
  });

  /**
   * 从 DASH API 返回的 dash.video 数组中提取可用清晰度列表
   * 同一 id（不同编解码器）只保留一个，按 id 降序排列
   * @param {Array} dashVideoArray - data.dash.video 数组
   * @returns {Array<{id: number, label: string}>}
   */
  function listAvailableBilibiliQualities(dashVideoArray) {
    if (!Array.isArray(dashVideoArray) || dashVideoArray.length === 0) {
      return [];
    }

    const seen = new Set();
    const qualities = [];

    for (const stream of dashVideoArray) {
      const qid = stream.id;
      if (qid == null || seen.has(qid)) {
        continue;
      }
      seen.add(qid);
      qualities.push({
        id: qid,
        label: BILIBILI_QUALITY_LABELS[qid] || `${qid}P`,
      });
    }

    qualities.sort((a, b) => b.id - a.id);
    return qualities;
  }

  /**
   * 根据目标清晰度 ID 选择视频流
   * @param {Array} videoStreams - 已按 id 降序排列的视频流数组
   * @param {string|number|null} targetQualityId - 目标画质 ID，'auto' 或 null 表示最高画质
   * @returns {Object|null} 选中的视频流对象，包含 baseUrl/base_url
   */
  function pickBilibiliVideoStream(videoStreams, targetQualityId) {
    if (!Array.isArray(videoStreams) || videoStreams.length === 0) {
      return null;
    }

    if (!targetQualityId || targetQualityId === 'auto') {
      return videoStreams[0];
    }

    const targetId = Number(targetQualityId);
    const match = videoStreams.find((s) => s.id === targetId);
    if (match) {
      return match;
    }

    console.warn(`[OVD] Bilibili 请求的画质 ID=${targetId} 不可用，回退到最高可用画质`);
    return videoStreams[0];
  }

  /**
   * 选择最高质量音频流
   * @param {Array} audioStreams - 已按 id 降序排列的音频流数组
   * @returns {Object|null} 选中的音频流对象
   */
  function pickBilibiliAudioStream(audioStreams) {
    if (!Array.isArray(audioStreams) || audioStreams.length === 0) {
      return null;
    }
    return audioStreams[0];
  }

  /**
   * 收集单个 DASH 流的全部候选下载地址：baseUrl 优先，其后是平台给出的 backupUrl。
   * B 站的 baseUrl 常指向 PCDN 边缘节点（如 *.mcdn.bilivideo.cn:8082、*.edge.*），
   * 这些节点在部分网络/端口策略下不可达；此时改用 backupUrl（多为 *.bilivideo.com）
   * 就能正常下载，因此需要把备用地址一并交给下载侧按顺序回退。
   * @param {Object} stream - dash.video / dash.audio 中的单个流对象
   * @returns {string[]} 去重后的 http(s) 地址列表（保持优先级顺序）
   */
  function listBilibiliStreamUrls(stream) {
    const candidates = [
      stream?.baseUrl,
      stream?.base_url,
      ...(Array.isArray(stream?.backupUrl) ? stream.backupUrl : []),
      ...(Array.isArray(stream?.backup_url) ? stream.backup_url : []),
    ];

    const seen = new Set();
    const urls = [];

    for (const candidate of candidates) {
      const url = typeof candidate === 'string' ? candidate.trim() : '';
      if (!url || seen.has(url) || !/^https?:\/\//i.test(url)) {
        continue;
      }
      seen.add(url);
      urls.push(url);
    }

    return urls;
  }

  function normalizeBilibiliDashStreams(dash = {}) {
    return {
      audio: Array.isArray(dash.audio) ? dash.audio.map((stream) => ({
        contentLength: Number(stream?.contentLength) || 0,
        id: Number(stream?.id) || 0,
        baseUrl: stream?.baseUrl || stream?.base_url || '',
      })) : [],
      video: Array.isArray(dash.video) ? dash.video.map((stream) => ({
        contentLength: Number(stream?.contentLength) || 0,
        id: Number(stream?.id) || 0,
        baseUrl: stream?.baseUrl || stream?.base_url || '',
      })) : [],
    };
  }

  function estimateBilibiliDownloadSize(dash = {}, options = {}) {
    const normalized = normalizeBilibiliDashStreams(dash);
    const selectedVideo = pickBilibiliVideoStream(normalized.video, options.qualityId);
    const selectedAudio = pickBilibiliAudioStream(normalized.audio);

    if (!selectedVideo || !selectedAudio) {
      return {
        bytes: 0,
        kind: null,
      };
    }

    return {
      bytes: (selectedVideo.contentLength || 0) + (selectedAudio.contentLength || 0),
      kind: 'dash',
    };
  }

  function buildBilibiliSelectionSnapshot(dash = {}, options = {}) {
    const normalized = normalizeBilibiliDashStreams(dash);
    const selectedVideo = pickBilibiliVideoStream(normalized.video, options.qualityId);
    const selectedAudio = pickBilibiliAudioStream(normalized.audio);
    const selectedSize = estimateBilibiliDownloadSize(dash, options);

    return {
      audioStreams: normalized.audio,
      selectedAudio: selectedAudio
        ? {
          contentLength: selectedAudio.contentLength,
          id: selectedAudio.id,
        }
        : null,
      selectedSizeBytes: selectedSize.bytes,
      selectedSizeKind: selectedSize.kind,
      selectedVideo: selectedVideo
        ? {
          contentLength: selectedVideo.contentLength,
          id: selectedVideo.id,
        }
        : null,
      videoStreams: normalized.video,
    };
  }

  globalThis.__OVD_BILIBILI_QUALITY_UTILS__ = Object.freeze({
    BILIBILI_QUALITY_LABELS,
    buildBilibiliSelectionSnapshot,
    estimateBilibiliDownloadSize,
    listAvailableBilibiliQualities,
    listBilibiliStreamUrls,
    normalizeBilibiliDashStreams,
    pickBilibiliAudioStream,
    pickBilibiliVideoStream,
  });
})();
