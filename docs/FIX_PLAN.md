# 修复计划：对标 Video DownloadHelper

> 基于 2026-09 全量代码评审（架构/后台管线、视频源探测、UI 交互、媒体处理与测试四路审查）产出的修复路线图。
> 目标：确保网页视频下载功能完善、交互友好、兼容性达标，达到 Video DownloadHelper（VDH）同级水平。
>
> **进度**：第一波 ✅（commit `3b8e554`）· 第二波 ✅（commit `cef9a20`）· 第三波 ✅（2026-09-25，未提交）· 第四波未开始。

## 总体判断

下载内核扎实（YouTube/Bilibili 深度适配、HLS/DASH 通用嗅探、纯 JS 浏览器内合并无需 ffmpeg——这是相比 VDH 依赖 companion app 的差异化优势），但存在：

1. 一批会产出**损坏文件却无任何提示**的高危 bug；
2. UI 层"半成品"特征——至少 4 个界面上存在的功能实际不生效；
3. 通用站点覆盖面（blob/MSE、iframe、动态加载）与 VDH 差距明显。

---

## 第一波：正确性修复（高危，会产出坏文件或功能失效）

优先级最高，修复前插件处于"不可信"状态。

| # | 问题 | 位置 | 修复方案 |
|---|------|------|----------|
| 1.1 | HLS/DASH 分片失败静默填空洞，产出中间缺段的损坏视频且零报错；`HLS_MAX_FAILED_RATIO` 阈值定义了从未使用 | `background/hls-fetcher.js:88`、`content/strategies/hls-strategy.js:65`、`lib/constants.js:44` | 分片失败先重试（3 次指数退避），失败比例超过 `HLS_MAX_FAILED_RATIO` 即中止任务并向用户报错，绝不产出含空洞的文件 |
| 1.2 | AES 加密失败静默产出垃圾：取 key 失败按未加密处理、解密失败回退密文拼接 | `lib/hls-pipeline.js:144-187` | key 获取/解密失败必须 fail-fast，明确报错"SAMPLE-AES/加密流不支持" |
| 1.3 | blob/MSE 视频链路断裂：页面拦截器检测到 blob 视频并上报，但被无条件丢弃，现代流媒体站列表为空 | `background/service-worker.js:595-598` | 改为正常注册 blob 条目（记录 tabId、标记 requiresTabContext），接通已有的 blob-strategy 委托下载链路 |
| 1.4 | iframe 嵌入视频不支持，第三方页面嵌入的 YouTube/Vimeo 播放器探测不到 | `manifest.json:68` | `all_frames: true`（至少覆盖 youtube/embed、player.vimeo.com 等），message-router/registry 按 frameId 区分来源并聚合到所属 tab |
| 1.5 | Popup 所有状态/错误提示用户看不见：`showMessage()` 空实现，无 toast 容器 | `popup/popup.js:1792`、`popup/popup.html` | 实现 toast 组件（error 红色长驻、success 短驻自动消散），这是所有用户反馈的咽喉 |
| 1.6 | 请求头被空对象覆盖导致间歇性 403：后到的空 `requestHeaders: {}` 覆盖已捕获的 Referer/Cookie | `background/video-registry.js:93` | 仅当 `Object.keys(info.requestHeaders).length > 0` 时才合并 headers |
| 1.7 | MV3 SW 生命周期冲突：任务状态全在内存，SW 30s 空闲回收后进度/续传/历史关联全丢；SW 内长时 fetch 可能被中途杀掉 | `background/service-worker.js`、`background/download-state-store.js` | 进行中任务关键字段（tabId、videoUrl、任务映射）写入 `chrome.storage.session`，SW 重启后恢复 `onChanged` 关联；长任务迁移到 offscreen document 执行 |
| 1.8 | `fetchStreamBufferResumable` 尾部填零 bug：服务器提前断流时产出尾部零填充的损坏文件（YouTube 策略已修，SW 是漏修旧拷贝） | `background/service-worker.js:1230` | 按 `loadedBytes` 分配合并数组，与 `youtube-adaptive-download-strategy.js:318` 对齐；顺手统一改用 `lib/http-utils.js` |

