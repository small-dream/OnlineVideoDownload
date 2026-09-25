// background/action-badge.js
// 图标徽章：按 tab 显示该 tab 检测到的视频数（替代旧的运行中任务数徽章）。

export const BADGE_BACKGROUND_COLOR = '#0d8fd3';
export const BADGE_MAX_COUNT = 99;

// 纯函数：徽章文本，>99 显示 "99+"，无检测时为空串
export function formatBadgeCount(count) {
  const value = Number(count) || 0;
  if (value <= 0) return '';
  return value > BADGE_MAX_COUNT ? `${BADGE_MAX_COUNT}+` : String(value);
}

export function createTabBadgeManager({ action = globalThis.chrome?.action } = {}) {
  function refresh(tabId, count) {
    if (tabId == null || !action?.setBadgeText) {
      return;
    }

    try {
      action.setBadgeText({ tabId, text: formatBadgeCount(count) });
      action.setBadgeBackgroundColor?.({ tabId, color: BADGE_BACKGROUND_COLOR });
    } catch (err) {
      console.warn(`[OVD] failed to update tab badge tab=${tabId}: ${err.message}`);
    }
  }

  function clear(tabId) {
    refresh(tabId, 0);
  }

  return { clear, refresh };
}
