import '../lib/byte-utils.js';
import '../lib/constants.js';
import '../lib/download-path.js';
import '../lib/message-types.js';
import { resolveSaveAs } from './save-location.js';
import { rememberDownloadFilename } from './download-filename-registry.js';

const byteUtils = globalThis.__OVD_BYTE_UTILS__ || {};
const constants = globalThis.__OVD_CONSTANTS__ || {};
const downloadPathUtils = globalThis.__OVD_DOWNLOAD_PATH__ || {};
const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
const MSG = messageTypes;

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';
const OBJECT_URL_REVOKE_DELAY = constants.OBJECT_URL_REVOKE_DELAY || 60000;
const BLOB_TRANSFER_CHUNK_SIZE = constants.BLOB_TRANSFER_CHUNK_SIZE || 256 * 1024;

let creatingOffscreenDocument = null;

function uint8ArrayToBase64Fallback(uint8Array) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < uint8Array.length; i += step) {
    const slice = uint8Array.subarray(i, i + step);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

const uint8ArrayToBase64 = byteUtils.uint8ArrayToBase64 || uint8ArrayToBase64Fallback;

async function hasOffscreenDocument(path = OFFSCREEN_DOCUMENT_PATH) {
  const documentUrl = chrome.runtime.getURL(path);

  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl],
    });
    return contexts.length > 0;
  }

  if (typeof chrome.offscreen?.hasDocument === 'function') {
    return chrome.offscreen.hasDocument();
  }

  return false;
}

async function ensureOffscreenDocument(path = OFFSCREEN_DOCUMENT_PATH) {
  if (!chrome.offscreen?.createDocument) {
    throw new Error('Offscreen API is unavailable');
  }

  if (await hasOffscreenDocument(path)) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      justification: 'Create object URLs for blob-backed downloads after the page is closed',
      reasons: ['BLOBS'],
      url: path,
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }

  await creatingOffscreenDocument;
}

function sendOffscreenMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function createObjectUrlInOffscreen(blob, filename, mimeType, taskMeta = {}) {
  await ensureOffscreenDocument();

  const transferId = `offscreen_blob_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());

  await sendOffscreenMessage({
    filename,
    mimeType,
    taskMeta,
    transferId,
    type: MSG.OFFSCREEN_BLOB_DOWNLOAD_START || 'OFFSCREEN_BLOB_DOWNLOAD_START',
  });

  for (let offset = 0; offset < bytes.length; offset += BLOB_TRANSFER_CHUNK_SIZE) {
    const chunk = bytes.slice(offset, offset + BLOB_TRANSFER_CHUNK_SIZE);
    await sendOffscreenMessage({
      chunkBase64: uint8ArrayToBase64(chunk),
      transferId,
      type: MSG.OFFSCREEN_BLOB_DOWNLOAD_CHUNK || 'OFFSCREEN_BLOB_DOWNLOAD_CHUNK',
    });
  }

  const response = await sendOffscreenMessage({
    transferId,
    type: MSG.OFFSCREEN_BLOB_DOWNLOAD_FINISH || 'OFFSCREEN_BLOB_DOWNLOAD_FINISH',
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Offscreen blob handoff failed');
  }

  return {
    filename: response.filename || filename,
    objectUrl: response.objectUrl,
    transferId,
  };
}

async function revokeOffscreenObjectUrl(transferId, objectUrl) {
  if (!transferId && !objectUrl) {
    return;
  }

  try {
    await sendOffscreenMessage({
      objectUrl,
      transferId,
      type: MSG.OFFSCREEN_BLOB_DOWNLOAD_ABORT || 'OFFSCREEN_BLOB_DOWNLOAD_ABORT',
    });
  } catch (err) {
    console.warn(`[OVD] failed to revoke offscreen object URL: ${err.message}`);
  }
}

async function submitBlobDownloadFromOffscreen(blob, filename, mimeType, taskMeta = {}) {
  const { objectUrl, transferId, filename: finalFilename } = await createObjectUrlInOffscreen(
    blob,
    filename,
    mimeType,
    taskMeta
  );
  const downloadFilename = await downloadPathUtils.applyDownloadSubdir?.(finalFilename);
  const saveAs = await resolveSaveAs();
  console.log(
    `[OVD] 保存 blob 文件 filename="${downloadFilename}" mime=${mimeType || blob?.type || '(none)'} size=${blob?.size ?? 0}`
  );

  const downloadResult = await new Promise((resolve) => {
    chrome.downloads.download({
      filename: downloadFilename,
      saveAs: saveAs,
      url: objectUrl,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      resolve({ ok: true, downloadId });
    });
  });

  if (!downloadResult.ok) {
    await revokeOffscreenObjectUrl(transferId, objectUrl);
    return downloadResult;
  }

  rememberDownloadFilename(downloadResult.downloadId, downloadFilename);

  setTimeout(() => {
    void revokeOffscreenObjectUrl(transferId, objectUrl);
  }, OBJECT_URL_REVOKE_DELAY);

  return {
    downloadId: downloadResult.downloadId,
    filename: downloadFilename,
    ok: true,
  };
}

/**
 * 把已经落到 OPFS 的流交给浏览器下载。
 * SW 里没有 URL.createObjectURL，由 offscreen 文档按文件名打开同一份 OPFS 文件
 * 生成对象 URL；双方共享扩展 origin 的 OPFS，因此不需要传输字节。
 */
async function submitOpfsDownloadFromOffscreen(opfsName, filename, mimeType, taskMeta = {}) {
  if (!opfsName) {
    return { error: 'OPFS 文件名为空', ok: false };
  }

  await ensureOffscreenDocument();

  let openResult;
  try {
    openResult = await sendOffscreenMessage({
      mimeType,
      name: opfsName,
      taskMeta,
      type: MSG.OFFSCREEN_OPFS_DOWNLOAD_OPEN || 'OFFSCREEN_OPFS_DOWNLOAD_OPEN',
    });
  } catch (err) {
    return { error: `OPFS 对象 URL 创建失败: ${err.message}`, ok: false };
  }

  if (!openResult?.ok || !openResult.objectUrl) {
    return { error: openResult?.error || 'OPFS 对象 URL 创建失败', ok: false };
  }

  const downloadFilename = await downloadPathUtils.applyDownloadSubdir?.(filename);
  const saveAs = await resolveSaveAs();

  const downloadResult = await new Promise((resolve) => {
    chrome.downloads.download({
      filename: downloadFilename,
      saveAs,
      url: openResult.objectUrl,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message, ok: false });
        return;
      }
      resolve({ downloadId, ok: true });
    });
  });

  if (!downloadResult.ok) {
    await releaseOpfsDownload({ name: opfsName, objectUrl: openResult.objectUrl });
    return downloadResult;
  }

  console.log(
    `[OVD] OPFS 文件已提交下载 downloadId=${downloadResult.downloadId} name=${opfsName} `
    + `size=${openResult.byteLength || 0} mime=${mimeType || '(none)'} filename="${downloadFilename}"`
  );
  rememberDownloadFilename(downloadResult.downloadId, downloadFilename);

  return {
    downloadId: downloadResult.downloadId,
    filename: downloadFilename,
    ok: true,
    opfsName,
    objectUrl: openResult.objectUrl,
    size: openResult.byteLength || null,
  };
}

/** 释放对象 URL 并删除 OPFS 临时文件（下载完成/失败/中断后调用） */
async function releaseOpfsDownload({ name = '', objectUrl = '' } = {}) {
  if (!name && !objectUrl) {
    return;
  }

  try {
    await sendOffscreenMessage({
      name,
      objectUrl,
      type: MSG.OFFSCREEN_OPFS_DOWNLOAD_RELEASE || 'OFFSCREEN_OPFS_DOWNLOAD_RELEASE',
    });
  } catch (err) {
    console.warn(`[OVD] 释放 OPFS 临时文件失败 name=${name}: ${err.message}`);
  }
}

export {
  ensureOffscreenDocument,
  releaseOpfsDownload,
  revokeOffscreenObjectUrl,
  submitBlobDownloadFromOffscreen,
  submitOpfsDownloadFromOffscreen,
};
