// background/page-stream-download.js
// 内容侧抓流落盘（PAGE_STREAM_* 消息的处理端）。
//
// 背景：Telegram Web（web.telegram.org/k）的视频由页面自己的 Service Worker 提供，
// 地址形如 `…/k/stream/<JSON>`，只有页面上下文发起的请求才会被那个 SW 接管
// （扩展后台直接 fetch 会打真实网络 → 404）。因此字节必须在内容脚本里抓，
// 但内容脚本又不该把整个视频攒在内存里，于是：
//   内容脚本 Range 分块抓取 → base64 逐块送后台 → 后台顺序写 OPFS → offscreen 生成
//   对象 URL 交给下载管理器。全程只有单个分片在内存里，GB 级文件也不会撑爆页面。
import '../lib/byte-utils.js';
import '../lib/opfs-sink.js';

const byteUtils = globalThis.__OVD_BYTE_UTILS__ || {};
const opfs = globalThis.__OVD_OPFS_SINK__ || {};

/** 传输表：transferId → { sink, filename, mimeType, bytes, ... } */
const transfers = new Map();

export class PageStreamDownloadManager {
  constructor(options = {}) {
    const {
      broadcastTaskUpdate = () => {},
      createSink = null,
      downloadStore = null,
      registerTempFile = () => {},
      submitOpfsDownload = async () => ({ error: 'submitOpfsDownload 不可用', ok: false }),
    } = options;

    this._broadcastTaskUpdate = broadcastTaskUpdate;
    this._createSink = createSink || (() => {
      if (typeof opfs.createOpfsSink !== 'function') {
        throw new Error('当前环境不支持 OPFS，无法保存页面侧抓取的视频流');
      }
      return opfs.createOpfsSink({ prefix: 'ovd-page-stream' });
    });
    this._downloadStore = downloadStore;
    this._registerTempFile = registerTempFile;
    this._submitOpfsDownload = submitOpfsDownload;
  }

  get transferCount() {
    return transfers.size;
  }

  async start(message = {}) {
    const transferId = message.transferId;
    if (!transferId) {
      throw new Error('缺少 transferId');
    }
    if (transfers.has(transferId)) {
      throw new Error(`传输 ${transferId} 重复开始`);
    }

    const sink = await this._createSink();
    transfers.set(transferId, {
      bytes: 0,
      fileSize: Number(message.fileSize) > 0 ? Number(message.fileSize) : 0,
      filename: String(message.filename || 'telegram-video.mp4'),
      mimeType: String(message.mimeType || 'video/mp4'),
      sink,
      startedAt: Date.now(),
      tabId: message.tabId ?? null,
      taskMeta: message.taskMeta || {},
    });

    console.log(`[OVD] 页面侧抓流开始 transfer=${transferId} file="${message.filename || ''}" opfs=${sink?.name || ''}`);
    return { ok: true, transferId };
  }

  async append(message = {}) {
    const transfer = transfers.get(message.transferId);
    if (!transfer) {
      throw new Error('传输不存在或已结束');
    }

    const bytes = byteUtils.base64ToUint8Array
      ? byteUtils.base64ToUint8Array(message.chunkBase64)
      : Uint8Array.from(atob(String(message.chunkBase64 || '')), (char) => char.charCodeAt(0));

    await transfer.sink.write(bytes);
    transfer.bytes += bytes.byteLength;
    return { ok: true, bytes: transfer.bytes };
  }

