// lib/progress-scale.js
// 统一进度坐标系：把「同一任务各阶段各自 0..100 的原始百分比」映射到任务级的 0..100。
// 背景：Bilibili/YouTube 解析下载分为「视音频流抓取 → 浏览器内合并」两个阶段，
// 两个阶段各自的回调都是 0..100。若直接上报，进度会先涨到 100% 再跌回 0%（同一任务
// 的 Popup 条目、任务列表、页面浮条由此互相矛盾），也会让浮条在抓取阶段误判完成而提前消失。
//
// 因此按阶段分配权重，三个展示位置（Popup 条目、任务列表、页面浮条）共用本模块的
// mapPhasePercent() 结果，保证同一时刻读到同一个数字。

'use strict';

(() => {
  if (globalThis.__OVD_PROGRESS_SCALE__) {
    return;
  }

  // 阶段 → [起始, 结束]（统一进度坐标系）
  // fetching：下载（页面/后台）抓取视音频流，占总进度约 90%
  // merging：浏览器内 fMP4 合并，占 90..99%，合并完成后由 complete 补到 100%
  // 其它阶段（recording / fetching-video / segments 等单阶段策略）不在表内，原样返回。
  const PHASE_RANGES = Object.freeze({
    fetching: Object.freeze([0, 90]),
    merging: Object.freeze([90, 99]),
  });

  function normalizePercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return 0;
    }
    return numeric >= 100 ? 100 : Math.round(numeric);
  }

  /**
   * 把阶段内百分比（0..100）映射到统一进度。
   * 未登记的阶段原样返回（保持既有策略行为不变）。
   * @param {string} phase 阶段名
   * @param {number} value 阶段内百分比
   * @returns {number} 0..100
   */
  function mapPhasePercent(phase, value) {
    const range = PHASE_RANGES[phase];
    const percent = normalizePercent(value);
    if (!range) {
      return percent;
    }

    const [start, end] = range;
    const mapped = Math.round(start + ((end - start) * percent) / 100);
    return Math.max(start, Math.min(end, mapped));
  }

  globalThis.__OVD_PROGRESS_SCALE__ = Object.freeze({
    PHASE_RANGES,
    mapPhasePercent,
    normalizePercent,
  });
})();
