// lib/mpd-parser.js
// MPD (MPEG-DASH) manifest 解析器
// 解析 MPD XML 提取自适应集、表示和分片 URL
// 以 <script> 方式加载，暴露全局 MpdParser

'use strict';

(() => {
  if (globalThis.__OVD_MPD_PARSER__) {
    return;
  }

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

    const match = durationStr.match(
      /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/
    );
    if (!match) {
      return null;
    }

    const hours = parseFloat(match[1]) || 0;
    const minutes = parseFloat(match[2]) || 0;
    const seconds = parseFloat(match[3]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function parseSegmentTimeline(timelineEl) {
    const segments = [];
    if (!timelineEl) {
      return segments;
    }

    const sElements = timelineEl.getElementsByTagNameNS('*', 'S');
    let time = 0;

    for (const s of sElements) {
      const t = s.getAttribute('t');
      const d = s.getAttribute('d');
      const r = s.getAttribute('r');

      if (t != null) {
        time = parseInt(t, 10);
      }

      const duration = parseInt(d, 10) || 0;
      if (duration <= 0) {
        continue;
      }

      const repeat = parseInt(r, 10) || 0;
      const count = repeat >= 0 ? repeat + 1 : 1;

      for (let i = 0; i < count; i++) {
        segments.push({ time: time + i * duration, duration });
      }

      time += count * duration;
    }

    return segments;
  }

  function parseRepresentation(repEl, adaptation, baseUrl, totalDuration) {
    const id = repEl.getAttribute('id') || '';
    const bandwidth = parseInt(repEl.getAttribute('bandwidth'), 10) || 0;
    const width = parseInt(repEl.getAttribute('width'), 10) || undefined;
    const height = parseInt(repEl.getAttribute('height'), 10) || undefined;
    const codecs = repEl.getAttribute('codecs') || adaptation.codecs || '';
    const mimeType = repEl.getAttribute('mimeType') || adaptation.mimeType || '';

    let segments = [];
    let initialization = null;

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
        initialization = resolveSegmentUrl(baseUrl, initTemplate
          .replace(/\$RepresentationID\$/g, id)
          .replace(/\$Bandwidth\$/g, String(bandwidth)));
      }

      const timelineEl = segmentTemplate.getElementsByTagNameNS('*', 'SegmentTimeline')[0];

      if (timelineEl) {
        const timelineSegments = parseSegmentTimeline(timelineEl);
        segments = timelineSegments.map((seg, idx) => ({
          url: resolveSegmentUrl(baseUrl, mediaTemplate
            .replace(/\$Number\$/g, String(startNumber + idx))
            .replace(/\$Time\$/g, String(seg.time))
            .replace(/\$Bandwidth\$/g, String(bandwidth))
            .replace(/\$RepresentationID\$/g, id)),
          duration: seg.duration / timescale,
          number: startNumber + idx,
        }));
      } else if (segmentDuration > 0 && totalDuration) {
        const segmentDurationSec = segmentDuration / timescale;
        const count = Math.ceil(totalDuration / segmentDurationSec);

        for (let idx = 0; idx < count; idx++) {
          segments.push({
            url: resolveSegmentUrl(baseUrl, mediaTemplate
              .replace(/\$Number\$/g, String(startNumber + idx))
              .replace(/\$Bandwidth\$/g, String(bandwidth))
              .replace(/\$RepresentationID\$/g, id)),
            duration: segmentDurationSec,
            number: startNumber + idx,
          });
        }
      }
    } else if (segmentList) {
      if (segmentList.getElementsByTagNameNS) {
        const initEl = segmentList.getElementsByTagNameNS('*', 'Initialization')[0];
        if (initEl) {
          const sourceURL = initEl.getAttribute('sourceURL') || initEl.getAttribute('range');
          if (sourceURL) {
            initialization = resolveSegmentUrl(baseUrl, sourceURL);
          }
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
            url: resolveSegmentUrl(baseUrl, media),
            duration: segDuration / segTimescale,
            number: idx + 1,
          });
        }
      }
    } else if (segmentBase) {
      const initEl = segmentBase.getElementsByTagNameNS
        ? segmentBase.getElementsByTagNameNS('*', 'Initialization')[0]
        : null;
      if (initEl) {
        const sourceURL = initEl.getAttribute('sourceURL');
        if (sourceURL) {
          initialization = resolveSegmentUrl(baseUrl, sourceURL);
        }
      }

      if (!initialization && baseUrl) {
        initialization = baseUrl;
      }

      segments = [{
        url: baseUrl,
        duration: totalDuration || 0,
        number: 1,
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
          url: resolvedUrl,
          duration: totalDuration || 0,
          number: 1,
        }];
      } else if (baseUrl) {
        initialization = baseUrl;
        segments = [{
          url: baseUrl,
          duration: totalDuration || 0,
          number: 1,
        }];
      }
    }

    return {
      id,
      bandwidth,
      width,
      height,
      codecs,
      mimeType,
      segments,
      initialization,
    };
  }

  function parseMpdManifest(mpdXmlText, baseUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(mpdXmlText, 'text/xml');

    const parseError = doc.getElementsByTagName('parsererror');
    if (parseError.length > 0) {
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

    const periodEls = mpd.getElementsByTagNameNS('*', 'Period');
    const adaptations = [];

    for (const period of periodEls) {
      const adaptationSets = period.getElementsByTagNameNS('*', 'AdaptationSet');

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

        const asSegmentBase = asEl.getElementsByTagNameNS('*', 'SegmentBase')[0] || null;
        const asSegmentList = asEl.getElementsByTagNameNS('*', 'SegmentList')[0] || null;
        const asSegmentTemplate = asEl.getElementsByTagNameNS('*', 'SegmentTemplate')[0] || null;

        const adaptationInfo = {
          codecs,
          mimeType,
          segmentBase: asSegmentBase,
          segmentList: asSegmentList,
          segmentTemplate: asSegmentTemplate,
        };

        for (const repEl of repEls) {
          representations.push(
            parseRepresentation(repEl, adaptationInfo, adaptationBaseUrl, totalDuration)
          );
        }

        if (representations.length === 0) {
          continue;
        }

        adaptations.push({
          contentType: contentType || guessContentType(representations[0]),
          mimeType,
          codecs,
          representations,
        });
      }
    }

    return {
      duration: totalDuration,
      adaptations,
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
    const reps = adaptationSet.representations;
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
    const reps = adaptationSet.representations;
    if (!reps || reps.length === 0) {
      return null;
    }

    return reps.reduce((best, rep) =>
      (rep.bandwidth > best.bandwidth ? rep : best));
  }

  globalThis.__OVD_MPD_PARSER__ = {
    parseMpdManifest,
    resolveSegmentUrl,
    selectBestAudioRepresentation,
    selectBestVideoRepresentation,
  };
})();
