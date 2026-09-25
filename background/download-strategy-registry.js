import { createBlobDownloadStrategy } from './download-strategies/blob-download-strategy.js';
import { createDashDownloadStrategy } from './download-strategies/dash-download-strategy.js';
import { createDirectDownloadStrategy } from './download-strategies/direct-download-strategy.js';
import { createHlsDownloadStrategy } from './download-strategies/hls-download-strategy.js';
import { createUnsupportedDownloadStrategy } from './download-strategies/unsupported-download-strategy.js';
import { createYouTubeAdaptiveDownloadStrategy } from './download-strategies/youtube-adaptive-download-strategy.js';

export class DownloadStrategyRegistry {
  constructor(strategies = []) {
    this.strategies = strategies;
  }

  getStrategy(videoInfo) {
    return this.strategies.find((strategy) => strategy.supports(videoInfo)) || null;
  }
}

export function createDefaultDownloadStrategyRegistry() {
  return new DownloadStrategyRegistry([
    createBlobDownloadStrategy(),
    createDirectDownloadStrategy(),
    createHlsDownloadStrategy(),
    // 已解析出音视频分离流的 DASH：后台直接落盘为两个文件（不静默丢音轨）
    createDashDownloadStrategy(),
    createUnsupportedDownloadStrategy(
      'dash',
      'DASH 清单需要在页面内合并音视频：请在该视频页面打开扩展后点击下载'
    ),
    createYouTubeAdaptiveDownloadStrategy(),
    createUnsupportedDownloadStrategy('bilibili-dash', 'Bilibili DASH needs to run in the page context'),
    createUnsupportedDownloadStrategy('youtube-adaptive', 'YouTube capture mode needs the page context'),
    createDirectDownloadStrategy({ fallback: true }),
  ]);
}
