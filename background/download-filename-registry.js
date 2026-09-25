// background/download-filename-registry.js
//
// 有些站点/CDN 会把有效媒体标成 text/plain（例如现场环境），浏览器下载管理器
// 于是按 MIME 给文件名追加扩展名：`xxx_2160p.mp4` → `xxx_2160p.mp4.txt`。
// 内容其实是能正常播放的视频，只是后缀不对。
//
// 解决方式：提交下载时登记"我们想要的相对文件名"，再用
// chrome.downloads.onDeterminingFilename 把浏览器拟定的名字改回来
// （绝不删除文件；改不动就保持原样）。

const pendingNames = new Map();
const MAX_ENTRIES = 200;

/** 提交下载后登记 intendedFilename（相对 Downloads 的路径） */
export function rememberDownloadFilename(downloadId, intendedFilename) {
  if (downloadId == null || downloadId === '') {
    return false;
  }
  const id = Number(downloadId);
  const name = typeof intendedFilename === 'string' ? intendedFilename.trim() : '';
  if (!Number.isFinite(id) || !name) {
    return false;
  }
  pendingNames.set(id, { name, at: Date.now() });
  if (pendingNames.size > MAX_ENTRIES) {
    const oldest = pendingNames.keys().next().value;
    pendingNames.delete(oldest);
  }
  return true;
}

export function takeDownloadFilename(downloadId) {
  const id = Number(downloadId);
  const entry = pendingNames.get(id);
  if (!entry) {
    return '';
  }
  pendingNames.delete(id);
  return entry.name;
}

export function peekDownloadFilename(downloadId) {
  return pendingNames.get(Number(downloadId))?.name || '';
}

export function clearDownloadFilenames() {
  pendingNames.clear();
}

const SPURIOUS_SUFFIX_PATTERN = /^(.*\.(?:mp4|m4v|m4a|mp3|webm|mkv|mov|flv|aac|ogg|oga|wav|ts))\.(?:txt|html?|xml)$/i;

/**
 * 去掉浏览器按 MIME 追加的伪后缀（`x.mp4.txt` → `x.mp4`）。
 * 只处理"媒体扩展名 + 文本类后缀"这一种形态，其它文件名原样返回。
 */
export function stripSpuriousMimeSuffix(filename) {
  const name = typeof filename === 'string' ? filename : '';
  const match = name.match(SPURIOUS_SUFFIX_PATTERN);
  return match ? match[1] : name;
}

export function listPendingDownloadFilenames() {
  return [...pendingNames.entries()].map(([id, entry]) => ({ id, name: entry.name }));
}
