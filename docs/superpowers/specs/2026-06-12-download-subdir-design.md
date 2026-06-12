# 下载子目录设置 — 设计文档

**日期**: 2026-06-12
**状态**: 已批准

---

## 概述

新增 `downloadSubdir` 设置项，允许用户配置视频下载的子目录。该子目录相对于 Chrome 默认下载目录，所有下载策略统一读取并拼接。

- **默认值**: `OnlineVideoDownload`
- **清空时**: 直接下载到 Chrome 默认下载目录（不创建子目录）

---

## 改动清单

### 1. `lib/settings-store.js` — 新增设置项

在 `DEFAULT_SETTINGS` 中新增：

```js
downloadSubdir: 'OnlineVideoDownload'
```

### 2. `background/downloader.js` — 拼接子目录前缀

在 `_buildFilenameBase` 方法中：

1. 通过 `settingsStore.getSettings()` 读取 `downloadSubdir`
2. 规范化路径：去除首尾斜杠/反斜杠，将 `\` 替换为 `/`
3. 拼接到文件名前：`dir + '/' + filenameBase`

这样所有通过 `submitDirectDownload` 的下载都会带上子目录前缀。

**引入 settingsStore**: 文件顶部需引入 `lib/settings-store.js`（ES Module 方式 import 并使用 `globalThis.__OVD_GENERAL_SETTINGS_STORE__`）。

### 3. `background/service-worker.js` — `downloadBlobData` 同步处理

`downloadBlobData` 函数也直接调用 `chrome.downloads.download()`，需要在调用前同样读取 `downloadSubdir` 并拼接到 filename 前。

### 4. `popup/popup.html` — 新增设置行

在 settings-list 中新增文本输入行：

```html
<label class="settings-row">
  <span>下载目录</span>
  <input type="text" id="popupDownloadSubdir" placeholder="留空为默认目录">
</label>
```

### 5. `popup/popup.js` — 设置读取与保存

- `populatePopupSettings`: 读取 `settings.downloadSubdir` 填入输入框
- `wirePopupSettings` controls 数组: 新增条目，`readValue` 回调中过滤不合法字符（`\ : * ? " < > |`）

### 6. CSS 无需改动

`popup.css` 中 `.settings-row input[type="text"]` 无现有样式，复用 number/select 的样式即可。需新增一条规则。

---

## 输入校验

子目录名在保存时过滤以下字符：`\ : * ? " < > |`。这是 Windows/macOS/Linux 文件名的通用非法字符。

---

## 文档同步

根据 CLAUDE.md 要求，需同步更新：
- `docs/PRD.md` — 新增下载目录设置功能描述
- `docs/ARCHITECTURE.md` — 更新 DEFAULT_SETTINGS、Downloader._buildFilenameBase 接口

---

## 未覆盖

- 不支持绝对路径（Chrome API 限制）
- 不支持按视频源分目录（YAGNI）
- 不支持每次下载时弹窗选择目录
