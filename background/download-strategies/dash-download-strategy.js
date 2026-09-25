import { submitDirectDownload } from './direct-download-strategy.js';

export function createDashDownloadStrategy() {
  return {
    id: 'dash',
    supports(videoInfo) {
      // 只有已经解析出音视频分离流的 DASH 才由后台落盘为两个文件；
      // 仅有一个 .mpd 地址的场景必须回到页面内合并，由 unsupported 策略明确告知用户。
      return videoInfo?.type === 'dash' && (videoInfo.videoStreams?.length || 0) > 0;
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
