'use strict';

(() => {
  if (globalThis.__OVD_BILIBILI_STRATEGY__) {
    return;
  }

  const messageTypes = globalThis.__OVD_MESSAGE_TYPES__?.MESSAGE_TYPES || {};
  const MSG = messageTypes;
  const qualityUtils = globalThis.__OVD_BILIBILI_QUALITY_UTILS__ || {};
  // 国际化：优先 chrome.i18n（见 lib/i18n.js）；未加载时本地退回中文原文，
  // 并同样处理 $1..$9 占位符，避免出现裸露的占位符。
  const i18n = globalThis.__OVD_I18N__ || {};
  const t = typeof i18n.t === 'function'
    ? i18n.t
    : (_key, fallback, subs) => {
      if (!fallback || !subs) {
        return fallback;
      }
      const list = Array.isArray(subs) ? subs : [subs];
      return String(fallback).replace(/\$(\d)/g, (match, index) => {
        const value = list[Number(index) - 1];
        return value == null ? match : String(value);
      });
    };

  const constants = globalThis.__OVD_CONSTANTS__ || {};
  // 阶段进度 → 统一进度（抓取 0..90、合并 90..99），与 background 抓取阶段共用同一映射
  const progressScale = globalThis.__OVD_PROGRESS_SCALE__ || {};
  const DEFAULT_MAX_MERGE_BYTES = 2 * 1024 * 1024 * 1024;

  function createBilibiliStrategy(options = {}) {
    const {
      calcWrid = null,
      fetchMediaStreamsAndWait = () => Promise.reject(new Error('fetchMediaStreamsAndWait unavailable')),
      getFloatButton = () => null,
      sendMessageAsync = () => Promise.reject(new Error('sendMessageAsync unavailable')),
      triggerBlobDownload = () => {},
      videoUtils = {},
    } = options;

    async function fetchJsonWithContext(url, requestOptions, phaseLabel) {
      let response;
      try {
        response = await fetch(url, requestOptions);
      } catch (err) {
        throw new Error(`${phaseLabel}: ${err.message}`);
      }

      if (!response.ok) {
        throw new Error(`${phaseLabel}: HTTP ${response.status} ${response.statusText}`);
      }

      try {
        return await response.json();
      } catch (err) {
        throw new Error(`${phaseLabel}: 响应解析失败 (${err.message})`);
      }
    }

    async function saveBlobViaBrowserDownload(blob, filename, context = {}, meta = {}) {
      const objectUrl = URL.createObjectURL(blob);

      try {
        const response = await sendMessageAsync({
          filename,
          objectUrl,
          sourceId: context.sourceId || 'bilibili',
          strategyId: context.strategyId || 'page-api',
          taskKey: context.taskKey || '',
          title: context.title || meta?.title || '',
          type: MSG.DOWNLOAD_BLOB_DATA || 'DOWNLOAD_BLOB_DATA',
          traceId: context.traceId || '',
          videoInfo: context.videoInfo || meta || null,
          videoUrl: context.videoUrl || meta?.url || '',
        });

        if (response?.ok) {
          return response;
        }

        throw new Error(response?.error || '浏览器保存失败');
      } catch (err) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch (revokeErr) {
          console.warn(`[OVD] failed to revoke Bilibili object URL: ${revokeErr.message}`);
        }

        console.warn(`[OVD] Bilibili browser save failed, fallback to in-page blob download: ${err.message}`);
        triggerBlobDownload(blob, filename, {
          sourceId: context.sourceId || 'bilibili',
          strategyId: context.strategyId || 'page-api',
          taskKey: context.taskKey || '',
          title: context.title || meta?.title || '',
          traceId: context.traceId || '',
          videoInfo: context.videoInfo || meta || null,
          videoUrl: context.videoUrl || meta?.url || '',
        });
        return { error: err.message, fallback: true, ok: true };
      }
    }

    /**
     * 调用 Bilibili playurl API 并返回原始播放数据
     * @param {Object} meta - 包含 bvid, cid 的视频元信息
     * @param {string} qn - 请求的画质上限（默认 '127' 即最高）
     * @returns {Object} playData - playurl API 的完整响应
     */
    async function fetchPlayData(meta, qn = '127') {
      const cid = meta?.cid;
      if (!cid) {
        throw new Error('无法获取 cid，请刷新页面重试');
      }

      console.log(`[OVD] Bilibili fetchPlayData bvid=${meta?.bvid || ''} cid=${cid} qn=${qn}`);

      const navData = await fetchJsonWithContext('https://api.bilibili.com/x/web-interface/nav', {
        credentials: 'include',
      }, '获取 Bilibili 导航信息失败');

      let imgKey = '';
      let subKey = '';
      const wbiImg = navData?.data?.wbi_img;
      if (wbiImg) {
        imgKey = wbiImg.img_url?.match(/([a-zA-Z0-9]+)\.png/)?.[1] || '';
        subKey = wbiImg.sub_url?.match(/([a-zA-Z0-9]+)\.png/)?.[1] || '';
      }

      const wts = Math.floor(Date.now() / 1000);
      const params = {
        bvid: meta.bvid || '',
        cid: String(cid),
        fnval: '4048',
        fnver: '0',
        fourk: '1',
        qn: String(qn),
        wts: String(wts),
      };

      params.w_rid = await calcWrid(params, imgKey, subKey);
      const queryString = new URLSearchParams(
        Object.keys(params).sort().reduce((acc, key) => {
          acc[key] = params[key];
          return acc;
        }, {})
      ).toString();

      const playData = await fetchJsonWithContext(`https://api.bilibili.com/x/player/playurl?${queryString}`, {
        credentials: 'include',
        headers: { Referer: 'https://www.bilibili.com' },
      }, '获取 Bilibili 播放地址失败');

      if (playData.code !== 0) {
        throw new Error(`B站 API 错误 ${playData.code}: ${playData.message}`);
      }

      return playData;
    }

    /**
     * 取 Bilibili 字幕轨列表（player/v2）。
     * 该接口要带页面 Cookie，只能在页面上下文调用，因此和画质一起在这里取；
     * 真正的字幕取流/转换/保存由 SW 完成（见 background/subtitle-downloader.js）。
     * @param {Object} meta - 包含 bvid, cid 的视频元信息
     * @returns {Promise<Array<{isAsr: boolean, languageCode: string, languageName: string, url: string}>>}
     */
    async function fetchSubtitleTracks(meta) {
      if (!meta?.cid || !meta?.bvid) {
        return [];
      }

      try {
        const query = new URLSearchParams({ bvid: meta.bvid, cid: String(meta.cid) });
        const data = await fetchJsonWithContext(
          `https://api.bilibili.com/x/player/v2?${query.toString()}`,
          {
            credentials: 'include',
            headers: { Referer: 'https://www.bilibili.com' },
          },
          '获取 Bilibili 字幕列表失败'
        );

        const list = data?.data?.subtitle?.subtitles;
        if (!Array.isArray(list)) {
          return [];
        }

        const tracks = list
          .filter((item) => item?.subtitle_url)
          .map((item) => ({
            isAsr: Number(item.ai_status) === 1 || /^ai[-_]/i.test(String(item.id_str || item.id || '')),
            languageCode: item.lan || '',
            languageName: item.lan_doc || item.lan || '',
            // 接口返回的地址可能是 //aisubtitle.hdslb.com/... 协议相对形式
            url: String(item.subtitle_url).startsWith('//')
              ? `https:${item.subtitle_url}`
              : String(item.subtitle_url),
          }));
        console.log(`[OVD] Bilibili 字幕轨 count=${tracks.length} langs=${tracks.map((track) => track.languageCode).join(', ')}`);
        return tracks;
      } catch (err) {
        // 字幕是可选增强：拿不到不影响画质列表与下载
        console.warn(`[OVD] Bilibili 字幕列表获取失败: ${err.message}`);
        return [];
      }
    }

    /**
     * 获取 Bilibili 视频可用清晰度列表
     * 供 popup 通过 message-router 调用，延迟加载
     * @param {Object} meta - 包含 bvid, cid 的视频元信息
     * @returns {Object} { qualities: [{id, label}], acceptQuality: number, subtitles: [...] }
     */
    async function fetchQualities(meta) {
      const [playData, subtitles] = await Promise.all([
        fetchPlayData(meta, '127'),
        fetchSubtitleTracks(meta),
      ]);

      const dash = playData?.data?.dash;
      if (!dash || !Array.isArray(dash.video)) {
        console.warn('[OVD] Bilibili playurl 响应不包含 DASH 数据，无法获取清晰度列表');
        return { acceptQuality: 0, qualities: [], subtitles };
      }

      const videoStreams = dash.video.sort((left, right) => right.id - left.id);
      const qualities = qualityUtils.listAvailableBilibiliQualities?.(videoStreams) || [];
      const acceptQuality = videoStreams[0]?.id || 0;

      console.log(`[OVD] Bilibili 可用清晰度 count=${qualities.length} acceptQuality=${acceptQuality} qualities=${qualities.map((q) => q.label).join(', ')}`);
      return { acceptQuality, dash, qualities, subtitles };
    }

    // 仅音频下载：容器由音轨 MIME 决定（B 站通常为 audio/mp4 → .m4a）
    function resolveBilibiliAudioContainer(stream) {
      if (/audio\/webm/i.test(stream?.mimeType || '')) {
        return { ext: '.webm', mimeType: 'audio/webm' };
      }
      if (/audio\/(?:mpeg|l4a|aac)/i.test(stream?.mimeType || '')) {
        return { ext: '.mp3', mimeType: 'audio/mpeg' };
      }
      return { ext: '.m4a', mimeType: 'audio/mp4' };
    }

    /**
     * 「仅音频」下载：只取 DASH 音轨，不做音视频合并。
     * 复用后台抓流通道（仅音频），回传后按音轨 MIME 保存。
     * @param {string[]} audioUrls - 音频流候选地址（主地址 + 备用 CDN）
     * @param {string} title - 视频标题
     * @param {Object} headers - 请求头
     * @param {Object} stream - 选中的音频流（读取 mimeType 决定容器）
     */
    async function downloadBilibiliAudioOnly(audioUrls, title, headers, progressReporter, context = {}, meta = {}, stream = null) {
      getFloatButton()?.showMessage(t('bili_fetchingAudio', '正在获取 Bilibili 音频数据...'), false, 0);
      progressReporter?.status(t('bili_fetchingAudio', '正在获取 Bilibili 音频数据...'));
      progressReporter?.progress(0, { phase: 'fetching' });

      // 只抓音轨：videoUrls 传空数组，后台不会再下载整段视频
      const { audioBuffer } = await fetchMediaStreamsAndWait(
        [],
        audioUrls,
        headers,
        'bili-audio',
        '等待 Bilibili 音频数据回传超时',
        {
          sourceId: context.sourceId || 'bilibili',
          strategyId: context.strategyId || 'page-api',
          taskKey: context.taskKey || '',
          title: context.title || meta?.title || title || '',
          traceId: context.traceId || '',
          videoUrl: context.videoUrl || meta?.url || '',
        }
      );

      if (context?.signal?.aborted) {
        const aborted = new Error('下载已取消');
        aborted.code = 'DOWNLOAD_ABORTED';
        throw aborted;
      }

      const { ext, mimeType } = resolveBilibiliAudioContainer(stream);
      const filename = videoUtils.buildMediaFilename?.({
        ext,
        fallback: 'bilibili_audio',
        title,
        type: 'audio',
      }) || `bilibili_audio${ext}`;

      const blob = new Blob([audioBuffer], { type: mimeType });
      const saveResult = await saveBlobViaBrowserDownload(blob, filename, context, meta);
      getFloatButton()?.showProgress(100);
      getFloatButton()?.showMessage(t('download_doneShort', '下载完成: $1', [filename]));
      progressReporter?.progress(100, { phase: 'complete' });
      console.log(`[OVD] Bilibili 音频下载完成 filename=${filename} size=${(blob.size / 1024 / 1024).toFixed(2)} MB`);
      return {
        ...saveResult,
        filename,
        ok: true,
        size: blob.size,
      };
    }

    /**
     * 合并 Bilibili DASH 视音频流并触发下载
     * @param {string[]} videoUrls - 视频流候选地址（主地址 + 备用 CDN）
     * @param {string[]} audioUrls - 音频流候选地址（主地址 + 备用 CDN）
     * @param {string} title - 视频标题
     * @param {Object} headers - 请求头
     */
    async function mergeBilibiliDashAndDownload(videoUrls, audioUrls, title, headers, progressReporter, context = {}, meta = {}) {
      getFloatButton()?.showMessage(t('bili_fetching', '正在获取 Bilibili 视音频数据...'), false, 0);
      getFloatButton()?.showProgress(0);
      progressReporter?.status(t('bili_fetching', '正在获取 Bilibili 视音频数据...'));
      progressReporter?.progress(0, { phase: 'fetching' });

      const { videoBuffer, audioBuffer } = await fetchMediaStreamsAndWait(
        videoUrls,
        audioUrls,
        headers,
        'bili',
        '等待 Bilibili 视音频数据回传超时',
        {
          sourceId: context.sourceId || 'bilibili',
          strategyId: context.strategyId || 'page-api',
          taskKey: context.taskKey || '',
          title: context.title || meta?.title || title || '',
          traceId: context.traceId || '',
          videoUrl: context.videoUrl || meta?.url || '',
        }
      );

      console.log(`[OVD] Bilibili 视频流大小=${(videoBuffer.byteLength / 1024 / 1024).toFixed(2)} MB 音频流大小=${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

      // 内容侧取消通道：数据已回传但尚未合并时，取消仍然有效
      if (context?.signal?.aborted) {
        const aborted = new Error('下载已取消');
        aborted.code = 'DOWNLOAD_ABORTED';
        throw aborted;
      }

      // 与 DASH/HLS 一致的体积守卫：超过上限时明确报错，
      // 避免浏览器内合并直接 OOM 崩掉整个页面（此前仅打日志）。
      const maxMergeBytes = constants.MAX_IN_PAGE_MERGE_BYTES || DEFAULT_MAX_MERGE_BYTES;
      const estimatedTotal = videoBuffer.byteLength + audioBuffer.byteLength;
      if (maxMergeBytes > 0 && estimatedTotal > maxMergeBytes) {
        // 分离文件降级：体积超限不再直接失败，改为分别保存视频与音频两个文件
        const totalMb = (estimatedTotal / 1024 / 1024).toFixed(0);
        const maxMb = Math.round(maxMergeBytes / 1024 / 1024);
        const message = t('bili_tooLarge', 'Bilibili 视频体积 $1 MB 超过浏览器内合并上限 $2 MB，改为分别保存视频与音频文件（可用本地工具合并）', [totalMb, String(maxMb)]);
        console.warn(`[OVD] ${message}`);
        progressReporter?.status?.(message);
        getFloatButton()?.showMessage(message, false, 0);

        const baseName = videoUtils.buildMediaFilename?.({
          ext: '.mp4',
          fallback: 'bilibili_video',
          title,
        }) || 'bilibili_video.mp4';
        const stem = baseName.replace(/\.mp4$/i, '');
        const videoFilename = `${stem}-video.mp4`;
        const audioFilename = `${stem}-audio.mp4`;

        const videoSave = await saveBlobViaBrowserDownload(
          new Blob([videoBuffer], { type: 'video/mp4' }),
          videoFilename,
          context,
          meta
        );
        await saveBlobViaBrowserDownload(
          new Blob([audioBuffer], { type: 'audio/mp4' }),
          audioFilename,
          context,
          meta
        );

        progressReporter?.progress(100, { phase: 'complete' });
        getFloatButton()?.showProgress(100);
        return {
          ...videoSave,
          filename: videoFilename,
          ok: true,
          separateFiles: [videoFilename, audioFilename],
          size: estimatedTotal,
        };
      }

      getFloatButton()?.showMessage(t('bili_merging', '正在合并 Bilibili 视音频...'), false, 0);
      progressReporter?.status(t('bili_merging', '正在合并 Bilibili 视音频...'));

      const blob = await BilibiliMuxer.mergeFmp4Streams(videoBuffer, audioBuffer, (percent) => {
        // 映射到统一进度：抓取阶段已推进到 90%，合并阶段接着走到 99%，
        // 完成后由 phase: 'complete' 补到 100%；浮条与 popup 条目/任务列表读同一个数字。
        const unifiedPercent = progressScale.mapPhasePercent?.('merging', percent) ?? percent;
        getFloatButton()?.showMessage(t('bili_mergingPercent', '合并中... $1%', [String(unifiedPercent)]), false, 0);
        getFloatButton()?.showProgress(unifiedPercent);
        progressReporter?.progress(unifiedPercent, { phase: 'merging' });
      });

      const filename = videoUtils.buildMediaFilename({
        ext: '.mp4',
        fallback: 'bilibili_video',
        title,
      });

      const saveResult = await saveBlobViaBrowserDownload(blob, filename, context, meta);
      getFloatButton()?.showProgress(100);
      getFloatButton()?.showMessage(t('download_doneShort', '下载完成: $1', [filename]));
      progressReporter?.progress(100, { phase: 'complete' });
      console.log(`[OVD] Bilibili 视音频合并完成 filename=${filename} size=${(blob.size / 1024 / 1024).toFixed(2)} MB`);
      return {
        ...saveResult,
        filename,
        ok: true,
        size: blob.size,
      };
    }

    /**
     * 处理 Bilibili 视频下载（支持清晰度选择）
     * @param {Object} meta - 视频元信息，包含 downloadOptions.qualityId
     * @param {HTMLElement} buttonElement - 触发下载的按钮元素
     */
    async function handleBilibiliDownload(meta, buttonElement, progressReporter, context = {}) {
      getFloatButton()?.showMessage(t('bili_fetchingUrl', '正在获取 Bilibili 视频地址...'), false, 0);
      progressReporter?.status(t('bili_fetchingUrl', '正在获取 Bilibili 视频地址...'));

      try {
        const qualityId = meta?.downloadOptions?.qualityId || 'auto';
        const qn = qualityId === 'auto' ? '127' : String(qualityId);

        console.log(`[OVD] Bilibili 开始下载 bvid=${meta?.bvid || ''} cid=${meta?.cid || ''} qualityId=${qualityId} qn=${qn}`);

        const playData = await fetchPlayData(meta, qn);
        const data = playData.data;
        const requiredHeaders = { Referer: 'https://www.bilibili.com' };

        if (data.dash) {
          const videoStreams = Array.isArray(data.dash.video)
            ? data.dash.video.slice().sort((left, right) => right.id - left.id)
            : [];
          const audioStreams = Array.isArray(data.dash.audio)
            ? data.dash.audio.slice().sort((left, right) => right.id - left.id)
            : [];

          const selectedAudio = qualityUtils.pickBilibiliAudioStream?.(audioStreams) || audioStreams[0];

          // B 站会同时返回主地址与备用 CDN 地址（backupUrl）。主地址常是 PCDN 边缘节点，
          // 部分网络下不可达；把备用地址一起交给后台按顺序回退，避免「主地址失败即整体失败」。
          const audioUrls = qualityUtils.listBilibiliStreamUrls?.(selectedAudio)
            || [selectedAudio?.baseUrl || selectedAudio?.base_url].filter(Boolean);

          // 仅音频：只下载音轨（无需视频流，也不再合并）
          if (meta?.downloadOptions?.audioOnly) {
            if (audioUrls.length === 0) {
              throw new Error('无法获取音频流地址');
            }
            const audioQualityLabel = qualityUtils.BILIBILI_QUALITY_LABELS?.[selectedAudio?.id] || `${selectedAudio?.id}K`;
            console.log(`[OVD] Bilibili 仅音频模式：选中音频流 id=${selectedAudio?.id} (${audioQualityLabel})`);
            return downloadBilibiliAudioOnly(audioUrls, meta.title, requiredHeaders, progressReporter, context, meta, selectedAudio);
          }

          const selectedVideo = qualityUtils.pickBilibiliVideoStream?.(videoStreams, qualityId) || videoStreams[0];
          const videoUrls = qualityUtils.listBilibiliStreamUrls?.(selectedVideo)
            || [selectedVideo?.baseUrl || selectedVideo?.base_url].filter(Boolean);

          if (videoUrls.length === 0 || audioUrls.length === 0) {
            throw new Error('无法获取音视频流地址');
          }

          const videoQualityLabel = qualityUtils.BILIBILI_QUALITY_LABELS?.[selectedVideo.id] || `${selectedVideo.id}P`;
          const audioQualityLabel = qualityUtils.BILIBILI_QUALITY_LABELS?.[selectedAudio.id] || `${selectedAudio.id}K`;
          console.log(`[OVD] Bilibili 选中视频流: id=${selectedVideo.id} (${videoQualityLabel}) 编解码器=${selectedVideo.codecid}`);
          console.log(`[OVD] Bilibili 选中音频流: id=${selectedAudio.id} (${audioQualityLabel})`);

          return mergeBilibiliDashAndDownload(videoUrls, audioUrls, meta.title, requiredHeaders, progressReporter, context, meta);
        }

        if (data.durl) {
          const result = await sendMessageAsync({
            payload: {
              requestHeaders: requiredHeaders,
              title: meta.title,
              type: 'direct',
              url: data.durl[0].url,
            },
            sourceId: context.sourceId || 'bilibili',
            strategyId: context.strategyId || 'page-api',
            taskKey: context.taskKey || '',
            title: context.title || meta?.title || '',
            traceId: context.traceId || '',
            videoInfo: context.videoInfo || meta || null,
            videoUrl: context.videoUrl || meta?.url || '',
            type: MSG.DOWNLOAD_VIDEO || 'DOWNLOAD_VIDEO',
          });

          if (!result?.ok) {
            throw new Error(result?.error || '下载失败');
          }

          getFloatButton()?.showMessage(t('download_started_short', '下载已开始'));
          progressReporter?.status(t('download_started_short', '下载已开始'));
          if (buttonElement) {
            const downloadId = result.downloadId ?? result.results?.[0]?.downloadId;
            if (downloadId != null) {
              buttonElement.dataset.downloadId = downloadId;
            }
          }
          return result;
        }

        throw new Error('无法解析 B站 视频格式');
      } catch (err) {
        getFloatButton()?.showMessage(t('bili_failed', 'Bilibili 下载失败: $1', [err.message]), true);
        progressReporter?.status(t('bili_failed', 'Bilibili 下载失败: $1', [err.message]), { level: 'error' });
        console.error('[OVD] Bilibili download error:', err);
        throw err;
      } finally {
        if (buttonElement) {
          buttonElement.disabled = false;
          buttonElement.textContent = '下载';
        }
      }
    }

    return {
      download(meta, context) {
        return handleBilibiliDownload(meta, context.buttonElement, context.progressReporter, context);
      },
      fetchJsonWithContext,
      fetchPlayData,
      fetchQualities,
      handleBilibiliDownload,
      id: 'page-api',
      mergeBilibiliDashAndDownload,
      priority: 100,
    };
  }

  globalThis.__OVD_BILIBILI_STRATEGY__ = {
    createBilibiliStrategy,
  };
})();
