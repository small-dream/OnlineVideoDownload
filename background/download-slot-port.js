// background/download-slot-port.js
// Popup ↔ Service Worker 的下载槽位协议（Port 通道）。
//
// Popup 在发起「内容侧下载」（Bilibili / YouTube 页面内下载）前先申请槽位，
// 让内容侧下载与后台下载共用同一个并发上限；Popup 关闭时端口断开，
// 后台按 owner 回收该端口持有的槽位（含仍在排队的条目）。
//
// 协议（Popup → SW）：
//   { type: 'ACQUIRE', id, entry } → { type: 'SLOT_ADMITTED', id }
//                                  | { type: 'SLOT_ABORTED', id, error }
//   { type: 'RELEASE', id }        → { type: 'SLOT_RELEASED', id, released }
//   { type: 'CANCEL', id }         → { type: 'SLOT_CANCELLED', id, cancelled }
//   { type: 'PING' }               → { type: 'SLOT_READY', owner, queue }
//
// 返回 null 表示该消息不需要回包。

export async function handleDownloadSlotMessage(queue, owner, message = {}) {
  const id = String(message.id || '');

  switch (message.type) {
    case 'ACQUIRE': {
      const entry = message.entry || {};
      const slotId = id || `slot-${owner}-${Date.now()}`;
      try {
        await queue.acquire({ ...entry, id: slotId, owner });
        return { id: slotId, type: 'SLOT_ADMITTED' };
      } catch (err) {
        return { error: err?.message || String(err), id: slotId, type: 'SLOT_ABORTED' };
      }
    }

    case 'RELEASE':
      return { id, released: queue.release(id), type: 'SLOT_RELEASED' };

    case 'CANCEL':
      return { cancelled: queue.cancelQueued(id), id, type: 'SLOT_CANCELLED' };

    case 'PING':
      return { owner, queue: queue.snapshot(), type: 'SLOT_READY' };

    default:
      return null;
  }
}
