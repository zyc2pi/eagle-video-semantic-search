/* 搜索 + 结果渲染（分批/分组/排序/过滤）+ 悬停自动播放 + 预览键盘导航 + 勾选导出 */
const Search = (() => {
  const CHUNK_SIZE = 60;        // 每批渲染的卡片数，滚动到底部续加（分组模式按组为粒度）
  const THUMB_CONCURRENCY = 6;  // 缩略图并发上限（每张图都是服务端一次 ffmpeg 抽帧进程）
  const PREVIEW_LEAD_IN_FRAMES = 2; // 跳过切点前两帧，避免转场/解码黑帧闪现

  let lastMatches = [];
  let lastQuery = '';           // 最近一次查询，供保存主题使用
  let lastRecipe = null;
  let newKeys = new Set();
  let archiveTime = { mode: 'all' };
  let archiveFilter = { query: '', source: 'all' };
  const filterDefaults = { query: '', source: 'all', tags: '', orientation: 'all', maxDur: null };
  let topicMembership = null;
  let topicMembershipStatus = '主题归属…';
  const cardMatches = new WeakMap();
  const matchThumbnails = new WeakMap();
  let renderGeneration = 0;
  let busy = false;
  let requestGeneration = 0;
  let activeRequest = null;
  let phase = '';
  function setPhase(value) {
    phase = value;
    if (el.searchPhase) el.searchPhase.textContent = value;
  }
  function cancel() {
    if (!activeRequest) return;
    activeRequest.abort();
    activeRequest = null;
    requestGeneration += 1;
    setPhase('已取消等待；服务端计算可能仍在继续');
    setBusy(false);
  }
  function setBusy(value) {
    busy = value;
    if (el.cancelSearch) el.cancelSearch.hidden = !activeRequest;
    document.dispatchEvent(new CustomEvent('search-busy'));
  }
  let selectedIdx = new Set();  // 勾选的结果下标（相对 lastMatches，视图变化不丢失）
  let selectionHandler = null;  // 勾选数量变化回调，由 plugin.js 注入
  let contextMenuHandler = null; // 仓库主题可提供片段操作菜单；普通搜索仍以右键切换勾选。

  // 视图状态（过滤→排序→分组，均不修改 lastMatches 本体）
  const view = { sortBy: 'sim', minDur: 0, grouped: false };
  let displayList = [];         // 视图变换后的原始下标序列
  let groups = [];              // 分组模式：[{name, idxs:[原始下标...]}]
  let flatPtr = 0;              // 平铺模式已渲染到 displayList 的位置
  let groupPtr = 0;             // 分组模式已渲染的组数
  let activePos = -1;           // 当前预览项在 displayList 中的位置（键盘导航用）
  let activeMatch = null;
  let previewLoadToken = 0;     // 连续切换结果时废弃上一轮异步媒体事件
  let sentinelObserver = null;
  let cancelPreviewLoad = () => {};
  let previewDiag = null;      // 临时诊断：当前预览的播放采样记录器

  const el = {};

  /* ---------- 缩略图限流加载 ---------- */
  const ThumbLoader = (() => {
    const queue = [];
    let active = 0;
    let generation = 0;

    function pump() {
      while (active < THUMB_CONCURRENCY && queue.length) {
        // 入队发生在卡片插入 DOM 之前，不能用 isConnected 过滤；
        // 换一轮结果时 clear() 已清空队列，不会有陈旧请求。
        const { img, url, onError, token } = queue.shift();
        active += 1;
        let settled = false;
        const done = (event) => {
          if (settled) return;
          settled = true;
          active -= 1;
          img.onload = null;
          img.onerror = null;
          try { if (event?.type === 'error' && token === generation) onError?.(); } finally { pump(); }
        };
        img.onload = done;
        img.onerror = done;
        img.src = url;
      }
    }

    return {
      load(img, url, onError) {
        const token = generation;
        const enqueue = () => {
          if (token !== generation) return;
          queue.push({ img, url, onError, token });
          pump();
        };
        // 观察器只决定何时入队；所有实际图片请求共用六个槽位。
        if (typeof LazyLoad !== 'undefined') {
          LazyLoad.observe(img, enqueue);
        } else {
          enqueue();
        }
      },
      clear() {
        generation += 1;
        queue.length = 0;
        // 已开始请求仍占并发槽位直到完成；只废弃尚未开始和旧失败回退。
        if (typeof LazyLoad !== 'undefined') {
          LazyLoad.clear();
        }
      },
    };
  })();

  /* ---------- 悬停自动播放（小窗静音循环该片段） ---------- */
  const hover = { video: null, box: null, diag: null };

  function clearPreviewMediaEvents(video) {
    for (const name of ['loadedmetadata', 'seeked', 'timeupdate', 'playing', 'waiting', 'pause', 'ended', 'error', 'canplay', 'loadeddata', 'progress']) {
      video[`on${name}`] = null;
    }
  }

  function stopHoverPreview() {
    if (hover.diag) {
      hover.diag.mark('hover-stop');
      hover.diag.flush();
      hover.diag = null;
    }
    if (hover.video) {
      clearPreviewMediaEvents(hover.video);
      hover.video.pause();
      hover.video.removeAttribute('src');
      hover.video.load();
      hover.video.remove();
      hover.video = null;
    }
    if (hover.box) {
      hover.box.classList.remove('hovering');
      hover.box = null;
    }
  }

  function startHoverPreview(box, m) {
    // 当前大预览已持有此片段，不再为同一张卡片创建第二个解码器。
    if (activeMatch === m) return;
    const item = Bridge.itemForPath(m.video_path);
    // 悬停仅尝试常用浏览器格式；其他格式点击后也只播放原文件，不转码。
    if (!item || !item.fileURL || !Bridge.isWebPlayable(item)) return;

    const fps = m.fps || 25;
    const startSec = previewStartFrame(m) / fps;
    const endSec = Math.max(m.end_frame / fps, startSec + 0.2);

    const v = document.createElement('video');
    v.className = 'hover-video';
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    let revealRequested = false;
    let located = false;
    let starting = false;

    const revealAfterPaint = () => {
      if (revealRequested || hover.video !== v) return;
      revealRequested = true;
      const reveal = () => {
        if (hover.video === v) v.classList.add('ready');
      };
      // loadeddata 只表示帧已解码；等待浏览器真正绘制后再盖住缩略图，消除黑闪。
      if (typeof v.requestVideoFrameCallback === 'function') {
        v.requestVideoFrameCallback(reveal);
      } else {
        requestAnimationFrame(reveal);
      }
    };

    const playFromScene = () => {
      if (hover.video !== v || starting || !located) return;
      starting = true;
      diag.mark('play');
      v.play().then(() => { diag.mark('play-ok'); revealAfterPaint(); }).catch((error) => {
        diag.mark('play-error', error.name);
        if (hover.video === v && error.name !== 'AbortError') stopHoverPreview();
      });
    };
    v.onloadedmetadata = () => {
      located = true;
      if (Math.abs(v.currentTime - startSec) >= 0.04) v.currentTime = startSec;
      playFromScene();
    };
    v.onseeked = () => { located = true; playFromScene(); };
    v.oncanplay = playFromScene;
    v.onprogress = playFromScene;
    v.onplaying = () => diag.mark('playing');
    v.onerror = () => {
      if (v.error) diag.mark('error', `${v.error.code}:${String(v.error.message || '').slice(0, 40)}`);
      if (hover.video === v) stopHoverPreview();
    };
    v.ontimeupdate = () => {
      if (v.currentTime >= endSec) v.currentTime = startSec; // 片段内循环
    };
    const diag = PreviewDiag.begin({
      mode: 'hover',
      video: v,
      clip: m.video_name,
      file: item.fileURL,
      scene: [m.start_frame, m.end_frame],
      srcKind: 'file',
    });
    diag.setPath('hover', 'file');
    box.appendChild(v);
    box.classList.add('hovering');
    hover.video = v;
    hover.box = box;
    hover.diag = diag;
    v.src = item.fileURL;
  }

  function bindHover(box, m) {
    box.addEventListener('mouseenter', () => {
      stopHoverPreview();
      startHoverPreview(box, m);
    });
    box.addEventListener('mouseleave', stopHoverPreview);
  }

  /* ---------- DOM 绑定 ---------- */
  function bindDom() {
    el.results = document.getElementById('results');
    el.emptyState = document.getElementById('empty-state');
    el.previewPanel = document.getElementById('preview-panel');
    el.previewVideo = document.getElementById('preview-video');
    el.previewInfo = document.getElementById('preview-info');
    el.btnLocate = document.getElementById('btn-locate');
    el.btnClosePreview = document.getElementById('btn-close-preview');
    el.viewBar = document.getElementById('view-bar');
    el.resultCount = document.getElementById('result-count');
    el.timeline = document.getElementById('preview-timeline');
    el.previewTags = document.getElementById('preview-tags');
    el.localFilters = document.getElementById('topic-scene-filter');
    const searchButton = document.getElementById('btn-search');
    el.cancelSearch = document.createElement('button');
    el.cancelSearch.id = 'btn-cancel-search';
    el.cancelSearch.type = 'button';
    el.cancelSearch.textContent = '取消等待';
    el.cancelSearch.hidden = true;
    el.cancelSearch.addEventListener('click', cancel);
    el.searchPhase = document.createElement('span');
    el.searchPhase.id = 'search-phase';
    el.searchPhase.setAttribute('role', 'status');
    searchButton.parentNode.appendChild(el.cancelSearch);
    searchButton.parentNode.appendChild(el.searchPhase);
    el.previewStatus = document.createElement('div');
    el.previewStatus.id = 'preview-status';
    el.previewStatus.setAttribute('role', 'status');
    el.previewRetry = document.createElement('button');
    el.previewRetry.textContent = '重试预览';
    el.previewRetry.hidden = true;
    el.previewRetry.addEventListener('click', () => { if (activeMatch) openPreview(activeMatch); });
    document.getElementById('preview-feedback').appendChild(el.previewStatus);
    document.getElementById('preview-feedback').appendChild(el.previewRetry);

    el.btnClosePreview.addEventListener('click', closePreview);
    el.btnLocate.addEventListener('click', async () => {
      const item = activeMatch && Bridge.itemForPath(activeMatch.video_path);
      if (item) await Bridge.locateInEagle([item.id]);
    });

    // 键盘：Esc 收起预览；预览打开时 ←/→ 切换上一个/下一个结果
    document.addEventListener('keydown', (e) => {
      if (document.querySelector('dialog[open]')) return;
      if (e.key === 'Escape') {
        if (document.querySelector('.compact-menu[open]')) return;
        closePreview();
        return;
      }
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (activeMatch && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        openPreviewAt(activePos + (e.key === 'ArrowRight' ? 1 : -1));
      }
    });
  }

  function setSelectionHandler(fn) {
    selectionHandler = fn;
  }

  /* ---------- 视图（排序/过滤/分组）---------- */
  function setView(partial) {
    if (partial.minDur !== undefined && (!Number.isFinite(partial.minDur) || partial.minDur < 0
        || (archiveFilter.maxDur != null && partial.minDur > archiveFilter.maxDur))) {
      throw new Error('片段时长下限须为非负数，且不能大于上限');
    }
    Object.assign(view, partial);
    if (lastMatches.length) render();
  }

  function computeDisplayList() {
    let idxs = lastMatches.map((_, i) => i);
    if (archiveTime.mode !== 'all') {
      const allowed = new Set(SearchRecipe.filterMatches(lastMatches, archiveTime,
        (match) => Bridge.itemForPath(match.video_path)));
      idxs = idxs.filter((i) => allowed.has(lastMatches[i]));
    }
    if (view.minDur > 0) {
      idxs = idxs.filter((i) => (lastMatches[i].duration_seconds || 0) >= view.minDur);
    }
    const nameQuery = archiveFilter.query.trim().toLocaleLowerCase();
    if (nameQuery) idxs = idxs.filter((i) => String(lastMatches[i].video_name || '').toLocaleLowerCase().includes(nameQuery));
    if (archiveFilter.source !== 'all') {
      idxs = idxs.filter((i) => !!lastMatches[i].manualScore === (archiveFilter.source === 'manual'));
    }
    const tags = String(archiveFilter.tags || '').split(/[,，]/).map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean);
    const orientation = archiveFilter.orientation || 'all';
    if (tags.length || orientation !== 'all' || archiveFilter.maxDur != null) {
      idxs = idxs.filter((i) => {
        const match = lastMatches[i];
        const item = Bridge.itemForPath(match.video_path);
        const itemTags = new Set((item?.tags || []).map((tag) => String(tag).toLocaleLowerCase()));
        if (tags.some((tag) => !itemTags.has(tag))) return false;
        const width = Number(item?.width); const height = Number(item?.height);
        const shape = width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)
          ? width > height ? 'landscape' : width < height ? 'portrait' : 'square' : 'unknown';
        return (orientation === 'all' || shape === orientation)
          && (archiveFilter.maxDur == null || (Number.isFinite(match.duration_seconds) && match.duration_seconds <= archiveFilter.maxDur));
      });
    }
    const cmp = {
      sim: (a, b) => (lastMatches[b].similarity || 0) - (lastMatches[a].similarity || 0)
        || Number(lastMatches[b].manualScore?.mode === 'top') - Number(lastMatches[a].manualScore?.mode === 'top'),
      dur: (a, b) => (lastMatches[b].duration_seconds || 0) - (lastMatches[a].duration_seconds || 0),
      name: (a, b) => String(lastMatches[a].video_name).localeCompare(String(lastMatches[b].video_name), 'zh')
        || lastMatches[a].start_frame - lastMatches[b].start_frame,
    }[view.sortBy] || null;
    if (cmp) idxs.sort(cmp);
    return idxs;
  }

  function computeGroups() {
    const map = new Map(); // normalizedPath -> group
    const list = [];
    displayList.forEach((i) => {
      const key = Bridge.normalizePath(lastMatches[i].video_path);
      let g = map.get(key);
      if (!g) {
        g = { name: lastMatches[i].video_name, idxs: [] };
        map.set(key, g);
        list.push(g);
      }
      g.idxs.push(i);
    });
    return list;
  }

  /* ---------- 检索 ---------- */
  async function findLibraryIndexes(modelName = Config.get().modelName, options = {}) {
    const identity = await Bridge.resolveLibraryIdentity();
    if (!identity?.id || !identity.index_name) throw new Error('素材库身份不完整，请升级或重启搜索服务');
    const indexes = await Api.listIndexes(identity.id);
    const matching = indexes.filter((ix) => ix.model === modelName
      && ix.name === `${identity.index_name}_${modelName}.lance`);
    const paths = matching.map((ix) => ix.path);
    return options.withRevisions ? { paths, revisions: matching.map((ix) => ix.revision ?? null) } : paths;
  }

  /* scopeSet 非空时只保留路径在集合内的结果（限定选中文件夹搜索） */
  function applyScope(matches, scopeSet) {
    if (!scopeSet) return matches;
    return matches.filter((m) => scopeSet.has(Bridge.normalizePath(m.video_path)));
  }

  function finishSearch(resp, scopeSet, query, recipe) {
    if (!resp.ok || !resp.data || !resp.data.success) {
      const msg = (resp.data && resp.data.error) || `搜索失败（HTTP ${resp.status}）`;
      return { ok: false, message: msg };
    }
    lastQuery = query;
    lastMatches = identifyMatches(applyScope(resp.data.matches || [], scopeSet));
    archiveTime = { mode: 'all' };
    archiveFilter = { query: '', source: 'all' };
    lastRecipe = recipe;
    newKeys.clear();
    selectedIdx.clear(); // 勾选下标相对上一轮结果，跨搜索保留会让批量操作命中错误素材
    render();
    document.dispatchEvent(new CustomEvent('search-completed'));
    return { ok: true, count: lastMatches.length, extra: resp.data };
  }

  async function prepare(modelName) {
    const indices = await findLibraryIndexes(modelName, { withRevisions: true });
    if (indices.paths.length === 0) return null;
    await Bridge.refreshPathMap();
    return indices;
  }

  const NO_INDEX = { ok: false, message: '当前素材库还没有索引，请先点击「索引整个库」' };

  function identifyMatches(matches) {
    return matches.map((match) => ({ ...match,
      eagleItemId: Bridge.itemForPath(match.video_path)?.id || match.eagleItemId,
    }));
  }

  async function requestRecipe(recipe, context, signal) {
    const snapshot = await prepare(recipe.config.modelName);
    if (signal?.aborted) { const error = new Error('已取消等待'); error.name = 'AbortError'; throw error; }
    if (!snapshot) throw new Error(NO_INDEX.message);
    const indices = snapshot.paths;
    if (SearchRecipe.normalize(recipe.library) !== SearchRecipe.normalize(eagle.library.path)) {
      throw new Error('素材库已切换，请重新搜索');
    }
    if (context.paths && context.paths.size === 0) {
      return { ok: true, data: { success: true, matches: [] } };
    }

    const payload = context.payload || recipe.payload;
    const cfg = recipe.config;
    const cacheParams = {
      kind: recipe.kind, query: recipe.query, payload, config: cfg,
      library: recipe.library, indexNames: indices,
      indexRevisions: snapshot.revisions,
      service: typeof Config.baseUrl === 'function' ? Config.baseUrl() : '',
      allowedVideoPaths: context.paths == null ? null : Array.from(context.paths),
    };
    // 旧服务没有索引版本时仍可搜索，但不可把同路径误当作未更新。
    const canCache = snapshot.revisions.every((revision) => typeof revision === 'string' && revision.length > 0);
    if (canCache && typeof SearchCache !== 'undefined') {
      const cached = SearchCache.get(cacheParams);
      if (cached) {
        console.log('[搜索缓存] 命中缓存，跳过请求');
        setPhase('从缓存加载结果…');
        return { ok: true, data: { success: true, matches: cached } };
      }
    }

    setPhase('等待服务返回结果…');

    let resp;
    if (recipe.kind === 'visual') {
      resp = await Api.searchVisual(payload, indices, cfg.visualThreshold, context.paths, cfg, { signal });
    } else if (recipe.kind === 'hybrid') {
      resp = await Api.searchHybrid(recipe.query, payload, indices, cfg.threshold, context.paths, cfg, { signal });
    } else {
      resp = await Api.search(recipe.query, indices, cfg.threshold, context.paths, cfg, { signal });
    }

    // 存储到缓存
    if (canCache && !signal?.aborted && typeof SearchCache !== 'undefined' && resp.ok && resp.data?.success && resp.data?.matches) {
      SearchCache.set(cacheParams, resp.data.matches);
      console.log('[搜索缓存] 已缓存结果');
    }

    return resp;
  }

  async function runCaptured(kind, query, payload, context, threshold) {
    if (busy) return { ok: false, message: '已有搜索正在进行，请稍候' };
    const generation = ++requestGeneration;
    const controller = new AbortController();
    activeRequest = controller;
    setBusy(true);
    setPhase('准备搜索范围…');
    try {
      const recipe = SearchRecipe.capture(kind, query, payload, context, threshold);
      const resp = await requestRecipe(recipe, context, controller.signal);
      if (generation !== requestGeneration) return { ok: false, cancelled: true, stale: true };
      if (SearchRecipe.normalize(recipe.library) !== SearchRecipe.normalize(eagle.library.path)) {
        throw new Error('素材库已切换，已忽略旧搜索结果');
      }
      setPhase('渲染结果…');
      return finishSearch(resp, context.paths, query, recipe);
    } catch (error) {
      if (generation !== requestGeneration || error.name === 'AbortError') return { ok: false, cancelled: true, stale: generation !== requestGeneration };
      throw error;
    } finally {
      if (generation === requestGeneration) { activeRequest = null; setPhase(''); setBusy(false); }
    }
  }

  function run(query, threshold, context) {
    return runCaptured('text', query, null, context, threshold);
  }

  function runVisual(payload, context, label = '') {
    return runCaptured('visual', label || '视觉搜索', payload, context);
  }

  function runFrameText(query, payload, context, threshold) {
    return runCaptured('text', query, payload, context, threshold);
  }

  /* 混合检索：文本提示词 × 视觉片段 融合（生成提示词搜索用） */
  function runHybrid(query, payload, context, textThreshold = null) {
    return runCaptured('hybrid', query, payload, context, textThreshold);
  }

  /* 仓库更新只返回候选；持久化成功后才改变当前显示。 */
  async function replay(recipe) {
    if (busy) throw new Error('已有搜索正在进行，请稍候');
    const generation = ++requestGeneration;
    const controller = new AbortController();
    activeRequest = controller;
    setBusy(true);
    setPhase('准备更新范围…');
    try {
      const context = await SearchRecipe.resolve(recipe);
      const resp = await requestRecipe(recipe, context, controller.signal);
      if (generation !== requestGeneration || controller.signal.aborted) {
        const error = new Error('已取消更新等待'); error.name = 'AbortError'; throw error;
      }
      if (SearchRecipe.normalize(recipe.library) !== SearchRecipe.normalize(eagle.library.path)) {
        throw new Error('素材库已切换，已忽略旧更新结果');
      }
      if (!resp.ok || !resp.data?.success) throw new Error(resp.data?.error || '更新搜索失败');
      return { matches: identifyMatches(applyScope(resp.data.matches || [], context.paths)),
        missingDates: context.missingDates };
    } finally {
      if (generation === requestGeneration) { activeRequest = null; setPhase(''); setBusy(false); }
    }
  }

  /* ---------- 渲染 ---------- */
  /* 文件名等外部字符串进 innerHTML 前必须转义：本页面可 require Node 模块，
     一个精心构造的文件名足以变成任意代码执行 */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtTime(t) {
    return String(t || '').replace(/\.\d+$/, '');
  }

  /* 视频头几帧可能是黑场/解码异常，缩略图从第 3 帧开始取（不超过场景尾帧） */
  function thumbFrame(m) {
    return Math.min(Math.max(m.start_frame, 3), m.end_frame);
  }

  function previewStartFrame(m) {
    return Math.min(m.start_frame + PREVIEW_LEAD_IN_FRAMES, m.end_frame);
  }

  function notifySelection() {
    selectionHandler?.(selectedIdx.size, lastMatches.length);
    document.dispatchEvent(new CustomEvent('search-selection'));
  }

  function setCardSelection(idx, checked, card, pick) {
    if (checked) selectedIdx.add(idx);
    else selectedIdx.delete(idx);
    pick.checked = checked;
    card.classList.toggle('selected', checked);
    notifySelection();
  }

  function buildCard(m, idx, pos) {
    const item = Bridge.itemForPath(m.video_path);
    const card = document.createElement('div');
    cardMatches.set(card, m);
    const initiallySelected = selectedIdx.has(idx);
    card.className = 'card' + (item ? '' : ' missing') + (initiallySelected ? ' selected' : '');
    card.dataset.sceneKey = String(ArchiveStore.sceneKey(m));
    card.title = document.body?.dataset.topic === 'true'
      ? '左键预览；右键从主题移除片段' : '左键预览；右键选中或取消选择';

    const thumbBox = document.createElement('div');
    thumbBox.className = 'thumb-box';
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = m.video_name;
    img.draggable = false;
    matchThumbnails.set(m, img);
    thumbBox.appendChild(img);
    ThumbLoader.load(img, Api.previewUrl(m.video_path, thumbFrame(m)));
    bindHover(thumbBox, m);
    if (typeof MediaDrag !== 'undefined') {
      MediaDrag.bindOriginal(thumbBox, () => selectedIdx.has(idx) ? getSelectedMatches() : [m], stopHoverPreview);
    }

    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'pick';
    pick.title = '选中此片段';
    pick.checked = initiallySelected;
    pick.addEventListener('click', (e) => e.stopPropagation());
    pick.addEventListener('change', () => {
      setCardSelection(idx, pick.checked, card, pick);
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = m.video_name;
    name.title = m.video_path;
    const sub = document.createElement('div');
    sub.className = 'sub';
    const badge = m.both_hit ? '<span class="badge-both" title="文本与视觉两路均命中">双</span>' : '';
    // AI 查询增强下被多条改写查询同时命中的场景更可信，展示 ×N 徽标
    const mq = Array.isArray(m.matched_queries) ? m.matched_queries : [];
    const multi = mq.length > 1
      ? `<span class="badge-multi" title="${esc(mq.map((q) => `${q.text}（${Number(q.similarity || 0).toFixed(1)}）`).join('\n'))}">×${mq.length}</span>`
      : '';
    const manual = m.manualScore ? '<span class="badge-manual" title="人工分数，更新时保留">人工</span>' : '';
    sub.innerHTML = `<span>${esc(fmtTime(m.start))} – ${esc(fmtTime(m.end))}</span>`
      + `<span>${multi}${badge}${manual}<span class="sim">${Number(m.similarity).toFixed(1)}</span></span>`;
    meta.appendChild(name);
    meta.appendChild(sub);
    if (newKeys.has(ArchiveStore.sceneKey(m))) {
      const badgeNew = document.createElement('span');
      badgeNew.className = 'badge-new';
      badgeNew.textContent = '本次新增';
      thumbBox.appendChild(badgeNew);
    }
    if (!item) {
      const tag = document.createElement('div');
      tag.className = 'missing-tag';
      tag.textContent = '素材已不在库中（可在设置中重建索引清理）';
      meta.appendChild(tag);
    }

    const similarBtn = document.createElement('button');
    similarBtn.className = 'similar-btn';
    similarBtn.textContent = '选帧找相似';
    similarBtn.title = '在右侧预览中选定画面后找相似';
    similarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPreviewAt(pos);
    });

    card.appendChild(thumbBox);
    card.appendChild(pick);
    card.appendChild(similarBtn);
    card.appendChild(meta);
    card.addEventListener('click', () => openPreviewAt(pos));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (contextMenuHandler?.(e, m)) return;
      setCardSelection(idx, !selectedIdx.has(idx), card, pick);
    });
    return card;
  }

  function buildGroup(g, startPos) {
    const details = document.createElement('details');
    details.className = 'vgroup';
    details.dataset.videoPath = Bridge.normalizePath(lastMatches[g.idxs[0]].video_path);
    details.open = true;
    const summary = document.createElement('summary');
    const scores = g.idxs.map((idx) => lastMatches[idx].similarity).filter(Number.isFinite);
    const best = scores.length ? scores.reduce((a, b) => Math.max(a, b), -Infinity).toFixed(1) : '—';
    summary.innerHTML = `<b>${esc(g.name)}</b><span class="vgroup-info">${g.idxs.length} 个场景 · 最高 ${best}</span>`;
    const body = document.createElement('div');
    body.className = 'vgroup-body';
    let shown = 0;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'group-load-more';
    const appendBatch = () => {
      const end = Math.min(shown + CHUNK_SIZE, g.idxs.length);
      for (let i = shown; i < end; i += 1) {
        const idx = g.idxs[i];
        body.appendChild(buildCard(lastMatches[idx], idx, startPos + i));
      }
      shown = end;
      details.dataset.loaded = String(shown);
      more.textContent = `加载更多场景（${shown}/${g.idxs.length}）`;
      more.hidden = shown === g.idxs.length;
    };
    more.addEventListener('click', appendBatch);
    details.addEventListener('toggle', () => { if (details.open && shown === 0) appendBatch(); });
    appendBatch();
    details.appendChild(summary);
    details.appendChild(body);
    details.appendChild(more);
    return details;
  }

  function renderNextChunk() {
    const frag = document.createDocumentFragment();
    let added = 0;

    if (view.grouped) {
      let pos = 0;
      for (let gi = 0; gi < groupPtr; gi += 1) pos += groups[gi].idxs.length;
      while (groupPtr < groups.length && added < CHUNK_SIZE) {
        const g = groups[groupPtr];
        frag.appendChild(buildGroup(g, pos));
        pos += g.idxs.length;
        added += g.idxs.length;
        groupPtr += 1;
      }
    } else {
      const end = Math.min(flatPtr + CHUNK_SIZE, displayList.length);
      for (let p = flatPtr; p < end; p += 1) {
        frag.appendChild(buildCard(lastMatches[displayList[p]], displayList[p], p));
      }
      added = end - flatPtr;
      flatPtr = end;
    }

    const oldSentinel = el.results.querySelector('.sentinel');
    if (oldSentinel) oldSentinel.remove();
    el.results.appendChild(frag);

    const remaining = view.grouped ? groupPtr < groups.length : flatPtr < displayList.length;
    if (remaining) {
      const shown = view.grouped
        ? groups.slice(0, groupPtr).reduce((s, g) => s + g.idxs.length, 0)
        : flatPtr;
      const sentinel = document.createElement('div');
      sentinel.className = 'sentinel';
      sentinel.textContent = `已显示 ${shown}/${displayList.length}，下滑加载更多…`;
      el.results.appendChild(sentinel);
      sentinelObserver.observe(sentinel);
    }
  }

  function render() {
    renderGeneration += 1;
    document.dispatchEvent(new CustomEvent('search-context'));
    closePreview();
    stopHoverPreview();
    ThumbLoader.clear();
    if (sentinelObserver) sentinelObserver.disconnect();
    sentinelObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) renderNextChunk();
    }, { root: el.results, rootMargin: '400px' });

    // 剔除已被过滤掉的勾选项，避免批量操作命中看不见的结果
    displayList = computeDisplayList();
    const visible = new Set(displayList);
    [...selectedIdx].forEach((i) => { if (!visible.has(i)) selectedIdx.delete(i); });

    groups = view.grouped ? computeGroups() : [];
    // 分组会重排视觉顺序：把 displayList 拍平成与渲染一致的顺序，
    // openPreviewAt/时间轴/←→导航都以 displayList 位置为准，两者必须同构
    if (view.grouped) displayList = groups.flatMap((g) => g.idxs);
    el.results.innerHTML = '';
    el.results.scrollTop = 0;
    el.results.classList.toggle('grouped', view.grouped);
    flatPtr = 0;
    groupPtr = 0;
    notifySelection();

    const has = displayList.length > 0;
    el.emptyState.classList.toggle('hidden', has);
    el.viewBar.classList.toggle('hidden', lastMatches.length === 0);
    if (el.localFilters) {
      el.localFilters.classList.toggle('hidden', lastMatches.length === 0);
      const values = { 'topic-scene-query': archiveFilter.query, 'topic-scene-source': archiveFilter.source,
        'result-tags': archiveFilter.tags || '',
        'result-max-dur': archiveFilter.maxDur ?? '' };
      Object.entries(values).forEach(([id, value]) => {
        const input = document.getElementById(id);
        if (input) input.value = value;
      });
      document.getElementById('result-filter-error').textContent = '';
    }
    const hasLocalFilter = archiveFilter.query.trim() || archiveFilter.source !== 'all'
      || archiveFilter.tags?.trim() || (archiveFilter.orientation || 'all') !== 'all' || archiveFilter.maxDur != null;
    document.getElementById('filter-active-indicator')?.classList.toggle('hidden', !hasLocalFilter && view.minDur <= 0);
    el.resultCount.textContent = view.minDur > 0 || archiveTime.mode !== 'all' || hasLocalFilter
      ? `${displayList.length}/${lastMatches.length} 条`
      : `${lastMatches.length} 条`;
    if (!has) {
      el.emptyState.innerHTML = lastMatches.length > 0 && hasLocalFilter
        ? '<p>当前组合筛选下没有片段，可清除筛选或调整时间与片段时长。标签使用 Eagle 素材信息。</p>'
        : lastMatches.length > 0 && archiveTime.mode !== 'all'
        ? '<p>当前筛选下没有已保存的结果，可切回「不限时间」或调整时长。缺少加入 Eagle 时间的素材不参与时间筛选。</p>'
        : lastMatches.length > 0
        ? '<p>当前时长过滤下没有结果，调低「≥秒」试试。</p>'
        : '<p>没有匹配结果，可尝试降低阈值或换个描述。</p>';
      return;
    }
    renderNextChunk();
  }

  /* ---------- 预览面板：同视频命中时间轴 ---------- */
  function renderTimeline(match, pos) {
    const tl = el.timeline;
    tl.innerHTML = '';
    const key = Bridge.normalizePath(match.video_path);
    const sameVideo = []; // [{pos, m}]
    displayList.forEach((idx, p) => {
      if (Bridge.normalizePath(lastMatches[idx].video_path) === key) {
        sameVideo.push({ pos: p, m: lastMatches[idx] });
      }
    });
    if (sameVideo.length < 2) {
      tl.classList.add('hidden');
      return;
    }
    tl.classList.remove('hidden');
    const fps = match.fps || 25;
    // 时间轴总长：优先 Eagle 素材的时长，否则用命中场景的最大结束帧估算
    const item = Bridge.itemForPath(match.video_path);
    const maxEnd = Math.max(...sameVideo.map((s) => s.m.end_frame)) / fps;
    const total = Math.max(item && item.duration ? item.duration : 0, maxEnd) || maxEnd;
    sameVideo.forEach((s) => {
      const seg = document.createElement('div');
      seg.className = 'tl-seg' + (s.pos === pos ? ' active' : '');
      const left = (s.m.start_frame / fps / total) * 100;
      const width = Math.max(((s.m.end_frame - s.m.start_frame) / fps / total) * 100, 0.8);
      seg.style.left = `${Math.min(left, 99)}%`;
      seg.style.width = `${Math.min(width, 100 - left)}%`;
      seg.title = `${fmtTime(s.m.start)} – ${fmtTime(s.m.end)}  相似度 ${Number(s.m.similarity).toFixed(1)}`;
      seg.addEventListener('click', (e) => {
        e.stopPropagation();
        openPreviewAt(s.pos);
      });
      tl.appendChild(seg);
    });
  }

  /* ---------- 点击预览（支持 ←/→ 键盘切换）---------- */
  /* 素材标签 chips：点击任意标签直接以它为查询词搜索（提纯打的标签由此形成闭环） */
  function renderPreviewTags(match) {
    const box = el.previewTags;
    box.innerHTML = '';
    const item = Bridge.itemForPath(match.video_path);
    const tags = (item && Array.isArray(item.tags)) ? item.tags : [];
    if (!tags.length) {
      const empty = document.createElement('span');
      empty.className = 'hint'; empty.textContent = '暂无标签'; box.appendChild(empty);
    }
    tags.forEach((tag) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip';
      chip.textContent = tag;
      chip.title = `搜索「${tag}」`;
      chip.addEventListener('click', () => {
        const input = document.getElementById('query');
        const btn = document.getElementById('btn-search');
        input.value = tag;
        if (!btn.disabled) btn.click();
      });
      box.appendChild(chip);
    });
  }

  function renderInspectorMembership() {
    const box = document.getElementById('preview-membership');
    if (!box) return;
    box.replaceChildren();
    if (!activeMatch) return;
    const topics = topicMembership?.(activeMatch);
    const library = eagle.library.path;
    if (!topics || !topics.length) {
      const empty = document.createElement(topics ? 'span' : 'button');
      empty.className = 'hint';
      empty.textContent = topics ? '尚未收录到主题' : topicMembershipStatus;
      if (!topics) {
        empty.type = 'button';
        empty.addEventListener('click', () => TopicRelations.refresh());
      }
      box.appendChild(empty);
      return;
    }
    topics.forEach((topic) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = topic.name; button.title = topic.name;
      button.addEventListener('click', () => TopicRelations.openTopic(topic.id, library));
      box.appendChild(button);
    });
  }

  function renderInspectorInfo(match, item) {
    const rating = document.getElementById('preview-rating');
    const details = document.getElementById('preview-details');
    if (!rating || !details) return;
    const stars = Number(item?.star);
    const eagleRating = Number.isInteger(stars) && stars >= 0 && stars <= 5
      ? '★'.repeat(stars) + '☆'.repeat(5 - stars) : '未获取';
    rating.innerHTML = `<dt>Eagle 评分</dt><dd class="inspector-rating-stars">${esc(eagleRating)}</dd>`
      + `<dt>${match.manualScore ? '人工评分' : '相似度'}</dt><dd>${esc(match.manualScore?.value ?? Number(match.similarity).toFixed(2))}</dd>`;
    const formatDate = (value) => {
      const date = new Date(Number(value));
      return value != null && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '未获取';
    };
    const size = Number(item?.size);
    const duration = Number(item?.duration);
    const rows = [
      ['尺寸', item?.width > 0 && item?.height > 0 ? `${item.width} × ${item.height}` : '未获取'],
      ['片段时长', Number.isFinite(match.duration_seconds) ? `${match.duration_seconds.toFixed(2)} 秒` : match.duration_display || '未获取'],
      ['素材时长', Number.isFinite(duration) && duration > 0 ? `${duration.toFixed(2)} 秒` : '未获取'],
      ['文件大小', Number.isFinite(size) && size > 0 ? `${(size / 1048576).toFixed(2)} MB` : '未获取'],
      ['格式', String(item?.ext || match.video_path?.split('.').pop() || '未获取').toUpperCase()],
      ['帧率', match.fps ? `${match.fps} fps` : '未获取'],
      ['加入日期', formatDate(item?.importedAt)],
      ['修改日期', formatDate(item?.lastModified)],
      ['文件路径', item?.filePath || match.video_path],
    ];
    details.innerHTML = rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('');
  }

  function openPreviewAt(pos) {
    if (pos < 0 || pos >= displayList.length) return;
    activePos = pos;
    const match = lastMatches[displayList[pos]];
    openPreview(match);
    renderTimeline(match, pos);
    renderPreviewTags(match);
  }

  function openPreviewByKey(key) {
    const pos = displayList.findIndex((index) => ArchiveStore.sceneKey(lastMatches[index]) === key);
    if (pos < 0) return false;
    openPreviewAt(pos);
    return true;
  }

  /* ---------- 预览诊断（临时：把真实播放数据追加到 <插件目录>/preview-diag.log） ---------- */
  const PreviewDiag = (() => {
    const SAMPLE_MS = 2000;   // 起播后采样多久的帧间隔
    const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    function logPath() {
      try {
        // 写到系统临时目录，避免往插件目录写文件触发 Eagle 的重载监听
        return require('path').join(require('os').tmpdir(), 'eagle-preview-diag.log');
      } catch (error) { return ''; }
    }
    function push(record) {
      const file = logPath();
      if (!file) return;
      try {
        require('fs').appendFileSync(file, JSON.stringify(record) + '\n');
        if (require('fs').statSync(file).size > 512 * 1024) require('fs').writeFileSync(file, '');
      } catch (error) { /* 诊断失败不影响播放 */ }
    }
    function elementInfo(video) {
      const rect = video.getBoundingClientRect ? video.getBoundingClientRect() : null;
      const panel = el.previewPanel;
      const workspace = typeof document.querySelector === 'function'
        ? document.querySelector('.result-workspace') : null;
      return {
        box: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : '',
        panelHidden: !!(panel && panel.classList.contains('hidden')),
        panelState: (panel && panel.dataset.state) || '',
        layout: (workspace && workspace.dataset.previewLayout) || '',
      };
    }
    function begin(meta) {
      if (!logPath()) return { mark() {}, setPath() {}, flush() {} };
      const t0 = now();
      const rec = {
        at: new Date().toISOString(),
        mode: meta.mode,
        path: '',
        clip: meta.clip || '',
        scene: meta.scene || null,
        file: meta.file || '',
        srcKind: meta.srcKind || '',
        events: [],
      };
      if (typeof navigator !== 'undefined' && navigator.userAgent) {
        const chrome = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
        rec.chrome = chrome ? chrome[1] : navigator.userAgent;
      }
      let sampling = false;
      let finished = false;
      let sampleTimer = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (sampleTimer !== null) clearTimeout(sampleTimer);
        sampleTimer = null;
        const video = meta.video;
        const quality = video && video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
        if (video) {
          rec.video = `${video.videoWidth}x${video.videoHeight}`;
          rec.readyState = video.readyState;
          rec.networkState = video.networkState;
          rec.seeking = video.seeking;
          rec.currentTime = video.currentTime;
          rec.buffered = [];
          for (let i = 0; i < (video.buffered?.length || 0); i += 1) {
            rec.buffered.push([video.buffered.start(i), video.buffered.end(i)]);
          }
          rec.paused = video.paused;
          rec.currentSrc = (video.currentSrc || '').slice(0, 160);
          rec.muted = video.muted;
          rec.rate = video.playbackRate;
          rec.controls = !!video.controls;
          Object.assign(rec, elementInfo(video));
          try { rec.videos = document.querySelectorAll('video').length; } catch (error) { /* ignore */ }
        }
        if (quality) rec.droppedTotal = quality.droppedVideoFrames;
        push(rec);
      };
      const sample = () => {
        sampling = true;
        const video = meta.video;
        const sampleStarted = now();
        const mediaStarted = video ? video.currentTime : 0;
        const startQuality = video && video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
        const gaps = [];
        const rafGaps = [];
        let last = null;
        let lastRaf = null;
        const onRaf = (time) => {
          if (finished) return;
          if (lastRaf !== null) rafGaps.push(+(time - lastRaf).toFixed(1));
          lastRaf = time;
          if (now() - t0 < SAMPLE_MS) requestAnimationFrame(onRaf);
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(onRaf);
        const onFrame = (time) => {
          if (finished) return;
          if (last !== null) gaps.push(+(time - last).toFixed(1));
          last = time;
          if (now() - t0 < SAMPLE_MS && typeof video.requestVideoFrameCallback === 'function') {
            video.requestVideoFrameCallback(onFrame);
          } else {
            stop();
          }
        };
        const stop = () => {
          if (finished) return;
          const endQuality = video && video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
          rec.sampleMs = Math.round(now() - sampleStarted);
          rec.advanced = video ? +(video.currentTime - mediaStarted).toFixed(3) : 0;
          rec.frames = gaps.length;
          rec.gapMean = gaps.length ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : 0;
          rec.gapMax = gaps.length ? +Math.max(...gaps).toFixed(1) : 0;
          rec.gapOver40 = gaps.filter((g) => g > 40).length;
          rec.rafFrames = rafGaps.length;
          rec.rafGapMean = rafGaps.length ? +(rafGaps.reduce((a, b) => a + b, 0) / rafGaps.length).toFixed(1) : 0;
          rec.rafGapMax = rafGaps.length ? +Math.max(...rafGaps).toFixed(1) : 0;
          rec.rafGapOver40 = rafGaps.filter((g) => g > 40).length;
          if (startQuality && endQuality) {
            rec.dropped = endQuality.droppedVideoFrames - startQuality.droppedVideoFrames;
            rec.decoded = endQuality.totalVideoFrames - startQuality.totalVideoFrames;
          }
          finish();
        };
        sampleTimer = setTimeout(stop, SAMPLE_MS + 1500);
        if (video && typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(onFrame);
      };
      return {
        mark(name, extra) {
          if (finished) return;
          rec.events.push(extra === undefined ? `${name}@${Math.round(now() - t0)}` : `${name}(${extra})@${Math.round(now() - t0)}`);
          if (name === 'playing' && !sampling) sample();
        },
        setPath(path, srcKind) {
          rec.path = path;
          if (srcKind) rec.srcKind = srcKind;
        },
        flush: finish,
      };
    }
    function boot() {
      const rec = { at: new Date().toISOString(), mode: 'boot', file: logPath() };
      if (typeof navigator !== 'undefined' && navigator.userAgent) rec.ua = navigator.userAgent;
      const workspace = typeof document.querySelector === 'function' ? document.querySelector('.result-workspace') : null;
      if (workspace) rec.layout = workspace.dataset.previewLayout || '';
      if (typeof window !== 'undefined') rec.window = `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`;
      push(rec);
    }
    return { begin, boot };
  })();
  if (typeof document !== 'undefined') {
    try { PreviewDiag.boot(); } catch (error) { /* 诊断不可用时忽略 */ }
  }

  function openPreview(match) {
    cancelPreviewLoad();
    if (previewDiag) { previewDiag.mark('superseded'); previewDiag.flush(); previewDiag = null; }
    const item = Bridge.itemForPath(match.video_path);
    const warmVideo = hover.video;
    const fps = match.fps || 25;
    const startFrame = previewStartFrame(match);
    const startSec = startFrame / fps;
    const endSec = match.end_frame / fps;
    let tookOver = false;
    if (warmVideo && item?.fileURL === warmVideo.getAttribute('src') && !warmVideo.error) {
      // 连正在加载的播放器一起接管，随后定位回片段开头，不重新加载源文件。
      tookOver = true;
      hover.video = null;
      const previous = el.previewVideo;
      clearPreviewMediaEvents(warmVideo);
      warmVideo.controls = true; warmVideo.muted = previous.muted;
      warmVideo.volume = previous.volume; warmVideo.playbackRate = previous.playbackRate;
      clearPreviewMediaEvents(previous);
      previous.pause(); previous.removeAttribute('src'); previous.load();
      warmVideo.id = 'preview-video'; warmVideo.className = '';
      previous.replaceWith(warmVideo);
      el.previewVideo = warmVideo;
    }
    stopHoverPreview();
    const changed = activeMatch !== match;
    activeMatch = match;
    document.dispatchEvent(new CustomEvent('preview-change'));
    const loadToken = ++previewLoadToken;
    const video = el.previewVideo;
    clearPreviewMediaEvents(video);
    video.pause();
    video.preload = 'auto';
    if (item?.fileURL && video.getAttribute?.('src') === item.fileURL && video.readyState >= 2 && !video.error) {
      // 已有解码画面时不再请求封面，避免抽帧请求干扰正在播放的源视频。
      video.removeAttribute('poster');
    } else {
      const thumbnail = matchThumbnails.get(match);
      const poster = thumbnail?.complete && thumbnail.naturalWidth > 0 ? thumbnail.currentSrc || thumbnail.src : item?.thumbnailURL;
      if (poster) video.poster = poster;
      else video.removeAttribute('poster');
    }
    const diag = PreviewDiag.begin({
      mode: 'preview',
      video,
      clip: match.video_name,
      file: (item && item.fileURL) || '',
      scene: [match.start_frame, match.end_frame],
      srcKind: item && item.fileURL ? 'file' : 'missing',
    });
    diag.setPath(tookOver ? 'takeover' : 'unknown');
    diag.mark('begin', `readyState=${video.readyState}`);
    previewDiag = diag;

    const isCurrent = () => loadToken === previewLoadToken;
    let positioned = false;
    let pendingPlayback = true;
    let attempt = 0;
    let stallTimer = null;
    let bufferingTimer = null;
    let nativeReloaded = false;
    let locateNative = null;
    let lastPlaybackTime = null;
    const clearStallTimer = () => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = null;
    };
    cancelPreviewLoad = () => {
      clearStallTimer();
      if (bufferingTimer !== null) clearTimeout(bufferingTimer);
      bufferingTimer = null;
      pendingPlayback = false;
      attempt += 1;
    };
    const setPreviewState = (state, message) => {
      if (!isCurrent()) return;
      if (bufferingTimer !== null) clearTimeout(bufferingTimer);
      bufferingTimer = null;
      el.previewPanel.dataset.state = state;
      el.previewStatus.textContent = message;
      el.previewStatus.hidden = !message;
      el.previewRetry.hidden = state !== 'error';
    };
    setPreviewState('loading', '正在加载预览…');
    const fail = (message = '无法直接播放原视频，请重试或在 Eagle 中打开素材。') => {
      if (!isCurrent()) return;
      diag.mark('fail');
      cancelPreviewLoad();
      clearPreviewMediaEvents(video);
      video.pause();
      setPreviewState('error', message);
    };
    const watchForStall = () => {
      if (!isCurrent() || stallTimer !== null) return;
      const watchedAttempt = attempt;
      lastPlaybackTime = video.currentTime;
      const timer = setTimeout(() => {
        if (!isCurrent() || watchedAttempt !== attempt || stallTimer !== timer) return;
        stallTimer = null;
        diag.mark('stall-timeout', 'native');
        if (!nativeReloaded && locateNative) {
          // 解码管线可能在接管/seek 后停住，仅重开原文件一次。
          nativeReloaded = true;
          attempt += 1;
          pendingPlayback = true;
          positioned = false;
          video.pause();
          const reloadAttempt = attempt;
          video.onloadedmetadata = () => {
            if (!isCurrent() || attempt !== reloadAttempt) return;
            video.onloadedmetadata = locateNative;
            locateNative();
          };
          diag.mark('native-reload');
          setPreviewState('native', '正在重新加载预览…');
          video.load();
          watchForStall();
        } else fail('原视频播放停滞，请重试或在 Eagle 中打开素材。');
      }, 1500);
      stallTimer = timer;
    };
    const playCurrent = () => {
      if (!isCurrent() || !pendingPlayback || !positioned) return;
      // play() 本身会等待浏览器缓冲，并驱动继续读取；额外门槛只会推迟起播。
      pendingPlayback = false;
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.oncanplay = null; video.onloadeddata = null; video.onprogress = null;
      const playingAttempt = attempt;
      diag.mark('play');
      video.play().then(() => {
        if (!isCurrent() || playingAttempt !== attempt) return;
        diag.mark('play-ok');
        setPreviewState('ready', '');
      }).catch((error) => {
        if (!isCurrent() || playingAttempt !== attempt || error.name === 'AbortError') return;
        diag.mark('play-error', error.name);
        if (error.name === 'NotAllowedError') {
          clearStallTimer();
          setPreviewState('ready', '预览已就绪，请点击播放');
        }
        else fail();
      });
    };

    video.oncanplay = playCurrent; video.onloadeddata = playCurrent; video.onprogress = playCurrent;
    video.onplaying = () => {
      if (!isCurrent()) return;
      diag.mark('playing');
      if (!pendingPlayback && !video.seeking) {
        watchForStall();
        setPreviewState('ready', '');
      }
    };
    video.onwaiting = () => {
      if (isCurrent() && !video.paused) {
        diag.mark('waiting', video.currentTime.toFixed(2));
        if (bufferingTimer === null) {
          const noticeAttempt = attempt;
          const timer = setTimeout(() => {
            if (bufferingTimer !== timer) return;
            bufferingTimer = null;
            if (isCurrent() && attempt === noticeAttempt && !video.paused) setPreviewState('buffering', '正在缓冲预览…');
          }, 200);
          bufferingTimer = timer;
        }
        watchForStall();
      }
    };
    video.onpause = video.onended = () => {
      if (!isCurrent() || !video.paused || pendingPlayback) return;
      diag.mark('paused');
      diag.flush();
      cancelPreviewLoad();
      setPreviewState('ready', '');
    };
    video.ontimeupdate = () => {
      if (!isCurrent()) return;
      // playing/play() 成功可能只跟着一帧；按播放速度累计足够进度才算恢复。
      const minProgress = 0.25 * Math.min(1, video.playbackRate || 1);
      if (!pendingPlayback && !video.paused && !video.seeking && Math.abs(video.currentTime - lastPlaybackTime) >= minProgress) {
        lastPlaybackTime = video.currentTime;
        clearStallTimer();
        setPreviewState('ready', '');
      }
      if (video.currentTime >= endSec) video.pause();
    };

    if (item && item.fileURL) {
      setPreviewState('native', '正在加载源视频…');
      diag.setPath(tookOver ? 'takeover' : 'native', 'file');
      // Chromium 108 的 poster 失败也会向 video 派发 error，但不设置 MediaError。
      video.onerror = () => {
        if (!video.error) { diag.mark('error-empty'); return; }
        diag.mark('error', `${video.error.code}:${String(video.error.message || '').slice(0, 40)}`);
        fail();
      };
      watchForStall();
      const locate = () => {
        if (!isCurrent() || video.onloadedmetadata !== locate) return;
        video.onloadedmetadata = null;
        if (Math.abs(video.currentTime - startSec) >= 0.04) {
          diag.mark('seek', `${video.currentTime.toFixed(2)}->${startSec.toFixed(2)}`);
          video.currentTime = startSec;
        }
        // 先发定位再 play；浏览器在定位完成后起播，同时驱动被暂停的预加载。
        positioned = true;
        playCurrent();
      };
      locateNative = locate;
      video.onloadedmetadata = locate;
      if (video.getAttribute?.('src') === item.fileURL && !video.error) {
        diag.mark('reuse-src', `readyState=${video.readyState}`);
        if (video.readyState >= 1) locate();
      } else { diag.mark('src-set'); video.src = item.fileURL; }
    } else {
      diag.setPath('missing', 'missing');
      fail('原视频已不在当前 Eagle 库中，请刷新结果。');
    }

    const hybridInfo = match.both_hit
      ? '<br><span class="badge-both">双</span> 文本与视觉两路均命中'
      : '';
    const mqList = Array.isArray(match.matched_queries) && match.matched_queries.length > 1
      ? '<br>命中查询：' + match.matched_queries
        .map((q) => `${esc(q.text)}（${Number(q.similarity || 0).toFixed(1)}）`).join('、')
      : '';
    el.previewInfo.innerHTML =
      `<b>${esc(match.video_name)}</b><br>`
      + `片段：${esc(fmtTime(match.start))} – ${esc(fmtTime(match.end))}${hybridInfo}${mqList}`
      + (item ? '' : '<br><span style="color:var(--danger)">素材已不在 Eagle 库中</span>')
      + '<br><span class="hint-inline">←/→ 切换结果，Esc 收起</span>';
    el.btnLocate.disabled = !item;
    renderInspectorInfo(match, item);
    renderInspectorMembership();
    document.getElementById('inspector-empty')?.classList.add('hidden');
    el.results?.querySelectorAll('.card').forEach((card) => card.classList.toggle('preview-active', cardMatches.get(card) === match));
    el.previewPanel.classList.remove('hidden');
    if (changed && el.previewPanel.parentElement) el.previewPanel.parentElement.scrollTop = 0;
  }

  function closePreview() {
    cancelPreviewLoad();
    previewLoadToken += 1;
    activeMatch = null;
    activePos = -1;
    if (previewDiag) { previewDiag.mark('close'); previewDiag.flush(); previewDiag = null; }
    document.getElementById('inspector-empty')?.classList.remove('hidden');
    el.results?.querySelectorAll('.preview-active').forEach((card) => card.classList.remove('preview-active'));
    if (el.previewVideo) {
      clearPreviewMediaEvents(el.previewVideo);
      el.previewVideo.pause();
      el.previewVideo.removeAttribute('src');
      el.previewVideo.removeAttribute('poster');
      el.previewVideo.load();
      el.previewPanel.classList.add('hidden');
    }
    document.dispatchEvent(new CustomEvent('preview-change'));
  }

  async function captureFrame() {
    const token = previewLoadToken;
    const cover = await CoverFrame.capture(el.previewVideo, activeMatch);
    if (token !== previewLoadToken) throw new Error('预览素材已切换，请重新选择画面');
    return cover;
  }

  function captureCover() { return captureFrame(); }

  function stepPreviewFrame(direction) {
    const video = el.previewVideo;
    if (!activeMatch || video.readyState < 2 || video.seeking || video.error) {
      throw new Error('请等待视频加载或定位完成');
    }
    video.pause();
    cancelPreviewLoad();
    video.onloadedmetadata = null;
    video.onseeked = null;
    video.oncanplay = null; video.onloadeddata = null; video.onprogress = null;
    video.currentTime = CoverFrame.stepTime(video.currentTime, direction, Number(activeMatch.fps) || 25, video.duration);
  }

  /* ---------- 结果存档载入 ---------- */
  function captureBrowsePosition() {
    if (!el.results?.getBoundingClientRect) return null;
    const rect = el.results.getBoundingClientRect();
    const cards = [...el.results.querySelectorAll('.card')];
    const anchor = cards.find((card) => {
      const bounds = card.getBoundingClientRect();
      return bounds.height > 0 && bounds.bottom > rect.top && bounds.top < rect.bottom;
    });
    return {
      scrollTop: el.results.scrollTop, rendered: flatPtr, groupCount: groupPtr,
      anchorKey: anchor?.dataset.sceneKey || null,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - rect.top : 0,
      groups: [...el.results.querySelectorAll('.vgroup')].map((group) => ({
        path: group.dataset.videoPath, loaded: Number(group.dataset.loaded), open: group.open,
      })),
    };
  }

  async function restoreBrowsePosition(position, { scroll = true } = {}) {
    if (!position || !el.results?.getBoundingClientRect) return false;
    const library = eagle.library.path;
    const generation = renderGeneration;
    const isCurrent = () => generation === renderGeneration && library === eagle.library.path
      && document.body.dataset.page !== 'warehouse';
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    if (!scroll) el.results.scrollTop = 0;
    // Show the initial batch before rebuilding a potentially deep browse history.
    await nextFrame();
    if (!isCurrent()) return false;
    if (view.grouped) {
      while (groupPtr < Math.min(position.groupCount || 0, groups.length)) {
        renderNextChunk();
        await nextFrame();
        if (!isCurrent()) return false;
      }
      const savedGroups = new Map((position.groups || []).map((group) => [group.path, group]));
      for (const group of el.results.querySelectorAll('.vgroup')) {
        const saved = savedGroups.get(group.dataset.videoPath);
        if (!saved) continue;
        group.open = saved.open;
        const more = group.querySelector('.group-load-more');
        while (!more.hidden && Number(group.dataset.loaded) < saved.loaded) {
          more.click();
          await nextFrame();
          if (!isCurrent()) return false;
        }
      }
    } else {
      while (flatPtr < Math.min(position.rendered || 0, displayList.length)) {
        renderNextChunk();
        await nextFrame();
        if (!isCurrent()) return false;
      }
    }
    if (!scroll) return false;
    const anchor = [...el.results.querySelectorAll('.card')].find((card) => card.dataset.sceneKey === position.anchorKey);
    const anchorRect = anchor?.getBoundingClientRect();
    const desired = anchorRect?.height > 0
      ? el.results.scrollTop + anchorRect.top - el.results.getBoundingClientRect().top - position.anchorOffset
      : position.scrollTop;
    el.results.scrollTop = Math.max(0, Number(desired) || 0);
    return el.results.scrollTop > 0;
  }

  function captureState() {
    return {
      library: SearchRecipe.normalize(lastRecipe?.library || eagle.library.path),
      matches: lastMatches.slice(), query: lastQuery,
      recipe: lastRecipe && SearchRecipe.clone(lastRecipe), view: { ...view },
      addedKeys: [...newKeys], time: SearchRecipe.clone(archiveTime),
      selected: [...selectedIdx],
      filter: { ...archiveFilter }, position: captureBrowsePosition(),
    };
  }

  function refreshTopicMembership(find, status = '主题归属…') {
    topicMembership = find;
    topicMembershipStatus = status;
    renderInspectorMembership();
  }

  function restoreState(state) {
    if (busy) throw new Error('已有搜索正在进行，请稍候再返回搜索');
    if (state?.library !== SearchRecipe.normalize(eagle.library.path)) state = null;
    lastMatches = state?.matches.slice() || [];
    lastQuery = state?.query || '';
    lastRecipe = state?.recipe ? SearchRecipe.clone(state.recipe) : null;
    Object.assign(view, state?.view || { sortBy: 'sim', minDur: 0, grouped: false });
    newKeys = new Set(state?.addedKeys || []);
    archiveTime = SearchRecipe.clone(state?.time || { mode: 'all' });
    archiveFilter = { query: '', source: 'all', ...state?.filter };
    selectedIdx = new Set(state?.selected || []);
    setPhase('');
    render();
  }

  async function loadResults(matches, query, recipe = null, savedView = null, addedKeys = [], time = { mode: 'all' }, filter = { query: '', source: 'all' }, options = {}) {
    if (options.shouldApply && !options.shouldApply()) return null;
    if (busy) throw new Error('已有搜索正在进行，请稍候再打开主题');
    const library = eagle.library.path;
    setBusy(true);
    try {
      const pathMap = await Bridge.refreshPathMap();
      if (options.shouldApply && !options.shouldApply()) return null;
      if (library !== eagle.library.path) throw new Error('素材库已切换，请重新打开主题');
      const byId = new Map([...pathMap.values()].map((item) => [item.id, item]));
      lastMatches = (Array.isArray(matches) ? matches : []).map((match) => {
        const item = byId.get(match.eagleItemId);
        return item ? { ...match, video_path: item.filePath, video_name: item.name } : match;
      });
      lastQuery = query || '';
      lastRecipe = recipe;
      archiveTime = SearchRecipe.clone(time);
      archiveFilter = { ...filter };
      newKeys = new Set(addedKeys);
      if (savedView) Object.assign(view, savedView);
      selectedIdx.clear();
      render();
      return lastMatches.length;
    } finally { setBusy(false); }
  }

  /* ---------- 供 plugin.js 取数据 ---------- */
  function replaceResults(matches, addedKeys = []) {
    if (busy) throw new Error('已有搜索正在进行，请稍候再整理主题');
    const selectedKeys = new Set((getSelectedMatches() || []).map(ArchiveStore.sceneKey));
    lastMatches = matches.slice();
    newKeys = new Set(addedKeys);
    selectedIdx = new Set(lastMatches.map((match, index) => selectedKeys.has(ArchiveStore.sceneKey(match)) ? index : -1)
      .filter((index) => index >= 0));
    render();
  }

  function getSelectedMatches() {
    if (selectedIdx.size === 0) return null;
    return [...selectedIdx].sort((a, b) => a - b).map((i) => lastMatches[i]).filter(Boolean);
  }

  function clearSelection() {
    selectedIdx.clear();
    el.results.querySelectorAll('.card.selected').forEach((card) => {
      card.classList.remove('selected');
      card.querySelector('.pick').checked = false;
    });
    notifySelection();
  }

  function getAllMatches() {
    return displayList.map((i) => lastMatches[i]);
  }

  function getLastQuery() {
    return lastQuery;
  }

  function getActiveMatch() {
    return activeMatch;
  }

  return {
    bindDom, run, runVisual, runFrameText, runHybrid, setView, findLibraryIndexes, loadResults, captureState, restoreState,
    setSelectionHandler, replaceResults, captureBrowsePosition, restoreBrowsePosition, refreshTopicMembership,
    setContextMenuHandler: (fn) => { contextMenuHandler = fn; },
    getSelectedMatches, clearSelection, getAllMatches, getLastQuery, getActiveMatch, openPreviewByKey,
    getRawMatches: () => lastMatches.slice(),
    getRecipe: () => lastRecipe && SearchRecipe.clone(lastRecipe),
    getView: () => ({ ...view }),
    getArchiveFilter: () => ({ ...archiveFilter }),
    setArchiveFilter(filter) {
      filter = { ...filterDefaults, ...filter };
      if (!['all', 'manual', 'auto'].includes(filter.source) || typeof filter.query !== 'string'
          || typeof filter.tags !== 'string' || !['all', 'landscape', 'portrait', 'square', 'unknown'].includes(filter.orientation)
          || (filter.maxDur !== null && (!Number.isFinite(filter.maxDur) || filter.maxDur < 0))) throw new Error('片段查找条件无效');
      if (filter.maxDur !== null && filter.maxDur < view.minDur) throw new Error('片段时长上限不能小于下限');
      if (JSON.stringify(archiveFilter) === JSON.stringify(filter)) return;
      archiveFilter = filter;
      render();
    },
    replay, cancel, getPhase: () => phase, isBusy: () => busy,
    pausePreview() { closePreview(); stopHoverPreview(); },
    captureCover, captureFrame, stepPreviewFrame,
    loadThumbnail: (img, url, onError) => ThumbLoader.load(img, url, onError),
    setArchiveTime(time) {
      SearchRecipe.bounds(time);
      if (JSON.stringify(archiveTime) === JSON.stringify(time)) return;
      archiveTime = SearchRecipe.clone(time);
      selectedIdx.clear();
      render();
    },
  };
})();
