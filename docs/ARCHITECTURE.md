# Online Video Downloader Architecture

> Version: 1.16.0
> Last Updated: 2026-09-25

## Goals

- Keep source-specific logic isolated by source and strategy.
- Keep shared download primitives in reusable libraries instead of duplicating them across runtimes.
- Reduce `content/content-main.js` to a composition entry instead of a giant implementation file.
- Let background strategies own their download behavior while `Downloader` stays focused on orchestration.

## Runtime Layout

```text
Page Context
  injected/page-context-script.js
    -> injected/page-core.js
    -> injected/page-http-utils.js
    -> injected/page-youtube-parser.js
    -> injected/page-bilibili-parser.js
    -> injected/page-interceptor.js
    -> postMessage

Content Script
  lib/ovd-logger.js
  lib/bilibili-quality-utils.js
  lib/bilibili-quality-store.js
  lib/settings-store.js
  lib/youtube-download-mode-store.js
  lib/youtube-stream-utils.js
  lib/ui-dom-utils.js
  lib/wbi-signer.js
  lib/hls-pipeline.js
  lib/mpd-parser.js
  content/youtube-download-options.js
  content/youtube-download-errors.js
  content/strategies/*
  content/stream-transfer-manager.js
  content/download-coordinator.js
  content/float-button.js
  content/message-router.js
  content/content-main.js
    -> chrome.runtime.sendMessage / chrome.tabs.sendMessage

Service Worker
  background/service-worker.js
  background/downloader.js
  background/hls-fetcher.js
  background/download-strategy-registry.js
  background/download-strategies/*
  background/download-history-store.js
  background/download-notification.js
  background/action-badge.js
  background/clear-video-scope.js

Popup
  lib/settings-store.js
  lib/bilibili-quality-utils.js
  lib/bilibili-quality-store.js
  lib/youtube-download-mode-store.js
  lib/youtube-stream-utils.js
  popup/popup-error-messages.js
  popup/popup.js
```

## Shared Libraries

### `lib/wbi-signer.js`

Responsibilities:

- Compute Bilibili `w_rid` signatures.
- Provide a JS `md5()` fallback when WebCrypto MD5 is unavailable.
- Expose helpers through `globalThis.__OVD_WBI_SIGNER__`.

Public surface:

- `calcWrid(params, imgKey, subKey)`
- `md5(str)`

### `lib/hls-pipeline.js`

Responsibilities:

- Centralize HLS parsing, URL resolution, encryption parsing, decryption, and output profile inference.
- Remove duplicated HLS helpers from content and background runtimes.
- Expose helpers through `globalThis.__OVD_HLS_PIPELINE__`.

Public surface:

- `parseHlsPlaylist`
- `selectBestHlsStream`
- `parseHlsEncryption`
- `parseAttributeList`
- `parseHlsIV`
- `decryptHlsSegments`
- `resolveHlsUrl`
- `inferHlsOutputProfile`
- `extFromUrl`
- `ensureExtension`
- `hlsFetch`
- `hlsFetchText(url, headers, options)`
- `hlsFetchBuffer(url, headers, options)`
- `downloadHlsSegments(urls, options)`

Notes:

- `options.credentials` 用于页面上下文请求：content script 中带 Cookie 的跨域请求若被目标站 CORS 拒绝（TypeError），`hlsFetch` 会自动去掉 credentials 重试一次，保证兼容只返回 `Access-Control-Allow-Origin: *` 的 CDN。
- `parseHlsEncryption(m3u8, baseUrl, headers, options)` 会把同样的 options 透传给密钥请求。
- 加密相关错误均为 fail-fast：`parseHlsEncryption` 在密钥获取失败（`HLS_KEY_FETCH_FAILED`）或加密方式非 AES-128/NONE（`HLS_UNSUPPORTED_ENCRYPTION`）时抛错；`decryptHlsSegments` 解密失败抛 `HLS_SEGMENT_DECRYPT_FAILED`，绝不回退使用密文。
- `downloadHlsSegments` 是 background/content 共用的分片下载循环：失败分片按 `HLS_SEGMENT_RETRY_DELAYS` 指数退避重试（最多 3 次），最终失败数超过 `HLS_MAX_FAILED_RATIO`（分片总数 ≤ 10 时零容忍）时抛 `HLS_SEGMENT_DOWNLOAD_FAILED` 中止任务，不产出含空洞的文件；未超阈值时通过 `onProgress(done, total, { failedCount, retriedCount })` 上报失败/重试统计。

### `lib/ovd-logger.js`

Responsibilities:

- Provide a small structured logger for content-side workflows.
- Standardize log prefixes, scoped tags, and `traceId` output.
- Allow debug logs to be gated by runtime preferences.

Public surface:

- `createLogger(scope, baseContext, options)`

### `lib/bilibili-quality-utils.js`

Responsibilities:

- Normalize Bilibili quality labels for popup rendering and logs.
- List unique available DASH video quality options from `data.dash.video`.
- Pick the requested Bilibili video stream and fall back safely when a preferred quality is unavailable.

