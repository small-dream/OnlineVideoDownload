// lib/bilibili-muxer.js
// B站 DASH fMP4 视音频合并工具
// 解析两路 fMP4 (视频+音频)，用 mp4-muxer 输出单个完整 MP4
// 依赖：Mp4Muxer 全局变量（lib/mp4-muxer.js）
// 以 <script> 方式加载，暴露全局 BilibiliMuxer

'use strict';

// ============================================================
// 最小化 ISO BMFF 盒子解析器
// ============================================================

/**
 * 合并入口容错：调用方可能给 ArrayBuffer，也可能给 Uint8Array/DataView
 * （下载管线拼接分片给的就是 Uint8Array）。统一转成 ArrayBuffer，
 * 否则 `new DataView(uint8Array)` 会抛
 * "First argument to DataView constructor must be an ArrayBuffer"。
 */
function toMuxArrayBuffer(input) {
  const byteUtils = globalThis.__OVD_BYTE_UTILS__ || {};
  if (typeof byteUtils.toArrayBuffer === 'function') {
    return byteUtils.toArrayBuffer(input);
  }
  if (!input) {
    return null;
  }
  if (input instanceof ArrayBuffer) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    const { buffer, byteLength, byteOffset } = input;
    return (byteOffset === 0 && byteLength === buffer.byteLength)
      ? buffer
      : buffer.slice(byteOffset, byteOffset + byteLength);
  }
  return null;
}

/**
 * 从 ArrayBuffer 中读取所有顶层盒子，返回 Map<fourCC, {offset, size, data}>
 */
function parseBoxes(buffer, offset = 0, end = null) {
  buffer = toMuxArrayBuffer(buffer);
  if (!buffer) {
    throw new Error('MP4 解析失败：输入不是 ArrayBuffer/Uint8Array');
  }
  const view = new DataView(buffer);
  if (end === null) end = buffer.byteLength;
  const boxes = new Map();
  let pos = offset;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4), view.getUint8(pos + 5),
      view.getUint8(pos + 6), view.getUint8(pos + 7)
    );
    if (size === 1) {
      // 64-bit size
      const hi = view.getUint32(pos + 8);
      const lo = view.getUint32(pos + 12);
      size = hi * 0x100000000 + lo;
    }
    if (size < 8 || pos + size > end) break;
    if (!boxes.has(type)) {
      // 只记录偏移，不再复制盒子内容：调用方一律通过 offset/size 读取
      boxes.set(type, { offset: pos, size });
    } else {
      // 允许多个同名盒子（moof, mdat）存为数组
      const existing = boxes.get(type);
      if (!Array.isArray(existing)) {
        boxes.set(type, [existing, { offset: pos, size }]);
      } else {
        existing.push({ offset: pos, size });
      }
    }
    pos += size;
  }
  return boxes;
}

/** 递归查找嵌套盒子，path 如 ['moov','trak','mdia'] */
function findBox(buffer, path, offset = 0, end = null) {
  let boxes = parseBoxes(buffer, offset, end);
  for (let i = 0; i < path.length; i++) {
    const entry = boxes.get(path[i]);
    if (!entry) return null;
    const box = Array.isArray(entry) ? entry[0] : entry;
    if (i === path.length - 1) return box;
    const parentEnd = box.offset + box.size;
    boxes = parseBoxes(buffer, box.offset + 8, parentEnd);
  }
  return null;
}

/** 读取 4 字节大端整数 */
function u32(dv, offset) {
  return dv.getUint32(offset);
}

function readFourCC(buffer, offset) {
  const dv = new DataView(buffer, offset);
  return String.fromCharCode(
    dv.getUint8(0),
    dv.getUint8(1),
    dv.getUint8(2),
    dv.getUint8(3)
  );
}

function listBoxTypes(boxes) {
  return [...boxes.keys()].join(', ') || '(none)';
}

function muxerLog(message) {
  console.log(message);
  try { globalThis.__OVD_MUXER_LOG__?.('log', message); } catch (err) { console.warn(`[BilibiliMuxer] failed to forward log: ${err.message}`); }
}

function muxerWarn(message) {
  console.warn(message);
  try { globalThis.__OVD_MUXER_LOG__?.('warn', message); } catch (err) { console.warn(`[BilibiliMuxer] failed to forward warn log: ${err.message}`); }
}

