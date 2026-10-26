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

  function syncReference() {
    const recipe = Search.getRecipe();
    const source = recipe?.payload;
    const visible = Boolean(source?.image_base64 && source.source_frame != null);
    $('frame-query-reference').classList.toggle('hidden', !visible);
    if (!visible) { $('frame-query-image').removeAttribute('src'); return; }
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
    document.addEventListener('search-context', syncReference);
    document.addEventListener('search-completed', syncReference);
  }

  return { init, isBusy: () => pending, visual, cancel };
})();
