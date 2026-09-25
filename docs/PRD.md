# Online Video Downloader 产品需求文档

> **版本**：1.16.0
> **最后更新**：2026-09-25
> **维护要求**：修改功能、下载策略、运行时分工或消息模型后，必须同步更新本文档与 `docs/ARCHITECTURE.md`。

---

## 1. 产品概述

Online Video Downloader 是一个 Manifest V3 浏览器扩展，用于检测并下载网页中的在线视频。

设计原则：

- 零宿主依赖：核心下载与合并能力尽量在浏览器内完成。
- 本机处理优先：不上传用户数据，不依赖远程执行。
- 页面低侵入：识别结果和进度集中在扩展 Popup；仅在执行长任务（HLS、录制等）时于页面右下角显示一条小型浮动反馈条，不遮挡页面内容。
- 不绕过 DRM：检测到受保护内容时给出提示，但不尝试解密。

---

## 2. 支持范围

当前支持的下载类型：

| 类型 | 说明 |
| --- | --- |
| `direct` | 普通直链 MP4 / WebM / FLV / MKV / M4V |
| `audio` | 音乐直链下载：MP3 / FLAC / OGA / OGG / M4A / AAC / WAV |
| `hls` | `.m3u8` HLS 流，支持 Master Playlist 与 AES-128 |
| `dash` | DASH 流，完整 MPD 解析与页面内音视频合并 |
| `youtube-adaptive` | YouTube 自适应流与页面录制下载 |
| `bilibili-meta` | Bilibili 元数据入口，通过页面 API 获取真实流 |
| `blob` | 由页面创建的 blob URL 视频 |
| `drm-detected` | 仅提示，不下载 |

来源归属：

- YouTube、Bilibili、blob 主要走 content / page 侧能力。
- 直链、部分 DASH 主要走 background。
- HLS 优先在 content（页面上下文）抓取：请求继承页面 Origin / Sec-Fetch / Referer / Cookie，规避 CDN 对扩展后台裸请求的 403 拦截；content 不可用或失败时回退到 service worker 抓取。

---

## 3. 检测与展示

视频检测来源：

- 网络请求拦截
- 页面注入脚本对 XHR / Fetch 的监听页面
- `<video>` / `<source>` / `<audio>` 扫描
- MediaSource / blob URL 捕获
- SPA 路由变化感知

UI 要求：

- Popup 显示当前页面已检测视频列表
- 支持从 Popup 发起下载
- 支持显示视频标题、格式标签、时长、大小、缩略图与进度
- Popup 视频条目采用卡片式布局，左侧展示视频缩略图
- Popup 中的 YouTube 条目支持在设置中切换下载模式（录制模式 / 解析下载），解析下载模式下可在条目中选择分辨率
- Popup 从内容侧发起下载时，条目按钮应保持”进行中”状态直到收到完成或失败结果，避免用户误以为任务未启动并重复点击
- 支持批量选择多个视频，从 Popup 一键并发下载
- 下载中的条目按钮直接显示百分比（「下载中 N%」）
- 工具栏图标徽章按当前标签页显示检测到的视频数（>99 显示 99+），运行中任务数显示在 Popup「任务」按钮徽章上
- 下载完成/失败推送系统通知（可在设置中通过 `downloadNotification` 关闭），点击通知打开下载所在文件夹
- 错误提示使用中文友好文案（错误码映射 + 关键词兜底），不直接透传原始错误信息
- Popup 采用浅色主题设计，宽度 560px，高度 460px

---

## 4. 下载行为

### 4.1 直链下载

- 使用浏览器下载能力提交任务
- 注入必要请求头，如 `Referer`
- 支持进度回传到页面与 Popup
- 音频条目复用直链下载策略，但在检测、标签与文件名推断层按 `audio` 类型独立处理

### 4.2 HLS 下载

- 解析 Master Playlist 并选择最优流
- 解析媒体分片列表与 `#EXT-X-MAP`
- 支持 `#EXT-X-KEY` 的 AES-128 解密
- 合并分片后触发单文件下载
- 运行时优先委托 content（页面上下文）抓取，携带页面 Cookie 与来源信息；content 无响应或失败时自动回退到 service worker 抓取
- 携带 Cookie 的跨域请求若被目标站 CORS 拒绝，自动退化为默认凭证模式重试
- HLS 解析、解密、URL 处理逻辑必须复用统一的共享 pipeline

