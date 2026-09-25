# Online Video Downloader Architecture

> Version: 1.17.18
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
  lib/progress-scale.js
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
- `parseHlsMasterPlaylist(m3u8, baseUrl)`
- `selectHlsVariant(variantsOrMaster, baseUrl, { quality })`
- `findMatchingAudioRendition(master, variant)`
- `resolveHlsKeys(keyEntries, headers, options)`
- `parseHlsKeyEntries(m3u8, baseUrl)`
- `parseByteRange(value)` / `toRangeHeader(byteRange)`
- `ivFromSequence(sequence)`
- `createAbortError(message)`
- `createInMemorySink()` / `createSegmentDecryptor(keyInfo)`
- `estimateHlsBytes(playlist, bandwidth, { bandwidthFactor })`
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

- `parseHlsMasterPlaylist` 列出 Master Playlist 的全部码率变体（`{ url, label, detail, bandwidth, width, height, codecs, audioGroupId }`）与 `EXT-X-MEDIA` 独立音轨；`selectHlsVariant(variants, baseUrl, { quality })` 接受变体 URL、`720p` 这类标签、高度数字或 `auto`/`best`，找不到时回退到最高码率。
- `parseHlsPlaylist` 返回富分片对象：`{ url, seq, duration, byteRange, keyIndex, discontinuity }`，并附带 `keys`（`EXT-X-KEY` 轮换列表）、`initSegmentByteRange`、`mediaSequence`、`discontinuityCount`、`hasEndList`、`isLive`、`playlistType`、`totalDuration`。`segments` 已由字符串数组变为对象数组，`downloadHlsSegments`/`inferHlsOutputProfile`/`extFromUrl` 同时兼容两种形式。
- 分片下载支持 `EXT-X-BYTERANGE`（含省略偏移的隐式续接）与 `Range` 头：`downloadHlsSegments` 以 `fetchBuffer(url, byteRange)` 调用取数函数，`hlsFetchBuffer(url, headers, { range })` 会追加 `Range: bytes=start-` 形式的请求头，并接受 `206 Partial Content` 响应。
- 加密支持密钥轮换与 IV 正确派生：`resolveHlsKeys` 逐个抓取并导入 `EXT-X-KEY` 密钥（非 AES-128 抛 `HLS_UNSUPPORTED_ENCRYPTION`，抓取失败抛 `HLS_KEY_FETCH_FAILED`）；`decryptHlsSegments(buffers, { keys, segments })` 按 `segment.keyIndex` 取密钥，无显式 IV 时用 `ivFromSequence(segment.seq)`（`EXT-X-MEDIA-SEQUENCE` + 下标）派生，`METHOD=NONE` 的分片原样保留。
- `options.credentials` 用于页面上下文请求：content script 中带 Cookie 的跨域请求若被目标站 CORS 拒绝（TypeError），`hlsFetch` 会自动去掉 credentials 重试一次，保证兼容只返回 `Access-Control-Allow-Origin: *` 的 CDN。
- `parseHlsEncryption(m3u8, baseUrl, headers, options)` 会把同样的 options 透传给密钥请求。
- 加密相关错误均为 fail-fast：`parseHlsEncryption` 在密钥获取失败（`HLS_KEY_FETCH_FAILED`）或加密方式非 AES-128/NONE（`HLS_UNSUPPORTED_ENCRYPTION`）时抛错；`decryptHlsSegments` 解密失败抛 `HLS_SEGMENT_DECRYPT_FAILED`，绝不回退使用密文。
- `downloadHlsSegments` 是 background/content 共用的分片下载循环：失败分片按 `HLS_SEGMENT_RETRY_DELAYS` 指数退避重试（最多 3 次），最终失败数超过 `HLS_MAX_FAILED_RATIO`（分片总数 ≤ 10 时零容忍）时抛 `HLS_SEGMENT_DOWNLOAD_FAILED` 中止任务，不产出含空洞的文件；未超阈值时通过 `onProgress(done, total, { failedCount, retriedCount })` 上报失败/重试统计。
- 体积守卫：累计下载字节超过 `options.maxTotalBytes`（默认 `constants.MAX_IN_PAGE_MERGE_BYTES`，2 GB）时抛 `HLS_OUTPUT_TOO_LARGE`，避免浏览器内合并 OOM。
- 内容侧体积预估：`estimateHlsBytes` 用 `sum(EXTINF) × 有效带宽 / 8` 估算输出体积（无 `AVERAGE-BANDWIDTH` 时对峰值 `BANDWIDTH` 乘 0.8；缺时长/带宽返回 0 即不拦截）。`content/strategies/hls-strategy.js` 在开始下载前用它判断，超过 `MAX_IN_PAGE_MERGE_BYTES` 直接抛 `HLS_CONTENT_SIZE_SKIP`，由 `hls-download-strategy` 视为委托失败并回退后台 OPFS 路径——避免"先下满 2 GB 再中止重下"。
- 取消：`options.signal` 为 `AbortSignal`，任一批次开始前检测到 `aborted` 即抛 `DOWNLOAD_ABORTED`（`createAbortError()`）。
- **顺序写入 sink（内存治理）**：`options.sink` 为 `{ write(chunk, { index, segment }) }` 时，`downloadHlsSegments` 不再返回整份 `buffers` 数组，而是只保留"已下载但还不能按序落盘"的重排窗口（≤ `concurrency` 个分片）。`options.transform(chunk, index, segment)` 在写入前逐分片执行（解密等），因此不需要再额外持有一份解密后的全量数组。返回 `{ buffers: null, writtenBytes, totalBytes, sink }`。
  - 内存对比：旧路径峰值 ≈ buffers(N) + merged(N) + Blob(N) ≈ 3N；sink 路径 ≈ 分片引用(N) + 窗口(≤并发数)，且 `toBlob()` 后引用立即释放。
  - `createInMemorySink()` 提供 `write` / `toArrayBuffer()` / `toBlob(mimeType)` / `byteLength` / `chunkCount`；`toBlob` 是消费型出口（交给 Blob 后清空引用）。
  - `createSegmentDecryptor(keyInfo)` 把密钥轮换 / 媒体序号派生 IV 封装成 `(buffer, index) => Promise<buffer>`，`decryptHlsSegments` 与 `transform` 共用同一实现，避免两条解密路径漂移。
  - 调用方策略：`content/strategies/hls-strategy.js`、`background/hls-fetcher.js` 在"不需要 fMP4 合并"时使用 sink（需要音轨合并时仍需整体持有视频数据，属 muxer 接口限制）；`content/strategies/dash-strategy.js` 视频/音频各用一个 sink，再用 `toArrayBuffer()` 交给 muxer（少一次全量拼接拷贝）。
  - 该接口即后续 OPFS / 文件落盘 sink 的挂载点：只需实现 `write` 的落盘版本，下载循环与策略无需改动。

### `lib/progress-scale.js`

Responsibilities:

- Provide one unified 0..100 progress coordinate for a download task across all UI surfaces.
- Map per-phase raw percentages (each phase reports its own 0..100) onto that coordinate.
- Expose helpers through `globalThis.__OVD_PROGRESS_SCALE__`.

