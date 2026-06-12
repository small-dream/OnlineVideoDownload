'use strict';

(() => {
  if (window.__OVD_PAGE_BILIBILI_PARSER__) {
    return;
  }

  const core = window.__OVD_PAGE_CORE__;
  if (!core) {
    console.error('[OVD][PAGE] page-bilibili-parser loaded before page-core');
    return;
  }

  const { registerResetter, sendToExtension } = core;

  const state = {
    lastReportedKey: null,
    lastValidationLogKey: null,
  };

  function resetState() {
    state.lastReportedKey = null;
    state.lastValidationLogKey = null;
  }

  function normalizeBilibiliId(value) {
    if (value == null || value === '') {
      return null;
    }
    return String(value).trim() || null;
  }

  function parseBilibiliBvidFromUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      const match = parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function parseBilibiliAidFromUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      const match = parsed.pathname.match(/\/video\/av(\d+)/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function getBilibiliPageUrlCandidate() {
    const candidates = [
      location.href,
      document.querySelector('link[rel="canonical"]')?.href || '',
      document.querySelector('meta[itemprop="url"]')?.content || '',
      document.querySelector('meta[property="og:url"]')?.content || '',
    ].filter(Boolean);

    return candidates.find((url) => {
      try {
        const pathname = new URL(url, location.origin).pathname;
        return pathname.includes('/video/') || pathname.includes('/bangumi/play/');
      } catch {
        return false;
      }
    }) || location.href;
  }

  function getCurrentBilibiliPageInfo() {
    const pageUrl = getBilibiliPageUrlCandidate();
    let pathname = '';
    let pageNumber = 1;

    try {
      const parsed = new URL(pageUrl, location.origin);
      pathname = parsed.pathname || '';
      pageNumber = Math.max(1, parseInt(parsed.searchParams.get('p') || '1', 10) || 1);
    } catch (err) {
      console.warn(`[OVD][BILI] failed to parse current page info: ${err.message}`);
    }

    return {
      aid: normalizeBilibiliId(parseBilibiliAidFromUrl(pageUrl)),
      bvid: normalizeBilibiliId(parseBilibiliBvidFromUrl(pageUrl)),
      isBangumiPage: pathname.includes('/bangumi/play/'),
      isVideoPage: pathname.includes('/video/'),
      pageNumber,
      pathname,
      url: pageUrl,
    };
  }

  function getExpectedBilibiliCid(meta, currentPage) {
    const pages = Array.isArray(meta?.pages) ? meta.pages : [];
    if (!pages.length) {
      return null;
    }

    const matchedPage = pages.find((item) => Number(item?.page) === Number(currentPage?.pageNumber || 1));
    if (matchedPage?.cid != null) {
      return normalizeBilibiliId(matchedPage.cid);
    }

    const indexedPage = pages[Math.max(0, Number(currentPage?.pageNumber || 1) - 1)];
    return normalizeBilibiliId(indexedPage?.cid);
  }

  function getBilibiliCoverFromDom() {
    return (
      document.querySelector('meta[property="og:image"]')?.content ||
      document.querySelector('meta[itemprop="image"]')?.content ||
      document.querySelector('.cover img')?.src ||
      document.querySelector('.video-cover img')?.src ||
      ''
    );
  }

  function shouldReportBilibiliMeta(meta, currentPage) {
    if (!meta?.cid) {
      return { ok: false, reason: 'missing-cid' };
    }

    if (!currentPage?.isVideoPage && !currentPage?.isBangumiPage) {
      return { ok: false, reason: 'not-bilibili-play-page' };
    }

    const metaBvid = normalizeBilibiliId(meta.bvid);
    const metaAid = normalizeBilibiliId(meta.aid);
    const metaCid = normalizeBilibiliId(meta.cid);
    const currentBvid = normalizeBilibiliId(currentPage.bvid);
    const currentAid = normalizeBilibiliId(currentPage.aid);

    if (currentPage.isVideoPage) {
      if (currentBvid && metaBvid && currentBvid !== metaBvid) {
        return { ok: false, reason: 'bvid-mismatch' };
      }

      if (currentAid && metaAid && currentAid !== metaAid) {
        return { ok: false, reason: 'aid-mismatch' };
      }

      if ((currentBvid || currentAid) && !(metaBvid || metaAid)) {
        return { ok: false, reason: 'candidate-missing-page-id' };
      }

      const expectedCid = getExpectedBilibiliCid(meta, currentPage);
      if (expectedCid && metaCid && expectedCid !== metaCid) {
        return { ok: false, reason: 'cid-mismatch' };
      }
    }

    return { ok: true, reason: 'matched' };
  }

  function getBilibiliMetaFromInitialState() {
    const initialState = window.__INITIAL_STATE__;
    if (!initialState) {
      return null;
    }

    const videoData = initialState.videoData || initialState.epInfo;
    if (!videoData) {
      return null;
    }

    return {
      aid: videoData.aid || initialState.aid || null,
      bvid: videoData.bvid || initialState.bvid || null,
      cid: videoData.cid || initialState.cid || null,
      duration: videoData.duration ? parseInt(videoData.duration, 10) : null,
      isLogin: !!initialState.isLogin,
      pages: videoData.pages || [],
      thumbnail: videoData.pic || videoData.cover || initialState.pic || getBilibiliCoverFromDom(),
      title: videoData.title || document.title,
    };
  }

  function getBilibiliMetaFromPlayInfo() {
    const playInfo = window.__playinfo__;
    if (!playInfo) {
      return null;
    }

    const bvidFromMeta = document.querySelector('meta[itemprop="url"]')?.content?.split('/').filter(Boolean).pop() || null;
    const titleFromDom =
      document.querySelector('h1.video-title')?.textContent?.trim() ||
      document.querySelector('.media-title')?.textContent?.trim() ||
      document.title;

    return {
      aid: playInfo.aid || playInfo?.data?.aid || null,
      bvid: bvidFromMeta,
      cid: playInfo.cid || playInfo?.data?.cid || null,
      duration: playInfo?.data?.timelength ? Math.round(playInfo.data.timelength / 1000) : null,
      isLogin: null,
      pages: [],
      thumbnail: getBilibiliCoverFromDom(),
      title: titleFromDom,
    };
  }

  function getBilibiliMetaFromPlayer() {
    if (!window.player?.getVideoInfo) {
      return null;
    }

    try {
      const info = window.player.getVideoInfo();
      if (!info) {
        return null;
      }

      return {
        aid: info.aid || null,
        bvid: info.bvid || null,
        cid: info.cid || null,
        duration: info.duration ? parseInt(info.duration, 10) : null,
        isLogin: null,
        pages: [],
        thumbnail: info.pic || info.cover || getBilibiliCoverFromDom(),
        title: info.title || document.title,
      };
    } catch {
      return null;
    }
  }

  function extractBilibili() {
    const currentPage = getCurrentBilibiliPageInfo();
    const candidates = [
      getBilibiliMetaFromInitialState(),
      getBilibiliMetaFromPlayInfo(),
      getBilibiliMetaFromPlayer(),
    ].filter(Boolean);

    const meta = candidates.find((candidate) => {
      const validation = shouldReportBilibiliMeta(candidate, currentPage);
      const logKey = [
        currentPage.url,
        currentPage.pageNumber,
        validation.reason,
        candidate?.bvid || candidate?.aid || '-',
        candidate?.cid || '-',
      ].join('|');

      if (!validation.ok) {
        if (state.lastValidationLogKey !== logKey) {
          state.lastValidationLogKey = logKey;
          console.log('[OVD][BILI] skip candidate', {
            candidateAid: candidate?.aid || null,
            candidateBvid: candidate?.bvid || null,
            candidateCid: candidate?.cid || null,
            currentAid: currentPage.aid,
            currentBvid: currentPage.bvid,
            currentPageNumber: currentPage.pageNumber,
            currentUrl: currentPage.url,
            reason: validation.reason,
          });
        }
        return false;
      }

      return true;
    });

    if (!meta) {
      return false;
    }

    const reportKey = `${meta.bvid || meta.aid}:${meta.cid}`;
    if (reportKey === state.lastReportedKey) {
      return true;
    }
    state.lastReportedKey = reportKey;

    sendToExtension({
      aid: meta.aid,
      bvid: meta.bvid,
      cid: meta.cid,
      duration: meta.duration != null ? parseInt(meta.duration, 10) : null,
      isLogin: !!meta.isLogin,
      pages: meta.pages || [],
      thumbnail: meta.thumbnail || getBilibiliCoverFromDom(),
      title: meta.title || document.title,
      type: 'bilibili-meta',
      url: currentPage.url,
    });

    return true;
  }

  function scheduleExtraction(reason) {
    const retryDelays = [0, 200, 500, 1000, 2000, 3500];
    retryDelays.forEach((delay) => {
      setTimeout(() => {
        const ok = extractBilibili();
        if (ok) {
          console.log(`[OVD][BILI] extract success reason=${reason} delay=${delay} url=${location.href}`);
        } else if (delay === retryDelays[retryDelays.length - 1]) {
          console.warn(`[OVD][BILI] extract failed reason=${reason} url=${location.href}`);
        }
      }, delay);
    });
  }

  registerResetter(resetState);

  window.__OVD_PAGE_BILIBILI_PARSER__ = {
    extractBilibili,
    resetState,
    scheduleExtraction,
  };
})();
