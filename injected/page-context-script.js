'use strict';

(() => {
  if (window.__OVD_PAGE_CONTEXT_BOOTSTRAPPED__) {
    return;
  }
  window.__OVD_PAGE_CONTEXT_BOOTSTRAPPED__ = true;

  function boot() {
    if (window.__OVD_INJECTED__) {
      return;
    }
    window.__OVD_INJECTED__ = true;

    const interceptor = window.__OVD_PAGE_INTERCEPTOR__;
    const youtubeParser = window.__OVD_PAGE_YOUTUBE_PARSER__;
    const bilibiliParser = window.__OVD_PAGE_BILIBILI_PARSER__;

    if (!interceptor || !youtubeParser || !bilibiliParser) {
      throw new Error('Missing page context modules');
    }

    interceptor.install();

    const hostname = location.hostname || '';
    const isYouTube = hostname.includes('youtube.com') || hostname.includes('youtu.be');
    const isBilibili = hostname.includes('bilibili.com');

    if (isYouTube) {
      youtubeParser.startWatching();
    }

    function scheduleYouTubeExtraction(reason) {
      if (!isYouTube) {
        return;
      }

      [0, 300, 800, 1500, 3000].forEach((delay) => {
        setTimeout(() => {
          console.log(`[OVD][PAGE] youtube extract retry reason=${reason} delay=${delay}`);
          youtubeParser.extractYouTube();
        }, delay);
      });
    }

    function init() {
      console.log('[OVD][PAGE] init', {
        hostname,
        readyState: document.readyState,
        url: location.href,
      });

      interceptor.scanVideoElements();
      interceptor.scanAudioElements();

      if (isYouTube) {
        scheduleYouTubeExtraction('init');
        window.addEventListener('yt-navigate-finish', () => {
          scheduleYouTubeExtraction('yt-navigate-finish');
        });
      }

      if (isBilibili) {
        bilibiliParser.scheduleExtraction('init');
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }

    window.addEventListener('load', () => {
      if (isYouTube) {
        scheduleYouTubeExtraction('load');
      }
      if (isBilibili) {
        bilibiliParser.scheduleExtraction('load');
      }
      interceptor.scanVideoElements();
      interceptor.scanAudioElements();
    });
  }

  try {
    boot();
  } catch (error) {
    console.error('[OVD][PAGE] failed to bootstrap page context:', error);
  }
})();
