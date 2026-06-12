# YouTube 多模式下载设计方案

> 状态：设计中  
> 日期：2026-04-04  
> 目标：在不影响现有 YouTube 录制模式的前提下，新增“解析下载模式”，支持用户选择下载模式与分辨率，并在浏览器内完成音视频合并。

## 1. 背景与现状

当前仓库的 YouTube 下载能力已经具备以下基础：

- 页面侧解析：`injected/page-context-script.js`
  - 通过 `ytInitialPlayerResponse`、`yt.player_`、`/youtubei/v1/player` 等来源提取 `combined`、`videoStreams`、`audioStreams`
- content 侧来源调度：`content/source-handlers.js`
  - 已支持“同一来源注册多个 strategy，并按优先级/选择逻辑决定实际执行策略”
- content 侧统一下载编排：`content/download-coordinator.js`
  - 已统一处理来源下载生命周期、去重与消息广播
- content 侧流数据传输：`content/stream-transfer-manager.js`
  - 已支持页面上下文抓取二进制流并回传 content
- 现有 YouTube 策略：`content/strategies/youtube-strategy.js`
  - 当前实际主路径是录制模式
  - 但文件内部已经存在“页面直链下载”和“视音频抓取+合并”辅助能力，尚未被模式化启用

这说明当前架构本身已经适合扩展，不需要推翻重写。最优方案不是继续在 `youtube-strategy.js` 中堆条件分支，而是把 YouTube 下载拆为“共享能力 + 多个可切换策略”。

## 2. 设计目标

- 保留现有录制模式，默认行为在未显式切换时不退化
- 新增解析下载模式，允许用户按需选择：
  - 录制模式
  - 解析下载模式
  - 视频分辨率
- 解析下载模式优先使用页面已解析出的直链
- 若是分离流，自动抓取视频流和音频流，并在浏览器内合并
- 不把 YouTube 特殊逻辑塞回 `content-main.js` 或 background 大型分支
- 日志完整、链路可追踪、异常定位成本低
- 后续便于继续扩展：
  - 自动模式
  - 仅音频模式
  - 更丰富的质量策略
  - `signatureCipher` 解密能力

## 3. 非目标

本次设计先不做以下事项：

- 不绕过 DRM
- 不依赖外部服务解析 YouTube
- 不引入本地宿主程序或 ffmpeg
- 不在第一阶段支持 `signatureCipher` 复杂解密
  - 仅使用当前页面可直接拿到的 `url`
  - 若只有 `signatureCipher` 没有可用 `url`，明确打日志并给出失败原因

## 4. 总体方案

### 4.1 模式定义

新增 YouTube 下载模式枚举：

- `capture`
  - 现有录制模式
  - 优点：兼容性强
  - 缺点：依赖页面播放、耗时长、需保持标签页打开
- `parse`
  - 新增解析下载模式
  - 从 `combined` / `videoStreams` / `audioStreams` 中选流
  - 视频与音频在页面侧抓取，在 content 侧合并，最终交给浏览器保存
- `auto`
  - 预留模式
  - 第一阶段可不暴露给 UI，只保留内部接口

### 4.2 关键原则

- YouTube 仍归属 content/page 侧能力
- background 不负责 YouTube 流解析与 mux，只保留通用下载、保存、状态广播能力
- UI 只传“用户选择”，不直接参与底层流选择
- 流选择、抓取、合并、保存、日志都拆成独立模块

## 5. 目标代码架构

### 5.1 新模块划分

建议新增如下模块：

- `lib/ovd-logger.js`
  - 统一日志工具
  - 支持作用域、traceId、结构化字段、debug 开关
- `lib/youtube-stream-utils.js`
  - YouTube 流归一化、分辨率选流、音频选流、兼容性判断
- `lib/youtube-download-mode-store.js`
  - 持久化 YouTube 下载模式偏好与默认分辨率
  - 建议基于 `chrome.storage.local`
- `content/strategies/youtube-capture-strategy.js`
  - 迁移现有录制模式逻辑
- `content/strategies/youtube-parse-download-strategy.js`
  - 新增解析下载模式逻辑
- `content/youtube-download-options.js`
  - 组装单次下载参数，解析用户选择，生成标准化 options

### 5.2 可选的小型增强模块

