/* 固定预览当前画面用于视觉检索；历史文字主题仍由 Search 重放。 */
const FrameSearch = (() => {
  const $ = (id) => document.getElementById(id);
  let hooks;
  let pending = false;
  let generation = 0;

  function setBusy(value) {
    pending = value;
    document.dispatchEvent(new CustomEvent('frame-search-busy'));
  }

  function label(frame) {
    return `${frame.videoName} · ${(frame.frame / frame.fps).toFixed(2)} 秒 · 源帧 ${frame.frame}`;
  }

  function payload(frame) {
    return { image_base64: frame.dataUrl, source_video_path: frame.videoPath,
      source_frame: frame.frame, source_fps: frame.fps, source_name: frame.videoName };
  }

  function checkLibrary(library) {
    if (SearchRecipe.normalize(library) !== SearchRecipe.normalize(eagle.library.path)) {
      throw new Error('素材库已切换，请重新选择画面');
    }
  }

  function checkReady() {
    if (pending || Search.isBusy()) throw new Error('已有搜索正在进行，请稍候');
    if (!hooks.canSearch()) throw new Error('搜索服务未就绪或正在建索引');
  }

  async function capture() {
    const library = eagle.library.path;
    const frame = await Search.captureFrame();
    checkLibrary(library);
    return { ...frame, library };
  }

  /* 找接续画面的源帧区间（含两端）：end 取片段最后 seconds 秒；playhead 取播放头及之前 seconds 秒。 */
  function continuationRange(match, mode, seconds, playheadFrame) {
    const fps = Number(match?.fps) || 25;
    const clipStart = Number(match?.original_start_frame ?? match?.start_frame);
    const clipEnd = Number(match?.original_end_frame ?? match?.end_frame);
    const span = Math.max(1, Math.round(seconds * fps));
    let end;
    let floor;
    if (mode === 'playhead') {
      if (!Number.isInteger(playheadFrame) || playheadFrame < 0) throw new Error('无法读取播放头位置');
      end = playheadFrame;
      floor = 0;
    } else {
      if (!Number.isFinite(clipStart) || !Number.isFinite(clipEnd) || clipEnd < clipStart) throw new Error('片段帧范围无效');
      end = Math.round(clipEnd);
      floor = Math.round(clipStart);
    }
    return { start: Math.max(floor, end - span + 1), end, fps };
  }

  function rangeLabel(name, start, end, fps) {
    return `${name || '视频'} · ${(start / fps).toFixed(1)}–${(end / fps).toFixed(1)} 秒`;
  }

  function continuationSettings() {
    const cfg = Config.get();
    return { mode: cfg.continuationMode === 'playhead' ? 'playhead' : 'end',
      seconds: Number(cfg.continuationSeconds) || 1 };
  }

  function syncContinuationControls() {
    const { mode, seconds } = continuationSettings();
    $('continuation-mode-end').checked = mode === 'end';
    $('continuation-mode-playhead').checked = mode === 'playhead';
    $('continuation-seconds').value = String(seconds);
    $('btn-frame-continue').title = `取${mode === 'end' ? '片段结尾' : '播放头之前'} ${seconds} 秒的多帧画面，`
      + '找内容相近、可以接上的镜头（同视频的后续镜头也会保留）；按画面内容匹配，不区分运动方向';
  }

  function saveContinuationControls() {
    const seconds = Number($('continuation-seconds').value);
    if (!Number.isFinite(seconds) || seconds < 0.2 || seconds > 10) {
      hooks.toast('取帧时长应为 0.2～10 秒', true);
      syncContinuationControls();
      return;
    }
    const mode = $('continuation-mode-playhead').checked ? 'playhead' : 'end';
    try { Config.save({ continuationMode: mode, continuationSeconds: seconds }); } catch { /* Config 已提示错误 */ }
    syncContinuationControls();
  }

  /* 以一段画面（多帧均值）找接续：后端按 video_path+起止帧采样，并排除与该区间重叠的自身镜头。 */
  async function continuation() {
    let token;
    try {
      checkReady();
      token = ++generation;
      setBusy(true);
      const library = eagle.library.path;
      const match = Search.getActiveMatch();
      if (!match) throw new Error('请先打开一个片段预览');
      const { mode, seconds } = continuationSettings();
      const playhead = mode === 'playhead' ? Search.getPreviewSourceFrame() : null;
      const { start, end, fps } = continuationRange(match, mode, seconds, playhead);
      const context = await hooks.resolveScope();
      checkLibrary(library);
      if (token !== generation) return;
      // 与单帧找相似一致：候选镜头取最相似帧，不改写全局聚合设置。
      context.config = { ...context.config, visualAgg: 'max' };
      const payload = { video_path: match.video_path, start_frame: start, end_frame: end,
        source_name: match.video_name, source_fps: fps, continuation: mode };
      hooks.toast('正在以这段画面查找接续镜头…');
      report(await Search.runVisual(payload, context, `接续「${rangeLabel(match.video_name, start, end, fps)}」`));
    } catch (error) {
      if (token === undefined || token === generation) hooks.toast(error.message, true, 6500);
    } finally {
      if (token === generation) { setBusy(false); syncReference(); }
    }
  }

  function syncReference() {
    const recipe = Search.getRecipe();
    const source = recipe?.payload;
    const range = Boolean(source?.continuation && source.video_path && Number.isFinite(source.end_frame));
    const visible = range || Boolean(source?.image_base64 && source.source_frame != null);
    $('frame-query-reference').classList.toggle('hidden', !visible);
    if (!visible) { $('frame-query-image').removeAttribute('src'); return; }
    // ThumbLoader 加载期间会隐藏图片；切回固定截图时恢复显示。
    $('frame-query-image').style.visibility = '';
    if (range) {
      const fps = source.source_fps || 25;
      Search.loadThumbnail($('frame-query-image'), Api.previewUrl(source.video_path, source.end_frame));
      $('frame-query-label').textContent = `接续查询画面：${rangeLabel(source.source_name, source.start_frame, source.end_frame, fps)}`;
      return;
    }
    $('frame-query-image').src = source.image_base64;
    $('frame-query-label').textContent = `${recipe.kind === 'text' ? '文字查询来源' : '视觉查询画面'}：`
      + label({ videoName: source.source_name || '视频', frame: source.source_frame, fps: source.source_fps || 25 });
  }

  function report(result) {
    if (result.cancelled || result.stale) return false;
    if (!result.ok) { hooks.toast(result.message, true, 6000); return false; }
    hooks.toast(result.count ? `找到 ${result.count} 个匹配场景` : '没有匹配结果，可调整搜索条件');
    return true;
  }

  async function visual() {
    let token;
    try {
      checkReady();
      token = ++generation;
      setBusy(true);
      const frame = await capture();
      if (token !== generation) return;
      const context = await hooks.resolveScope();
      checkLibrary(frame.library);
      if (token !== generation) return;
      // 单帧找画面采用候选最相似帧；不改写其他搜索的全局聚合设置。
      context.config = { ...context.config, visualAgg: 'max' };
      hooks.toast('正在以当前帧搜索相似画面…');
      report(await Search.runVisual(payload(frame), context, `画面「${label(frame)}」`));
    } catch (error) {
      if (token === undefined || token === generation) hooks.toast(error.message, true, 6500);
    } finally {
      if (token === generation) { setBusy(false); syncReference(); }
    }
  }

  function cancel() {
    generation += 1;
    if (pending) Search.cancel();
    setBusy(false);
  }

  function init(options) {
    hooks = options;
    $('btn-frame-visual').addEventListener('click', visual);
    $('btn-frame-continue').addEventListener('click', continuation);
    ['continuation-mode-end', 'continuation-mode-playhead', 'continuation-seconds']
      .forEach((id) => $(id).addEventListener('change', saveContinuationControls));
    syncContinuationControls();
    document.addEventListener('search-context', syncReference);
    document.addEventListener('search-completed', syncReference);
  }

  return { init, isBusy: () => pending, visual, continuation, continuationRange, cancel };
})();
