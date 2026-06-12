# 贡献指南

感谢你对 Online Video Downloader 项目的关注！欢迎提交 Issue 和 Pull Request。

## 开发环境设置

1. 克隆仓库
2. 打开 Chrome，访问 `chrome://extensions`
3. 开启**开发者模式**
4. 点击**加载已解压的扩展程序**，选择项目根目录

## 代码风格

- 使用 ES Module（`import/export`），Service Worker 使用 `type: "module"`
- 类和方法注释使用中文
- 调试日志前缀：`[OVD]`（content script）、`[HLS]`（hls-fetcher）

## 项目结构

- `background/` — Service Worker 进程代码，只能使用 SW API
- `content/` — Content Script，可访问 DOM，不能访问 `window.*`
- `injected/` — 注入页面真实上下文的脚本，通过 postMessage 通信
- `popup/` — 扩展图标弹出面板
- `lib/` — 共享工具库
- `test/` — 单元测试

## 运行测试

```bash
npm test
```

使用 Node.js 内置测试运行器（`node:test` + `node:assert/strict`），不引入第三方测试框架。

## 提交 Pull Request

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 提交更改，确保测试通过
4. 推送到你的 Fork
5. 创建 Pull Request，描述变更内容和目的

### PR 检查清单

- [ ] 所有现有测试通过
- [ ] 新增公共函数有对应测试
- [ ] 如果修改了接口签名，更新 `docs/ARCHITECTURE.md`
- [ ] 如果新增/删除了功能，更新 `docs/PRD.md`

## 安全约定

- 不尝试绕过 DRM（Widevine/PlayReady）
- 不加载远程代码
- 用户输入（标题）在写入 HTML 时必须使用 `escapeHtml` 转义

## 报告 Bug

请提交 Issue 并包含：

- Chrome 版本
- 目标网站 URL
- 复现步骤
- Console 中的 `[OVD]` 错误日志