  async finish(message = {}) {
    const transferId = message.transferId;
    const transfer = transfers.get(transferId);
    if (!transfer) {
      return { error: '传输不存在或已结束', ok: false };
    }

    transfers.delete(transferId);

    let sinkInfo;
    try {
      sinkInfo = await transfer.sink.finalize();
    } catch (err) {
      await transfer.sink.remove?.().catch?.(() => {});
      return { error: `临时文件写入失败: ${err.message}`, ok: false };
    }

    // 一个字节都没收到就落盘会保存出空文件，直接当失败处理并清理临时文件
    if (!sinkInfo?.byteLength) {
      await transfer.sink.remove?.().catch?.(() => {});
      return { error: '未取到任何视频数据', ok: false };
    }

    const taskMeta = { ...transfer.taskMeta, ...(message.taskMeta || {}) };

    let result;
    try {
      result = await this._submitOpfsDownload(
        sinkInfo?.name,
        transfer.filename,
        transfer.mimeType,
        taskMeta
      );
    } catch (err) {
      await transfer.sink.remove?.().catch?.(() => {});
      return { error: `保存失败: ${err.message}`, ok: false };
    }

    if (!result?.ok) {
      await transfer.sink.remove?.().catch?.(() => {});
      return { error: result?.error || '保存失败', ok: false };
    }

    this._registerTempFile(result.downloadId, sinkInfo?.name);
    this._attachDownloadToTask(result.downloadId, transfer, taskMeta);

    console.log(
      `[OVD] 页面侧抓流完成 transfer=${transferId} downloadId=${result.downloadId} `
      + `size=${Math.round((sinkInfo?.byteLength || 0) / 1024)} KB file="${result.filename || transfer.filename}"`
    );

    return {
      ok: true,
      downloadId: result.downloadId ?? null,
      filename: result.filename || transfer.filename,
      opfsName: sinkInfo?.name || '',
      size: sinkInfo?.byteLength ?? transfer.bytes,
    };
  }

  async abort(message = {}) {
    const transfer = transfers.get(message.transferId);
    if (!transfer) {
      return { ok: true };
    }

    transfers.delete(message.transferId);
    const removed = await transfer.sink.remove?.().catch?.(() => false);
    console.log(
      `[OVD] 页面侧抓流中止 transfer=${message.transferId} `
      + `reason=${message.error || 'unknown'} written=${transfer.bytes} cleaned=${removed !== false}`
    );
    return { ok: true };
  }

  /** 标签页关闭/导航后清掉该标签页未完成的传输，避免 OPFS 临时文件残留 */
  async abortForTab(tabId) {
    if (tabId == null) {
      return 0;
    }

    let aborted = 0;
    for (const [transferId, transfer] of [...transfers]) {
      if (transfer.tabId !== tabId) {
        continue;
      }
      await this.abort({ error: 'tab closed', transferId });
      aborted += 1;
    }
    return aborted;
  }

  /**
   * 把 downloadId 挂回内容侧已经在跟踪的同一条任务。
   * 内容侧的任务以 taskKey / traceId / videoUrl 建索引（见 DownloadStateStore#_findTask），
   * 这里带上同样的字段即可命中，不会多出一条重复任务。
   */
  _attachDownloadToTask(downloadId, transfer, taskMeta = {}) {
    if (downloadId == null || !this._downloadStore?.registerDownload) {
      return;
    }

    try {
      this._downloadStore.registerDownload(downloadId, {
        requiresTabContext: true,
        sourceId: taskMeta.sourceId || 'telegram',
        strategyId: taskMeta.strategyId || 'page-stream',
        tabId: taskMeta.tabId ?? transfer.tabId ?? null,
        taskId: taskMeta.taskId || null,
        title: taskMeta.title || transfer.filename,
        videoInfo: taskMeta.videoInfo || null,
        videoUrl: taskMeta.videoUrl || '',
      });
      const task = this._downloadStore.updateTaskByVideoUrl(taskMeta.videoUrl || '', {
        downloadId,
        filename: transfer.filename,
        percent: 100,
        sourceId: taskMeta.sourceId || 'telegram',
        status: 'complete',
        strategyId: taskMeta.strategyId || 'page-stream',
        taskKey: taskMeta.taskKey || '',
        traceId: taskMeta.traceId || '',
      });
      this._broadcastTaskUpdate(task);
    } catch (err) {
      console.warn(`[OVD] 页面侧抓流登记下载失败 downloadId=${downloadId}: ${err.message}`);
    }
  }
}
