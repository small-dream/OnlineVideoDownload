<p align="center">
  <img src="icons/icon128.png" alt="Online Video Downloader" width="80" height="80">
  <h1 align="center">Online Video Downloader</h1>
  <p align="center">
    一键检测并下载网页中的在线视频<br>
    <strong>YouTube</strong> · <strong>Bilibili</strong> · <strong>HLS</strong> · <strong>DASH</strong> · <strong>Blob</strong> · <strong>MP4</strong>
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT">
    <img src="https://img.shields.io/badge/Chrome-88%2B-green.svg" alt="Chrome 88+">
    <img src="https://img.shields.io/badge/Manifest-V3-purple.svg" alt="Manifest V3">
  </p>
  <p align="center">
    <strong>中文</strong> · <a href="README_EN.md">English</a> · <a href="README_JA.md">日本語</a> · <a href="README_FR.md">Français</a>
  </p>
</p>

---

## ✨ 核心亮点

- 🎬 **自动检测** — 打开任意网页，自动识别页内所有视频资源，无需手动粘贴链接
- 🏷️ **徽章计数** — 工具栏图标直接显示当前标签页检测到的视频数量，一眼可见
- ☑️ **批量下载** — 多选 / 全选后一键并发下载多个视频
- 🔔 **完成通知** — 下载完成 / 失败推送系统通知，点击通知直接打开所在文件夹
- ⬇️ **一键下载** — 点击下载按钮即可保存视频，操作极简
- 🔀 **浏览器内合并** — YouTube 1080p+、Bilibili DASH 音视频自动合并，**无需安装 ffmpeg 或任何本地工具**
- 🌐 **全平台支持** — YouTube、Bilibili 专项适配，同时支持任意网站的 HLS / DASH / MP4 / Blob 视频
- 🔒 **隐私安全** — 所有数据在本地处理，不上传任何信息到第三方服务器
- 🛡️ **DRM 尊重** — 检测到加密内容时仅标记提示，不尝试绕过保护

---

## 🚀 快速开始（30 秒安装）

> **前提**：你需要有 Chrome 88+ 或 Edge 88+ 浏览器

### 第 1 步：下载代码

```bash
git clone https://github.com/small-dream/OnlineVideoDownload.git
```

或从 [GitHub Releases](../../releases/latest) 下载最新打包好的 ZIP 并解压。

### 第 2 步：加载扩展

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 打开右上角 **「开发者模式」** 开关
3. 点击 **「加载已解压的扩展程序」**
4. 选择项目根目录（包含 `manifest.json` 的文件夹）

✅ 安装完成！工具栏会出现扩展图标。

---

## 📖 使用教程

### 基础用法：下载一个视频

1. **打开包含视频的网页**（比如一个 YouTube 视频页面）
2. 等待视频播放器加载，扩展会自动检测视频资源
3. **点击工具栏的扩展图标**，弹出面板中显示已检测到的视频列表
4. 找到你想下载的视频，点击 **「下载」** 按钮
5. 视频开始下载，底部进度条实时显示下载进度

> 💡 **提示**：安装扩展后，你访问的任何网页中的视频都会被自动检测。只需要点击扩展图标就能看到结果。

### YouTube 下载

| 分辨率 | 下载方式 |
|--------|----------|
| ≤ 720p | 直接下载（含音频的合并流） |
| 1080p+ | 自动下载视频流 + 音频流，浏览器内合并为一个文件 |

- 打开 YouTube 视频页面 → 点击扩展图标 → 选择分辨率 → 下载
- 支持「捕获模式」（直接抓取浏览器已加载的流）和「解析模式」（独立获取流信息）
- 解析模式下可选择分辨率：1080p、720p、480p 等

### Bilibili 下载

- 需要已在浏览器中 **登录 Bilibili 账号**（未登录仅能下载 360P）
- 打开 B 站视频页面 → 点击扩展图标 → 选择清晰度 → 下载
- 支持**自动选择最高可用画质**，也可手动指定清晰度
- 清晰度偏好会记住，下次下载沿用同一选择
- 大会员内容需要大会员账号

### HLS 直播流 / .m3u8 视频

- 对于使用 HLS 协议的直播或点播视频，扩展会自动下载所有 TS 分片
- 在浏览器内合并为一个 `.ts` 文件后保存
- 支持 **AES-128 加密流**的自动解密
- 下载过程中显示分片进度：`已下载 45/120 片`

### Blob URL / MSE 视频

- 部分网站使用 MediaSource API 播放视频（显示为 `blob:` 开头的地址）
- 扩展会自动拦截并捕获这类内存中的视频数据
- 通过 Content Script 中转，实现下载保存

---

## 🎨 视频类型标识

弹出面板中，每种视频类型用不同颜色标识，方便快速识别：

| 标识 | 类型 | 说明 |
|------|------|------|
| 🟢 **MP4** | 直链视频 | 直接下载 |
| 🔴 **HLS** | M3U8 流 | 浏览器内合并分片后下载 |
| 🟡 **DASH** | MPD 流 | 下载 MPD 或合并视音频流 |
| 🔴 **YouTube** | YouTube 视频 | ≤720p 直接下载；1080p+ 自动合并 |
| 🔵 **B站** | Bilibili 视频 | 调用 API 获取流并自动合并 |
| 🟣 **Blob** | MSE 内存视频 | Content Script 中转下载 |
| ⬛ 🔒 **DRM** | 加密保护内容 | 不可下载，仅标记提示 |

