import '../lib/message-types.js';
import '../lib/opfs-sink.js';

const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
const MSG = messageTypes;
const opfsSink = globalThis.__OVD_OPFS_SINK__ || {};

const transfers = new Map();
// OPFS 文件名 → 对象 URL：SW 只传文件名，双方共享同一扩展 origin 的 OPFS
const opfsObjectUrls = new Map();

function normalizeBinaryPayload(payload) {
  if (payload instanceof ArrayBuffer) {
    return payload;
  }

  if (ArrayBuffer.isView(payload)) {
    return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  }

  if (Array.isArray(payload)) {
    return Uint8Array.from(payload).buffer;
  }

  throw new Error('Invalid binary payload');
}

function base64ToUint8Array(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function normalizeFilename(filename, mimeType = '') {
  const safe = String(filename || 'video').trim() || 'video';
  if (/\.[a-z0-9]{2,5}$/i.test(safe)) {
    return safe;
  }

  if (String(mimeType).includes('mp4')) {
    return `${safe}.mp4`;
  }

  return `${safe}.ts`;
}

function handleMessage(message, _sender, sendResponse) {
  try {
    switch (message?.type) {
      case MSG.OFFSCREEN_BLOB_DOWNLOAD_START || 'OFFSCREEN_BLOB_DOWNLOAD_START': {
        if (!message.transferId) {
          throw new Error('Missing transferId');
        }

        transfers.set(message.transferId, {
          chunks: [],
          filename: normalizeFilename(message.filename, message.mimeType),
          mimeType: message.mimeType || 'video/mp2t',
          objectUrl: '',
          taskMeta: message.taskMeta || {},
        });
        sendResponse({ ok: true });
        return false;
      }

      case MSG.OFFSCREEN_BLOB_DOWNLOAD_CHUNK || 'OFFSCREEN_BLOB_DOWNLOAD_CHUNK': {
        const transfer = transfers.get(message.transferId);
        if (!transfer) {
          throw new Error('Transfer not found');
        }

        transfer.chunks.push(base64ToUint8Array(message.chunkBase64));
        sendResponse({ ok: true });
        return false;
      }

      case MSG.OFFSCREEN_BLOB_DOWNLOAD_FINISH || 'OFFSCREEN_BLOB_DOWNLOAD_FINISH': {
        const transfer = transfers.get(message.transferId);
        if (!transfer) {
          throw new Error('Transfer not found');
        }

        transfers.delete(message.transferId);
        const blob = new Blob(transfer.chunks, { type: transfer.mimeType });
        const objectUrl = URL.createObjectURL(blob);
        transfer.objectUrl = objectUrl;
        sendResponse({
          filename: transfer.filename,
          objectUrl,
          ok: true,
          taskMeta: transfer.taskMeta,
        });
        return false;
      }

      case MSG.OFFSCREEN_BLOB_DOWNLOAD_ABORT || 'OFFSCREEN_BLOB_DOWNLOAD_ABORT': {
        const transfer = message.transferId ? transfers.get(message.transferId) : null;
        const objectUrl = message.objectUrl || transfer?.objectUrl || '';
        if (objectUrl) {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch (err) {
            console.warn(`[OVD] failed to revoke offscreen object URL: ${err.message}`);
          }
        }
        if (message.transferId) {
          transfers.delete(message.transferId);
        }
        sendResponse({ ok: true });
        return false;
      }

      case MSG.OFFSCREEN_OPFS_DOWNLOAD_OPEN || 'OFFSCREEN_OPFS_DOWNLOAD_OPEN': {
        if (!message.name) {
          throw new Error('Missing OPFS file name');
        }
        handleOpfsOpen(message)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err.message || String(err), ok: false }));
        return true;
      }

      case MSG.OFFSCREEN_OPFS_DOWNLOAD_RELEASE || 'OFFSCREEN_OPFS_DOWNLOAD_RELEASE': {
        releaseOpfsEntry(message)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err.message || String(err), ok: false }));
        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    sendResponse({ ok: false, error: err.message || String(err) });
    return false;
  }
}

/**
 * 把 OPFS 文件暴露成对象 URL。
 * getFile() 拿到的是文件后端 File，交给 Blob URL 后无需把整份数据读进 JS 堆。
 */
async function handleOpfsOpen(message) {
  const name = String(message.name);
  const existing = opfsObjectUrls.get(name);
  if (existing?.objectUrl) {
    return { byteLength: existing.byteLength, name, objectUrl: existing.objectUrl, ok: true, reused: true };
  }

  const file = await opfsSink.readFile?.(name);
  if (!file) {
    throw new Error(`OPFS 文件不存在: ${name}`);
  }

  // 从 OPFS 取出的 File 类型是空的：不显式包装成带 MIME 的 Blob 时，
  // 浏览器无法判断媒体类型，可能按错误类型给文件名追加扩展名（现场 .mp4.txt）
  const typedBlob = message.mimeType ? new Blob([file], { type: String(message.mimeType) }) : file;
  const objectUrl = URL.createObjectURL(typedBlob);
  opfsObjectUrls.set(name, { byteLength: file.size, objectUrl });
  console.log(
    `[OVD] OPFS 文件已暴露为对象 URL name=${name} size=${file.size} mime=${message.mimeType || '(none)'}`
  );

  return { byteLength: file.size, name, objectUrl, ok: true };
}

async function releaseOpfsEntry(message) {
  const entry = message.name ? opfsObjectUrls.get(message.name) : null;
  const objectUrl = message.objectUrl || entry?.objectUrl || '';

  if (objectUrl) {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      console.warn(`[OVD] failed to revoke OPFS object URL: ${err.message}`);
    }
  }

  if (message.name) {
    opfsObjectUrls.delete(message.name);
  }

  // 只删除本扩展创建的临时文件，避免误删其它数据
  if (message.name && String(message.name).startsWith('ovd-')) {
    await opfsSink.removeFile?.(String(message.name));
  }

  return { ok: true };
}

chrome.runtime.onMessage.addListener(handleMessage);