Public surface:

- `PHASE_RANGES`
- `mapPhasePercent(phase, percent)`
- `normalizePercent(percent)`

Notes:

- 背景：Bilibili 与 YouTube 解析下载分「视音频流抓取 → 浏览器内合并」两个阶段，两阶段的回调都是 0..100；直接上报会让同一任务的进度先涨到 100% 再跌回 0%，而 Popup 条目、Popup 任务列表、页面右下角浮条（`content/float-button.js`）各自由不同消息驱动，于是同一时刻显示三个不同的数字。
- 阶段权重：`fetching` → 0..90、`merging` → 90..99；合并完成后再由 `phase: 'complete'` 补到 100%。未登记的阶段（`recording`、`fetching-video` 等单阶段策略）原样返回，既有策略行为不变。
- 抓取阶段的百分比由 background 计算并映射（`background/service-worker.js#fetchMediaStreams` 的 `onStreamProgress`），随后一次性写进任务表（`DownloadStateStore`）并广播给发起该任务的 frame 与 Popup；合并阶段由内容侧策略用同一函数映射后上报 `SOURCE_DOWNLOAD_PROGRESS`。两侧共用本模块，保证同一时刻三处读到同一个数字。
- 抓取阶段的广播不再只发给 Popup：`BILIBILI_STREAM_PROGRESS` 消息携带 `frameId`，`safeTabMessage` 据此只发往发起下载的 frame（页面上其它 iframe 不会各自弹出浮条），`safeRuntimeMessage` 同时送达 Popup。

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
- Resolve `$Number%05d$` / `$Time%08d$` 宽度格式符与 `$$` 转义。
- Group adaptations by Period and expose per-representation byte ranges.
- Expose helpers through `globalThis.__OVD_MPD_PARSER__`.

Public surface:

- `parseMpdManifest(xmlText, baseUrl)`
- `selectBestVideoRepresentation(adaptationSet)`
- `selectBestAudioRepresentation(adaptationSet)`
- `collectRepresentationsAcrossPeriods(manifest, contentType)`
- `formatSegmentTemplate(template, variables)` / `formatTemplateNumber(value, widthSpec)`
- `parseSegmentTimeline(timelineEl, { periodDuration, timescale })`
- `parseByteRange(value)` / `toRangeHeader(byteRange)`
- `resolveSegmentUrl(representation, segmentIndex, baseUrl)`

Notes:

- 无 `DOMParser` 的环境（Node 单元测试）自动退回内置最小 XML 解析器，因此 `test/mpd-parser.test.js` 在 Node 下真实执行而非 skip。
- 返回结构新增 `periods: [{ id, index, start, duration, adaptations }]` 与 `isMultiPeriod`；`adaptations` 仍为扁平列表，且每项附带 `periodIndex` / `periodId` / `start`。
- `SegmentTimeline` 支持 `r="-1"`（重复到 Period 结束，依赖 `Period@duration`）；`SegmentURL@mediaRange`/`indexRange`、`Initialization@range`、`SegmentBase@indexRange` 解析为 `{ start, end, length }`，开放区间生成 `bytes=start-`。
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

Defaults now include `domainBlacklist`（域名黑名单，逗号/换行分隔）、`minVideoDurationSec`、`minVideoSizeMb`（0 = 不限）与 `askSaveLocation`（每次询问保存位置）。

### `lib/video-filter.js`

Responsibilities:

- 按用户设置过滤检测结果，压掉广告片段、音效等噪声条目。
- 域名黑名单（子域名匹配，blob 条目回退到所属页面域名）、最小时长、最小体积。
- 阈值过滤只作用于通用嗅探条目，结构化来源（YouTube/Bilibili）永远显示。
- Expose helpers through `globalThis.__OVD_VIDEO_FILTER__`.

Public surface:

- `shouldFilterVideo(video, settings, context) -> { filtered, reason }`
- `filterVideos(videos, settings, context)`
- `parseDomainList(value)` / `normalizeDomain(input)` / `isBlacklistedHost(host, domains)` / `hostOf(url)`

Notes:

- 过滤在 `background/service-worker.js#getVisibleVideosForTab` 读取时应用，因此改设置后无需重新检测即可生效，徽章计数与 popup 列表始终一致。
- 时长/体积未知（0 或缺失）时不过滤，避免误杀。

### `lib/opfs-sink.js`

Responsibilities:

- 把分片顺序写进扩展自身 origin 的 OPFS，避免 GB 级文件常驻内存；接口与 `createInMemorySink` 一致（`write` / `byteLength` / `mode`）。
- 提供自适应 sink：小文件全程内存，累计超过 `OPFS_SPILL_THRESHOLD_BYTES`（默认 128 MB）后把已缓冲内容一次性溢出到 OPFS 并继续落盘；不支持 OPFS 或溢出失败时退回纯内存，由调用方的体积守卫兜底。
- `cleanupStale()` 清理异常退出遗留的临时文件（按 `lastModified` 与 `OPFS_STALE_MS` 判断，避免误删在跑的任务）。
- Expose helpers through `globalThis.__OVD_OPFS_SINK__`.

Public surface:

- `isSupported()`
- `createFileName(prefix)`
- `createOpfsSink({ name })` → `{ mode:'opfs', name, byteLength, chunkCount, write, finalize, remove }`
- `createSpillSink({ name, thresholdBytes })` → 追加 `spill()` / `toBlob(mime)` / `supportsSpill` / `spillFailed`
- `readFile(name)` / `removeFile(name)` / `listNames()`
- `cleanupStale({ prefix, maxAgeMs, now })`

Notes:

- 写入失败（例如配额不足）抛 `OPFS_WRITE_FAILED`，调用方据此中止任务，不产出损坏文件。
- manifest 已声明 `unlimitedStorage`，否则 GB 级写入会先撞到存储配额。
- 这就是 `downloadHlsSegments({ sink })` 的挂载点：策略层只看到 `mode`/`name`，不感知存储介质。

### `background/opfs-temp-registry.js`

Responsibilities:

- 登记 `downloadId → OPFS 文件名`，供 service worker 在下载完成/失败/中断后释放对象 URL 并删除临时文件。
- 不持久化：SW 重启前遗留的文件由 `lib/opfs-sink.js#cleanupStale` 兜底。

Public surface:

