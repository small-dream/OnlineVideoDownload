# Online Video Downloader — AI 协作规则

本文件定义了 AI（Claude）在此项目中工作时必须遵守的规则。

---

## 文档同步规则（MANDATORY）

**任何代码修改完成后，必须同步更新相关文档。这是强制要求，不得跳过。**

### 需要同步更新 `docs/PRD.md` 的变更

- 新增或删除功能
- 修改 UI 交互行为（悬浮按钮、面板、进度显示等）
- 修改支持的视频格式类型
- 修改下载行为或下载策略
- 修改安装流程或系统要求

### 需要同步更新 `docs/ARCHITECTURE.md` 的变更

- 修改任何文件的类/方法接口签名
- 修改消息类型（新增/删除/修改字段）—— 必须更新第 3 节消息类型全览
- 修改数据结构（`VideoInfo`、`MergeJob` 等）
- 修改文件职责或添加新文件
- 修改关键算法（YouTube 计划选择、Bilibili WBI 签名、HLS 解密等）
- 修改进程间通信方式
- 修改 Chrome API 使用方式

### 更新格式要求

- 在文档对应章节就地修改，不要在文末追加
- 更新文档顶部的**最后更新**日期
- 若新增功能，同时在两份文档的**版本历史**章节追加记录

---

## 项目约定

### 代码风格

- ES Module（`import/export`），Service Worker 使用 `type: "module"`
- 类和方法注释使用中文
- 调试日志前缀：`[OVD]`（content script）、`[HLS]`（hls-fetcher）

### 消息命名约定

- 从页面上下文 postMessage 到 content script：`OVD_PAGE_SCRIPT` 来源标识
- content script ↔ SW 的消息 type：`全大写_下划线`（如 `VIDEO_DETECTED`）
- SW 广播到 UI 的消息 type：`全大写_下划线`（如 `DOWNLOAD_PROGRESS`）

### 安全约定

- 不尝试绕过 DRM（Widevine/PlayReady）
- 不加载远程代码
- 用户输入（标题）在写入 HTML 时必须 `escapeHtml`

### 文件结构约定

- background/ — Service Worker 进程代码，只能使用 SW API
- content/ — Content Script，可访问 DOM，不能访问 `window.*`（页面变量）
- injected/ — 注入页面真实上下文的脚本，通过 postMessage 通信
- popup/ — 扩展图标弹出面板
- test/ — 单元测试

---

## 单元测试规则（MANDATORY）

**使用 Node.js 内置测试运行器（`node:test` + `node:assert/strict`），不引入第三方测试框架。**

### 运行测试

```bash
npm test          # 运行全部测试
node --test       # 等效
node --test test/xxx.test.js  # 运行单个测试文件
```

### 测试编写规范

- 测试文件放在 `test/` 目录，命名为 `<module-name>.test.js`
- IIFE 模块（`lib/`、`content/`）通过 `require()` 加载，访问 `globalThis.__OVD_*__`
- ES Module（`background/`）通过动态 `import()` 加载
- 每个 IIFE 测试文件使用 `loadModule` 模式避免重复加载冲突：

```javascript
const path = require('node:path');
function loadModule(globalKey, filePath) {
  delete globalThis[globalKey];
  delete require.cache[require.resolve(filePath)];
  require(filePath);
  return globalThis[globalKey];
}
```

- 需要 `chrome` API 的模块（settings-store、download-history-store）用简单 mock 替代
- 需要 DOM 的模块（ui-dom-utils）用最小 mock 元素替代

### 测试覆盖要求

**修改任何模块后，必须确保对应测试通过，新增公共函数必须补充测试。**

当前测试覆盖的模块：

| 模块 | 测试文件 |
| ------ | ------- |
| lib/byte-utils.js | test/byte-utils.test.js |
| lib/http-utils.js | test/http-utils.test.js |
| lib/message-types.js | test/message-types.test.js |
| lib/video-utils.js | test/video-utils.test.js |
| lib/video-source-utils.js | test/video-source-utils.test.js |
| lib/constants.js | test/constants.test.js |
| lib/bilibili-quality-utils.js | test/bilibili-quality-utils.test.js |
| lib/youtube-stream-utils.js | test/youtube-stream-utils.test.js |
| lib/hls-pipeline.js | test/hls-pipeline.test.js |
| lib/wbi-signer.js | test/wbi-signer.test.js |
| lib/mpd-parser.js | test/mpd-parser.test.js |
| lib/settings-store.js | test/settings-store.test.js |
| lib/ui-dom-utils.js | test/ui-dom-utils.test.js |
| content/progress-reporter.js | test/progress-reporter.test.js |
| content/source-handlers.js | test/source-handlers.test.js |
| background/download-history-store.js | test/download-history-store.test.js |
| background/download-state-store.js | test/download-state-store.test.js |

---

## 上下文文档

开始工作前，先阅读以下文档获取完整上下文：

1. [docs/PRD.md](docs/PRD.md) — 产品功能需求
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 技术架构与接口文档
3. [manifest.json](manifest.json) — 扩展清单（权限、入口）

如需了解具体实现细节，再按需阅读对应源文件。
