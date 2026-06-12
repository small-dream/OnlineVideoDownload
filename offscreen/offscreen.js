import '../lib/message-types.js';

const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
const MSG = messageTypes;

const transfers = new Map();

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

      default:
        return false;
    }
  } catch (err) {
    sendResponse({ ok: false, error: err.message || String(err) });
    return false;
  }
}

chrome.runtime.onMessage.addListener(handleMessage);
