<p align="center">
  <img src="icons/icon128.png" alt="Online Video Downloader" width="80" height="80">
  <h1 align="center">Online Video Downloader</h1>
  <p align="center">
    Detect and download online videos from any webpage with one click<br>
    <strong>YouTube</strong> · <strong>Bilibili</strong> · <strong>HLS</strong> · <strong>DASH</strong> · <strong>Blob</strong> · <strong>MP4</strong>
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT">
    <img src="https://img.shields.io/badge/Chrome-88%2B-green.svg" alt="Chrome 88+">
    <img src="https://img.shields.io/badge/Manifest-V3-purple.svg" alt="Manifest V3">
  </p>
  <p align="center">
    <a href="README.md">中文</a> · <strong>English</strong> · <a href="README_JA.md">日本語</a> · <a href="README_FR.md">Français</a>
  </p>
</p>

---

## ✨ Highlights

- 🎬 **Auto Detection** — Automatically identifies all video resources on any page, no need to paste URLs
- 🏷️ **Badge Counter** — The toolbar icon shows the number of videos detected on the current tab at a glance
- ☑️ **Batch Download** — Multi-select / select-all and download several videos concurrently in one click
- 🔔 **Completion Notifications** — System notifications on download completion/failure; click a notification to open its folder
- ⬇️ **One-Click Download** — Save videos with a single click, dead simple
- 🔀 **In-Browser Merging** — YouTube 1080p+ and Bilibili DASH audio/video streams are merged in the browser — **no ffmpeg or local tools required**
- 🌐 **Broad Compatibility** — Specialized support for YouTube and Bilibili, plus HLS / DASH / MP4 / Blob videos from any website
- 🔒 **Privacy First** — All processing happens locally, no data is ever sent to third-party servers
- 🛡️ **DRM Respect** — Encrypted content is flagged but never bypassed

---

## 🚀 Quick Start (30 seconds)

> **Prerequisites**: Chrome 88+ or Edge 88+

### Step 1: Get the code

```bash
git clone https://github.com/small-dream/OnlineVideoDownload.git
```

Or download and extract the ZIP.

### Step 2: Load the extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the project root directory (the one with `manifest.json`)

✅ Done! The extension icon appears in your toolbar.

---

## 📖 Usage Guide

### Basic: Download a video

1. **Open a page with a video** (e.g., a YouTube video page)
2. Wait for the video player to load — the extension detects videos automatically
3. **Click the extension icon** in the toolbar to see all detected videos
4. Find the video you want and click **Download**
5. The progress bar at the bottom shows real-time download status

> 💡 **Tip**: After installing the extension, any video on any page you visit is automatically detected. Just click the icon to see what's available.

### YouTube downloads

| Resolution | How it works |
|-----------|---------------|
| ≤ 720p | Direct download (combined stream with audio) |
| 1080p+ | Automatically downloads video + audio streams and merges them in the browser |

- Open a YouTube video → click the extension icon → choose resolution → download
- Supports **Capture mode** (grab browser-loaded streams) and **Parse mode** (fetch stream info independently)
- In Parse mode you can select resolution: 1080p, 720p, 480p, etc.

### Bilibili downloads

- Requires being **logged into a Bilibili account** in the browser (unauthenticated users can only download 360P)
- Open a Bilibili video → click the extension icon → choose quality → download
- **Auto-selects highest available quality**, or manually choose a specific quality
- Your quality preference is saved for future downloads
- Premium content requires a premium account

### HLS streams / .m3u8 videos

- For live streams or VOD using HLS, the extension automatically downloads all TS segments
- Segments are merged in the browser into a single `.ts` file
- Multi-bitrate masters expose a **quality dropdown** (pick any variant; defaults to the highest)
- Supports automatic decryption of **AES-128 encrypted streams** (including key rotation), `EXT-X-BYTERANGE` segments, and `EXT-X-MEDIA` separate audio tracks (muxed into the video)
- Live playlists without `ENDLIST` warn that only the current playback window is saved, instead of silently writing a truncated file
- Streams over 1.5 GB abort with a clear message instead of risking an out-of-memory merge
- Shows segment progress during download: `Downloaded 45/120 segments`

### Blob URL / MSE videos

- Some websites use MediaSource API for playback (URLs starting with `blob:`)
- The extension intercepts and captures this in-memory video data
- Download is handled via Content Script relay

---

## 🎨 Video Type Labels

The popup panel uses color-coded labels for quick identification:

| Label | Type | Description |
|-------|------|-------------|
| 🟢 **MP4** | Direct link | Direct download |
| 🔴 **HLS** | M3U8 stream | Browser merges segments then downloads |
| 🟡 **DASH** | MPD stream | Download MPD or merge audio/video |
| 🔴 **YouTube** | YouTube video | ≤720p direct; 1080p+ auto-merge |
| 🔵 **B站** | Bilibili video | API fetch + auto-merge |
| 🟣 **Blob** | MSE in-memory | Content Script relay download |
| ⬛ 🔒 **DRM** | Encrypted content | Cannot download, flagged only |

