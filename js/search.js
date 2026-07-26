/* 搜索 + 结果渲染（分批/分组/排序/过滤）+ 悬停自动播放 + 预览键盘导航 + 勾选导出 */
const Search = (() => {
  const CHUNK_SIZE = 60;        // 每批渲染的卡片数，滚动到底部续加（分组模式按组为粒度）
  const THUMB_CONCURRENCY = 6;  // 缩略图并发上限（每张图都是服务端一次 ffmpeg 抽帧进程）
  const HOVER_DELAY_MS = 260;   // 悬停多少毫秒后开始播放，避免扫过误触发

  let lastMatches = [];
  let lastQuery = '';           // 最近一次查询，供导出目录名/打标签使用
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
  let sentinelObserver = null;

  const el = {};

  /* ---------- 缩略图限流加载 ---------- */
  const ThumbLoader = (() => {
    const queue = [];
    let active = 0;

    function pump() {
      while (active < THUMB_CONCURRENCY && queue.length) {
        // 入队发生在卡片插入 DOM 之前，不能用 isConnected 过滤；
        // 换一轮结果时 clear() 已清空队列，不会有陈旧请求。
        const { img, url } = queue.shift();
        active += 1;
        const done = () => {
          active -= 1;
          img.onload = null;
          img.onerror = null;
          pump();
        };
        img.onload = done;
        img.onerror = done;
        img.src = url;
      }
    }

    return {
      load(img, url) {
        queue.push({ img, url });
        pump();
      },
      clear() {
        queue.length = 0;
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
    const startSec = m.start_frame / fps;
    const endSec = Math.max(m.end_frame / fps, startSec + 0.2);

    const v = document.createElement('video');
    v.className = 'hover-video';
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.src = item.fileURL;
    v.onloadedmetadata = () => {
      v.currentTime = startSec;
      v.play().catch(() => {});
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
    el.btnSelectAll = document.getElementById('btn-select-all-results');
    el.viewBar = document.getElementById('view-bar');
    el.resultCount = document.getElementById('result-count');
    el.timeline = document.getElementById('preview-timeline');
    el.dragArea = document.getElementById('drag-area');

    el.btnClosePreview.addEventListener('click', closePreview);
    el.btnLocate.addEventListener('click', async () => {
      const item = activeMatch && Bridge.itemForPath(activeMatch.video_path);
      if (item) await Bridge.locateInEagle([item.id]);
    });
    el.btnSelectAll.addEventListener('click', async () => {
      const ids = [...new Set(
        lastMatches.map((m) => Bridge.itemForPath(m.video_path)).filter(Boolean).map((it) => it.id)
      )];
      if (ids.length) await Bridge.locateInEagle(ids);
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
  async function findLibraryIndexes() {
    const cfg = Config.get();
    const prefix = `${Bridge.indexNameForLibrary()}_`;
    const indexes = await Api.listIndexes();
    return indexes
      .filter((ix) => ix.model === cfg.modelName && ix.name.startsWith(prefix))
      .map((ix) => ix.path);
  }

  /* scopeSet 非空时只保留路径在集合内的结果（限定选中文件夹搜索） */
  function applyScope(matches, scopeSet) {
    if (!scopeSet) return matches;
    return matches.filter((m) => scopeSet.has(Bridge.normalizePath(m.video_path)));
  }

  function finishSearch(resp, scopeSet, query) {
    if (!resp.ok || !resp.data || !resp.data.success) {
      const msg = (resp.data && resp.data.error) || `搜索失败（HTTP ${resp.status}）`;
      return { ok: false, message: msg };
    }
    lastQuery = query;
    lastMatches = applyScope(resp.data.matches || [], scopeSet);
    render();
    return { ok: true, count: lastMatches.length, extra: resp.data };
  }

  async function prepare() {
    const indices = await findLibraryIndexes();
    if (indices.length === 0) return null;
    await Bridge.refreshPathMap();
    return indices;
  }

  const NO_INDEX = { ok: false, message: '当前素材库还没有索引，请先点击「索引整个库」' };

  async function run(query, threshold, scopeSet = null) {
    const indices = await prepare();
    if (!indices) return NO_INDEX;
    return finishSearch(await Api.search(query, indices, threshold), scopeSet, query);
  }

  async function runVisual(payload, scopeSet = null, label = '') {
    const indices = await prepare();
    if (!indices) return NO_INDEX;
    const resp = await Api.searchVisual(payload, indices, Config.get().visualThreshold);
    return finishSearch(resp, scopeSet, label || '视觉搜索');
  }

  /* 混合检索：文本提示词 × 视觉片段 融合（生成提示词搜索用） */
  async function runHybrid(query, payload, scopeSet = null) {
    const indices = await prepare();
    if (!indices) return NO_INDEX;
    const resp = await Api.searchHybrid(query, payload, indices);
    return finishSearch(resp, scopeSet, query);
  }

  /* ---------- 渲染 ---------- */
  function fmtTime(t) {
    return String(t || '').replace(/\.\d+$/, '');
  }

  /* 视频头几帧可能是黑场/解码异常，缩略图从第 3 帧开始取（不超过场景尾帧） */
  function thumbFrame(m) {
    return Math.min(Math.max(m.start_frame, 3), m.end_frame);
  }

  function notifySelection() {
    selectionHandler?.(selectedIdx.size, lastMatches.length);
  }

  function buildCard(m, idx, pos) {
    const item = Bridge.itemForPath(m.video_path);
    const card = document.createElement('div');
    card.className = 'card' + (item ? '' : ' missing');

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
    pick.title = '勾选后可批量导出/打标签';
    pick.checked = selectedIdx.has(idx);
    pick.addEventListener('click', (e) => e.stopPropagation());
    pick.addEventListener('change', () => {
      if (pick.checked) selectedIdx.add(idx);
      else selectedIdx.delete(idx);
      notifySelection();
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
    sub.innerHTML = `<span>${fmtTime(m.start)} – ${fmtTime(m.end)}</span>`
      + `<span>${badge}<span class="sim">${Number(m.similarity).toFixed(1)}</span></span>`;
    meta.appendChild(name);
    meta.appendChild(sub);
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
    return card;
  }

  function buildGroup(g, startPos) {
    const details = document.createElement('details');
    details.className = 'vgroup';
    details.open = true;
    const summary = document.createElement('summary');
    const best = Number(lastMatches[g.idxs[0]].similarity || 0).toFixed(1);
    summary.innerHTML = `<b>${g.name}</b><span class="vgroup-info">${g.idxs.length} 个场景 · 最高 ${best}</span>`;
    const body = document.createElement('div');
    body.className = 'vgroup-body';
    g.idxs.forEach((idx, i) => {
      body.appendChild(buildCard(lastMatches[idx], idx, startPos + i));
    });
    details.appendChild(summary);
    details.appendChild(body);
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
    el.results.innerHTML = '';
    el.results.classList.toggle('grouped', view.grouped);
    flatPtr = 0;
    groupPtr = 0;
    notifySelection();

    const has = displayList.length > 0;
    el.emptyState.classList.toggle('hidden', has);
    el.btnSelectAll.classList.toggle('hidden', !has);
    el.viewBar.classList.toggle('hidden', lastMatches.length === 0);
    el.resultCount.textContent = view.minDur > 0
      ? `${displayList.length}/${lastMatches.length} 条`
      : `${lastMatches.length} 条`;
    if (!has) {
      el.emptyState.innerHTML = lastMatches.length > 0
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

  /* ---------- 预览面板：拖拽片段到剪辑软件 ---------- */
  function renderDragArea(match) {
    const area = el.dragArea;
    area.innerHTML = '';
    const prepare = document.createElement('button');
    prepare.textContent = '准备拖拽片段';
    prepare.title = '把这个片段切成 H.264 文件（有缓存），之后可直接拖进 PR/剪映等剪辑软件';
    prepare.addEventListener('click', async () => {
      prepare.disabled = true;
      prepare.textContent = '切割中…';
      try {
        const resp = await Api.clipFile(match.video_path, match.start_frame, match.end_frame);
        if (!resp.ok || !resp.data || !resp.data.success) {
          prepare.textContent = '准备拖拽片段';
          prepare.disabled = false;
          alert((resp.data && resp.data.error) || '切割失败');
          return;
        }
        const clipPath = resp.data.path;
        area.innerHTML = '';

        const chip = document.createElement('div');
        chip.className = 'drag-chip';
        chip.textContent = '🎬 拖到剪辑软件';
        chip.title = clipPath;

        const note = document.createElement('span');
        note.className = 'drag-note';

        const dragFail = (err) => {
          console.error('[Drag] startDrag 失败', err);
          note.textContent = '拖拽不可用，已打开文件夹，请从资源管理器拖入';
          eagle.shell.showItemInFolder(clipPath);
        };

        const nativeDrag = () => {
          try {
            if (eagle.drag && typeof eagle.drag.startDrag === 'function') {
              const r = eagle.drag.startDrag([clipPath]);
              if (r && typeof r.catch === 'function') r.catch(dragFail);
            } else {
              dragFail(new Error('当前 Eagle 版本无 eagle.drag API'));
            }
          } catch (err) {
            dragFail(err);
          }
        };

        // 主路径：mousedown + 位移阈值直接触发原生拖拽（HTML5 dragstart 在部分
        // Electron 环境里不触发 startDrag，改为手动判定拖动意图更可靠）
        chip.addEventListener('mousedown', (downEv) => {
          if (downEv.button !== 0) return;
          const startX = downEv.clientX;
          const startY = downEv.clientY;
          let fired = false;
          const onMove = (mv) => {
            if (fired) return;
            if (Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY) > 3) {
              fired = true;
              cleanup();
              nativeDrag();
            }
          };
          const cleanup = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', cleanup);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', cleanup);
        });
        // 备份路径：环境支持 HTML5 drag 时也能走
        chip.draggable = true;
        chip.addEventListener('dragstart', (e) => {
          e.preventDefault();
          nativeDrag();
        });

        const reveal = document.createElement('button');
        reveal.textContent = '在文件夹显示';
        reveal.addEventListener('click', () => eagle.shell.showItemInFolder(clipPath));

        area.appendChild(chip);
        area.appendChild(reveal);
        area.appendChild(note);
      } catch (e) {
        prepare.textContent = '准备拖拽片段';
        prepare.disabled = false;
        console.error(e);
      }
    });
    area.appendChild(prepare);
  }

  /* ---------- 点击预览（支持 ←/→ 键盘切换）---------- */
  function openPreviewAt(pos) {
    if (pos < 0 || pos >= displayList.length) return;
    activePos = pos;
    const match = lastMatches[displayList[pos]];
    openPreview(match);
    renderTimeline(match, pos);
    renderDragArea(match);
  }

  function openPreview(match) {
    stopHoverPreview();
    activeMatch = match;
    const item = Bridge.itemForPath(match.video_path);
    const fps = match.fps || 25;
    const startSec = match.start_frame / fps;
    const endSec = match.end_frame / fps;

    const video = el.previewVideo;
    video.onloadedmetadata = null;
    video.ontimeupdate = null;
    video.onerror = null;
    video.pause();

    const useClipFallback = () => {
      // mkv/avi/flv、编码不支持或素材已删：走服务端转码片段
      video.onerror = null;
      video.ontimeupdate = null;
      video.src = Api.clipUrl(match.video_path, match.start_frame, match.end_frame);
      video.onloadedmetadata = () => video.play().catch(() => {});
    };

    if (item && item.fileURL && Bridge.isWebPlayable(item)) {
      // 直接播源文件，秒开且不产生转码缓存
      video.src = item.fileURL;
      video.onerror = useClipFallback;
      video.onloadedmetadata = () => {
        video.currentTime = startSec;
        video.play().catch(() => {});
      };
      video.ontimeupdate = () => {
        if (video.currentTime >= endSec) video.pause();
      };
    } else {
      useClipFallback();
    }

    const hybridInfo = match.both_hit
      ? '<br><span class="badge-both">双</span> 文本与视觉两路均命中'
      : '';
    el.previewInfo.innerHTML =
      `<b>${match.video_name}</b><br>`
      + `片段：${fmtTime(match.start)} – ${fmtTime(match.end)}（${match.duration_display || ''}）<br>`
      + `相似度：${Number(match.similarity).toFixed(2)}${hybridInfo}`
      + (item ? '' : '<br><span style="color:var(--danger)">素材已不在 Eagle 库中</span>')
      + '<br><span class="hint-inline">←/→ 切换结果，Esc 收起</span>';
    el.btnLocate.disabled = !item;
    el.previewPanel.classList.remove('hidden');
  }

  function closePreview() {
    activeMatch = null;
    activePos = -1;
    if (el.previewVideo) {
      el.previewVideo.pause();
      el.previewVideo.removeAttribute('src');
      el.previewVideo.load();
      el.previewPanel.classList.add('hidden');
    }
  }

  /* ---------- 结果存档载入 ---------- */
  async function loadResults(matches, query) {
    await Bridge.refreshPathMap();
    lastMatches = Array.isArray(matches) ? matches : [];
    lastQuery = query || '';
    render();
    return lastMatches.length;
  }

  /* ---------- 供 plugin.js 取数据 ---------- */
  function getSelectedMatches() {
    if (selectedIdx.size === 0) return null;
    return [...selectedIdx].sort((a, b) => a - b).map((i) => lastMatches[i]).filter(Boolean);
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
    getSelectedMatches, getAllMatches, getLastQuery, getActiveMatch,
    getRawMatches: () => lastMatches.slice(),
  };
})();