## 第二波：体验达标（界面存在但失效的功能 + 核心反馈链路）

> ✅ 已全部完成（commit `cef9a20`，2026-09-25）。

| # | 问题 | 位置 | 修复方案 | 状态 |
|---|------|------|----------|------|
| 2.1 | 下载完成通知是死功能（设置有开关、权限已申请、零调用） | `manifest.json:16`、`lib/settings-store.js` | 在 SW 下载完成分支读 `downloadNotification` 设置调 `chrome.notifications.create`（标题、大小、点击打开文件夹）；不做则移除权限与设置项 | ✅ `cef9a20` |
| 2.2 | 文件命名规则设置不生效 | `popup/popup.js`、`lib/download-path.js` | 在 `Downloader._buildFilenameBase`/`download-path.js` 按 `title`/`title-quality`/`title-date` 模板拼接；或暂时从设置 UI 移除 | ✅ `cef9a20` |
| 2.3 | 批量下载代码完整但 UI 被阉割（复选框被 CSS 隐藏、无调用方），PRD §4.7 宣称支持 | `popup/popup.js:1749`、`popup/popup.css:74-78` | 恢复复选框可见性 + 全选 +「下载所选」按钮接通 `startBatchDownload`；或删除代码并同步 PRD。当前状态最糟，必须二选一 | ✅ `cef9a20` |
| 2.4 | 图标徽章语义错位：显示运行中任务数而非检测到的视频数（VDH 核心发现性交互） | `background/service-worker.js:656-670` | 检测数变化时按 tab `setBadgeText` 显示检测数；任务数用 popup 内已有的 `taskEntryBadge` | ✅ `cef9a20` |
| 2.5 | 条目内无百分比进度，popup 关闭后长任务完全无反馈（`getFloatButton` 恒返回 null，55 处调用空转） | `popup/popup.js:1621`、`content/content-main.js:155` | 条目按钮文案显示百分比（"下载中 45%"）；恢复页面内浮动进度/错误反馈（浮动条或 toast） | ✅ `cef9a20` |
| 2.6 | 死 UI：类型徽章计算了未渲染；`.note-text {display:none}` 隐藏全部说明（含 DRM 提示）；"检测到 N 个视频"写入隐藏元素 | `popup/popup.js:1087-1103`、`popup/popup.css:392-395` | 渲染 `buildFormatPillHtml` 类型徽章；按需显示 note-text；计数挪到主视图可见位置 | ✅ `cef9a20` |
| 2.7 | 错误提示不友好：原始 `err.message` 透传，错误码体系未对接文案 | `content/youtube-download-errors.js`、`popup/popup.js:1736` | 建立错误码 → 中文友好文案映射表，对 Bilibili/HLS 失败给出可操作指引（登录、刷新、切换模式） | ✅ `cef9a20` |
| 2.8 | 「清列表」只清 popup 本地数组，下一条消息就重新填满 | `popup/popup.js:242-246` | 同时通知 background 清理该 tab 的 registry | ✅ `cef9a20` |

## 第三波：覆盖面对标 VDH