### 4.3 DASH 下载

- 完整 MPD manifest 解析，支持多 Period、多 AdaptationSet、多 Representation
- 选择最优视频与音频 Representation
- 页面内使用 BilibiliMuxer 进行 fMP4 音视频合并
- 可继续由页面侧执行浏览器内合并的来源，优先保留页面侧方案
- 通用 background DASH 标记为不支持，委托给 content 侧处理

### 4.4 YouTube 下载

- 保持现有页面录制下载能力
- 新增解析下载模式，允许用户在设置中切换：
  - 录制模式
  - 解析下载模式
  - 解析下载模式下可在视频条目中选择可用分辨率
- 解析下载模式优先使用页面已解析的可下载流
- 当高分辨率流仅存在 `signatureCipher` 时，Popup 仍应展示对应分辨率，并标记为“待签名解析”
- 页面侧应在必要时尝试额外的 YouTube player fallback 请求，以补全高分辨率可下载直链
- 当页面已暴露自适应视频或音频轨道、但缺少可用直链时，页面侧也应自动触发一次 YouTube Android fallback，并输出明确的触发原因与结果日志
- 当视频与音频为分离流时，必须在浏览器内抓取并自动合并为单个 MP4
- 当解析下载的自适应视音频总量过大、不适合浏览器内合并时，应提前失败并明确提示用户改用更低清晰度或录制模式，而不是长时间无反馈
- 当解析下载进入页面侧视音频抓取阶段时，Popup 应持续显示抓取进度；若抓流失败，也应尽快暴露明确错误，而不是停留在“无反应”
- 下载过程中可临时静音当前标签页，完成后恢复
- 录制与页面内抓流都属于 content / page 侧能力，不应混入 background 大型条件分支
- 默认行为仍保持录制模式，避免影响现有页面内下载链路

### 4.5 Bilibili 下载

- 使用页面上下文可用的 Cookie 请求播放地址
- 必须通过 WBI 签名构造受保护接口请求
- DASH 流在浏览器内抓取并合并为单个 MP4
- FLV / MP4 直链可退化为 background 直链下载
- 合并后的文件优先通过浏览器下载 API 保存，若保存失败则降级为页面内 blob 触发下载

### 4.6 Blob 下载

- content script 读取 blob URL
- 在页面内重新创建可下载对象并触发浏览器保存

### 4.7 批量下载

- Popup 视频列表支持多选复选框
- 提供"全选"与"取消全选"操作
- 选中的视频可一键并发下载
- 下载队列控制最大并发数，从用户设置中读取
- 批量下载状态实时反映在各条目的进度中
- DRM 保护的条目不可勾选，不参与批量下载
- 列表头部提供「全选/取消全选」与「下载所选 (N)」按钮，N 为当前已选数量

### 4.8 设置页面

- 设置界面内置在 Popup 中
- 设置界面包含所有可配置选项（并发下载数、下载目录、历史保留天数等）
- 使用 `lib/settings-store.js` 统一读写设置，所有运行时通过共享 store 保持一致
- 支持 `chrome.storage.local` 持久化

### 4.9 下载历史

- 使用 `chrome.storage.local` 持久化下载记录
- 最多保留 100 条历史记录
- 每条记录包含标题、URL、下载时间、文件大小、下载 ID 等信息
- 支持按保留天数自动清理过期记录
- 支持手动清除全部历史
- 支持删除单条历史记录（每行右侧删除按钮）
- 在 Popup 的下载历史界面中展示
- 下载完成时自动写入历史记录
- 新增记录时自动去重合并：按 `downloadId`、文件路径、URL + 时间窗口（2 分钟内）、CJK 相似标题匹配检测重复，合并为同一条记录
- 历史记录支持点击打开下载文件所在文件夹（需要该记录包含浏览器下载 ID）

---

## 5. 运行时结构要求

