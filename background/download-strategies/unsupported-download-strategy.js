export function createUnsupportedDownloadStrategy(type, message) {
  return {
    id: `unsupported:${type}`,
    supports(videoInfo) {
      return videoInfo?.type === type;
    },
    async download() {
      throw new Error(message);
    },
  };
}
