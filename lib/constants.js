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

    // 媒体流传输超时（毫秒）
    MEDIA_STREAM_TIMEOUT: 120000,

    // 页面内直链下载超时（毫秒）
    PAGE_DIRECT_DOWNLOAD_TIMEOUT: 600000,

    // YouTube 页面内合并最大字节数
    MAX_IN_PAGE_MERGE_BYTES: 1.5 * 1024 * 1024 * 1024,

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
  });
})();