// ============================================================
// 从 moov 盒子提取视频解码配置（avcC）
// ============================================================
function extractAvcDecoderConfig(moovBuffer, moovOffset, moovEnd) {
  // 路径: moov → trak → mdia → minf → stbl → stsd → avc1 → avcC
  // moovOffset/moovEnd 为 moov 盒子内容范围（跳过 8 字节头之后）
  const scanOffset = (moovOffset !== undefined) ? moovOffset : 0;
  const scanEnd = (moovEnd !== undefined) ? moovEnd : moovBuffer.byteLength;
  const moovBoxes = parseBoxes(moovBuffer, scanOffset, scanEnd);
  const trakEntry = moovBoxes.get('trak');
  const traks = Array.isArray(trakEntry) ? trakEntry : (trakEntry ? [trakEntry] : []);

  for (let trackIndex = 0; trackIndex < traks.length; trackIndex++) {
    const trak = traks[trackIndex];
    const trakBoxes = parseBoxes(moovBuffer, trak.offset + 8, trak.offset + trak.size);
    const mdia = trakBoxes.get('mdia');
    if (!mdia) continue;
    const mdiaBoxes = parseBoxes(moovBuffer, mdia.offset + 8, mdia.offset + mdia.size);

    // 检查是否是视频轨
    const hdlr = mdiaBoxes.get('hdlr');
    if (hdlr) {
      const hdlrDv = new DataView(moovBuffer, hdlr.offset + 8);
      const handler = String.fromCharCode(
        hdlrDv.getUint8(8), hdlrDv.getUint8(9), hdlrDv.getUint8(10), hdlrDv.getUint8(11)
      );
      if (handler !== 'vide') continue;
    }

    const minf = mdiaBoxes.get('minf');
    if (!minf) continue;
    const minfBoxes = parseBoxes(moovBuffer, minf.offset + 8, minf.offset + minf.size);
    const stbl = minfBoxes.get('stbl');
    if (!stbl) continue;
    const stblBoxes = parseBoxes(moovBuffer, stbl.offset + 8, stbl.offset + stbl.size);
    const stsd = stblBoxes.get('stsd');
    if (!stsd) continue;

    // stsd: version(1) + flags(3) + entry_count(4) + entries
    const stsdDv = new DataView(moovBuffer, stsd.offset + 8);
    // 跳过 version(1) + flags(3) + entry_count(4) = 8 bytes
    const firstEntryOffset = stsd.offset + 8 + 8;
    const firstEntrySize = new DataView(moovBuffer, firstEntryOffset).getUint32(0);
    const firstEntryType = readFourCC(moovBuffer, firstEntryOffset + 4);

    // 在 avc1/av01/hev1 等 sample entry 内查找解码配置盒
    const sampleEntryEnd = firstEntryOffset + firstEntrySize;
    // 视频 sample entry 的子盒开始位置：
    // size+type(8) + SampleEntry(8) + VisualSampleEntry fields(70) = 86
    const configBoxOffset = firstEntryOffset + 8 + 8 + 70;
    const innerBoxes = parseBoxes(moovBuffer, configBoxOffset, sampleEntryEnd);
    muxerLog(
      `[BilibiliMuxer] 视频轨#${trackIndex} sampleEntry=${firstEntryType} entrySize=${firstEntrySize} `
      + `configOffset=${configBoxOffset} sampleEntryEnd=${sampleEntryEnd} innerBoxes=${listBoxTypes(innerBoxes)}`
    );
    if (configBoxOffset >= sampleEntryEnd) {
      muxerWarn(
        `[BilibiliMuxer] 视频轨#${trackIndex} 配置盒偏移异常 configOffset=${configBoxOffset} sampleEntryEnd=${sampleEntryEnd}`
      );
    }
    const codecMap = [
      ['avcC', 'avc'],
      ['hvcC', 'hevc'],
      ['av1C', 'av1'],
      ['vpcC', 'vp9'],
    ];

    for (const [boxType, codec] of codecMap) {
      const configBox = innerBoxes.get(boxType);
      if (!configBox) continue;
      muxerLog(`[BilibiliMuxer] 视频轨#${trackIndex} 命中配置盒 ${boxType} -> codec=${codec}`);
      return {
        codec,
        description: moovBuffer.slice(configBox.offset + 8, configBox.offset + configBox.size),
      };
    }

    // av1 由 mp4-muxer 生成默认 av1C，也允许没有额外配置盒时继续
    if (firstEntryType === 'av01') {
      muxerWarn(`[BilibiliMuxer] 视频轨#${trackIndex} 未找到 av1C，回退为默认 av1 配置`);
      return { codec: 'av1', description: null };
    }
  }
  muxerWarn(`[BilibiliMuxer] 未找到视频解码配置，moov 顶层盒=${listBoxTypes(moovBoxes)}`);
  return null;
}