以下是当前产品实现要求，不是可选建议：

- `content/content-main.js` 只负责装配，不再承载大段来源逻辑。
- 每个内容来源应有独立 strategy 文件。
- 所有 Map 型传输状态必须集中在统一的 transfer manager。
- 下载启动、去重和生命周期消息必须由统一 coordinator 管理。
- 页面消息和 background 消息的 switch 路由必须集中到独立 message router。
- Bilibili WBI 签名与 HLS pipeline 必须位于 `lib/` 共享层，避免重复实现。
- background `Downloader` 只保留编排能力，不再维护具体下载分支的大量私有方法。

---

## 6. 进度与状态反馈

| 场景 | 展示位置 | 数据来源 |
| --- | --- | --- |
| 直链下载 | 视频条目级进度 | `chrome.downloads.onChanged` |
| HLS 下载 | 全局进度 | 已完成分片数 / 总分片数 |
| 页面内合并 | 全局进度与状态文案 | muxer 回调 |
| 来源下载生命周期 | Popup 状态提示 | `SOURCE_DOWNLOAD_STARTED` / `SOURCE_DOWNLOAD_RESULT` |
| 页面内抓流 / 录制 | Popup 全局进度与状态文案 | `SOURCE_DOWNLOAD_PROGRESS` / `SOURCE_DOWNLOAD_STATUS` |
| 下载中任务 | 条目按钮百分比（「下载中 N%」） | background 广播进度 |
| 长任务（HLS / 录制等） | 页面右下角浮动反馈条（Popup 关闭后仍可见） | `content/float-button.js` |
| 下载完成 / 失败 | 系统通知（设置 `downloadNotification` 控制） | `background/download-notification.js` |
| 错误提示 | Popup 友好文案（错误码映射 + 关键词兜底） | `popup/popup-error-messages.js` |

兼容性要求：

- 保留 YouTube / Bilibili 旧消息名兼容层
- 统一生命周期消息作为主协议

---

## 7. 非功能要求

- 不上传用户视频数据或页面私密数据
- 不加载远程代码
- 不尝试绕过 Widevine / PlayReady 等 DRM
- 支持 Chrome / Edge 的 Manifest V3 运行环境
- 模块拆分后仍需保持原有下载行为不变

已知限制：

- DRM 内容不可下载
- Bilibili 高质量内容可能依赖登录态
- YouTube `signatureCipher` 复杂场景仍可能受限
- HLS 下载在页面上下文执行，关闭标签页会中断任务；content 不可用时自动回退到 service worker，部分 CDN 会对后台裸请求返回 403

---

## 8. 版本历史

