'use strict';

(() => {
  if (globalThis.__OVD_CONSTANTS__) {
    return;
  }

  globalThis.__OVD_CONSTANTS__ = Object.freeze({
    // 流式抓取重试延迟（毫秒）
    STREAM_FETCH_RETRY_DELAYS: [0, 1000, 2500, 5000],

    // 下载中断自动恢复重试延迟（毫秒）
    DOWNLOAD_RESUME_RETRY_DELAYS: [1500, 4000, 8000],

    // HLS 分片下载并发数
    HLS_SEGMENT_CONCURRENCY: 5,

    // Blob 分块传输的块大小
    BLOB_TRANSFER_CHUNK_SIZE: 256 * 1024,

    // 后台→内容侧媒体流回传：块大小与在途消息数（流水线）
    MEDIA_STREAM_CHUNK_SIZE: 1024 * 1024,
    MEDIA_STREAM_PIPELINE_DEPTH: 4,

    // 媒体流传输超时（毫秒）
    MEDIA_STREAM_TIMEOUT: 120000,

    // 页面内直链下载超时（毫秒）
    PAGE_DIRECT_DOWNLOAD_TIMEOUT: 600000,

    // YouTube 页面内合并最大字节数
    // muxer 零拷贝后合并期峰值 ≈ 2×（输入 + 输出），故由 1.5GB 上调到 2GB
    MAX_IN_PAGE_MERGE_BYTES: 2 * 1024 * 1024 * 1024,

    // YouTube 自适应流"浏览器内合并"的实际上限。
    // 合并期同时存在：两路输入 + 合并输出 + Blob 物化，峰值 ≈ 3~4× 总字节；
    // 1.7GB 的视频按 2GB 上限放行后必然抛 "Array buffer allocation failed"，
    // 因此这里给一条更保守的线：超过就走 HLS（OPFS 流式落盘，上限 8GB）或明确报错。
    YOUTUBE_MERGE_MAX_BYTES: 768 * 1024 * 1024,

    // YouTube media range fetch tuning
    YOUTUBE_PARALLEL_MIN_BYTES: 16 * 1024 * 1024,
    YOUTUBE_PARALLEL_AUDIO_MIN_BYTES: 1 * 1024 * 1024,
    YOUTUBE_PARALLEL_AUDIO_CHUNK_BYTES: 1 * 1024 * 1024,
    YOUTUBE_PARALLEL_CHUNK_BYTES: 8 * 1024 * 1024,
    YOUTUBE_PARALLEL_MAX_CONCURRENCY: 4,

    // 脚本注入后等待时间（毫秒）
    SCRIPT_INJECTION_DELAY: 300,

    // Object URL 撤销延迟（毫秒）
    OBJECT_URL_REVOKE_DELAY: 60000,

    // HLS 失败分片阈值百分比（超过则中止下载）
    HLS_MAX_FAILED_RATIO: 0.1,

    // HLS/DASH 分片下载失败重试延迟（毫秒），最多重试 3 次
    HLS_SEGMENT_RETRY_DELAYS: [500, 1000, 2000],

    // 大文件落盘：累计超过该字节数后从内存缓冲切换到 OPFS 流式落盘
    OPFS_SPILL_THRESHOLD_BYTES: 128 * 1024 * 1024,

    // DASH 浏览器内合并上限（超过则降级为分离文件）
    DASH_MAX_MERGE_BYTES: 2 * 1024 * 1024 * 1024,

    // 落盘（OPFS）路径的输出上限：约束从内存改为磁盘空间
    OPFS_MAX_OUTPUT_BYTES: 8 * 1024 * 1024 * 1024,

    // OPFS 残留临时文件的保留时间（超过即视为异常退出遗留，可安全清理）
    OPFS_STALE_MS: 6 * 60 * 60 * 1000,
  });
})();