- `registerOpfsTempFile(downloadId, name)`
- `takeOpfsTempFile(downloadId)`（取出即移除）
- `listOpfsTempFiles()` / `clearOpfsTempFiles()`

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
- `fetchMediaStreamsAndWait(videoUrls, audioUrls, headers, transferPrefix, timeoutMessage, taskMeta)` 的第 6 个参数为任务身份（`sourceId`/`strategyId`/`taskKey`/`title`/`traceId`/`videoUrl`，经 `normalizeTaskMeta` 过滤，不含 `videoInfo`），随 `FETCH_MEDIA_STREAMS` 交给 background，使抓取阶段进度能落到同一任务上。
- 媒体流分片按 `seq` 落位而非 `push`：后台回传已改为**有界流水线**（`MEDIA_STREAM_PIPELINE_DEPTH`），到达顺序不再保证。
- `finishMediaStreamTransfer` 会校验分片连续性（`compactOrderedChunks`），出现空洞抛 `MEDIA_STREAM_CHUNK_MISSING`，绝不产出缺片/错序文件。

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
- 页面侧抓流进度与 background 的抓取阶段广播都按 `lib/progress-scale.js` 映射到统一进度，并同步刷新页面浮条，因此浮条、Popup 条目与任务列表三处显示同一个百分比。
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
- Master Playlist 画质选择（`options.quality`）、`EXT-X-BYTERANGE`/`Range`、密钥轮换、直播（无 `ENDLIST`）显式提示，以及独立音轨（`EXT-X-MEDIA`）通过 `lib/bilibili-muxer.js` 合并进视频。
- 大文件流式落盘：使用 `lib/opfs-sink.js` 的自适应 sink，超过阈值（默认 128 MB）自动切到 OPFS，输出上限随之变为 `OPFS_MAX_OUTPUT_BYTES`（默认 8 GB）而不是内存 2 GB；下载完成后经 offscreen 文档按文件名换取对象 URL 交给 `chrome.downloads`，并在下载结束/中断时删除临时文件。
- 体积超过 `MAX_IN_PAGE_MERGE_BYTES` 时抛 `HLS_OUTPUT_TOO_LARGE`，不进入合并。

### Download Queue

File: [background/download-queue.js](D:/github/OnlineVideoDownload/background/download-queue.js)

Responsibilities:

- 为所有后台下载入口（直链/HLS/DASH/YouTube parse）提供统一并发上限，来源为 `concurrentDownloadLimit` 设置。
- `handleMessage` 的 `DOWNLOAD_VIDEO` 分支先 `setLimit(settings.concurrentDownloadLimit)` 再 `run()`，超出上限的任务排队等待，长任务持续占用槽位。
- `acquire()`/`release()` 支持限额调高后立即唤醒等待者；`run(task, { signal })` 对已取消任务抛 `DOWNLOAD_ABORTED`。

### Save Location

File: [background/save-location.js](D:/github/OnlineVideoDownload/background/save-location.js)

Responsibilities:

- `resolveSaveAs()` 读取 `askSaveLocation` 设置，供 `chrome.downloads.download({ saveAs })` 使用。
- 被 `direct-download-strategy`、`offscreen-download`（HLS blob 落盘）与 `service-worker.downloadBlobData` 共用。

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
- `DOWNLOAD_BLOB_DATA`
- `FETCH_MEDIA_STREAMS`
- `SET_TAB_MUTED`
- `CLEAR_TAB_VIDEOS`
- `HLS_PROGRESS_UPDATE`
- `INJECT_PAGE_SCRIPTS`（content 请求 background 用 `chrome.scripting.executeScript({ world: 'MAIN' })` 注入页面脚本）
- `INJECT_DOWNLOAD_HEADERS` / `RELEASE_DOWNLOAD_HEADERS`（content 侧 DASH 下载借用 background 的 DNR 规则）
- `GET_DOWNLOAD_HISTORY`
- `CLEAR_DOWNLOAD_HISTORY`
- `OPEN_DOWNLOAD_FOLDER`
- `DELETE_DOWNLOAD_HISTORY_RECORD`

Notes:

- Source-download lifecycle payloads now include both `traceId` and `taskKey` so popup UI can keep the correct item in a pending/completed state across async content-side workflows.
- `FETCH_MEDIA_STREAMS` 增加可选 `taskMeta`（内容侧任务身份：`sourceId`/`strategyId`/`taskKey`/`title`/`traceId`/`videoUrl`），background 据此把抓取阶段进度写进同一个任务，而不是只做广播。缺 `taskMeta` 的旧消息仍可工作（只广播、不更新任务表）。
- `BILIBILI_STREAM_PROGRESS` 改由 background 发起（抓取阶段进度），见下方 Background -> Content / Popup；内容侧不再自行转发合并进度（合并阶段走 `SOURCE_DOWNLOAD_PROGRESS`，background 已能更新任务并广播）。background 保留对内容侧同名消息的透传分支以兼容旧版内容脚本。
- Download completion now passes `downloadId` (browser download ID) through the history record so the store can deduplicate entries and the options page can open the download folder.
- `INJECT_PAGE_SCRIPTS` 字段为 `files`（`injected/*` 与 `lib/message-types.js` 的有序列表）；background 用 `sender.frameId` 定向到发起注入的 frame，CSP 严格站点不再依赖 `<script src>`（DOM 注入保留为回退）。
- `INJECT_DOWNLOAD_HEADERS` 字段为 `url` / `headers` / `corsOrigin`，返回 `{ ok, token }`；`RELEASE_DOWNLOAD_HEADERS { token }` 触发对应 `declarativeNetRequest` 动态规则清理。未释放的会话保留在 `headerInjectionSessions` 中，避免下载中途规则被回收。

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
- `ABORT_SOURCE_DOWNLOAD`
- `DASH_DOWNLOAD_DELEGATE`
- `BILIBILI_STREAM_PROGRESS`
- `SOURCE_DOWNLOAD_STARTED`
- `SOURCE_DOWNLOAD_RESULT`

Notes:

- `HLS_DOWNLOAD_DELEGATE` 由 background 的 `hls-download-strategy` 发往 content，字段为 `m3u8Url` / `filename` / `headers`（捕获到的 `Referer` / `Origin` / `Cookie`）/ `options`（`fetchOptions` 默认 `{ credentials: 'include' }`，用户选定的画质以 `quality`（变体 URL 或标签）透传）/ `taskMeta`；content 返回 `{ downloadId, filename, failedCount, segmentCount, quality, isLive, audioMerged }`，任务据此写入真实 `downloadId`。
- 内容侧 HLS 因体积超限（`HLS_OUTPUT_TOO_LARGE`）中止时，`hls-download-strategy` 视为委托失败并自动回退到 `HlsFetcher`；后台路径用 OPFS 落盘，因此大文件不会因为内容侧的内存上限而整体失败。
- `ABORT_SOURCE_DOWNLOAD` 由 popup 任务视图发往 content，字段 `taskKey` / `traceId` / `videoUrl`（任一匹配即可）。content 侧两种任务都会响应：`download-coordinator` 的内容任务（Bilibili/DASH/YouTube 录制）会 `abort()` 其 `AbortController` 并广播 `SOURCE_DOWNLOAD_RESULT{ ok:false, error:'已取消' }`；HLS 委托下载由 `message-router` 按 `taskMeta.taskKey`/`taskId` 保存的控制器中止，返回 `{ hlsCancelled: true }`。
- 委托下载期间 background 通过 `injectHeaders(url, headers, { corsOrigin })` 注册临时 DNR 规则，让页面上下文的带 Cookie 请求能通过 CDN 的 CORS 校验；content 无响应或返回失败时，同一任务自动回退到 `HlsFetcher`。
- `BILIBILI_STREAM_PROGRESS`（`phase: 'fetching'`）由 background 在抓取 Bilibili 视音频流时广播：`percent` 已按 `lib/progress-scale.js` 映射到统一进度（抓取阶段 0..90）；消息携带发起下载的 `frameId`，`tabs.sendMessage` 因此只发往该 frame 用于驱动页面浮条，同时经 `safeRuntimeMessage` 送达 Popup 条目进度；同一 `percent` 也已写进任务表，所以「下载任务」列表与条目、浮条三处一致。