| 版本 | 日期 | 变更摘要 |
| --- | --- | --- |
| 1.16.0 | 2026-09-25 | 接通 `notifications` 权限：下载完成/失败按设置（`downloadNotification`）弹出系统通知，含文件名与大小，点击通知打开下载所在文件夹；`filenameFormat` 命名规则生效（标题 / 标题+画质 / 标题+日期，画质后缀取分辨率或平台清晰度）；图标徽章改为按标签页显示检测到的视频数（>99 显示 99+，tab 关闭/清理/注册表恢复时同步刷新），运行中任务数改由 Popup 任务视图展示；恢复页面内长任务浮动反馈条（右下角小条，文本消息 4 秒自动消失、进度百分比、同一时间一条，Popup 关闭后仍可见）；`CLEAR_TAB_VIDEOS` 明确 popup 来源（无 sender.tab）走整 tab 清理、子框架仅清该 frame 的语义，「清列表」同时清空 background 的 VideoRegistry 且不再被旧消息重新填满；批量下载 UI 恢复：条目复选框可见、列表头部全选（含半选态）与「下载所选 (N)」按钮、并发数读取 `concurrentDownloadLimit`、DRM 条目不可勾选；下载中条目按钮显示「下载中 N%」百分比；错误提示改为中文友好文案（`popup-error-messages.js`，15 个错误码映射 + 关键词兜底，如 B 站未登录提示）。 |
| 1.15.0 | 2026-09-24 | HLS 下载改为优先在页面上下文（content）执行：携带页面 Cookie/Origin/Referer 以规避 CDN（如 Cloudflare WAF）对扩展后台裸请求的 403 拦截，content 不可用或失败时回退到 service worker；委托下载回传真实 downloadId，DNR 规则按页面来源回显 CORS 响应头。 |
| 1.14.0 | 2026-06-12 | 新增下载目录设置：支持配置子目录名（相对于 Chrome 默认下载目录），默认 `OnlineVideoDownload`。 |
| 1.13.0 | 2026-06-12 | 移除独立 Options Page 与 `options_ui` 注册，设置和下载历史统一在 Popup 内管理。 |
| 1.12.0 | 2026-06-12 | 下载历史支持单条删除（每行右侧删除按钮）和清空全部历史。 |
| 1.11.0 | 2026-05-30 | Popup 简化：移除标题前的平台标签（YouTube/Bilibili 等）、移除"最高 Xp"质量徽章；YouTube 下载模式选择（录制/解析）统一移至设置页，解析模式下视频条目仅保留分辨率选择器。 |
| 1.10.0 | 2026-05-30 | Popup UI 重设计为浅色主题卡片式布局，视频条目展示缩略图；新增下载历史去重合并（按 downloadId / 文件路径 / URL+时间窗口 / CJK 相似标题）；新增历史记录点击打开下载文件夹；Bilibili DASH 合并结果改用浏览器下载 API 保存；YouTube / Bilibili 解析器新增 thumbnail 字段提取。 |
| 1.9.0 | 2026-05-29 | 新增 DASH 完整 MPD 解析与页面内音视频合并；新增批量下载（多选、全选、并发队列）；新增设置与历史界面；新增下载历史持久化（100 条上限、自动清理、手动清除）。 |
| 1.8.0 | 2026-05-28 | 移除页面浮动按钮与浮动弹窗，识别视频列表和下载进度统一由 Popup 展示；页面侧任务通过统一进度消息上报。（注：页面内浮动反馈条已于 1.16.0 以右下角小型进度条形式恢复。） |
| 1.7.6 | 2026-04-06 | 集中共享消息类型常量，并修复 Popup 中内容侧下载条目会过早恢复为可点击状态的问题；现在会持续显示进行中，直到任务完成或失败。 |
| 1.7.5 | 2026-04-06 | 修复 YouTube 页面上音频流被错误识别为大量独立 MP3 的问题，googlevideo.com 媒体流现在统一由 YouTube 解析器处理。 |
| 1.7.4 | 2026-04-05 | 新增在线音频下载能力：支持 `audio` 类型检测、`<audio>` 元素扫描、Music 标签展示，并复用现有直链下载策略保存为音乐文件。 |
| 1.6.3 | 2026-04-04 | 为 YouTube 解析下载补充页面抓流进度反馈：页面侧分块读取并上报进度，Popup 在抓取阶段持续显示百分比与已接收体积。 |
| 1.6.2 | 2026-04-04 | 为 YouTube 解析下载补充大文件保护：当自适应视音频预计体积过大时提前失败，并提示改用更低清晰度或录制模式。 |
| 1.6.1 | 2026-04-04 | 补充 YouTube 解析下载的 fallback 触发条件：当自适应流缺少可用直链时自动发起 Android fallback，并要求输出明确的触发原因与结果日志。 |
| 1.6.0 | 2026-04-04 | 新增 YouTube 多模式下载：Popup 可选择录制模式或解析下载模式，并支持按可用分辨率选择、待签名解析清晰度提示、页面 fallback 抓流、浏览器内音视频合并与详细调试日志。 |
| 1.5.0 | 2026-04-04 | 明确内容侧拆分为 strategy、transfer manager、coordinator、message router，并将 WBI signer 与 HLS pipeline 上提为共享层；background Downloader 改为轻量编排器。 |
| 1.4.0 | 2026-04-02 | 稳定现有下载能力与统一生命周期消息，移除本地宿主依赖。 |
| 1.0.0 | 2026-03-30 | 初始版本：检测、直链/HLS/DASH/YouTube/Bilibili 下载、UI、Popup、进度显示。 |
