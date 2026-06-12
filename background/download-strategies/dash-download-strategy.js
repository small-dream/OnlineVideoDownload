import { submitDirectDownload } from './direct-download-strategy.js';

export function createDashDownloadStrategy() {
  return {
    id: 'dash',
    supports(videoInfo) {
      return videoInfo?.type === 'dash';
    },
    async download(videoInfo, context) {
      const { url, requestHeaders } = videoInfo;

      if (videoInfo.videoStreams?.length) {
        const results = [];
        const headers = { ...requestHeaders, ...videoInfo.requiredHeaders };
        results.push(await submitDirectDownload({
          filenameNoExt: `${context.filenameBase}_video`,
          headers,
          url: videoInfo.videoStreams[0].url,
        }));

        if (videoInfo.audioStreams?.[0]) {
          results.push(await submitDirectDownload({
            filenameNoExt: `${context.filenameBase}_audio`,
            headers,
            url: videoInfo.audioStreams[0].url,
          }));
        }

        return {
          note: 'Video and audio are separate. Merge in browser if supported.',
          results,
        };
      }

      return submitDirectDownload({
        filenameNoExt: context.filenameBase,
        headers: requestHeaders,
        url,
      });
    },
  };
}