Public surface:

- `BILIBILI_QUALITY_LABELS`
- `listAvailableBilibiliQualities(dashVideoArray)`
- `pickBilibiliAudioStream(audioStreams)`
- `pickBilibiliVideoStream(videoStreams, targetQualityId)`

### `lib/bilibili-quality-store.js`

Responsibilities:

- Cache Bilibili quality preferences from `chrome.storage.local`.
- Keep popup and content runtimes aligned when the stored default quality changes.
- Expose a tiny preference API mirroring the YouTube mode store pattern.

Public surface:

- `init()`
- `getPreferences()`
- `getCachedPreferences()`
- `updatePreferences(partialPreferences)`

### `lib/ui-dom-utils.js`

Responsibilities:

- Centralize popup DOM visibility helpers.
- Replace repeated inline `display:none` toggles with `hidden`-driven state updates.
- Reuse button/progress/title-edit UI behavior across extension surfaces.
- `setButtonState` 支持含结构化子元素（图标 + 文字 + 菜单）的按钮布局，只更新文字 span 而保留整体 DOM 结构。

Public surface:

- `setHidden(element, hidden)`
- `showTimedMessage(options)`
- `setButtonState(button, state, labels)`
- `updateProgress(options)`
- `updateDownloadItemProgress(options)`
- `startInlineTitleEdit(options)`

### `lib/youtube-download-mode-store.js`

Responsibilities:

- Cache YouTube download preferences from `chrome.storage.local`.
- Keep content and popup runtimes in sync when preferences change.
- Expose debug toggles for verbose YouTube logging.

Public surface:

- `init()`
- `getPreferences()`
- `getCachedPreferences()`
- `getDefaultMode()`
- `getDefaultResolution()`
- `isDebugEnabled(scope)`
- `updatePreferences(partialPreferences)`

### `lib/youtube-stream-utils.js`

Responsibilities:

- Normalize YouTube `combined`, `videoStreams`, and `audioStreams`.
- List available quality options for the popup UI.
- Pick the most appropriate combined/adaptive stream pair for parse downloads.
- Build debug snapshots when stream selection fails.

Public surface:

- `normalizeYouTubeStreams(meta)`
- `listAvailableVideoQualities(meta)`
- `pickCombinedStream(meta, options)`
- `pickAdaptiveVideoStream(meta, options)`
- `pickAdaptiveAudioStream(meta)`
- `buildYouTubeSelectionSnapshot(meta, options)`

### `lib/mpd-parser.js`

Responsibilities:

- Parse DASH MPD manifests into structured representations.
- Select the best video and audio Representation by bandwidth and codec.
- Resolve segment URLs from SegmentTemplate or SegmentList.
- Expose helpers through `globalThis.__OVD_MPD_PARSER__`.

Public surface:

- `parseMpdManifest(xmlText, baseUrl)`
- `selectBestVideoRepresentation(adaptationSet)`
- `selectBestAudioRepresentation(adaptationSet)`
- `resolveSegmentUrl(representation, segmentIndex, baseUrl)`

### `lib/settings-store.js`

Responsibilities:

- Provide a unified settings store backed by `chrome.storage.local`.
- Cache settings in memory for fast reads.
- Keep all runtimes (content, background, popup, options) aligned on the same preferences.
- Expose helpers through `globalThis.__OVD_GENERAL_SETTINGS_STORE__`.

Public surface:

- `init()`
- `getSettings()`
- `getCachedSettings()`
- `updateSettings(partialSettings)`

## Page Context Runtime

### Loader Entry

File: [injected/page-context-script.js](D:/github/OnlineVideoDownload/injected/page-context-script.js)

Responsibilities:

- Guard against double-loading in the page runtime.
- Inject the page-context child scripts in a fixed order because page context cannot use ES modules.
- Boot the page runtime after all child scripts are available.
- Start site-specific page extraction and generic media scans.

### Page Modules

Files:

- [injected/page-core.js](D:/github/OnlineVideoDownload/injected/page-core.js)
- [injected/page-http-utils.js](D:/github/OnlineVideoDownload/injected/page-http-utils.js)
- [injected/page-youtube-parser.js](D:/github/OnlineVideoDownload/injected/page-youtube-parser.js)
- [injected/page-bilibili-parser.js](D:/github/OnlineVideoDownload/injected/page-bilibili-parser.js)
- [injected/page-interceptor.js](D:/github/OnlineVideoDownload/injected/page-interceptor.js)

Responsibilities:

- `page-core`: own page-context constants, `postMessage` bridging, content-to-page message routing, and shared reset hooks.
- `page-http-utils`: own page-side binary fetch helpers, resumable/ranged media fetches, direct-download handling, and YouTube stream chunk transfer.
- `page-youtube-parser`: own YouTube player-response extraction, dedupe state, watch-page validation, and Android fallback logic.
- `page-bilibili-parser`: own Bilibili page metadata extraction and validation across `__INITIAL_STATE__`, `__playinfo__`, and player APIs. Extracts thumbnail from `videoData.pic`, `videoData.cover`, `initialState.pic`, and DOM `<meta>` / `<img>` elements.
- `page-interceptor`: own XHR/fetch interception, `MediaSource` / blob detection, DRM detection, history hooks, and generic audio/video element scans.