| # | 事项 | 说明 | 状态 |
|---|------|------|------|
| 3.1 | HLS 清晰度选择 | Master Playlist 暴露码率/分辨率变体供用户选择（复用 YouTube/Bilibili 已有的画质选择 UI），不再固定最高带宽 | ✅ `parseHlsMasterPlaylist`/`selectHlsVariant` + popup 下拉框 + `HLS_FETCH_QUALITIES`，选择以 `downloadOptions.variantUrl` 精确回传 |
| 3.2 | HLS 协议补全 | 支持 `EXT-X-BYTERANGE`、`EXT-X-KEY` 轮换、`EXT-X-MEDIA-SEQUENCE`（当前 AES IV 会错位）、`EXT-X-MEDIA` 独立音轨合并；检测 discontinuity 与直播（无 ENDLIST 时明确提示"直播中，仅下载当前窗口"而非静默产出残片） | ✅ 分片对象化（`seq`/`byteRange`/`keyIndex`/`discontinuity`）、`resolveHlsKeys` 轮换、`ivFromSequence` 派生 IV、独立音轨经 muxer 合并、直播显式提示 |
| 3.3 | DASH 路径补全 | `content/strategies/dash-strategy.js` 复用 `injectHeaders` 注入 Referer/CORS（当前遇防盗链 CDN 直接 403）；background 的 DASH 策略统一走 content 合并路径或明确告知"将下载两个分离文件" | ✅ content 经 `INJECT_DOWNLOAD_HEADERS`/`RELEASE_DOWNLOAD_HEADERS` 借用 SW 的 DNR 规则；background 对已解析分离流落盘两个文件，仅 `.mpd` 场景给出中文可操作提示 |
| 3.4 | MPD 解析修复 | 支持 `$Number%05d$` 宽度格式符（`lib/mpd-parser.js:135-151` 当前只做字面替换，产出含 `$` 的坏 URL）、SegmentURL `mediaRange`/`indexRange`、多 Period 正确分组、SegmentTimeline `r="-1"` | ✅ 另加 `$Time%08d$`、`$$` 转义、`SegmentBase@indexRange`、内置无 DOMParser 回退解析器（测试不再 skip） |
| 3.5 | 通用嗅探增强 | MIME 增加 `video/mp2t`、`video/quicktime`、`application/octet-stream`（结合扩展名/Content-Disposition 二次确认）；通用站点加 MutationObserver 持续监听动态插入的 `<video>/<audio>`（当前仅 init/load 扫描两次） | ✅ 另加 `video/x-matroska`；`injected/page-context-script.js` 新增防抖 MutationObserver + `loadstart`/`loadedmetadata` 监听 |
| 3.6 | 页面注入改用 `chrome.scripting.executeScript({world:'MAIN'})` | 当前 DOM `<script>` 注入在 Twitter/X 等 CSP 严格站点静默失败，导致全部 hook 失效（`content/content-main.js:16-51`） | ✅ 新增 `INJECT_PAGE_SCRIPTS`（按 `sender.frameId` 定向、`injectImmediately`），DOM `<script>` 注入保留为回退 |
| 3.7 | 大文件内存治理 | HLS 与 Bilibili 合并路径补与 DASH 一致的 2GB 体积守卫（当前 `content/strategies/bilibili-strategy.js:185` 只打日志）；评估 OPFS/File System Access API 分片落盘替代纯内存合并；过大时降级为"下载分离文件" | ✅ 三步：①`downloadHlsSegments({ maxTotalBytes })` 统一守卫；②顺序写入 sink + 逐分片 transform，峰值内存 ≈3N → ≈N+并发窗口；③新增 `lib/opfs-sink.js`（内存→OPFS 自适应溢出，`unlimitedStorage`），后台 HLS 大文件真正落盘（上限改 `OPFS_MAX_OUTPUT_BYTES` 8GB），临时文件由 SW 在下载结束/中断时清理、启动时清理残留；内容侧超限自动回退到后台落盘路径 |
| 3.8 | 过滤与黑名单 | 增加大小/时长阈值与域名黑名单，过滤广告片段、音效等噪声条目 | ✅ 新增 `lib/video-filter.js` + 三个设置项，读取列表时过滤，结构化来源不受阈值影响 |
| 3.9 | 任务管理补全 | 内容侧任务 ABORT 消息通道（当前只能取消有 downloadId 的任务）、落实全局并发队列（`concurrentDownloadLimit` 当前仅 popup 批量入口生效）、`saveAs` 可选保存位置 | ✅ `ABORT_SOURCE_DOWNLOAD` + `AbortController`（`DOWNLOAD_ABORTED`）、popup 任务「取消」按钮、`background/download-queue.js` 全局并发、`askSaveLocation` → `saveAs`；过大文件改为保存分离文件（3.7 三步之外的第 4 个降级点：DASH/Bilibili/HLS 音轨） |

### 第三波遗留（未做，建议并入第四波）

