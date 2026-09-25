import '../lib/download-path.js';
import '../lib/settings-store.js';
import '../lib/video-utils.js';
import { createDefaultDownloadStrategyRegistry } from './download-strategy-registry.js';
import { HlsFetcher } from './hls-fetcher.js';

const { buildFilenameBase } = globalThis.__OVD_VIDEO_UTILS__;
const settingsStore = globalThis.__OVD_GENERAL_SETTINGS_STORE__;
const downloadPathUtils = globalThis.__OVD_DOWNLOAD_PATH__ || {};

export class Downloader {
  constructor() {
    this.hlsFetcher = new HlsFetcher();
    this.strategyRegistry = createDefaultDownloadStrategyRegistry();
  }

  async download(videoInfo, tabId, options = {}) {
    const { url, type } = videoInfo || {};
    const filenameBase = await this._buildFilenameBase(videoInfo, tabId);
    console.log(`[OVD] download request type=${type} filename="${filenameBase}" tabId=${tabId} url=${url}`);

    const strategy = this.strategyRegistry.getStrategy(videoInfo);
    if (!strategy) {
      throw new Error(`No download strategy registered for type: ${type || 'unknown'}`);
    }

    return strategy.download(videoInfo, {
      filenameBase,
      hlsFetcher: this.hlsFetcher,
      tabId,
      ...options,
    });
  }

  async _buildFilenameBase(videoInfo, tabId) {
    const tabTitle = await this._getTabTitle(tabId);
    const rawFilenameBase = buildFilenameBase({
      fallback: 'video',
      tabTitle,
      title: videoInfo?.title,
      type: videoInfo?.type,
      url: videoInfo?.url,
    });
    const filenameBase = await downloadPathUtils.applyDownloadNaming?.(rawFilenameBase, videoInfo, settingsStore)
      ?? await downloadPathUtils.applyDownloadSubdir?.(rawFilenameBase, settingsStore);

    console.log(`[OVD] filename base="${filenameBase}" tabTitle="${tabTitle || ''}"`);
    return filenameBase;
  }

  async _getTabTitle(tabId) {
    if (!tabId) {
      return '';
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      const title = typeof tab?.title === 'string' ? tab.title.trim() : '';
      return title || '';
    } catch {
      return '';
    }
  }
}