### Popup -> Content

Examples:

- `BILIBILI_FETCH_QUALITIES`
- `HLS_FETCH_QUALITIES`

Notes:

- The popup requests Bilibili quality options lazily from the content runtime using the current video's `bvid` and `cid`.
- The content router delegates that request to `bilibili-strategy.fetchQualities()` so popup UI does not need to duplicate Bilibili API logic.
- HLS 画质同理：popup 用 `{ m3u8Url, headers }` 请求 `HLS_FETCH_QUALITIES`，content 复用 `hlsDelegateHandler.fetchQualities()`（内部 `parseHlsMasterPlaylist`）返回 `{ isMaster, qualities: [{ url, label, detail, bandwidth, height }] }`；选中项以 `downloadOptions.variantUrl`（精确变体 URL）随下载请求回传。

### Background -> Content (媒体流回传)

- `MEDIA_STREAM_CHUNK` 现在携带 `seq`（同一 label 内自增），块大小取 `MEDIA_STREAM_CHUNK_SIZE`（默认 1 MB，此前复用 256 KB 的 blob 分块常量），最多 `MEDIA_STREAM_PIPELINE_DEPTH`（默认 4）条消息在途，`bytes.subarray` 直接作为 base64 输入避免逐块复制。
- 内容侧按 `seq` 落位，因此流水线不影响还原顺序；`seq` 缺失（旧调用方/页面注入路径）退化为顺序追加。
- 收益模型：100 MB 回传、单次消息往返按 1 ms 计，消息数 400 → 100、阻塞时间 401 ms → 112 ms（≈3.6×）；实际数值取决于 IPC 往返成本。

### Background <-> Offscreen

Examples:

- `OFFSCREEN_BLOB_DOWNLOAD_START` / `OFFSCREEN_BLOB_DOWNLOAD_CHUNK` / `OFFSCREEN_BLOB_DOWNLOAD_FINISH` / `OFFSCREEN_BLOB_DOWNLOAD_ABORT`
- `OFFSCREEN_OPFS_DOWNLOAD_OPEN`
- `OFFSCREEN_OPFS_DOWNLOAD_RELEASE`

Notes:

- SW 里没有 `URL.createObjectURL`，因此对象 URL 一律由 offscreen 文档创建。
- `OFFSCREEN_OPFS_DOWNLOAD_OPEN { name }` 由 offscreen 按文件名打开**同一份 OPFS 文件**（扩展 origin 共享）并返回 `{ ok, objectUrl, byteLength }`——只传文件名，不传输字节。
- `OFFSCREEN_OPFS_DOWNLOAD_RELEASE { name, objectUrl }` 撤销对象 URL 并删除 `ovd-` 前缀的临时文件；由 `background/service-worker.js` 在 `chrome.downloads.onChanged` 的 `complete` / `interrupted` 分支通过 `background/opfs-temp-registry.js` 触发。
- 小文件仍走 `OFFSCREEN_BLOB_DOWNLOAD_*` 的 base64 分片中转（既有路径，会多一份复制）。

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

## 浏览器矩阵（Browser Matrix）

**决策：仅支持 Chromium 内核（Chrome / Edge 109+，Opera/Chromium 同源亦可）。**

依赖的 Chromium 专有能力：

| 能力 | 用途 | Firefox 现状 |
| --- | --- | --- |
| `chrome.offscreen` | 页面关闭后创建 blob 对象 URL、打开 OPFS 临时文件 | 无等价 API |
| `declarativeNetRequest` 动态规则 | 下载时临时注入 `Referer`/CORS，绕过防盗链 403 | 语义与可用性不同，需重写为 webRequest 阻塞式 |
| `chrome.scripting.executeScript({ world: 'MAIN' })` | CSP 严格站点下注入页面 hook | 需 `contentScripts.register` + 不同世界模型 |
| `chrome.runtime.getContexts` | 判断 offscreen 文档是否已存在 | 无对应概念 |
| MV3 Service Worker + module | 后台全部逻辑 | 事件页模型不同 |

