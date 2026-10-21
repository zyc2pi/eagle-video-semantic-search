/* 入口：初始化、主题、服务状态、事件接线 */
(() => {
  const $ = (id) => document.getElementById(id);
  let serviceOnline = false;
  let lastIndexSummary = null;
  let indexMode = 'all';
  const INDEX_MODES = {
    all: '索引整个库',
    folder: '索引选中文件夹',
    selected: '索引选中素材',
  };

  /* 外部字符串（文件名/标签/查询词）进 innerHTML 前必须转义 */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

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

  function clearSearchCache() {
    if (typeof SearchCache !== 'undefined') SearchCache.clear();
  }

  function setServiceStatus(state, message) {
    const wasOnline = serviceOnline;
    serviceOnline = state === 'online';
    if (!serviceOnline || !wasOnline) clearSearchCache();
    $('service-dot').className = `dot ${state}`;
    $('service-text').textContent = message;
    updateButtons();
    if (serviceOnline && !wasOnline) {
      refreshIndexHint();
      Indexer.recover(indexHandlers()).then((job) => {
        if (job) {
          $('index-progress').classList.remove('hidden');
          $('index-progress-text').textContent = '已恢复未完成索引任务的监视';
          updateButtons();
        }
      }).catch((error) => { $('index-hint').textContent = error.message; });
    }
    // 新机器上项目路径多半不对：首次检测到路径无效时自动弹出设置页引导配置
    if (state === 'offline' && !settingsAutoOpened
        && /项目路径无效|找不到便携 Python/.test(message)) {
      settingsAutoOpened = true;
      openSettings();
    }
  }

  function updateButtons() {
    const indexing = Indexer.isRunning() || Search.isBusy() || (typeof FrameSearch !== 'undefined' && FrameSearch.isBusy());
    $('btn-search').disabled = !serviceOnline || indexing;
    ['btn-index-primary', 'btn-index-menu-toggle'].forEach((id) => {
      $(id).disabled = !serviceOnline || indexing;
    });
    if (indexing) closeIndexModeMenu();
    ['btn-frame-visual', 'btn-frame-text'].forEach((id) => {
      $(id).disabled = !serviceOnline || indexing;
    });
  }

  function closeIndexModeMenu() {
    $('index-mode-menu').classList.add('hidden');
    $('index-mode-picker').classList.remove('open');
    $('btn-index-menu-toggle').setAttribute('aria-expanded', 'false');
  }

  function toggleIndexModeMenu() {
    if ($('btn-index-menu-toggle').disabled) return;
    const opening = $('index-mode-menu').classList.contains('hidden');
    $('index-mode-menu').classList.toggle('hidden', !opening);
    $('index-mode-picker').classList.toggle('open', opening);
    $('btn-index-menu-toggle').setAttribute('aria-expanded', String(opening));
  }

  function selectIndexMode(mode) {
    if (!Object.prototype.hasOwnProperty.call(INDEX_MODES, mode)) return;
    indexMode = mode;
    $('btn-index-primary').textContent = INDEX_MODES[mode];
    document.querySelectorAll('[data-index-mode]').forEach((option) => {
      const active = option.dataset.indexMode === mode;
      option.classList.toggle('active', active);
      option.setAttribute('aria-checked', String(active));
    });
    closeIndexModeMenu();
  }

  // ---------- 建索引 ----------
  function indexHandlers() {
    return {
      onConnection(online, message) {
        setServiceStatus(online ? 'online' : 'offline', message);
        $('index-progress-text').textContent = message;
      },
      onProgress(status) {
        const pct = status.total > 0 ? Math.round((status.current / status.total) * 100) : 0;
        $('index-bar-fill').style.width = `${pct}%`;
        const queued = status.queued > 0 ? `（队列还有 ${status.queued} 个任务）` : '';
        $('index-progress-text').textContent =
          status.state === 'queued' ? `任务已排队${queued}` : `${status.current}/${status.total}  ${status.current_video || '准备中…'}${queued}`;
      },
      onTerminal() {
        // 失败或任务记录丢失也可能发生在部分写入后，不能继续使用旧结果。
        clearSearchCache();
      },
      async onDone(status) {
        $('index-progress').classList.add('hidden');
        updateButtons();

        let outcome = { newSkipped: 0, newFailed: 0 };
        try {
          const refreshed = await refreshIndexHint({ announceOutcome: true });
          if (refreshed) outcome = refreshed;
        } catch { /* refreshIndexHint 内部已记录错误 */ }
        if (status.state === 'cancelled') {
          toast(`已停止索引（已完成 ${status.current}/${status.total}，已写入部分保留，再次点击可增量续跑）`, false, 5000);
        } else {
          let message = `索引完成：本轮处理 ${status.total} 个视频`;
          if (outcome.newSkipped > 0) {
            message += `，其中 ${outcome.newSkipped} 个无有效场景已跳过`;
          }
          if (outcome.newFailed > 0) {
            message += `，${outcome.newFailed} 个处理失败`;
          }
          if (status.pruned > 0) {
            message += `，清理 ${status.pruned} 个已删除素材`;
          }
          if (outcome.newSkipped > 0 || outcome.newFailed > 0) {
            message += '（详情见服务日志）';
          }
          toast(message, false, 6000);
        }
      },
      onError(message) {
        $('index-progress').classList.add('hidden');
        updateButtons();
        toast(`索引失败：${message}`, true, 6000);
      },
    };
  }

  async function startIndexing(mode) {
    if (Search.isBusy()) { toast('搜索进行中，请稍候再建索引'); return; }
    closeIndexModeMenu();
    await ensureIndexOutcomeBaseline();
    const result = await Indexer.start(mode, indexHandlers());
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
  let scopeDialogExpanded = new Set(); // 对话框每次打开时默认全部折叠
  let scopeFolderRoots = [];

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

  function renderFolderRows(rows, container) {
    const scrollTop = container.scrollTop;
    container.innerHTML = '';
    rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'folder-row';
      row.style.paddingLeft = `${r.depth * 18}px`;

      if (r.hasChildren) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'folder-toggle';
        toggle.textContent = r.expanded ? '▾' : '▸';
        toggle.setAttribute('aria-expanded', String(r.expanded));
        toggle.setAttribute('aria-label', `${r.expanded ? '收起' : '展开'} ${r.name}`);
        toggle.addEventListener('click', () => {
          if (r.expanded) scopeDialogExpanded.delete(r.id);
          else scopeDialogExpanded.add(r.id);
          renderFolderTree(container);
        });
        row.appendChild(toggle);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'folder-toggle-spacer';
        row.appendChild(spacer);
      }

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
      name.className = 'folder-name';
      name.textContent = r.name + (r.childCount ? `（${r.childCount} 个子文件夹）` : '');
      name.title = r.name;
      row.appendChild(cb);
      row.appendChild(name);
      container.appendChild(row);
    });
    container.scrollTop = scrollTop;
  }

  function renderFolderTree(container) {
    const rows = ScopeFolderTree.flattenVisible(scopeFolderRoots, scopeDialogExpanded);
    renderFolderRows(rows, container);
  }

  async function openScopeDialog() {
    const cfg = Config.get();
    scopeDialogChecked = new Set(cfg.scopeFolderIds || []);
    scopeDialogExpanded = new Set();
    scopeFolderRoots = [];
    document.querySelectorAll('input[name="scope-mode"]').forEach((r) => {
      r.checked = r.value === (cfg.scopeMode || 'all');
    });
    const tree = $('folder-tree');
    tree.innerHTML = '<p class="hint">读取文件夹列表…</p>';
    $('scope-dialog').showModal();
    try {
      const roots = await Bridge.getFolderTree();
      scopeFolderRoots = roots;
      const rows = ScopeFolderTree.flattenVisible(roots, scopeDialogExpanded);
      console.log(`[Scope] 顶层 ${roots.length} 个，初始显示 ${rows.length} 个文件夹`);
      if (rows.length === 0) {
        // 可见行为空说明返回结构完全对不上，把原始结构的关键信息亮出来便于排查
        const sample = roots.length ? Object.keys(roots[0]).join(', ') : '(空列表)';
        tree.innerHTML = `<p class="hint">没有读取到文件夹。原始返回 ${roots.length} 项，`
          + `首项字段: ${esc(sample)}</p>`;
        return;
      }
      renderFolderTree(tree);
    } catch (e) {
      console.error('[Scope] 读取文件夹树失败', e);
      tree.innerHTML = `<p class="hint" style="color:var(--danger)">读取文件夹失败：${esc(e.message)}</p>`;
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
    const context = await SearchRecipe.currentContext();
    $('time-warning').textContent = context.missingDates
      ? `${context.missingDates} 个素材缺少导入时间，已排除` : '';
    return context;
  }

  // ---------- 视觉检索（以图搜视频 / 以片搜片） ----------
  async function doVisualSearch(payload, label) {
    if (!serviceOnline || Indexer.isRunning()) {
      toast('搜索服务未就绪或正在建索引', true);
      return;
    }
    const btn = $('btn-search');
    hideResolvedIndexHintForSearch();
    btn.disabled = true;
    btn.textContent = '搜索中…';
    toast(`正在以${label}搜索相似场景…`);
    try {
      const scope = await resolveSearchScope();
      const r = await Search.runVisual(payload, scope, label);
      if (r.cancelled || r.stale) return;
      if (!r.ok) toast(r.message, true, 5000);
      else if (r.count === 0) toast('没有相似场景（可在设置中降低视觉阈值）');
      else toast(`找到 ${r.count} 个相似场景`);
    } catch (e) {
      console.error(e);
      toast(`搜索出错：${e.message}`, true, 5000);
    } finally {
      btn.textContent = Search.isBusy() ? '搜索中…' : '搜索';
      updateButtons();
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
  function saveResults() {
    Warehouse.saveCurrent();
  }

  function openArchives() {
    Warehouse.open();
  }

  // ---------- 素材库统计 ----------
  function statsBar(label, count, max, extra = '') {
    const pct = max > 0 ? Math.max((count / max) * 100, 1.5) : 0;
    return `<div class="stat-row"><span class="stat-label" title="${esc(label)}">${esc(label)}</span>`
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
        const coverages = [];
        for (const p of indices) {
          coverages.push(await Api.indexCoverage(p));
        }
        const summary = Bridge.summarizeIndexCoverage(videos, coverages);
        indexedCount = summary.indexed;
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
      body.innerHTML = `<p class="hint" style="color:var(--danger)">统计失败：${esc(e.message)}</p>`;
    }
  }

  // ---------- 语义查重 ----------
  async function runDedupScan() {
    const body = $('dedup-body');
    body.innerHTML = '<p class="hint">扫描中（读取索引向量并聚类）…</p>';
    try {
      const indices = await Search.findLibraryIndexes();
      if (indices.length === 0) {
        body.innerHTML = '<p class="hint">当前素材库还没有索引，请先建索引。</p>';
        return;
      }
      await Bridge.refreshPathMap();
      const threshold = Math.min(Math.max(parseFloat($('dedup-threshold').value) || 0.93, 0.8), 0.99);
      const resp = await Api.dedupScan(indices, threshold);
      if (!resp.ok || !resp.data || !resp.data.success) {
        body.innerHTML = `<p class="hint" style="color:var(--danger)">扫描失败：${esc((resp.data && resp.data.error) || resp.status)}</p>`;
        return;
      }
      const groups = resp.data.groups || [];
      if (groups.length === 0) {
        body.innerHTML = `<p class="hint">没有发现相似度 ≥ ${threshold} 的重复视频（共扫描 ${resp.data.video_count} 个）。可调低阈值再试。</p>`;
        return;
      }
      body.innerHTML = '';
      const head = document.createElement('p');
      head.className = 'hint';
      head.textContent = `共扫描 ${resp.data.video_count} 个视频，发现 ${resp.data.group_count} 组相似（每组保留哪个由你决定，可先「选中」在 Eagle 中查看）`;
      body.appendChild(head);
      groups.forEach((g, gi) => {
        const box = document.createElement('div');
        box.className = 'archive-row';
        const info = document.createElement('span');
        info.className = 'archive-name';
        const names = g.videos.map((v) => {
          const item = Bridge.itemForPath(v.video_path);
          return item ? item.name : v.video_path.split(/[\\/]/).pop();
        });
        info.textContent = `组${gi + 1}（${g.videos.length} 个）：${names.join('、')}`;
        info.title = g.videos.map((v) => `${v.video_path}（相似度 ${v.similarity}）`).join('\n');
        const locate = document.createElement('button');
        locate.textContent = '在 Eagle 中选中';
        locate.addEventListener('click', async () => {
          const ids = g.videos.map((v) => Bridge.itemForPath(v.video_path))
            .filter(Boolean).map((it) => it.id);
          if (ids.length === 0) {
            toast('这组素材已不在库中', true);
            return;
          }
          await Bridge.locateInEagle(ids);
        });
        box.appendChild(info);
        box.appendChild(locate);
        body.appendChild(box);
      });
    } catch (e) {
      console.error(e);
      body.innerHTML = `<p class="hint" style="color:var(--danger)">扫描出错：${esc(e.message)}</p>`;
    }
  }

  function openDedupScan() {
    $('dedup-dialog').showModal();
    runDedupScan();
  }

  // 在线目录不能直接覆盖；离线维护工具会校验进程锁、包清单并保存回滚记录。
  async function exportIndexes() {
    toast('索引导出已改为安全离线维护：关闭 5006/5007 服务后，使用后端 tools/index_package.py export；详见更新说明。不会压缩运行中的索引。', true, 10000);
  }

  async function importIndexes() {
    toast('索引导入已改为安全离线维护：关闭 5006/5007 服务后，使用后端 tools/index_package.py import；自动校验并保留回滚备份。不会直接覆盖运行中的索引。', true, 10000);
  }

  async function openIndexJobs() {
    let dialog = $('index-jobs-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'index-jobs-dialog';
      dialog.className = 'settings-form';
      document.body.appendChild(dialog);
    }
    dialog.replaceChildren();
    const title = document.createElement('h3'); title.textContent = '当前库的索引任务'; dialog.appendChild(title);
    const body = document.createElement('div'); body.className = 'index-jobs-list'; dialog.appendChild(body);
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.onclick = () => dialog.close(); dialog.appendChild(close);
    if (!dialog.open) dialog.showModal();
    body.textContent = '正在读取…';
    try {
      const library = await Bridge.resolveLibraryIdentity();
      const jobs = await Api.listIndexJobs(library.id);
      body.textContent = `库 ID：${library.id}（搬家关联时使用；复制库不应复用）`;
      if (!jobs.length) body.appendChild(document.createTextNode('；暂无任务。旧索引仍保留，新版按独立库身份重建或离线迁移。'));
      for (const job of jobs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))) {
        const row = document.createElement('details');
        const summary = document.createElement('summary');
        const labels = { queued: '排队中', running: '运行中', cancelling: '停止中', done: '已完成', error: '失败', cancelled: '已停止', interrupted: '已中断' };
        summary.textContent = `${labels[job.state] || job.state} · ${job.source || '未知来源'} · ${job.current || 0}/${job.total || 0} · ${new Date((job.created_at || 0) * 1000).toLocaleString()}`;
        row.appendChild(summary);
        const detail = document.createElement('pre'); detail.className = 'job-details';
        detail.textContent = `${job.job_id}\n${job.error || ''}\n` + (job.file_results || []).map((item) => `${item.state || item.status || 'unknown'}: ${item.path}${item.reason || item.error ? ` — ${item.reason || item.error}` : ''}`).join('\n');
        row.appendChild(detail);
        const active = ['queued', 'running', 'cancelling'].includes(job.state);
        if (active || (job.file_results || []).some((item) => item.retryable)) {
          const action = document.createElement('button'); action.type = 'button'; action.textContent = active ? '停止此任务' : '仅重试失败项';
          const key = require('crypto').randomUUID();
          action.onclick = async () => {
            action.disabled = true;
            try {
              if ((await Bridge.resolveLibraryIdentity()).id !== library.id) throw new Error('素材库已切换');
              if (active) { const result = await Api.cancelIndex(job.job_id); if (!result.ok) throw new Error(result.data?.error || '取消失败'); }
              else {
                clearSearchCache();
                const retry = Indexer.retry(job.job_id, key, indexHandlers());
                updateButtons();
                await retry;
                $('index-bar-fill').style.width = '0%';
                $('index-progress-text').textContent = '已提交失败项重试，等待任务开始…';
                $('index-progress').classList.remove('hidden');
              }
              await openIndexJobs();
            } catch (error) { detail.textContent += `\n${error.message}`; action.disabled = false; }
            finally { updateButtons(); }
          };
          row.appendChild(action);
        }
        body.appendChild(row);
      }
    } catch (error) { body.textContent = error.message; }
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
    if (indices.length === 0) {
      return {
        indexed: 0, skipped: 0, failed: 0, missing: videos.length, stale: 0,
      };
    }
    const coverages = [];
    for (const p of indices) {
      coverages.push(await Api.indexCoverage(p));
    }
    return Bridge.summarizeIndexCoverage(videos, coverages);
  }

  async function ensureIndexOutcomeBaseline() {
    const cfg = Config.get();
    const library = eagle.library.path || '';
    if (cfg.indexOutcomeLibrary === library) return;
    try {
      const summary = lastIndexSummary || await countMissingVideos();
      lastIndexSummary = summary;
      Config.save({
        indexOutcomeLibrary: library,
        indexOutcomeSkipped: summary.skipped,
        indexOutcomeFailed: summary.failed,
      });
    } catch (e) {
      console.warn('初始化索引结果提示基线失败', e);
    }
  }

  function hideResolvedIndexHintForSearch() {
    if (lastIndexSummary && lastIndexSummary.missing === 0) {
      $('index-hint').classList.add('hidden');
    }
  }

  async function refreshIndexHint({ announceOutcome = false } = {}) {
    if (!serviceOnline) return;
    if (Indexer.isRunning() && !announceOutcome) return;
    const hint = $('index-hint');
    try {
      const library = await Bridge.resolveLibraryIdentity();
      const legacy = await Indexer.detectLegacyIndex(library.path, library.index_name);

      // 静默记录旧索引检测结果，不在UI显示，避免打扰用户
      if (legacy && legacy.count > 0) {
        console.info('[旧索引检测] 发现旧索引，但已配置为静默模式');
        console.info('[旧索引检测] 旧索引:', legacy.name, '记录数:', legacy.count);
        console.info('[旧索引检测] 新索引:', legacy.currentName);
        console.info('[旧索引检测] 如需查看迁移步骤，请在控制台调用: window.showLegacyMigration()');
        // 暴露全局方法供开发者或agent手动调用
        window.showLegacyMigration = () => showLegacyIndexMigrationDialog(legacy);
        // 不返回，继续显示正常的索引提示
      }

      const summary = await countMissingVideos();
      lastIndexSummary = summary;

      const cfg = Config.get();
      const libraryPath = eagle.library.path || '';
      const sameLibrary = cfg.indexOutcomeLibrary === libraryPath;
      const delta = Bridge.indexOutcomeDelta(summary, {
        skipped: cfg.indexOutcomeSkipped,
        failed: cfg.indexOutcomeFailed,
      }, announceOutcome && sameLibrary);
      Config.save({
        indexOutcomeLibrary: libraryPath,
        indexOutcomeSkipped: summary.skipped,
        indexOutcomeFailed: summary.failed,
      });

      hint.textContent = Bridge.indexHintText(summary);
      hint.title = hint.textContent ? '检测到新视频，完成增量索引后会自动隐藏' : '';
      hint.classList.toggle('warn', summary.missing > 0);
      hint.classList.toggle('hidden', summary.missing === 0);
      hint.classList.remove('legacy-index');
      return { ...summary, newSkipped: delta.skipped, newFailed: delta.failed };
    } catch (e) {
      console.warn('索引对比失败', e);
      return { newSkipped: 0, newFailed: 0 };
    }
  }

  function showLegacyIndexMigrationDialog(legacy) {
    const dialog = document.createElement('dialog');
    dialog.className = 'legacy-migration-dialog';

    // 从旧索引名称移除 .lance 后缀
    const sourceIndexName = legacy.name.replace(/\.lance$/, '');
    const targetIndexName = legacy.currentName;
    const model = legacy.model || 'qihoo360-fg-clip2-base';

    const migrationCommand = `python\\python.exe tools\\index_package.py migrate --source "${sourceIndexName}" --target "${targetIndexName}" --model "${model}"`;

    dialog.innerHTML = `
      <h3>旧索引迁移指南</h3>
      <p class="hint">检测到旧版本的索引数据（<strong>${legacy.count.toLocaleString()}</strong> 条记录），需要迁移到新版本才能使用。</p>
      <div class="migration-info">
        <p><strong>旧索引：</strong><code>${esc(sourceIndexName)}</code></p>
        <p><strong>新索引：</strong><code>${esc(targetIndexName)}</code></p>
        <p><strong>模型：</strong><code>${esc(model)}</code></p>
      </div>
      <h4>迁移步骤</h4>
      <ol class="migration-steps">
        <li><strong>关闭服务：</strong>在后端目录运行 <code>stop-service.bat</code>（或手动关闭 5006 和 5007 端口服务）</li>
        <li><strong>运行迁移：</strong>在后端目录打开命令行，执行以下命令（已为您准备好，点击下方按钮可复制）：
          <pre id="migration-command">${esc(migrationCommand)}</pre>
        </li>
        <li><strong>启动服务：</strong>运行 <code>start-service.bat</code> 重新启动搜索服务</li>
        <li><strong>验证迁移：</strong>在插件中重新加载，索引提示应消失，搜索应正常工作</li>
      </ol>
      <div class="migration-warning">
        <p>⚠️ <strong>重要提示：</strong></p>
        <ul>
          <li>迁移过程中不要操作 Eagle 或搜索插件</li>
          <li>迁移会保留原索引，不会删除或覆盖数据</li>
          <li>如果迁移失败，原索引仍然完整，可以重试</li>
          <li>迁移成功后，旧索引仍然保留在后端，可手动删除或保留作为备份</li>
        </ul>
      </div>
      <div class="dialog-actions">
        <button id="migration-close" type="button">知道了</button>
        <button id="migration-copy-command" type="button" class="primary">复制迁移命令</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.showModal();

    $('migration-close').addEventListener('click', () => {
      dialog.close();
      dialog.remove();
    });

    $('migration-copy-command').addEventListener('click', async () => {
      const command = $('migration-command').textContent;
      try {
        await navigator.clipboard.writeText(command);
        toast('迁移命令已复制到剪贴板');
      } catch (e) {
        toast('复制失败，请手动复制命令', true);
      }
    });

    dialog.addEventListener('close', () => dialog.remove());
  }

  const AUTO_INDEX_INTERVAL_MS = 10 * 60 * 1000;
  let autoIndexTimer = null;

  async function autoIndexTick() {
    if (!Config.get().autoIndex || Indexer.isRunning()) return;
    try {
      if (!serviceOnline && !(await Service.ensure(setServiceStatus))) return;
      const { missing, stale } = await countMissingVideos();
      if (missing > 0 || stale > 0) {
        console.log(
          `[AutoIndex] 发现 ${missing} 个新视频、${stale} 个失效路径，自动同步索引`,
        );
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

  /* Ctrl+V 粘贴图片 → 以图搜视频 */
  function handlePaste(e) {
    if (document.querySelector('dialog[open]')) return;
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
    hideResolvedIndexHintForSearch();
    const btn = $('btn-search');
    btn.disabled = true;
    btn.textContent = '搜索中…';
    try {
      const scope = await resolveSearchScope();
      const threshold = parseFloat($('threshold').value);
      Config.save({ threshold });
      const r = await Search.run(query, threshold, scope);
      if (r.cancelled || r.stale) return;
      if (!r.ok) toast(r.message, true, 5000);
      else if (r.extra?.temporal_info) {
        toast(Search.temporalSummary(r.extra.temporal_info), false, 10000);
        if (r.count) pushHistory(query);
      }
      else if (r.count === 0) toast('没有匹配结果，可尝试降低阈值');
      else {
        toast(`找到 ${r.count} 个匹配场景`);
        pushHistory(query);
      }
    } catch (e) {
      console.error(e);
      toast(`搜索出错：${e.message}`, true, 5000);
    } finally {
      btn.textContent = Search.isBusy() ? '搜索中…' : '搜索';
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
    $('cfg-ai-expand').checked = !!cfg.aiExpand;
    $('cfg-ai-mode').value = cfg.aiMode || 'balanced';
    $('cfg-dedup').checked = !!cfg.dedup;
    $('cfg-dedup-threshold').value = cfg.dedupThreshold != null ? cfg.dedupThreshold : 0.95;
    $('cfg-mini-rerank').checked = !!cfg.miniRerank;
    $('settings-error').textContent = Config.getLoadError?.() || '';
    $('btn-recover-settings').classList.toggle('hidden', !Config.getLoadError?.());
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

  function saveSettings(event, recover = false) {
    event.preventDefault();
    const form = $('settings-form');
    $('settings-error').textContent = '';
    if (!form.reportValidity()) return;
    try {
    const prevModel = Config.get().modelName;
    const prevKey = Config.get().deepseekKey || '';
    const modelName = $('cfg-model').value;
    Config.save({
      deepseekKey: $('cfg-deepseek-key').value.trim(),
      projectRoot: $('cfg-project-root').value.trim(),
      port: $('cfg-port').value === '' ? NaN : Number($('cfg-port').value),
      modelName,
      visualThreshold: $('cfg-visual-threshold').value === '' ? NaN : Number($('cfg-visual-threshold').value),
      visualMargin: $('cfg-visual-margin').value === '' ? NaN : Number($('cfg-visual-margin').value),
      visualAgg: $('cfg-visual-agg').value,
      visualCentered: $('cfg-visual-centered').checked,
      visualSceneFrames: Number($('cfg-visual-scene-frames').value),
      visualVideoFrames: Number($('cfg-visual-video-frames').value),
      indexSampleInterval: Number($('cfg-idx-sample-interval').value),
      indexResolution: Number($('cfg-idx-resolution').value),
      indexMinSceneLen: Number($('cfg-idx-min-scene').value),
      indexBatchSize: Number($('cfg-idx-batch').value),
      indexSceneThreshold: Number($('cfg-idx-scene-threshold').value),
      indexLocalmaxOrder: Number($('cfg-idx-localmax').value),
      indexFp16: $('cfg-idx-fp16').checked,
      aiEnhance: $('cfg-ai-enhance').checked,
      aiExpand: $('cfg-ai-expand').checked,
      aiMode: $('cfg-ai-mode').value || 'balanced',
      dedup: $('cfg-dedup').checked,
      dedupThreshold: Number($('cfg-dedup-threshold').value),
      miniRerank: $('cfg-mini-rerank').checked,
      autoIndex: $('cfg-auto-index').checked,
      ...(modelName !== prevModel ? { threshold: modelName.includes('fg-clip2') ? 11 : 21 } : {}),
    }, { recover });
    applyAutoIndexSetting();
    if (modelName !== prevModel) {
      const suggested = modelName.includes('fg-clip2') ? 11 : 21;
      $('threshold').value = suggested;
      $('threshold-val').textContent = suggested;
      toast(`已切换模型，阈值建议调整为 ${suggested}，请对库重新建索引`);
    }
    if (Config.get().deepseekKey !== prevKey) {
      toast('DeepSeek Key 已更新，点击设置里的「重启搜索服务」后生效', false, 5000);
    }
    setServiceStatus('offline', '配置已更新，正在重新连接…');
    $('settings-dialog').close();
    Service.ensure(setServiceStatus);
    } catch (error) {
      $('settings-error').textContent = error.message;
    }
  }

  let organizeSelection = null;
  let organizing = false;

  function updateSelectionActions() {
    const matches = Search.getSelectedMatches() || [];
    $('btn-clear-selection').disabled = organizing || Search.isBusy() || matches.length === 0;
    const targets = Bridge.selectionTargets(matches);
    $('selection-count').textContent = matches.length
      ? `已选 ${matches.length} 个片段 / ${targets.ids.length} 个素材` : '';
    for (const id of ['btn-selection-tag', 'btn-selection-folder']) {
      $(id).disabled = organizing || Search.isBusy() || targets.ids.length === 0;
    }
  }

  function openOrganize(kind) {
    if (organizing || Search.isBusy()) return;
    const targets = Bridge.selectionTargets(Search.getSelectedMatches());
    if (!targets.ids.length) return;
    organizeSelection = { ...targets, kind, library: eagle.library.path };
    $('organize-title').textContent = kind === 'tag' ? '添加标签' : '添加到 Eagle 新文件夹';
    $('organize-summary').textContent = `将处理 ${targets.ids.length} 个素材（重复片段已合并）`
      + (targets.missing ? `，另有 ${targets.missing} 个失效素材将跳过` : '')
      + (kind === 'folder' ? '。在当前库根目录创建新文件夹。' : '。');
    $('organize-name').value = Warehouse.getCurrentName() || Search.getLastQuery() || '搜索结果';
    $('organize-name').disabled = false;
    $('organize-submit').disabled = false;
    $('organize-submit').textContent = '添加';
    $('organize-cancel').textContent = '取消';
    $('organize-status').textContent = '';
    $('organize-dialog').showModal();
    $('organize-name').select();
  }

  async function submitOrganize(event) {
    event.preventDefault();
    if (organizing || !organizeSelection) return;
    const name = $('organize-name').value.trim();
    if (!name) { $('organize-status').textContent = '请输入名称'; return; }
    organizing = true;
    $('organize-submit').disabled = true;
    $('organize-name').disabled = true;
    $('organize-cancel').disabled = true;
    $('organize-status').textContent = '正在添加…';
    updateSelectionActions();
    try {
      const selection = organizeSelection;
      const result = await Bridge.organizeItems(selection.ids, selection.kind, name, selection.library, selection.folderId);
      selection.folderId = result.folderId;
      selection.ids = result.items.filter((item) => item.status === 'failed').map((item) => item.id);
      $('organize-status').textContent = `完成：成功 ${result.success} 个，失败 ${result.failed} 个，失效跳过 ${result.missing + selection.missing} 个。`
        + (result.folderId ? `新文件夹：${name}。` : '')
        + (result.failed ? '\n成功项已保留，可仅重试失败项：\n' + result.items.filter((item) => item.status !== 'success').map((item) => `${item.name}：${item.reason}`).join('\n') : '');
      if (result.failed) {
        $('organize-submit').textContent = '仅重试失败项';
        $('organize-submit').disabled = false;
      }
    } catch (error) {
      $('organize-status').textContent = `操作未完成：${error.message}。已完成的修改会保留。`;
      $('organize-submit').disabled = false;
      $('organize-submit').textContent = '重试';
    } finally {
      organizing = false;
      $('organize-cancel').disabled = false;
      $('organize-cancel').textContent = '关闭';
      updateSelectionActions();
    }
  }

  // ---------- 快捷键系统 ----------
  function initShortcuts() {
    // Ctrl+K: 聚焦搜索框
    Shortcuts.register('ctrl+k', () => {
      $('query').focus();
      $('query').select();
    }, { description: '聚焦搜索框' });

    // Ctrl+I: 开始索引
    Shortcuts.register('ctrl+i', () => {
      if (!$('btn-index-primary').disabled) {
        startIndexing(indexMode);
      }
    }, { description: '开始索引' });

    // Ctrl+W: 打开仓库
    Shortcuts.register('ctrl+w', () => {
      Warehouse.open();
    }, { description: '打开仓库' });

    // Ctrl+,: 打开设置
    Shortcuts.register('ctrl+,', () => {
      openSettings();
    }, { description: '打开设置' });

    // Escape: 关闭对话框
    Shortcuts.register('escape', (e) => {
      const openDialog = document.querySelector('dialog[open]');
      // 原生 Escape 会派发可取消的 cancel 事件，保留各业务的忙碌保护。
      if (openDialog?.hasAttribute('data-no-escape')) e.preventDefault();
    }, { description: '关闭对话框', preventDefault: false });

    // Ctrl+/: 显示快捷键帮助
    Shortcuts.register('ctrl+/', () => {
      showShortcutsHelp();
    }, { description: '显示快捷键帮助' });
  }

  function showShortcutsHelp() {
    const shortcuts = Shortcuts.getAll();
    const dialog = document.createElement('dialog');
    dialog.className = 'shortcuts-help-dialog';
    dialog.innerHTML = `
      <h3>快捷键列表</h3>
      <div class="shortcuts-list">
        ${shortcuts.map(s => `
          <div class="shortcut-item">
            <kbd>${s.shortcut.replace(/\+/g, '</kbd> + <kbd>').replace('ctrl', '⌘/Ctrl')}</kbd>
            <span>${s.description}</span>
          </div>
        `).join('')}
      </div>
      <div class="dialog-actions">
        <button type="button" onclick="this.closest('dialog').close()">关闭</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove());
  }

  // ---------- 初始化 ----------
  function wireEvents() {
    Search.setSelectionHandler(updateSelectionActions);
    $('btn-clear-selection').addEventListener('click', () => Search.clearSelection());
    document.addEventListener('search-busy', updateSelectionActions);
    $('btn-selection-tag').addEventListener('click', () => openOrganize('tag'));
    $('btn-selection-folder').addEventListener('click', () => openOrganize('folder'));
    $('organize-form').addEventListener('submit', submitOrganize);
    $('organize-cancel').addEventListener('click', () => $('organize-dialog').close());
    $('organize-dialog').addEventListener('cancel', (event) => { if (organizing) event.preventDefault(); });
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
    $('btn-index-primary').addEventListener('click', () => startIndexing(indexMode));
    $('btn-index-menu-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleIndexModeMenu();
    });
    document.querySelectorAll('[data-index-mode]').forEach((option) => {
      option.addEventListener('click', () => selectIndexMode(option.dataset.indexMode));
    });
    $('btn-stop-index').addEventListener('click', stopIndexing);
    $('btn-restart-service').addEventListener('click', restartService);
    $('btn-rebuild-index').addEventListener('click', rebuildIndex);
    $('btn-view-log').addEventListener('click', viewServiceLog);
    $('btn-index-jobs').addEventListener('click', openIndexJobs);
    $('btn-refresh-library').addEventListener('click', async () => {
      try { Bridge.invalidateCache(); await Bridge.refreshPathMap(true); toast('素材缓存已刷新，下次搜索使用最新素材范围'); }
      catch (error) { toast(error.message, true); }
    });
    $('btn-stats').addEventListener('click', openStats);
    $('btn-dedup-scan').addEventListener('click', openDedupScan);
    $('btn-dedup-rescan').addEventListener('click', runDedupScan);
    $('btn-close-dedup').addEventListener('click', () => $('dedup-dialog').close());
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
    $('btn-scope').addEventListener('click', openScopeDialog);
    $('btn-scope-apply').addEventListener('click', applyScopeDialog);
    $('btn-scope-cancel').addEventListener('click', () => $('scope-dialog').close());
    document.addEventListener('paste', handlePaste);
    $('btn-settings').addEventListener('click', openSettings);
    $('settings-form').addEventListener('submit', saveSettings);
    $('btn-recover-settings').addEventListener('click', (event) => saveSettings(event, true));
    $('btn-cancel-settings').addEventListener('click', () => $('settings-dialog').close());
    document.addEventListener('click', (e) => {
      if (!$('index-mode-menu').classList.contains('hidden')
          && !e.target.closest('#index-mode-picker')) {
        closeIndexModeMenu();
      }
    });
    document.addEventListener('search-busy', updateButtons);
    document.addEventListener('frame-search-busy', updateButtons);
  }

  eagle.onPluginCreate((plugin) => {
    Config.init(plugin.path);
    Config.onError?.((message) => toast(message, true, 7000));
    if (Config.getLoadError?.()) toast(Config.getLoadError(), true, 10000);
    applyTheme();
    Search.bindDom();
    Warehouse.init({ toast, canSearch: () => serviceOnline && !Indexer.isRunning() });
    wireEvents();
    FrameSearch.init({ toast,
      canSearch: () => serviceOnline && !Indexer.isRunning(),
      resolveScope: resolveSearchScope,
      onTextSuccess(query) { $('query').value = query; pushHistory(query); },
    });
    initShortcuts();

    const cfg = Config.get();
    $('threshold').value = cfg.threshold;
    $('threshold-val').textContent = cfg.threshold;
    renderHistory();
    selectIndexMode('all');
    resetScopeIfLibraryChanged();
    updateScopeButton();

    // serviceMode 下随 Eagle 启动即运行：开了自动索引才主动拉起 Python 服务，
    // 否则保持安静，等用户打开窗口（onPluginShow）再连接
    if (cfg.autoIndex) {
      Service.ensure(setServiceStatus).then(() => applyAutoIndexSetting());
    } else {
      applyAutoIndexSetting();
    }

    // 低频心跳：服务中途崩溃时状态灯及时变灰（此前只在开窗时检查，绿灯会一直挂着）
    setInterval(async () => {
      const ok = await Api.health();
      if (ok && !serviceOnline) {
        setServiceStatus('online', '搜索服务已连接');
      } else if (!ok && serviceOnline) {
        setServiceStatus('offline', '搜索服务已断开（可在设置里重启服务）');
      }
    }, 60000);
  });

  eagle.onPluginShow(() => {
    if (!serviceOnline) Service.ensure(setServiceStatus);
    else if (!Indexer.isRunning()) refreshIndexHint();
  });

  eagle.onThemeChanged(() => applyTheme());

  eagle.onLibraryChanged(() => {
    // 换库后：索引名、路径映射、结果全部失效
    location.reload();
  });
})();
