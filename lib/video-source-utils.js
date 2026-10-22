'use strict';

(() => {
  function getSourceId(videoInfo = {}) {
    const type = videoInfo?.type || '';
    if (type === 'youtube-adaptive') return 'youtube';
    if (type === 'bilibili-meta' || type === 'bilibili-dash') return 'bilibili';
    if (type === 'blob') return 'blob';
    if (type === 'dash') return 'dash';
    if (type === 'telegram') return 'telegram';
    return 'generic';
  }

  function getExecutionMode(videoInfo = {}) {
    const sourceId = getSourceId(videoInfo);
    // 「仅音频」不需要页面录制/合并，音轨直链在后台即可完成下载
    if (sourceId === 'youtube' && videoInfo?.downloadOptions?.audioOnly) {
      return 'background';
    }
    // YouTube parse 模式在 Service Worker 中独立下载，不依赖标签页
    if (sourceId === 'youtube' && videoInfo?.downloadOptions?.mode === 'parse') {
      return 'background';
    }
    if (sourceId === 'youtube' || sourceId === 'bilibili' || sourceId === 'blob' || sourceId === 'dash' || sourceId === 'telegram') {
      return 'content';
    }
    return 'background';
  }

  function buildTaskKey(videoInfo = {}) {
    const sourceId = getSourceId(videoInfo);

    switch (sourceId) {
      case 'youtube':
        return videoInfo?.videoId || videoInfo?.url || videoInfo?.title || 'youtube';
      case 'bilibili':
        return [
          videoInfo?.bvid || videoInfo?.aid || videoInfo?.url || 'bilibili',
          videoInfo?.cid || 'no-cid',
        ].join(':');
      case 'blob':
        return videoInfo?.url || videoInfo?.title || 'blob';
      case 'dash':
        return videoInfo?.url || 'dash';
      case 'telegram':
        return videoInfo?.telegramDocId || videoInfo?.url || 'telegram';
      default:
        return videoInfo?.url || videoInfo?.title || videoInfo?.type || 'video';
    }
  }

  function getSourceLabel(videoInfo = {}) {
    if (getSourceId(videoInfo) === 'generic') {
      return videoInfo?.type === 'audio' ? 'Audio' : 'Video';
    }

    const labels = {
      youtube: 'YouTube',
      bilibili: 'Bilibili',
      blob: 'Blob',
      dash: 'DASH',
      telegram: 'Telegram',
      generic: 'Video',
    };

    return labels[getSourceId(videoInfo)] || 'Video';
  }

  // 只有清单类来源能替代不可读取的 MSE blob
  const BLOB_FALLBACK_TYPES = new Set(['hls', 'dash']);

  function normalizeTitleKey(title) {
    return String(title || '').trim().toLowerCase();
  }

  function isManifestCandidate(video = {}) {
    return BLOB_FALLBACK_TYPES.has(String(video?.type || ''))
      && /^https?:\/\//i.test(String(video?.url || ''));
  }

  function newestVideo(videos = []) {
    return videos.reduce((newest, video) => {
      if (!newest) {
        return video;
      }
      return (Number(video?.timestamp) || 0) >= (Number(newest.timestamp) || 0) ? video : newest;
    }, null);
  }

  /**
   * 为 blob 条目找一条同页嗅探到的 HLS / DASH 清单，作为真正的下载来源。
   *
   * MSE 播放流的 blob: 地址只是播放器喂数据的管道（没有文件数据，fetch 必失败），
   * 而同一播放器请求的 m3u8 / mpd 会被网络拦截单独登记成条目。
   * 匹配顺序：同 frame + 同标题 → 同标题 → 同 frame → 全页唯一候选，
   * 既避免借到同 frame 里另一条视频（广告）的清单，也不跨播放器乱借。
   *
   * @param {Object} video 待下载的 blob 条目
   * @param {Object[]} videos 当前标签页的检测结果（同一次渲染的列表）
   * @returns {Object|null} 可替代的清单条目，没有则 null
   */
  function findBlobFallbackVideo(video = {}, videos = []) {
    if (video?.type !== 'blob') {
      return null;
    }

    const candidates = (Array.isArray(videos) ? videos : []).filter((candidate) => (
      candidate && candidate !== video && isManifestCandidate(candidate)
    ));
    if (candidates.length === 0) {
      return null;
    }

    const frameId = Number.isInteger(video?.frameId) ? video.frameId : null;
    const sameFrame = frameId == null
      ? []
      : candidates.filter((candidate) => Number.isInteger(candidate?.frameId) && candidate.frameId === frameId);
    const title = normalizeTitleKey(video?.title);
    const sameTitle = title
      ? candidates.filter((candidate) => normalizeTitleKey(candidate?.title) === title)
      : [];

    const sameFrameAndTitle = sameFrame.filter((candidate) => sameTitle.includes(candidate));
    if (sameFrameAndTitle.length > 0) {
      return newestVideo(sameFrameAndTitle);
    }

    if (sameTitle.length > 0) {
      return newestVideo(sameTitle);
    }

    if (sameFrame.length > 0) {
      return newestVideo(sameFrame);
    }

    // 跨 frame 且标题对不上时，只有全页仅一个候选才敢借用（否则可能下成另一个视频）
    return candidates.length === 1 ? candidates[0] : null;
  }

  /**
   * 列表展示用：MSE blob 条目在同页已有可替代清单时隐藏。
   *
   * 这类 blob 地址没有文件数据（fetch 必失败），保留它只会让同一个视频在列表里
   * 出现两行，并让批量下载把同一条视频下两遍；清单条目会通过
   * `lib/video-filter.js#backfillFrameMetadata` 借用它的封面与时长，信息不会丢。
   * 隐藏比「点击时替换」更不可逆，因此这里只认更确定的匹配：同 frame，或全页只有
   * 一个清单候选（不跨 frame 按标题猜，避免把另一个播放器的清单当成这条视频）。
   * 没有把握时保留该行，点下载仍会走 `findBlobFallbackVideo` 的宽松匹配。
   */
  function dropShadowedMseBlobs(videos = []) {
    const list = Array.isArray(videos) ? videos : [];
    const candidates = list.filter(isManifestCandidate);

    return list.filter((video) => {
      if (video?.type !== 'blob' || video?.mse !== true) {
        return true;
      }

      const frameId = Number.isInteger(video?.frameId) ? video.frameId : null;
      const sameFrame = frameId == null
        ? []
        : candidates.filter((candidate) => candidate !== video
          && Number.isInteger(candidate?.frameId)
          && candidate.frameId === frameId);

      return sameFrame.length === 0 && candidates.length !== 1;
    });
  }

  globalThis.__OVD_VIDEO_SOURCE_UTILS__ = {
    buildTaskKey,
    dropShadowedMseBlobs,
    findBlobFallbackVideo,
    getExecutionMode,
    getSourceId,
    getSourceLabel,
  };
})();
