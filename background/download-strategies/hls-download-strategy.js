import { safeRuntimeMessage, safeTabMessage } from '../../lib/browser-compat.module.js';
import '../../lib/message-types.js';
import { injectHeaders } from '../header-injector.js';

const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
const MSG = messageTypes;

/**
 * 读取标签页来源（Origin），用于委托下载时回显 CORS 响应头。
 */
async function resolveTabOrigin(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url ? new URL(tab.url).origin : '';
  } catch (err) {
    console.warn(`[OVD] 无法解析标签页来源 tab=${tabId}: ${err.message}`);
    return '';
  }
}

/**
 * 优先在页面上下文完成 HLS 下载。
 * content script 发起的请求携带页面 Origin / Sec-Fetch / Referer / Cookie，
 * 可避开 CDN（Cloudflare 等）针对扩展后台裸请求的 403 拦截。
 * 返回 null 表示委托不可用或失败，由调用方回退到 service worker 下载。
 */
async function delegateHlsDownloadToPage({ context, headers, m3u8Url, taskMeta, frameId = null }) {
  const tabId = context?.tabId;
  if (!tabId || !m3u8Url) {
    return null;
  }

  const corsOrigin = await resolveTabOrigin(tabId);
  let cleanupRules = async () => {};

  try {
    cleanupRules = await injectHeaders(m3u8Url, headers, { corsOrigin });
  } catch (err) {
    console.warn(`[OVD] HLS 委托下载注入请求头规则失败: ${err.message}`);
  }

  try {
    // 委托定向到检测出视频的 frame，避免多 frame 重复执行
    const response = await safeTabMessage(tabId, {
      type: MSG.HLS_DOWNLOAD_DELEGATE || 'HLS_DOWNLOAD_DELEGATE',
      m3u8Url,
      filename: context.filenameBase,
      headers,
      options: { fetchOptions: { credentials: 'include' } },
      taskMeta,
    }, undefined, frameId != null ? { frameId } : undefined);

    if (!response) {
      console.warn(`[OVD] HLS 页面上下文下载不可用（tab=${tabId} 无响应），回退到后台下载`);
      return null;
    }

    if (response.ok === false) {
      console.warn(`[OVD] HLS 页面上下文下载失败: ${response.error || 'unknown'}，回退到后台下载`);
      return null;
    }

    console.log(`[OVD] HLS 页面上下文下载完成 downloadId=${response.downloadId ?? 'none'} filename="${response.filename || ''}"`);
    return {
      downloadId: response.downloadId ?? null,
      failedCount: response.failedCount ?? 0,
      filename: response.filename || '',
      requiresTabContext: true,
      segmentCount: response.segmentCount ?? 0,
    };
  } catch (err) {
    console.warn(`[OVD] HLS 页面上下文下载异常: ${err.message}，回退到后台下载`);
    return null;
  } finally {
    await cleanupRules();
  }
}

export function createHlsDownloadStrategy() {
  return {
    id: 'hls',
    supports(videoInfo) {
      return videoInfo?.type === 'hls';
    },
    async download(videoInfo, context) {
      const emitProgress = (percent, payload = {}) => {
        const msg = {
          percent,
          taskMeta: context.taskMeta || {},
          type: MSG.HLS_PROGRESS || 'HLS_PROGRESS',
          videoUrl: videoInfo?.url || '',
          ...payload,
        };
        context.onTaskProgress?.(percent, {
          phase: payload.phase || '',
          status: percent >= 100 ? 'complete' : 'running',
        });
        safeTabMessage(context.tabId, msg);
        safeRuntimeMessage(msg);
      };
      const onProgress = (done, total, stats) => {
        emitProgress(Math.min(95, Math.round((done / total) * 95)), {
          done,
          phase: 'segments',
          total,
          // 分片失败未超阈值时通过进度消息告知用户
          ...(stats?.failedCount > 0
            ? { failedCount: stats.failedCount, warning: `${stats.failedCount}/${total} 个分片下载失败` }
            : {}),
        });
      };

      const delegated = await delegateHlsDownloadToPage({
        context,
        headers: videoInfo?.requestHeaders || {},
        m3u8Url: videoInfo?.url,
        taskMeta: context.taskMeta || {},
        frameId: videoInfo?.frameId,
      });
      if (delegated) {
        return delegated;
      }

      console.log(`[OVD] HLS 下载回退到 service worker url=${videoInfo?.url}`);
      const result = await context.hlsFetcher.downloadAndMerge(
        videoInfo?.url,
        context.filenameBase,
        videoInfo?.requestHeaders || {},
        onProgress,
        context.tabId,
        context.taskMeta || {}
      );
      emitProgress(100, { phase: 'browser-handoff' });
      return result;
    },
  };
}