// ============================================================
// 从 moov 盒子提取音频解码配置（esds/dOps）
// ============================================================
function extractAudioDecoderConfig(moovBuffer, moovOffset, moovEnd) {
  const scanOffset = (moovOffset !== undefined) ? moovOffset : 0;
  const scanEnd = (moovEnd !== undefined) ? moovEnd : moovBuffer.byteLength;
  const moovBoxes = parseBoxes(moovBuffer, scanOffset, scanEnd);
  const trakEntry = moovBoxes.get('trak');
  const traks = Array.isArray(trakEntry) ? trakEntry : (trakEntry ? [trakEntry] : []);

  for (let trackIndex = 0; trackIndex < traks.length; trackIndex++) {
    const trak = traks[trackIndex];
    const trakBoxes = parseBoxes(moovBuffer, trak.offset + 8, trak.offset + trak.size);
    const mdia = trakBoxes.get('mdia');
    if (!mdia) continue;
    const mdiaBoxes = parseBoxes(moovBuffer, mdia.offset + 8, mdia.offset + mdia.size);

    // 检查是否是音频轨
    const hdlr = mdiaBoxes.get('hdlr');
    if (hdlr) {
      const hdlrDv = new DataView(moovBuffer, hdlr.offset + 8);
      const handler = String.fromCharCode(
        hdlrDv.getUint8(8), hdlrDv.getUint8(9), hdlrDv.getUint8(10), hdlrDv.getUint8(11)
      );
      if (handler !== 'soun') continue;
    }

    // 从 mdhd 获取 timescale
    const mdhd = mdiaBoxes.get('mdhd');
    let timescale = 44100;
    if (mdhd) {
      const mdhdDv = new DataView(moovBuffer, mdhd.offset + 8);
      const version = mdhdDv.getUint8(0);
      timescale = version === 1
        ? mdhdDv.getUint32(20) // 64-bit timestamps: 8+8+4 = skip 20 bytes
        : mdhdDv.getUint32(12); // 32-bit timestamps
    }

    const minf = mdiaBoxes.get('minf');
    if (!minf) continue;
    const minfBoxes = parseBoxes(moovBuffer, minf.offset + 8, minf.offset + minf.size);
    const stbl = minfBoxes.get('stbl');
    if (!stbl) continue;
    const stblBoxes = parseBoxes(moovBuffer, stbl.offset + 8, stbl.offset + stbl.size);
    const stsd = stblBoxes.get('stsd');
    if (!stsd) continue;

    // stsd: version(1)+flags(3)+entry_count(4) = 8 bytes header, then entries
    const firstEntryOffset = stsd.offset + 8 + 8;
    const firstEntrySize = new DataView(moovBuffer, firstEntryOffset).getUint32(0);
    const firstEntryType = readFourCC(moovBuffer, firstEntryOffset + 4);
    const isOpus = firstEntryType === 'Opus' || firstEntryType === 'opus';

    // audio sample entry: 4+4+6+2 = 16 (header) + 8 (reserved) + 2 (channelcount) + 2 (samplesize) + 2 + 2 + 4 (samplerate 16.16) = 28
    const audioEntryFieldsSize = 28;
    const configBoxOffset = firstEntryOffset + 8 + audioEntryFieldsSize;
    const sampleEntryEnd = firstEntryOffset + firstEntrySize;
    const innerBoxes = parseBoxes(moovBuffer, configBoxOffset, sampleEntryEnd);
    muxerLog(
      `[BilibiliMuxer] 音频轨#${trackIndex} sampleEntry=${firstEntryType} entrySize=${firstEntrySize} `
      + `configOffset=${configBoxOffset} sampleEntryEnd=${sampleEntryEnd} innerBoxes=${listBoxTypes(innerBoxes)}`
    );

    // 提取音频参数
    const audioEntryDv = new DataView(moovBuffer, firstEntryOffset + 8);
    const channelCount = audioEntryDv.getUint16(16); // offset 16 within audio sample entry body
    const sampleRateFixed = audioEntryDv.getUint32(24); // 16.16 fixed point
    const sampleRate = sampleRateFixed >>> 16;

    if (isOpus) {
      const dOpsBox = innerBoxes.get('dOps');
      if (dOpsBox) {
        muxerLog(`[BilibiliMuxer] 音频轨#${trackIndex} 命中配置盒 dOps -> codec=opus`);
        return {
          codec: 'opus',
          description: moovBuffer.slice(dOpsBox.offset + 8, dOpsBox.offset + dOpsBox.size),
          numberOfChannels: channelCount || 2,
          sampleRate: sampleRate || 48000,
          timescale,
        };
      }
    } else {
      // AAC — find esds
      const esdsBox = innerBoxes.get('esds');
      if (esdsBox) {
        muxerLog(`[BilibiliMuxer] 音频轨#${trackIndex} 命中配置盒 esds -> codec=aac`);
        // esds: version(1)+flags(3) = 4 bytes header, then ES_Descriptor
        // Parse the AudioSpecificConfig from esds
        const asc = parseAudioSpecificConfigFromEsds(moovBuffer, esdsBox.offset + 8 + 4, esdsBox.offset + esdsBox.size);
        return {
          codec: 'aac',
          description: asc,
          numberOfChannels: channelCount || 2,
          sampleRate: sampleRate || 44100,
          timescale,
        };
      }
      // fallback: no esds, construct a default AudioSpecificConfig
      return {
        codec: 'aac',
        description: null,
        numberOfChannels: channelCount || 2,
        sampleRate: sampleRate || 44100,
        timescale,
      };
    }
  }
  muxerWarn(`[BilibiliMuxer] 未找到音频解码配置，moov 顶层盒=${listBoxTypes(moovBoxes)}`);
  return null;
}

