'use strict';

(() => {
  if (globalThis.__OVD_YOUTUBE_STREAM_UTILS__) {
    return;
  }

  function parseResolutionHeight(resolution) {
    if (typeof resolution !== 'string') {
      return 0;
    }

    if (resolution === 'auto') {
      return 0;
    }

    const match = resolution.match(/(\d{3,4})p/i);
    return match ? Number(match[1]) : 0;
  }

  function streamHasUsableUrl(stream) {
    return !!(stream && typeof stream.url === 'string' && stream.url);
  }

  function isMp4VideoStream(stream) {
    return streamHasUsableUrl(stream) && /video\/mp4/i.test(stream?.mimeType || '');
  }

  function isMp4AudioStream(stream) {
    return streamHasUsableUrl(stream) && /audio\/mp4/i.test(stream?.mimeType || '');
  }

  function normalizeStream(stream, kind) {
    return {
      audioQuality: stream?.audioQuality || '',
      // 音轨元数据（多语言/自动配音时用来挑原声）
      audioTrackId: stream?.audioTrackId || '',
      audioTrackIsDefault: stream?.audioTrackIsDefault === true,
      audioTrackName: stream?.audioTrackName || '',
      bitrate: Number(stream?.bitrate) || 0,
      contentLength: Number(stream?.contentLength) || 0,
      hasSignatureCipher: !!(stream?.signatureCipher || stream?.cipher),
      hasUrl: streamHasUsableUrl(stream),
      height: Number(stream?.height) || 0,
      itag: Number(stream?.itag) || 0,
      kind,
      mimeType: stream?.mimeType || '',
      quality: stream?.quality || '',
      qualityLabel: stream?.qualityLabel || '',
      signatureCipher: stream?.signatureCipher || stream?.cipher || '',
      url: stream?.url || '',
      width: Number(stream?.width) || 0,
    };
  }

  function normalizeYouTubeStreams(meta = {}) {
    return {
      audio: (meta.audioStreams || []).map((stream) => normalizeStream(stream, 'audio')),
      combined: (meta.combined || []).map((stream) => normalizeStream(stream, 'combined')),
      video: (meta.videoStreams || []).map((stream) => normalizeStream(stream, 'video')),
    };
  }

  function sortCombined(left, right) {
    return ((right.height || 0) - (left.height || 0)) || ((right.bitrate || 0) - (left.bitrate || 0));
  }

  function sortVideo(left, right) {
    return ((right.height || 0) - (left.height || 0)) || ((right.bitrate || 0) - (left.bitrate || 0));
  }

  function sortAudio(left, right) {
    return (right.bitrate || 0) - (left.bitrate || 0);
  }

  function uniqueHeights(streams = []) {
    const values = Array.from(new Set(streams.map((stream) => Number(stream?.height) || 0).filter(Boolean)));
    values.sort((left, right) => right - left);
    return values;
  }

  function estimateStreamBytes(stream = {}, durationSeconds = 0) {
    const contentLength = Number(stream?.contentLength) || 0;
    if (contentLength > 0) {
      return contentLength;
    }

    const bitrate = Number(stream?.bitrate) || 0;
    const duration = Number(durationSeconds) || 0;
    if (!bitrate || !duration) {
      return 0;
    }

    return Math.max(0, Math.round((bitrate / 8) * duration));
  }

  function listAvailableVideoQualities(meta = {}) {
    const normalized = normalizeYouTubeStreams(meta);
    const qualityMap = new Map();

    for (const stream of [...normalized.combined, ...normalized.video]) {
      const height = Number(stream.height) || 0;
      if (!height || (!stream.hasUrl && !stream.hasSignatureCipher)) {
        continue;
      }

      const key = `${height}p`;
      const existing = qualityMap.get(key) || {
        hasAdaptive: false,
        hasCombined: false,
        hasDirectUrl: false,
        hasSignatureCipherOnly: false,
        height,
        label: key,
      };

      if (stream.kind === 'combined') {
        existing.hasCombined = true;
      } else {
        existing.hasAdaptive = true;
      }

      if (stream.hasUrl) {
        existing.hasDirectUrl = true;
      }
      if (!stream.hasUrl && stream.hasSignatureCipher) {
        existing.hasSignatureCipherOnly = true;
      }

      qualityMap.set(key, existing);
    }

    return Array.from(qualityMap.values()).sort((left, right) => right.height - left.height);
  }

  function pickCombinedStream(meta = {}, options = {}) {
    const {
      fallbackToLowerQuality = true,
      resolution = 'auto',
    } = options;

    const normalized = normalizeYouTubeStreams(meta);
    const candidates = normalized.combined
      .filter(isMp4VideoStream)
      .sort(sortCombined);

    if (!candidates.length) {
      return null;
    }

    const targetHeight = parseResolutionHeight(resolution);
    if (!targetHeight) {
      return candidates[0];
    }

    const exact = candidates.find((stream) => stream.height === targetHeight);
    if (exact) {
      return exact;
    }

    if (!fallbackToLowerQuality) {
      return null;
    }

    return candidates.find((stream) => stream.height <= targetHeight) || null;
  }

  function pickAdaptiveVideoStream(meta = {}, options = {}) {
    const {
      fallbackToLowerQuality = true,
      resolution = 'auto',
    } = options;

    const normalized = normalizeYouTubeStreams(meta);
    const candidates = normalized.video
      .filter(isMp4VideoStream)
      .sort(sortVideo);

    if (!candidates.length) {
      return null;
    }

    const targetHeight = parseResolutionHeight(resolution);
    if (!targetHeight) {
      return candidates[0];
    }

    const exact = candidates.find((stream) => stream.height === targetHeight);
    if (exact) {
      return exact;
    }

    if (!fallbackToLowerQuality) {
      return null;
    }

    return candidates.find((stream) => stream.height <= targetHeight) || candidates[0] || null;
  }

  /**
   * 该音轨是否"原声"（不是自动配音/其它语言轨）。
   * YouTube 会为带自动配音的视频返回多条同码率的音轨（adaptiveFormats[].audioTrack），
   * 只按码率挑会把配音轨合进视频 —— 现场表现为"合并后声音不是原视频的"。
   */
  function isOriginalAudioTrack(stream) {
    if (stream?.audioTrackIsDefault === true) {
      return true;
    }
    // 没有 audioIsDefault 字段的老响应：按名称判断（"English (US) original" 等）
    return /original|原声/i.test(String(stream?.audioTrackName || ''));
  }

  function pickAdaptiveAudioStream(meta = {}) {
    const normalized = normalizeYouTubeStreams(meta);
    const candidates = normalized.audio.filter(isMp4AudioStream);
    if (candidates.length === 0) {
      return null;
    }

    // 优先原声轨：先看 audioIsDefault/名称，再按码率排序取最高
    const originalTracks = candidates.filter(isOriginalAudioTrack);
    const pool = originalTracks.length > 0 ? originalTracks : candidates;
    return pool.sort(sortAudio)[0] || null;
  }

  function estimateYouTubeDownloadSize(meta = {}, options = {}) {
    const normalizedOptions = {
      ...options,
    };
    const durationSeconds = Number(meta?.duration || meta?.lengthSeconds || meta?.videoDetails?.lengthSeconds) || 0;
    const exactCombined = normalizedOptions.preferCombined && normalizedOptions.resolution !== 'auto'
      ? pickCombinedStream(meta, {
        ...normalizedOptions,
        fallbackToLowerQuality: false,
      })
      : null;
    const selectedVideo = pickAdaptiveVideoStream(meta, normalizedOptions);
    const selectedAudio = pickAdaptiveAudioStream(meta, normalizedOptions);
    const canUseAdaptive = !!(selectedVideo && selectedAudio);

    if (exactCombined) {
      return {
        kind: 'combined',
        bytes: estimateStreamBytes(exactCombined, durationSeconds),
      };
    }

    if (canUseAdaptive) {
      return {
        kind: 'adaptive',
        bytes: estimateStreamBytes(selectedVideo, durationSeconds) + estimateStreamBytes(selectedAudio, durationSeconds),
      };
    }

    const fallbackCombined = normalizedOptions.preferCombined
      ? pickCombinedStream(meta, normalizedOptions)
      : null;
    if (fallbackCombined) {
      return {
        kind: 'combined',
        bytes: estimateStreamBytes(fallbackCombined, durationSeconds),
      };
    }

    return {
      kind: null,
      bytes: 0,
    };
  }

  function buildYouTubeSelectionSnapshot(meta = {}, options = {}) {
    const normalized = normalizeYouTubeStreams(meta);
    const selectedCombined = pickCombinedStream(meta, options);
    const selectedVideo = pickAdaptiveVideoStream(meta, options);
    const selectedAudio = pickAdaptiveAudioStream(meta, options);
    const selectedSize = estimateYouTubeDownloadSize(meta, options);

    return {
      availableAudioBitrates: normalized.audio
        .filter((stream) => stream.hasUrl)
        .map((stream) => stream.bitrate)
        .filter(Boolean)
        .sort((left, right) => right - left),
      availableCombined: uniqueHeights(normalized.combined.filter((stream) => stream.hasUrl)).map((height) => `${height}p`),
      availableSignatureCipherVideo: uniqueHeights(
        normalized.video.filter((stream) => !stream.hasUrl && stream.hasSignatureCipher)
      ).map((height) => `${height}p`),
      availableVideo: uniqueHeights(normalized.video.filter((stream) => stream.hasUrl)).map((height) => `${height}p`),
      options: { ...options },
      requestedResolution: options?.resolution || 'auto',
      selectedAudio: selectedAudio
        ? {
          bitrate: selectedAudio.bitrate,
          contentLength: selectedAudio.contentLength,
          hasUrl: selectedAudio.hasUrl,
          itag: selectedAudio.itag,
          mimeType: selectedAudio.mimeType,
        }
        : null,
      selectedCombined: selectedCombined
        ? {
          contentLength: selectedCombined.contentLength,
          hasUrl: selectedCombined.hasUrl,
          height: selectedCombined.height,
          itag: selectedCombined.itag,
          mimeType: selectedCombined.mimeType,
        }
        : null,
      selectedVideo: selectedVideo
        ? {
          contentLength: selectedVideo.contentLength,
          hasUrl: selectedVideo.hasUrl,
          height: selectedVideo.height,
          itag: selectedVideo.itag,
          mimeType: selectedVideo.mimeType,
        }
        : null,
      selectedSizeBytes: selectedSize.bytes,
      selectedSizeKind: selectedSize.kind,
    };
  }

  globalThis.__OVD_YOUTUBE_STREAM_UTILS__ = {
    buildYouTubeSelectionSnapshot,
    isMp4AudioStream,
    isMp4VideoStream,
    listAvailableVideoQualities,
    normalizeYouTubeStreams,
    parseResolutionHeight,
    isOriginalAudioTrack,
    estimateStreamBytes,
    estimateYouTubeDownloadSize,
    pickAdaptiveAudioStream,
    pickAdaptiveVideoStream,
    pickCombinedStream,
    streamHasUsableUrl,
  };
})();