- `content/youtube-download-errors.js`
  - 定义标准错误码与错误包装器
- `content/youtube-debug-snapshot.js`
  - 在失败时输出本次视频可用流、用户选择、最终选流结果

### 5.3 现有模块调整方式

- `content/source-handlers.js`
  - 保持注册机制不变
  - 给 `youtube` 来源注册多个 strategy
- `content/content-main.js`
  - 仅增加装配，不增加业务分支
- `content/download-coordinator.js`
  - 保持统一生命周期管理
  - 可增加 `traceId` 透传
- `popup/popup.js`
  - 新增模式选择与分辨率选择 UI
- `content/progress-reporter.js`
  - 保持轻量
  - 模式/分辨率选择只在 Popup 中提供，避免页面内 UI 与 Popup 重复

## 6. 推荐的职责边界

### 6.1 `youtube-capture-strategy`

职责：

- 查找主播放器 video 元素
- 静音标签页
- 从头播放并录制
- 保存 blob
- 恢复页面状态
- 输出录制阶段详细日志

说明：

- 基本是对现有 `content/strategies/youtube-strategy.js` 中录制路径的拆分迁移
- 逻辑尽量不改，只做模块化与日志增强，降低回归风险

### 6.2 `youtube-parse-download-strategy`

职责：

- 读取标准化下载选项
- 基于用户分辨率选择具体视频流
- 选择最合适音频流
- 触发页面侧抓取视频流和音频流
- 调用 muxer 合并
- 保存最终 MP4
- 输出解析链路详细日志

### 6.3 `youtube-stream-utils`

职责：

- 从 `combined/videoStreams/audioStreams` 提取统一候选结构
- 判断某流是否可下载：
  - 必须存在 `url`
  - 优先 `video/mp4` + `audio/mp4`
- 生成分辨率选项列表
- 根据用户目标分辨率进行选流

建议暴露接口：

- `normalizeYouTubeStreams(meta)`
- `listAvailableVideoQualities(meta)`
- `pickCombinedStream(meta, options)`
- `pickAdaptiveVideoStream(meta, options)`
- `pickAdaptiveAudioStream(meta, options)`
- `buildYouTubeSelectionSnapshot(meta, options)`

## 7. 来源注册与策略选择

### 7.1 注册方式

在 `content/content-main.js` 中注册：

- `youtube-capture-strategy`
- `youtube-parse-download-strategy`

并由 `youtube` 来源的 `selectStrategy()` 决定实际策略，而不是简单按优先级取第一个。

### 7.2 推荐选择逻辑

新增 `youtube` 专用 handler，替代通用 `createSourceHandler('youtube')`：

- 根据 `videoInfo.downloadOptions?.mode` 选择 strategy
- 未传入时读取模式偏好存储
- 若仍无配置，默认走 `capture`
  - 这样完全不影响已有行为

伪代码：

```js
selectStrategy(videoInfo, strategies, context) {
  const mode =
    videoInfo?.downloadOptions?.mode ||
    context.actions?.getYouTubeDefaultMode?.() ||
    'capture';

  return strategies.find((s) => s.id === `youtube-${mode}`) || strategies[0] || null;
}
```

## 8. 数据模型设计

### 8.1 检测结果 `videoInfo`

保留当前页面上报结构，不破坏已有字段：

```js
{
  type: 'youtube-adaptive',
  url,
  title,
  videoId,
  duration,
  fileSize,
  requestHeaders,
  combined,
  videoStreams,
  audioStreams
}
```

### 8.2 单次下载请求附加字段

UI 发起下载时，传入一个克隆对象并附加：

```js
downloadOptions: {
  mode: 'capture' | 'parse',
  resolution: 'auto' | '2160p' | '1440p' | '1080p' | '720p' | '480p',
  preferCombined: true,
  fallbackToLowerQuality: true
}
```

说明：

- 不建议直接修改 registry 中的原始 `videoInfo`
- UI 点击时复制当前条目，并附加本次选择
- 这样可以保留“检测结果”和“下载请求”两个语义层次

### 8.3 视频清晰度选项来源

建议基于 `videoStreams` 计算可用分辨率：