/** 从 esds 盒子内容中提取 AudioSpecificConfig (DecoderSpecificInfo) */
function parseAudioSpecificConfigFromEsds(buffer, start, end) {
  const dv = new DataView(buffer);
  let pos = start;

  function readDescriptor() {
    if (pos >= end) return null;
    const tag = dv.getUint8(pos++);
    let size = 0;
    for (let i = 0; i < 4; i++) {
      const b = dv.getUint8(pos++);
      size = (size << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return { tag, size, start: pos };
  }

  // ES_Descriptor (tag 0x03)
  const esDesc = readDescriptor();
  if (!esDesc || esDesc.tag !== 0x03) return null;
  // Skip ES_ID (2) + streamDependenceFlag etc (1)
  const flags = dv.getUint8(pos + 2);
  let skip = 3;
  if (flags & 0x80) skip += 2; // streamDependence
  if (flags & 0x40) skip += dv.getUint8(pos + skip) + 1; // URL
  if (flags & 0x20) skip += 2; // OCRstreamFlag
  pos += skip;

  // DecoderConfigDescriptor (tag 0x04)
  const dcDesc = readDescriptor();
  if (!dcDesc || dcDesc.tag !== 0x04) return null;
  pos += 13; // objectTypeIndication(1) + streamType(1) + bufferSize(3) + maxBitrate(4) + avgBitrate(4)

  // DecoderSpecificInfo (tag 0x05) — this is the AudioSpecificConfig
  const dsiDesc = readDescriptor();
  if (!dsiDesc || dsiDesc.tag !== 0x05) return null;
  return buffer.slice(pos, pos + dsiDesc.size);
}

// ============================================================
// 从 mdhd 获取视频轨的 timescale
// ============================================================
function extractVideoTimescale(moovBuffer, moovOffset, moovEnd) {
  const scanOffset = (moovOffset !== undefined) ? moovOffset : 0;
  const scanEnd = (moovEnd !== undefined) ? moovEnd : moovBuffer.byteLength;
  const moovBoxes = parseBoxes(moovBuffer, scanOffset, scanEnd);
  const trakEntry = moovBoxes.get('trak');
  const traks = Array.isArray(trakEntry) ? trakEntry : (trakEntry ? [trakEntry] : []);

  for (const trak of traks) {
    const trakBoxes = parseBoxes(moovBuffer, trak.offset + 8, trak.offset + trak.size);
    const mdia = trakBoxes.get('mdia');
    if (!mdia) continue;
    const mdiaBoxes = parseBoxes(moovBuffer, mdia.offset + 8, mdia.offset + mdia.size);

    const hdlr = mdiaBoxes.get('hdlr');
    if (hdlr) {
      const hdlrDv = new DataView(moovBuffer, hdlr.offset + 8);
      const handler = String.fromCharCode(
        hdlrDv.getUint8(8), hdlrDv.getUint8(9), hdlrDv.getUint8(10), hdlrDv.getUint8(11)
      );
      if (handler !== 'vide') continue;
    }

    const mdhd = mdiaBoxes.get('mdhd');
    if (mdhd) {
      const mdhdDv = new DataView(moovBuffer, mdhd.offset + 8);
      const version = mdhdDv.getUint8(0);
      return version === 1 ? mdhdDv.getUint32(20) : mdhdDv.getUint32(12);
    }
  }
  return 90000; // 默认视频 timescale
}

// ============================================================
// 从 fMP4 碎片中提取样本列表
// ============================================================
/**
 * 解析 moof + mdat 组合，返回 [{data: Uint8Array, duration: number, isKey: boolean, ctOffset: number}]
 * moofBuffer: moof 盒子的内容（不含 8 字节头）
 * mdatBuffer: mdat 盒子的内容（不含 8 字节头）
 */
/**
 * 解析一个 moof + mdat 组合。
 * 零拷贝：只接受原缓冲 + 偏移，样本数据以视图返回（不再逐样本复制），
 * 因此调用方必须在合并结束前保持 buffer 存活（mergeBilibiliDash 全程持有输入）。
 *
 * @param {ArrayBuffer} buffer - 原始 fMP4 缓冲
 * @param {{moofPayloadOffset: number, moofPayloadSize: number, mdatPayloadOffset: number}} fragment
 */
/**
 * 解析一个 moof+mdat 对里的样本。
 * 默认返回带 `data` 视图的样本（内存合并用）；`descriptorsOnly: true` 时只返回
 * 偏移/长度/时长等描述信息 —— 流式合并（从文件按需读样本）用它，
 * 这样无需把整段媒体读进内存。
 */
function parseFragment(buffer, fragment, options = {}) {
  buffer = toMuxArrayBuffer(buffer);
  if (!buffer) {
    throw new Error('parseFragment 需要 ArrayBuffer 或 Uint8Array');
  }
  const descriptorsOnly = options?.descriptorsOnly === true;
  const samples = [];
  const {
    moofPayloadOffset,
    moofPayloadSize,
    mdatPayloadOffset,
    mdatPayloadSize,
  } = fragment;
  const moofBoxStart = moofPayloadOffset - 8;
  const moofEnd = moofPayloadOffset + moofPayloadSize;
  const mdatPayloadEnd = mdatPayloadOffset + (mdatPayloadSize || 0);
  const moofBoxes = parseBoxes(buffer, moofPayloadOffset, moofEnd);
  const trafEntry = moofBoxes.get('traf');
  if (!trafEntry) return samples;

  // 一个 moof 可以包含多个 traf（多轨），每个 traf 可以包含多个 trun（分次 run），
  // 之前只取第一个会静默丢样本。
  const trafs = Array.isArray(trafEntry) ? trafEntry : [trafEntry];
  // 未声明 data-offset 的 run 紧接「上一个 run」（跨 traf 有效，ISO 14496-12 §8.8.8），
  // 首个 run 从 mdat payload 起点开始。
  let cursor = mdatPayloadOffset;

  for (const traf of trafs) {
    const trafBoxes = parseBoxes(buffer, traf.offset + 8, traf.offset + traf.size);
    const trunEntry = trafBoxes.get('trun');
    if (!trunEntry) continue;

    // ---- tfhd ----
    let defaultSampleDuration = 0;
    let defaultSampleFlags = 0;
    let baseDataOffset = null;
    const tfhd = trafBoxes.get('tfhd');
    if (tfhd) {
      const tfhdDv = new DataView(buffer, tfhd.offset + 8);
      const tfhdFlags = (tfhdDv.getUint8(1) << 16) | (tfhdDv.getUint8(2) << 8) | tfhdDv.getUint8(3);
      let tfhdPos = 8; // version(1)+flags(3)+track_id(4)
      if (tfhdFlags & 0x000001) {
        baseDataOffset = tfhdDv.getUint32(tfhdPos) * 0x100000000 + tfhdDv.getUint32(tfhdPos + 4);
        tfhdPos += 8;
      }
      if (tfhdFlags & 0x000002) tfhdPos += 4; // sample-description-index
      if (tfhdFlags & 0x000008) { defaultSampleDuration = tfhdDv.getUint32(tfhdPos); tfhdPos += 4; }
      if (tfhdFlags & 0x000010) tfhdPos += 4; // default-sample-size
      if (tfhdFlags & 0x000020) { defaultSampleFlags = tfhdDv.getUint32(tfhdPos); tfhdPos += 4; }
    }

    // 没有 base-data-offset 时，trun.data-offset 的基准是 moof 盒子起点（ISO 14496-12）
    const base = baseDataOffset != null ? baseDataOffset : moofBoxStart;

    const truns = Array.isArray(trunEntry) ? trunEntry : [trunEntry];
    for (const trun of truns) {
      const trunDv = new DataView(buffer, trun.offset + 8);
      const trunFlags = (trunDv.getUint8(1) << 16) | (trunDv.getUint8(2) << 8) | trunDv.getUint8(3);
      const sampleCount = trunDv.getUint32(4);

      let trunPos = 8;
      if (trunFlags & 0x000001) {
        const declaredOffset = trunDv.getUint32(trunPos);
        trunPos += 4;
        const resolved = base + declaredOffset;
        if (mdatPayloadSize > 0 && (resolved < mdatPayloadOffset || resolved >= mdatPayloadEnd)) {
          const err = new Error(
            `trun data-offset 越界：解析到 ${resolved}，mdat payload 区间为 [${mdatPayloadOffset}, ${mdatPayloadEnd})`
          );
          err.code = 'FMP4_TRUN_OFFSET_OUT_OF_RANGE';
          throw err;
        }
        cursor = resolved;
      }

      let firstSampleFlags = null;
      if (trunFlags & 0x000004) { firstSampleFlags = trunDv.getUint32(trunPos); trunPos += 4; }

      for (let i = 0; i < sampleCount; i++) {
        let duration = defaultSampleDuration;
        let size = 0;
        // first-sample-flags 覆盖第一个样本的 flags（ISO 14496-12）
        let flags = (i === 0 && firstSampleFlags !== null) ? firstSampleFlags : defaultSampleFlags;
        let ctOffset = 0;

        if (trunFlags & 0x000100) { duration = trunDv.getUint32(trunPos); trunPos += 4; }
        if (trunFlags & 0x000200) { size = trunDv.getUint32(trunPos); trunPos += 4; }
        if (trunFlags & 0x000400) { flags = trunDv.getUint32(trunPos); trunPos += 4; }
        if (trunFlags & 0x000800) { ctOffset = trunDv.getInt32(trunPos); trunPos += 4; }

        if (size === 0) {
          const err = new Error(`第 ${samples.length} 个样本 size 为 0，无法定位媒体数据`);
          err.code = 'FMP4_SAMPLE_SIZE_INVALID';
          throw err;
        }

        if (mdatPayloadSize > 0 && cursor + size > mdatPayloadEnd) {
          const err = new Error(
            `样本数据越界：需要 [${cursor}, ${cursor + size})，mdat payload 终点为 ${mdatPayloadEnd}`
          );
          err.code = 'FMP4_SAMPLE_OUT_OF_RANGE';
          throw err;
        }

        // 判断是否关键帧（flags: bit 25 表示非同步样本，0 = 关键帧）
        const isNonSync = (flags >> 16) & 0x0001;

        const descriptor = {
          ctOffset,
          duration,
          isKey: !isNonSync,
          offset: cursor,
          size,
        };
        samples.push(descriptorsOnly
          ? descriptor
          // 视图而非副本：省掉"每样本一次复制"的大头开销
          : { ...descriptor, data: new Uint8Array(buffer, cursor, size) });
        cursor += size;
      }
    }
  }

  return samples;
}

// ============================================================
// 主合并函数
// ============================================================
/**
 * 收集 fMP4 中的所有 moof+mdat 对，只记录偏移（零拷贝）。
 * boxes 参数保留以兼容旧调用签名（内部自行遍历顶层盒子）。
 */
function collectFragments(buffer, _boxes) {
  const fragments = [];
  const allBoxes = [];
  const view = new DataView(buffer);
  let pos = 0;
  while (pos + 8 <= buffer.byteLength) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4), view.getUint8(pos + 5),
      view.getUint8(pos + 6), view.getUint8(pos + 7)
    );
    if (size === 1) {
      size = view.getUint32(pos + 8) * 0x100000000 + view.getUint32(pos + 12);
    }
    if (size < 8) break;
    allBoxes.push({ type, offset: pos, size });
    pos += size;
  }

  for (let i = 0; i < allBoxes.length; i++) {
    if (allBoxes[i].type === 'moof') {
      const moof = allBoxes[i];
      const mdat = allBoxes[i + 1];
      if (mdat && mdat.type === 'mdat') {
        // 只记录偏移（含 payload 起点），不再切片复制整段媒体数据
        fragments.push({
          mdatPayloadOffset: mdat.offset + 8,
          mdatPayloadSize: mdat.size - 8,
          moofPayloadOffset: moof.offset + 8,
          moofPayloadSize: moof.size - 8,
        });
        i++; // 跳过 mdat
      }
    }
  }
  return fragments;
}

