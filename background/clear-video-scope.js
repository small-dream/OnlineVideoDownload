// background/clear-video-scope.js
// CLEAR_TAB_VIDEOS 清理范围判定（纯函数）：
// content 脚本上报时 sender.tab/sender.frameId 齐全；popup 发来的消息 sender.tab 为
// undefined，只能依赖 msg.tabId。frameId 为 null/0（主框架）时做 tab 级清理，
// 仅子框架（frameId > 0）才清该 frame 的条目。

export function resolveClearVideoScope({ sender = {}, msg = {} } = {}) {
  const tabId = sender?.tab?.id ?? msg?.tabId ?? null;
  const rawFrameId = sender?.frameId ?? msg?.frameId ?? null;
  const frameId = Number.isFinite(rawFrameId) && rawFrameId > 0 ? rawFrameId : null;
  return { frameId, tabId };
}
