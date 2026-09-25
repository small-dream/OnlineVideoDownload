import { injectHeaders } from '../header-injector.js';
import { resolveSaveAs } from '../save-location.js';
import { browserInfo } from '../../lib/browser-compat.module.js';
import { rememberDownloadFilename } from '../download-filename-registry.js';

export function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.(mp4|webm|flv|mkv|m4v|m4a|mp3|flac|oga|ogg|aac|wav)$/);
    return match ? `.${match[1]}` : null;
  } catch {
    return null;
  }
}

export async function submitDirectDownload({ url, filenameNoExt, headers, type }) {
  const ext = extFromUrl(url) || (type === 'audio' ? '.mp3' : '.mp4');
  const filename = filenameNoExt.endsWith(ext) ? filenameNoExt : filenameNoExt + ext;
  console.log(`[OVD] direct download${type === 'audio' ? ' (audio)' : ''} filename="${filename}" url=${url} browser=${browserInfo.name}`);

  const cleanupRules = await injectHeaders(url, headers);
  const options = { filename, saveAs: await resolveSaveAs(), url };

  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error(`[OVD] chrome.downloads.download failed: ${chrome.runtime.lastError.message}`);
        cleanupRules().catch((err) => {
          console.warn(`[OVD] failed to cleanup direct-download rules after download error: ${err.message}`);
        });
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      console.log(`[OVD] download submitted downloadId=${downloadId} filename="${filename}"`);
      // 登记拟用文件名：有些 CDN 会把媒体标成 text/plain，浏览器会追加 .txt，
      // 由 downloads.onDeterminingFilename 改回我们想要的名字
      rememberDownloadFilename(downloadId, filename);
      resolve({ cleanupRules, downloadId });
    });
  });
}

export function createDirectDownloadStrategy(options = {}) {
  const { fallback = false } = options;

  return {
    id: fallback ? 'fallback-direct' : 'direct',
    supports(videoInfo) {
      if (fallback) {
        return true;
      }
      return videoInfo?.type === 'direct' || videoInfo?.type === 'audio';
    },
    async download(videoInfo, context) {
      return submitDirectDownload({
        filenameNoExt: context.filenameBase,
        headers: videoInfo?.requestHeaders,
        type: videoInfo?.type,
        url: videoInfo?.url,
      });
    },
  };
}
