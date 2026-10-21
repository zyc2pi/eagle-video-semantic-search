/* 主题快速审片：队列固定可见片段身份，写入成功后才前进。 */
const TopicReview = (() => {
  const $ = (id) => document.getElementById(id);
  let hooks;
  let session = null;
  let applying = false;

  function status(message = '', error = false) {
    $('topic-review-status').textContent = message;
    $('topic-review-status').dataset.error = String(error);
  }
  function context() {
    const current = hooks.getContext();
    if (!session || !current || current.library !== session.library || current.entry.id !== session.id
        || eagle.library.path !== session.library) throw new Error('主题或素材库已切换，请重新开始审片');
    hooks.checkIdle();
    return current;
  }
  function stop(restorePosition = true) {
    const previous = session;
    session = null;
    document.body.classList.remove('quick-review');
    $('topic-review-panel').classList.add('hidden');
    $('topic-review').setAttribute('aria-pressed', 'false');
    if (restorePosition && previous?.library === eagle.library.path) {
      Search.restoreBrowsePosition(previous.position);
    }
  }
  function sync() {
    if (!session) return;
    const active = Search.getActiveMatch();
    const key = active && ArchiveStore.sceneKey(active);
    const index = session.keys.indexOf(key);
    if (index < 0) { stop(); return; }
    session.index = index;
    const fps = Number(active.fps) > 0 ? Number(active.fps) : 25;
    const start = Number(active.original_start_frame ?? active.start_frame) / fps;
    const end = Number(active.original_end_frame ?? active.end_frame) / fps;
    $('topic-review-scene').textContent = `${active.video_name || active.video_path} · ${start.toFixed(2)}–${end.toFixed(2)} 秒`;
    $('topic-review-scene').title = active.video_path;
    const visible = new Map(Search.getAllMatches().map((match) => [ArchiveStore.sceneKey(match), match]));
    const pending = session.keys.filter((value) => visible.has(value) && !visible.get(value).reviewedAt).length;
    $('topic-review-progress').textContent = `已处理 ${session.keys.length - pending} / ${session.keys.length}`;
    $('topic-review-state').textContent = `${index + 1} / ${session.keys.length} · ${active.reviewedAt ? '已审阅' : '未审阅'} · 原分 ${active.similarity ?? '未知'}`;
    $('topic-review-score').value = active.manualScore ? String(active.manualScore.value) : '';
    $('topic-review-reset').disabled = !active.reviewedAt;
    $('topic-review-prev').disabled = !session.keys.slice(0, index).some((value) => visible.has(value));
  }
  function show(key) {
    if (!Search.openPreviewByKey(key)) throw new Error('片段已不在当前结果中，请重新开始审片');
    sync();
  }
  function next() {
    context();
    const visible = new Map(Search.getAllMatches().map((match) => [ArchiveStore.sceneKey(match), match]));
    for (let offset = 1; offset <= session.keys.length; offset += 1) {
      const index = (session.index + offset) % session.keys.length;
      const key = session.keys[index];
      if (visible.has(key) && !visible.get(key).reviewedAt) {
        show(key);
        status(offset === session.keys.length ? '其余片段已处理；当前片段仍未审阅。' : '');
        return;
      }
    }
    stop();
    hooks.toast('当前筛选下的片段已全部审阅，进度已保存');
  }
  function previous() {
    context();
    const visible = new Set(Search.getAllMatches().map(ArchiveStore.sceneKey));
    for (let index = session.index - 1; index >= 0; index -= 1) {
      if (visible.has(session.keys[index])) { show(session.keys[index]); status(); return; }
    }
  }
  function start() {
    hooks.checkIdle();
    const current = hooks.getContext();
    if (!current || current.library !== eagle.library.path) throw new Error('请先打开当前素材库的主题');
    const matches = Search.getAllMatches();
    if (!matches.length) throw new Error('当前筛选下没有可审阅的片段');
    session = { library: current.library, id: current.entry.id,
      keys: matches.map(ArchiveStore.sceneKey), index: 0, position: Search.captureBrowsePosition() };
    document.body.classList.add('quick-review');
    $('topic-review-panel').classList.remove('hidden');
    $('topic-review').setAttribute('aria-pressed', 'true');
    show(ArchiveStore.sceneKey(matches.find((match) => !match.reviewedAt) || matches[0]));
    status('保留只标记已审阅；跳过不写入状态。');
  }
  function act(action) {
    const current = context();
    const match = Search.getActiveMatch();
    if (!match || ArchiveStore.sceneKey(match) !== session.keys[session.index]) throw new Error('预览已改变，请重新选择片段');
    let score;
    if (action === 'score') {
      const text = $('topic-review-score').value;
      score = text === '' ? NaN : Number(text);
      if (!SceneScores.valid(score)) throw new Error('请填写非负的有效分数');
    }
    const position = session.index;
    applying = true;
    try {
      hooks.commit(action, match, score, current);
      session.index = position;
      if (action === 'reset') { show(ArchiveStore.sceneKey(match)); status('已设为未审阅'); }
      else next();
    } finally { applying = false; }
  }
  function attempt(action) {
    try { action(); }
    catch (error) {
      if (session && session.library !== eagle.library.path) stop(false);
      status(error.message, true);
      hooks.toast(error.message, true);
    }
  }
  function init(callbacks) {
    hooks = callbacks;
    $('topic-review').addEventListener('click', () => attempt(() => session ? stop() : start()));
    $('topic-review-exit').addEventListener('click', () => stop());
    $('topic-review-prev').addEventListener('click', () => attempt(previous));
    $('topic-review-next').addEventListener('click', () => attempt(next));
    for (const action of ['keep', 'remove', 'reset']) {
      $(`topic-review-${action}`).addEventListener('click', () => attempt(() => act(action)));
    }
    $('topic-review-score-form').addEventListener('submit', (event) => {
      event.preventDefault(); attempt(() => act('score'));
    });
    document.addEventListener('search-context', () => { if (!applying) stop(false); });
    document.addEventListener('preview-change', () => {
      if (!session || applying) return;
      if (!Search.getActiveMatch()) stop();
      else sync();
    });
    document.addEventListener('keydown', (event) => {
      if (!session || applying || event.isComposing || event.altKey || event.metaKey
          || document.querySelector('dialog[open]')) return;
      if (session.library !== eagle.library.path) { stop(false); return; }
      const target = event.target;
      if (target?.id === 'topic-review-score' && event.key === 'Enter' && event.repeat) {
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (target?.id === 'topic-review-score' && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        const value = target.value === '' ? null : Number(target.value);
        target.value = SceneScores.adjust(value, event.key === 'ArrowUp' ? 1 : -1, event.ctrlKey).toFixed(1);
        return;
      }
      if (event.ctrlKey) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); stop(); return;
      }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable) return;
      const actions = {
        k: () => act('keep'), x: () => act('remove'), n: next,
        arrowright: next, arrowleft: previous,
        s: () => { $('topic-review-score').focus(); $('topic-review-score').select(); },
      };
      const action = actions[event.key.toLowerCase()];
      if (!action) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) attempt(action);
    }, true);
  }
  return { init, stop, getBrowsePosition: () => session?.position || null };
})();