Notes:

- Page modules communicate through `window.__OVD_PAGE_*__` namespaces instead of ES module imports.
- `page-context-script.js` remains the only script injected directly by the content runtime after `lib/message-types.js`.

## Content Runtime

### Composition Entry

File: [content/content-main.js](D:/github/OnlineVideoDownload/content/content-main.js)

Responsibilities:

- Guard against double-loading.
- Inject `injected/page-context-script.js`.
- Create shared runtime helpers such as `emitRuntimeMessage`, `postMessageToPage`, and blob download handoff.
- Compose the content-side services and strategies.
- Start the message router.

`content-main.js` should stay a thin assembler. New source behavior should go into dedicated modules, not back into this file.

### Source Registry

File: [content/source-handlers.js](D:/github/OnlineVideoDownload/content/source-handlers.js)

Responsibilities:

- Map a detected video to a `sourceId`.
- Register one or more strategies per source.
- Resolve the active strategy for a given video and execution context.
- Keep generic direct video links and generic audio links on the shared `generic` source path.

Current source IDs:

- `blob`
- `youtube`
- `bilibili`
- `dash`
- `generic`

### Strategies

Files:

- [content/strategies/blob-strategy.js](D:/github/OnlineVideoDownload/content/strategies/blob-strategy.js)
- [content/strategies/youtube-capture-strategy.js](D:/github/OnlineVideoDownload/content/strategies/youtube-capture-strategy.js)
- [content/strategies/youtube-parse-download-strategy.js](D:/github/OnlineVideoDownload/content/strategies/youtube-parse-download-strategy.js)
- [content/strategies/bilibili-strategy.js](D:/github/OnlineVideoDownload/content/strategies/bilibili-strategy.js)
- [content/strategies/generic-strategy.js](D:/github/OnlineVideoDownload/content/strategies/generic-strategy.js)
- [content/strategies/hls-strategy.js](D:/github/OnlineVideoDownload/content/strategies/hls-strategy.js)
- [content/strategies/dash-strategy.js](D:/github/OnlineVideoDownload/content/strategies/dash-strategy.js)

Responsibilities:

- `blob-strategy`: read blob URLs in the page and trigger file downloads.
- `youtube-capture-strategy`: keep the legacy page-recording workflow isolated and stable.
- `youtube-parse-download-strategy`: select YouTube streams by requested mode/resolution and mux adaptive tracks in-page.
- `bilibili-strategy`: call Bilibili APIs, sign WBI requests, fetch available qualities on demand, fetch DASH streams, relay merge progress, mux in-page, and save merged blob via browser download API with in-page blob fallback.
- `generic-strategy`: delegate background-driven downloads.
- `hls-strategy`: handle `HLS_DOWNLOAD_DELEGATE` in content using the shared HLS pipeline; page requests carry site cookies and page origin so CDN bot protection (Cloudflare WAF etc.) does not see an extension-context fetch.
- `dash-strategy`: handle `DASH_DOWNLOAD_DELEGATE` in content; parse MPD manifest, fetch video and audio segments, and merge them using BilibiliMuxer into a single MP4.

Additional content helpers:

- [content/progress-reporter.js](D:/github/OnlineVideoDownload/content/progress-reporter.js)
- [content/youtube-download-options.js](D:/github/OnlineVideoDownload/content/youtube-download-options.js)
- [content/youtube-download-errors.js](D:/github/OnlineVideoDownload/content/youtube-download-errors.js)
- [content/float-button.js](D:/github/OnlineVideoDownload/content/float-button.js)

Responsibilities:

- `progress-reporter`: normalize page-side source progress/status messages and forward them to background for popup display.
- `youtube-download-options`: merge stored preferences with per-request `downloadOptions`.
- `youtube-download-errors`: normalize YouTube error codes across capture and parse strategies.
- `float-button`: render the page-bottom-right floating feedback bar for long tasks (HLS, capture, etc.); `showMessage(text, isError, durationMs)` auto-hides after 4s by default, `showProgress(percent)` shows a progress bar and lingers briefly at 100%, `hide()` dismisses it; only one bar at a time so progress stays visible even after the popup closes.
- `youtube-stream-utils`: list both directly playable qualities and signature-only qualities for diagnostics and popup rendering.
- `youtube-parse-download-strategy`: reject oversized adaptive merge jobs before page-side fetching exhausts browser memory.

### Stream Transfer Manager

File: [content/stream-transfer-manager.js](D:/github/OnlineVideoDownload/content/stream-transfer-manager.js)

Responsibilities:

- Own all Map-based transfer state.
- Receive chunked HLS blob transfers from the service worker.
- Receive chunked media-stream transfers for YouTube and Bilibili.
- Coordinate page-direct download completion promises.
- Normalize binary payloads and download filenames.
- Forward optional `traceId` metadata into page-context YouTube fetch/download requests.

