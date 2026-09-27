'use strict';

// 字幕工具（shared：content script / popup / service worker / 测试）
//
// 各来源字幕的原始格式不同，这里统一成一条流水线：
//   原始响应（WebVTT / YouTube json3 / YouTube srv3 XML / Bilibili JSON / SRT）
//     → parseSubtitleText()  → cue 列表 [{ start, end, text }]
//     → cuesToSrt()          → SRT 文本（作为侧车文件保存为 .srt）
// 全部是纯函数（不依赖 chrome / DOM），便于三端复用与单测。

(() => {
  if (globalThis.__OVD_SUBTITLE_UTILS__) {
    return;
  }

  const DEFAULT_CUE_DURATION_SECONDS = 2;
  const DEFAULT_SUBTITLE_LANGUAGE = 'und';
  const DEFAULT_SUBTITLE_EXTENSION = '.srt';
  // YouTube 字幕接口按 fmt 返回不同格式：json3 结构最稳、vtt 覆盖面好、srv3 兼容老接口
  const YOUTUBE_CAPTION_FORMATS = Object.freeze(['json3', 'vtt', 'srv3']);
  const YOUTUBE_CAPTION_HOST_PATTERN = /(^|\.)youtube\.com$/i;
  // 三种时间戳写法：HH:MM:SS,mmm（SRT）/ HH:MM:SS.mmm（VTT）/ MM:SS.mmm
  const TIMESTAMP_PATTERN = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/;
  const FILENAME_ILLEGAL_PATTERN = /[\\/:*?"<>|\u0000-\u001f]/g;

  // 忽略大小写与 BCP-47 后缀差异（zh-Hans / zh-CN 都算 zh）
  function primaryLanguageTag(languageCode = '') {
    return String(languageCode || '').trim().toLowerCase().split(/[-_]/)[0];
  }

  function decodeHtmlEntities(text) {
    // &amp; 必须最后替换，否则 "&amp;lt;" 会被二次解码
    return String(text ?? '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  /** 去掉字幕文本里的标签（<c>/<v>/<00:00:01.000>/<br> 等）与转义实体，保留换行 */
  function stripCaptionMarkup(text) {
    const flattened = String(text ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/\r\n?/g, '\n');

    return decodeHtmlEntities(flattened)
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  function toSeconds(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  /** 解析 SRT/VTT 时间戳（HH:MM:SS,mmm / HH:MM:SS.mmm / MM:SS.mmm），失败返回 NaN */
  function parseTimestampToSeconds(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : NaN;
    }

    const raw = String(value ?? '').trim();
    if (!raw) {
      return NaN;
    }

    const matched = TIMESTAMP_PATTERN.exec(raw);
    if (!matched) {
      return toSeconds(raw);
    }

    const hours = Number(matched[1] || 0);
    const minutes = Number(matched[2] || 0);
    const seconds = Number(matched[3] || 0);
    const milliseconds = Number(String(matched[4] || '0').padEnd(3, '0'));
    return (hours * 3600) + (minutes * 60) + seconds + (milliseconds / 1000);
  }

  function padNumber(value, length) {
    return String(Math.max(0, Math.trunc(value))).padStart(length, '0');
  }

  /** 秒 → SRT 时间戳 00:00:01,500 */
  function formatSrtTimestamp(seconds) {
    const totalMilliseconds = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    const hours = Math.floor(totalMilliseconds / 3600000);
    const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
    const secs = Math.floor((totalMilliseconds % 60000) / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return [
      padNumber(hours, 2),
      padNumber(minutes, 2),
      padNumber(secs, 2),
    ].join(':') + `,${padNumber(milliseconds, 3)}`;
  }

  /**
   * 清洗 cue 列表：丢弃空文本，补齐缺失/倒挂的结束时间，按开始时间排序。
   * 后续所有解析器都返回这里的产物，保证下游（SRT 输出、UI 计数）拿到同一形状。
   */
  function normalizeCues(cues) {
    if (!Array.isArray(cues)) {
      return [];
    }

    const normalized = [];
    for (const cue of cues) {
      const text = stripCaptionMarkup(cue?.text);
      if (!text) {
        continue;
      }

      const start = toSeconds(cue?.start);
      if (!Number.isFinite(start) || start < 0) {
        continue;
      }

      const declaredEnd = toSeconds(cue?.end);
      const end = Number.isFinite(declaredEnd) && declaredEnd > start
        ? declaredEnd
        : start + DEFAULT_CUE_DURATION_SECONDS;
      normalized.push({ end, start, text });
    }

    normalized.sort((left, right) => left.start - right.start || left.end - right.end);
    return normalized;
  }

  /** cue 列表 → SRT 文本（每个 cue 一个序号块，块间空行） */
  function cuesToSrt(cues) {
    const list = normalizeCues(cues);
    return list
      .map((cue, index) => [
        String(index + 1),
        `${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}`,
        cue.text,
        '',
      ].join('\n'))
      .join('\n');
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function toJsonPayload(input) {
    if (typeof input !== 'string') {
      return input;
    }
    const trimmed = input.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return null;
    }
    return safeJsonParse(trimmed);
  }

  // ============================================================
  // YouTube
  // ============================================================

  /**
   * YouTube `fmt=json3` 字幕（player 的默认字幕接口响应）。
   * 事件缺 dDurationMs 时用下一条事件的起点兜底，最后一条补默认时长。
   */
  function parseYouTubeJson3Captions(input) {
    const payload = toJsonPayload(input);
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const cues = [];

    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (!event || typeof event !== 'object') {
        continue;
      }

      const segments = Array.isArray(event.segs) ? event.segs : [];
      const text = segments.map((segment) => (segment && segment.utf8) || '').join('');
      if (!text.trim()) {
        continue;
      }

      const startMs = Number(event.tStartMs);
      const start = (Number.isFinite(startMs) ? startMs : 0) / 1000;
      let durationMs = Number(event.dDurationMs);
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        const nextStartMs = Number(events[index + 1]?.tStartMs);
        durationMs = Number.isFinite(nextStartMs) && Number.isFinite(startMs)
          ? Math.max(0, nextStartMs - startMs)
          : DEFAULT_CUE_DURATION_SECONDS * 1000;
      }

      cues.push({ end: start + (durationMs / 1000), start, text });
    }

    return normalizeCues(cues);
  }

  function parseSimpleAttributes(source) {
    const attributes = {};
    const pattern = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
    let matched = pattern.exec(String(source || ''));
    while (matched) {
      attributes[matched[1].toLowerCase()] = matched[2];
      matched = pattern.exec(String(source || ''));
    }
    return attributes;
  }

  function parseYouTubeParagraphs(source, cues) {
    // srv3：<p t="1240" d="2480"><s>文本</s></p>（t/d 单位毫秒）
    const pattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let matched = pattern.exec(source);
    while (matched) {
      const attributes = parseSimpleAttributes(matched[1]);
      const startMs = Number(attributes.t);
      const durationMs = Number(attributes.d);
      const start = (Number.isFinite(startMs) ? startMs : 0) / 1000;
      const duration = Number.isFinite(durationMs) && durationMs > 0
        ? durationMs / 1000
        : DEFAULT_CUE_DURATION_SECONDS;
      cues.push({ end: start + duration, start, text: matched[2] });
      matched = pattern.exec(source);
    }
  }

  function parseYouTubeTextNodes(source, cues) {
    // srv1：<text start="1.5" dur="2.3">文本</text>（单位秒）
    const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let matched = pattern.exec(source);
    while (matched) {
      const attributes = parseSimpleAttributes(matched[1]);
      const start = toSeconds(attributes.start);
      const duration = toSeconds(attributes.dur);
      cues.push({
        end: (Number.isFinite(start) ? start : 0)
          + (Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_CUE_DURATION_SECONDS),
        start: Number.isFinite(start) ? start : 0,
        text: matched[2],
      });
      matched = pattern.exec(source);
    }
  }

  /** YouTube srv3 / srv2 / srv1（XML）字幕 */
  function parseYouTubeXmlCaptions(input) {
    const source = String(input ?? '');
    const cues = [];
    parseYouTubeParagraphs(source, cues);
    parseYouTubeTextNodes(source, cues);
    return normalizeCues(cues);
  }

  /**
   * 给 YouTube 字幕地址换成指定 fmt。
   * 刻意用字符串替换而不是 URL API：URLSearchParams 会重新编码 `sparams=ip,ipbits,...`
   * 里的逗号，可能破坏签名校验。
   */
  function youTubeCaptionUrlWithFormat(url, format = 'json3') {
    const raw = String(url || '').trim();
    if (!raw) {
      return '';
    }
    if (!format) {
      return raw;
    }

    const stripped = raw
      .replace(/([?&])fmt=[^&#]*/g, '$1')
      .replace(/\?&/g, '?')
      .replace(/&&+/g, '&')
      .replace(/[?&]$/, '');
    const separator = stripped.includes('?') ? '&' : '?';
    return `${stripped}${separator}fmt=${encodeURIComponent(format)}`;
  }

  /** 是否是 YouTube 的 timedtext 字幕接口地址（这类地址需要按 fmt 变体重试） */
  function isYouTubeCaptionUrl(url = '') {
    try {
      const parsed = new URL(String(url));
      return YOUTUBE_CAPTION_HOST_PATTERN.test(parsed.hostname)
        && /timedtext$/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  /**
   * 构造字幕取流尝试序列。
   * YouTube：按 fmt 逐个重试（每种格式的解析方式不同，见 parseSubtitleText）；
   * 其它来源（Bilibili 字幕 CDN / HLS 独立字幕）：单次请求 + 自动识别格式。
   * @returns {Array<{ credentials: string, format: string, url: string, contentType?: string }>}
   */
  function buildSubtitleFetchAttempts(url = '', requestedFormat = '') {
    const target = String(url || '').trim();
    const format = String(requestedFormat || '').trim();
    if (!isYouTubeCaptionUrl(target)) {
      return [{ credentials: 'omit', format: format || 'auto', url: target }];
    }

    const ordered = format && YOUTUBE_CAPTION_FORMATS.includes(format)
      ? [format, ...YOUTUBE_CAPTION_FORMATS.filter((item) => item !== format)]
      : (format ? [format, ...YOUTUBE_CAPTION_FORMATS] : [...YOUTUBE_CAPTION_FORMATS]);

    return ordered.map((item) => ({
      contentType: item === 'vtt' ? 'text/vtt' : '',
      credentials: 'include',
      format: item,
      url: youTubeCaptionUrlWithFormat(target, item),
    }));
  }

  // ============================================================
  // Bilibili
  // ============================================================

  /** Bilibili 字幕 JSON：{ body: [{ from, to, content }] } */
  function parseBilibiliSubtitleJson(input) {
    const payload = toJsonPayload(input);
    const body = Array.isArray(payload?.body) ? payload.body : [];
    return normalizeCues(body.map((item) => ({
      end: item?.to,
      start: item?.from,
      text: item?.content,
    })));
  }

  // ============================================================
  // WebVTT / SRT
  // ============================================================

  function parseVttCueTiming(line) {
    const [startRaw, endRaw] = String(line).split(/\s*-->\s*/);
    const start = parseTimestampToSeconds(startRaw);
    const end = parseTimestampToSeconds(String(endRaw || '').trim().split(/\s+/)[0]);
    if (!Number.isFinite(start)) {
      return null;
    }
    return { end, start };
  }

  /** WebVTT（HLS 独立字幕轨 / YouTube fmt=vtt） */
  function parseVttSubtitles(input) {
    const lines = String(input ?? '').replace(/\r\n?/g, '\n').split('\n');
    const cues = [];
    let current = null;

    const flush = () => {
      if (current) {
        cues.push({ end: current.end, start: current.start, text: current.lines.join('\n') });
        current = null;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        flush();
        continue;
      }

      if (current) {
        current.lines.push(line);
        continue;
      }

      if (line.includes('-->')) {
        const timing = parseVttCueTiming(line);
        if (timing) {
          current = { end: timing.end, lines: [], start: timing.start };
        }
        continue;
      }
      // 其余行是 WEBVTT 头 / NOTE / STYLE / REGION / cue 标识，忽略
    }

    flush();
    return normalizeCues(cues);
  }

  /** SRT 文本 → cue 列表（用于回读/兜底，例如服务器直接返回 SRT） */
  function parseSrtSubtitles(input) {
    const blocks = String(input ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    const cues = [];

    for (const block of blocks) {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex === -1) {
        continue;
      }

      const timing = parseVttCueTiming(lines[timingIndex]);
      if (!timing) {
        continue;
      }
      cues.push({
        end: timing.end,
        start: timing.start,
        text: lines.slice(timingIndex + 1).join('\n'),
      });
    }

    return normalizeCues(cues);
  }

  // ============================================================
  // 统一入口
  // ============================================================

  /** 依据响应内容/MIME 猜测字幕格式 */
  function detectSubtitleFormat(text, contentType = '') {
    const trimmed = String(text ?? '').trimStart();
    const mime = String(contentType || '').toLowerCase();

    if (/^WEBVTT/i.test(trimmed) || mime.includes('text/vtt')) {
      return 'vtt';
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const payload = safeJsonParse(trimmed);
      if (Array.isArray(payload?.body)) {
        return 'bilibili';
      }
      if (Array.isArray(payload?.events)) {
        return 'json3';
      }
      return 'bilibili';
    }

    if (trimmed.startsWith('<')) {
      return 'srv3';
    }

    return 'srt';
  }

  /**
   * 统一入口：任意来源字幕文本 → cue 列表
   * @param {string} text - 响应正文
   * @param {{ format?: string, contentType?: string }} [options]
   *   format 为 'auto'/空时按内容自动识别
   */
  function parseSubtitleText(text, options = {}) {
    const requested = String(options.format || 'auto');
    const format = requested && requested !== 'auto'
      ? requested
      : detectSubtitleFormat(text, options.contentType);

    switch (format) {
      case 'vtt':
        return parseVttSubtitles(text);
      case 'json3':
        return parseYouTubeJson3Captions(text);
      case 'bilibili':
        return parseBilibiliSubtitleJson(text);
      case 'srv1':
      case 'srv2':
      case 'srv3':
      case 'xml':
        return parseYouTubeXmlCaptions(text);
      case 'srt':
        return parseSrtSubtitles(text);
      default:
        return [];
    }
  }

  // ============================================================
  // 轨道列表：归一化 / 选择 / 命名
  // ============================================================

  function trackDisplayName(track) {
    const simple = track?.name?.simpleText;
    if (simple) {
      return String(simple);
    }
    if (Array.isArray(track?.name?.runs)) {
      return track.name.runs.map((run) => run?.text || '').join('');
    }
    return String(
      track?.languageName
      || track?.language_name
      || track?.lan_doc
      || track?.label
      || track?.name
      || ''
    );
  }

  /**
   * 把各来源的字幕轨统一成 { id, isAsr, languageCode, languageName, url }。
   * 兼容 YouTube `playerCaptionsTracklistRenderer.captionTracks` 原始形状
   * 与 Bilibili `player/v2` → `subtitle.subtitles` 形状。
   */
  function normalizeSubtitleTracks(tracks) {
    if (!Array.isArray(tracks)) {
      return [];
    }

    const normalized = [];
    const seen = new Set();
    for (const track of tracks) {
      if (!track || typeof track !== 'object') {
        continue;
      }

      const url = String(track.baseUrl || track.base_url || track.url || '').trim();
      if (!url) {
        continue;
      }

      const languageCode = String(
        track.languageCode || track.language_code || track.lan || track.lang || track.language || ''
      ).trim();
      const isAsr = track.kind === 'asr'
        || track.isAsr === true
        || track.is_asr === true
        || Number(track.ai_status) === 1
        || /^ai[-_]/i.test(String(track.id_str || track.id || ''));
      const languageName = trackDisplayName(track) || languageCode || DEFAULT_SUBTITLE_LANGUAGE;
      const id = `${languageCode || DEFAULT_SUBTITLE_LANGUAGE}|${isAsr ? 'asr' : 'manual'}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);

      normalized.push({ id, isAsr, languageCode, languageName, url });
    }

    return normalized;
  }

  /**
   * 选一条要下载的字幕轨。
   * 有偏好语言时优先精确匹配 → 主语言前缀匹配；没命中再按「人工中文 → 人工英文 → 任意人工 → 第一条」兜底。
   */
  function selectSubtitleTrack(tracks, preferredLanguage = '') {
    const list = normalizeSubtitleTracks(tracks);
    if (list.length === 0) {
      return null;
    }

    const preferred = String(preferredLanguage || '').trim().toLowerCase();
    if (preferred) {
      const exact = list.find((item) => item.languageCode.toLowerCase() === preferred);
      if (exact) {
        return exact;
      }

      const primary = primaryLanguageTag(preferred);
      const byPrimary = list.find((item) => primaryLanguageTag(item.languageCode) === primary);
      if (byPrimary) {
        return byPrimary;
      }
    }

    for (const language of ['zh', 'en']) {
      const manual = list.find((item) => !item.isAsr && primaryLanguageTag(item.languageCode) === language);
      if (manual) {
        return manual;
      }
    }

    for (const language of ['zh', 'en']) {
      const any = list.find((item) => primaryLanguageTag(item.languageCode) === language);
      if (any) {
        return any;
      }
    }

    return list.find((item) => !item.isAsr) || list[0];
  }

  /** 语言代码/名称 → 可安全写入文件名的一段（去掉 Windows 非法字符） */
  function sanitizeFilenamePart(value) {
    return String(value ?? '')
      .replace(FILENAME_ILLEGAL_PATTERN, '_')
      .replace(/\s+/g, ' ')
      .trim()
      // Windows 不允许文件名以点/空格结尾
      .replace(/[.\s]+$/, '');
  }

  function normalizeSubtitleExtension(ext) {
    const raw = String(ext || '').trim();
    if (!raw) {
      return DEFAULT_SUBTITLE_EXTENSION;
    }
    return raw.startsWith('.') ? raw : `.${raw}`;
  }

  /**
   * 侧车字幕文件名：`<媒体标题>.<语言>[.auto]<ext>`
   * 例：`My Video.zh-Hans.srt`、`My Video.en.auto.srt`
   */
  function buildSubtitleFilename(baseName, track = {}, ext = DEFAULT_SUBTITLE_EXTENSION) {
    const base = sanitizeFilenamePart(baseName) || 'subtitle';
    const language = sanitizeFilenamePart(track.languageCode || track.languageName)
      || DEFAULT_SUBTITLE_LANGUAGE;
    const suffix = track.isAsr ? '.auto' : '';
    return `${base}.${language}${suffix}${normalizeSubtitleExtension(ext)}`;
  }

  function subtitleMimeTypeForExtension(ext) {
    switch (normalizeSubtitleExtension(ext).toLowerCase()) {
      case '.vtt':
        return 'text/vtt';
      case '.srt':
        return 'application/x-subrip';
      case '.ass':
      case '.ssa':
        return 'text/x-ssa';
      case '.lrc':
        return 'text/plain';
      default:
        return 'application/octet-stream';
    }
  }

  globalThis.__OVD_SUBTITLE_UTILS__ = Object.freeze({
    DEFAULT_CUE_DURATION_SECONDS,
    DEFAULT_SUBTITLE_EXTENSION,
    DEFAULT_SUBTITLE_LANGUAGE,
    YOUTUBE_CAPTION_FORMATS,
    buildSubtitleFilename,
    buildSubtitleFetchAttempts,
    cuesToSrt,
    detectSubtitleFormat,
    formatSrtTimestamp,
    isYouTubeCaptionUrl,
    normalizeCues,
    normalizeSubtitleTracks,
    parseBilibiliSubtitleJson,
    parseSrtSubtitles,
    parseSubtitleText,
    parseTimestampToSeconds,
    parseVttSubtitles,
    parseYouTubeJson3Captions,
    parseYouTubeXmlCaptions,
    sanitizeFilenamePart,
    selectSubtitleTrack,
    stripCaptionMarkup,
    subtitleMimeTypeForExtension,
    youTubeCaptionUrlWithFormat,
  });
})();
