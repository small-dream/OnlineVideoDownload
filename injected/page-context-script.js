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

    // Popup「重新检测」→ content → 这里：重扫媒体元素并重跑平台解析。
    // 页面里的 <video> 常晚于 Popup 打开才出现（懒加载 / SPA），
    // 给用户一个手动重试入口，而不是只能刷新页面。
    const pageCore = window.__OVD_PAGE_CORE__;
    const pageMsg = window.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
    pageCore?.registerMessageHandler?.(
      pageMsg.RESCAN_PAGE_VIDEOS || 'RESCAN_PAGE_VIDEOS',
      () => {
        interceptor.scanVideoElements();
        interceptor.scanAudioElements();
        if (isYouTube) {
          scheduleYouTubeExtraction('rescan');
        }
        if (isBilibili) {
          bilibiliParser.scheduleExtraction('rescan');
        }
      }
    );

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
      watchDomForMedia();

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

  /**
   * 通用站点持续监听动态插入的 <video>/<audio>。
   * 原先只在 init/load 各扫一次，SPA 或懒加载播放器会整场漏检。
   */
  function watchDomForMedia() {
    if (watchDomForMedia.installed) {
      return;
    }
    watchDomForMedia.installed = true;

    const interceptor = window.__OVD_PAGE_INTERCEPTOR__;
    if (!interceptor || typeof MutationObserver === 'undefined') {
      return;
    }

    let scheduled = false;
    const scheduleScan = () => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        interceptor.scanVideoElements();
        interceptor.scanAudioElements();
      }, 300);
    };

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          scheduleScan();
          return;
        }
        for (const node of record.addedNodes || []) {
          if (node.nodeType !== 1) {
            continue;
          }
          if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
            scheduleScan();
            return;
          }
          if (typeof node.querySelector === 'function' && node.querySelector('video, audio, source')) {
            scheduleScan();
            return;
          }
        }
      }
    });

    observer.observe(document.documentElement || document, {
      attributeFilter: ['src'],
      attributes: true,
      childList: true,
      subtree: true,
    });

    // src 由 JS 直接赋值（property）时属性观察可能不触发，补一条媒体事件监听
    for (const eventName of ['loadstart', 'loadedmetadata']) {
      document.addEventListener(eventName, (event) => {
        const tag = event.target?.tagName;
        if (tag === 'VIDEO' || tag === 'AUDIO') {
          scheduleScan();
        }
      }, true);
    }
  }

  try {
    boot();
  } catch (error) {
    console.error('[OVD][PAGE] failed to bootstrap page context:', error);
  }
})();