- 内容侧（页面上下文）路径仍是纯内存：OPFS 只有扩展 origin 可见。已在下载前用播放列表估算体积，预估超限直接跳过内容侧（`HLS_CONTENT_SIZE_SKIP`），因此"先下满 2 GB 再重下"的情况已消除；估算不准（例如服务器码率远低于标称）时仍可能落在回退路径上。
- DASH / Bilibili 合并仍需整体持有两路数据（fMP4 muxer 接口限制），超过上限时已降级为分离文件，但没有流式 mux。
- File System Access API（用户直接选保存位置并流式写入）未做：需要可见页面 + 用户手势，属 UX 变更。
- `offscreen/offscreen.js` 的小文件中转（base64 分片）仍会再复制一份，仅在内存路径上。到这一步 P1 全部完成（muxer 零拷贝、OPFS 落盘、写入与下载重叠）。
- HLS 直播续录、`EXT-X-PROGRAM-DATE-TIME` 对齐、DRM（SAMPLE-AES/CENC）仍然不支持。

## 第四波：工程健康

| # | 事项 | 说明 |
|---|------|------|
| 4.1 | 修复 MPD 测试零执行 | `test/mpd-parser.test.js:7` 的 6 个用例因 Node 无 DOMParser 全部 skip；引入 `@xmldom/xmldom` 或 happy-dom 让其真正运行，并补 `$Number%05d$`、`r="-1"`、mediaRange 回归用例 |
| 4.2 | 补 bilibili-muxer 测试 | 手写二进制解析器是全仓库风险最高、覆盖为零的模块；用最小构造的 fMP4 fixture 验证 `parseFragment`/config 提取/mux 输出；同时修复 trun data-offset、多 traf/trun 的脆弱假设（`lib/bilibili-muxer.js:382`）与样本写入失败静默丢帧问题 | ✅ 完成：`test/bilibili-muxer.test.js`（14 例）覆盖零拷贝不变量、样本解析正确性、**真实 moov（avcC/esds）fixture 的端到端合并**（输出重新解析验证双 trak + mdat），以及 trun data-offset（含越界报错）、多 traf/多 trun 解析、样本写入失败 fail-fast、空样本中止 |
| 4.3 | 消除重复实现 | HLS 下载循环在 background/content 各一份（`hls-fetcher.js` vs `hls-strategy.js`）收敛为单一实现；`youtube-adaptive-download-strategy.js:70-130` 改用 `lib/http-utils.js`（两份逻辑已出现漂移） | ✅ ①`youtube-adaptive` 删除 5 份本地重复（content-range 解析、clen 提示、total 推断、Range 头、分片合并）改为调用 `lib/http-utils.js` / `lib/byte-utils.js`，并给共享库补上闭区间 Range 与 totalBytes 预分配（原库只支持 `bytes=N-`，已漂移）；②HLS 侧把 `toMuxBuffer`、密钥解析（`resolveHlsKeyInfo`）移入 `lib/hls-pipeline.js`，content 与 background 两侧仅保留 3 行委托 shim（含替身管线兼容分支）。仍存在的差异是传输层胶水（内容侧浮条+blob 交接 vs 后台 OPFS/offscreen 交接），属两端固有差异，不再强行合并 |
| 4.4 | 国际化 | 引入 `_locales` + `chrome.i18n`，至少补英文（README 已有四语、UI 锁中文，发布商店受限） | ✅ phase A + phase B 完成（phase A：`_locales/zh_CN`（默认）+ `_locales/en` 各 94 key、manifest `default_locale`、`lib/i18n.js`（`t()` 缺 key 退回中文原文并本地替换 $1 占位符 + `applyI18n` 处理 data-i18n 属性）、popup 静态界面与 43 处动态文案、系统通知文案已接入。phase B：内容脚本侧 25 条状态/提示文案已接入——7 个策略文件（HLS/DASH/Bilibili/YouTube 录制与解析/Blob/Generic）内置 `t()` 前置，`lib/i18n.js` 加入 content_scripts 加载顺序，本地 fallback 同样做 `$1..$9` 替换）。phase C（错误文案）：`popup-error-messages` 改为 i18n 感知（14→19 个错误码，新增体积超限/OPFS 写入/取消等；关键词兜底同时支持中英文），策略侧无错误码的抛错文案（画质缺失、无分片、manifest 为空、无自适应集、muxer 未加载、交接失败）也接入 `t()`。`_locales` 各 152 key |
| 4.5 | 死代码清理 | 未引用的 `background/download-strategies/dash-download-strategy.js`、`buildQualityHtml`、重复 labels 常量；同步更新 PRD 与 README 中名不符实的描述 | ✅ 删除 `buildQualityHtml`（恒返回空串）与 `DOWNLOAD_BUTTON_LABELS`、`message-router` 未用的 `formatBytes`；`dash-download-strategy` 已在第三波注册启用；README 四语版本口径修正为 Chrome/Edge 109+ |
| 4.6 | 安全与权限收紧 | postMessage 增加 nonce/握手 token 校验（当前任意网页可伪造 OVD 消息触发带 Cookie 的下载）；收紧 `web_accessible_resources` 对 `<all_urls>` 暴露整个 `lib/*` 与 `injected/*` 的范围；manifest 增加 `minimum_chrome_version`（offscreen 需 109+） | ✅ 页面消息按不可信数据处理（`lib/page-message-guard.js` 类型白名单 + http(s)/blob 协议白名单 + 长度上限，content 与 SW 双层校验）；WAR 收紧为 `injected/*.js` + `lib/message-types.js` + `icons/*`；`minimum_chrome_version: "109"`。注：MAIN world 无法对页面保密，因此不做「共享 token」式校验（可被页面监听窃取），改为限制页面消息能触发的动作面 |
| 4.7 | 文件名健壮性 | `sanitizeFilename` 处理 Windows 保留名（CON/PRN/NUL…）与尾部点/空格；重复文件名冲突策略 | ✅ 保留名加 `_` 前缀、去尾部点/空格（截断后二次处理）、剔控制字符、按码点截断；重名冲突由 `chrome.downloads` 默认 uniquify 处理（已在文档写明） |
| 4.8 | 浏览器矩阵决策 | 明确仅支持 Chromium（README/manifest 声明并移除误导性的 Firefox 检测），或引入 webextension-polyfill + 替代 offscreen 方案真正支持 Firefox | ✅ 决策为仅支持 Chromium：README 四语 + manifest `minimum_chrome_version: 109`；`browser-compat` 移除 `isFirefox`，改为 `isChromium`/`supported` 并在 SW 启动时明确警告；ARCHITECTURE 新增「浏览器矩阵」章节说明放弃 Firefox 的四个硬依赖 |