`lib/browser-compat.js` 只做信息采集：`browserInfo.supported` 为 false 时 Service Worker
启动日志会明确提示"不在支持矩阵内"，不做看似兼容的降级尝试。

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
| 1.17.23 | 2026-09-25 | 现场反馈「能下载了，但没有音视频合并」。原因：1.17.22 为消重把整个 `youtube-adaptive` 行藏了，连带"（含音频）/（需合并）"的清晰度列表和模式入口一起消失，只剩 HLS 行的"自动"。改成**数据层合并记录、界面层合并选项**：①`lib/video-filter.js` 新增 `mergeYouTubeHlsEntries`，把同 videoId 的 YouTube HLS 条目并入 `youtube-adaptive` 条目（挂成 `hlsManifestUrl`），HLS 条目不单独展示；`background/service-worker.js#getVisibleVideosForTab` 先合并再过滤（徽章计数也随之为 1）；②popup 的 YouTube 清晰度下拉在有 `hlsManifestUrl` 时追加「自动（HLS 预合并，最高画质）」，并异步用 `HLS_FETCH_QUALITIES` 拉 Master Playlist 变体、以「1080p（…）·HLS」形式补进同一个下拉；③选中 `hls:*` 时 `triggerDownload` 把 payload 转成 `type:'hls'`（带 `variantUrl`，auto 时不传 quality），走已有的 HLS 链路（页面上下文抓取 + 分片合并）；其余选项照旧走"抓视频流 + 抓音频流 + fMP4 合并"，合并能力与模式入口都回来了；④存在 HLS 选项时清晰度下拉不再要求切到解析模式（模式门控只对纯合并路径生效）。新增用例 2 条，全量 679 项通过。 |
| 1.17.22 | 2026-09-25 | 现场反馈「可以下载了，但识别列表同一个视频出现两行」：1.17.21 新增的 YouTube HLS 条目与原有的 `youtube-adaptive` 条目并列显示（一行 `YouTube` 徽章、一行 `HLS` 徽章）。修复：`lib/video-filter.js` 新增 `isYouTubeHlsEntry`（识别 `manifest.googlevideo.com/api/manifest/hls_playlist/...`）/`youtubeHlsVideoId`（从 `.../id/<videoId>/...` 取 id）/`listYouTubeHlsVideoIds`，`shouldHideRedundantDetection` 在"同一 videoId 已经有 YouTube HLS 条目"时隐藏 `youtube-adaptive` 那一行——保留 HLS 条目的理由：它是预合并流（无需音视频合并）、不要求 pot，且现场已确认能真正下载；`background/service-worker.js#buildDetectionFilterContext` 相应透传 `youtubeHlsVideoIds`。HLS 条目的清晰度下拉本身会自动拉取 Master Playlist 变体（1014 处 `void fetchAndPopulateQualities()`），所以隐藏 YouTube 行不会丢清晰度选择。新增用例 3 条；另把 `lib/page-message-guard.js` 的 URL 长度上限由 8K 放宽到 16K（YouTube HLS 清单地址自带完整签名，接近上限），全量 677 项通过。 |
| 1.17.21 | 2026-09-25 | 现场日志（行号与 `main` 一致、且完全没有 `direct client` 行）说明浏览器仍在跑旧代码，但这份旧代码的日志给出了**关键新事实**：web 播放响应是 `adaptiveFormatsCount: 78 / formatsCount: 1`、`directAudioCount: 0`、`cipherOnlyVideoCount: 0` —— 自适应流**全部是 SABR-only**（只有 `serverAbrStreamingUrl`，既无 `url` 也无 `signatureCipher`），普通 GET 下不了，所以旧代码的下拉只能有那条 360p progressive。这也是 yt-dlp 里"YouTube is forcing SABR streaming for this client"的情形，只能换客户端解决。改动：①客户端矩阵扩到 7 个并全部校正为 yt-dlp 当前值——`tv`(TVHTML5 7.20260707.07.00) / `web_embedded`(56) / `web_safari`(WEB 2.20260708.00.00 + Safari context UA, `preferHls`) / `ios`(21.26.4) / `android`(21.26.364) / `mweb`(2.20260708.05.00) / `visionos`(1.02)，其中 tv/web_embedded/web_safari/visionos 标 `requiresPot:false`；②解析播放响应时收集 `hlsManifestUrl`：YouTube 的 HLS 是**预合并**的（144p~1080p 一体）且 web 家族的 HLS 不要求 pot，因此若有则以 `type:'hls'` 额外上报一条（带时长/标题/封面/Referer），直接复用已有的 HLS 下载链路（页面上下文抓取 + 分片合并）绕开 SABR-only 死路；③每个客户端日志补 `hls=yes/no dash=yes/no`，`getManifestUrls` 纳入单测。新增用例 2 条，全量 674 项通过。 |
| 1.17.20 | 2026-09-25 | 修复「清晰度下拉只剩 360p」。1.17.19 只用了**第一个成功的**直下客户端，而 TVHTML5 对部分视频只返回 progressive（itag 18 = 360p），于是它把原本丰富的流列表整体替换成了单条 360p——现场截图即"只有默认的 360"。改动：①`fetchYouTubeDirectClientPlayerResponse` 改为分组尝试：先跑"不要求 pot"的客户端（TVHTML5 / WEB_EMBEDDED_PLAYER），若其中最好的可直接下载分辨率仍 `<720p`，再继续试 IOS / ANDROID，最后用 `pickBestClientResult` 按"可直接下载的最高分辨率 → 条数 → pot-free 优先"挑最好的一份（新增 `scorePlayerClientResult`/`pickBestClientResult`，纯函数 + 单测），日志会打出 `direct client picked key=… candidates=tv:360p,android:1080p`；②新增 SABR-only 统计：`getYouTubePlayerMetricsFromFormats` 统计只有 `serverAbrStreamingUrl`（既无 `url` 也无 `signatureCipher`）的条目，并写进 `stream summary` 日志（`sabrOnlyVideoCount/sabrOnlyAudioCount`）——web 响应里高清晰度被强制走 SABR 时无法用普通 GET 下载，正是"列表只剩 360p"的另一半原因，日志可一眼区分。新增用例 3 条，全量 673 项通过。 |
| 1.17.19 | 2026-09-25 | 修复「YouTube 解析下载全 403、清晰度/合并看起来失灵」。用户现场确认：视频能正常播放、同浏览器里其他下载扩展能快速下载 —— 说明不是网络/环境拦截，而是我们**取错了地址**。根因：`ytInitialPlayerResponse` 属于 **web 客户端**，它给出的 `streamingData` 是"半成品"：地址不带 GVS PO Token（`pot`）、`n` 也未做 nsig 转换。yt-dlp 的 `INNERTUBE_CLIENTS` 里 web/mweb/ios/android 的 `GVS_PO_TOKEN_POLICY` 都是 `required=True`，这类地址谁来请求都会被 googlevideo 回 403；而 **TVHTML5 与 WEB_EMBEDDED_PLAYER 没有该策略（不要求 pot）**，它们返回的地址可以直接下载——这正是其他扩展能下载的原因。改动：①新增 `lib/youtube-innertube-clients.js`（对齐 yt-dlp 的客户端配置与请求构造：TVHTML5 7.20260707.07.00 / WEB_EMBEDDED_PLAYER 2.20260708.00.00 / IOS 21.26.4 / ANDROID 21.26.364，前两个 `requiresPot:false`，纯函数便于单测）；②`injected/page-youtube-parser.js` 的兜底取流改为**直下客户端优先级**：原来的 ANDROID_VR 1.60.19 / ANDROID 19.09.37 早已过期（Innertube 直接回 400，现场日志可见），现在按 pot-free 优先依次调用，拿到流后用 `sourceTag:'direct-client'` 重新上报（带 `clientKey`），并且这类报告不受"上次分辨率更高"的去重限制；若该客户端没有直接 `url`（只有 `signatureCipher`）则保留原报告，避免把可下载列表换成待签名条目；③只要页面能解析出播放响应，就会取一次直下客户端的流（不再只在旧启发式命中时才取）；④popup 在"清晰度"下拉被禁用（录制模式）时给出提示"切到「解析下载」可选清晰度并合并音视频"，避免误以为功能被删。新增用例 6 条（客户端优先级/版本/请求体/请求头/流计数），全量 670 项通过。 |
| 1.17.18 | 2026-09-25 | 修复「Bilibili 下载进度三处不一致」。此前同一任务的 Popup 条目、Popup「下载任务」列表、页面右下角浮条各自由不同消息驱动，且各自使用自己阶段的原始百分比：抓取阶段只有条目拿到进度（任务列表与浮条停在 0%），合并阶段三处又从 0% 重新开始。新增 `lib/progress-scale.js`（`mapPhasePercent`：`fetching` 0..90、`merging` 90..99、`complete` 100）作为唯一进度坐标系，background 与 content 共用：①`fetchMediaStreams` 的抓取进度先映射再同时写进 `DownloadStateStore`（任务列表 + 条目）与广播，`FETCH_MEDIA_STREAMS` 新增 `taskMeta` 让后台定位同一任务，并加单调保护（两路流总长度先后到达时分母变大导致回退）；②`BILIBILI_STREAM_PROGRESS` 携带 `frameId`，只发往发起下载的 frame，`message-router` 据此驱动页面浮条（同页其它 iframe 不再各自弹条）；③Bilibili / YouTube 解析下载的合并回调改用同一映射（浮条与上报 popup 的数字逐次相同），内容侧重复转发的合并进度已移除。新增用例 8 条，全量 663 项通过。 |
| 1.17.17 | 2026-09-25 | popup 提示不再堆叠：一次下载会依次上报「正在获取 Bilibili 视频地址…」「正在获取 Bilibili 视音频数据…」等状态，旧实现每条 `SOURCE_DOWNLOAD_STATUS` 都 `appendChild` 一条 toast，于是屏幕上同时出现多条几乎一样的提示（截图即 3 条）。`popup/popup.js#showMessage` 新增 `options.key`：同一任务（`taskKey`/`traceId`）的状态、完成、失败复用同一个 toast 就地更新文案并重置自动消散计时；另外对「连续重复文案」直接刷新计时而不新增节点（兜住多 frame 重复上报）。popup 侧的开始/已在执行/失败提示同样按 `source:<taskKey>` 归类。实测一次下载过程中 toast 容器始终只有 1 条，文案按状态就地更新。 |
| 1.17.16 | 2026-09-25 | 完成通知按「视频」去重：重复点击/重试会各自产生 downloadId（同一 taskKey），此前每个 downloadId 弹一条「下载完成」，用户看到的就是多条几乎一样的横幅。`DownloadNotificationManager.notifyComplete` 新增 `options.dedupeKey`（由 SW 传 `taskKey`）按逻辑视频去重；SW 侧 `notifyDownloadComplete` 另外检查任务快照里是否已有同 `taskKey` 且 `completeNotified` 的任务（随 storage.session 存活，SW 被回收后依然有效）。通知 id 仍为 `ovd-download-<downloadId>`，点击定位文件的能力不变。实测同一条视频连点两次：2 个文件、仅 1 条通知。新增用例 1 条，全量 655 项通过。 |
| 1.17.15 | 2026-09-25 | 修复「检测列表出现多条同名视频、下载时通知重复」。B 站视频页的播放器用 MSE，`blob:` URL 在播放器每次重建/切流时都会变，于是同一视频在列表里堆出 1 条 `bilibili-meta` + N 条标题相同的 `Blob` 条目（实测 3 条），用户误点即会连带产生重复文件与重复完成通知。新增 `lib/video-filter.js#shouldHideRedundantDetection`（B 站视频页存在 `bilibili-meta`/`bilibili-dash` 时隐藏同页的 `blob` 与页面内部 `audio` 噪声；YouTube 既有规则——非观看页整页隐藏、观看页隐藏同源 blob 与音效——原样保留）与 `lib/video-filter.js#collapseDuplicateBlobEntries`（同一 frame + 同标题的多个 blob 只保留最新一条），`getVisibleVideosForTab` 读取时先折叠再过滤，规则本身为纯函数并纳入单测。实测同一页面：原始注册表仍为 `bilibili-meta + blob`，popup 列表由 3 条收敛为 1 条，点击下载 1 次 → 1 个文件 + 1 条完成通知。新增用例 4 条，全量 654 项通过。 |
| 1.17.14 | 2026-09-25 | 修复「一次下载变成多份 + 完成通知重复」。①重复下载：内容脚本注入所有 frame，而 `chrome.tabs.sendMessage(tabId, msg)` 默认广播给每个 frame——B 站页面同时存在主 frame 与两个 `s1.hdslb.com` iframe 时，一次点击会被 3 个 frame 各下载一份（实测 3 个文件、3 条系统「下载完成」提示）。内容脚本拿不到自身 frameId（onMessage 的 sender 是发送方 popup），因此 `content-main` 在 MAIN world 注入成功后从 SW 响应里记录 `globalThis.__OVD_FRAME_ID__`（`INJECT_PAGE_SCRIPTS` 回传 `sender.frameId`），`message-router` 对 SOURCE_DOWNLOAD 一类下载消息做归属判定：`meta.frameId`/`taskMeta.videoInfo.frameId` 与自身不一致时直接忽略且不响应，由持有该视频的 frame 独占执行；缺 frameId 的旧消息保持广播兼容。②重复通知：完成通知此前**从未真正触发**——正常完成分支没有调用，唯一调用点位于 SW 重启补写路径且引用了未定义变量 `downloadId`/`item`；现在完成分支会发通知，并做两级去重（`DownloadNotificationManager` 按 downloadId 去重 + 任务上持久化 `completeNotified` 标记，覆盖「中断→自动续传→完成」与 SW 重启补写），通知文案只展示文件名而非绝对路径。③`DOWNLOAD_BLOB_DATA` 按 `traceId` 去重：首次响应丢失但下载已创建时复用同一 downloadId，避免内容侧兜底重下产出重复文件。新增/调整用例 5 条，全量 650 项通过。 |
| 1.17.13 | 2026-09-25 | 修复「全部站点探测不到视频」与「B 站下载 Failed to fetch」。①探测全灭：`background/download-strategies/youtube-adaptive-download-strategy.js` 在 4.3 收敛时多写了一份 `const byteUtils`，顶层重复声明是 SyntaxError，MV3 service worker 的 module 依赖图因此整体无法求值——SW 起不来、`INJECT_PAGE_SCRIPTS` 无人处理、MAIN world 脚本从未注入，表现为任何站点零探测；删除重复声明，并新增 `test/module-syntax.test.js`（单子进程 `vm.SourceTextModule` 编译全部随扩展发布的 `.js`，防止同类「单测全绿但 SW 死了」的回归）。②B 站下载：`playurl` 返回的 `baseUrl` 常指向 PCDN 边缘节点（`*.mcdn.bilivideo.cn:8082`、`*.edge.*`），在部分网络/端口策略下不可达，此前只试 `baseUrl`，失败即整个下载报 `video stream fetch failed: Failed to fetch`；新增 `lib/bilibili-quality-utils.js#listBilibiliStreamUrls`（baseUrl + backupUrl 去重）与 `lib/http-utils.js#fetchFirstAvailableUrl`（按顺序回退、失败时汇总各域名与原因），content 侧把候选地址数组透传给 `FETCH_MEDIA_STREAMS`，background 对每个候选域名分别注入 Referer/CORS 规则后逐个尝试，全部失败时错误文案会列出所试域名，popup 新增 `err_streamUnreachable` 关键词兜底。③顺带：SW 把 `BILIBILI_DOWNLOAD_*` / `YOUTUBE_DOWNLOAD_*` 声明为通知类消息，消除每次下载都刷的 `Unknown message type` 报错。 |
| 1.17.12 | 2026-09-25 | 第四波 4.4 国际化 phase C（错误文案）：popup/popup-error-messages.js 改为 i18n 感知——错误码映射表由 14 项扩到 19 项（补 HLS_OUTPUT_TOO_LARGE/HLS_CONTENT_SIZE_SKIP/DASH_OUTPUT_TOO_LARGE/OPFS_WRITE_FAILED/DOWNLOAD_ABORTED），每条带 key + 中文兜底；关键词兜底由 2 条扩到 7 条且**同时支持中英关键词**（403 / timeout / login required / DRM / No segments found 等），因为原始错误可能来自任一语言。策略侧无错误码的抛错文案（master 无可用画质、m3u8 无分片、DASH manifest 为空、MPD 无视频自适应集、muxer 未加载、浏览器交接失败）接入 	()。_locales/zh_CN 与 _locales/en 各 152 key 保持一一对应。 |
| 1.17.11 | 2026-09-25 | 第四波 4.3 消除重复实现：①ackground/download-strategies/youtube-adaptive-download-strategy.js 删除本地 5 份重复（parseContentRangeTotal/parseTotalBytesHintFromUrl/inferTotalBytesFromResponse/createRangeHeaderValue+uildRangeRequestHeaders/mergeUint8Chunks，共 2274 字符），改为调用 lib/http-utils.js 与 lib/byte-utils.js；共享库补齐此前缺失的能力——createRangeHeaderValue(start, end) 支持闭区间、createRangeRequestHeaders(headers, start, end) 先剔除原 Range 避免冲突、concatUint8Arrays(arrays, totalBytes) 支持预分配并跳过空分片（这正是两处实现漂移的部分）。②HLS 侧 	oMuxBuffer 与密钥解析（新增 
esolveHlsKeyInfo）收敛进 lib/hls-pipeline.js，content/strategies/hls-strategy.js 与 ackground/hls-fetcher.js 只剩 3 行委托 shim（保留替身管线兼容分支，使既有 stub 测试语义不变）。传输层胶水（内容侧浮条进度 + blob 交接 / 后台 OPFS + offscreen 交接）保留各自实现，属两端固有差异。 |
| 1.17.10 | 2026-09-25 | 第四波 4.4 国际化 phase B：内容脚本侧 25 条用户可见状态/提示文案接入 i18n——7 个策略文件（hls / dash / bilibili / youtube-capture / youtube-parse-download / blob / generic）各自内置 	(key, fallback, subs) 前置（优先 globalThis.__OVD_I18N__.t，未加载时本地退回中文原文**并同样替换 $1..**，因此测试环境与生产行为一致）；lib/i18n.js 加入 manifest content_scripts 顺序（紧跟 message-types.js）。_locales/zh_CN 与 _locales/en 各 119 key 并保持 key 集合一致。仍未覆盖（phase C）：策略抛错文案与 popup-error-messages 错误目录。 |
| 1.17.9 | 2026-09-25 | 第四波 4.4 国际化（phase A）：新增 _locales/zh_CN（default_locale，94 key）与 _locales/en（同 key 集），lib/i18n.js 提供 	(key, fallback, subs) 与 pplyI18n(root)——设计上强制调用方传中文原文作为 fallback，并在本地实现 $1.. 替换，因此漏配 key 只会退化为改动前的界面，不会露出 popup.xxx；popup.html 静态文案改用 data-i18n/data-i18n-title/data-i18n-placeholder，popup.js 43 处动态文案与 download-notification.js 通知文案接入。phase B（内容脚本状态文案）待做。 |
| --- | --- | --- |
| 1.17.8 | 2026-09-25 | 第四波（4.8 浏览器矩阵决策 + 4.5 死代码清理）。4.8：明确**仅支持 Chromium 内核（Chrome / Edge 109+）**并写进 README 四语与 manifest（`minimum_chrome_version: "109"`）；`lib/browser-compat.js` 移除 `isFirefox` 探测，改为 `isChromium` / `supported`（Chrome/Edge/Opera/Chromium），Service Worker 启动时对不受支持的浏览器发出明确警告而非静默降级。放弃 Firefox 的理由：offscreen document、declarativeNetRequest 动态规则、`scripting.executeScript({ world: 'MAIN' })`、`runtime.getContexts` 均无等价方案，真支持等于重写离线下载与页面注入两条链路。4.5：删除 popup 中恒返回空串的 `buildQualityHtml`（及其调用点）、未被引用的 `DOWNLOAD_BUTTON_LABELS`、`content/message-router.js` 中未使用的 `byteUtils`/`formatBytes`；`background/download-strategies/dash-download-strategy.js` 已在第三波注册启用，不再是死代码。 |
| 1.17.7 | 2026-09-25 | 第四波（4.6 安全收紧 + 4.7 文件名健壮性）。安全：新增 `lib/page-message-guard.js`，把「页面 → 内容脚本」的检测结果当不可信数据处理——类型必须在白名单内（audio/hls/dash/direct/blob/youtube-adaptive/bilibili-meta/drm-detected…），URL 只允许 `http(s):` 与带 origin 的 `blob:`（挡掉 `file:`/`data:`/`chrome:`/`javascript:`/裸 `blob:`），并限制 URL 与 title 长度；`content/message-router.js` 在转发 `VIDEO_DETECTED` 前校验，`service-worker.js#handleVideoDetected` 再做一次纵深防御。`web_accessible_resources` 由 `lib/*` 收紧为仅 `lib/message-types.js`（DOM 注入回退所需）+ `injected/*.js` + `icons/*`；manifest 增加 `minimum_chrome_version: "109"`（offscreen 依赖）。文件名：`sanitizeFilename` 规避 Windows 保留设备名（CON/PRN/NUL/COM1-9/LPT1-9，含带扩展名）、去掉结尾点与空格（Windows 会静默剥离）、剔除控制字符，并改为按码点截断（不再切断 emoji 代理对）；重名冲突沿用 `chrome.downloads` 默认的 uniquify 策略。 |
| 1.17.6 | 2026-09-25 | `downloadHlsSegments` 的 sink 写入与分片下载重叠：写入排到一条串行链上（保证顺序文件不错位），只有「未落盘分片数 > `options.sinkWindow`（默认 = 并发数）」时才回压等待，写入/解密错误经 `writeError` 在批次检查点与收尾处抛出。此前每批 `await flushSink()` 会把 OPFS 落盘延迟叠加到下载关键路径上；现在节省量 ≈ (批次数 − 1) × 单批抓取等待。新增用例：下载与写入重叠的结构断言（写入期间确有抓取发生、写入仍串行、写入顺序 = 分片顺序）、串行 vs 重叠的耗时下界对比、sink 写入失败透出错误码。 |
| 1.17.5 | 2026-09-25 | `bilibili-muxer` 解析健壮性收尾（4.2 剩余三项）：①`parseFragment` 现在遵循 `trun` 的 `data-offset`（含 `tfhd` `base-data-offset`，基准为 moof 起点），越界抛 `FMP4_TRUN_OFFSET_OUT_OF_RANGE`；未声明偏移时游标按 ISO 14496-12 §8.8.8 跨 traf 连续推进，首个 run 落在 mdat payload 起点。②一个 moof 内的多个 `traf`、同一 `traf` 内的多个 `trun` 全部解析（此前 `parseBoxes` 返回数组时只取第一个，静默丢样本）。③样本写入失败不再 `muxerWarn` 后继续：抛 `FMP4_SAMPLE_WRITE_FAILED`（带 track/sampleIndex），样本 size 为 0 抛 `FMP4_SAMPLE_SIZE_INVALID`，视频或音频解析结果为空抛 `FMP4_NO_SAMPLES`——避免产出静默丢帧/音画不同步的 MP4。新增 7 个用例覆盖 data-offset 跳过填充与越界、多 traf、多 trun 连续、写入失败、空样本。 |
| 1.17.4 | 2026-09-25 | 真实 moov fixture 端到端合并测试（4.2 收口）：`test/bilibili-muxer.test.js` 新增程序化构造的真实 fMP4（ftyp + moov(trak(mdia(hdlr/mdhd/minf/stbl/stsd → avc1→avcC 或 mp4a→esds))) + N×(moof+mdat)），断言 `mergeFmp4Streams` 能提取解码配置、完成合并，并通过重新解析输出验证「moov 含 2 条 trak + mdat 存在」；同时用真实结构复验零拷贝不变量。随之把合并上限从 1.5 GB 上调到 2 GB（`MAX_IN_PAGE_MERGE_BYTES` / `DASH_MAX_MERGE_BYTES`，含各策略的兜底默认值），依据是零拷贝后合并期峰值 ≈ 2×（输入 + 输出）。 |
| 1.17.3 | 2026-09-25 | `bilibili-muxer` 零拷贝重构：`parseBoxes` 不再 `slice` 出 `box.data`（全仓库无消费者，改为只记录 offset/size）；`collectFragments` 从「切片出 moofData/mdatData」改为产出 `moofPayloadOffset/Size + mdatPayloadOffset/Size`；`parseFragment(buffer, fragment)` 改为按偏移解析，样本数据用 `new Uint8Array(buffer, offset, size)` 视图而非副本（`addVideoChunkRaw` 只读且输入在合并期间存活，视图安全）。同时 `content/strategies/hls-strategy.js`、`background/hls-fetcher.js` 传入 muxer 前不再 `buffer.slice()` 复制两路数据（视图已覆盖整个 buffer 时直接复用）。效果：合并前的临时拷贝由「盒子内容 + 片段 + 逐样本」约 3 份全量，降为 0，mux 峰值从约 4～5× 流大小降到约 2×（输入 + 输出），使 `MAX_IN_PAGE_MERGE_BYTES` 有放宽空间。新增 `test/bilibili-muxer.test.js`（6 例）用自建 moof/mdat fixture 断言零拷贝不变量（偏移产出、样本视图共享 buffer、内存增量与媒体体积解耦）；`BilibiliMuxer.__internals` 暴露 `parseBoxes/collectFragments/parseFragment/findBox` 供测试断言。 |
| 1.17.2 | 2026-09-25 | P0 优化（网络/浪费路径）：①`lib/hls-pipeline.js` 新增 `estimateHlsBytes(playlist, bandwidth, { bandwidthFactor })`，content 侧 HLS 在下载前按 `sum(EXTINF) × 有效带宽 / 8` 预估体积，超过 `MAX_IN_PAGE_MERGE_BYTES` 时抛 `HLS_CONTENT_SIZE_SKIP` 让后台 OPFS 路径接手，消除"先下满 2 GB 再中止重下"；②Bilibili/YouTube 的媒体流回传由「256 KB + 逐条 await」改为「1 MB + 有界流水线（`MEDIA_STREAM_CHUNK_SIZE` / `MEDIA_STREAM_PIPELINE_DEPTH`）」，消息数降 4 倍、阻塞时间在 1 ms 往返模型下约 3.6 倍提升；分片带 `seq`，`content/stream-transfer-manager.js` 按 seq 落位并在 `finish` 时校验连续性，缺片抛 `MEDIA_STREAM_CHUNK_MISSING` 而不是产出错序文件。 |
| 1.17.1 | 2026-09-25 | Third-wave follow-up: large-file memory治理与分离文件降级。`downloadHlsSegments` 新增 `options.sink` / `options.transform`：有 sink 时不再返回整份 buffers，只保留 ≤ 并发数的有序重排窗口，解密在写入前逐分片执行（`createSegmentDecryptor` 与 `decryptHlsSegments` 共用实现，峰值内存从 ≈3N 降到 ≈N）。新增 `lib/opfs-sink.js`：`createInMemorySink` / `createOpfsSink` / `createSpillSink`（超过 `OPFS_SPILL_THRESHOLD_BYTES` 自动溢出到扩展 origin 的 OPFS，输出上限改用 `OPFS_MAX_OUTPUT_BYTES`）+ `cleanupStale()`；manifest 增加 `unlimitedStorage`。后台 HLS 路径使用自适应 sink，完成后经 offscreen 的 `OFFSCREEN_OPFS_DOWNLOAD_OPEN`（只传文件名、不传字节）换取对象 URL 交给 `chrome.downloads`，`background/opfs-temp-registry.js` 记录 `downloadId → 文件名`，SW 在 `onChanged` 的 complete/interrupted 分支删除临时文件；内容侧因 `HLS_OUTPUT_TOO_LARGE` 中止后仍会自动回退到这条后台路径。分离文件降级：HLS 独立音轨无法合并（视频非 fMP4 或 muxer 抛错）时单独保存 `_audio` 文件而不是丢弃；DASH 超过 `DASH_MAX_MERGE_BYTES`、Bilibili 超过内存上限时改为保存 `-video` / `-audio` 两个文件而不是直接失败。 |
| 1.17.0 | 2026-09-25 | Third-wave coverage parity with Video DownloadHelper. HLS: `parseHlsMasterPlaylist` + `selectHlsVariant` expose every variant (with `width/height/bandwidth/codecs/audioGroupId`) to a new popup clarity dropdown backed by `HLS_FETCH_QUALITIES` (selection travels as `downloadOptions.variantUrl`); the media playlist parser now returns rich segments (`seq`/`byteRange`/`keyIndex`/`discontinuity`) and handles `EXT-X-BYTERANGE`, `EXT-X-KEY` rotation, `EXT-X-MEDIA-SEQUENCE`-derived IVs, `EXT-X-MAP` byte ranges, `EXT-X-DISCONTINUITY` and `EXT-X-ENDLIST` (live playlists show a 「仅下载当前窗口」 warning instead of silently producing a truncated file); `EXT-X-MEDIA` audio renditions are muxed into the video via `bilibili-muxer` when both sides are fMP4. Streams larger than `MAX_IN_PAGE_MERGE_BYTES` abort with `HLS_OUTPUT_TOO_LARGE` (also enforced for Bilibili muxing via `BILIBILI_OUTPUT_TOO_LARGE`). DASH: `lib/mpd-parser.js` gains `$Number%05d$`/`$Time%08d$` template formatting, `mediaRange`/`indexRange`/`SegmentBase@indexRange` byte ranges, correct multi-Period grouping (`periods`, `isMultiPeriod`, `collectRepresentationsAcrossPeriods`) and `SegmentTimeline r="-1"`, plus a built-in XML fallback so the parser runs (and is tested) without `DOMParser`; the content DASH strategy injects Referer/CORS through `INJECT_DOWNLOAD_HEADERS`/`RELEASE_DOWNLOAD_HEADERS` and passes byte ranges to the fetcher. Detection: `video/mp2t`, `video/quicktime`, `video/x-matroska` and `application/octet-stream` (confirmed by extension or `Content-Disposition`) are recognised, and generic pages watch `MutationObserver` + media events instead of scanning twice. Injection: page scripts are loaded through `chrome.scripting.executeScript({ world: 'MAIN' })` (`INJECT_PAGE_SCRIPTS`) with the `<script src>` path kept as fallback. Settings: `domainBlacklist` / `minVideoDurationSec` / `minVideoSizeMb` filter noisy entries at read time via `lib/video-filter.js`, and `askSaveLocation` drives `saveAs`. Tasks: `ABORT_SOURCE_DOWNLOAD` cancels content-side tasks through `AbortController`/`DOWNLOAD_ABORTED`, the popup task list has a 取消 button, and `background/download-queue.js` applies `concurrentDownloadLimit` to every background download entry point. |
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