Owned state:

- `hlsBlobTransfers`
- `mediaStreamTransfers`
- `pageDirectDownloadTransfers`

### Download Coordinator

File: [content/download-coordinator.js](D:/github/OnlineVideoDownload/content/download-coordinator.js)

Responsibilities:

- Build source execution context.
- Start source downloads through the source registry.
- Deduplicate active work by `sourceId + strategyId + taskKey`.
- Emit unified lifecycle messages.
- Generate a per-download `traceId` and attach it to source execution context and lifecycle payloads.
- Attach a per-task progress reporter so page-side workflows can update the popup, and surface long-task progress/messages on the page via the float feedback bar (see `content/float-button.js`).

Primary messages emitted:

- `SOURCE_DOWNLOAD_STARTED`
- `SOURCE_DOWNLOAD_PROGRESS`
- `SOURCE_DOWNLOAD_RESULT`
- `SOURCE_DOWNLOAD_STATUS`

Legacy compatibility adapters are still emitted for:

- `YOUTUBE_DOWNLOAD_STARTED`
- `YOUTUBE_DOWNLOAD_RESULT`
- `BILIBILI_DOWNLOAD_STARTED`
- `BILIBILI_DOWNLOAD_RESULT`

### Message Router

File: [content/message-router.js](D:/github/OnlineVideoDownload/content/message-router.js)

Responsibilities:

- Handle postMessage traffic from the injected page script.
- Handle runtime messages from background and popup.
- Answer popup-side `BILIBILI_FETCH_QUALITIES` requests through the Bilibili strategy.
- Forward page-side stream progress into background so popup can show one unified progress surface.
- Route transfer events into the stream transfer manager.
- Route source download requests into the download coordinator.
- Route HLS delegate requests into the HLS delegate handler.

## Popup Runtime

File: [popup/popup.js](D:/github/OnlineVideoDownload/popup/popup.js)

Responsibilities:

- Load persisted YouTube and Bilibili download preferences before rendering the current tab's video list.
- Render source-specific controls per item instead of treating all videos as a generic download row.
- Video items use a card layout with thumbnail images on the left and metadata/controls on the right.
- YouTube download mode (录制/解析) is configured in the settings view; only the resolution selector appears inline for parse mode.
- Lazily request Bilibili quality options from the active tab only when the quality selector is focused or clicked.
- Persist the last selected Bilibili quality so later downloads default to the same preference.
- Reflect background broadcast progress for HLS, YouTube, and Bilibili workflows in a unified popup progress bar.
- Own the visible video list, per-item progress, global progress, and source workflow status messages.
- Support batch download: multi-select checkboxes, select-all toggle, and concurrent download dispatch.
- Provide in-popup settings and download history views.
- Map error codes to friendly Chinese text via `popup-error-messages.js` (`buildFriendlyErrorMessage`): 15 error-code mappings plus keyword-based fallbacks (e.g. Bilibili login hints), so raw `err.message` never reaches the user.
- Settings view: read and write extension preferences through `lib/settings-store.js`.
- History view: load download history with `GET_DOWNLOAD_HISTORY`, open folders with `OPEN_DOWNLOAD_FOLDER`, and delete individual records with `DELETE_DOWNLOAD_HISTORY_RECORD`.
- The standalone `options_ui` page has been removed; popup is the only user-facing settings/history surface.
- Popup dimensions: 560×460px, light theme (`#f4f4f5` background), card-based video items with rounded corners.

## Background Runtime

### Downloader

File: [background/downloader.js](D:/github/OnlineVideoDownload/background/downloader.js)

Responsibilities:

- Build a stable filename base, optionally prefixed with `downloadSubdir` from settings.
- `lib/download-path.js` `composeFilenameBase` honors the `filenameFormat` setting (`title` / `title-quality` / `title-date`) so the configured naming rule actually applies.
- Look up the matching background strategy.
- Pass shared execution context such as `filenameBase`, `tabId`, and `hlsFetcher`.

`Downloader` intentionally no longer owns the concrete direct/HLS/DASH/YouTube download implementations.

### Background Strategy Registry

Files:

- [background/download-strategy-registry.js](D:/github/OnlineVideoDownload/background/download-strategy-registry.js)
- [background/download-strategies/direct-download-strategy.js](D:/github/OnlineVideoDownload/background/download-strategies/direct-download-strategy.js)
- [background/download-strategies/hls-download-strategy.js](D:/github/OnlineVideoDownload/background/download-strategies/hls-download-strategy.js)
- [background/download-strategies/dash-download-strategy.js](D:/github/OnlineVideoDownload/background/download-strategies/dash-download-strategy.js)
- [background/download-strategies/youtube-adaptive-download-strategy.js](D:/github/OnlineVideoDownload/background/download-strategies/youtube-adaptive-download-strategy.js)
- [background/download-strategies/blob-download-strategy.js](D:/github/OnlineVideoDownload/background/download-strategies/blob-download-strategy.js)
- [background/download-strategies/unsupported-download-strategy.js](D:/github/OnlineVideoDownload/background/download-strategies/unsupported-download-strategy.js)

