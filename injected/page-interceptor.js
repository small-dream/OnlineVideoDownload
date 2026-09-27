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

  const THUMBNAIL_MAX_WIDTH = 320;
  const THUMBNAIL_JPEG_QUALITY = 0.72;
  // 与 lib/page-message-guard.js 的上限保持一致
  const THUMBNAIL_MAX_LENGTH = 262144;
  const THUMBNAIL_DATA_URL_PATTERN = /^data:image\/(?:jpeg|jpg|png|webp);base64,/i;
  // <video> 元素 → 已截取的封面，避免每次重扫都做一次 canvas 编码
  const videoThumbnailCache = new WeakMap();
  // <video> 元素 → 已经上报过封面的 src，避免把几十 KB 的 data URL 反复 postMessage
  const reportedThumbnailCache = new WeakMap();
  // 页面级封面（og:image 一族）：跨域播放器截不了帧、也没有 poster 时兜底
  const PAGE_THUMBNAIL_META_SELECTOR = 'meta[property="og:image"], meta[name="twitter:image"], meta[itemprop="thumbnailUrl"]';
  let cachedPageThumbnail = '';

  /** 页面数据不可信：只接受图片地址或 base64 图片 data URL */
  function sanitizeThumbnailValue(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw || raw.length > THUMBNAIL_MAX_LENGTH) {
      return '';
    }
    if (THUMBNAIL_DATA_URL_PATTERN.test(raw)) {
      return raw;
    }
    return /^(?:https?:\/\/|\/\/)/i.test(raw) ? raw : '';
  }

  function resolvePosterThumbnail(videoElement) {
    try {
      const poster = videoElement?.poster || videoElement?.getAttribute?.('poster') || '';
      if (!poster) {
        return '';
      }
      return sanitizeThumbnailValue(new URL(poster, location.href).href);
    } catch (err) {
      console.warn(`[OVD][PAGE] failed to resolve video poster: ${err.message}`);
      return '';
    }
  }

  /**
   * 截取当前画面当封面。跨域且未声明 CORS 的媒体会污染 canvas（drawImage/toDataURL 抛错），
   * 此时返回空串，由 poster 或 Popup 侧的带请求头补全兜底。
   */
  function captureFrameThumbnail(videoElement) {
    try {
      if (!videoElement || videoElement.tagName !== 'VIDEO' || videoElement.readyState < 2) {
        return '';
      }

      const width = videoElement.videoWidth;
      const height = videoElement.videoHeight;
      if (!width || !height) {
        return '';
      }

      const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));

      const context = canvas.getContext('2d');
      if (!context) {
        return '';
      }

      context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      return sanitizeThumbnailValue(canvas.toDataURL('image/jpeg', THUMBNAIL_JPEG_QUALITY));
    } catch (err) {
      console.warn(`[OVD][PAGE] thumbnail frame capture skipped: ${err.message}`);
      return '';
    }
  }

  /**
   * 缩略图优先取作者提供的 poster（不存在跨域污染），没有 poster 才截当前帧。
   * 同一元素 + 同一 src 只截一次，避免媒体事件触发的重扫反复编码。
   */
  function extractMediaThumbnail(mediaElement, sourceUrl) {
    if (!mediaElement || mediaElement.tagName !== 'VIDEO') {
      return '';
    }

    const poster = resolvePosterThumbnail(mediaElement);
    if (poster) {
      return poster;
    }

    const cacheKey = String(sourceUrl || '');
    const cached = videoThumbnailCache.get(mediaElement);
    if (cached && cached.sourceUrl === cacheKey && cached.thumbnail) {
      return cached.thumbnail;
    }

    const captured = captureFrameThumbnail(mediaElement);
    if (captured) {
      videoThumbnailCache.set(mediaElement, { sourceUrl: cacheKey, thumbnail: captured });
    }
    return captured;
  }

  /**
   * 页面自报的社交卡片封面。这类图片是作者为「这个页面」准备的，因此只在
   * 本 frame 只有一个 <video>（封面不会张冠李戴到另一个播放器）时启用。
   * 没找到时不做负缓存：og:image 可能由页面脚本稍后注入。
   */
  function resolvePageThumbnail() {
    if (cachedPageThumbnail) {
      return cachedPageThumbnail;
    }

    try {
      const meta = document.querySelector(PAGE_THUMBNAIL_META_SELECTOR);
      const content = meta?.getAttribute?.('content') || '';
      if (!content) {
        return '';
      }

      const resolved = sanitizeThumbnailValue(new URL(content, location.href).href);
      if (resolved) {
        cachedPageThumbnail = resolved;
      }
      return resolved;
    } catch (err) {
      console.warn(`[OVD][PAGE] failed to resolve page thumbnail: ${err.message}`);
      return '';
    }
  }

  /**
   * 只在首次拿到封面时附带 thumbnail 字段：注册表合并时会保留已捕获的封面，
   * 后续重扫（媒体事件、MutationObserver）不必再重复传一次 data URL。
   * 元素级封面（poster / 截帧）优先；单 <video> frame 才退回页面级封面。
   */
  function takeThumbnailPayload(mediaElement, sourceUrl, soleVideoElement = false) {
    const thumbnail = extractMediaThumbnail(mediaElement, sourceUrl)
      || (soleVideoElement ? resolvePageThumbnail() : '');
    if (!thumbnail || reportedThumbnailCache.get(mediaElement) === sourceUrl) {
      return {};
    }

    reportedThumbnailCache.set(mediaElement, sourceUrl);
    return soleVideoElement ? { thumbnail, thumbnailScope: 'frame' } : { thumbnail };
  }

  function scanVideoElements() {
    if (isYouTubePage()) {
      return;
    }

    // 本 frame 只有一个 <video> 时，它的封面可以代表该 frame 的其它检测条目：
    // 典型场景是 hls.js 播放器同时上报 m3u8 与 MSE blob 两条记录，只有一条拿得到画面。
    const soleVideoElement = document.querySelectorAll('video').length === 1;
    const mediaElements = document.querySelectorAll('video[src], video source[src]');

    for (const element of mediaElements) {
      const src = element.src || element.getAttribute('src');
      if (!src) {
        continue;
      }

      const videoElement = element.tagName === 'VIDEO' ? element : element.closest('video');
      try {
        const fullUrl = new URL(src, location.href).href;
        // blob:（MSE 播放流）同样登记：补上封面，也覆盖 createObjectURL 的自建播放器
        const isBlobSource = /^blob:/i.test(fullUrl);
        if (!isBlobSource && fullUrl.startsWith('data:')) {
          continue;
        }

        const type = isBlobSource ? 'blob' : detectVideoType(fullUrl, '');
        if (!type) {
          continue;
        }

        const duration = (videoElement?.duration && Number.isFinite(videoElement.duration))
          ? Math.round(videoElement.duration)
          : null;
        const extra = {
          duration,
          source: 'video-element',
          ...takeThumbnailPayload(videoElement, fullUrl, soleVideoElement),
        };

        reportVideo(fullUrl, type, extra);
        if (!isBlobSource) {
          fetchMediaElementSize(fullUrl, type, duration, 'video-element');
        }
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
            const soleVideoElement = document.querySelectorAll('video').length === 1;
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
                  ...takeThumbnailPayload(mediaElement, mediaElement.src, soleVideoElement),
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
    captureFrameThumbnail,
    detectVideoType,
    extractMediaThumbnail,
    fetchMediaElementSize,
    install,
    isYouTubeMediaUrl,
    reportVideo,
    resolvePageThumbnail,
    sanitizeThumbnailValue,
    scanAudioElements,
    scanVideoElements,
    takeThumbnailPayload,
  };
})();
