/* 入口：初始化、主题、服务状态、事件接线 */
(() => {
  const $ = (id) => document.getElementById(id);
  let serviceOnline = false;

  function toast(message, isError = false, ms = 3500) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = document.createElement('div');
    t.className = 'toast' + (isError ? ' error' : '');
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function applyTheme() {
    const dark = typeof eagle.app.isDarkColors === 'function'
      ? eagle.app.isDarkColors()
      : true;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  let settingsAutoOpened = false;

  function setServiceStatus(state, message) {
    const wasOnline = serviceOnline;
    serviceOnline = state === 'online';
    $('service-dot').className = `dot ${state}`;
    $('service-text').textContent = message;
    updateButtons();
    if (serviceOnline && !wasOnline) refreshIndexHint();
    // 新机器上项目路径多半不对：首次检测到路径无效时自动弹出设置页引导配置
    if (state === 'offline' && !settingsAutoOpened
        && /项目路径无效|找不到便携 Python/.test(message)) {
      settingsAutoOpened = true;
      openSettings();
    }
  }

  function updateButtons() {
    const indexing = Indexer.isRunning();
    $('btn-search').disabled = !serviceOnline || indexing;
    $('btn-visual-selected').disabled = !serviceOnline || indexing;
    ['btn-index-all', 'btn-index-folder', 'btn-index-selected'].forEach((id) => {
      $(id).disabled = !serviceOnline || indexing;
    });
  }

  // ---------- 建索引 ----------
  async function startIndexing(mode) {
    const result = await Indexer.start(mode, {
      onProgress(status) {
        const pct = status.total > 0 ? Math.round((status.current / status.total) * 100) : 0;
        $('index-bar-fill').style.width = `${pct}%`;
        const queued = status.queued > 0 ? `（队列还有 ${status.queued} 个任务）` : '';
        $('index-progress-text').textContent =
          `${status.current}/${status.total}  ${status.current_video || '准备中…'}${queued}`;
      },
      onDone(status) {
        $('index-progress').classList.add('hidden');
        updateButtons();
        if (status.state === 'cancelled') {
          toast(`已停止索引（已完成 ${status.current}/${status.total}，已写入部分保留，再次点击可增量续跑）`, false, 5000);
        } else {
          toast(`索引完成：本次新增 ${status.total} 个视频`);
        }
        refreshIndexHint();
      },
      onError(message) {
        $('index-progress').classList.add('hidden');
        updateButtons();
        toast(`索引失败：${message}`, true, 6000);
      },
    });

    if (!result.started) {
      toast(result.message, true);
      return;
    }
    $('index-bar-fill').style.width = '0%';
    $('index-progress-text').textContent = `已提交 ${result.count} 个视频，等待任务开始…`;
    $('index-progress').classList.remove('hidden');
    updateButtons();
  }

  async function stopIndexing() {
    $('btn-stop-index').disabled = true;
    $('index-progress-text').textContent = '正在停止…（当前视频处理完后停止）';
    const r = await Indexer.cancel();
    $('btn-stop-index').disabled = false;
    if (!r.ok) toast(r.message, true);
  }

  // ---------- 搜索范围选择器（整库 / 跟随 Eagle 选中 / 指定文件夹，均递归子文件夹）----------
  let scopeDialogChecked = new Set(); // 对话框内当前勾选的文件夹 id

  function updateScopeButton() {
    const cfg = Config.get();
    const btn = $('btn-scope');
    if (cfg.scopeMode === 'selected') btn.textContent = '范围: 跟随 Eagle 选中';
    else if (cfg.scopeMode === 'custom') btn.textContent = `范围: ${cfg.scopeFolderIds.length} 个文件夹`;
    else btn.textContent = '范围: 整个库';
    btn.classList.toggle('scoped', cfg.scopeMode !== 'all');
  }

  /* 换库后自定义文件夹 id 失效，自动回退为整库 */
  function resetScopeIfLibraryChanged() {
    const cfg = Config.get();
    if (cfg.scopeMode === 'custom' && cfg.scopeLibrary
        && cfg.scopeLibrary !== eagle.library.path) {
      Config.save({ scopeMode: 'all', scopeFolderIds: [], scopeLibrary: '' });
    }
  }

  /* 把任意形状的文件夹树安全地打平成 [{id, name, depth, childCount}]：
     visited 防环、防重复；深度封顶，避免异常结构把行推到不可见位置 */
  function flattenFolderTree(roots) {
    const rows = [];
    const visited = new Set();
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object') return;
      const id = node.id || node.folderId;
      if (!id || visited.has(id)) return;
      visited.add(id);
      const children = Array.isArray(node.children) ? node.children : [];
      rows.push({
        id,
        name: node.name || node.title || '(未命名)',
        depth: Math.min(depth, 10),
        childCount: children.length,
      });
      children.forEach((c) => walk(c, depth + 1));
    };
    (roots || []).forEach((r) => walk(r, 0));
    return rows;
  }

  function renderFolderRows(rows, container) {
    rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'folder-row';
      row.style.paddingLeft = `${r.depth * 16}px`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = scopeDialogChecked.has(r.id);
      cb.addEventListener('change', () => {
        if (cb.checked) scopeDialogChecked.add(r.id);
        else scopeDialogChecked.delete(r.id);
        // 勾选任何文件夹即切到"指定文件夹"模式
        document.querySelector('input[name="scope-mode"][value="custom"]').checked = true;
      });
      const name = document.createElement('span');
      name.textContent = r.name + (r.childCount ? `（${r.childCount} 个子文件夹）` : '');
      name.title = r.name;
      row.appendChild(cb);
      row.appendChild(name);
      container.appendChild(row);
    });
  }

  async function openScopeDialog() {
    const cfg = Config.get();
    scopeDialogChecked = new Set(cfg.scopeFolderIds || []);
    document.querySelectorAll('input[name="scope-mode"]').forEach((r) => {
      r.checked = r.value === (cfg.scopeMode || 'all');
    });
    const tree = $('folder-tree');
    tree.innerHTML = '<p class="hint">读取文件夹列表…</p>';
    $('scope-dialog').showModal();
    try {
      const roots = await Bridge.getFolderTree();
      const rows = flattenFolderTree(roots);
      console.log(`[Scope] 顶层 ${roots.length} 个，打平后 ${rows.length} 个文件夹`);
      tree.innerHTML = '';
      if (rows.length === 0) {
        // 打平后为空说明返回结构完全对不上，把原始结构的关键信息亮出来便于排查
        const sample = roots.length ? Object.keys(roots[0]).join(', ') : '(空列表)';
        tree.innerHTML = `<p class="hint">没有读取到文件夹。原始返回 ${roots.length} 项，`
          + `首项字段: ${sample}</p>`;
        return;
      }
      renderFolderRows(rows, tree);
    } catch (e) {
      console.error('[Scope] 读取文件夹树失败', e);
      tree.innerHTML = `<p class="hint" style="color:var(--danger)">读取文件夹失败：${e.message}</p>`;
    }
  }

  function applyScopeDialog() {
    const mode = document.querySelector('input[name="scope-mode"]:checked')?.value || 'all';
    const ids = mode === 'custom' ? [...scopeDialogChecked] : [];
    if (mode === 'custom' && ids.length === 0) {
      toast('请先在列表中勾选至少一个文件夹', true);
      return;
    }
    Config.save({ scopeMode: mode, scopeFolderIds: ids, scopeLibrary: eagle.library.path });
    $('scope-dialog').close();
    updateScopeButton();
  }

  /* 按当前范围设置返回路径集合；整库返回 null（不过滤） */
  async function resolveSearchScope() {
    const cfg = Config.get();
    if (cfg.scopeMode === 'selected') {
      const scope = await Bridge.folderScopePathSet();
      if (scope === null) {
        throw new Error('范围是「跟随 Eagle 选中」，请先在 Eagle 中选中要搜索的文件夹');
      }
      if (scope.size === 0) {
        throw new Error('选中的文件夹（含子文件夹）内没有视频素材');
      }
      return scope;
    }
    if (cfg.scopeMode === 'custom') {
      const scope = await Bridge.pathSetFromFolderIds(cfg.scopeFolderIds);
      if (scope.size === 0) {
        throw new Error('指定的文件夹（含子文件夹）内没有视频素材，点「范围」重新选择');
      }
      return scope;
    }
    return null;
  }

  // ---------- 视觉检索（以图搜视频 / 以片搜片） ----------
  async function doVisualSearch(payload, label) {
    if (!serviceOnline || Indexer.isRunning()) {
      toast('搜索服务未就绪或正在建索引', true);
      return;
    }
    const btn = $('btn-search');
    btn.disabled = true;
    btn.textContent = '搜索中…';
    toast(`正在以${label}搜索相似场景…`);
    try {
      const scope = await resolveSearchScope();
      const r = await Search.runVisual(payload, scope, label);
      if (!r.ok) toast(r.message, true, 5000);
      else if (r.count === 0) toast('没有相似场景（可在设置中降低视觉阈值）');
      else toast(`找到 ${r.count} 个相似场景`);
    } catch (e) {
      console.error(e);
      toast(`搜索出错：${e.message}`, true, 5000);
    } finally {
      btn.textContent = '搜索';
      updateButtons();
    }
  }

  async function visualSearchFromSelection() {
    const items = await eagle.item.getSelected();
    const video = (items || []).find((it) => Bridge.isVideoItem(it));
    if (video) {
      await doVisualSearch({ video_path: video.filePath }, `素材「${video.name}」`);
      return;
    }
    const image = (items || []).find((it) => Bridge.isImageItem(it));
    if (image) {
      await doVisualSearch({ image_path: image.filePath }, `图片「${image.name}」`);
      return;
    }
    toast('请先在 Eagle 中选中一个视频或图片素材', true);
  }

  // ---------- 导出片段并导回 Eagle ----------
  function matchesForBatchAction() {
    const picked = Search.getSelectedMatches();
    if (picked) return { matches: picked, picked: true };
    const all = Search.getAllMatches();
    return { matches: all, picked: false };
  }

  async function exportSelected() {
    const { matches, picked } = matchesForBatchAction();
    if (matches.length === 0) return;
    if (!picked && matches.length > 50) {
      toast(`结果有 ${matches.length} 条，请先勾选要导出的片段（悬停卡片左上角勾选）`, true, 5000);
      return;
    }
    const query = Search.getLastQuery() || '语义搜索';
    const btn = $('btn-export');
    btn.disabled = true;
    btn.textContent = `导出中 0/${matches.length}…`;
    try {
      const resp = await Api.exportClips(matches, query);
      const data = resp.data;
      if (!resp.ok || !data || !data.success) {
        toast((data && data.error) || `导出失败（HTTP ${resp.status}）`, true, 6000);
        return;
      }
      const files = data.exported_files || [];
      btn.textContent = `导入 Eagle 0/${files.length}…`;
      const folderId = await Bridge.findOrCreateFolder(`语义搜索_${query}`.slice(0, 60));
      let imported = 0;
      for (const f of files) {
        try {
          await eagle.item.addFromPath(f.output_path, {
            name: f.filename.replace(/\.[^.]+$/, ''),
            tags: [query],
            folders: [folderId],
            annotation: `来源: ${f.video_path}\n片段: ${f.start || ''} – ${f.end || ''}`,
          });
          imported += 1;
          btn.textContent = `导入 Eagle ${imported}/${files.length}…`;
        } catch (e) {
          console.error('导入失败', f.output_path, e);
        }
      }
      const failed = (data.errors || []).length;
      toast(`导出 ${data.exported_count} 个片段，已导入 Eagle 文件夹「语义搜索_${query}」${imported} 个`
        + (failed ? `（${failed} 个切割失败）` : ''), false, 6000);
      await eagle.folder.open(folderId).catch(() => {});
    } catch (e) {
      console.error(e);
      toast(`导出出错：${e.message}`, true, 6000);
    } finally {
      btn.textContent = '导出片段';
      btn.disabled = false;
      updateBatchButtons();
    }
  }

  // ---------- 给结果素材打标签 ----------
  async function tagResults() {
    const { matches } = matchesForBatchAction();
    const query = (Search.getLastQuery() || '').trim();
    if (!query || matches.length === 0) return;
    const items = new Map();
    matches.forEach((m) => {
      const item = Bridge.itemForPath(m.video_path);
      if (item) items.set(item.id, item);
    });
    let tagged = 0;
    for (const item of items.values()) {
      try {
        const tags = Array.isArray(item.tags) ? item.tags : [];
        if (!tags.includes(query)) {
          item.tags = [...tags, query];
          await item.save();
          tagged += 1;
        }
      } catch (e) {
        console.error('打标签失败', item.id, e);
      }
    }
    toast(`已给 ${tagged} 个素材打上标签「${query}」（${items.size - tagged} 个已有该标签）`);
  }

  // ---------- 视频内容 → 提示词 → 搜索 ----------
  async function describeAndSearch() {
    const m = Search.getActiveMatch();
    if (!m) return;
    if (!serviceOnline || Indexer.isRunning()) {
      toast('搜索服务未就绪或正在建索引', true);
      return;
    }
    const btn = $('btn-describe');
    btn.disabled = true;
    btn.textContent = '分析画面中…';
    toast('正在用视觉模型分析画面（首次需加载模型，约 20~40 秒）…', false, 8000);
    try {
      const resp = await Api.describe({
        video_path: m.video_path,
        start_frame: m.start_frame,
        end_frame: m.end_frame,
      });
      if (!resp.ok || !resp.data || !resp.data.success) {
        toast((resp.data && resp.data.error) || `分析失败（HTTP ${resp.status}）`, true, 6000);
        return;
      }
      const prompts = resp.data.prompts || [];
      if (prompts.length === 0) {
        toast('没有生成出可用的提示词', true);
        return;
      }
      // 混合检索：提示词文本 × 原片段视觉 两路融合，比单路更准
      $('query').value = prompts[0];
      prompts.slice(1).reverse().forEach((p) => pushHistory(p));
      pushHistory(prompts[0]);
      toast(`生成提示词：${prompts.join(' / ')}，正在做文本×视觉混合检索…`, false, 7000);
      const scope = await resolveSearchScope();
      const r = await Search.runHybrid(prompts[0], {
        video_path: m.video_path,
        start_frame: m.start_frame,
        end_frame: m.end_frame,
      }, scope);
      if (!r.ok) toast(r.message, true, 5000);
      else toast(`混合检索找到 ${r.count} 个场景（带「双」标的两路均命中，最可信）`, false, 6000);
    } catch (e) {
      console.error(e);
      toast(`分析出错：${e.message}`, true, 6000);
    } finally {
      btn.textContent = '生成提示词搜索';
      btn.disabled = false;
    }
  }

  // ---------- 搜索历史（自绘下拉，原生 datalist 在 Electron 里定位/收起有问题）----------
  function pushHistory(query) {
    const old = Config.get().history || [];
    const history = [query, ...old.filter((q) => q !== query)].slice(0, 20);
    Config.save({ history });
    renderHistory();
  }

  function historyPanelVisible() {
    return !$('history-panel').classList.contains('hidden');
  }

  function toggleHistoryPanel(show) {
    const panel = $('history-panel');
    const target = typeof show === 'boolean' ? show : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !target);
    if (target) renderHistory();
  }

  function renderHistory() {
    const panel = $('history-panel');
    panel.innerHTML = '';
    const history = Config.get().history || [];
    if (history.length === 0) {
      panel.innerHTML = '<div class="history-empty">还没有搜索历史</div>';
      return;
    }
    history.forEach((q) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const text = document.createElement('span');
      text.className = 'h-text';
      text.textContent = q;
      const del = document.createElement('button');
      del.className = 'h-del';
      del.textContent = '✕';
      del.title = '删除这条历史';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        Config.save({ history: (Config.get().history || []).filter((x) => x !== q) });
        renderHistory();
      });
      item.appendChild(text);
      item.appendChild(del);
      item.addEventListener('click', () => {
        $('query').value = q;
        toggleHistoryPanel(false);
        doSearch();
      });
      panel.appendChild(item);
    });
  }

  // ---------- 结果存档 ----------
  function savesDir() {
    const path = require('path');
    return path.join(Config.pluginPath(), 'saves');
  }

  function saveResults() {
    const matches = Search.getRawMatches();
    if (matches.length === 0) return;
    const fs = require('fs');
    const path = require('path');
    const query = Search.getLastQuery() || '未命名';
    try {
      fs.mkdirSync(savesDir(), { recursive: true });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const safe = query.replace(/[<>:"/\\|?*]/g, '_').slice(0, 40);
      const file = path.join(savesDir(), `${stamp}_${safe}.json`);
      fs.writeFileSync(file, JSON.stringify({
        savedAt: new Date().toISOString(),
        query,
        library: eagle.library.path,
        count: matches.length,
        matches,
      }), 'utf-8');
      toast(`已保存 ${matches.length} 条结果为存档「${query}」`);
    } catch (e) {
      toast(`保存失败：${e.message}`, true);
    }
  }

  function openArchives() {
    const fs = require('fs');
    const path = require('path');
    const list = $('archive-list');
    list.innerHTML = '';
    let files = [];
    try {
      fs.mkdirSync(savesDir(), { recursive: true });
      files = fs.readdirSync(savesDir()).filter((f) => f.endsWith('.json')).sort().reverse();
    } catch { /* 目录不可读则显示空态 */ }
    if (files.length === 0) {
      list.innerHTML = '<p class="hint">还没有存档。搜索后点视图栏的「存结果」保存。</p>';
    }
    files.forEach((f) => {
      const full = path.join(savesDir(), f);
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(full, 'utf-8'));
      } catch { return; }
      const row = document.createElement('div');
      row.className = 'archive-row';
      const date = (meta.savedAt || '').slice(0, 16).replace('T', ' ');
      row.innerHTML = `<span class="archive-name" title="${f}"><b>${meta.query || '未命名'}</b>`
        + ` · ${meta.count || (meta.matches || []).length} 条 · ${date}</span>`;
      const load = document.createElement('button');
      load.textContent = '载入';
      load.addEventListener('click', async () => {
        $('archive-dialog').close();
        $('query').value = meta.query || '';
        const n = await Search.loadResults(meta.matches || [], meta.query || '');
        toast(`已载入存档「${meta.query}」（${n} 条）`);
      });
      const del = document.createElement('button');
      del.textContent = '删除';
      del.addEventListener('click', () => {
        try { fs.unlinkSync(full); } catch { /* 已被删除 */ }
        row.remove();
      });
      row.appendChild(load);
      row.appendChild(del);
      list.appendChild(row);
    });
    $('archive-dialog').showModal();
  }

  // ---------- 提纯闭环：把视频交接给「视频自动提纯」插件 ----------
  async function sendToPurify() {
    const m = Search.getActiveMatch();
    if (!m) return;
    const item = Bridge.itemForPath(m.video_path);
    if (!item) {
      toast('素材已不在库中，无法提纯', true);
      return;
    }
    try {
      const fs = require('fs');
      const path = require('path');
      const inbox = path.join(Config.get().projectRoot, 'purify_inbox.json');
      let list = [];
      try {
        if (fs.existsSync(inbox)) list = JSON.parse(fs.readFileSync(inbox, 'utf-8')) || [];
      } catch { list = []; }
      if (!list.some((x) => x.id === item.id)) {
        list.push({
          id: item.id,
          name: item.name,
          filePath: item.filePath,
          folderId: Array.isArray(item.folders) && item.folders.length ? item.folders[0] : null,
        });
      }
      fs.writeFileSync(inbox, JSON.stringify(list, null, 2), 'utf-8');
      toast(`已发送「${item.name}」到提纯队列，打开「视频自动提纯」插件即可开始（可连发多个）`, false, 6000);
    } catch (e) {
      toast(`交接失败：${e.message}`, true);
    }
  }

  // ---------- 素材库统计 ----------
  function statsBar(label, count, max, extra = '') {
    const pct = max > 0 ? Math.max((count / max) * 100, 1.5) : 0;
    return `<div class="stat-row"><span class="stat-label" title="${label}">${label}</span>`
      + `<span class="stat-track"><span class="stat-fill" style="width:${pct}%"></span></span>`
      + `<span class="stat-num">${count}${extra}</span></div>`;
  }

  async function openStats() {
    const body = $('stats-body');
    body.innerHTML = '<p class="hint">统计中…</p>';
    $('stats-dialog').showModal();
    try {
      const videos = await Bridge.collectLibraryVideos();
      const total = videos.length;

      // 索引覆盖率
      let indexedCount = 0;
      if (serviceOnline) {
        const indices = await Search.findLibraryIndexes();
        const indexed = new Set();
        for (const p of indices) {
          (await Api.indexContents(p)).forEach((v) => indexed.add(Bridge.normalizePath(v)));
        }
        indexedCount = videos.filter((v) => indexed.has(Bridge.normalizePath(v.filePath))).length;
      }

      // 标签分布 + 提纯产出
      const tagCount = new Map();
      let purified = 0;
      videos.forEach((v) => {
        const tags = Array.isArray(v.tags) ? v.tags : [];
        tags.forEach((t) => tagCount.set(t, (tagCount.get(t) || 0) + 1));
        if (tags.includes('自动提纯')) purified += 1;
      });
      const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

      // 时长分布（Eagle 视频素材的 duration 单位为秒）
      const buckets = [
        ['0-2 秒', 0, 2], ['2-5 秒', 2, 5], ['5-15 秒', 5, 15],
        ['15-60 秒', 15, 60], ['1-5 分钟', 60, 300], ['>5 分钟', 300, Infinity],
      ];
      const durCounts = buckets.map(() => 0);
      let unknownDur = 0;
      videos.forEach((v) => {
        const d = Number(v.duration);
        if (!Number.isFinite(d) || d <= 0) { unknownDur += 1; return; }
        const i = buckets.findIndex(([, lo, hi]) => d >= lo && d < hi);
        if (i >= 0) durCounts[i] += 1;
      });

      const maxTag = topTags.length ? topTags[0][1] : 0;
      const maxDur = Math.max(...durCounts, 1);
      body.innerHTML = `
        <div class="stat-summary">
          视频素材 <b>${total}</b> 个 ·
          已索引 <b>${serviceOnline ? indexedCount : '?'}</b>（${serviceOnline && total ? Math.round(indexedCount / total * 100) : '?'}%） ·
          提纯产出片段 <b>${purified}</b> 个
        </div>
        <h4>时长分布${unknownDur ? `（${unknownDur} 个未知时长未计入）` : ''}</h4>
        ${buckets.map(([label], i) => statsBar(label, durCounts[i], maxDur)).join('')}
        <h4>标签 Top ${topTags.length}</h4>
        ${topTags.length ? topTags.map(([t, n]) => statsBar(t, n, maxTag)).join('')
          : '<p class="hint">还没有任何标签（提纯或打标签后这里会出现分布）</p>'}
      `;
    } catch (e) {
      body.innerHTML = `<p class="hint" style="color:var(--danger)">统计失败：${e.message}</p>`;
    }
  }

  // ---------- 索引迁移（导出/导入 zip） ----------
  function runPowerShell(args) {
    return new Promise((resolve, reject) => {
      const { execFile } = require('child_process');
      execFile('powershell.exe', ['-NoProfile', '-Command', args],
        { windowsHide: true }, (err, _out, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve();
        });
    });
  }

  async function exportIndexes() {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const src = path.join(Config.get().projectRoot, 'indexes');
    if (!fs.existsSync(src)) {
      toast('还没有任何索引可导出', true);
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const dest = path.join(os.homedir(), 'Desktop', `eagle_indexes_${stamp}.zip`);
    toast('正在打包索引（大库可能要几分钟）…', false, 8000);
    try {
      await runPowerShell(`Compress-Archive -Path "${src}\\*" -DestinationPath "${dest}" -Force`);
      toast(`已导出到桌面：${path.basename(dest)}`, false, 6000);
      eagle.shell.showItemInFolder(dest);
    } catch (e) {
      toast(`导出失败：${e.message}`, true, 6000);
    }
  }

  async function importIndexes() {
    const path = require('path');
    let zipPath = null;
    try {
      const r = await eagle.dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: '索引包', extensions: ['zip'] }],
      });
      zipPath = r && !r.canceled && r.filePaths && r.filePaths[0];
    } catch {
      toast('当前 Eagle 版本不支持文件选择对话框；请手动把 zip 解压到项目 indexes 目录', true, 7000);
      return;
    }
    if (!zipPath) return;
    const dest = path.join(Config.get().projectRoot, 'indexes');
    toast('正在导入索引…', false, 6000);
    try {
      await runPowerShell(`Expand-Archive -Path "${zipPath}" -DestinationPath "${dest}" -Force`);
      toast('索引导入完成', false, 5000);
      refreshIndexHint();
    } catch (e) {
      toast(`导入失败：${e.message}`, true, 6000);
    }
  }

  // ---------- 动态模型列表（模型升级通道：models/ 目录放入新模型即出现在下拉） ----------
  async function populateModelSelect() {
    const sel = $('cfg-model');
    try {
      const models = await Api.listModels();
      // 过滤掉非嵌入模型（重排/多模态大模型/工具目录）
      const embeddable = models.filter((m) =>
        !/reranker|minicpm|ffmpeg|shot_scale/i.test(m.name));
      if (embeddable.length === 0) return; // 保留静态选项
      const current = Config.get().modelName;
      sel.innerHTML = '';
      embeddable.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.name + (/fg-?clip2/i.test(m.name) ? '（中文，推荐）' : '');
        sel.appendChild(opt);
      });
      sel.value = embeddable.some((m) => m.name === current) ? current : embeddable[0].name;
    } catch { /* 服务不在线时保留静态选项 */ }
  }

  // ---------- 未索引提醒 / 静默自动索引 ----------
  async function countMissingVideos() {
    const videos = await Bridge.collectLibraryVideos();
    const indices = await Search.findLibraryIndexes();
    if (indices.length === 0) return videos.length;
    const indexed = new Set();
    for (const p of indices) {
      (await Api.indexContents(p)).forEach((v) => indexed.add(Bridge.normalizePath(v)));
    }
    return videos.filter((v) => !indexed.has(Bridge.normalizePath(v.filePath))).length;
  }

  async function refreshIndexHint() {
    if (!serviceOnline) return;
    const hint = $('index-hint');
    try {
      const missing = await countMissingVideos();
      hint.textContent = missing > 0 ? `${missing} 个新视频未索引` : '索引已同步';
      hint.classList.toggle('warn', missing > 0);
      if (missing > 0 && !Config.get().autoIndex) {
        toast(`发现 ${missing} 个视频尚未索引，点「索引整个库」增量补齐`, false, 5000);
      }
    } catch (e) {
      console.warn('索引对比失败', e);
    }
  }

  const AUTO_INDEX_INTERVAL_MS = 10 * 60 * 1000;
  let autoIndexTimer = null;

  async function autoIndexTick() {
    if (!Config.get().autoIndex || Indexer.isRunning()) return;
    try {
      if (!serviceOnline && !(await Service.ensure(setServiceStatus))) return;
      const missing = await countMissingVideos();
      if (missing > 0) {
        console.log(`[AutoIndex] 发现 ${missing} 个新视频，自动增量索引`);
        await startIndexing('all');
      }
    } catch (e) {
      console.warn('[AutoIndex] 检查失败', e);
    }
  }

  function applyAutoIndexSetting() {
    if (autoIndexTimer) {
      clearInterval(autoIndexTimer);
      autoIndexTimer = null;
    }
    if (Config.get().autoIndex) {
      autoIndexTimer = setInterval(autoIndexTick, AUTO_INDEX_INTERVAL_MS);
      autoIndexTick(); // 开启后立即检查一次
    }
  }

  function updateBatchButtons(selectedCount = 0, total = 0) {
    const has = total > 0 || Search.getAllMatches().length > 0;
    $('btn-export').classList.toggle('hidden', !has);
    $('btn-tag').classList.toggle('hidden', !has);
    if (has) {
      const n = selectedCount || 0;
      $('btn-export').textContent = n > 0 ? `导出片段(${n})` : '导出片段';
      $('btn-tag').textContent = n > 0 ? `打标签(${n})` : '打标签';
    }
  }

  /* Ctrl+V 粘贴图片 → 以图搜视频 */
  function handlePaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        e.preventDefault();
        const file = it.getAsFile();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => doVisualSearch({ image_base64: reader.result }, '剪贴板图片');
        reader.readAsDataURL(file);
        return;
      }
    }
  }

  // ---------- 搜索 ----------
  async function doSearch() {
    const query = $('query').value.trim();
    if (!query) return;
    const btn = $('btn-search');
    btn.disabled = true;
    btn.textContent = '搜索中…';
    try {
      const scope = await resolveSearchScope();
      const threshold = parseFloat($('threshold').value);
      Config.save({ threshold });
      const r = await Search.run(query, threshold, scope);
      if (!r.ok) toast(r.message, true, 5000);
      else if (r.count === 0) toast('没有匹配结果，可尝试降低阈值');
      else {
        toast(`找到 ${r.count} 个匹配场景`);
        pushHistory(query);
      }
    } catch (e) {
      console.error(e);
      toast(`搜索出错：${e.message}`, true, 5000);
    } finally {
      btn.textContent = '搜索';
      updateButtons();
    }
  }

  // ---------- 设置 ----------
  function openSettings() {
    const cfg = Config.get();
    populateModelSelect(); // 异步刷新模型下拉（models/ 目录有什么就列什么）
    $('cfg-project-root').value = cfg.projectRoot;
    $('cfg-port').value = cfg.port;
    $('cfg-model').value = cfg.modelName;
    $('cfg-visual-threshold').value = cfg.visualThreshold;
    $('cfg-visual-margin').value = cfg.visualMargin;
    $('cfg-visual-agg').value = cfg.visualAgg || 'mean';
    $('cfg-visual-centered').checked = !!cfg.visualCentered;
    $('cfg-visual-scene-frames').value = cfg.visualSceneFrames;
    $('cfg-visual-video-frames').value = cfg.visualVideoFrames;
    $('cfg-idx-sample-interval').value = cfg.indexSampleInterval;
    $('cfg-idx-resolution').value = cfg.indexResolution;
    $('cfg-idx-min-scene').value = cfg.indexMinSceneLen;
    $('cfg-idx-batch').value = cfg.indexBatchSize;
    $('cfg-idx-scene-threshold').value = cfg.indexSceneThreshold;
    $('cfg-idx-localmax').value = cfg.indexLocalmaxOrder;
    $('cfg-idx-fp16').checked = !!cfg.indexFp16;
    $('cfg-deepseek-key').value = cfg.deepseekKey || '';
    $('cfg-ai-enhance').checked = !!cfg.aiEnhance;
    $('cfg-dedup').checked = !!cfg.dedup;
    $('cfg-mini-rerank').checked = !!cfg.miniRerank;
    $('cfg-mini-keep').checked = !!cfg.miniKeepLoaded;
    $('cfg-auto-index').checked = !!cfg.autoIndex;
    $('settings-dialog').showModal();
  }

  async function rebuildIndex() {
    $('settings-dialog').close();
    toast('开始全量重建当前库索引（清理失效条目并应用当前索引参数）…', false, 5000);
    await startIndexing('rebuild');
  }

  function viewServiceLog() {
    const lp = Service.logPath();
    try {
      const fs = require('fs');
      if (!fs.existsSync(lp)) {
        toast('日志文件还不存在（服务由插件启动后才会产生日志）', true);
        return;
      }
      eagle.shell.openPath(lp);
    } catch (e) {
      toast(`打开日志失败：${e.message}`, true);
    }
  }

  async function restartService() {
    $('settings-dialog').close();
    setServiceStatus('starting', '正在重启搜索服务…');
    try {
      const resp = await Api.shutdown();
      if (!resp.ok && resp.data && resp.data.error) {
        toast(resp.data.error, true);
        setServiceStatus('online', '搜索服务已连接');
        return;
      }
    } catch { /* 服务本来就没起来，直接走启动流程 */ }
    await new Promise((r) => setTimeout(r, 2000));
    Service.ensure(setServiceStatus);
  }

  function saveSettings() {
    const prevModel = Config.get().modelName;
    const prevKey = Config.get().deepseekKey || '';
    const modelName = $('cfg-model').value;
    Config.save({
      deepseekKey: $('cfg-deepseek-key').value.trim(),
      projectRoot: $('cfg-project-root').value.trim(),
      port: parseInt($('cfg-port').value, 10) || 5006,
      modelName,
      visualThreshold: parseFloat($('cfg-visual-threshold').value) || 40,
      visualMargin: parseFloat($('cfg-visual-margin').value) || 15,
      visualAgg: $('cfg-visual-agg').value,
      visualCentered: $('cfg-visual-centered').checked,
      visualSceneFrames: parseInt($('cfg-visual-scene-frames').value, 10) || 5,
      visualVideoFrames: parseInt($('cfg-visual-video-frames').value, 10) || 8,
      indexSampleInterval: parseInt($('cfg-idx-sample-interval').value, 10) || 5,
      indexResolution: parseInt($('cfg-idx-resolution').value, 10) || 256,
      indexMinSceneLen: parseInt($('cfg-idx-min-scene').value, 10) || 7,
      indexBatchSize: parseInt($('cfg-idx-batch').value, 10) || 128,
      indexSceneThreshold: parseFloat($('cfg-idx-scene-threshold').value) || 0.85,
      indexLocalmaxOrder: parseInt($('cfg-idx-localmax').value, 10) || 2,
      indexFp16: $('cfg-idx-fp16').checked,
      aiEnhance: $('cfg-ai-enhance').checked,
      dedup: $('cfg-dedup').checked,
      miniRerank: $('cfg-mini-rerank').checked,
      miniKeepLoaded: $('cfg-mini-keep').checked,
      autoIndex: $('cfg-auto-index').checked,
    });
    applyAutoIndexSetting();
    if (modelName !== prevModel) {
      const suggested = modelName.includes('fg-clip2') ? 11 : 21;
      $('threshold').value = suggested;
      $('threshold-val').textContent = suggested;
      Config.save({ threshold: suggested });
      toast(`已切换模型，阈值建议调整为 ${suggested}，请对库重新建索引`);
    }
    if (Config.get().deepseekKey !== prevKey) {
      toast('DeepSeek Key 已更新，点击设置里的「重启搜索服务」后生效', false, 5000);
    }
    setServiceStatus('offline', '配置已更新，正在重新连接…');
    Service.ensure(setServiceStatus);
  }

  // ---------- 初始化 ----------
  function wireEvents() {
    $('btn-search').addEventListener('click', doSearch);
    $('query').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !$('btn-search').disabled) {
        toggleHistoryPanel(false);
        doSearch();
      } else if (e.key === 'ArrowDown' && !historyPanelVisible()) {
        toggleHistoryPanel(true);
      } else if (e.key === 'Escape' && historyPanelVisible()) {
        e.stopPropagation(); // 只关历史面板，不触发全局 Esc 收起预览
        toggleHistoryPanel(false);
      }
    });
    $('btn-history').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHistoryPanel();
    });
    // 点击面板外任意处关闭历史下拉
    document.addEventListener('click', (e) => {
      if (historyPanelVisible()
          && !e.target.closest('.query-wrap')) {
        toggleHistoryPanel(false);
      }
    });
    $('threshold').addEventListener('input', () => {
      $('threshold-val').textContent = $('threshold').value;
    });
    $('btn-index-all').addEventListener('click', () => startIndexing('all'));
    $('btn-index-folder').addEventListener('click', () => startIndexing('folder'));
    $('btn-index-selected').addEventListener('click', () => startIndexing('selected'));
    $('btn-stop-index').addEventListener('click', stopIndexing);
    $('btn-visual-selected').addEventListener('click', visualSearchFromSelection);
    $('btn-export').addEventListener('click', exportSelected);
    $('btn-tag').addEventListener('click', tagResults);
    $('btn-restart-service').addEventListener('click', restartService);
    $('btn-rebuild-index').addEventListener('click', rebuildIndex);
    $('btn-view-log').addEventListener('click', viewServiceLog);
    $('btn-describe').addEventListener('click', describeAndSearch);
    $('btn-purify').addEventListener('click', sendToPurify);
    $('btn-stats').addEventListener('click', openStats);
    $('btn-close-stats').addEventListener('click', () => $('stats-dialog').close());
    $('btn-export-indexes').addEventListener('click', exportIndexes);
    $('btn-import-indexes').addEventListener('click', importIndexes);
    // 视图栏：排序 / 时长过滤 / 分组
    $('view-sort').addEventListener('change', () => Search.setView({ sortBy: $('view-sort').value }));
    $('view-min-dur').addEventListener('change', () => {
      Search.setView({ minDur: parseFloat($('view-min-dur').value) || 0 });
    });
    $('view-grouped').addEventListener('change', () => {
      Search.setView({ grouped: $('view-grouped').checked });
    });
    $('btn-save-results').addEventListener('click', saveResults);
    $('btn-archives').addEventListener('click', openArchives);
    $('btn-close-archives').addEventListener('click', () => $('archive-dialog').close());
    $('btn-scope').addEventListener('click', openScopeDialog);
    $('btn-scope-apply').addEventListener('click', applyScopeDialog);
    $('btn-scope-cancel').addEventListener('click', () => $('scope-dialog').close());
    document.addEventListener('paste', handlePaste);
    $('btn-settings').addEventListener('click', openSettings);
    $('btn-save-settings').addEventListener('click', saveSettings);
    Search.setVisualHandler(doVisualSearch);
    Search.setSelectionHandler(updateBatchButtons);
  }

  eagle.onPluginCreate((plugin) => {
    Config.init(plugin.path);
    applyTheme();
    Search.bindDom();
    wireEvents();

    const cfg = Config.get();
    $('threshold').value = cfg.threshold;
    $('threshold-val').textContent = cfg.threshold;
    renderHistory();
    resetScopeIfLibraryChanged();
    updateScopeButton();

    // serviceMode 下随 Eagle 启动即运行：开了自动索引才主动拉起 Python 服务，
    // 否则保持安静，等用户打开窗口（onPluginShow）再连接
    if (cfg.autoIndex) {
      Service.ensure(setServiceStatus).then(() => applyAutoIndexSetting());
    } else {
      applyAutoIndexSetting();
    }
  });

  eagle.onPluginShow(() => {
    if (!serviceOnline) Service.ensure(setServiceStatus);
  });

  eagle.onThemeChanged(() => applyTheme());

  eagle.onLibraryChanged(() => {
    // 换库后：索引名、路径映射、结果全部失效
    location.reload();
  });
})();