Responsibilities:

- Match `videoInfo` to the correct background execution path.
- Keep each download implementation local to the strategy that owns it.
- Reuse `submitDirectDownload()` for direct video, audio files, DASH fallback, and YouTube adaptive downloads where possible.
- `hls-download-strategy` 先尝试把 HLS 下载委托给 content（页面上下文），委托失败或无 tab 上下文时再调用 `HlsFetcher`；委托期间通过 `injectHeaders` 注册 DNR 规则，并把 CORS 响应头回显为页面来源（`access-control-allow-credentials: true`），使带 Cookie 的跨域响应能被浏览器接受。

### HLS Fetcher

File: [background/hls-fetcher.js](D:/github/OnlineVideoDownload/background/hls-fetcher.js)

Responsibilities:

- Act as the fallback path: fetch HLS playlists and segments in the service worker.
- Used when page-context delegation is unavailable (no tab/content script), fails, or the source has no tab context.
- Reuse `lib/hls-pipeline.js` for parsing and decryption logic.
- Inject temporary `Referer` / `Origin` request headers plus permissive CORS response headers via `injectHeaders` before fetching.

### Download History Store

File: [background/download-history-store.js](D:/github/OnlineVideoDownload/background/download-history-store.js)

Responsibilities:

- Persist download history records to `chrome.storage.local`.
- Maintain a maximum of 100 records, pruning oldest entries when the cap is exceeded.
- Auto-prune records older than the configured retention days.
- Provide clear-all functionality.
- Deduplicate incoming records: when a new record matches an existing one (by `downloadId`, filename, URL within a 2-minute window, or similar CJK title), the existing record is merged and replaced instead of creating a duplicate entry.
- ES module consumed by the service worker.

Record fields:

- `id` — unique record identifier
- `downloadId` — browser download ID (from `chrome.downloads`), used for deduplication and folder opening
- `url` — original video URL
- `title` — display title
- `type` — download type (e.g. `direct`, `bilibili`, `youtube-adaptive`)
- `filename` — saved file path
- `size` — file size in bytes
- `timestamp` — download completion time
- `tabUrl` — source page URL
- `status` — download status (e.g. `complete`)

Deduplication strategy (in `addRecord`, checked in order):

1. Exact `downloadId` match
2. Exact normalized filename match
3. Same URL within a 2-minute window (`DUPLICATE_WINDOW_MS`)
4. Similar CJK title within a 2-minute window (substring match, minimum 4 characters)

When a duplicate is found, the new record's fields are merged into the existing record, preferring the new values while keeping fallback values from the existing record.

Public surface:

- `init()`
- `addRecord(record)`
- `getAll()`
- `deleteRecord(id)`
- `clear()`
- `prune()`

### Download Notification

File: [background/download-notification.js](D:/github/OnlineVideoDownload/background/download-notification.js)

Responsibilities:

- Show system notifications on download completion/failure, gated by the `downloadNotification` setting.
- Build notification id/title/message in pure functions (filename + size for completion, filename + reason for failure) so they are unit-testable separately from `chrome` calls.
- Handle notification clicks: `onClicked` resolves the download id from the notification id and calls `chrome.downloads.show` to open the download folder.

Public surface:

- `DownloadNotificationManager`
- `buildNotificationId(downloadId)`
- `parseNotificationDownloadId(notificationId)`
- `buildCompletionNotification({ filename, sizeBytes })`
- `buildFailureNotification({ filename, reason })`

### Tab Action Badge

File: [background/action-badge.js](D:/github/OnlineVideoDownload/background/action-badge.js)

Responsibilities:

- Drive the toolbar icon badge as a per-tab count of detected videos (replacing the old running-task-count badge).
- Format the badge text: `formatBadgeCount(count)` renders the count, collapses anything above 99 to `99+`, and renders an empty string when nothing is detected.
- Refresh the badge when a tab's registry entries change and clear it when the tab closes or its registry is cleared.

Public surface:

- `createTabBadgeManager({ action })` → `{ refresh(tabId, count), clear(tabId) }`
- `formatBadgeCount(count)`
- `BADGE_MAX_COUNT` (99), `BADGE_BACKGROUND_COLOR`

Note: running-task count is no longer shown on the icon; it appears on the popup's 任务 (tasks) button badge instead.

### Clear Video Scope

File: [background/clear-video-scope.js](D:/github/OnlineVideoDownload/background/clear-video-scope.js)

Responsibilities:

- Resolve the cleanup scope of `CLEAR_TAB_VIDEOS` as a pure function.
- Messages from content scripts carry `sender.tab`/`sender.frameId`; messages from the popup have no `sender.tab` and rely on `msg.tabId`.
- A `frameId` of null/0 (main frame) triggers a tab-level clear; only a subframe (`frameId > 0`) clears that frame's entries.