## 里程碑建议

- **M1（正确性）**：第一波 8 项全部完成，验收标准——任何失败路径都有明确报错，不存在静默产出损坏文件的场景。
- **M2（体验可用）**：第二波完成，验收标准——界面上出现的每个功能都真实生效；下载全流程（检测→选择→进度→完成/失败）用户均有可见反馈。
- **M3（对标 VDH）**：✅ 第三波完成，验收标准——blob/MSE 站点、iframe 嵌入、通用 HLS/DASH 站点可正常探测与下载，画质可选。
- **M4（工程健康）**：第四波完成，验收标准——416 个测试零 skip，muxer/MPD 等高危模块有真实覆盖。

## 与 VDH 差距速查表

| 维度 | VDH | 本项目现状 | 对应修复波次 |
|---|---|---|---|
| 图标徽章 | 检测到的视频数 | 已对齐（第二波 2.4 ✅） | 第二波 2.4 |
| MSE/blob 嗅探 | 核心能力 | 检测到但被丢弃 | 第一波 1.3 |
| iframe 视频 | 支持 | 不支持 | 第一波 1.4 |
| 大文件 | companion app 流式落盘 | 后台 HLS 走 OPFS 流式落盘（≈无内存上限）✅；内容侧/DASH/Bilibili 超限降级为分离文件 ✅ | 第三波 3.7（已完成） |
| 清晰度选择 | 全档位 | YouTube/Bilibili/HLS 均可选 ✅ | 第三波 3.1 |
| 任务管理 | 暂停/取消/队列/黑名单 | 取消 ✅、全局并发队列 ✅、黑名单 ✅；暂停/断点续传仍未做 | 第三波 3.8/3.9 |
| 国际化 | 20+ 语言 | 仅中文 | 第四波 4.4 |
| YouTube/Bilibili | 商店版不支持 YouTube | 深度适配 ✅ 超过 VDH | — |
| 转码依赖 | 需装 companion app | 纯 JS 合并零安装 ✅ | — |