- 去重后输出 `2160p / 1440p / 1080p / 720p ...`
- 若 `combined` 中存在同分辨率，也标注为“带音频”
- UI 统一展示分辨率，不直接暴露 itag

## 9. 解析下载模式的执行流程

### 9.1 入口流程

1. UI 发送 `SOURCE_DOWNLOAD`
2. `download-coordinator` 生成 `traceId`
3. `youtube` handler 根据 `downloadOptions.mode` 选择 `youtube-parse`
4. `youtube-parse-download-strategy` 开始执行

### 9.2 选流策略

优先级建议如下：

1. 用户指定分辨率且存在对应 `combined` MP4：
   - 直接走单流下载
2. 用户指定分辨率且存在对应 `video/mp4` 自适应视频流：
   - 选择该视频流 + 最优 `audio/mp4`
   - 抓取并合并
3. 用户指定分辨率不存在，但允许降级：
   - 选择不高于目标分辨率的最高可用流
4. 若还不存在：
   - 选择最高可用可下载 MP4 视频流
5. 若没有任何带 `url` 的可下载流：
   - 抛出 `NO_DOWNLOADABLE_STREAM`

### 9.3 合并策略

- `combined` 流：
  - 直接页面侧下载或抓 blob 保存
- 分离流：
  - 页面侧抓取 `ArrayBuffer`
  - content 侧调用现有 muxer 合并为 MP4
  - 通过 `DOWNLOAD_BLOB_DATA` 交给浏览器保存

### 9.4 为什么继续放在 content/page 侧

- 解析地址通常依赖页面上下文
- 示例中的 `googlevideo` 地址本身带有效期，不能离线长期复用
- 页面侧抓取更容易复用当前登录态和同源上下文
- 与现有 Bilibili/YouTube content 侧链路一致

## 10. UI 方案

### 10.1 第一阶段建议

下载模式与分辨率选择集中在 Popup：

- YouTube 条目增加模式下拉：
  - `录制模式`
  - `解析下载模式`
- 当选择 `解析下载模式` 时，显示分辨率下拉
- 默认值来源于 `chrome.storage.local`
- 点击下载时，把选择写入 `downloadOptions`

原因：

- Popup 更适合展示较复杂配置
- 页面内不再注入可见悬浮面板，避免和 Popup 形成两套入口
- 可减少现有页面 UI 回归风险

### 10.2 后续可选

页面侧仅保留进度上报：

- 最近一次使用的模式
- 最近一次使用的分辨率
- Popup 中的“再次下载同配置”

## 11. 日志设计

### 11.1 统一日志规范

建议新增统一 logger：

```js
createLogger('youtube-parse', {
  traceId,
  videoId,
  mode,
  resolution
});
```

输出格式：

```text
[OVD][youtube-parse][trace=yt-1712200000-abcd][video=VFe7Ap1kfk0] selecting stream target=1080p
```

### 11.2 必须记录的关键节点

解析下载模式至少记录：

- 下载开始
- 用户选择
- 可用流摘要
- 选流结果
- 是否命中 combined
- 视频流抓取开始/完成
- 音频流抓取开始/完成
- 合并开始/进度/完成
- 浏览器保存开始/完成
- 清理动作完成

录制模式至少记录：

- 选择到的 video 元素信息
- `captureStream` 支持性
- 静音前后状态
- 播放开始
- 录制开始/结束
- blob 大小
- 保存完成

### 11.3 异常日志要求

所有 catch 不能只吞掉异常，至少输出：

- error code
- error message
- traceId
- 当前阶段
- 关键上下文
  - `videoId`
  - `requestedResolution`
  - `selectedVideoItag`
  - `selectedAudioItag`
  - `availableVideoHeights`

## 12. 异常模型

建议为 YouTube 下载定义明确错误码：

- `YT_MODE_NOT_SUPPORTED`
- `YT_NO_STREAMS`
- `YT_NO_MATCHING_RESOLUTION`
- `YT_NO_DOWNLOADABLE_MP4_VIDEO`
- `YT_NO_DOWNLOADABLE_MP4_AUDIO`
- `YT_SIGNATURE_CIPHER_UNSUPPORTED`
- `YT_PAGE_FETCH_TIMEOUT`
- `YT_PAGE_FETCH_FAILED`
- `YT_MUX_FAILED`
- `YT_SAVE_FAILED`
- `YT_CAPTURE_UNSUPPORTED`
- `YT_CAPTURE_VIDEO_NOT_FOUND`
- `YT_CAPTURE_PLAYBACK_FAILED`

