/* 固定预览当前画面，分别用于视觉检索和本地画面转文字检索。 */
const FrameSearch = (() => {
  const $ = (id) => document.getElementById(id);
  let hooks;
  let pending = false;
  let generation = 0;
  let controller = null;
  let textSource = null;
  let searchingText = false;

  function setBusy(value) {
    pending = value;
    $('frame-text-query').disabled = value;
    $('frame-text-retry').disabled = value || !textSource;
    $('frame-text-submit').disabled = value || !$('frame-text-query').value.trim();
    $('frame-text-dialog').setAttribute('aria-busy', String(value));
    if (value && $('frame-text-dialog').open) $('frame-text-cancel').focus();
    document.dispatchEvent(new CustomEvent('frame-search-busy'));
  }

  function status(message, error = false) {
    $('frame-text-status').textContent = message;
    $('frame-text-status').dataset.error = String(error);
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
    if (pending || Search.isBusy()) throw new Error('已有搜索或画面生成正在进行，请稍候');
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

  async function generateText() {
    if (!textSource || pending) return;
    const token = ++generation;
    controller = new AbortController();
    setBusy(true);
    status('正在用本地模型生成检索文字，首次加载可能较慢…');
    try {
      checkLibrary(textSource.library);
      if (!hooks.canSearch() || Search.isBusy()) throw new Error('搜索服务未就绪或正在忙碌，请稍后重新生成');
      const response = await Api.describeFrame(payload(textSource), { signal: controller.signal });
      if (token !== generation) return;
      checkLibrary(textSource.library);
      if (!response.ok || !response.data?.success) throw new Error(response.data?.error || '画面转文字失败');
      const prompts = (Array.isArray(response.data.prompts) ? response.data.prompts : [])
        .filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
      if (!prompts.length) throw new Error('没有生成可用文字，可重试或自行输入搜索词');
      $('frame-text-prompts').replaceChildren();
      for (const prompt of prompts) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = prompt;
        button.addEventListener('click', () => {
          if (pending) return;
          $('frame-text-query').value = prompt;
          $('frame-text-submit').disabled = false;
        });
        $('frame-text-prompts').appendChild(button);
      }
      $('frame-text-query').value = prompts[0];
      status('选择或修改一条描述，然后点击“文字搜索”。');
    } catch (error) {
      if (token === generation && error.name !== 'AbortError') status(error.message, true);
    } finally {
      if (token === generation) { controller = null; setBusy(false); }
    }
  }

  async function text() {
    let token;
    try {
      checkReady();
      token = ++generation;
      setBusy(true);
      const frame = await capture();
      if (token !== generation) return;
      textSource = frame;
      $('frame-text-image').src = frame.dataUrl;
      $('frame-text-source').textContent = label(frame);
      $('frame-text-query').value = '';
      $('frame-text-prompts').replaceChildren();
      setBusy(false);
      $('frame-text-dialog').showModal();
      await generateText();
    } catch (error) {
      if (token === undefined || token === generation) hooks.toast(error.message, true, 6500);
    } finally {
      if (token === generation) setBusy(false);
    }
  }

  async function submitText(event) {
    event.preventDefault();
    let token;
    try {
      checkReady();
      const query = $('frame-text-query').value.trim();
      if (!query || !textSource) return;
      checkLibrary(textSource.library);
      token = ++generation;
      searchingText = true;
      setBusy(true);
      status('正在按文字搜索…');
      const context = await hooks.resolveScope();
      checkLibrary(textSource.library);
      if (token !== generation) return;
      const threshold = Number($('threshold').value);
      const result = await Search.runFrameText(query, payload(textSource), context, threshold);
      if (token !== generation) return;
      if (report(result)) {
        hooks.onTextSuccess(query);
        searchingText = false;
        $('frame-text-dialog').close();
      } else if (!result.cancelled && !result.stale) status(result.message, true);
    } catch (error) {
      if (token === undefined || token === generation) status(error.message, true);
    } finally {
      if (token === generation) { searchingText = false; setBusy(false); syncReference(); }
    }
  }

  function cancel() {
    generation += 1;
    controller?.abort(); controller = null;
    if (searchingText) Search.cancel();
    searchingText = false;
    textSource = null;
    setBusy(false);
  }

  function init(options) {
    hooks = options;
    $('btn-frame-visual').addEventListener('click', visual);
    $('btn-frame-text').addEventListener('click', text);
    $('frame-text-form').addEventListener('submit', submitText);
    $('frame-text-retry').addEventListener('click', generateText);
    $('frame-text-query').addEventListener('input', () => {
      $('frame-text-submit').disabled = pending || !$('frame-text-query').value.trim();
    });
    $('frame-text-cancel').addEventListener('click', () => { cancel(); $('frame-text-dialog').close(); });
    $('frame-text-dialog').addEventListener('cancel', cancel);
    $('frame-text-dialog').addEventListener('close', () => {
      // 原生 close 事件异步派发；重新打开后不能被旧事件取消。
      if (!$('frame-text-dialog').open) cancel();
    });
    document.addEventListener('search-context', syncReference);
    document.addEventListener('search-completed', syncReference);
  }

  return { init, isBusy: () => pending, visual, text, cancel };
})();
