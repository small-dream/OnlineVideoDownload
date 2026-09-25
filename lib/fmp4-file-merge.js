'use strict';

// 流式（文件级）fMP4 合并：把磁盘上的两路 fMP4（视频/音频）合成一个 MP4，
// 全程只把"盒子头 + 一个 moof + 一个片段的媒体数据"读进内存，峰值与文件体积无关。
//
// 为什么需要它：内存版 mergeFmp4Streams 要同时持有两路输入 + 合并输出 + Blob 物化
// （峰值 ≈3~4× 总字节），1.7GB 的视频必然抛 "Array buffer allocation failed"；
// 走这条路之后只有磁盘容量是上限。
//
// 两个阶段：
//   prepareFmp4FileMerge()  建立索引：稀疏读盒头 + 读 moov（小） + 逐片段解析样本描述
//                           （不读媒体数据）→ 调用方据此创建 Mp4Muxer
//   writePreparedFmp4()     按片段批量读样本数据喂给 Mp4Muxer（输出由调用方接到磁盘）
//
// 复用 BilibiliMuxer.__internals：moov 解码配置/时长基准/宽高解析 + 样本描述解析，
// 与内存版保持同一套口径。

(() => {
  if (globalThis.__OVD_FMP4_FILE_MERGE__) {
    return;
  }

  // 单个 moof 一般几 KB；给上限防止畸形流把内存吃光
  const MAX_MOOF_BYTES = 4 * 1024 * 1024;
  // 一个 moof 内的样本通常连续存放：按片段批量读，避免"每样本一次 IO"
  const MAX_BATCH_READ_BYTES = 32 * 1024 * 1024;
  const VIDEO_DEFAULT_SAMPLE_DURATION_US = 33333;
  const AUDIO_DEFAULT_SAMPLE_DURATION_US = 23220;

  function getInternals() {
    return globalThis.BilibiliMuxer?.__internals || {};
  }

  function getMp4Muxer() {
    return (typeof Mp4Muxer !== 'undefined' ? Mp4Muxer : globalThis.Mp4Muxer) || {};
  }

  /** 把 `{size, readRange}` 包装成按需读取的文件视图 */
  function createSourceReader(source, label = 'source') {
    if (!source || typeof source.readRange !== 'function' || !(Number(source.size) >= 0)) {
      throw new Error(`${label} 需要 { size, readRange(start, end) }`);
    }

    const size = Number(source.size) || 0;

    async function readRange(start, end) {
      const from = Math.max(0, Number(start) || 0);
      const to = Math.min(size, Number(end) || 0);
      if (!(to > from)) {
        return new Uint8Array(0);
      }
      const bytes = await source.readRange(from, to);
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    }

    return { label, readRange, size };
  }

  /**
   * 稀疏遍历顶层盒子（只读 8~16 字节盒头）。
   * @returns {Promise<Array<{offset: number, size: number, type: string}>>}
   */
  async function readTopLevelBoxes(reader) {
    const boxes = [];
    let pos = 0;

    while (pos + 8 <= reader.size) {
      const header = await reader.readRange(pos, Math.min(reader.size, pos + 16));
      if (header.byteLength < 8) {
        break;
      }

      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      let boxSize = view.getUint32(0);
      let headerSize = 8;
      if (boxSize === 1) {
        if (header.byteLength < 16) {
          break;
        }
        boxSize = view.getUint32(8) * 0x100000000 + view.getUint32(12);
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = reader.size - pos; // 延伸到文件末尾
      }

      const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
      if (boxSize < headerSize || pos + boxSize > reader.size) {
        const error = new Error(`${reader.label} 盒子 ${type} 长度异常：size=${boxSize} offset=${pos}`);
        error.code = 'FMP4_BOX_INVALID';
        throw error;
      }

      boxes.push({ offset: pos, size: boxSize, type });
      pos += boxSize;
    }

    return boxes;
  }

  /** 由顶层盒子推导 moof+mdat 对（只记偏移，不读媒体数据） */
  function collectFragmentsFromBoxes(boxes) {
    const fragments = [];
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index];
      if (box.type !== 'moof') {
        continue;
      }
      const next = boxes[index + 1];
      if (!next || next.type !== 'mdat') {
        continue;
      }

      fragments.push({
        mdatPayloadOffset: next.offset + 8,
        mdatPayloadSize: Math.max(0, next.size - 8),
        moofOffset: box.offset,
        moofPayloadOffset: box.offset + 8,
        moofPayloadSize: Math.max(0, box.size - 8),
      });
    }
    return fragments;
  }

  /**
   * 读取并解析 moov（只读这一小段），得到解码配置/时长基准/宽高。
   */
  async function readTrackMetadata(reader, boxes = null) {
    const topBoxes = boxes || await readTopLevelBoxes(reader);
    const moov = topBoxes.find((box) => box.type === 'moov');
    if (!moov) {
      const error = new Error(`${reader.label} 缺少 moov 盒子`);
      error.code = 'FMP4_NO_MOOV';
      throw error;
    }

    const moovBytes = await reader.readRange(moov.offset, moov.offset + moov.size);
    const moovBuffer = moovBytes.buffer.slice(moovBytes.byteOffset, moovBytes.byteOffset + moovBytes.byteLength);
    const internals = getInternals();
    const start = 8; // 跳过 size+type
    const end = moov.size;

    const safeCall = (fn, fallback, label) => {
      if (typeof fn !== 'function') {
        return fallback;
      }
      try {
        return fn(moovBuffer, start, end);
      } catch (err) {
        console.warn(`[OVD][FILE-MERGE] ${label} 解析失败 ${reader.label}: ${err.message}`);
        return fallback;
      }
    };

    return {
      audio: safeCall(internals.extractAudioDecoderConfig, null, '音频解码配置') || null,
      dimensions: safeCall(internals.parseVideoDimensionsFromMoov, null, '视频宽高') || null,
      moov,
      timescale: Number(safeCall(internals.extractVideoTimescale, 0, '时长基准')) || 0,
      video: safeCall(internals.extractAvcDecoderConfig, null, '视频解码配置') || null,
    };
  }

  /**
   * 逐片段解析样本描述信息（不读媒体数据）。
   * @returns {Promise<Array<{ctOffset: number, duration: number, isKey: boolean, offset: number, size: number}>>}
   */
  async function collectSampleDescriptors(reader, fragments) {
    const internals = getInternals();
    if (typeof internals.parseFragment !== 'function') {
      throw new Error('BilibiliMuxer.__internals.parseFragment 不可用');
    }

    const descriptors = [];
    for (const fragment of fragments) {
      const moofSize = fragment.moofPayloadSize + 8;
      if (moofSize > MAX_MOOF_BYTES) {
        const error = new Error(`${reader.label} 的 moof 过大（${moofSize} 字节），拒绝解析`);
        error.code = 'FMP4_MOOF_TOO_LARGE';
        throw error;
      }

      const moofBytes = await reader.readRange(fragment.moofOffset, fragment.moofOffset + moofSize);
      const moofBuffer = moofBytes.buffer.slice(moofBytes.byteOffset, moofBytes.byteOffset + moofBytes.byteLength);
      const samples = internals.parseFragment(moofBuffer, {
        mdatPayloadOffset: fragment.mdatPayloadOffset - fragment.moofOffset,
        mdatPayloadSize: 0, // 只取描述，不在这里校验越界（下面按文件大小校验）
        moofPayloadOffset: fragment.moofPayloadOffset - fragment.moofOffset,
        moofPayloadSize: fragment.moofPayloadSize,
      }, { descriptorsOnly: true });

      for (const sample of samples) {
        const absoluteOffset = fragment.moofOffset + sample.offset;
        if (absoluteOffset + sample.size > reader.size) {
          const error = new Error(
            `${reader.label} 样本越界：[${absoluteOffset}, ${absoluteOffset + sample.size}) 超出文件 ${reader.size} 字节`
          );
          error.code = 'FMP4_SAMPLE_OUT_OF_RANGE';
          throw error;
        }
        descriptors.push({ ...sample, offset: absoluteOffset });
      }
    }

    return descriptors;
  }

  /** 按给定时长基准把样本换算成微秒时间戳（与内存版口径一致） */
  function withTimestamps(descriptors, timescale, defaultDurationUs) {
    const scale = Number(timescale) > 0 ? Number(timescale) : 1000;
    let cursor = 0;
    const output = [];
    for (const sample of descriptors) {
      const durationUs = Math.round((sample.duration / scale) * 1_000_000);
      output.push({
        ctOffsetUs: Math.round(((sample.ctOffset || 0) / scale) * 1_000_000),
        durationUs: durationUs > 0 ? durationUs : (defaultDurationUs || 0),
        isKey: !!sample.isKey,
        offset: sample.offset,
        size: sample.size,
        tsUs: Math.round((cursor / scale) * 1_000_000),
      });
      cursor += Number(sample.duration) || 0;
    }
    return output;
  }

  /** 一个 moof 内的样本通常连续：合并相邻读取，减少 IO 次数 */
  function planReadBatches(samples) {
    const batches = [];
    let current = null;
    for (const sample of samples) {
      if (current
        && sample.offset - (current.offset + current.size) <= 65536
        && (current.size + sample.size) <= MAX_BATCH_READ_BYTES) {
        current.size = (sample.offset + sample.size) - current.offset;
        current.samples.push(sample);
        continue;
      }
      current = { offset: sample.offset, samples: [sample], size: sample.size };
      batches.push(current);
    }
    return batches;
  }

  function buildDecoderConfigs(videoMeta, audioMeta) {
    return {
      audio: audioMeta?.audio
        ? {
          codec: audioMeta.audio.codec === 'opus' ? 'opus' : 'aac',
          description: audioMeta.audio.description,
          numberOfChannels: audioMeta.audio.numberOfChannels,
          sampleRate: audioMeta.audio.sampleRate,
        }
        : undefined,
      video: videoMeta?.video
        ? { codec: videoMeta.video.codec, description: videoMeta.video.description }
        : undefined,
    };
  }

  /**
   * 建立索引：盒头 + moov + 全部样本描述（不读媒体数据）。
   * 返回的信息足够调用方构造 Mp4Muxer。
   */
  async function prepareFmp4FileMerge({ audio, onProgress, video } = {}) {
    const videoReader = createSourceReader(video, 'video');
    const audioReader = createSourceReader(audio, 'audio');

    const videoBoxes = await readTopLevelBoxes(videoReader);
    const audioBoxes = await readTopLevelBoxes(audioReader);
    onProgress?.(5, { phase: 'indexing' });

    const videoMeta = await readTrackMetadata(videoReader, videoBoxes);
    const audioMeta = await readTrackMetadata(audioReader, audioBoxes);
    onProgress?.(12, { phase: 'metadata' });

    const videoSamples = withTimestamps(
      await collectSampleDescriptors(videoReader, collectFragmentsFromBoxes(videoBoxes)),
      videoMeta.timescale || 1000,
      VIDEO_DEFAULT_SAMPLE_DURATION_US
    );
    const audioSamples = withTimestamps(
      await collectSampleDescriptors(audioReader, collectFragmentsFromBoxes(audioBoxes)),
      audioMeta.audio?.timescale || 44100,
      AUDIO_DEFAULT_SAMPLE_DURATION_US
    );

    if (videoSamples.length === 0 || audioSamples.length === 0) {
      const error = new Error(
        `样本解析结果为空（视频 ${videoSamples.length} / 音频 ${audioSamples.length}），已中止合并`
      );
      error.code = 'FMP4_NO_SAMPLES';
      throw error;
    }

    return {
      audioDecoderConfig: buildDecoderConfigs(videoMeta, audioMeta).audio,
      audioReader,
      audioSamples,
      audioTimescale: audioMeta.audio?.timescale || 44100,
      videoDecoderConfig: buildDecoderConfigs(videoMeta, audioMeta).video,
      videoDimensions: videoMeta.dimensions || null,
      videoReader,
      videoSamples,
      videoTimescale: videoMeta.timescale || 1000,
    };
  }

  async function feedTrack({ decoderConfig, descriptors, muxer, onProgress, reader, track }) {
    const defaultDurationUs = track === 'video'
      ? VIDEO_DEFAULT_SAMPLE_DURATION_US
      : AUDIO_DEFAULT_SAMPLE_DURATION_US;
    let index = 0;

    for (const batch of planReadBatches(descriptors)) {
      const bytes = await reader.readRange(batch.offset, batch.offset + batch.size);
      for (const sample of batch.samples) {
        const localOffset = sample.offset - batch.offset;
        const data = bytes.subarray(localOffset, localOffset + sample.size);
        // 与内存版一致：首样本与关键帧携带 decoderConfig，其余不带
        const meta = (track === 'video')
          ? ((index === 0 || sample.isKey) && decoderConfig ? { decoderConfig } : undefined)
          : ((index === 0 && decoderConfig) ? { decoderConfig } : undefined);

        try {
          if (track === 'video') {
            muxer.addVideoChunkRaw(
              data,
              sample.isKey ? 'key' : 'delta',
              sample.tsUs + sample.ctOffsetUs,
              sample.durationUs || defaultDurationUs,
              meta,
              sample.ctOffsetUs
            );
          } else {
            muxer.addAudioChunkRaw(data, 'key', sample.tsUs, sample.durationUs || defaultDurationUs, meta);
          }
        } catch (err) {
          const wrapped = new Error(`${track === 'video' ? '视频' : '音频'}样本 ${index} 写入失败: ${err.message}`);
          wrapped.code = 'FMP4_SAMPLE_WRITE_FAILED';
          wrapped.sampleIndex = index;
          wrapped.track = track;
          throw wrapped;
        }
        index++;
      }
      onProgress?.(index, descriptors.length, track);
    }
  }

  /**
   * 把索引好的样本喂给 muxer（调用方负责把 muxer 的输出接到磁盘/目标）。
   * @returns {Promise<{audioSamples: number, videoSamples: number, totalSamples: number}>}
   */
  async function writePreparedFmp4({ muxer, onProgress, prepared } = {}) {
    if (!prepared?.videoReader || !prepared?.audioReader || !prepared?.videoSamples || !prepared?.audioSamples) {
      throw new Error('writePreparedFmp4 需要 prepareFmp4FileMerge 的结果');
    }
    if (!muxer || typeof muxer.addVideoChunkRaw !== 'function' || typeof muxer.addAudioChunkRaw !== 'function') {
      throw new Error('writePreparedFmp4 需要一个可用的 Mp4Muxer 实例');
    }

    const totalSamples = prepared.videoSamples.length + prepared.audioSamples.length;
    let processed = 0;
    const report = () => {
      onProgress?.(14 + Math.round((processed / totalSamples) * 82), { phase: 'muxing' });
    };

    await feedTrack({
      decoderConfig: prepared.videoDecoderConfig,
      descriptors: prepared.videoSamples,
      muxer,
      onProgress: (index) => {
        processed = index;
        report();
      },
      reader: prepared.videoReader,
      track: 'video',
    });

    await feedTrack({
      decoderConfig: prepared.audioDecoderConfig,
      descriptors: prepared.audioSamples,
      muxer,
      onProgress: (index) => {
        processed = prepared.videoSamples.length + index;
        report();
      },
      reader: prepared.audioReader,
      track: 'audio',
    });

    return {
      audioSamples: prepared.audioSamples.length,
      totalSamples,
      videoSamples: prepared.videoSamples.length,
    };
  }

  globalThis.__OVD_FMP4_FILE_MERGE__ = Object.freeze({
    MAX_BATCH_READ_BYTES,
    MAX_MOOF_BYTES,
    collectFragmentsFromBoxes,
    collectSampleDescriptors,
    createSourceReader,
    getMp4Muxer,
    planReadBatches,
    prepareFmp4FileMerge,
    readTopLevelBoxes,
    readTrackMetadata,
    withTimestamps,
    writePreparedFmp4,
  });
})();