对外展示简洁中文错误，对内日志保留详细技术上下文。

## 13. 调试友好性设计

### 13.1 traceId 贯穿整条链路

每次下载生成一个 `traceId`，贯穿：

- popup / progress-reporter
- download-coordinator
- youtube strategy
- stream-transfer-manager
- page-context-script
- mux 过程日志

这样可以在 Console 中按一次 trace 检索整条链路。

### 13.2 失败时输出快照

建议在失败日志中附加快照：

```js
{
  requestedMode: 'parse',
  requestedResolution: '1080p',
  selectedVideo: { itag, height, mimeType, hasUrl },
  selectedAudio: { itag, bitrate, mimeType, hasUrl },
  availableCombined: ['360p', '720p'],
  availableVideo: ['2160p', '1440p', '1080p', '720p'],
  availableAudioBitrates: [128000]
}
```

### 13.3 debug 开关

建议增加：

- `chrome.storage.local.debug.youtube = true/false`

关闭时保留关键 info/error，打开时输出全部调试日志。

## 14. 对现有功能的影响控制

### 14.1 默认行为不变

若用户没有开启或选择“解析下载模式”：

- 继续走 `capture` 录制模式
- 不改变现有按钮行为
- 不改变现有 background 下载逻辑

### 14.2 渐进式替换

当前 `content/strategies/youtube-strategy.js` 不建议直接大改。推荐分两步：

1. 先抽公共函数
2. 再拆成两个 strategy 文件

这样便于逐步验证：

- 第一步只做模块重构，不改行为
- 第二步再接入 UI 的模式选择

## 15. 推荐实施步骤

### 阶段 1：能力拆分

- 抽出 `youtube-stream-utils`
- 抽出 `youtube-capture-strategy`
- 抽出 `ovd-logger`
- 保持默认仍走录制模式

### 阶段 2：新增解析下载策略

- 新建 `youtube-parse-download-strategy`
- 接通页面抓流、合并、保存
- 加入 traceId 与异常码

### 阶段 3：接入模式选择 UI

- Popup 增加模式与分辨率选择
- 写入 `downloadOptions`
- handler 按模式选择策略

### 阶段 4：补齐调试与回归验证

- 验证 YouTube 录制模式回归
- 验证 720p combined 直下
- 验证 1080p 分离流抓取与合并
- 验证不存在目标分辨率时的降级逻辑
- 验证抓流失败、合并失败、保存失败时的日志完整性

## 16. 示例视频的落地方式

针对你提供的示例视频：

- 视频页：`https://www.youtube.com/watch?v=VFe7Ap1kfk0`
- 1080p 视频流：`itag=299`
- 音频流：`itag=140`

在目标实现中：

- 页面解析阶段应拿到 `videoStreams` 中的 1080p 视频流和 `audioStreams` 中的音频流
- 当用户选择：
  - 模式=`解析下载模式`
  - 分辨率=`1080p`
- 则 `youtube-parse-download-strategy` 选中：
  - `itag=299` 视频流
  - `itag=140` 音频流
- 然后：
  - 页面侧抓取二进制
  - content 侧 mux 为 MP4
  - 最终触发浏览器下载

需要注意：

- 这些解析 URL 带 `expire` 等临时参数，只能作为当前会话中的短期可用地址
- 不应缓存为长期下载地址
- 下载前必须基于页面最新解析结果重新选流

## 17. 最终推荐结论

最优实现路径是：

- 保持 YouTube 归属 content/page 侧
- 将现有单一 `youtube-strategy` 拆成“录制 strategy + 解析 strategy + 共享选流工具 + 统一日志工具”
- 用 `downloadOptions` 传递用户选择，而不是污染原始检测元数据
- 默认继续使用录制模式，确保现有功能零回归
- Popup 负责模式与分辨率选择；页面侧只负责解析、抓流、合并和进度上报

该方案与当前仓库的 `source registry + strategy + coordinator + transfer manager` 架构完全一致，侵入最小、可调试性最好，也最利于后续继续扩展 YouTube 下载能力。
