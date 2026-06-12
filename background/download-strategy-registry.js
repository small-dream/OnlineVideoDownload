import { createBlobDownloadStrategy } from './download-strategies/blob-download-strategy.js';
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
    createUnsupportedDownloadStrategy('dash', 'DASH streams require content-side merging'),
    createYouTubeAdaptiveDownloadStrategy(),
    createUnsupportedDownloadStrategy('bilibili-dash', 'Bilibili DASH needs to run in the page context'),
    createUnsupportedDownloadStrategy('youtube-adaptive', 'YouTube capture mode needs the page context'),
    createDirectDownloadStrategy({ fallback: true }),
  ]);
}