Public surface:

- `resolveClearVideoScope({ sender, msg })` → `{ tabId, frameId }`

## Message Model

### Page Context -> Content

Examples:

- `page-changed`
- `YOUTUBE_DIRECT_DOWNLOAD_RESULT`
- `YOUTUBE_MEDIA_STREAM_START`
- `YOUTUBE_MEDIA_STREAM_PROGRESS`
- `YOUTUBE_MEDIA_STREAM_CHUNK`
- `YOUTUBE_MEDIA_STREAM_FINISH`
- `YOUTUBE_MEDIA_STREAM_ERROR`

Notes:

- `lib/message-types.js` now centralizes shared message names and page-context source identifiers across background, content, popup, and injected page runtime.
- `YOUTUBE_DIRECT_DOWNLOAD` and `YOUTUBE_MEDIA_STREAMS_REQUEST` from content to page now include optional `traceId`.
- YouTube stream payloads now include `itag` for combined/video/audio candidates.
- The injected page runtime may issue an additional Android-style YouTube player request when adaptive video/audio entries exist but usable direct URLs are missing, or when the initial payload only exposes low-quality direct URLs while higher qualities remain inaccessible.
- The page-context YouTube parser suppresses repeated identical source-hit/debug summaries and records explicit fallback trigger / response / no-improvement logs once per video.
- The YouTube parse strategy uses stream `contentLength` when available to estimate adaptive fetch size and fail fast on oversized in-browser merge jobs.
- The injected page runtime now reads YouTube adaptive media streams incrementally, emits `YOUTUBE_MEDIA_STREAM_PROGRESS` checkpoints, and suppresses noisy per-chunk relay logs.

### Content -> Background

Examples:

- `VIDEO_DETECTED`
- `DOWNLOAD_VIDEO`
- `BILIBILI_STREAM_PROGRESS`
- `DOWNLOAD_BLOB_DATA`
- `FETCH_MEDIA_STREAMS`
- `SET_TAB_MUTED`
- `CLEAR_TAB_VIDEOS`
- `HLS_PROGRESS_UPDATE`
- `GET_DOWNLOAD_HISTORY`
- `CLEAR_DOWNLOAD_HISTORY`
- `OPEN_DOWNLOAD_FOLDER`
- `DELETE_DOWNLOAD_HISTORY_RECORD`

Notes:

- Source-download lifecycle payloads now include both `traceId` and `taskKey` so popup UI can keep the correct item in a pending/completed state across async content-side workflows.
- Bilibili in-page muxing now forwards `BILIBILI_STREAM_PROGRESS` through background so the popup can show the fetching/merging percentage.
- Download completion now passes `downloadId` (browser download ID) through the history record so the store can deduplicate entries and the options page can open the download folder.

### Background -> Content / Popup

Examples:

- `UPDATE_BUTTON`
- `DOWNLOAD_PROGRESS`
- `HLS_PROGRESS`
- `FETCH_BLOB`
- `HLS_DOWNLOAD_BLOB_START`
- `HLS_DOWNLOAD_BLOB_CHUNK`
- `HLS_DOWNLOAD_BLOB_FINISH`
- `HLS_DOWNLOAD_DELEGATE`
- `DASH_DOWNLOAD_DELEGATE`
- `BILIBILI_STREAM_PROGRESS`
- `SOURCE_DOWNLOAD_STARTED`
- `SOURCE_DOWNLOAD_RESULT`

Notes:

- `HLS_DOWNLOAD_DELEGATE` 由 background 的 `hls-download-strategy` 发往 content，字段为 `m3u8Url` / `filename` / `headers`（捕获到的 `Referer` / `Origin` / `Cookie`）/ `options.fetchOptions`（默认 `{ credentials: 'include' }`）/ `taskMeta`；content 返回 `{ downloadId, filename, failedCount, segmentCount }`，任务据此写入真实 `downloadId`。
- 委托下载期间 background 通过 `injectHeaders(url, headers, { corsOrigin })` 注册临时 DNR 规则，让页面上下文的带 Cookie 请求能通过 CDN 的 CORS 校验；content 无响应或返回失败时，同一任务自动回退到 `HlsFetcher`。

### Popup -> Content

Examples:

- `BILIBILI_FETCH_QUALITIES`

Notes:

- The popup requests Bilibili quality options lazily from the content runtime using the current video's `bvid` and `cid`.
- The content router delegates that request to `bilibili-strategy.fetchQualities()` so popup UI does not need to duplicate Bilibili API logic.

## Content Script Load Order

Manifest content-script order is now:

