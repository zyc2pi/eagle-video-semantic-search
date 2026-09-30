/* 搜索 + 结果渲染（分批/分组/排序/过滤）+ 悬停自动播放 + 预览键盘导航 + 勾选导出 */
const Search = (() => {
  const CHUNK_SIZE = 60;        // 每批渲染的卡片数，滚动到底部续加（分组模式按组为粒度）
  const THUMB_CONCURRENCY = 6;  // 缩略图并发上限（每张图都是服务端一次 ffmpeg 抽帧进程）
  const HOVER_DELAY_MS = 260;   // 悬停多少毫秒后开始播放，避免扫过误触发
  const PREVIEW_LEAD_IN_FRAMES = 2; // 跳过切点前两帧，避免转场/解码黑帧闪现

  let lastMatches = [];
  let lastQuery = '';           // 最近一次查询，供保存主题使用
  let lastRecipe = null;
  let newKeys = new Set();
  let archiveTime = { mode: 'all' };
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
  let visualHandler = null;     // 结果卡片「找相似」回调，由 plugin.js 注入
  let selectionHandler = null;  // 勾选数量变化回调，由 plugin.js 注入

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
  let previewOffsetFrame = 0; // 转码片段的起点；源视频直播放时为 0。

  const el = {};

  /* ---------- 缩略图限流加载 ---------- */
  const ThumbLoader = (() => {
    const queue = [];
    let active = 0;

    function pump() {
      while (active < THUMB_CONCURRENCY && queue.length) {
        // 入队发生在卡片插入 DOM 之前，不能用 isConnected 过滤；
        // 换一轮结果时 clear() 已清空队列，不会有陈旧请求。
        const { img, url, onError } = queue.shift();
        active += 1;
        const done = (event) => {
          active -= 1;
          img.onload = null;
          img.onerror = null;
          try { if (event?.type === 'error') onError?.(); } finally { pump(); }
        };
        img.onload = done;
        img.onerror = done;
        img.src = url;
      }
    }

    return {
      load(img, url, onError) {
        // 使用懒加载：图片进入视口时才加载
        if (typeof LazyLoad !== 'undefined') {
          LazyLoad.observe(img, url, () => {
            if (onError) {
              img.onerror = onError;
            }
          });
        } else {
          // 降级：直接加载
          queue.push({ img, url, onError });
          pump();
        }
      },
      clear() {
        queue.length = 0;
        if (typeof LazyLoad !== 'undefined') {
          LazyLoad.clear();
        }
      },
    };
  })();

  /* ---------- 悬停自动播放（小窗静音循环该片段） ---------- */
  const hover = { timer: null, video: null, box: null };

  function stopHoverPreview() {
    if (hover.timer) {
      clearTimeout(hover.timer);
      hover.timer = null;
    }
    if (hover.video) {
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
    const item = Bridge.itemForPath(m.video_path);
    // 只对 <video> 可直接播放的格式做悬停预览；mkv/avi/flv 悬停转码代价太高，保持点击预览
    if (!item || !item.fileURL || !Bridge.isWebPlayable(item)) return;

    const fps = m.fps || 25;
    const startSec = previewStartFrame(m) / fps;
    const endSec = Math.max(m.end_frame / fps, startSec + 0.2);

    const v = document.createElement('video');
    v.className = 'hover-video';
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = item.fileURL;
    let revealRequested = false;

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
      if (hover.video !== v) return;
      v.play().then(revealAfterPaint).catch(() => {});
    };
    v.onloadedmetadata = () => {
      if (Math.abs(v.currentTime - startSec) < 0.04) playFromScene();
      else v.currentTime = startSec;
    };
    v.onseeked = playFromScene;
    v.onerror = () => {
      if (hover.video === v) stopHoverPreview();
    };
    v.ontimeupdate = () => {
      if (v.currentTime >= endSec) v.currentTime = startSec; // 片段内循环
    };
    box.appendChild(v);
    box.classList.add('hovering');
    hover.video = v;
    hover.box = box;
  }

  function bindHover(box, m) {
    box.addEventListener('mouseenter', () => {
      stopHoverPreview();
      hover.timer = setTimeout(() => {
        hover.timer = null;
        startHoverPreview(box, m);
      }, HOVER_DELAY_MS);
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
    el.previewPanel.appendChild(el.previewStatus);
    el.previewPanel.appendChild(el.previewRetry);

    el.btnClosePreview.addEventListener('click', closePreview);
    el.btnLocate.addEventListener('click', async () => {
      const item = activeMatch && Bridge.itemForPath(activeMatch.video_path);
      if (item) await Bridge.locateInEagle([item.id]);
    });

    // 键盘：Esc 收起预览；预览打开时 ←/→ 切换上一个/下一个结果
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
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

  function setVisualHandler(fn) {
    visualHandler = fn;
  }

  function setSelectionHandler(fn) {
    selectionHandler = fn;
  }

  /* ---------- 视图（排序/过滤/分组）---------- */
  function setView(partial) {
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
    const cmp = {
      sim: (a, b) => (lastMatches[b].similarity || 0) - (lastMatches[a].similarity || 0),
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
  async function findLibraryIndexes(modelName = Config.get().modelName) {
    const identity = await Bridge.resolveLibraryIdentity();
    if (!identity?.id || !identity.index_name) throw new Error('素材库身份不完整，请升级或重启搜索服务');
    const indexes = await Api.listIndexes(identity.id);
    return indexes.filter((ix) => ix.model === modelName
      && ix.name === `${identity.index_name}_${modelName}.lance`).map((ix) => ix.path);
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
    lastRecipe = recipe;
    newKeys.clear();
    selectedIdx.clear(); // 勾选下标相对上一轮结果，跨搜索保留会让批量操作命中错误素材
    render();
    document.dispatchEvent(new CustomEvent('search-completed'));
    return { ok: true, count: lastMatches.length, extra: resp.data };
  }

  async function prepare(modelName) {
    const indices = await findLibraryIndexes(modelName);
    if (indices.length === 0) return null;
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
    const indices = await prepare(recipe.config.modelName);
    if (signal?.aborted) { const error = new Error('已取消等待'); error.name = 'AbortError'; throw error; }
    if (!indices) throw new Error(NO_INDEX.message);
    if (SearchRecipe.normalize(recipe.library) !== SearchRecipe.normalize(eagle.library.path)) {
      throw new Error('素材库已切换，请重新搜索');
    }
    if (context.paths && context.paths.size === 0) {
      return { ok: true, data: { success: true, matches: [] } };
    }

    // 尝试从缓存获取结果
    if (typeof SearchCache !== 'undefined') {
      const cacheParams = {
        query: recipe.query,
        imagePath: recipe.payload?.imagePath,
        imageUrl: recipe.payload?.imageUrl,
        model: recipe.config.modelName,
        indexNames: indices,
        topK: recipe.config.threshold
      };

      const cached = SearchCache.get(cacheParams);
      if (cached) {
        console.log('[搜索缓存] 命中缓存，跳过请求');
        setPhase('从缓存加载结果…');
        return { ok: true, data: { success: true, matches: cached } };
      }
    }

    const payload = context.payload || recipe.payload;
    const cfg = recipe.config;
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
    if (typeof SearchCache !== 'undefined' && resp.ok && resp.data?.success && resp.data?.matches) {
      const cacheParams = {
        query: recipe.query,
        imagePath: recipe.payload?.imagePath,
        imageUrl: recipe.payload?.imageUrl,
        model: recipe.config.modelName,
        indexNames: indices,
        topK: recipe.config.threshold
      };
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
    const initiallySelected = selectedIdx.has(idx);
    card.className = 'card' + (item ? '' : ' missing') + (initiallySelected ? ' selected' : '');
    card.title = '左键预览；右键选中或取消选择';

    const thumbBox = document.createElement('div');
    thumbBox.className = 'thumb-box';
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = m.video_name;
    thumbBox.appendChild(img);
    ThumbLoader.load(img, Api.previewUrl(m.video_path, thumbFrame(m)));
    bindHover(thumbBox, m);

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
    sub.innerHTML = `<span>${fmtTime(m.start)} – ${fmtTime(m.end)}</span>`
      + `<span>${multi}${badge}<span class="sim">${Number(m.similarity).toFixed(1)}</span></span>`;
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
    similarBtn.textContent = '找相似';
    similarBtn.title = '以这个片段为查询，搜索相似场景';
    similarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      visualHandler?.({
        video_path: m.video_path,
        start_frame: m.start_frame,
        end_frame: m.end_frame,
      }, `片段「${m.video_name}」`);
    });

    card.appendChild(thumbBox);
    card.appendChild(pick);
    card.appendChild(similarBtn);
    card.appendChild(meta);
    card.addEventListener('click', () => openPreviewAt(pos));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setCardSelection(idx, !selectedIdx.has(idx), card, pick);
    });
    return card;
  }

  function buildGroup(g, startPos) {
    const details = document.createElement('details');
    details.className = 'vgroup';
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
    el.results.classList.toggle('grouped', view.grouped);
    flatPtr = 0;
    groupPtr = 0;
    notifySelection();

    const has = displayList.length > 0;
    el.emptyState.classList.toggle('hidden', has);
    el.viewBar.classList.toggle('hidden', lastMatches.length === 0);
    el.resultCount.textContent = view.minDur > 0 || archiveTime.mode !== 'all'
      ? `${displayList.length}/${lastMatches.length} 条`
      : `${lastMatches.length} 条`;
    if (!has) {
      el.emptyState.innerHTML = lastMatches.length > 0 && archiveTime.mode !== 'all'
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
    const tags = (item && Array.isArray(item.tags)) ? item.tags.slice(0, 12) : [];
    box.classList.toggle('hidden', tags.length === 0);
    tags.forEach((tag) => {
      const chip = document.createElement('span');
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

  function openPreviewAt(pos) {
    if (pos < 0 || pos >= displayList.length) return;
    activePos = pos;
    const match = lastMatches[displayList[pos]];
    openPreview(match);
    renderTimeline(match, pos);
    renderPreviewTags(match);
  }

  function openPreview(match) {
    stopHoverPreview();
    activeMatch = match;
    const loadToken = ++previewLoadToken;
    const item = Bridge.itemForPath(match.video_path);
    const fps = match.fps || 25;
    const startFrame = previewStartFrame(match);
    const startSec = startFrame / fps;
    const endSec = match.end_frame / fps;

    const video = el.previewVideo;
    video.onloadedmetadata = null;
    video.onseeked = null;
    video.ontimeupdate = null;
    video.onplaying = null;
    video.onerror = null;
    video.pause();
    previewOffsetFrame = 0;
    video.poster = Api.previewUrl(match.video_path, thumbFrame(match));

    const isCurrent = () => loadToken === previewLoadToken;
    let fallbackUsed = false;
    const setPreviewState = (state, message) => {
      if (!isCurrent()) return;
      el.previewPanel.dataset.state = state;
      el.previewStatus.textContent = message;
      el.previewRetry.hidden = state !== 'error';
    };
    setPreviewState('loading', '正在加载预览…');
    const fail = () => setPreviewState('error', '预览失败：素材不可读取、编码不支持或转码服务不可用。可重试预览。');
    const playCurrent = () => {
      if (!isCurrent()) return;
      setPreviewState('ready', fallbackUsed ? '转码预览已就绪' : '原生预览已就绪');
      video.play().catch((error) => {
        if (!isCurrent() || error.name === 'AbortError') return;
        if (error.name === 'NotAllowedError') setPreviewState('ready', '预览已就绪，请点击播放');
        else if (fallbackUsed) fail();
        else useClipFallback();
      });
    };

    const useClipFallback = () => {
      // mkv/avi/flv、编码不支持或素材已删：走服务端转码片段
      if (!isCurrent()) return;
      if (fallbackUsed) { fail(); return; }
      fallbackUsed = true;
      setPreviewState('transcoding', '正在请求转码预览…');
      video.onerror = fail;
      video.onseeked = null;
      video.ontimeupdate = null;
      previewOffsetFrame = startFrame;
      video.src = Api.clipUrl(match.video_path, startFrame, match.end_frame);
      video.onloadedmetadata = playCurrent;
    };

    if (item && item.fileURL && Bridge.isWebPlayable(item)) {
      setPreviewState('native', '正在加载源视频…');
      // 直接播源文件，秒开且不产生转码缓存
      video.src = item.fileURL;
      video.onerror = useClipFallback;
      video.onloadedmetadata = () => {
        if (!isCurrent()) return;
        if (Math.abs(video.currentTime - startSec) < 0.04) playCurrent();
        else {
          // 只在初次定位后自动播放；用户暂停选帧时，后续 seek 不应重新播放。
          video.onseeked = () => { video.onseeked = null; playCurrent(); };
          video.currentTime = startSec;
        }
      };
      video.ontimeupdate = () => {
        if (isCurrent() && video.currentTime >= endSec) video.pause();
      };
    } else {
      useClipFallback();
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
      + `片段：${fmtTime(match.start)} – ${fmtTime(match.end)}（${match.duration_display || ''}）<br>`
      + `相似度：${Number(match.similarity).toFixed(2)}${hybridInfo}${mqList}`
      + (item ? '' : '<br><span style="color:var(--danger)">素材已不在 Eagle 库中</span>')
      + '<br><span class="hint-inline">←/→ 切换结果，Esc 收起</span>';
    el.btnLocate.disabled = !item;
    el.previewPanel.classList.remove('hidden');
  }

  function closePreview() {
    previewLoadToken += 1;
    activeMatch = null;
    activePos = -1;
    if (el.previewVideo) {
      el.previewVideo.pause();
      el.previewVideo.onloadedmetadata = null;
      el.previewVideo.onseeked = null;
      el.previewVideo.ontimeupdate = null;
      el.previewVideo.onerror = null;
      el.previewVideo.removeAttribute('src');
      el.previewVideo.removeAttribute('poster');
      el.previewVideo.load();
      el.previewPanel.classList.add('hidden');
    }
  }

  async function captureCover() {
    const token = previewLoadToken;
    const cover = await CoverFrame.capture(el.previewVideo, activeMatch, previewOffsetFrame);
    if (token !== previewLoadToken) throw new Error('预览素材已切换，请重新选择封面画面');
    return cover;
  }

  function stepPreviewFrame(direction) {
    const video = el.previewVideo;
    if (!activeMatch || video.readyState < 2 || video.seeking || video.error) {
      throw new Error('请等待视频加载或定位完成');
    }
    video.pause();
    video.onseeked = null;
    video.currentTime = CoverFrame.stepTime(video.currentTime, direction, Number(activeMatch.fps) || 25, video.duration);
  }

  /* ---------- 结果存档载入 ---------- */
  async function loadResults(matches, query, recipe = null, savedView = null, addedKeys = [], time = { mode: 'all' }) {
    if (busy) throw new Error('已有搜索正在进行，请稍候再打开主题');
    setBusy(true);
    try {
      const pathMap = await Bridge.refreshPathMap();
      const byId = new Map([...pathMap.values()].map((item) => [item.id, item]));
      lastMatches = (Array.isArray(matches) ? matches : []).map((match) => {
        const item = byId.get(match.eagleItemId);
        return item ? { ...match, video_path: item.filePath, video_name: item.name } : match;
      });
      lastQuery = query || '';
      lastRecipe = recipe;
      archiveTime = SearchRecipe.clone(time);
      newKeys = new Set(addedKeys);
      if (savedView) Object.assign(view, savedView);
      selectedIdx.clear();
      render();
      return lastMatches.length;
    } finally { setBusy(false); }
  }

  /* ---------- 供 plugin.js 取数据 ---------- */
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
    bindDom, run, runVisual, runHybrid, setView, findLibraryIndexes, loadResults,
    setVisualHandler, setSelectionHandler,
    getSelectedMatches, clearSelection, getAllMatches, getLastQuery, getActiveMatch,
    getRawMatches: () => lastMatches.slice(),
    getRecipe: () => lastRecipe && SearchRecipe.clone(lastRecipe),
    getView: () => ({ ...view }),
    replay, cancel, getPhase: () => phase, isBusy: () => busy,
    pausePreview() { closePreview(); stopHoverPreview(); },
    captureCover, stepPreviewFrame,
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
