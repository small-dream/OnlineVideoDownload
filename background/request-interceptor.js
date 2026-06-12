// background/request-interceptor.js
// Observe network requests with the webRequest API and register media candidates.
// MV3 only allows observation here; requests cannot be blocked.

export class RequestInterceptor {
  constructor(registry, onDetected) {
    this.registry = registry;
    this.onDetected = onDetected; // callback(tabId, count)
  }

  start() {
    try {
      chrome.webRequest.onBeforeRequest.addListener(
        this._onBeforeRequest.bind(this),
        { urls: ['<all_urls>'] }
      );
    } catch (err) {
      console.error('[OVD] Failed to register onBeforeRequest listener:', err);
    }

    try {
      chrome.webRequest.onHeadersReceived.addListener(
        this._onHeadersReceived.bind(this),
        { urls: ['<all_urls>'] },
        ['responseHeaders']
      );
    } catch (err) {
      console.error('[OVD] Failed to register onHeadersReceived listener:', err);
    }

    try {
      chrome.webRequest.onSendHeaders.addListener(
        this._onSendHeaders.bind(this),
        { urls: ['<all_urls>'] },
        ['requestHeaders']
      );
    } catch (err) {
      console.error('[OVD] Failed to register onSendHeaders listener:', err);
    }
  }

  _logMediaLabel(type) {
    return type === 'audio' ? 'audio' : 'video';
  }

  _onBeforeRequest(details) {
    if (details.type === 'main_frame') return;
    if (details.tabId < 0) return;

    const { url, tabId } = details;

    // YouTube 媒体流由 page-context-script 的 processYouTubePlayerResponse 统一处理
    if (this._isYouTubeMediaUrl(url)) return;

    const type = this._detectTypeByUrl(url);
    if (!type) return;

    console.log(`[OVD] detected ${this._logMediaLabel(type)} request type=${type} tab=${tabId} url=${url}`);

    const result = this.registry.add(tabId, {
      url,
      type,
      title: '',
      requestHeaders: {},
    });

    if (result === 'new') {
      console.log(`[OVD] registered ${this._logMediaLabel(type)} candidate tab=${tabId} count=${this.registry.countForTab(tabId)}`);
      this.onDetected(tabId, this.registry.countForTab(tabId));
    }
  }

  _onHeadersReceived(details) {
    if (details.type === 'main_frame') return;
    if (details.tabId < 0) return;

    const { url, tabId, responseHeaders } = details;

    try {
      const u = new URL(url);
      if (u.pathname.toLowerCase().endsWith('.m4s')) return;
      // YouTube 媒体流由 page-context-script 统一处理
      if (u.hostname.includes('googlevideo.com')) return;
    } catch (err) {
      console.warn(`[OVD] failed to inspect response URL in request interceptor: ${err.message}`);
    }

    const contentType = responseHeaders
      ?.find((header) => header.name.toLowerCase() === 'content-type')
      ?.value || '';
    const contentLength = responseHeaders
      ?.find((header) => header.name.toLowerCase() === 'content-length')
      ?.value || '';

    const type = this._detectTypeByMime(contentType);
    if (!type) return;

    const existing = this.registry.getByUrl(tabId, url);
    if (existing && existing.type !== 'direct' && existing.type !== 'audio') return;

    console.log(`[OVD] confirmed ${this._logMediaLabel(type)} by response headers type=${type} content-type=${contentType} tab=${tabId} url=${url}`);

    const fileSize = contentLength ? parseInt(contentLength, 10) : undefined;
    const result = this.registry.add(tabId, {
      url,
      type,
      mimeType: contentType || undefined,
      fileSize: Number.isFinite(fileSize) ? fileSize : undefined,
    });
    if (result === 'new') {
      console.log(`[OVD] registered ${this._logMediaLabel(type)} candidate from mime tab=${tabId}`);
      this.onDetected(tabId, this.registry.countForTab(tabId));
    } else {
      console.log(`[OVD] skipped duplicate ${this._logMediaLabel(type)} tab=${tabId} url=${url.substring(0, 80)}`);
    }
  }

  _onSendHeaders(details) {
    if (details.tabId < 0) return;

    const { url, tabId, requestHeaders } = details;
    if (!requestHeaders) return;

    const type = this._detectTypeByUrl(url);
    if (!type) return;

    const headersObj = {};
    for (const header of requestHeaders) {
      const name = header.name.toLowerCase();
      if (['origin', 'referer', 'cookie'].includes(name)) {
        headersObj[header.name] = header.value;
      }
    }

    if (Object.keys(headersObj).length > 0) {
      console.log(`[OVD] captured request headers tab=${tabId} keys=${Object.keys(headersObj).join(',')} url=${url}`);
      this.registry.add(tabId, { url, type, requestHeaders: headersObj });
    }
  }

  _detectTypeByUrl(url) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      if (pathname.includes('.m3u8')) return 'hls';
      if (pathname.includes('.mpd')) return 'dash';
      if (/\.(mp4|webm|flv|m4v|mkv)(\?|$)/.test(pathname)) return 'direct';
      if (/\.(mp3|flac|oga|ogg|m4a|aac|wav)(\?|$)/.test(pathname)) return 'audio';
    } catch {
      // Ignore invalid URLs.
    }
    return null;
  }

  /** YouTube 媒体流 URL（googlevideo.com），由 page script 统一处理 */
  _isYouTubeMediaUrl(url) {
    try {
      return new URL(url).hostname.includes('googlevideo.com');
    } catch {
      return false;
    }
  }

  _detectTypeByMime(contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl')) return 'hls';
    if (ct.includes('application/dash+xml')) return 'dash';
    if (ct.startsWith('audio/')) return 'audio';
    if (ct.startsWith('video/mp4') || ct.startsWith('video/webm') || ct.startsWith('video/x-flv')) return 'direct';
    return null;
  }
}
