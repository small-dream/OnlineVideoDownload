// lib/mpd-parser.js
// MPD (MPEG-DASH) manifest 解析器
// 解析 MPD XML 提取自适应集、表示和分片 URL
// 以 <script> 方式加载，暴露全局 MpdParser
// 无 DOMParser 的环境（Node 单元测试）自动退回内置最小 XML 解析器

'use strict';

(() => {
  if (globalThis.__OVD_MPD_PARSER__) {
    return;
  }

  // ---------------------------------------------------------------
  // DASH 模板替换
  // ---------------------------------------------------------------

  function formatTemplateNumber(value, widthSpec) {
    const num = Number(value);
    const safe = Number.isFinite(num) ? Math.trunc(num) : 0;
    const text = String(safe);
    const widthMatch = /^%0?(\d+)d$/i.exec(String(widthSpec || ''));
    if (!widthMatch) {
      return text;
    }

    const width = Math.min(64, parseInt(widthMatch[1], 10) || 0);
    return text.padStart(width, '0');
  }

  /**
   * DASH 分片模板替换。
   * 支持 $Number$ / $Number%05d$ / $Time$ / $Time%08d$ / $Bandwidth$ / $RepresentationID$，
   * 以及 $$ 转义；未定义的变量保持原样。
   */
  function formatSegmentTemplate(template, variables = {}) {
    return String(template || '').replace(/\$([A-Za-z]+)(%0?\d+d)?\$|\$\$/g, (match, name, widthSpec) => {
      if (!name) {
        return '$';
      }
      if (!Object.prototype.hasOwnProperty.call(variables, name)) {
        return match;
      }
      const value = variables[name];
      return widthSpec ? formatTemplateNumber(value, widthSpec) : String(value);
    });
  }

  /**
   * 解析 mediaRange/indexRange/range 属性：`start-end` 或 `start`（长度未知）。
   */
  function parseByteRange(value) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(String(value || '').trim());
    if (!match) {
      return null;
    }

    const start = parseInt(match[1], 10);
    const end = match[2] != null ? parseInt(match[2], 10) : null;
    return {
      end,
      length: end != null ? Math.max(0, end - start + 1) : null,
      start,
    };
  }

  function toRangeHeader(byteRange) {
    if (!byteRange || !Number.isFinite(byteRange.start)) {
      return null;
    }
    const end = Number.isFinite(byteRange.end) ? byteRange.end : '';
    return `bytes=${byteRange.start}-${end}`;
  }

  // ---------------------------------------------------------------
  // 内置最小 XML 解析器（无 DOMParser 环境的回退）
  // 仅需支撑 MPD 这类机器生成的结构化 XML：元素、属性、文本，忽略注释/声明/CDATA
  // ---------------------------------------------------------------

  function createXmlElement(tagName, attributes, parent) {
    const colon = tagName.indexOf(':');
    const element = {
      _attributes: attributes || [],
      _parseError: false,
      _text: '',
      childNodes: [],
      localName: colon >= 0 ? tagName.slice(colon + 1) : tagName,
      namespaceURI: '*',
      nodeType: 1,
      parentNode: parent || null,
      tagName,
    };

    element.getAttribute = function getAttribute(name) {
      const found = element._attributes.find((attr) => attr.name === name);
      return found ? found.value : null;
    };

    element.getElementsByTagName = function getElementsByTagName(name) {
      const result = [];
      const wanted = name === '*' ? null : name;
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) {
            continue;
          }
          if (!wanted || child.localName === wanted || child.tagName === wanted) {
            result.push(child);
          }
          visit(child);
        }
      };
      visit(element);
      return result;
    };

    element.getElementsByTagNameNS = function getElementsByTagNameNS(_ns, localName) {
      const result = [];
      const wanted = localName === '*' ? null : localName;
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) {
            continue;
          }
          if (!wanted || child.localName === wanted || child.tagName === wanted) {
            result.push(child);
          }
          visit(child);
        }
      };
      visit(element);
      return result;
    };

    Object.defineProperty(element, 'textContent', {
      get() {
        let text = element._text;
        for (const child of element.childNodes) {
          text += child.nodeType === 1 ? child.textContent : (child.nodeValue || '');
        }
        return text;
      },
    });

    return element;
  }

  function createXmlDocument() {
    const document = {
      _parseError: false,
      documentElement: null,
      nodeType: 9,
    };

    document.getElementsByTagName = (name) => {
      if (!document.documentElement) {
        return [];
      }
      if (document.documentElement.localName === name || document.documentElement.tagName === name) {
        return [document.documentElement];
      }
      return document.documentElement.getElementsByTagName(name);
    };

    document.getElementsByTagNameNS = (ns, localName) => {
      const root = document.documentElement;
      if (!root) {
        return [];
      }
      const result = [];
      if (localName === '*' || root.localName === localName || root.tagName === localName) {
        result.push(root);
      }
      return result.concat(root.getElementsByTagNameNS(ns, localName));
    };

    return document;
  }

  function parseXmlFallback(xmlText) {
    const document = createXmlDocument();
    const root = createXmlElement('#document', [], null);
    const stack = [root];
    const text = String(xmlText || '');
    let index = 0;

    const appendText = (chunk) => {
      if (!chunk) {
        return;
      }
      const current = stack[stack.length - 1];
      if (current) {
        current._text += chunk;
      }
    };

    while (index < text.length) {
      const lt = text.indexOf('<', index);
      if (lt === -1) {
        appendText(text.slice(index));
        break;
      }

      appendText(text.slice(index, lt));

      if (text.startsWith('<!--', lt)) {
        const end = text.indexOf('-->', lt);
        index = end === -1 ? text.length : end + 3;
        continue;
      }

      if (text.startsWith('<?', lt)) {
        const end = text.indexOf('?>', lt);
        index = end === -1 ? text.length : end + 2;
        continue;
      }

      if (text.startsWith('<![CDATA[', lt)) {
        const end = text.indexOf(']]>', lt);
        appendText(text.slice(lt + 9, end === -1 ? text.length : end));
        index = end === -1 ? text.length : end + 3;
        continue;
      }

      if (text.startsWith('<!', lt)) {
        const end = text.indexOf('>', lt);
        index = end === -1 ? text.length : end + 1;
        continue;
      }

      const gt = text.indexOf('>', lt);
      if (gt === -1) {
        document._parseError = true;
        break;
      }

      const rawTag = text.slice(lt + 1, gt).trim();
      if (rawTag.includes('<')) {
        document._parseError = true;
        break;
      }

      if (rawTag.startsWith('/')) {
        const name = rawTag.slice(1).trim();
        for (let depth = stack.length - 1; depth > 0; depth--) {
          if (stack[depth].tagName === name || stack[depth].localName === name) {
            stack.length = depth;
            break;
          }
        }
        index = gt + 1;
        continue;
      }

      const selfClosing = rawTag.endsWith('/');
      const tagBody = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
      const nameMatch = /^[^\s/>]+/.exec(tagBody);
      if (!nameMatch) {
        document._parseError = true;
        break;
      }

      const name = nameMatch[0];
      const attributes = [];
      const attrRegex = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(tagBody)) !== null) {
        attributes.push({
          name: attrMatch[1],
          value: attrMatch[3] !== undefined ? attrMatch[3] : attrMatch[4],
        });
      }

      const parent = stack[stack.length - 1];
      const element = createXmlElement(name, attributes, parent);
      parent.childNodes.push(element);
      if (!document.documentElement) {
        document.documentElement = element;
      }

      if (!selfClosing) {
        stack.push(element);
      }

      index = gt + 1;
    }

    if (stack.length > 1) {
      document._parseError = true;
    }

    return document;
  }

  function parseXml(xmlText) {
    if (typeof DOMParser !== 'undefined') {
      try {
        return new DOMParser().parseFromString(String(xmlText || ''), 'text/xml');
      } catch (_err) {
        return parseXmlFallback(xmlText);
      }
    }
    return parseXmlFallback(xmlText);
  }

  // ---------------------------------------------------------------
  // MPD 结构解析
  // ---------------------------------------------------------------

  function getDirectChildrenNS(parent, ns, localName) {
    const result = [];
    if (!parent || !parent.childNodes) {
      return result;
    }
    for (const child of parent.childNodes) {
      if (child.nodeType === 1 && child.localName === localName) {
        if (ns === '*' || child.namespaceURI === ns) {
          result.push(child);
        }
      }
    }
    return result;
  }

  function resolveSegmentUrl(baseUrl, segmentPath) {
    if (!segmentPath) {
      return baseUrl || '';
    }

    try {
      return new URL(segmentPath, baseUrl).href;
    } catch (_err) {
      if (baseUrl && !baseUrl.endsWith('/')) {
        return baseUrl + '/' + segmentPath;
      }

      return (baseUrl || '') + segmentPath;
    }
  }

  function parseDurationToSeconds(durationStr) {
    if (!durationStr) {
      return null;
    }

    const match = String(durationStr).match(
      /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
    );
    if (!match || !match[0]) {
      return null;
    }

    const days = parseFloat(match[1]) || 0;
    const hours = parseFloat(match[2]) || 0;
    const minutes = parseFloat(match[3]) || 0;
    const seconds = parseFloat(match[4]) || 0;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
  }

  /**
   * 解析 SegmentTimeline。
   * r="-1" 表示重复到 Period 结束（依赖 periodDuration/timescale）；
   * 无法确定结束点时退回单段，避免产出无限分片列表。
   */
  function parseSegmentTimeline(timelineEl, options = {}) {
    const segments = [];
    if (!timelineEl) {
      return segments;
    }

    const timescale = parseInt(options.timescale, 10) || 1;
    const periodDuration = Number.isFinite(Number(options.periodDuration))
      ? Number(options.periodDuration)
      : null;
    const periodEndTicks = periodDuration != null && periodDuration > 0
      ? Math.round(periodDuration * timescale)
      : null;

    const sElements = timelineEl.getElementsByTagNameNS('*', 'S');
    let time = 0;

    for (const s of sElements) {
      const t = s.getAttribute('t');
      const d = s.getAttribute('d');
      const r = s.getAttribute('r');

      if (t != null) {
        time = parseInt(t, 10) || 0;
      }

      const duration = parseInt(d, 10) || 0;
      if (duration <= 0) {
        continue;
      }

      const repeat = parseInt(r, 10);
      let count;
      if (r != null && Number.isFinite(repeat) && repeat < 0) {
        count = periodEndTicks != null && periodEndTicks > time
          ? Math.max(1, Math.ceil((periodEndTicks - time) / duration))
          : 1;
      } else {
        count = (Number.isFinite(repeat) && repeat >= 0 ? repeat : 0) + 1;
      }

      for (let i = 0; i < count; i++) {
        segments.push({ duration, time: time + i * duration });
      }

      time += count * duration;
    }

    return segments;
  }

  function parseRepresentation(repEl, adaptation, baseUrl, totalDuration, periodInfo = {}) {
    const id = repEl.getAttribute('id') || '';
    const bandwidth = parseInt(repEl.getAttribute('bandwidth'), 10) || 0;
    const width = parseInt(repEl.getAttribute('width'), 10) || undefined;
    const height = parseInt(repEl.getAttribute('height'), 10) || undefined;
    const codecs = repEl.getAttribute('codecs') || adaptation.codecs || '';
    const mimeType = repEl.getAttribute('mimeType') || adaptation.mimeType || '';
    const periodIndex = periodInfo.index ?? 0;
    const periodDuration = Number.isFinite(Number(periodInfo.duration))
      ? Number(periodInfo.duration)
      : totalDuration;

    const baseVariables = {
      Bandwidth: bandwidth,
      RepresentationID: id,
    };

    let segments = [];
    let initialization = null;
    let initializationRange = null;

    const segmentBase = repEl.getElementsByTagNameNS('*', 'SegmentBase')[0]
      || adaptation.segmentBase;
    const segmentList = repEl.getElementsByTagNameNS('*', 'SegmentList')[0]
      || adaptation.segmentList;
    const segmentTemplate = repEl.getElementsByTagNameNS('*', 'SegmentTemplate')[0]
      || adaptation.segmentTemplate;

    if (segmentTemplate) {
      const mediaTemplate = segmentTemplate.getAttribute('media') || '';
      const initTemplate = segmentTemplate.getAttribute('initialization') || '';
      const timescale = parseInt(segmentTemplate.getAttribute('timescale'), 10) || 1;
      const startNumber = parseInt(segmentTemplate.getAttribute('startNumber'), 10) || 1;
      const segmentDuration = parseInt(segmentTemplate.getAttribute('duration'), 10) || 0;

      if (initTemplate) {
        initialization = resolveSegmentUrl(baseUrl, formatSegmentTemplate(initTemplate, baseVariables));
      }

      const timelineEl = segmentTemplate.getElementsByTagNameNS('*', 'SegmentTimeline')[0];

      if (timelineEl) {
        const timelineSegments = parseSegmentTimeline(timelineEl, {
          periodDuration,
          timescale,
        });
        segments = timelineSegments.map((seg, idx) => ({
          byteRange: null,
          duration: seg.duration / timescale,
          number: startNumber + idx,
          time: seg.time,
          url: resolveSegmentUrl(baseUrl, formatSegmentTemplate(mediaTemplate, {
            ...baseVariables,
            Number: startNumber + idx,
            Time: seg.time,
          })),
        }));
      } else if (segmentDuration > 0 && periodDuration) {
        const segmentDurationSec = segmentDuration / timescale;
        const count = Math.ceil(periodDuration / segmentDurationSec);

        for (let idx = 0; idx < count; idx++) {
          const number = startNumber + idx;
          segments.push({
            byteRange: null,
            duration: segmentDurationSec,
            number,
            time: idx * segmentDuration,
            url: resolveSegmentUrl(baseUrl, formatSegmentTemplate(mediaTemplate, {
              ...baseVariables,
              Number: number,
              Time: idx * segmentDuration,
            })),
          });
        }
      }
    } else if (segmentList) {
      const initEl = segmentList.getElementsByTagNameNS
        ? segmentList.getElementsByTagNameNS('*', 'Initialization')[0]
        : null;
      if (initEl) {
        const sourceURL = initEl.getAttribute('sourceURL');
        initializationRange = parseByteRange(initEl.getAttribute('range'));
        if (sourceURL) {
          initialization = resolveSegmentUrl(baseUrl, sourceURL);
        } else if (initializationRange) {
          initialization = baseUrl;
        }
      }

      const segUrls = segmentList.getElementsByTagNameNS
        ? segmentList.getElementsByTagNameNS('*', 'SegmentURL')
        : [];
      const segDuration = parseInt(segmentList.getAttribute('duration'), 10) || 1;
      const segTimescale = parseInt(segmentList.getAttribute('timescale'), 10) || 1;

      for (let idx = 0; idx < segUrls.length; idx++) {
        const segUrl = segUrls[idx];
        const media = segUrl.getAttribute('media');
        if (media) {
          segments.push({
            byteRange: parseByteRange(segUrl.getAttribute('mediaRange')),
            duration: segDuration / segTimescale,
            index: segUrl.getAttribute('index') || '',
            indexRange: parseByteRange(segUrl.getAttribute('indexRange')),
            number: idx + 1,
            url: resolveSegmentUrl(baseUrl, media),
          });
        }
      }
    } else if (segmentBase) {
      const initEl = segmentBase.getElementsByTagNameNS
        ? segmentBase.getElementsByTagNameNS('*', 'Initialization')[0]
        : null;
      const indexRange = parseByteRange(segmentBase.getAttribute('indexRange'));

      if (initEl) {
        const sourceURL = initEl.getAttribute('sourceURL');
        initializationRange = parseByteRange(initEl.getAttribute('range'));
        initialization = sourceURL ? resolveSegmentUrl(baseUrl, sourceURL) : baseUrl;
      } else if (!initialization && baseUrl) {
        initialization = baseUrl;
      }

      // SegmentBase：indexRange 之后即媒体数据，用开放区间 Range 拉取
      const mediaRange = indexRange && Number.isFinite(indexRange.end)
        ? { end: null, length: null, start: indexRange.end + 1 }
        : null;

      segments = [{
        byteRange: mediaRange,
        duration: periodDuration || 0,
        indexRange,
        number: 1,
        url: baseUrl,
      }];
    } else {
      const baseURLs = getDirectChildrenNS(repEl, '*', 'BaseURL');
      const repBaseUrl = baseURLs.length > 0
        ? baseURLs[0].textContent.trim()
        : null;

      if (repBaseUrl) {
        const resolvedUrl = resolveSegmentUrl(baseUrl, repBaseUrl);
        initialization = resolvedUrl;
        segments = [{
          byteRange: null,
          duration: periodDuration || 0,
          number: 1,
          url: resolvedUrl,
        }];
      } else if (baseUrl) {
        initialization = baseUrl;
        segments = [{
          byteRange: null,
          duration: periodDuration || 0,
          number: 1,
          url: baseUrl,
        }];
      }
    }

    return {
      bandwidth,
      codecs,
      height,
      id,
      initialization,
      initializationRange,
      mimeType,
      periodIndex,
      segments,
      start: periodInfo.start ?? 0,
      width,
    };
  }

  function parsePeriods(mpd, effectiveBaseUrl, totalDuration) {
    let periodEls = getDirectChildrenNS(mpd, '*', 'Period');
    if (periodEls.length === 0) {
      periodEls = mpd.getElementsByTagNameNS('*', 'Period');
    }

    const periods = [];
    let nextStart = 0;

    periodEls.forEach((periodEl, index) => {
      const startAttr = parseDurationToSeconds(periodEl.getAttribute('start'));
      const start = startAttr != null ? startAttr : nextStart;
      const durationAttr = parseDurationToSeconds(periodEl.getAttribute('duration'));
      const duration = durationAttr != null
        ? durationAttr
        : (totalDuration != null ? Math.max(0, totalDuration - start) : null);

      nextStart = start + (duration || 0);

      const periodId = periodEl.getAttribute('id') || `period-${index}`;
      const adaptationSets = periodEl.getElementsByTagNameNS('*', 'AdaptationSet');
      const adaptations = [];

      for (const asEl of adaptationSets) {
        const contentType = asEl.getAttribute('contentType')
          || asEl.getAttribute('mimeType')?.split('/')[0]
          || '';
        const mimeType = asEl.getAttribute('mimeType') || '';
        const codecs = asEl.getAttribute('codecs') || '';

        const asBaseURLs = getDirectChildrenNS(asEl, '*', 'BaseURL');
        let adaptationBaseUrl = effectiveBaseUrl;
        if (asBaseURLs.length > 0) {
          adaptationBaseUrl = resolveSegmentUrl(effectiveBaseUrl, asBaseURLs[0].textContent.trim());
        }

        const repEls = asEl.getElementsByTagNameNS('*', 'Representation');
        const representations = [];

        const adaptationInfo = {
          codecs,
          mimeType,
          segmentBase: asEl.getElementsByTagNameNS('*', 'SegmentBase')[0] || null,
          segmentList: asEl.getElementsByTagNameNS('*', 'SegmentList')[0] || null,
          segmentTemplate: asEl.getElementsByTagNameNS('*', 'SegmentTemplate')[0] || null,
        };

        const periodInfo = { duration, index, start };

        for (const repEl of repEls) {
          representations.push(
            parseRepresentation(repEl, adaptationInfo, adaptationBaseUrl, totalDuration, periodInfo)
          );
        }

        if (representations.length === 0) {
          continue;
        }

        adaptations.push({
          codecs,
          contentType: contentType || guessContentType(representations[0]),
          duration,
          mimeType,
          periodId,
          periodIndex: index,
          representations,
          start,
        });
      }

      periods.push({
        adaptations,
        duration,
        id: periodId,
        index,
        start,
      });
    });

    return periods;
  }

  function parseMpdManifest(mpdXmlText, baseUrl) {
    const doc = parseXml(mpdXmlText);

    const parseError = typeof doc.getElementsByTagName === 'function'
      ? doc.getElementsByTagName('parsererror')
      : [];
    if (doc._parseError || (parseError && parseError.length > 0)) {
      throw new Error('MPD XML parse error');
    }

    const mpd = doc.getElementsByTagNameNS('*', 'MPD')[0];
    if (!mpd) {
      throw new Error('No MPD element found');
    }

    const durationStr = mpd.getAttribute('mediaPresentationDuration') || '';
    const totalDuration = parseDurationToSeconds(durationStr);

    const mpdBaseURLs = getDirectChildrenNS(mpd, '*', 'BaseURL');
    let effectiveBaseUrl = baseUrl;
    if (mpdBaseURLs.length > 0) {
      const mpdBase = mpdBaseURLs[0].textContent.trim();
      if (mpdBase) {
        effectiveBaseUrl = resolveSegmentUrl(baseUrl, mpdBase);
      }
    }

    const periods = parsePeriods(mpd, effectiveBaseUrl, totalDuration);
    const adaptations = periods.flatMap((period) => period.adaptations);

    return {
      adaptations,
      duration: totalDuration,
      isMultiPeriod: periods.length > 1,
      periods,
    };
  }

  function guessContentType(rep) {
    const mime = (rep.mimeType || '').toLowerCase();
    const codecs = (rep.codecs || '').toLowerCase();

    if (mime.startsWith('audio/')) {
      return 'audio';
    }

    if (mime.startsWith('video/')) {
      return 'video';
    }

    if (codecs.startsWith('avc') || codecs.startsWith('hev') || codecs.startsWith('av1')
      || codecs.startsWith('vp')) {
      return 'video';
    }

    if (codecs.startsWith('mp4a') || codecs.startsWith('aac') || codecs.startsWith('opus')) {
      return 'audio';
    }

    if (rep.width || rep.height) {
      return 'video';
    }

    return 'video';
  }

  function selectBestVideoRepresentation(adaptationSet) {
    const reps = adaptationSet?.representations;
    if (!reps || reps.length === 0) {
      return null;
    }

    return reps.reduce((best, rep) => {
      const bestPixels = (best.width || 0) * (best.height || 0);
      const repPixels = (rep.width || 0) * (rep.height || 0);
      if (repPixels > bestPixels) {
        return rep;
      }

      if (repPixels === bestPixels && rep.bandwidth > best.bandwidth) {
        return rep;
      }

      return best;
    });
  }

  function selectBestAudioRepresentation(adaptationSet) {
    const reps = adaptationSet?.representations;
    if (!reps || reps.length === 0) {
      return null;
    }

    return reps.reduce((best, rep) =>
      (rep.bandwidth > best.bandwidth ? rep : best));
  }

  /**
   * 按 Period 顺序收集同一内容类型的最佳表示，用于跨 Period 拼接分片。
   * hasMultipleInitializations 为 true 表示各 Period 初始化段不同，
   * 直接拼接会产生不连续文件，调用方应改用分离下载或提示用户。
   */
  function collectRepresentationsAcrossPeriods(manifest, contentType) {
    const periods = Array.isArray(manifest?.periods) && manifest.periods.length > 0
      ? manifest.periods
      : [{
        adaptations: manifest?.adaptations || [],
        duration: manifest?.duration ?? null,
        index: 0,
        start: 0,
      }];

    const picked = [];
    for (const period of periods) {
      const adaptation = (period.adaptations || []).find((item) => item.contentType === contentType);
      if (!adaptation) {
        continue;
      }
      const rep = contentType === 'audio'
        ? selectBestAudioRepresentation(adaptation)
        : selectBestVideoRepresentation(adaptation);
      if (rep) {
        picked.push(rep);
      }
    }

    const initializations = new Set(picked.map((rep) => rep.initialization || '').filter(Boolean));
    return {
      hasMultipleInitializations: initializations.size > 1,
      representations: picked,
    };
  }

  globalThis.__OVD_MPD_PARSER__ = {
    collectRepresentationsAcrossPeriods,
    formatSegmentTemplate,
    formatTemplateNumber,
    parseByteRange,
    parseDurationToSeconds,
    parseMpdManifest,
    parseSegmentTimeline,
    resolveSegmentUrl,
    selectBestAudioRepresentation,
    selectBestVideoRepresentation,
    toRangeHeader,
  };
})();