/**
 * 合并 B站 DASH 视音频为单个 MP4
 * @param {ArrayBuffer} videoBuffer - 视频 fMP4 完整数据
 * @param {ArrayBuffer} audioBuffer - 音频 fMP4 完整数据
 * @param {function} onProgress - 进度回调 (percent: 0-100)
 * @returns {Promise<Blob>}
 */
async function mergeBilibiliDash(videoBuffer, audioBuffer, onProgress) {
  // 容错：下载管线可能传 Uint8Array（拼接分片的产物）
  videoBuffer = toMuxArrayBuffer(videoBuffer);
  audioBuffer = toMuxArrayBuffer(audioBuffer);
  if (!videoBuffer || !audioBuffer) {
    throw new Error('视音频数据为空或类型不支持（需要 ArrayBuffer 或 Uint8Array）');
  }

  muxerLog('[BilibiliMuxer] 开始解析 fMP4...');
  onProgress?.(5);

  // 1. 找到 moov 盒子
  const videoBoxes = parseBoxes(videoBuffer);
  const audioBoxes = parseBoxes(audioBuffer);
  muxerLog(`[BilibiliMuxer] 视频顶层盒=${listBoxTypes(videoBoxes)}`);
  muxerLog(`[BilibiliMuxer] 音频顶层盒=${listBoxTypes(audioBoxes)}`);

  const videoMoov = videoBoxes.get('moov');
  const audioMoov = audioBoxes.get('moov');
  if (!videoMoov) throw new Error('视频流缺少 moov 盒子');
  if (!audioMoov) throw new Error('音频流缺少 moov 盒子');

  // moov 内容范围（跳过 8 字节 size+type 头）
  const videoMoovStart = videoMoov.offset + 8;
  const videoMoovEnd = videoMoov.offset + videoMoov.size;
  const audioMoovStart = audioMoov.offset + 8;
  const audioMoovEnd = audioMoov.offset + audioMoov.size;

  const videoMoovBuf = videoBuffer;
  const audioMoovBuf = audioBuffer;

  // 2. 提取解码配置
  const videoConfig = extractAvcDecoderConfig(videoMoovBuf, videoMoovStart, videoMoovEnd);
  const audioConfig = extractAudioDecoderConfig(audioMoovBuf, audioMoovStart, audioMoovEnd);
  const videoTimescale = extractVideoTimescale(videoMoovBuf, videoMoovStart, videoMoovEnd);
  let videoDims = null;
  try {
    videoDims = parseVideoDimensionsFromMoov(videoMoovBuf, videoMoovStart, videoMoovEnd);
  } catch (err) {
    muxerWarn(`[BilibiliMuxer] 解析视频宽高失败: ${err.message}`);
  }

  muxerLog(`[BilibiliMuxer] 视频 codec=${videoConfig?.codec} timescale=${videoTimescale}`);
  muxerLog(`[BilibiliMuxer] 音频 codec=${audioConfig?.codec} sampleRate=${audioConfig?.sampleRate} channels=${audioConfig?.numberOfChannels} timescale=${audioConfig?.timescale}`);
  muxerLog(`[BilibiliMuxer] 视频尺寸=${videoDims ? `${videoDims.width}x${videoDims.height}` : 'unknown'}`);

  if (!videoConfig) throw new Error('无法提取视频解码配置');
  if (!audioConfig) throw new Error('无法提取音频解码配置');

  onProgress?.(10);

  // 3. 收集所有 moof+mdat 对（零拷贝，只记录偏移）
  const videoFragments = collectFragments(videoBuffer, videoBoxes);
  const audioFragments = collectFragments(audioBuffer, audioBoxes);
  muxerLog(`[BilibiliMuxer] 视频片段数=${videoFragments.length} 音频片段数=${audioFragments.length}`);

  onProgress?.(15);

  // 4. 解析所有样本
  const videoSamples = [];
  for (const frag of videoFragments) {
    const samples = parseFragment(videoBuffer, frag);
    videoSamples.push(...samples);
  }
  const audioSamples = [];
  for (const frag of audioFragments) {
    const samples = parseFragment(audioBuffer, frag);
    audioSamples.push(...samples);
  }
  muxerLog(`[BilibiliMuxer] 视频样本数=${videoSamples.length} 音频样本数=${audioSamples.length}`);

  onProgress?.(25);

  // 5. 计算时间戳（从 timescale 单位转换为微秒）
  const videoSamplesWithTs = [];
  let videoTs = 0;
  for (const s of videoSamples) {
    const tsUs = Math.round((videoTs / videoTimescale) * 1_000_000);
    const durationUs = Math.round((s.duration / videoTimescale) * 1_000_000);
    const ctOffsetUs = Math.round((s.ctOffset / videoTimescale) * 1_000_000);
    videoSamplesWithTs.push({ ...s, tsUs, durationUs, ctOffsetUs });
    videoTs += s.duration;
  }

  const audioSamplesWithTs = [];
  const audioTimescale = audioConfig.timescale || 44100;
  let audioTs = 0;
  for (const s of audioSamples) {
    const tsUs = Math.round((audioTs / audioTimescale) * 1_000_000);
    const durationUs = Math.round((s.duration / audioTimescale) * 1_000_000);
    audioSamplesWithTs.push({ ...s, tsUs, durationUs });
    audioTs += s.duration;
  }

  onProgress?.(30);

  // 6. 初始化 mp4-muxer
  const muxerRuntime = (typeof Mp4Muxer !== 'undefined' ? Mp4Muxer : globalThis.Mp4Muxer);
  if (!muxerRuntime) {
    throw new Error('Mp4Muxer is not loaded');
  }
  const { Muxer, ArrayBufferTarget } = muxerRuntime;
  const target = new ArrayBufferTarget();

  const muxerOptions = {
    target,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
    video: {
      codec: videoConfig.codec,
      width: 0, // 先设为 0，mp4-muxer 会从 decoderConfig 中推断
      height: 0,
    },
    audio: {
      codec: audioConfig.codec === 'opus' ? 'opus' : 'aac',
      numberOfChannels: audioConfig.numberOfChannels,
      sampleRate: audioConfig.sampleRate,
    },
  };

  // 尝试从 avcC 解析宽高
  try {
    const dims = parseVideoDimensionsFromMoov(videoMoovBuf, videoMoovStart, videoMoovEnd);
    if (dims) {
      muxerOptions.video.width = dims.width;
      muxerOptions.video.height = dims.height;
    }
  } catch (err) {
    muxerWarn(`[BilibiliMuxer] failed to reuse parsed video dimensions: ${err.message}`);
  }

  if (muxerOptions.video.width === 0) {
    // 无法获取宽高时使用一个合理的默认值，mp4-muxer 需要非零值
    muxerOptions.video.width = 1920;
    muxerOptions.video.height = 1080;
  }

  const muxer = new Muxer(muxerOptions);

  // 7. 写入视频样本
  const videoDecoderConfig = {
    codec: videoConfig.codec,
    description: videoConfig.description,
  };

  const totalSamples = videoSamplesWithTs.length + audioSamplesWithTs.length;
  let processedSamples = 0;

  // 解析出 0 个样本说明 fixture/流结构没被正确理解：直接失败，不产出空轨文件
  if (videoSamplesWithTs.length === 0 || audioSamplesWithTs.length === 0) {
    const err = new Error(
      `样本解析结果为空（视频 ${videoSamplesWithTs.length} / 音频 ${audioSamplesWithTs.length}），已中止合并`
    );
    err.code = 'FMP4_NO_SAMPLES';
    throw err;
  }

  for (let i = 0; i < videoSamplesWithTs.length; i++) {
    const s = videoSamplesWithTs[i];
    const meta = (i === 0 || s.isKey) ? { decoderConfig: videoDecoderConfig } : undefined;
    try {
      muxer.addVideoChunkRaw(
        s.data,
        s.isKey ? 'key' : 'delta',
        s.tsUs + s.ctOffsetUs,          // timestamp = PTS = DTS + ctOffset
        s.durationUs > 0 ? s.durationUs : 33333, // 默认 30fps
        meta,
        s.ctOffsetUs                    // compositionTimeOffset: PTS - DTS
      );
    } catch (err) {
      // 写入失败意味着该帧不在输出里：继续会产出静默丢帧/音画不同步的文件
      const wrapped = new Error(`视频样本 ${i} 写入失败，已中止合并: ${err.message}`);
      wrapped.code = 'FMP4_SAMPLE_WRITE_FAILED';
      wrapped.sampleIndex = i;
      wrapped.track = 'video';
      throw wrapped;
    }
    processedSamples++;
    if (i % 100 === 0) {
      onProgress?.(30 + Math.round((processedSamples / totalSamples) * 60));
    }
  }

  // 8. 写入音频样本
  const audioDecoderConfig = audioConfig.description ? {
    codec: audioConfig.codec === 'opus' ? 'opus' : 'aac',
    description: audioConfig.description,
    numberOfChannels: audioConfig.numberOfChannels,
    sampleRate: audioConfig.sampleRate,
  } : undefined;

  for (let i = 0; i < audioSamplesWithTs.length; i++) {
    const s = audioSamplesWithTs[i];
    const meta = (i === 0 && audioDecoderConfig) ? { decoderConfig: audioDecoderConfig } : undefined;
    try {
      muxer.addAudioChunkRaw(
        s.data,
        'key', // AAC 每帧都是关键帧
        s.tsUs,
        s.durationUs > 0 ? s.durationUs : 23220, // ~44100Hz 的帧时长
        meta
      );
    } catch (err) {
      const wrapped = new Error(`音频样本 ${i} 写入失败，已中止合并: ${err.message}`);
      wrapped.code = 'FMP4_SAMPLE_WRITE_FAILED';
      wrapped.sampleIndex = i;
      wrapped.track = 'audio';
      throw wrapped;
    }
    processedSamples++;
    if (i % 200 === 0) {
      onProgress?.(30 + Math.round((processedSamples / totalSamples) * 60));
    }
  }

  onProgress?.(92);

  // 9. 完成合并
  muxer.finalize();
  const { buffer } = target;
  muxerLog(`[BilibiliMuxer] 合并完成，输出大小=${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
  onProgress?.(100);

  return new Blob([buffer], { type: 'video/mp4' });
}

// ============================================================
// 从 moov 解析视频宽高
// ============================================================
function parseVideoDimensionsFromMoov(buffer, moovOffset, moovEnd) {
  const scanOffset = (moovOffset !== undefined) ? moovOffset : 0;
  const scanEnd = (moovEnd !== undefined) ? moovEnd : buffer.byteLength;
  const moovBoxes = parseBoxes(buffer, scanOffset, scanEnd);
  const trakEntry = moovBoxes.get('trak');
  const traks = Array.isArray(trakEntry) ? trakEntry : (trakEntry ? [trakEntry] : []);

  for (const trak of traks) {
    const trakBoxes = parseBoxes(buffer, trak.offset + 8, trak.offset + trak.size);
    const mdia = trakBoxes.get('mdia');
    if (!mdia) continue;
    const mdiaBoxes = parseBoxes(buffer, mdia.offset + 8, mdia.offset + mdia.size);

    const hdlr = mdiaBoxes.get('hdlr');
    if (hdlr) {
      const hdlrDv = new DataView(buffer, hdlr.offset + 8);
      const handler = String.fromCharCode(
        hdlrDv.getUint8(8), hdlrDv.getUint8(9), hdlrDv.getUint8(10), hdlrDv.getUint8(11)
      );
      if (handler !== 'vide') continue;
    }

    const minf = mdiaBoxes.get('minf');
    if (!minf) continue;
    const minfBoxes = parseBoxes(buffer, minf.offset + 8, minf.offset + minf.size);
    const stbl = minfBoxes.get('stbl');
    if (!stbl) continue;
    const stblBoxes = parseBoxes(buffer, stbl.offset + 8, stbl.offset + stbl.size);
    const stsd = stblBoxes.get('stsd');
    if (!stsd) continue;

    // stsd: fullbox header(4) + entry_count(4) = 8 bytes, then first entry
    const firstEntryOffset = stsd.offset + 8 + 8;
    // visual sample entry width/height 位于 size+type 之后偏移 24/26
    const widthOffset = firstEntryOffset + 8 + 24;
    const dv = new DataView(buffer, widthOffset);
    const width = dv.getUint16(0);
    const height = dv.getUint16(2);
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

// ============================================================
// 暴露全局对象
// ============================================================
var BilibiliMuxer = {
  // 仅测试用的内部件（零拷贝不变量需要直接断言）
  __internals: {
    collectFragments,
    extractAudioDecoderConfig,
    extractAvcDecoderConfig,
    extractVideoTimescale,
    findBox,
    parseBoxes,
    parseFragment,
    parseVideoDimensionsFromMoov,
  },
  mergeBilibiliDash,
  mergeFmp4Streams: mergeBilibiliDash,
};
if (typeof globalThis !== "undefined") {
  globalThis.BilibiliMuxer = BilibiliMuxer;
}