1. `lib/browser-compat.js`
2. `lib/byte-utils.js`
3. `lib/http-utils.js`
4. `lib/constants.js`
5. `lib/message-types.js`
6. `lib/video-utils.js`
7. `lib/ui-dom-utils.js`
8. `lib/video-source-utils.js`
9. `lib/mp4-muxer.js`
10. `lib/bilibili-muxer.js`
11. `lib/wbi-signer.js`
12. `lib/bilibili-quality-utils.js`
13. `lib/bilibili-quality-store.js`
14. `lib/settings-store.js`
15. `lib/hls-pipeline.js`
16. `lib/mpd-parser.js`
17. `lib/ovd-logger.js`
18. `lib/youtube-download-mode-store.js`
19. `lib/youtube-stream-utils.js`
20. `content/source-handlers.js`
21. `content/progress-reporter.js`
22. `content/youtube-download-options.js`
23. `content/youtube-download-errors.js`
24. `content/strategies/*` (includes `dash-strategy.js`)
25. `content/stream-transfer-manager.js`
26. `content/download-coordinator.js`
27. `content/float-button.js`
28. `content/message-router.js`
29. `content/content-main.js`

This order is required because content modules communicate through `globalThis` factories.

## Frame Scope (iframe 嵌入检测)

Content scripts 以 `all_frames: true` 注入所有子框架，用于检测第三方页面嵌入的 YouTube embed / Vimeo 等播放器。约定：

- `chrome.tabs.sendMessage` 默认广播到 tab 内所有 frame；委托类消息（`FETCH_BLOB`、`HLS_DOWNLOAD_DELEGATE`、`SOURCE_DOWNLOAD`、`MEDIA_STREAM_*`、`REVOKE_OBJECT_URL`）必须按 `frameId` 定向，由 `lib/browser-compat.js` 的 `safeTabMessage`/`sendTabMessageAsync` 自动从 `message.frameId` / `meta.frameId` / `taskMeta(.videoInfo).frameId` 提取，或通过显式 options 传入。
- 注册表条目记录 `frameId`（`VIDEO_DETECTED` 来自 `sender.frameId`，webRequest 来自 `details.frameId`）；同 tab 多 frame 上报按 URL 去重合并为单条。
- 子框架导航触发的 `CLEAR_TAB_VIDEOS` 只清理该 frame 的条目（`VideoRegistry.clearFrame`）；主框架导航仍为 tab 级清理。

## Page Script Injection Order

The page-context loader injects child scripts in this order:

1. `injected/page-core.js`
2. `injected/page-http-utils.js`
3. `injected/page-youtube-parser.js`
4. `injected/page-bilibili-parser.js`
5. `injected/page-interceptor.js`
6. Boot page-context runtime from `injected/page-context-script.js`

This order is required because the page runtime uses `window.__OVD_PAGE_*__` namespaces for dependency wiring.

## Extension Rules

When adding a new source:

1. Add or update source identification in [lib/video-source-utils.js](D:/github/OnlineVideoDownload/lib/video-source-utils.js).
2. Register the source in [content/source-handlers.js](D:/github/OnlineVideoDownload/content/source-handlers.js) when the source is content-owned.
3. Add a dedicated source strategy under [content/strategies](D:/github/OnlineVideoDownload/content/strategies).
4. If the source is background-owned, register a background strategy instead.
5. Keep `content/content-main.js` limited to wiring.

When adding shared low-level helpers:

- Put cross-runtime logic in `lib/`.
- Prefer one implementation consumed by both content and background.
- Avoid copying parsing/decryption/signing logic into multiple files.

## Version History

