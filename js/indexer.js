/* 建索引流程：收集视频 → POST /api/v1/index → 轮询进度 */
const Indexer = (() => {
  let polling = null;
  let running = false;
  let listeners = { onProgress: null, onDone: null, onError: null };

  function isRunning() {
    return running;
  }

  function stopPolling() {
    if (polling) {
      clearInterval(polling);
      polling = null;
    }
    running = false;
  }

  function startPolling() {
    polling = setInterval(async () => {
      let status;
      try {
        status = await Api.indexStatus();
      } catch {
        return; // 网络抖动，下轮再试
      }
      if (!status) return;
      if (status.state === 'running') {
        listeners.onProgress?.(status);
      } else if (status.state === 'done' || status.state === 'cancelled') {
        stopPolling();
        listeners.onDone?.(status);
      } else if (status.state === 'error') {
        stopPolling();
        listeners.onError?.(status.error || '索引任务失败');
      } else {
        // 'idle'：服务在索引期间被重启（状态被重置）。不收尾会让 running 恒为
        // true、搜索/索引按钮永久禁用，只能重载插件。
        stopPolling();
        listeners.onError?.('索引任务状态丢失（服务可能被重启），可重新提交增量索引');
      }
    }, 2000);
  }

  /* 请求停止：服务端在当前视频处理完后停止，已完成部分保留（下次可增量续跑） */
  async function cancel() {
    const resp = await Api.cancelIndex();
    if (!resp.ok) {
      return { ok: false, message: (resp.data && resp.data.error) || '停止请求失败' };
    }
    return { ok: true };
  }

  /**
   * mode: 'all' | 'folder' | 'selected' | 'rebuild'（rebuild=全库重建，清理已删素材的失效条目）
   * handlers: { onProgress(status), onDone(status), onError(message) }
   * 返回 { started, count, message }
   * 服务端支持任务队列：索引进行中再次提交会排队串行执行。
   */
  async function start(mode, handlers) {
    stopPolling(); // 防御性：避免残留的旧轮询与本次并存
    listeners = handlers;

    let videos;
    if (mode === 'all' || mode === 'rebuild') {
      videos = await Bridge.collectLibraryVideos();
    } else if (mode === 'folder') {
      videos = await Bridge.collectFolderVideos();
      if (videos === null) return { started: false, message: '请先在 Eagle 中选中一个文件夹' };
    } else {
      videos = await Bridge.collectSelectedVideos();
      if (videos === null) return { started: false, message: '请先在 Eagle 中选中素材' };
    }
    if (!videos || videos.length === 0) {
      return { started: false, message: '没有找到视频素材（支持 mp4/mov/mkv/avi/webm/flv）' };
    }

    const cfg = Config.get();
    const resp = await Api.startIndex(
      videos.map((it) => it.filePath),
      Bridge.indexNameForLibrary(),
      cfg.modelName,
      mode === 'rebuild'
    );
    if (!resp.ok) {
      const msg = (resp.data && resp.data.error) || `启动索引失败（HTTP ${resp.status}）`;
      return { started: false, message: msg };
    }

    running = true;
    startPolling();
    return { started: true, count: videos.length };
  }

  return { start, cancel, isRunning };
})();
