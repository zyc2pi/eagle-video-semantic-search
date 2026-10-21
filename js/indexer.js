/* 每次只监视自己的 job_id；轮询串行，掉线保留身份并退避重连。 */
const Indexer = (() => {
  let timer = null;
  let running = false;
  let submitting = false;
  let generation = 0;
  let jobId = null;
  let failures = 0;
  let listeners = {};
  let uncertainSubmission = null;
  let legacyIndexDetected = null;

  function isRunning() { return running || submitting; }
  function stopPolling() {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null; running = false;
  }

  async function detectLegacyIndex(libraryPath, currentIndexName) {
    if (legacyIndexDetected !== null) return legacyIndexDetected;
    try {
      // 从库路径提取库名称，移除 .library 后缀
      let legacyName = libraryPath.split(/[\\/]/).filter(Boolean).pop();
      if (legacyName.endsWith('.library')) {
        legacyName = legacyName.slice(0, -8); // 移除 .library 后缀
      }
      console.log(`[Legacy Index] 检测旧索引：当前库路径=${libraryPath}, 推断旧名称=${legacyName}, 当前索引名=${currentIndexName}`);

      if (legacyName === currentIndexName) {
        console.log('[Legacy Index] 旧名称与当前索引名相同，无需迁移');
        legacyIndexDetected = null;
        return null;
      }

      // 查询全部索引（不限制 library_id，因为旧索引可能没有关联 library_id）
      const allIndexes = await Api.listIndexes();
      console.log(`[Legacy Index] 查询到 ${allIndexes.length} 个索引，原始数据:`, allIndexes);

      // 匹配旧索引：名称包含库名（如 eagle_mad相关_模型名.lance）且不是当前索引
      const legacyPattern = new RegExp(`^eagle_${legacyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_`);
      const legacy = allIndexes.find((idx) => {
        const matches = legacyPattern.test(idx.name) && idx.name !== currentIndexName;
        console.log(`[Legacy Index] 检查索引 ${idx.name}: 匹配=${matches}, 记录数=${idx.doc_count || idx.document_count || idx.num_documents || 0}`);
        return matches;
      });

      if (legacy) {
        const count = legacy.doc_count || legacy.document_count || legacy.num_documents || 0;
        // 从旧索引名称中提取模型名称（如 eagle_mad相关_qihoo360-fg-clip2-base.lance -> qihoo360-fg-clip2-base）
        const modelMatch = legacy.name.match(/_([^_]+)\.lance$/);
        const model = modelMatch ? modelMatch[1] : legacy.model || 'qihoo360-fg-clip2-base';
        legacyIndexDetected = { name: legacy.name, count, currentName: currentIndexName, libraryName: legacyName, model };
        console.log(`[Legacy Index] 检测到旧索引: ${legacy.name} (${count} 条记录), 模型: ${model}`);
        return legacyIndexDetected;
      }

      console.log('[Legacy Index] 未检测到旧索引');
      legacyIndexDetected = null;
      return null;
    } catch (error) {
      console.error('[Legacy Index] 检测旧索引失败:', error);
      legacyIndexDetected = null;
      return null;
    }
  }

  function watch(id, handlers) {
    stopPolling(); jobId = id; running = true; listeners = handlers; failures = 0;
    const token = generation;
    const poll = async () => {
      let status;
      try {
        status = await Api.indexStatus(id);
        if (!status?.state) throw new Error('状态无效');
      } catch (error) {
        if (token !== generation) return;
        if (error.status === 404) {
          stopPolling(); listeners.onTerminal?.({ state: 'unknown', job_id: id });
          listeners.onError?.('任务记录已不存在，请检查任务历史后重新提交增量索引'); return;
        }
        failures += 1;
        listeners.onConnection?.(false, failures >= 3 ? '连接中断，索引状态未知；正在重连，请勿重复提交' : '正在重新连接索引任务…');
        timer = setTimeout(poll, Math.min(30000, 2000 * (2 ** Math.min(failures - 1, 4))));
        return;
      }
      if (token !== generation) return;
      if (failures) listeners.onConnection?.(true, '索引任务已重新连接');
      failures = 0;
      if (['running', 'queued', 'cancelling'].includes(status.state)) {
        listeners.onProgress?.(status);
        timer = setTimeout(poll, 2000);
      } else {
        stopPolling();
        listeners.onTerminal?.(status);
        if (['done', 'cancelled'].includes(status.state)) listeners.onDone?.(status);
        else listeners.onError?.(status.error || '任务已中断或状态丢失；已写入结果保留，可重新增量索引');
      }
    };
    timer = setTimeout(poll, 0);
  }

  async function cancel() {
    if (!jobId) return { ok: false, message: '尚未取得任务身份，不能取消其他插件的任务' };
    try {
      const resp = await Api.cancelIndex(jobId);
      return resp.ok ? { ok: true } : { ok: false, message: resp.data?.error || '停止请求失败，仍在监视任务' };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  async function recover(handlers = {}) {
    if (isRunning()) return null;
    const library = await Bridge.resolveLibraryIdentity();
    const jobs = await Api.listIndexJobs(library.id);
    if (isRunning()) return null;
    const job = jobs.find((value) => value.source === 'semantic-search' && ['queued', 'running', 'cancelling'].includes(value.state));
    if (job) watch(job.job_id, handlers);
    return job;
  }

  async function retry(id, idempotencyKey, handlers = {}) {
    if (isRunning()) throw new Error('已有索引任务正在提交或监视，请等待后重试');
    submitting = true;
    try {
      const response = await Api.retryIndex(id, idempotencyKey);
      if (!response?.job_id) throw new Error('服务未返回重试任务身份，请按原请求重试确认');
      watch(response.job_id, handlers);
      return response;
    } finally { submitting = false; }
  }

  async function start(mode, handlers = {}) {
    if (submitting) return { started: false, message: '任务正在提交，请稍候' };
    if (running) return { started: false, message: '已有索引任务正在监视，断线时也请勿重复提交' };
    submitting = true;
    try {
      const library = await Bridge.resolveLibraryIdentity();
      let submission = uncertainSubmission;
      if (submission && submission.metadata.library_id !== library.id) throw new Error('另一个库的提交结果尚未确认，请切回原库重试确认');
      if (!submission) {
        const jobs = await Api.listIndexJobs(library.id);
        const active = jobs.find((job) => job.source === 'semantic-search' && ['queued', 'running', 'cancelling'].includes(job.state));
        if (active) { watch(active.job_id, handlers); return { started: true, count: active.total || 0, recovered: true }; }
        let videos;
        if (mode === 'all' || mode === 'rebuild') videos = await Bridge.collectLibraryVideos(true);
        else if (mode === 'folder') videos = await Bridge.collectFolderVideos();
        else videos = await Bridge.collectSelectedVideos();
        if (videos === null) return { started: false, message: '请先在 Eagle 中选择文件夹或素材' };
        const pruneMissing = mode === 'all' || mode === 'rebuild';
        if (!videos || (!videos.length && !pruneMissing)) return { started: false, message: '没有找到视频素材' };
        const currentLibrary = await Bridge.resolveLibraryIdentity();
        if (currentLibrary.id !== library.id || currentLibrary.path !== library.path) throw new Error('素材库已切换，请重新操作');
        submission = {
          paths: videos.map((item) => item.filePath), name: library.index_name,
          model: Config.get().modelName, rebuild: mode === 'rebuild', pruneMissing,
          metadata: { library_id: library.id, library_path: library.path, source: 'semantic-search', idempotency_key: require('crypto').randomUUID() },
        };
      }
      uncertainSubmission = submission;
      const response = await Api.startIndex(submission.paths, submission.name, submission.model, submission.rebuild, submission.pruneMissing, submission.metadata);
      if (!response.ok) {
        uncertainSubmission = null;
        throw new Error(response.data?.error || ('启动索引失败（HTTP ' + response.status + '）'));
      }
      if (!response.data?.job_id) throw new Error('服务未返回任务身份；请确认服务已升级');
      uncertainSubmission = null;
      watch(response.data.job_id, handlers);
      return { started: true, count: submission.paths.length };
    } catch (error) {
      return { started: false, message: error.message + (uncertainSubmission ? '；提交结果未知，再次点击将按原请求确认，不会重复建任务' : '') };
    } finally { submitting = false; }
  }

  function getLegacyIndexInfo() {
    return legacyIndexDetected;
  }

  function clearLegacyIndexCache() {
    legacyIndexDetected = null;
  }

  return { start, retry, cancel, recover, isRunning, detectLegacyIndex, getLegacyIndexInfo, clearLegacyIndexCache };
})();
