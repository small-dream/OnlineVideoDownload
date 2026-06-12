// background/header-injector.js
// 使用 declarativeNetRequest 动态规则，在 HLS/视频下载时临时注入请求头和 CORS 响应头
// 解决两个问题：
// 1. CDN 校验 Referer/Origin → 注入正确的请求头
// 2. SW fetch 跨域 CORS 限制 → 注入 Access-Control-Allow-Origin 响应头

// 动态规则 ID 范围：10000 起步，避免与其他规则冲突
let _nextRuleId = 10000;

// 当前活跃的规则集 Map<groupKey, ruleId[]>
const _activeRules = new Map();

/**
 * 为指定域名注入请求头 + CORS 响应头，返回清理函数
 * @param {string} targetUrl - 目标 URL（用于提取域名）
 * @param {Object} headers - 要注入的请求头 { Referer?: string, Origin?: string }
 * @returns {Promise<() => Promise<void>>} cleanup 函数
 */
export async function injectHeaders(targetUrl, headers) {
  let domain;
  try {
    domain = new URL(targetUrl).hostname;
  } catch {
    domain = targetUrl;
  }

  const addRules = [];
  const ruleIds = [];

  const requestHeaderOps = [];
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (!value) continue;
      const lowerName = name.toLowerCase();
      if (lowerName === 'referer' || lowerName === 'origin') {
        requestHeaderOps.push({ header: lowerName, operation: 'set', value });
      }
    }
  }

  // Include navigation/download-like requests so chrome.downloads.download
  // can also inherit the temporary Referer/Origin rules.
  const headerResourceTypes = [
    'xmlhttprequest',
    'other',
    'media',
    'main_frame',
    'sub_frame',
    'object',
  ];

  if (requestHeaderOps.length > 0) {
    const ruleId = _nextRuleId++;
    ruleIds.push(ruleId);
    addRules.push({
      id: ruleId,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: requestHeaderOps },
      condition: { urlFilter: `||${domain}`, resourceTypes: headerResourceTypes },
    });
    console.log(`[OVD] 注入请求头规则 ruleId=${ruleId} domain=${domain} headers=${requestHeaderOps.map(h => h.header + '=' + h.value).join(', ')}`);
  }

  const corsRuleId = _nextRuleId++;
  ruleIds.push(corsRuleId);
  addRules.push({
    id: corsRuleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'access-control-allow-origin', operation: 'set', value: '*' },
        { header: 'access-control-allow-methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
      ],
    },
    condition: { urlFilter: `||${domain}`, resourceTypes: headerResourceTypes },
  });
  console.log(`[OVD] 注入 CORS 响应头规则 ruleId=${corsRuleId} domain=${domain}`);

  if (addRules.length === 0) return async () => {};

  await chrome.declarativeNetRequest.updateDynamicRules({ addRules, removeRuleIds: [] });

  const groupKey = `${domain}-${Date.now()}`;
  _activeRules.set(groupKey, ruleIds);
  console.log(`[OVD] declarativeNetRequest 规则已注册 groupKey=${groupKey} ruleIds=${ruleIds.join(',')}`);

  return async () => {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIds, addRules: [] });
      console.log(`[OVD] declarativeNetRequest 规则已清理 groupKey=${groupKey}`);
    } catch (err) {
      console.warn(`[OVD] failed to cleanup declarativeNetRequest rules groupKey=${groupKey}: ${err.message}`);
    }
    _activeRules.delete(groupKey);
  };
}

/**
 * 清理所有动态规则（用于扩展初始化时防止残留）
 */
export async function cleanupAllRules() {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const idsToRemove = existingRules.filter(r => r.id >= 10000).map(r => r.id);
    if (idsToRemove.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: idsToRemove, addRules: [] });
      console.log(`[OVD] 启动清理残留规则 ${idsToRemove.length} 条`);
    }
  } catch (err) {
    console.warn(`[OVD] failed to cleanup residual dynamic rules: ${err.message}`);
  }
  _activeRules.clear();
}
