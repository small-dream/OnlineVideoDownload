'use strict';

(() => {
  if (window.__OVD_PAGE_YOUTUBE_PARSER__) {
    return;
  }

  const core = window.__OVD_PAGE_CORE__;
  if (!core) {
    console.error('[OVD][PAGE] page-youtube-parser loaded before page-core');
    return;
  }

  const { registerResetter, sendToExtension } = core;

  const state = {
    androidFallbackAttempted: new Set(),
    androidFallbackInflight: new Map(),
    duplicateLogKey: null,
    fallbackDecisionLogKey: null,
    currentVideoFallbackLogKey: null,
    currentVideoFallbackTimer: null,
    currentVideoFallbackTimerVideoId: null,
    lastNoStreamingLogKey: null,
    lastProcessLogKey: null,
    lastReportedMetrics: null,
    lastReportedVideoId: null,
    lastResponseDedupKey: null,
    lastSourceHitLogKeys: new Map(),
    lastSummaryLogKey: null,
    pendingPlayerResponse: null,
    pendingReplayTimer: null,
    reportedBlobUrls: new Set(),
    stopWatching: null,
  };

  function clearPendingReplayTimer() {
    if (state.pendingReplayTimer) {
      clearTimeout(state.pendingReplayTimer);
      state.pendingReplayTimer = null;
    }
  }

  function clearCurrentVideoFallbackTimer() {
    if (state.currentVideoFallbackTimer) {
      clearTimeout(state.currentVideoFallbackTimer);
      state.currentVideoFallbackTimer = null;
      state.currentVideoFallbackTimerVideoId = null;
    }
  }

  function resetState() {
    state.lastReportedVideoId = null;
    state.lastReportedMetrics = null;
    state.lastProcessLogKey = null;
    state.lastNoStreamingLogKey = null;
    state.lastResponseDedupKey = null;
    state.lastSummaryLogKey = null;
    state.fallbackDecisionLogKey = null;
    state.currentVideoFallbackLogKey = null;
    state.duplicateLogKey = null;
    state.pendingPlayerResponse = null;
    clearPendingReplayTimer();
    clearCurrentVideoFallbackTimer();
    state.lastSourceHitLogKeys.clear();
    state.androidFallbackAttempted.clear();
    state.reportedBlobUrls.clear();
  }

  function cachePendingPlayerResponse(playerResponse, sourceTag = 'page') {
    if (!playerResponse?.streamingData) {
      return;
    }

    const pendingKey = buildYouTubeResponseDedupKey(playerResponse, sourceTag);
    if (state.pendingPlayerResponse?.key !== pendingKey) {
      console.log('[OVD][YT-DEBUG] cached pending player response', {
        adaptiveFormatsCount: playerResponse?.streamingData?.adaptiveFormats?.length || 0,
        formatsCount: playerResponse?.streamingData?.formats?.length || 0,
        sourceTag,
        videoId: playerResponse?.videoDetails?.videoId || '',
      });
    }

    state.pendingPlayerResponse = {
      key: pendingKey,
      playerResponse,
      sourceTag,
    };

    clearPendingReplayTimer();
    state.pendingReplayTimer = setTimeout(() => {
      flushPendingPlayerResponse('timer');
    }, 250);
  }

  function flushPendingPlayerResponse(reason = 'manual') {
    const pending = state.pendingPlayerResponse;
    if (!pending) {
      return false;
    }

    const urlVideoId = getCurrentYouTubePageVideoId();
    const currentPageUrl = getCurrentYouTubePageUrl();
    if (!urlVideoId || !currentPageUrl) {
      return false;
    }

    state.pendingPlayerResponse = null;
    clearPendingReplayTimer();
    console.log(`[OVD][YT-DEBUG] replaying pending player response reason=${reason} dataVideoId=${pending.playerResponse?.videoDetails?.videoId || '-'} urlVideoId=${urlVideoId}`);
    processYouTubePlayerResponse(pending.playerResponse, { sourceTag: pending.sourceTag });
    return true;
  }

  function rememberBlobUrl(url) {
    if (!url) {
      return false;
    }

    if (state.reportedBlobUrls.has(url)) {
      return true;
    }

    state.reportedBlobUrls.add(url);
    if (state.reportedBlobUrls.size > 32) {
      const oldest = state.reportedBlobUrls.values().next().value;
      if (oldest) {
        state.reportedBlobUrls.delete(oldest);
      }
    }

    return false;
  }

  function getYtcfgValue(key) {
    try {
      if (window.ytcfg?.get) {
        return window.ytcfg.get(key);
      }
    } catch (err) {
      console.warn(`[OVD][YT-DEBUG] failed to read ytcfg key=${key}: ${err.message}`);
    }
    return null;
  }

  function buildYouTubeResponseDedupKey(playerResponse, sourceTag = 'page') {
    const formats = playerResponse?.streamingData?.formats || [];
    const adaptiveFormats = playerResponse?.streamingData?.adaptiveFormats || [];

    const formatKey = formats
      .map((stream) => `${stream?.itag || 0}:${stream?.url ? 1 : 0}:${stream?.height || 0}:${stream?.bitrate || 0}`)
      .join(',');
    const adaptiveKey = adaptiveFormats
      .map((stream) => `${stream?.itag || 0}:${stream?.mimeType?.startsWith('audio/') ? 'a' : 'v'}:${stream?.url ? 1 : 0}:${(stream?.signatureCipher || stream?.cipher) ? 1 : 0}:${stream?.height || 0}:${stream?.bitrate || 0}`)
      .join(',');

    return [
      sourceTag,
      playerResponse?.videoDetails?.videoId || '-',
      playerResponse?.playabilityStatus?.status || '-',
      formatKey,
      adaptiveKey,
    ].join('|');
  }

  function buildYouTubeMetricsLogKey(videoId, metrics = {}, sourceTag = 'page') {
    return [
      sourceTag,
      videoId || '-',
      metrics.adaptiveAudioCount || 0,
      metrics.adaptiveVideoCount || 0,
      metrics.cipherOnlyVideoCount || 0,
      metrics.directAudioCount || 0,
      metrics.directCombinedCount || 0,
      metrics.directVideoCount || 0,
      metrics.maxCipherVideoHeight || 0,
      metrics.maxDirectCombinedHeight || 0,
      metrics.maxDirectVideoHeight || 0,
      metrics.opaqueAdaptiveAudioCount || 0,
      metrics.opaqueAdaptiveVideoCount || 0,
    ].join('|');
  }

  function buildYouTubeNoStreamingLogKey(playerResponse, sourceTag = 'page') {
    return [
      sourceTag,
      getCurrentYouTubePageVideoId(playerResponse) || '-',
      playerResponse?.videoDetails?.videoId || '-',
      playerResponse?.playabilityStatus?.status || '-',
      Object.keys(playerResponse || {}).sort().join(','),
    ].join('|');
  }

  function shouldSuppressYouTubeSourceHitLabel(label = '') {
    return /^polling/.test(label) || /^dom-change/.test(label);
  }

  function logYouTubeSourceHitOnce(sourceName, playerResponse, label) {
    const key = [
      sourceName,
      playerResponse?.videoDetails?.videoId || '-',
      playerResponse?.streamingData?.formats?.length || 0,
      playerResponse?.streamingData?.adaptiveFormats?.length || 0,
    ].join('|');

    if (state.lastSourceHitLogKeys.get(sourceName) === key) {
      return;
    }

    state.lastSourceHitLogKeys.set(sourceName, key);
    if (shouldSuppressYouTubeSourceHitLabel(label)) {
      return;
    }

    console.log(`[OVD][YT-DEBUG] source hit label=${label} source=${sourceName}`);
  }

  function getYouTubePlayerMetricsFromFormats(formats = [], adaptiveFormats = []) {
    const combined = formats.filter((format) => format?.mimeType?.startsWith('video/'));
    const video = adaptiveFormats.filter((format) => format?.mimeType?.startsWith('video/'));
    const audio = adaptiveFormats.filter((format) => format?.mimeType?.startsWith('audio/'));

    const directCombinedHeights = combined.filter((format) => !!format?.url).map((format) => Number(format.height) || 0).filter(Boolean);
    const directVideoHeights = video.filter((format) => !!format?.url).map((format) => Number(format.height) || 0).filter(Boolean);
    const cipherVideoHeights = video
      .filter((format) => !format?.url && (format?.signatureCipher || format?.cipher))
      .map((format) => Number(format.height) || 0)
      .filter(Boolean);

    return {
      adaptiveAudioCount: audio.length,
      adaptiveVideoCount: video.length,
      cipherOnlyVideoCount: video.filter((format) => !format?.url && (format?.signatureCipher || format?.cipher)).length,
      directAudioCount: audio.filter((format) => !!format?.url).length,
      directCombinedCount: combined.filter((format) => !!format?.url).length,
      directVideoCount: video.filter((format) => !!format?.url).length,
      maxCipherVideoHeight: cipherVideoHeights.length ? Math.max(...cipherVideoHeights) : 0,
      maxDirectCombinedHeight: directCombinedHeights.length ? Math.max(...directCombinedHeights) : 0,
      maxDirectVideoHeight: directVideoHeights.length ? Math.max(...directVideoHeights) : 0,
      opaqueAdaptiveAudioCount: audio.filter((format) => !format?.url && !(format?.signatureCipher || format?.cipher)).length,
      opaqueAdaptiveVideoCount: video.filter((format) => !format?.url && !(format?.signatureCipher || format?.cipher)).length,
    };
  }

  function getYouTubeAndroidFallbackReason(metrics) {
    if (!metrics) {
      return null;
    }

    const maxDirectHeight = Math.max(metrics.maxDirectVideoHeight || 0, metrics.maxDirectCombinedHeight || 0);

    if (metrics.adaptiveVideoCount > 0 && metrics.directVideoCount === 0) {
      if (metrics.cipherOnlyVideoCount > 0) {
        return 'adaptive-video-signature-only';
      }
      return 'adaptive-video-without-direct-url';
    }

    if (metrics.adaptiveAudioCount > 0 && metrics.directAudioCount === 0) {
      return 'adaptive-audio-without-direct-url';
    }

    if ((metrics.maxCipherVideoHeight || 0) > maxDirectHeight) {
      return 'signature-cipher-higher-quality';
    }

    if (
      metrics.adaptiveVideoCount > 0 &&
      metrics.directCombinedCount > 0 &&
      (metrics.maxDirectCombinedHeight || 0) <= 360 &&
      maxDirectHeight <= 360
    ) {
      return 'combined-only-low-quality';
    }

    return null;
  }

  function shouldTryAndroidPlayerFallback(metrics) {
    return !!getYouTubeAndroidFallbackReason(metrics);
  }

  function hasYouTubeAndroidFallbackPrerequisites(videoId) {
    if (!videoId) {
      return false;
    }

    const apiKey = getYtcfgValue('INNERTUBE_API_KEY');
    if (apiKey) {
      return true;
    }

    const logKey = `${videoId}|missing-api-key`;
    if (state.currentVideoFallbackLogKey !== logKey) {
      state.currentVideoFallbackLogKey = logKey;
      console.log(`[OVD][YT-DEBUG] waiting for INNERTUBE_API_KEY before current video fallback videoId=${videoId}`);
    }

    return false;
  }

  function scheduleCurrentVideoIdFallback(reason = 'no-valid-player-response', delayMs = 1200, details = {}) {
    const videoId = getCurrentYouTubePageVideoId();
    const currentPageUrl = getCurrentYouTubePageUrl();
    if (!videoId || !currentPageUrl) {
      return false;
    }

    if (state.lastReportedVideoId === videoId) {
      return false;
    }

    if (state.androidFallbackAttempted.has(videoId) || state.androidFallbackInflight.has(videoId)) {
      const skipKey = `${videoId}|${reason}|already-started`;
      if (state.currentVideoFallbackLogKey !== skipKey) {
        state.currentVideoFallbackLogKey = skipKey;
        console.log(`[OVD][YT-DEBUG] current video fallback already inflight or attempted videoId=${videoId} reason=${reason}`);
      }
      return false;
    }

    if (!hasYouTubeAndroidFallbackPrerequisites(videoId)) {
      return false;
    }

    if (state.currentVideoFallbackTimer && state.currentVideoFallbackTimerVideoId === videoId) {
      return true;
    }

    clearCurrentVideoFallbackTimer();
    state.currentVideoFallbackTimerVideoId = videoId;
    const logKey = `${videoId}|${reason}|scheduled`;
    if (state.currentVideoFallbackLogKey !== logKey) {
      state.currentVideoFallbackLogKey = logKey;
      console.log('[OVD][YT-DEBUG] scheduling current video fallback', {
        currentPageUrl,
        delayMs,
        reason,
        sourceLabel: details.label || '',
        staleDataVideoId: details.staleDataVideoId || '',
        videoId,
      });
    }

    state.currentVideoFallbackTimer = setTimeout(() => {
      state.currentVideoFallbackTimer = null;
      state.currentVideoFallbackTimerVideoId = null;

      const latestVideoId = getCurrentYouTubePageVideoId();
      if (latestVideoId !== videoId) {
        console.log(`[OVD][YT-DEBUG] cancel current video fallback videoId=${videoId} latest=${latestVideoId || '-'}`);
        return;
      }

      if (state.lastReportedVideoId === videoId) {
        console.log(`[OVD][YT-DEBUG] cancel current video fallback after report videoId=${videoId}`);
        return;
      }

      scheduleYouTubeAndroidFallback(videoId, reason, null);
    }, delayMs);

    return true;
  }

  function shouldSkipDuplicateYouTubeReport(videoId, nextMetrics, sourceTag) {
    if (!videoId || videoId !== state.lastReportedVideoId || !state.lastReportedMetrics) {
      return false;
    }

    const previousScore =
      ((state.lastReportedMetrics.maxDirectVideoHeight || 0) * 1000) +
      ((state.lastReportedMetrics.directVideoCount || 0) * 10) +
      (state.lastReportedMetrics.directCombinedCount || 0);
    const nextScore =
      ((nextMetrics?.maxDirectVideoHeight || 0) * 1000) +
      ((nextMetrics?.directVideoCount || 0) * 10) +
      (nextMetrics?.directCombinedCount || 0);

    if (sourceTag === 'android-fallback' && nextScore > previousScore) {
      return false;
    }

    return nextScore <= previousScore;
  }

  async function fetchYouTubeAndroidPlayerResponse(videoId) {
    const apiKey = getYtcfgValue('INNERTUBE_API_KEY');
    if (!videoId || !apiKey) {
      throw new Error('Missing videoId or INNERTUBE_API_KEY');
    }

    const visitorData = getYtcfgValue('VISITOR_DATA');
    const clientCandidates = [
      {
        clientName: 'ANDROID_VR',
        clientNameHeader: '28',
        clientVersion: '1.60.19',
        osName: 'Android',
        osVersion: '14',
        platform: 'MOBILE',
      },
      {
        clientName: 'ANDROID',
        clientNameHeader: '3',
        clientVersion: '19.09.37',
        osName: 'Android',
        osVersion: '14',
        platform: 'MOBILE',
      },
    ];

    let lastError = null;
    for (const client of clientCandidates) {
      try {
        console.log(`[OVD][YT-DEBUG] android fallback request client=${client.clientName} videoId=${videoId}`);
        const response = await fetch(`/youtubei/v1/player?prettyPrint=false&key=${encodeURIComponent(apiKey)}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            ...(visitorData ? { 'x-goog-visitor-id': visitorData } : {}),
            'x-youtube-client-name': client.clientNameHeader,
            'x-youtube-client-version': client.clientVersion,
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: client.clientName,
                clientVersion: client.clientVersion,
                hl: 'zh-CN',
                gl: 'US',
                osName: client.osName,
                osVersion: client.osVersion,
                platform: client.platform,
              },
            },
            playbackContext: {
              contentPlaybackContext: {
                html5Preference: 'HTML5_PREF_WANTS',
              },
            },
            videoId,
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (data?.streamingData) {
          return data;
        }

        throw new Error('No streamingData in fallback response');
      } catch (error) {
        lastError = error;
        console.warn(`[OVD][YT-DEBUG] android fallback failed client=${client.clientName} videoId=${videoId}: ${error.message}`);
      }
    }

    throw lastError || new Error('Android fallback failed');
  }

  function scheduleYouTubeAndroidFallback(videoId, reason, metrics = null) {
    if (!videoId || state.androidFallbackInflight.has(videoId) || state.androidFallbackAttempted.has(videoId)) {
      return;
    }

    if (!hasYouTubeAndroidFallbackPrerequisites(videoId)) {
      return;
    }

    state.androidFallbackAttempted.add(videoId);
    console.log('[OVD][YT-DEBUG] start android fallback', {
      adaptiveAudioCount: metrics?.adaptiveAudioCount || 0,
      adaptiveVideoCount: metrics?.adaptiveVideoCount || 0,
      directAudioCount: metrics?.directAudioCount || 0,
      directCombinedCount: metrics?.directCombinedCount || 0,
      directVideoCount: metrics?.directVideoCount || 0,
      maxDirectCombinedHeight: metrics?.maxDirectCombinedHeight || 0,
      maxDirectVideoHeight: metrics?.maxDirectVideoHeight || 0,
      opaqueAdaptiveAudioCount: metrics?.opaqueAdaptiveAudioCount || 0,
      opaqueAdaptiveVideoCount: metrics?.opaqueAdaptiveVideoCount || 0,
      reason: reason || 'unknown',
      videoId,
    });

    const task = fetchYouTubeAndroidPlayerResponse(videoId)
      .then((fallbackResponse) => {
        console.log('[OVD][YT-DEBUG] android fallback response', {
          adaptiveFormats: fallbackResponse?.streamingData?.adaptiveFormats?.length || 0,
          formats: fallbackResponse?.streamingData?.formats?.length || 0,
          videoId: fallbackResponse?.videoDetails?.videoId || videoId,
        });
        processYouTubePlayerResponse(fallbackResponse, { sourceTag: 'android-fallback' });
      })
      .catch((error) => {
        console.warn(`[OVD][YT-DEBUG] android fallback final failure videoId=${videoId}: ${error.message}`);
      })
      .finally(() => {
        state.androidFallbackInflight.delete(videoId);
      });

    state.androidFallbackInflight.set(videoId, task);
  }

  function getVideoIdFromUrl() {
    try {
      const params = new URLSearchParams(location.search);
      return params.get('v') || null;
    } catch {
      return null;
    }
  }

  function parseYouTubeVideoIdFromUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      if (parsed.hostname === 'youtu.be') {
        return parsed.pathname.split('/').filter(Boolean)[0] || null;
      }
      if (parsed.pathname.startsWith('/shorts/')) {
        return parsed.pathname.split('/').filter(Boolean)[1] || null;
      }
      if (parsed.pathname.startsWith('/live/')) {
        return parsed.pathname.split('/').filter(Boolean)[1] || null;
      }
      if (parsed.pathname.startsWith('/embed/')) {
        return parsed.pathname.split('/').filter(Boolean)[1] || null;
      }
      if (parsed.pathname === '/watch') {
        return new URLSearchParams(parsed.search).get('v') || null;
      }
    } catch (err) {
      console.warn(`[OVD][YT-DEBUG] failed to parse YouTube video id from URL: ${err.message}`);
    }
    return null;
  }

  function getCurrentYouTubePageVideoId() {
    const locationVideoId = parseYouTubeVideoIdFromUrl(location.href);
    if (locationVideoId) {
      return locationVideoId;
    }

    const urlVideoId = getVideoIdFromUrl();
    if (urlVideoId) {
      return urlVideoId;
    }

    try {
      const watchFlexyVideoId = document.querySelector('ytd-watch-flexy[video-id]')?.getAttribute('video-id');
      if (watchFlexyVideoId) {
        return watchFlexyVideoId;
      }
    } catch (err) {
      console.warn(`[OVD][YT-DEBUG] failed to read ytd-watch-flexy video-id: ${err.message}`);
    }

    try {
      const canonicalHref = document.querySelector('link[rel="canonical"]')?.href;
      const canonicalVideoId = parseYouTubeVideoIdFromUrl(canonicalHref);
      if (canonicalVideoId) {
        return canonicalVideoId;
      }
    } catch (err) {
      console.warn(`[OVD][YT-DEBUG] failed to read canonical YouTube URL: ${err.message}`);
    }

    try {
      const ogUrl = document.querySelector('meta[property="og:url"]')?.content;
      const ogVideoId = parseYouTubeVideoIdFromUrl(ogUrl);
      if (ogVideoId) {
        return ogVideoId;
      }
    } catch (err) {
      console.warn(`[OVD][YT-DEBUG] failed to read og:url video id: ${err.message}`);
    }

    return null;
  }

  function buildYouTubeWatchUrl(videoId) {
    if (!videoId) {
      return null;
    }
    return `${location.origin}/watch?v=${encodeURIComponent(videoId)}`;
  }

  function getCurrentYouTubePageUrl(playerResponse = null) {
    try {
      if (parseYouTubeVideoIdFromUrl(location.href)) {
        return location.href;
      }
    } catch (err) {
      console.warn(`[OVD][YT-DEBUG] failed to inspect current YouTube page URL: ${err.message}`);
    }

    try {
      const canonicalHref = document.querySelector('link[rel="canonical"]')?.href;
      if (canonicalHref && parseYouTubeVideoIdFromUrl(canonicalHref)) {
        return canonicalHref;
      }
    } catch (err) {
      console.warn(`[OVD][YT-DEBUG] failed to inspect canonical YouTube page URL: ${err.message}`);
    }

    try {
      const ogUrl = document.querySelector('meta[property="og:url"]')?.content;
      if (ogUrl && parseYouTubeVideoIdFromUrl(ogUrl)) {
        return ogUrl;
      }
    } catch (err) {
      console.warn(`[OVD][YT-DEBUG] failed to inspect og:url page URL: ${err.message}`);
    }

    const pageVideoId = getCurrentYouTubePageVideoId(playerResponse);
    return buildYouTubeWatchUrl(pageVideoId);
  }

  function isCurrentYouTubeWatchPage(playerResponse = null) {
    return !!getCurrentYouTubePageVideoId(playerResponse);
  }

  function shouldContinueSearchingYouTubeSources(playerResponse) {
    if (!playerResponse?.streamingData) {
      return true;
    }

    if (!isCurrentYouTubeWatchPage(playerResponse)) {
      return true;
    }

    const urlVideoId = getCurrentYouTubePageVideoId(playerResponse);
    const dataVideoId = playerResponse?.videoDetails?.videoId || null;
    if (urlVideoId && dataVideoId && urlVideoId !== dataVideoId) {
      return true;
    }

    const formats = playerResponse?.streamingData?.formats || [];
    const adaptiveFormats = playerResponse?.streamingData?.adaptiveFormats || [];
    if (formats.length + adaptiveFormats.length === 0) {
      return true;
    }

    const metrics = getYouTubePlayerMetricsFromFormats(formats, adaptiveFormats);
    return shouldTryAndroidPlayerFallback(metrics);
  }

  function tryExtractFromAllSources(label) {
    if (window.ytInitialPlayerResponse?.streamingData) {
      logYouTubeSourceHitOnce('ytInitialPlayerResponse', window.ytInitialPlayerResponse, label);
      const shouldContinue = shouldContinueSearchingYouTubeSources(window.ytInitialPlayerResponse);
      processYouTubePlayerResponse(window.ytInitialPlayerResponse);
      if (!shouldContinue) {
        return true;
      }
    }

    try {
      if (window.yt?.player_?.getPlayerResponse) {
        const playerResponse = window.yt.player_.getPlayerResponse();
        if (playerResponse?.streamingData) {
          logYouTubeSourceHitOnce('yt.player_.getPlayerResponse()', playerResponse, label);
          const shouldContinue = shouldContinueSearchingYouTubeSources(playerResponse);
          processYouTubePlayerResponse(playerResponse);
          if (!shouldContinue) {
            return true;
          }
        }
      }
    } catch (error) {
      console.warn(`[OVD][YT-DEBUG] source read failed label=${label} source=yt.player_: ${error.message}`);
    }

    try {
      if (window.yt?.player_?.getPlayerResponse) {
        const nestedResponse = window.yt.player_.getPlayerResponse()?.playerResponse;
        if (nestedResponse?.streamingData) {
          logYouTubeSourceHitOnce('getPlayerResponse().playerResponse', nestedResponse, label);
          const shouldContinue = shouldContinueSearchingYouTubeSources(nestedResponse);
          processYouTubePlayerResponse(nestedResponse);
          if (!shouldContinue) {
            return true;
          }
        }
      }
    } catch (err) {
      console.warn(`[OVD][YT-DEBUG] source read failed label=${label} source=getPlayerResponse().playerResponse: ${err.message}`);
    }

    try {
      if (window.yt?.config_?.PLAYER_RESPONSE?.streamingData) {
        logYouTubeSourceHitOnce('yt.config_.PLAYER_RESPONSE', window.yt.config_.PLAYER_RESPONSE, label);
        const shouldContinue = shouldContinueSearchingYouTubeSources(window.yt.config_.PLAYER_RESPONSE);
        processYouTubePlayerResponse(window.yt.config_.PLAYER_RESPONSE);
        if (!shouldContinue) {
          return true;
        }
      }
    } catch (err) {
      console.warn(`[OVD][YT-DEBUG] source read failed label=${label} source=yt.config_.PLAYER_RESPONSE: ${err.message}`);
    }

    try {
      const playerElement = document.getElementById('movie_player');
      if (playerElement && typeof playerElement.getPlayerResponse === 'function') {
        const domResponse = playerElement.getPlayerResponse();
        if (domResponse?.streamingData) {
          logYouTubeSourceHitOnce('#movie_player.getPlayerResponse()', domResponse, label);
          const shouldContinue = shouldContinueSearchingYouTubeSources(domResponse);
          processYouTubePlayerResponse(domResponse);
          if (!shouldContinue) {
            return true;
          }
        }
      }
    } catch (error) {
      console.warn(`[OVD][YT-DEBUG] source read failed label=${label} source=#movie_player: ${error.message}`);
    }

    if (flushPendingPlayerResponse(`source-scan:${label}`)) {
      return true;
    }

    scheduleCurrentVideoIdFallback('source-scan-no-valid-player-response', 1200, { label });
    return false;
  }

  function startWatching() {
    if (state.stopWatching) {
      return state.stopWatching;
    }

    let lastKnownVideoId = null;
    const cleanups = [];

    const pollInterval = setInterval(() => {
    let currentVideoId = null;
    try {
      currentVideoId = window.ytInitialPlayerResponse?.videoDetails?.videoId || null;
    } catch (err) {
      console.warn(`[OVD][YT-DEBUG] polling failed to read ytInitialPlayerResponse video id: ${err.message}`);
    }
    try {
      if (!currentVideoId) {
        currentVideoId = window.yt?.player_?.getPlayerResponse?.()?.videoDetails?.videoId || null;
      }
    } catch (err) {
      console.warn(`[OVD][YT-DEBUG] polling failed to read player response video id: ${err.message}`);
    }

      if (currentVideoId && currentVideoId !== lastKnownVideoId && currentVideoId !== state.lastReportedVideoId) {
        lastKnownVideoId = currentVideoId;
        console.log(
          `[OVD][YT-DEBUG] polling detected video change current=${currentVideoId} previous=${state.lastReportedVideoId || '-'}`
        );
        setTimeout(() => tryExtractFromAllSources('polling-delayed'), 300);
      } else {
        tryExtractFromAllSources('polling');
      }
    }, 800);

    const observer = new MutationObserver(() => {
      tryExtractFromAllSources('dom-change');
    });
    observer.observe(document.documentElement || document, { childList: true, subtree: true });

    ['yt-navigate-finish', 'yt-page-data-updated'].forEach((eventName) => {
      const handler = () => {
        console.log(`[OVD][YT-DEBUG] received YouTube event ${eventName}`);
        for (let delay = 0; delay <= 3000; delay += 500) {
          setTimeout(() => tryExtractFromAllSources(`${eventName}+${delay}ms`), delay);
        }
      };
      window.addEventListener(eventName, handler);
      cleanups.push(() => window.removeEventListener(eventName, handler));
    });

    const urlChangeHandler = () => {
      for (let delay = 0; delay <= 4000; delay += 500) {
        setTimeout(() => tryExtractFromAllSources(`urlchange+${delay}ms`), delay);
      }
    };
    window.addEventListener('ovd:urlchange', urlChangeHandler);
    cleanups.push(() => window.removeEventListener('ovd:urlchange', urlChangeHandler));

    console.log('[OVD][YT-DEBUG] started YouTube watchers');

    state.stopWatching = () => {
      clearInterval(pollInterval);
      observer.disconnect();
      cleanups.forEach((cleanup) => cleanup());
      state.stopWatching = null;
    };

    return state.stopWatching;
  }

  function processYouTubePlayerResponse(playerResponse, options = {}) {
    const sourceTag = options?.sourceTag || 'page';
    const formats = playerResponse?.streamingData?.formats || [];
    const adaptiveFormats = playerResponse?.streamingData?.adaptiveFormats || [];
    const processLogKey = [
      sourceTag,
      !!playerResponse?.streamingData,
      !!playerResponse?.videoDetails,
      playerResponse?.videoDetails?.videoId || '-',
      formats.length,
      adaptiveFormats.length,
    ].join('|');
    const hasProcessLogValue =
      !!playerResponse?.streamingData ||
      !!playerResponse?.videoDetails ||
      sourceTag === 'android-fallback';
    const shouldLogProcess =
      hasProcessLogValue &&
      (sourceTag === 'android-fallback' || state.lastProcessLogKey !== processLogKey);

    if (shouldLogProcess) {
      state.lastProcessLogKey = processLogKey;
      console.log('[OVD][YT-DEBUG] processYouTubePlayerResponse', {
        adaptiveFormatsCount: adaptiveFormats.length,
        formatsCount: formats.length,
        hasStreamingData: !!playerResponse?.streamingData,
        hasVideoDetails: !!playerResponse?.videoDetails,
        sourceTag,
        title: playerResponse?.videoDetails?.title || '',
        videoId: playerResponse?.videoDetails?.videoId || '',
      });
    }

    if (!playerResponse?.streamingData) {
      const noStreamingLogKey = buildYouTubeNoStreamingLogKey(playerResponse, sourceTag);
      const shouldLogNoStreaming =
        (sourceTag === 'android-fallback' ||
          !!playerResponse?.videoDetails?.videoId ||
          !!playerResponse?.playabilityStatus?.status) &&
        state.lastNoStreamingLogKey !== noStreamingLogKey;

      if (shouldLogNoStreaming) {
        state.lastNoStreamingLogKey = noStreamingLogKey;
        console.log('[OVD][YT-DEBUG] missing streamingData', {
          currentVideoId: getCurrentYouTubePageVideoId(playerResponse),
          dataVideoId: playerResponse?.videoDetails?.videoId || '',
          playabilityStatus: playerResponse?.playabilityStatus?.status || '',
          sourceTag,
        });
      }
      if (sourceTag !== 'android-fallback') {
        const pageVideoId = getCurrentYouTubePageVideoId(playerResponse);
        const dataVideoId = playerResponse?.videoDetails?.videoId || '';
        if (!dataVideoId || dataVideoId === pageVideoId) {
          scheduleCurrentVideoIdFallback('player-response-missing-streamingData', 1000, {
            staleDataVideoId: dataVideoId,
          });
        }
      }
      return;
    }

    const urlVideoId = getCurrentYouTubePageVideoId(playerResponse);
    const currentPageUrl = getCurrentYouTubePageUrl(playerResponse);
    const dataVideoId = playerResponse.videoDetails?.videoId || null;
    if (!urlVideoId || !currentPageUrl) {
      cachePendingPlayerResponse(playerResponse, sourceTag);
      console.log(`[OVD][YT-DEBUG] pending watch context dataVideoId=${dataVideoId || '-'}`);
      return;
    }

    if (state.pendingPlayerResponse?.key === buildYouTubeResponseDedupKey(playerResponse, sourceTag)) {
      state.pendingPlayerResponse = null;
      clearPendingReplayTimer();
    }

    if (shouldLogProcess) {
      console.log(`[OVD][YT-DEBUG] urlVideoId=${urlVideoId} dataVideoId=${dataVideoId || '-'}`);
    }

    if (urlVideoId && dataVideoId && urlVideoId !== dataVideoId) {
      console.log(`[OVD][YT-DEBUG] stale player response url=${urlVideoId} data=${dataVideoId}`);
      if (sourceTag !== 'android-fallback') {
        scheduleCurrentVideoIdFallback('stale-player-response', 900, {
          staleDataVideoId: dataVideoId,
        });
      }
      return;
    }

    const allFormats = [...formats, ...adaptiveFormats];
    if (allFormats.length === 0) {
      console.log('[OVD][YT-DEBUG] no streaming formats found');
      return;
    }

    const videoDetails = playerResponse.videoDetails || {};
    const currentVideoId = videoDetails.videoId || null;
    const responseDedupKey = buildYouTubeResponseDedupKey(playerResponse, sourceTag);
    if (state.lastResponseDedupKey === responseDedupKey) {
      return;
    }
    state.lastResponseDedupKey = responseDedupKey;

    const combined = formats
      .filter((format) => format.url && format.mimeType?.startsWith('video/'))
      .map((format) => ({
        bitrate: format.bitrate,
        contentLength: format.contentLength ? parseInt(format.contentLength, 10) : null,
        height: format.height,
        itag: format.itag,
        mimeType: format.mimeType,
        quality: format.quality,
        qualityLabel: format.qualityLabel,
        url: format.url,
        width: format.width,
      }));

    const videoStreams = adaptiveFormats
      .filter((format) => format.mimeType?.startsWith('video/'))
      .map((format) => ({
        bitrate: format.bitrate,
        contentLength: format.contentLength ? parseInt(format.contentLength, 10) : null,
        height: format.height,
        itag: format.itag,
        mimeType: format.mimeType,
        quality: format.quality,
        qualityLabel: format.qualityLabel,
        signatureCipher: format.signatureCipher || format.cipher || null,
        url: format.url || null,
        width: format.width,
      }))
      .sort((left, right) => (right.height || 0) - (left.height || 0));

    const audioStreams = adaptiveFormats
      .filter((format) => format.mimeType?.startsWith('audio/'))
      .map((format) => ({
        audioQuality: format.audioQuality,
        bitrate: format.bitrate,
        contentLength: format.contentLength ? parseInt(format.contentLength, 10) : null,
        itag: format.itag,
        mimeType: format.mimeType,
        signatureCipher: format.signatureCipher || format.cipher || null,
        url: format.url || null,
      }))
      .sort((left, right) => (right.bitrate || 0) - (left.bitrate || 0));

    const bestVideoSize = videoStreams[0]?.contentLength || combined[0]?.contentLength || null;
    const bestAudioSize = audioStreams[0]?.contentLength || null;
    const totalSize = (bestVideoSize != null && bestAudioSize != null)
      ? bestVideoSize + bestAudioSize
      : (bestVideoSize || null);

    const metrics = getYouTubePlayerMetricsFromFormats(formats, adaptiveFormats);
    const fallbackReason = getYouTubeAndroidFallbackReason(metrics);
    const summaryLogKey = buildYouTubeMetricsLogKey(currentVideoId, metrics, sourceTag);
    if (sourceTag === 'android-fallback' || state.lastSummaryLogKey !== summaryLogKey) {
      state.lastSummaryLogKey = summaryLogKey;
      console.log('[OVD][YT-DEBUG] stream summary', {
        adaptiveAudioCount: metrics.adaptiveAudioCount,
        adaptiveVideoCount: metrics.adaptiveVideoCount,
        cipherOnlyVideoCount: metrics.cipherOnlyVideoCount,
        directAudioCount: metrics.directAudioCount,
        directCombinedCount: metrics.directCombinedCount,
        directVideoCount: metrics.directVideoCount,
        fallbackReason,
        maxCipherVideoHeight: metrics.maxCipherVideoHeight,
        maxDirectCombinedHeight: metrics.maxDirectCombinedHeight,
        maxDirectVideoHeight: metrics.maxDirectVideoHeight,
        opaqueAdaptiveAudioCount: metrics.opaqueAdaptiveAudioCount,
        opaqueAdaptiveVideoCount: metrics.opaqueAdaptiveVideoCount,
        sourceTag,
        videoId: currentVideoId,
      });
    }

    if (shouldSkipDuplicateYouTubeReport(currentVideoId, metrics, sourceTag)) {
      if (sourceTag === 'android-fallback') {
        const fallbackDuplicateKey = `${summaryLogKey}|duplicate-fallback`;
        if (state.duplicateLogKey !== fallbackDuplicateKey) {
          state.duplicateLogKey = fallbackDuplicateKey;
          console.log(`[OVD][YT-DEBUG] android fallback returned no better streams videoId=${currentVideoId}`);
        }
        return;
      }

      const duplicateLogKey = `${summaryLogKey}|duplicate-${sourceTag}`;
      if (state.duplicateLogKey !== duplicateLogKey) {
        state.duplicateLogKey = duplicateLogKey;
        console.log(`[OVD][YT-DEBUG] duplicate report suppressed videoId=${currentVideoId} source=${sourceTag}`);
      }
      return;
    }

    if (metrics.cipherOnlyVideoCount > 0) {
      console.warn(
        `[OVD][YT-DEBUG] signatureCipher-only streams detected videoId=${currentVideoId} maxCipher=${metrics.maxCipherVideoHeight}p maxDirect=${Math.max(metrics.maxDirectVideoHeight, metrics.maxDirectCombinedHeight)}p source=${sourceTag}`
      );
    }

    state.lastReportedVideoId = currentVideoId;
    state.lastReportedMetrics = metrics;
    clearCurrentVideoFallbackTimer();
    console.log(
      `[OVD][YT-DEBUG] reporting videoId=${currentVideoId} combined=${combined.length} videoStreams=${videoStreams.length} audioStreams=${audioStreams.length} source=${sourceTag}`
    );

    sendToExtension({
      audioStreams,
      combined,
      duration: videoDetails.lengthSeconds ? parseInt(videoDetails.lengthSeconds, 10) : null,
      fileSize: totalSize,
      requestHeaders: {
        Referer: currentPageUrl,
      },
      thumbnail: videoDetails.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || '',
      title: videoDetails.title || document.title,
      type: 'youtube-adaptive',
      url: currentPageUrl,
      videoId: currentVideoId,
      videoStreams,
    });

    if (sourceTag !== 'android-fallback' && shouldTryAndroidPlayerFallback(metrics)) {
      if (!state.androidFallbackAttempted.has(currentVideoId) && !state.androidFallbackInflight.has(currentVideoId)) {
        state.fallbackDecisionLogKey = `${currentVideoId}|${fallbackReason || 'unknown'}|start`;
        console.log(
          `[OVD][YT-DEBUG] scheduling android fallback videoId=${currentVideoId} reason=${fallbackReason || 'unknown'}`
        );
      } else {
        const skipKey = `${currentVideoId}|${fallbackReason || 'unknown'}|skip`;
        if (state.fallbackDecisionLogKey !== skipKey) {
          state.fallbackDecisionLogKey = skipKey;
          console.log(
            `[OVD][YT-DEBUG] android fallback already inflight or attempted videoId=${currentVideoId} reason=${fallbackReason || 'unknown'}`
          );
        }
      }
      scheduleYouTubeAndroidFallback(currentVideoId, fallbackReason, metrics);
    }
  }

  function extractYouTube() {
    console.log('[OVD][YT-DEBUG] extractYouTube', {
      currentUrl: location.href,
      hasInitialResponse: !!window.ytInitialPlayerResponse,
      title: window.ytInitialPlayerResponse?.videoDetails?.title || '',
      videoId: window.ytInitialPlayerResponse?.videoDetails?.videoId || '',
    });
    tryExtractFromAllSources('extractYouTube');
  }

  registerResetter(resetState);

  window.__OVD_PAGE_YOUTUBE_PARSER__ = {
    extractYouTube,
    processYouTubePlayerResponse,
    rememberBlobUrl,
    resetState,
    startWatching,
    tryExtractFromAllSources,
  };
})();
