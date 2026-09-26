'use strict';

(() => {
  if (window.__OVD_PAGE_INTERCEPTOR__) {
    return;
  }

  const core = window.__OVD_PAGE_CORE__;
  const httpUtils = window.__OVD_PAGE_HTTP_UTILS__;
  const youtubeParser = window.__OVD_PAGE_YOUTUBE_PARSER__;
  const bilibiliParser = window.__OVD_PAGE_BILIBILI_PARSER__;

  if (!core || !httpUtils || !youtubeParser || !bilibiliParser) {
    console.error('[OVD][PAGE] page-interceptor loaded before its dependencies');
    return;
  }

  const { MSG, resetForUrlChange, sendToExtension } = core;
  const { originalFetch } = httpUtils;

  const state = {
    installed: false,
  };

  function isYouTubePage() {
    return location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be');
  }

  function isYouTubeMediaUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.hostname.includes('googlevideo.com') || parsed.pathname.includes('/videoplayback');
    } catch {
      return false;
    }
  }

  function shouldSuppressGenericDetection(url = '') {
    if (!isYouTubePage()) {
      return false;
    }

    if (url.includes('/youtubei/v1/player') || url.includes('/youtubei/v1/next')) {
      return false;
    }

    return true;
  }

  function detectVideoType(url, contentType) {
    const normalizedContentType = String(contentType || '').toLowerCase();
    if (normalizedContentType.includes('application/vnd.apple.mpegurl') || normalizedContentType.includes('application/x-mpegurl')) {
      return 'hls';
    }
    if (normalizedContentType.includes('application/dash+xml')) {
      return 'dash';
    }
    // video/mp4、video/webm、video/mp2t、video/quicktime 等都可直链保存
    if (normalizedContentType.startsWith('video/')) {
      return 'direct';
    }
    if (normalizedContentType.startsWith('audio/')) {
      return 'audio';
    }

    try {
      const pathname = new URL(url, location.href).pathname.toLowerCase();
      if (pathname.includes('.m3u8')) return 'hls';
      if (pathname.includes('.mpd')) return 'dash';
      if (/\.(mp4|webm|flv|m4v|mkv|mov|ts|mpg|mpeg|avi|ogv)(\?|$)/.test(pathname)) return 'direct';
      if (/\.(mp3|flac|oga|ogg|m4a|aac|wav)(\?|$)/.test(pathname)) return 'audio';
    } catch (err) {
      console.warn(`[OVD][PAGE] failed to detect video type from URL: ${err.message}`);
    }

    return null;
  }

  function reportVideo(url, type, extra) {
    if (shouldSuppressGenericDetection(url)) {
      return;
    }

    sendToExtension({
      requestHeaders: {},
      title: frameDisplayTitle(),
      type,
      url,
      ...extra,
    });
  }

  /**
   * 子框架的 document.title 通常是播放器自己的名字（现场：「弹幕播放器」），
   * 对用户和文件名都没有意义。留空交给 background 用标签页标题（视频名）补全；
   * 顶层 frame 维持原行为。
   */
  function frameDisplayTitle() {
    try {
      return window.top === window ? document.title : '';
    } catch (_err) {
      return document.title;
    }
  }

  function fetchMediaElementSize(url, type, duration, source) {
    if (type !== 'direct' && type !== 'audio') {
      return;
    }

    fetch(url, { method: 'HEAD' })
      .then((response) => {
        const size = response.headers.get('content-length');
        const mimeType = response.headers.get('content-type') || '';
        if (size || mimeType) {
          reportVideo(url, type, {
            duration,
            fileSize: size ? parseInt(size, 10) : undefined,
            mimeType,
            source,
          });
        }
      })
      .catch((err) => {
        console.warn(`[OVD][PAGE] failed to fetch media element size: ${err.message}`);
      });
  }

  function scanVideoElements() {
    if (isYouTubePage()) {
      return;
    }

    const videos = document.querySelectorAll('video[src], video source[src]');
    for (const element of videos) {
      const src = element.src || element.getAttribute('src');
      if (!src || src.startsWith('blob:') || src.startsWith('data:')) {
        continue;
      }

      try {
        const fullUrl = new URL(src, location.href).href;
        const type = detectVideoType(fullUrl, '');
        if (!type) {
          continue;
        }

        const videoElement = element.tagName === 'VIDEO' ? element : element.closest('video');
        const duration = (videoElement?.duration && Number.isFinite(videoElement.duration))
          ? Math.round(videoElement.duration)
          : null;

        reportVideo(fullUrl, type, { duration, source: 'video-element' });
        fetchMediaElementSize(fullUrl, type, duration, 'video-element');
      } catch (err) {
        console.warn(`[OVD][PAGE] failed to scan video element source: ${err.message}`);
      }
    }
  }

  function scanAudioElements() {
    if (isYouTubePage()) {
      return;
    }

    const audioElements = document.querySelectorAll('audio[src], audio source[src]');
    for (const element of audioElements) {
      const src = element.src || element.getAttribute('src');
      if (!src || src.startsWith('blob:') || src.startsWith('data:')) {
        continue;
      }

      try {
        const fullUrl = new URL(src, location.href).href;
        const type = detectVideoType(fullUrl, '');
        if (type !== 'audio') {
          continue;
        }

        const audioElement = element.tagName === 'AUDIO' ? element : element.closest('audio');
        const duration = (audioElement?.duration && Number.isFinite(audioElement.duration))
          ? Math.round(audioElement.duration)
          : null;

        reportVideo(fullUrl, type, { duration, source: 'audio-element' });
        fetchMediaElementSize(fullUrl, type, duration, 'audio-element');
      } catch (err) {
        console.warn(`[OVD][PAGE] failed to scan audio element source: ${err.message}`);
      }
    }
  }

  function install() {
    if (state.installed) {
      return;
    }
    state.installed = true;

    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const xhrAddEventListener = XMLHttpRequest.prototype.addEventListener;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._ovd_url = url ? new URL(url, location.href).href : null;
      this._ovd_reqHeaders = {};
      return xhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (this._ovd_reqHeaders) {
        this._ovd_reqHeaders[name] = value;
      }
      return xhrSetRequestHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.addEventListener = function (type, listener, ...rest) {
      if ((type === 'load' || type === 'loadend') && typeof listener === 'function') {
        const originalListener = listener;
        const wrappedListener = function (...args) {
          if (this._ovd_url) {
            if (
              (this._ovd_url.includes('/youtubei/v1/player') || this._ovd_url.includes('/youtubei/v1/next')) &&
              location.hostname.includes('youtube.com')
            ) {
              console.log(`[OVD][YT-DEBUG] XHR player response url=${this._ovd_url.substring(0, 150)}`);
              try {
                const responseText = this.responseText;
                if (responseText) {
                  youtubeParser.processYouTubePlayerResponse(JSON.parse(responseText));
                }
              } catch (error) {
                console.error('[OVD][YT-DEBUG] XHR player response parse failed:', error);
              }
            }

            const contentType = this.getResponseHeader ? (this.getResponseHeader('content-type') || '') : '';
            const videoType = detectVideoType(this._ovd_url, contentType);
            if (videoType) {
              if (isYouTubePage()) {
                return originalListener.apply(this, args);
              }
              reportVideo(this._ovd_url, videoType, {
                mimeType: contentType,
                requestHeaders: this._ovd_reqHeaders,
              });
            }
          }

          return originalListener.apply(this, args);
        };

        return xhrAddEventListener.call(this, type, wrappedListener, ...rest);
      }

      return xhrAddEventListener.call(this, type, listener, ...rest);
    };

    window.fetch = function (input, init) {
      let url;
      try {
        url = typeof input === 'string'
          ? new URL(input, location.href).href
          : (input instanceof Request ? input.url : null);
      } catch {
        url = typeof input === 'string' ? input : null;
      }

      const requestHeaders = {};
      if (init?.headers) {
        try {
          if (init.headers instanceof Headers) {
            init.headers.forEach((value, key) => {
              requestHeaders[key] = value;
            });
          } else if (Array.isArray(init.headers)) {
            init.headers.forEach(([key, value]) => {
              requestHeaders[key] = value;
            });
          } else {
            Object.assign(requestHeaders, init.headers);
          }
        } catch (err) {
          console.warn(`[OVD][PAGE] failed to normalize fetch request headers: ${err.message}`);
        }
      }

      const promise = originalFetch(input, init);
      if (url) {
        promise.then((response) => {
          try {
            if (url.includes('/youtubei/v1/player') && location.hostname.includes('youtube.com')) {
              console.log(`[OVD][YT-DEBUG] fetch player response url=${url.substring(0, 150)}`);
              response.clone().json()
                .then((data) => {
                  youtubeParser.processYouTubePlayerResponse(data);
                })
                .catch((error) => {
                  console.error('[OVD][YT-DEBUG] fetch player response parse failed:', error);
                });
            }

            const contentType = response.headers?.get('content-type') || '';
            const videoType = detectVideoType(url, contentType);
            if (videoType) {
              if (isYouTubePage()) {
                return;
              }
              reportVideo(url, videoType, {
                mimeType: contentType,
                requestHeaders,
              });
            }
          } catch (err) {
            console.warn(`[OVD][PAGE] failed to inspect fetch response for media detection: ${err.message}`);
          }
        }).catch((err) => {
          console.warn(`[OVD][PAGE] fetch interception promise rejected: ${err.message}`);
        });
      }

      return promise;
    };

    if (window.MediaSource) {
      const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mimeType) {
        const sourceBuffer = addSourceBuffer.call(this, mimeType);

        if (isYouTubePage()) {
          return sourceBuffer;
        }

        if (mimeType && (mimeType.startsWith('video/') || mimeType.startsWith('audio/') || mimeType.includes('mp4'))) {
          setTimeout(() => {
            const mediaElements = document.querySelectorAll('video, audio');
            for (const mediaElement of mediaElements) {
              if (mediaElement.src && mediaElement.src.startsWith('blob:')) {
                if (youtubeParser.rememberBlobUrl(mediaElement.src)) {
                  continue;
                }
                sendToExtension({
                  mimeType,
                  source: 'mediasource',
                  title: frameDisplayTitle(),
                  type: 'blob',
                  url: mediaElement.src,
                });
              }
            }
          }, 200);
        }

        return sourceBuffer;
      };
    }

    if (navigator.requestMediaKeySystemAccess) {
      const requestMediaKeySystemAccess = navigator.requestMediaKeySystemAccess.bind(navigator);
      navigator.requestMediaKeySystemAccess = function (keySystem, configs) {
        if (keySystem && (keySystem.includes('widevine') || keySystem.includes('playready') || keySystem.includes('clearkey'))) {
          sendToExtension({
            keySystem,
            title: document.title,
            type: 'drm-detected',
            url: location.href,
          });
        }
        return requestMediaKeySystemAccess(keySystem, configs);
      };
    }

    const pushState = history.pushState.bind(history);
    const replaceState = history.replaceState.bind(history);

    history.pushState = function (...args) {
      const result = pushState(...args);
      window.dispatchEvent(new Event('ovd:urlchange'));
      return result;
    };

    history.replaceState = function (...args) {
      const result = replaceState(...args);
      window.dispatchEvent(new Event('ovd:urlchange'));
      return result;
    };

    window.addEventListener('popstate', () => {
      window.dispatchEvent(new Event('ovd:urlchange'));
    });

    window.addEventListener('ovd:urlchange', () => {
      resetForUrlChange();
      sendToExtension({
        type: MSG.PAGE_CHANGED || 'page-changed',
        url: location.href,
      });
      if (location.hostname.includes('bilibili.com')) {
        bilibiliParser.scheduleExtraction('urlchange');
      }
    });
  }

  window.__OVD_PAGE_INTERCEPTOR__ = {
    detectVideoType,
    fetchMediaElementSize,
    install,
    isYouTubeMediaUrl,
    reportVideo,
    scanAudioElements,
    scanVideoElements,
  };
})();