| Version | Date | Changes |
| --- | --- | --- |
| 1.16.0 | 2026-09-25 | Content scripts now inject into all frames (`all_frames: true`) to detect iframe-embedded videos (YouTube embed, etc.). Registry entries record `frameId` (from `sender.frameId`/`details.frameId`); delegation messages (`FETCH_BLOB`, `HLS_DOWNLOAD_DELEGATE`, `SOURCE_DOWNLOAD`, `MEDIA_STREAM_*`, `REVOKE_OBJECT_URL`) are routed to the detecting frame via `chrome.tabs.sendMessage` options, with `browser-compat` auto-extracting `frameId` from message meta. Subframe navigations clear only that frame's entries via `VideoRegistry.clearFrame`. Second-wave UX pass: download completion/failure system notifications gated by `downloadNotification` (click opens the download folder via `download-notification.js`); `filenameFormat` naming rule enforced in `lib/download-path.js` (`title` / `title-quality` / `title-date`); batch download UI restored (visible per-item checkboxes, header select-all with indeterminate state, 「下载所选 (N)」 button, concurrency from `concurrentDownloadLimit`, DRM items not selectable); toolbar badge now shows the per-tab detected-video count (>99 → `99+`) via `action-badge.js` while running-task count moves to the popup tasks-button badge; downloading items show 「下载中 N%」; in-page floating feedback bar restored (`content/float-button.js`) for long tasks; errors render as friendly Chinese text via `popup-error-messages.js` (15 error-code mappings + keyword fallbacks); 「清列表」 also clears the background `VideoRegistry` via `CLEAR_TAB_VIDEOS` with popup/main-frame/subframe scope resolved by `clear-video-scope.js`. |
| 1.15.0 | 2026-09-24 | HLS downloads now run in the page context first: `hls-download-strategy` delegates to `HLS_DOWNLOAD_DELEGATE` so requests carry page cookies/origin/`Sec-Fetch` (fixes CDN WAF 403s seen from service-worker fetches), echoes the tab origin in CORS response headers via `injectHeaders(url, headers, { corsOrigin })`, adds optional `credentials` support to `hlsFetch`/`hlsFetchText`/`hlsFetchBuffer`/`parseHlsEncryption`, returns the real `downloadId` from the delegated blob download, and falls back to `HlsFetcher` when the content script is unavailable or fails. |
| 1.14.1 | 2026-06-12 | Fixed subdirectory setting not working for content-script blob downloads (HLS, blob, DASH). `triggerBlobDownload` now delegates to service worker via `DOWNLOAD_BLOB_DATA` message so `chrome.downloads.download` handles the subdirectory path correctly; falls back to `<a download>` only when the service worker is unavailable. |
| 1.14.0 | 2026-06-12 | Added `downloadSubdir` setting (default `OnlineVideoDownload`) to save downloads into a subdirectory under Chrome's default download folder. `Downloader._buildFilenameBase` and `downloadBlobData` now prepend the configured subdirectory. |
| 1.13.0 | 2026-06-12 | Removed the standalone Options page and `options_ui`; settings and history are now managed only inside the popup. |
| 1.12.0 | 2026-06-12 | Added single-record deletion for download history (`deleteRecord`, `DELETE_DOWNLOAD_HISTORY_RECORD` message type, per-row delete button in popup history). |
| 1.10.0 | 2026-05-30 | Popup UI redesign: light theme, 560×460px card layout with video thumbnails. Added download history deduplication in `DownloadHistoryStore` (by `downloadId`, filename, URL+time window, CJK similar title). Added `OPEN_DOWNLOAD_FOLDER` message type and `openDownloadFolder()` in service worker. Bilibili DASH merge now saves via browser download API (`saveBlobViaBrowserDownload`) with in-page blob fallback. Added `thumbnail` field extraction in YouTube and Bilibili page parsers. Refactored `setButtonState` in `ui-dom-utils.js` to support structured button children. Popup history rows are now clickable to open download folder. |
| 1.9.0 | 2026-05-29 | Added DASH MPD parser (`lib/mpd-parser.js`), general settings store (`lib/settings-store.js`), DASH content strategy (`content/strategies/dash-strategy.js`), and download history store (`background/download-history-store.js`). Integrated batch download in popup, history persistence on download completion, and new message types (`DASH_DOWNLOAD_DELEGATE`, `GET_DOWNLOAD_HISTORY`, `CLEAR_DOWNLOAD_HISTORY`). |
| 1.7.9 | 2026-04-06 | Added shared Bilibili quality utilities/storage, popup-side Bilibili quality selection with persisted preference, and unified Bilibili fetch/merge progress broadcasting. |
| 1.8.0 | 2026-05-28 | Removed visible page floating UI, added content progress reporter messages, and consolidated detected-video and download-progress display into the extension popup. |
| 1.7.8 | 2026-04-06 | Split the injected page runtime into `page-core`, `page-http-utils`, `page-youtube-parser`, `page-bilibili-parser`, and `page-interceptor`, and turned `page-context-script.js` into a thin in-page loader. |
| 1.7.7 | 2026-04-06 | Added shared `lib/ui-dom-utils.js`, moved popup visibility handling to `hidden`, and centralized repeated button/progress/title-edit UI state logic. |
| 1.7.6 | 2026-04-06 | Centralized shared message names into `lib/message-types.js`, added `taskKey` to source-download lifecycle payloads, and fixed popup item state so content-side downloads stay pending until completion or failure. |
| 1.7.5 | 2026-04-06 | Fixed YouTube audio streams being detected as separate phantom entries by filtering googlevideo.com URLs from generic fetch/XHR/webRequest hooks. |
| 1.7.3 | 2026-04-04 | Added YouTube parse-mode page-side stream progress reporting so adaptive fetches show visible progress and clearer diagnostics before merge completes or fails. |
| 1.7.2 | 2026-04-04 | Added YouTube parse-mode adaptive size estimation and an oversized in-browser merge guard so extremely large jobs fail fast with a clear recommendation instead of appearing stuck. |
| 1.7.1 | 2026-04-04 | Broadened YouTube Android fallback triggering for adaptive streams without direct URLs, added explicit fallback result logging, and reduced repeated identical page-context debug summaries. |
| 1.7.0 | 2026-04-04 | Added YouTube mode preferences, stream-selection helpers, structured logging, split YouTube content flow into capture/parse strategies, and added popup mode/resolution selection with trace-aware lifecycle metadata. |
| 1.6.0 | 2026-04-04 | Split content runtime into strategies, transfer manager, coordinator, and message router; added shared WBI signer and HLS pipeline; simplified background downloader and made HLS fetcher reuse shared helpers. |
| 1.5.0 | 2026-04-03 | Introduced source handlers, unified source lifecycle messages, and background download strategy registry. |
