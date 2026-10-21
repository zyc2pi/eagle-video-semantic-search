/* Auto-scenes-extraction 服务 /api/v1 客户端 */
const Api = (() => {
  // 默认 5 分钟超时：服务端卡死时 UI 不至于永远停在「搜索中…」；
  // 长任务（导出/mini-rerank 搜索）单独放宽到 10 分钟，传 0 表示不超时。
  const DEFAULT_TIMEOUT_MS = 300000;
  const LONG_TIMEOUT_MS = 600000;

  async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const callerSignal = options.signal;
    let timedOut = false;
    const abort = () => controller.abort();
    if (callerSignal?.aborted) abort();
    else callerSignal?.addEventListener('abort', abort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      let data;
      try { data = await resp.json(); }
      catch (error) {
        // JSON parsing may reject while the response body is still streaming.
        // Cancellation, timeout and transport failures must reach the caller.
        if (controller.signal.aborted || error.name !== 'SyntaxError') throw error;
        data = null;
      }
      if (controller.signal.aborted) throw new Error('Response body interrupted');
      return { ok: resp.ok, status: resp.status, data };
    } catch (e) {
      if (controller.signal.aborted) {
        const error = new Error(timedOut ? '请求超时（服务可能繁忙，可稍后重试）' : '已取消等待；服务端计算可能仍在继续');
        error.name = timedOut ? 'TimeoutError' : 'AbortError';
        throw error;
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
    }
  }

  function post(path, body, timeoutMs = DEFAULT_TIMEOUT_MS, requestOptions = {}) {
    return fetchJson(`${Config.baseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...requestOptions.headers },
      body: JSON.stringify(body),
      signal: requestOptions.signal,
    }, requestOptions.timeoutMs ?? timeoutMs);
  }

  async function health(timeoutMs = 1500) {
    try {
      const r = await fetchJson(`${Config.baseUrl()}/api/v1/health`, {}, timeoutMs);
      return r.ok && r.data && r.data.success === true;
    } catch {
      return false;
    }
  }

  async function healthInfo() {
    const r = await fetchJson(`${Config.baseUrl()}/api/v1/health`, {}, 5000);
    if (!r.ok) throw new Error('服务能力查询失败');
    return r.data;
  }

  async function resolveLibrary(path, name) {
    const r = await post('/api/v1/libraries/resolve', { path, name }, 10000);
    if (!r.ok || !r.data?.library) throw new Error(r.data?.error || '素材库身份解析失败');
    return r.data.library;
  }

  async function associateLibrary(id, path) {
    const r = await post('/api/v1/libraries/associate', { library_id: id, path, confirm: true }, 10000);
    if (!r.ok) throw new Error(r.data?.error || '素材库关联失败');
    return r.data;
  }

  async function listIndexJobs(libraryId) {
    const r = await fetchJson(`${Config.baseUrl()}/api/v1/index/jobs${libraryId ? `?library_id=${encodeURIComponent(libraryId)}` : ''}`, {}, 5000);
    if (!r.ok) throw new Error(r.data?.error || '任务列表读取失败');
    return r.data?.jobs || [];
  }

  async function listIndexes(libraryId) {
    const r = await fetchJson(`${Config.baseUrl()}/api/v1/indexes${libraryId ? `?library_id=${encodeURIComponent(libraryId)}` : ''}`);
    if (!r.ok) throw new Error(r.data?.error || '索引列表读取失败');
    return (r.data && r.data.indexes) || [];
  }

  async function listModels() {
    const r = await fetchJson(`${Config.baseUrl()}/api/v1/models`);
    return (r.data && r.data.models) || [];
  }

  function startIndex(videoPaths, indexName, modelName, rebuild = false, pruneMissing = false, metadata = {}) {
    const cfg = Config.get();
    return post('/api/v1/index', {
      library_id: metadata.library_id,
      library_path: metadata.library_path,
      source: metadata.source,
      idempotency_key: metadata.idempotency_key,
      video_paths: videoPaths,
      index_name: indexName,
      model_name: modelName,
      resume: !rebuild,
      prune_missing: !!pruneMissing,
      options: {
        sample_interval: cfg.indexSampleInterval,
        output_resolution: String(cfg.indexResolution),
        min_scene_length: cfg.indexMinSceneLen,
        batch_size: cfg.indexBatchSize,
        cosine_similarity_threshold: cfg.indexSceneThreshold,
        localmax_order: cfg.indexLocalmaxOrder,
        use_fp16: !!cfg.indexFp16,
      },
    }, 10000);
  }

  async function indexStatus(jobId) {
    const path = jobId ? `/api/v1/index/jobs/${encodeURIComponent(jobId)}` : '/api/v1/index/status';
    const r = await fetchJson(`${Config.baseUrl()}${path}`, {}, 5000);
    if (!r.ok) { const error = new Error(r.data?.error || '任务状态读取失败'); error.status = r.status; throw error; }
    return r.data;
  }

  function cancelIndex(jobId) {
    return post(jobId ? `/api/v1/index/jobs/${encodeURIComponent(jobId)}/cancel` : '/api/v1/index/cancel', {}, 5000);
  }

  async function retryIndex(jobId, idempotencyKey) {
    const r = await post(`/api/v1/index/jobs/${encodeURIComponent(jobId)}/retry`, { idempotency_key: idempotencyKey }, 10000);
    if (!r.ok || !r.data?.job_id) throw new Error(r.data?.error || '重试任务提交失败');
    return r.data;
  }

  /**
   * 视觉检索。payload 查询源三选一：
   *   { image_base64 } | { image_path } | { video_path, start_frame?, end_frame? }
   */
  function withSearchScope(body, allowedVideoPaths) {
    if (allowedVideoPaths == null) return body;
    return { ...body, allowed_video_paths: Array.from(allowedVideoPaths) };
  }

  function searchVisual(payload, indices, threshold, allowedVideoPaths = null, cfg = Config.get(), requestOptions = {}) {
    const isScene = payload.start_frame != null || payload.end_frame != null;
    return post('/api/v1/search_visual', withSearchScope({
      ...payload,
      indices,
      threshold,
      top_k: 100,
      exclude_self: true,
      relative_margin: cfg.visualMargin,
      scene_aggregation: cfg.visualAgg || 'mean',
      centered: !!cfg.visualCentered,
      query_frames: isScene ? cfg.visualSceneFrames : cfg.visualVideoFrames,
    }, allowedVideoPaths), DEFAULT_TIMEOUT_MS, requestOptions);
  }

  function isTemporalQuery(query) {
    const text = String(query || '');
    if (/不眨眼|没有眨眼|without blinking|not blinking/i.test(text)) return false;
    return /眨眼|眨动|blink(?:ing)?\b|运镜|推拉摇移|(?:相机|摄影机|摄像机|镜头).{0,6}(?:穿梭|穿行|推进|推拉|平移|移动|环绕|旋转)|(?:推|拉|摇|移|跟)镜头|camera\s+(?:movement|motion|pan|dolly|tracking|fly)/i.test(text);
  }

  function search(query, indices, threshold, allowedVideoPaths = null, cfg = Config.get(), requestOptions = {}) {
    return post('/api/v1/search', withSearchScope({
      query,
      indices,
      threshold,
      start_frame_offset: -2,
      end_frame_offset: 2,
      // 设置页的增强开关（ai_enhance/ai_mode 只在总开关打开时被后端采纳）
      ai_search_enabled: !!cfg.aiEnhance,
      bilingual_search: !!cfg.aiEnhance,
      ai_enhance: !!cfg.aiExpand,
      ai_mode: cfg.aiMode || 'balanced',
      use_dedup: !!cfg.dedup,
      dedup_threshold: cfg.dedupThreshold != null ? cfg.dedupThreshold : 0.95,
      use_mini_rerank: !!cfg.miniRerank,
      temporal_search: isTemporalQuery(query) ? 'auto' : 'off',
    }, allowedVideoPaths), cfg.miniRerank || isTemporalQuery(query) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS, requestOptions);
  }

  function shutdown() {
    return post('/api/v1/shutdown', {}, 5000, { headers: Service.controlHeaders() });
  }

  function describeFrame(payload, requestOptions = {}) {
    return post('/api/v1/describe', { ...payload, keep_model: false }, LONG_TIMEOUT_MS, requestOptions);
  }

  /* 混合检索：文本提示词 × 视觉片段 两路融合。textThreshold 不传时退回配置值 */
  function searchHybrid(query, payload, indices, textThreshold, allowedVideoPaths = null, cfg = Config.get(), requestOptions = {}) {
    return post('/api/v1/search_hybrid', withSearchScope({
      query,
      ...payload,
      indices,
      text_threshold: textThreshold != null ? textThreshold : cfg.threshold,
      visual_threshold: cfg.visualThreshold,
      relative_margin: cfg.visualMargin,
      scene_aggregation: cfg.visualAgg || 'mean',
      centered: !!cfg.visualCentered,
      query_frames: cfg.visualSceneFrames,
      top_k: 100,
      exclude_self: true,
      start_frame_offset: -2,
      end_frame_offset: 2,
    }, allowedVideoPaths), DEFAULT_TIMEOUT_MS, requestOptions);
  }

  /* 语义查重：场景向量 → 视频级相似分组（纯 CPU，不加载模型） */
  function dedupScan(indices, threshold) {
    return post('/api/v1/dedup_scan', { indices, threshold });
  }

  /* 查询索引覆盖状态：可搜索路径 + 已检查但无有效场景的跳过路径。 */
  async function indexCoverage(lancePath) {
    const r = await fetchJson(
      `${Config.baseUrl()}/api/v1/index/contents?path=${encodeURIComponent(lancePath)}`);
    if (!r.ok || r.data?.success !== true) throw new Error(r.data?.error || '索引覆盖状态读取失败');
    const data = r.data;
    if (!Array.isArray(data.video_paths) || ['skipped_paths', 'failed_paths', 'processed_paths']
      .some((key) => data[key] !== undefined && !Array.isArray(data[key]))) {
      throw new Error('索引覆盖状态格式无效');
    }
    const indexedPaths = data.video_paths || [];
    const skippedPaths = data.skipped_paths || [];
    const failedPaths = data.failed_paths || [];
    return {
      indexedPaths,
      skippedPaths,
      failedPaths,
      // 兼容尚未升级的后端：旧响应没有 processed_paths 时退回已索引路径。
      processedPaths: data.processed_paths || indexedPaths.concat(skippedPaths, failedPaths),
    };
  }

  async function indexContents(lancePath) {
    return (await indexCoverage(lancePath)).indexedPaths;
  }

  function previewUrl(videoPath, frame) {
    return `${Config.baseUrl()}/get_preview?video_path=${encodeURIComponent(videoPath)}&frame=${frame}`;
  }

  function clipUrl(videoPath, startFrame, endFrame) {
    return `${Config.baseUrl()}/get_clip?video_path=${encodeURIComponent(videoPath)}`
      + `&start_frame=${startFrame}&end_frame=${endFrame}`;
  }

  return {
    health, healthInfo, resolveLibrary, associateLibrary, listIndexJobs, listIndexes, listModels, startIndex, indexStatus, cancelIndex, retryIndex,
    search, searchVisual, searchHybrid, describeFrame, shutdown, isTemporalQuery,
    dedupScan, indexCoverage, indexContents, previewUrl, clipUrl,
  };
})();
