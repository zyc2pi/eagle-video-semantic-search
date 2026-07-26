/* Auto-scenes-extraction 服务 /api/v1 客户端 */
const Api = (() => {
  async function fetchJson(url, options = {}, timeoutMs = 0) {
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      const data = await resp.json().catch(() => null);
      return { ok: resp.ok, status: resp.status, data };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function post(path, body) {
    return fetchJson(`${Config.baseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
  }

  async function health(timeoutMs = 1500) {
    try {
      const r = await fetchJson(`${Config.baseUrl()}/api/v1/health`, {}, timeoutMs);
      return r.ok && r.data && r.data.success === true;
    } catch {
      return false;
    }
  }

  async function listIndexes() {
    const r = await fetchJson(`${Config.baseUrl()}/api/v1/indexes`);
    return (r.data && r.data.indexes) || [];
  }

  async function listModels() {
    const r = await fetchJson(`${Config.baseUrl()}/api/v1/models`);
    return (r.data && r.data.models) || [];
  }

  function startIndex(videoPaths, indexName, modelName, rebuild = false) {
    const cfg = Config.get();
    return post('/api/v1/index', {
      video_paths: videoPaths,
      index_name: indexName,
      model_name: modelName,
      resume: !rebuild,
      options: {
        sample_interval: cfg.indexSampleInterval,
        output_resolution: String(cfg.indexResolution),
        min_scene_length: cfg.indexMinSceneLen,
        batch_size: cfg.indexBatchSize,
        cosine_similarity_threshold: cfg.indexSceneThreshold,
        localmax_order: cfg.indexLocalmaxOrder,
        use_fp16: !!cfg.indexFp16,
      },
    });
  }

  async function indexStatus() {
    const r = await fetchJson(`${Config.baseUrl()}/api/v1/index/status`);
    return r.data;
  }

  function cancelIndex() {
    return post('/api/v1/index/cancel', {});
  }

  /**
   * 视觉检索。payload 查询源三选一：
   *   { image_base64 } | { image_path } | { video_path, start_frame?, end_frame? }
   */
  function searchVisual(payload, indices, threshold) {
    const cfg = Config.get();
    const isScene = payload.start_frame != null || payload.end_frame != null;
    return post('/api/v1/search_visual', {
      ...payload,
      indices,
      threshold,
      top_k: 100,
      exclude_self: true,
      relative_margin: cfg.visualMargin,
      scene_aggregation: cfg.visualAgg || 'mean',
      centered: !!cfg.visualCentered,
      query_frames: isScene ? cfg.visualSceneFrames : cfg.visualVideoFrames,
    });
  }

  function search(query, indices, threshold) {
    const cfg = Config.get();
    return post('/api/v1/search', {
      query,
      indices,
      threshold,
      start_frame_offset: -2,
      end_frame_offset: 2,
      // 设置页的增强开关
      ai_search_enabled: !!cfg.aiEnhance,
      bilingual_search: !!cfg.aiEnhance,
      use_dedup: !!cfg.dedup,
      use_mini_rerank: !!cfg.miniRerank,
    });
  }

  /* 批量导出片段为真实 MP4，clips: [{video_path, start_frame, end_frame}]，prompt 用作导出目录名 */
  function exportClips(clips, prompt) {
    return post('/api/v1/export', {
      clips: clips.map((m) => ({
        video_path: m.video_path,
        start_frame: m.start_frame,
        end_frame: m.end_frame,
        start: m.start,
        end: m.end,
      })),
      mode: 'copy',
      prompt,
    });
  }

  function shutdown() {
    return post('/api/v1/shutdown', {});
  }

  /* 视频内容 → 搜索提示词（MiniCPM 视觉模型，首次调用加载模型较慢） */
  function describe(payload) {
    return post('/api/v1/describe', {
      ...payload,
      keep_model: !!Config.get().miniKeepLoaded,
    });
  }

  /* 混合检索：文本提示词 × 视觉片段 两路融合 */
  function searchHybrid(query, payload, indices) {
    const cfg = Config.get();
    return post('/api/v1/search_hybrid', {
      query,
      ...payload,
      indices,
      text_threshold: cfg.threshold,
      visual_threshold: cfg.visualThreshold,
      relative_margin: cfg.visualMargin,
      scene_aggregation: cfg.visualAgg || 'mean',
      centered: !!cfg.visualCentered,
      query_frames: cfg.visualSceneFrames,
      top_k: 100,
      exclude_self: true,
      start_frame_offset: -2,
      end_frame_offset: 2,
    });
  }

  /* 生成 H.264 片段文件并返回本地路径（供拖拽到剪辑软件） */
  function clipFile(videoPath, startFrame, endFrame) {
    return post('/api/v1/clip_file', {
      video_path: videoPath,
      start_frame: startFrame,
      end_frame: endFrame,
    });
  }

  /* 查询索引内已收录的视频路径（供未索引提醒对比） */
  async function indexContents(lancePath) {
    const r = await fetchJson(
      `${Config.baseUrl()}/api/v1/index/contents?path=${encodeURIComponent(lancePath)}`);
    return (r.data && r.data.video_paths) || [];
  }

  function previewUrl(videoPath, frame) {
    return `${Config.baseUrl()}/get_preview?video_path=${encodeURIComponent(videoPath)}&frame=${frame}`;
  }

  function clipUrl(videoPath, startFrame, endFrame) {
    return `${Config.baseUrl()}/get_clip?video_path=${encodeURIComponent(videoPath)}`
      + `&start_frame=${startFrame}&end_frame=${endFrame}`;
  }

  return {
    health, listIndexes, listModels, startIndex, indexStatus, cancelIndex,
    search, searchVisual, searchHybrid, exportClips, shutdown, describe,
    indexContents, clipFile, previewUrl, clipUrl,
  };
})();
