'use strict';

// 下载产物健壮性工具（shared：service worker / 测试）
//
// 现象：把媒体直链交给浏览器下载管理器时，若服务器拒绝并回 text/plain 错误页，
// Chrome 会按 MIME 给文件名追加扩展名 —— 于是出现
// `Learn 10 phrases …_2160p.mp4.txt`（内容是 403 错误页，不是视频）。
// 这类文件必须删除并按失败上报，否则用户以为下载成功了。

(() => {
  if (globalThis.__OVD_DOWNLOAD_ARTIFACT_UTILS__) {
    return;
  }

  const TEXT_MIME_PATTERN = /^(?:text\/|application\/(?:xml|xhtml\+xml))/;
  const SMALL_STUB_MAX_BYTES = 512 * 1024;

  /**
   * @param {{ filename?: string, fileSize?: number, mime?: string, totalBytes?: number }|null} item
   * @returns {boolean} 是否是"服务器错误页残片"
   */
  function isBrokenTextStubDownload(item) {
    if (!item) {
      return false;
    }
    if (/\.txt$/i.test(String(item.filename || ''))) {
      return true;
    }

    const mime = String(item.mime || '').toLowerCase();
    const size = Number(item.fileSize ?? item.totalBytes) || 0;
    // 文本类 MIME 且体积很小（错误页通常几 KB）才判定，避免误伤正常文件
    return TEXT_MIME_PATTERN.test(mime) && size < SMALL_STUB_MAX_BYTES;
  }

  globalThis.__OVD_DOWNLOAD_ARTIFACT_UTILS__ = Object.freeze({
    SMALL_STUB_MAX_BYTES,
    TEXT_MIME_PATTERN,
    isBrokenTextStubDownload,
  });
})();