---

## 📋 支持的格式与网站

### 通用格式（任意网站）

| 格式 | 说明 |
|------|------|
| MP4 / WebM / FLV / MKV / M4V | 直链视频，一键下载 |
| HLS (.m3u8) | 含 AES-128 加密流的自动解密与合并 |
| DASH (.mpd) | 下载描述文件或合并视音频流 |
| Blob URL | 拦截 MediaSource 创建的内存视频 |

### 专项适配

| 网站 | 适配能力 |
|------|----------|
| **YouTube** | 合并流 + 自适应流；SPA 路由感知；多分辨率选择 |
| **Bilibili** | WBI 签名；DASH/FLV 双格式；分P视频；清晰度选择；CDN Referer 注入 |

### 已知不支持

- **DRM 加密内容**（Netflix、Disney+ 等）— Widevine/PlayReady 保护，扩展无法获取解密数据
- **未登录的付费内容** — 请先登录对应网站账号

---

## 🏗️ 技术架构

```
Chrome Extension (Manifest V3)
│
├── background/                    Service Worker 进程
│   ├── service-worker.js          消息路由 + 下载完成监听 + 合并触发
│   ├── video-registry.js          已检测视频内存注册表
│   ├── request-interceptor.js     webRequest 网络请求监听
│   ├── downloader.js              下载调度器（MP4/HLS/DASH/YouTube/B站）
│   ├── hls-fetcher.js             HLS 分片下载、AES 解密、内存合并
│   └── header-injector.js         请求头注入
│
├── content/                       Content Script（可访问 DOM）
│   ├── content-main.js            入口：注入页面脚本 + 组装策略
│   ├── message-router.js          popup / background / page 三端消息路由
│   ├── progress-reporter.js       页面内任务进度上报
│   └── strategies/                各平台下载策略
│
├── injected/                      页面真实上下文脚本
│   ├── page-context-script.js     主控脚本
│   ├── page-interceptor.js        XHR / Fetch / MediaSource / DRM Hook
│   ├── page-youtube-parser.js     YouTube 流解析
│   ├── page-bilibili-parser.js    Bilibili 流解析
│   └── page-http-utils.js         页面内 HTTP 工具
│
├── lib/                           共享工具库
│   ├── hls-pipeline.js            HLS 解析与处理管线
│   ├── mpd-parser.js              DASH MPD 解析器
│   ├── wbi-signer.js              Bilibili WBI 签名算法
│   ├── bilibili-muxer.js          Bilibili FLV 封装
│   ├── mp4-muxer.js               MP4 封装
│   └── ...                        其他工具模块
│
└── popup/                         扩展弹出面板 UI
    ├── popup.html
    ├── popup.js
    └── popup.css
```

更详细的接口文档请参阅 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## ❓ 常见问题

<details>
<summary><strong>弹出面板没有检测到视频？</strong></summary>

- 确认该页面有视频资源（当前版本已支持 iframe 嵌入视频检测；若 CSP 严格的页面仍无结果，可能是注入被拦截，可等待后续版本优化）
- 尝试刷新页面后重新检测
- 按 F12 打开开发者工具 → Console，检查是否有 `[OVD]` 前缀的错误信息

</details>

<details>
<summary><strong>YouTube 只能下载 720p？</strong></summary>

- 720p 及以下为包含音频的合并流，可直接下载
- 1080p 及以上需要自动抓取分离的视频流 + 音频流，并在浏览器内合并
- 确保网络稳定，合并过程需要完整下载两路流

</details>

<details>
<summary><strong>合并失败怎么办？</strong></summary>

- 刷新页面后重试，确认网络稳定
- 按 F12 → Console，查看 `[OVD]` 前缀的错误日志
- 若仅特定视频失败，可能是源站流格式异常或临时不可用
- YouTube / Bilibili 抓流支持自动重试，源站支持 `Range` 时可从断点续传

</details>

<details>
<summary><strong>Bilibili 下载失败？</strong></summary>

- 确认已登录 Bilibili 账号
- 手动选择的清晰度不可用时，扩展会自动回退到最高可用画质
- B 站 API 签名算法可能随版本更新变化，如持续失败请提交 Issue

</details>

<details>
<summary><strong>下载的 HLS 文件怎么播放？</strong></summary>

- `.ts` 文件可用 VLC、PotPlayer、mpv 直接播放
- 也可用 ffmpeg 转换：`ffmpeg -i input.ts -c copy output.mp4`

</details>

---

## 🤝 参与贡献

欢迎提交 Issue 和 Pull Request！请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境设置和代码规范。

```bash
# 克隆项目
git clone https://github.com/small-dream/OnlineVideoDownload.git

# 运行测试
npm test
```

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。

---

## ⚠️ 免责声明

本工具仅供学习和个人使用。请遵守你所在地区的法律法规以及各视频平台的服务条款，仅下载你有权访问的内容。作者不对任何滥用行为承担责任。
