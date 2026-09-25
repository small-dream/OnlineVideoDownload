// background/save-location.js
// 读取「每次询问保存位置」设置，供 chrome.downloads.download 的 saveAs 使用。

import '../lib/settings-store.js';

export async function resolveSaveAs() {
  try {
    const settings = await globalThis.__OVD_GENERAL_SETTINGS_STORE__?.getSettings?.() || {};
    return !!settings.askSaveLocation;
  } catch (err) {
    console.warn(`[OVD] 读取保存位置设置失败: ${err.message}`);
    return false;
  }
}