---

## 📋 Supported Formats & Sites

### Universal formats (any website)

| Format | Description |
|--------|-------------|
| MP4 / WebM / FLV / MKV / M4V | Direct link, one-click download |
| HLS (.m3u8) | Including AES-128 encrypted stream decryption and merging |
| DASH (.mpd) | Download manifest or merge audio/video streams |
| Blob URL | Intercept MediaSource in-memory videos |

### Specialized support

| Site | Capabilities |
|------|-------------|
| **YouTube** | Combined + adaptive streams; SPA routing awareness; multi-resolution selection |
| **Bilibili** | WBI signing; DASH/FLV dual format; multi-part videos; quality selection; CDN Referer injection |

### Known limitations

- **DRM-encrypted content** (Netflix, Disney+, etc.) — Widevine/PlayReady protection prevents access to decrypted data
- **Paid content without login** — Please log into the respective website first

---

## 🏗️ Architecture

```
Chrome Extension (Manifest V3)
│
├── background/                    Service Worker
│   ├── service-worker.js          Message routing + download completion + merge trigger
│   ├── video-registry.js          Detected videos in-memory registry
│   ├── request-interceptor.js     webRequest network listener
│   ├── downloader.js              Download scheduler (MP4/HLS/DASH/YouTube/Bilibili)
│   ├── hls-fetcher.js             HLS segment download, AES decryption, in-memory merge
│   └── header-injector.js         Request header injection
│
├── content/                       Content Script (DOM access)
│   ├── content-main.js            Entry point: inject page scripts + strategy assembly
│   ├── message-router.js          popup / background / page message routing
│   ├── progress-reporter.js       In-page task progress reporting
│   └── strategies/                Per-platform download strategies
│
├── injected/                      Page context scripts
│   ├── page-context-script.js     Main controller
│   ├── page-interceptor.js        XHR / Fetch / MediaSource / DRM hooks
│   ├── page-youtube-parser.js     YouTube stream parser
│   ├── page-bilibili-parser.js    Bilibili stream parser
│   └── page-http-utils.js         In-page HTTP utilities
│
├── lib/                           Shared utility library
│   ├── hls-pipeline.js            HLS parsing and processing pipeline
│   ├── mpd-parser.js              DASH MPD parser
│   ├── wbi-signer.js              Bilibili WBI signing algorithm
│   ├── bilibili-muxer.js          Bilibili FLV muxer
│   ├── mp4-muxer.js               MP4 muxer
│   └── ...                        Other utility modules
│
└── popup/                         Extension popup UI
    ├── popup.html
    ├── popup.js
    └── popup.css
```

For detailed interface documentation, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## ❓ FAQ

<details>
<summary><strong>No videos detected in the popup?</strong></summary>

- Make sure the page actually has video content (iframe-embedded videos are supported since v1.16.0; on pages with strict CSP the injection may still be blocked)
- Try refreshing the page and detecting again
- Press F12 → Console and check for errors with the `[OVD]` prefix

</details>

<details>
<summary><strong>YouTube only downloads 720p?</strong></summary>

- 720p and below are combined streams that include audio — direct download
- 1080p+ requires downloading separate video + audio streams and merging them in the browser
- Make sure your network is stable; merging requires both streams to be fully downloaded

</details>

<details>
<summary><strong>Merge failed?</strong></summary>

- Refresh the page and try again; ensure your network is stable
- Press F12 → Console and check for `[OVD]` error logs
- If only specific videos fail, the source stream format may be unusual or temporarily unavailable
- YouTube / Bilibili streaming supports automatic retry; if the server supports `Range`, it can resume from where it left off

</details>

<details>
<summary><strong>Bilibili download failed?</strong></summary>

- Make sure you're logged into a Bilibili account
- If your chosen quality is unavailable, the extension auto-falls back to the highest available quality
- Bilibili's API signing algorithm may change with updates — if failures persist, please file an Issue

</details>

<details>
<summary><strong>How to play downloaded HLS files?</strong></summary>

- `.ts` files can be played directly with VLC, PotPlayer, or mpv
- Or convert with ffmpeg: `ffmpeg -i input.ts -c copy output.mp4`

</details>

---

## 🤝 Contributing

Issues and Pull Requests are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and code conventions.

```bash
# Clone the project
git clone https://github.com/small-dream/OnlineVideoDownload.git

# Run tests
npm test
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

---

## ⚠️ Disclaimer

This tool is for educational and personal use only. Please comply with the laws and regulations of your jurisdiction and the terms of service of each video platform. Only download content you have the right to access. The author is not responsible for any misuse.
