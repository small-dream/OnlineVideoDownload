import { safeRuntimeMessage, safeTabMessage } from '../../lib/browser-compat.module.js';
import '../../lib/message-types.js';

const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
const MSG = messageTypes;

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
      const onProgress = (done, total) => {
        emitProgress(Math.min(95, Math.round((done / total) * 95)), {
          done,
          phase: 'segments',
          total,
        });
      };

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
