/* 搜索 + 结果渲染（分批/分组/排序/过滤）+ 预览面板详情与键盘导航 + 勾选；媒体播放见 previewPlayer.js */
const Search = (() => {
  const CHUNK_SIZE = 60;        // 每批渲染的卡片数，滚动到底部续加（分组模式按组为粒度）
  const THUMB_CONCURRENCY = 6;  // 缩略图并发上限（服务端缓存未命中时需要 ffmpeg 抽帧）
  const PREVIEW_LEAD_IN_FRAMES = 2; // 跳过切点前两帧，避免转场/解码黑帧闪现

  let lastMatches = [];
  let lastQuery = '';           // 最近一次查询，供保存主题使用
  let lastRecipe = null;
  let newKeys = new Set();
  let archiveTime = { mode: 'all' };
  let archiveFilter = { query: '', source: 'all' };
  let sessionScope = { library: '', paths: null };
  const filterDefaults = { query: '', source: 'all', tags: '', orientation: 'all', maxDur: null,
    membership: 'all', videoLimit: 0, queryHits: 0 };
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
  let selectionAnchor = null;  // 最近一次普通点击或单项勾选，作为 Shift 范围起点。

  // 视图状态（过滤→排序→分组，均不修改 lastMatches 本体）
  const view = { sortBy: 'sim', minDur: 0, grouped: false };
  let displayList = [];         // 视图变换后的原始下标序列
  let groups = [];              // 分组模式：[{name, idxs:[原始下标...]}]
  let flatPtr = 0;              // 平铺模式已渲染到 displayList 的位置
  let groupPtr = 0;             // 分组模式已渲染的组数
  let activePos = -1;           // 当前预览项在 displayList 中的位置（键盘导航用）
  let activeMatch = null;
  let sentinelObserver = null;

  const el = {};
  // 悬停与预览面板的媒体加载、停滞恢复、逐帧由 PreviewPlayer 负责，共用同一个 el。
  const player = PreviewPlayer.create(el, { previewStartFrame: (m) => previewStartFrame(m) });
  const { stopHoverPreview } = player;

  /* ---------- 缩略图限流加载 ---------- */
  const ThumbLoader = (() => {
    const queue = [];
    const cache = new Map();
    const pending = new Map();
    const failed = new WeakMap();
    let maxEntries = 5000;
    let maxBytes = 128 * 1024 * 1024;
    let cacheBytes = 0;
    let active = 0;
    let generation = 0;
    let cacheGeneration = 0;

    function cachedSource(url) {
      const entry = cache.get(url);
      if (!entry) return null;
      cache.delete(url);
      cache.set(url, entry);
      return entry.source;
    }

    function remember(url, source) {
      // 保留原始压缩图片字节，不持有离屏 DOM/解码位图；按双字节字符串保守计费。
      const bytes = (url.length + source.length) * 2;
      if (!maxEntries || bytes > maxBytes) return;
      // 同时写入磁盘缓存，下次打开插件可不等搜索服务直接显示。
      if (typeof ThumbDiskCache !== 'undefined') ThumbDiskCache.write(url, source);
      if (cache.has(url)) cacheBytes -= cache.get(url).bytes;
      cache.delete(url);
      cache.set(url, { source, bytes });
      cacheBytes += bytes;
      trim();
    }

    function trim() {
      while (cache.size > maxEntries || cacheBytes > maxBytes) {
        const oldest = cache.keys().next().value;
        cacheBytes -= cache.get(oldest).bytes;
        cache.delete(oldest);
      }
    }

    async function readImage(url) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`预览图请求失败：${response.status}`);
        const blob = await response.blob();
        if (!blob.type.startsWith('image/')) throw new Error('预览图响应不是图片');
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.onabort = () => reject(new Error('预览图读取已取消'));
          reader.readAsDataURL(blob);
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    function pump() {
      while (active < THUMB_CONCURRENCY && queue.length) {
        // 入队发生在卡片插入 DOM 之前，不能用 isConnected 过滤；
        // 换一轮结果时 clear() 已清空队列，不会有陈旧请求。
        const { img, url, onError, token } = queue.shift();
        const cacheToken = cacheGeneration;
        active += 1;
        let settled = false;
        let source = cachedSource(url);
        let request = null;
        const done = (event) => {
          if (settled) return;
          settled = true;
          active -= 1;
          img.onload = null;
          img.onerror = null;
          if (event?.type === 'load') {
            img.style.visibility = '';
            delete img.dataset.thumbnailFailed;
            failed.delete(img);
          } else if (event?.type === 'error' && token === generation) {
            img.dataset.thumbnailFailed = 'true';
            failed.set(img, { url, onError });
          }
          if (event?.type === 'load' && source && cacheToken === cacheGeneration) remember(url, source);
          if (request && pending.get(url) === request) pending.delete(url);
          try { if (event?.type === 'error' && token === generation) onError?.(); } finally { pump(); }
        };
        img.onload = done;
        img.onerror = done;
        if (source) {
          img.src = source;
        } else if (maxEntries && maxBytes && /^https?:\/\//i.test(url)
            && typeof fetch === 'function' && typeof FileReader !== 'undefined') {
          request = pending.get(url);
          if (!request) {
            // 内存未命中时先读磁盘缓存，缺失或已失效再请求服务。
            request = typeof ThumbDiskCache !== 'undefined'
              ? ThumbDiskCache.read(url).then((data) => data || readImage(url))
              : readImage(url);
            pending.set(url, request);
          }
          request.then((data) => {
            source = data;
            img.src = data;
          }, () => {
            // 不支持 fetch/CORS 或服务暂时失败时沿用原生图片加载及已有回退。
            img.src = url;
          });
        } else {
          img.src = url;
        }
      }
    }

    return {
      configure(cfg) {
        maxEntries = cfg.thumbnailCacheMaxEntries ?? 5000;
        maxBytes = (cfg.thumbnailCacheMaxMB ?? 128) * 1024 * 1024;
        trim();
        if (typeof ThumbDiskCache !== 'undefined') ThumbDiskCache.configure(cfg);
      },
      load(img, url, onError) {
        img.style.visibility = 'hidden';
        delete img.dataset.thumbnailFailed;
        const source = cachedSource(url);
        if (source) {
          // 已确认能解码的数据直接显示，不等待懒加载观察器或网络队列。
          img.src = source;
          img.style.visibility = '';
          return;
        }
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
        // 已开始请求仍占并发槽位直到完成；保留缓存及在途共享请求供新页面复用。
        if (typeof LazyLoad !== 'undefined') {
          LazyLoad.clear();
        }
      },
      resetCache() {
        this.clear();
        cacheGeneration += 1;
        cache.clear(); pending.clear(); cacheBytes = 0;
      },
      retryFailed() {
        document.querySelectorAll('img[data-thumbnail-failed]').forEach((img) => {
          const request = failed.get(img);
          if (request) this.load(img, request.url, request.onError);
        });
      },
    };
  })();

  /* ---------- 悬停自动播放（小窗静音循环该片段，实现见 PreviewPlayer） ---------- */
  function startHoverPreview(box, m) {
    player.startHoverPreview(box, m, activeMatch === m);
  }

  function bindHover(box, m) {
    player.bindHover(box, m, (match) => activeMatch === match);
  }

  /* ---------- DOM 绑定 ---------- */
  function bindDom() {
    el.results = document.getElementById('results');
    el.emptyState = document.getElementById('empty-state');
    el.previewPanel = document.getElementById('preview-panel');
    el.previewVideo = document.getElementById('preview-video');
    el.previewInfo = document.getElementById('preview-info');
    el.btnLocate = document.getElementById('btn-locate');
    el.btnRevealAll = document.getElementById('btn-reveal-all');
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
    const previewItem = () => {
      const item = activeMatch && Bridge.itemForPath(activeMatch.video_path);
      if (!item) Dom.toast('这个素材已不在当前 Eagle 库中', true);
      return item;
    };
    el.btnLocate.addEventListener('click', async () => {
      const item = previewItem();
      if (!item) return;
      try {
        await Bridge.locateInEagle([item.id]);
      } catch (e) {
        Dom.toast(`打开所在文件夹失败：${e.message || e}`, true);
      }
    });
    el.btnRevealAll.addEventListener('click', async () => {
      const item = previewItem();
      if (!item) return;
      try {
        await Bridge.revealInAll(item.id);
      } catch (e) {
        Dom.toast(`在全部中显示失败：${e.message || e}`, true);
      }
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
    if (archiveFilter.minScore != null) {
      idxs = idxs.filter((i) => Number.isFinite(lastMatches[i].similarity) && lastMatches[i].similarity >= archiveFilter.minScore);
    }
    if (sessionScope.library === eagle.library.path && sessionScope.paths != null) {
      const paths = sessionScope.paths;
      idxs = idxs.filter((i) => paths.has(Bridge.normalizePath(lastMatches[i].video_path)));
    }
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
    if (archiveFilter.membership && archiveFilter.membership !== 'all') {
      idxs = topicMembership ? idxs.filter((i) =>
        Boolean(topicMembership(lastMatches[i])?.length) === (archiveFilter.membership === 'collected')) : [];
    }
    if (archiveFilter.queryHits > 0) idxs = idxs.filter((i) => {
      const queries = lastMatches[i].matched_queries;
      return Array.isArray(queries) && queries.length >= archiveFilter.queryHits;
    });
    if (archiveFilter.videoLimit > 0) {
      const counts = new Map();
      const best = idxs.slice().sort((a, b) => (lastMatches[b].similarity || 0) - (lastMatches[a].similarity || 0));
      const keep = new Set(best.filter((i) => {
        const match = lastMatches[i];
        const key = match.eagleItemId || Bridge.itemForPath(match.video_path)?.id || Bridge.normalizePath(match.video_path);
        const count = counts.get(key) || 0;
        counts.set(key, count + 1);
        return count < archiveFilter.videoLimit;
      }));
      idxs = idxs.filter((i) => keep.has(i));
    }
    const cmp = {
      continuation: (a, b) => (lastMatches[a].continuation_rank ?? Infinity) - (lastMatches[b].continuation_rank ?? Infinity),
      sim: (a, b) => (lastMatches[b].similarity || 0) - (lastMatches[a].similarity || 0)
        || Number(lastMatches[b].manualScore?.mode === 'top') - Number(lastMatches[a].manualScore?.mode === 'top'),
      dur: (a, b) => (lastMatches[b].duration_seconds || 0) - (lastMatches[a].duration_seconds || 0),
      name: (a, b) => String(lastMatches[a].video_name).localeCompare(String(lastMatches[b].video_name), 'zh')
        || lastMatches[a].start_frame - lastMatches[b].start_frame,
    }[view.sortBy] || null;
    if (cmp) idxs.sort(cmp);
    return idxs;
  }

  /* 运镜/景别快捷筛选：只列当前完整结果中素材已有的 analyze_shot 标签，点击切换标签筛选条件。 */
  const SHOT_TAG_PREFIXES = ['运镜:', '景别:'];
  function renderShotTagChips() {
    const box = document.getElementById('result-tag-chips');
    if (!box) return;
    const counts = new Map();
    const seenVideos = new Set();
    lastMatches.forEach((match) => {
      const key = Bridge.normalizePath(match.video_path);
      if (seenVideos.has(key)) return;
      seenVideos.add(key);
      (Bridge.itemForPath(match.video_path)?.tags || []).forEach((tag) => {
        tag = String(tag);
        if (SHOT_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix))) counts.set(tag, (counts.get(tag) || 0) + 1);
      });
    });
    const active = new Set(String(archiveFilter.tags || '').split(/[,，]/)
      .map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean));
    const tags = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
    box.classList.toggle('hidden', !tags.length);
    box.replaceChildren(...tags.map((tag) => Dom.h('button', {
      type: 'button', className: 'tag-chip', dataset: { tag },
      attrs: { 'aria-pressed': String(active.has(tag.toLocaleLowerCase())) },
      title: `${counts.get(tag)} 个视频带此标签，点击切换`,
    }, `${tag.replace(/^(运镜|景别):/, '')} ${counts.get(tag)}`)));
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

  function finishSearch(resp, query, recipe, filters) {
    if (!resp.ok || !resp.data || !resp.data.success) {
      const msg = (resp.data && resp.data.error) || `搜索失败（HTTP ${resp.status}）`;
      return { ok: false, message: msg };
    }
    lastQuery = query;
    if (recipe.payload?.continuation_review) {
      view.sortBy = 'continuation';
      document.getElementById('view-sort').value = 'continuation';
    } else if (view.sortBy === 'continuation') {
      view.sortBy = 'sim';
      document.getElementById('view-sort').value = 'sim';
    }
    if (recipe.refinement) {
      view.sortBy = 'sim';
      document.getElementById('view-sort').value = 'sim';
    }
    lastMatches = identifyMatches(resp.data.matches || []);
    archiveTime = SearchRecipe.clone(filters.time);
    archiveFilter = { ...filters.filter };
    lastRecipe = recipe;
    newKeys.clear();
    selectedIdx.clear(); // 勾选下标相对上一轮结果，跨搜索保留会让批量操作命中错误素材
    render();
    document.dispatchEvent(new CustomEvent('search-completed'));
    return { ok: true, count: displayList.length, extra: resp.data };
  }

  async function prepare(modelName) {
    const indices = await findLibraryIndexes(modelName, { withRevisions: true });
    if (indices.paths.length === 0) return null;
    const pathMap = await Bridge.refreshPathMap();
    return { ...indices, pathMap };
  }

  const NO_INDEX = { ok: false, message: '当前素材库还没有索引，请先点击「索引整个库」' };

  function identifyMatches(matches) {
    return matches.flatMap((match) => {
      const item = Bridge.itemForPath(match.video_path);
      if (!item || (match.eagleItemId && match.eagleItemId !== item.id)) return [];
      return [{ ...match, eagleItemId: item.id }];
    });
  }

  function refinementCandidates(refinement, pathMap) {
    if (!Array.isArray(refinement.scenes) || !Number.isFinite(refinement.weight)
        || refinement.weight < 0 || refinement.weight > 10) throw new Error('继续搜索的候选或权重无效');
    const byId = new Map([...pathMap.values()].map((item) => [item.id, item]));
    return refinement.scenes.flatMap((scene) => {
      if (typeof scene.video_path !== 'string' || !Number.isFinite(scene.similarity)
          || !Number.isInteger(scene.start_frame) || scene.start_frame < 0
          || !Number.isInteger(scene.end_frame) || scene.end_frame < scene.start_frame) {
        throw new Error('继续搜索的候选镜头无效，请从原结果重新搜索');
      }
      const item = scene.eagleItemId ? byId.get(scene.eagleItemId) : pathMap.get(Bridge.normalizePath(scene.video_path));
      if (!item) return [];
      return [{ ...scene, video_path: item.filePath }];
    });
  }

  function weightedScore(previous, current, weight) {
    if (weight === 0) return previous;
    if (weight === 10) return current;
    return (previous * (10 - weight) + current * weight) / 10;
  }

  function applyRefinement(matches, scenes, weight) {
    const find = ArchiveStore.sceneLookup(scenes);
    return identifyMatches(matches).flatMap((match) => {
      const index = find(match);
      if (index === undefined) return [];
      const previous = scenes[index].similarity;
      const current = match.similarity;
      if (!Number.isFinite(current)) throw new Error('搜索服务返回了无效分数');
      return [{ ...match, similarity: weightedScore(previous, current, weight),
        refinementScore: { previous, current } }];
    });
  }

  async function requestRecipe(recipe, context, signal, { quiet = false } = {}) {
    const phaseOf = quiet ? () => {} : setPhase;
    const snapshot = await prepare(recipe.config.modelName);
    if (signal?.aborted) { const error = new Error('已取消等待'); error.name = 'AbortError'; throw error; }
    if (!snapshot) throw new Error(NO_INDEX.message);
    const indices = snapshot.paths;
    if (SearchRecipe.normalize(recipe.library) !== SearchRecipe.normalize(eagle.library.path)) {
      throw new Error('素材库已切换，请重新搜索');
    }
    const scenes = recipe.refinement ? refinementCandidates(recipe.refinement, snapshot.pathMap) : null;
    if (scenes) {
      const paths = new Set(scenes.map((scene) => Bridge.normalizePath(scene.video_path)));
      context = { ...context, paths: new Set([...paths].filter((path) => context.paths == null || context.paths.has(path))) };
    }
    if (context.paths && context.paths.size === 0) {
      return { ok: true, data: { success: true, matches: [] } };
    }

    const payload = context.payload || recipe.payload;
    const cfg = SearchRecipe.options(recipe.config);
    // 加权前保留新词的完整分数，不能先按新词阈值丢掉上一轮的高分镜头。
    if (scenes) cfg.threshold = 0;
    const cacheParams = {
      kind: recipe.kind, query: recipe.query, payload, config: cfg,
      library: recipe.library, indexNames: indices,
      indexRevisions: snapshot.revisions,
      service: typeof Config.baseUrl === 'function' ? Config.baseUrl() : '',
      allowedVideoPaths: context.paths == null ? null : Array.from(context.paths),
    };
    // 旧服务没有索引版本时仍可搜索，但不可把同路径误当作未更新。
    const canCache = !payload?.continuation_review && snapshot.revisions.every((revision) => typeof revision === 'string' && revision.length > 0);
    let resp;
    if (canCache && typeof SearchCache !== 'undefined') {
      const cached = SearchCache.get(cacheParams);
      if (cached) {
        console.log('[搜索缓存] 命中缓存，跳过请求');
        phaseOf('从缓存加载结果…');
        resp = { ok: true, fromCache: true, data: { success: true, matches: cached } };
      }
    }

    if (!resp) {
      phaseOf('等待服务返回结果…');
      if (recipe.kind === 'visual') {
        resp = await Api.searchVisual(payload, indices, cfg.visualThreshold, context.paths, cfg, { signal });
      } else if (recipe.kind === 'hybrid') {
        resp = await Api.searchHybrid(recipe.query, payload, indices, cfg.threshold, context.paths, cfg, { signal });
      } else if (recipe.kind === 'feedback') {
        resp = await Api.searchFeedback(payload.feedback, indices, context.paths, cfg, { signal });
      } else if (recipe.kind === 'sequence') {
        resp = await Api.searchSequence(payload.sequence, indices, cfg.threshold, context.paths, cfg, { signal });
      } else {
        resp = await Api.search(recipe.query, indices, cfg.threshold, context.paths, cfg,
          { signal, aiPlan: payload?.aiPlan || null });
      }

      // 缓存原始新词分数；候选镜头交集与权重在命中缓存后也要重新计算。
      if (canCache && !signal?.aborted && typeof SearchCache !== 'undefined' && resp.ok && resp.data?.success && resp.data?.matches) {
        SearchCache.set(cacheParams, resp.data.matches);
        console.log('[搜索缓存] 已缓存结果');
      }
    }
    if (scenes && resp.ok && resp.data?.success) {
      const matches = applyRefinement(resp.data.matches || [], scenes, recipe.refinement.weight)
        .filter((match) => match.similarity >= (recipe.config.threshold ?? 0));
      return { ...resp, data: { ...resp.data, matches } };
    }

    return resp;
  }

  async function runCaptured(kind, query, payload, context, threshold, refinement = null) {
    if (busy) return { ok: false, message: '已有搜索正在进行，请稍候' };
    const generation = ++requestGeneration;
    const controller = new AbortController();
    activeRequest = controller;
    setBusy(true);
    setPhase('准备搜索范围…');
    try {
      const recipe = SearchRecipe.capture(kind, query, payload, context, threshold);
      if (refinement) recipe.refinement = refinement;
      const standalone = document.body.dataset.topic !== 'true';
      const filters = { time: context.time || { mode: 'all' },
        filter: { ...(standalone && !refinement ? archiveFilter : { query: '', source: 'all' }),
          minScore: kind === 'text' ? recipe.config.threshold || null : null } };
      if (standalone && !refinement) {
        archiveTime = SearchRecipe.clone(filters.time);
        archiveFilter = { ...filters.filter };
      }
      // 新搜索保留全库候选；显示条件不进入请求和缓存键，主题更新仍按原 recipe 重放。
      const request = { ...recipe, config: { ...recipe.config, ...(kind === 'text' ? { threshold: 0 } : {}) } };
      const started = Date.now();
      const resp = await requestRecipe(request, { ...context, paths: null }, controller.signal);
      const latencyMs = Date.now() - started;
      // 归属读取失败不作废搜索结果；列表显示读取状态，可在筛选菜单中重试。
      if (archiveFilter.membership && archiveFilter.membership !== 'all') {
        await TopicRelations.ensure().catch((error) => { if (error.name !== 'AbortError') Dom.toast(error.message, true); });
      }
      if (generation !== requestGeneration) return { ok: false, cancelled: true, stale: true };
      if (SearchRecipe.normalize(recipe.library) !== SearchRecipe.normalize(eagle.library.path)) {
        throw new Error('素材库已切换，已忽略旧搜索结果');
      }
      setPhase('渲染结果…');
      const result = finishSearch(resp, query, recipe, standalone && !refinement ? { time: archiveTime, filter: archiveFilter } : filters);
      // 评测记录与性能诊断订阅：耗时为请求往返（含缓存命中），不含渲染。
      if (result.ok && typeof CustomEvent === 'function') {
        document.dispatchEvent?.(new CustomEvent('search-complete', { detail: {
          recipe: SearchRecipe.clone(recipe), latencyMs, fromCache: !!resp.fromCache,
          timings: resp.data?.timings || null, library: recipe.library } }));
      }
      return result;
    } catch (error) {
      if (generation !== requestGeneration || error.name === 'AbortError') return { ok: false, cancelled: true, stale: generation !== requestGeneration };
      throw error;
    } finally {
      if (generation === requestGeneration) { activeRequest = null; setPhase(''); setBusy(false); }
    }
  }

  // aiPlan：搜索前确认的 AI 改写计划，存入 recipe.payload，主题更新时按同一计划重放。
  function run(query, threshold, context, aiPlan = null) {
    return runCaptured('text', query, aiPlan ? { aiPlan } : null, context, threshold);
  }

  async function refine(query, threshold, context, source, weight) {
    if (SearchRecipe.normalize(source.library) !== SearchRecipe.normalize(eagle.library.path)) {
      throw new Error('素材库已切换，请重新打开原结果');
    }
    if (!source.matches.length) throw new Error('当前筛选下没有可继续搜索的镜头');
    const scenes = source.matches.map((match) => ({ video_path: match.video_path,
      eagleItemId: match.eagleItemId || Bridge.itemForPath(match.video_path)?.id,
      start_frame: match.original_start_frame ?? match.start_frame,
      end_frame: match.original_end_frame ?? match.end_frame, similarity: match.similarity }));
    return runCaptured('text', query, null, { ...context,
      config: { ...context.config, modelName: source.modelName || context.config.modelName } }, threshold,
    { label: source.label, scenes, weight });
  }

  function setRefinementWeight(weight) {
    if (busy) throw new Error('搜索中暂不能调整权重');
    if (!lastRecipe?.refinement) return;
    if (!Number.isFinite(weight) || weight < 0 || weight > 10) throw new Error('权重应为 0～10');
    lastMatches = lastMatches.map((match) => {
      if (!match.refinementScore || match.manualScore) return match;
      const { previous, current } = match.refinementScore;
      if (!Number.isFinite(previous) || !Number.isFinite(current)) throw new Error('已存镜头的权重分数无效，请更新主题后再调整');
      return { ...match, similarity: weightedScore(previous, current, weight) };
    });
    lastRecipe = { ...lastRecipe, refinement: { ...lastRecipe.refinement, weight } };
    render();
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

  /* 正负样本反馈：examples = { positives, negatives, negativeWeight }，片段用原始帧边界与素材 ID 固定。 */
  function exampleFromMatch(match) {
    return { video_path: match.video_path,
      itemId: match.eagleItemId || Bridge.itemForPath(match.video_path)?.id || null,
      start_frame: match.original_start_frame ?? match.start_frame,
      end_frame: match.original_end_frame ?? match.end_frame };
  }

  function runFeedback(examples, context, label) {
    if (!examples.positives?.length) throw new Error('至少需要一个正例片段');
    if (examples.positives.length > 50 || (examples.negatives?.length || 0) > 50) throw new Error('正例、负例各最多 50 个片段');
    return runCaptured('feedback', label, { feedback: examples }, context);
  }

  /* 时序组合：sequence = { steps: [2～4 个文本], maxGap: 秒 }；每步阈值由服务端按当前阈值过滤。 */
  function runSequence(sequence, context, threshold) {
    return runCaptured('sequence', sequence.steps.join(' → '), { sequence }, context, threshold);
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

  /* 新素材探测：按主题已存条件只在 candidatePaths（新加入的视频）内重放，只返回候选，不改变显示或写入主题。 */
  async function probe(recipe, candidatePaths, { signal: backgroundSignal } = {}) {
    if (busy) throw new Error('已有搜索正在进行，请稍候');
    // 后台探测：不占用搜索忙碌状态、不显示阶段文字，用户开始任何搜索时由调用方中止。
    if (backgroundSignal) {
      const context = await SearchRecipe.resolve(recipe);
      const paths = new Set([...candidatePaths].filter((path) => context.paths == null || context.paths.has(path)));
      if (!paths.size) return { matches: [], candidates: 0 };
      const resp = await requestRecipe(recipe, { ...context, paths }, backgroundSignal, { quiet: true });
      if (backgroundSignal.aborted) { const error = new Error('已取消检查'); error.name = 'AbortError'; throw error; }
      if (!resp.ok || !resp.data?.success) throw new Error(resp.data?.error || '搜索失败');
      return { matches: identifyMatches(applyScope(resp.data.matches || [], paths)), candidates: paths.size };
    }
    const generation = ++requestGeneration;
    const controller = new AbortController();
    activeRequest = controller;
    setBusy(true);
    try {
      const context = await SearchRecipe.resolve(recipe);
      const paths = new Set([...candidatePaths].filter((path) => context.paths == null || context.paths.has(path)));
      if (!paths.size) return { matches: [], candidates: 0 };
      const resp = await requestRecipe(recipe, { ...context, paths }, controller.signal);
      if (generation !== requestGeneration || controller.signal.aborted) {
        const error = new Error('已取消检查'); error.name = 'AbortError'; throw error;
      }
      if (!resp.ok || !resp.data?.success) throw new Error(resp.data?.error || '搜索失败');
      return { matches: identifyMatches(applyScope(resp.data.matches || [], paths)), candidates: paths.size };
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
    selectionAnchor = idx;
    if (checked) selectedIdx.add(idx);
    else selectedIdx.delete(idx);
    pick.checked = checked;
    card.classList.toggle('selected', checked);
    notifySelection();
  }

  function selectRange(idx) {
    const end = displayList.indexOf(idx);
    const anchor = displayList.indexOf(selectionAnchor);
    if (end < 0) return;
    const start = anchor < 0 ? end : anchor;
    if (anchor < 0) selectionAnchor = idx;
    for (let pos = Math.min(start, end); pos <= Math.max(start, end); pos += 1) {
      selectedIdx.add(displayList[pos]);
    }
    el.results.querySelectorAll('.card').forEach((card) => {
      const checked = selectedIdx.has(Number(card.dataset.resultIndex));
      card.classList.toggle('selected', checked);
      card.querySelector('.pick').checked = checked;
    });
    notifySelection();
  }

  function buildCard(m, idx, pos) {
    const item = Bridge.itemForPath(m.video_path);
    const card = document.createElement('div');
    cardMatches.set(card, m);
    const initiallySelected = selectedIdx.has(idx);
    card.className = 'card' + (item ? '' : ' missing') + (initiallySelected ? ' selected' : '');
    card.dataset.sceneKey = String(ArchiveStore.sceneKey(m));
    card.dataset.resultIndex = String(idx);
    card.title = '左键单选；Ctrl+左键多选；Shift+左键连续多选；右键整理所选；双击预览';

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
    pick.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.shiftKey) selectRange(idx);
    });
    pick.addEventListener('change', () => {
      // Shift 点击已在 click 中更新整段，避免 change 重置范围起点。
      if (pick.checked !== selectedIdx.has(idx)) setCardSelection(idx, pick.checked, card, pick);
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
    card.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.shiftKey) e.preventDefault();
    });
    card.addEventListener('click', (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        selectRange(idx);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        setCardSelection(idx, !selectedIdx.has(idx), card, pick);
      } else {
        clearSelection();
        setCardSelection(idx, true, card, pick);
      }
    });
    card.addEventListener('dblclick', (e) => {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.target.closest('button, input')) openPreviewAt(pos);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!selectedIdx.has(idx)) {
        clearSelection();
        setCardSelection(idx, true, card, pick);
      }
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
    selectionAnchor = null;
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
    el.viewBar.classList.toggle('hidden', lastMatches.length === 0 && !lastRecipe?.refinement);
    const refinement = lastRecipe?.refinement;
    document.getElementById('result-refine-controls').classList.toggle('hidden', !refinement);
    if (refinement) {
      const chain = document.getElementById('result-search-chain');
      chain.textContent = `${refinement.label} → ${lastQuery}`;
      chain.title = chain.textContent;
      document.getElementById('result-refine-weight').value = refinement.weight;
      document.getElementById('result-refine-old').textContent = 10 - refinement.weight;
      document.getElementById('result-refine-new').textContent = refinement.weight;
    }
    if (el.localFilters) {
      el.localFilters.classList.remove('hidden');
      const values = { 'topic-scene-query': archiveFilter.query, 'topic-scene-source': archiveFilter.source,
        'result-tags': archiveFilter.tags || '', 'result-membership': archiveFilter.membership || 'all',
        'result-video-limit': archiveFilter.videoLimit || 0, 'result-query-hits': archiveFilter.queryHits || 0,
        'result-max-dur': archiveFilter.maxDur ?? '', 'topic-filter-threshold': archiveFilter.minScore ?? '' };
      Object.entries(values).forEach(([id, value]) => {
        const input = document.getElementById(id);
        if (input) input.value = value;
      });
      document.getElementById('result-filter-error').textContent = '';
      renderShotTagChips();
      const membershipStatus = document.getElementById('result-membership-status');
      if (membershipStatus) {
        membershipStatus.replaceChildren();
        if (archiveFilter.membership && archiveFilter.membership !== 'all' && !topicMembership) {
          membershipStatus.append(Dom.h('button', { type: 'button', text: `${topicMembershipStatus} · 重试`,
            onclick: () => TopicRelations.ensure().catch((error) => Dom.toast(error.message, true)) }));
        }
      }
    }
    const hasLocalFilter = archiveFilter.query.trim() || archiveFilter.source !== 'all'
      || archiveFilter.tags?.trim() || (archiveFilter.orientation || 'all') !== 'all' || archiveFilter.maxDur != null
      || archiveFilter.minScore != null || (archiveFilter.membership && archiveFilter.membership !== 'all')
      || archiveFilter.videoLimit > 0 || archiveFilter.queryHits > 0
      || (sessionScope.library === eagle.library.path && sessionScope.paths != null);
    document.getElementById('filter-active-indicator')?.classList.toggle('hidden', !hasLocalFilter && view.minDur <= 0 && archiveTime.mode === 'all');
    el.resultCount.textContent = view.minDur > 0 || archiveTime.mode !== 'all' || hasLocalFilter
      ? `${displayList.length}/${lastMatches.length} 条`
      : `${lastMatches.length} 条`;
    if (!has) {
      el.emptyState.innerHTML = archiveFilter.membership && archiveFilter.membership !== 'all' && !topicMembership
        ? `<p>${esc(topicMembershipStatus)}，请在筛选菜单中重试。</p>`
        : lastMatches.length > 0 && hasLocalFilter
        ? '<p>当前组合筛选下没有片段，可清除筛选或调整时间与片段时长。标签使用 Eagle 素材信息。</p>'
        : lastMatches.length > 0 && archiveTime.mode !== 'all'
        ? '<p>当前时间筛选下没有结果，可切回「不限时间」或调整时长。缺少加入 Eagle 时间的素材不参与时间筛选。</p>'
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
    // 没有标签时整段隐藏，不占行。
    box.closest('.inspector-tags-section')?.classList.toggle('hidden', !tags.length);
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

  /* 顶部预览的摘要胶囊：相似度/人工评分 + 所属主题（点击打开主题）。 */
  function renderPreviewSummary(topics, library) {
    const box = document.getElementById('preview-summary');
    if (!box) return;
    box.replaceChildren();
    if (!activeMatch) return;
    const score = document.createElement('span');
    score.className = 'preview-score';
    score.textContent = activeMatch.manualScore
      ? `人工 ${activeMatch.manualScore.value} 分` : `相似度 ${Number(activeMatch.similarity).toFixed(2)}`;
    box.appendChild(score);
    if (!topics) return;
    if (!topics.length) {
      const none = document.createElement('span');
      none.textContent = '未收录到主题';
      box.appendChild(none);
      return;
    }
    const shown = topics.slice(0, 3);
    shown.forEach((topic) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = `主题：${topic.name}`; button.title = `打开主题「${topic.name}」`;
      button.addEventListener('click', () => TopicRelations.openTopic(topic.id, library));
      box.appendChild(button);
    });
    if (topics.length > shown.length) {
      const more = document.createElement('span');
      more.textContent = `+${topics.length - shown.length}`;
      more.title = topics.slice(shown.length).map((topic) => topic.name).join('、');
      box.appendChild(more);
    }
  }

  function renderInspectorMembership() {
    const box = document.getElementById('preview-membership');
    if (!box) return;
    box.replaceChildren();
    if (!activeMatch) { renderPreviewSummary(null, null); return; }
    const topics = topicMembership?.(activeMatch);
    const library = eagle.library.path;
    renderPreviewSummary(topics, library);
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

  function openPreview(match) {
    const item = Bridge.itemForPath(match.video_path);
    const fps = match.fps || 25;
    const startSec = previewStartFrame(match) / fps;
    const endSec = match.end_frame / fps;
    // 取消上一轮加载并接管同源悬停播放器（含在途加载）。
    player.prepare(item);
    const changed = activeMatch !== match;
    activeMatch = match;
    document.dispatchEvent(new CustomEvent('preview-change'));
    // 封面复用已加载的卡片缩略图，否则用 Eagle 缩略图；已解码同源播放器由 PreviewPlayer 移除封面。
    const thumbnail = matchThumbnails.get(match);
    const poster = thumbnail?.complete && thumbnail.naturalWidth > 0 ? thumbnail.currentSrc || thumbnail.src : item?.thumbnailURL;
    player.start({ item, startSec, endSec, poster });

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
      + (item ? '' : '<br><span style="color:var(--danger)">素材已不在 Eagle 库中</span>');
    if (Number.isFinite(match.continuation_similarity)) {
      el.previewInfo.append(Dom.h('p', { text: `开头复核 ${match.continuation_similarity.toFixed(1)} · 原检索 ${Number(match.similarity || 0).toFixed(1)}` }));
    } else if (match.continuation_error) {
      el.previewInfo.append(Dom.h('p', { className: 'form-error', text: `开头复核失败：${match.continuation_error}` }));
    }
    const sequence = document.getElementById('preview-sequence');
    if (sequence) {
      const steps = Array.isArray(match.sequence) ? match.sequence : [];
      sequence.classList.toggle('hidden', !steps.length);
      sequence.replaceChildren(...steps.map((step, index) => Dom.h('button', {
        type: 'button', className: 'sequence-step',
        text: `${index + 1}. ${step.query} · ${(step.original_start_frame / fps).toFixed(1)}–${((step.original_end_frame + 1) / fps).toFixed(1)} 秒 · ${Number(step.similarity || 0).toFixed(1)}`,
        onclick: () => {
          if (activeMatch !== match || !item) return;
          player.prepare(item);
          player.start({ item, startSec: step.original_start_frame / fps, endSec: (step.original_end_frame + 1) / fps, poster });
        },
      })));
    }
    el.btnLocate.disabled = !item;
    if (el.btnRevealAll) el.btnRevealAll.disabled = !item;
    renderInspectorInfo(match, item);
    renderInspectorMembership();
    document.getElementById('inspector-empty')?.classList.add('hidden');
    el.results?.querySelectorAll('.card').forEach((card) => card.classList.toggle('preview-active', cardMatches.get(card) === match));
    el.previewPanel.classList.remove('hidden');
    if (changed && el.previewPanel.parentElement) el.previewPanel.parentElement.scrollTop = 0;
  }

  function closePreview() {
    player.close();
    activeMatch = null;
    activePos = -1;
    document.getElementById('inspector-empty')?.classList.remove('hidden');
    el.results?.querySelectorAll('.preview-active').forEach((card) => card.classList.remove('preview-active'));
    player.teardown();
    document.dispatchEvent(new CustomEvent('preview-change'));
  }

  function captureFrame() { return player.captureFrame(activeMatch); }

  function captureCover() { return captureFrame(); }

  function stepPreviewFrame(direction) { player.stepFrame(activeMatch, direction); }

  function getPreviewSourceFrame() { return player.sourceFrameAt(activeMatch); }

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
      threshold: document.getElementById('threshold').value,
      selected: [...selectedIdx],
      filter: { ...archiveFilter }, position: captureBrowsePosition(),
    };
  }

  function refreshTopicMembership(find, status = '主题归属…') {
    const changed = topicMembership !== find || topicMembershipStatus !== status;
    topicMembership = find;
    topicMembershipStatus = status;
    renderInspectorMembership();
    if (changed && archiveFilter.membership && archiveFilter.membership !== 'all') {
      // 归属更新后按新归属重排，同时回到原浏览位置。
      const position = captureBrowsePosition();
      render();
      restoreBrowsePosition(position).catch(() => {});
    }
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
    SearchRecipe.writeTime(archiveTime);
    const threshold = state?.threshold ?? archiveFilter.minScore ?? Config.get().threshold;
    document.getElementById('threshold').value = threshold;
    document.getElementById('threshold-val').textContent = threshold;
    selectedIdx = new Set(state?.selected || []);
    setPhase('');
    render();
  }

  function pruneMissingVideos(inventory) {
    ThumbLoader.resetCache();
    if (typeof ThumbDiskCache !== 'undefined') ThumbDiskCache.prune(inventory);
    const state = captureState();
    if (ArchiveStore.reconcileVideoReferences(state, inventory)) state.selected = [];
    restoreState(state);
  }

  async function loadResults(matches, query, recipe = null, savedView = null, addedKeys = [], time = { mode: 'all' }, filter = { query: '', source: 'all' }, options = {}) {
    if (options.shouldApply && !options.shouldApply()) return null;
    if (busy) throw new Error('已有搜索正在进行，请稍候再打开主题');
    const library = eagle.library.path;
    setBusy(true);
    try {
      const pathMap = await Bridge.refreshPathMap();
      if (filter.membership && filter.membership !== 'all') await TopicRelations.ensure().catch((error) => Dom.toast(error.message, true));
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
    selectionAnchor = null;
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
    bindDom, run, refine, setRefinementWeight, runVisual, runFeedback, runSequence, exampleFromMatch, runFrameText, runHybrid, setView, findLibraryIndexes, loadResults, captureState, restoreState, pruneMissingVideos,
    configureThumbnailCache: (cfg) => ThumbLoader.configure(cfg),
    retryThumbnails: () => ThumbLoader.retryFailed(),
    clearThumbnailCache() { ThumbLoader.resetCache(); render(); },
    setSelectionHandler, replaceResults, captureBrowsePosition, restoreBrowsePosition, refreshTopicMembership,
    getSelectedMatches, clearSelection, getAllMatches, getLastQuery, getActiveMatch, openPreviewByKey,
    refreshTags() { renderShotTagChips(); if (activeMatch) renderPreviewTags(activeMatch); },
    hasResults: () => displayList.length > 0,
    getRawMatches: () => lastMatches.slice(),
    getRecipe: () => lastRecipe && SearchRecipe.clone(lastRecipe),
    getView: () => ({ ...view }),
    getArchiveFilter: () => ({ ...archiveFilter }),
    getArchiveTime: () => SearchRecipe.clone(archiveTime),
    setScopeFilter(paths, library) {
      sessionScope = { library, paths: paths == null ? null : new Set(paths) };
      render();
    },
    setArchiveFilter(filter) {
      filter = { ...filterDefaults, ...filter };
      if (!['all', 'manual', 'auto'].includes(filter.source) || typeof filter.query !== 'string'
          || typeof filter.tags !== 'string' || !['all', 'landscape', 'portrait', 'square', 'unknown'].includes(filter.orientation)
          || (filter.maxDur !== null && (!Number.isFinite(filter.maxDur) || filter.maxDur < 0))) throw new Error('片段查找条件无效');
      if (!['all', 'collected', 'uncollected'].includes(filter.membership)
          || ![0, 1, 3, 5].includes(filter.videoLimit) || !Number.isInteger(filter.queryHits)
          || filter.queryHits < 0 || filter.queryHits > 8) throw new Error('片段筛选条件无效');
      if (filter.maxDur !== null && filter.maxDur < view.minDur) throw new Error('片段时长上限不能小于下限');
      if (filter.minScore != null && (!Number.isFinite(filter.minScore) || filter.minScore < 0)) throw new Error('请输入有效的非负阈值');
      if (filter.scopePaths != null && (!Array.isArray(filter.scopePaths) || !filter.scopePaths.every((path) => typeof path === 'string'))) throw new Error('文件夹范围无效');
      if (JSON.stringify(archiveFilter) === JSON.stringify(filter)) return;
      archiveFilter = filter;
      render();
    },
    replay, probe, cancel, getPhase: () => phase, isBusy: () => busy,
    pausePreview() { closePreview(); stopHoverPreview(); },
    captureCover, captureFrame, stepPreviewFrame, getPreviewSourceFrame,
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
