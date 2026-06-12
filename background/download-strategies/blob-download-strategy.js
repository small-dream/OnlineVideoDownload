export function createBlobDownloadStrategy() {
  return {
    id: 'blob',
    supports(videoInfo) {
      return videoInfo?.type === 'blob';
    },
    async download(videoInfo, context) {
      return {
        needsBlobFetch: true,
        url: videoInfo?.url,
        filename: context.filenameBase,
      };
    },
  };
}
