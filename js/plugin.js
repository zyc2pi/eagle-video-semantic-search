/* 入口：初始化、主题、服务状态、事件接线 */
(() => {
  const { $, esc, toast, h } = Dom;
  let serviceOnline = false;
  let pluginReady = false;
  let showPending = false;
  let lastIndexSummary = null;
  let indexMode = 'all';
  let refineSource = null;
  let refineContextGeneration = 0;
  let autoCheckScheduled = false;
  const INDEX_MODES = {
    all: '索引整个库',
    folder: '索引选中文件夹',
    selected: '索引选中素材',
  };

  function applyTheme() {
    const theme = Config.get().theme || 'auto';
    const dark = theme === 'dark' || (theme === 'auto' && (
      typeof eagle.app.isDarkColors === 'function' ? eagle.app.isDarkColors() : true
    ));
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
    $('service-text').textContent = state === 'starting' ? '加载搜索服务…' : message;
    $('service-text').hidden = serviceOnline;
    $('service-status').title = message;
    $('service-status').setAttribute('aria-label', message);
    updateButtons();
    if (serviceOnline && !wasOnline) {
      Search.retryThumbnails();
      refreshIndexHint();
      if (!autoCheckScheduled) {
        autoCheckScheduled = true;
        setTimeout(() => { if (!Indexer.isRunning()) Warehouse.autoCheckNewMaterials(); }, 20000);
      }
      Indexer.recover(indexHandlers()).then((job) => {
        if (job) {
          $('index-progress').classList.remove('hidden');
          $('index-progress-text').textContent = job.state === 'done' ? '正在补全上次全库索引的主题清理…' : '已恢复未完成索引任务的监视';
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
    const indexing = Indexer.isRunning() || Search.isBusy() || (typeof FrameSearch !== 'undefined' && FrameSearch.isBusy())
      || (typeof ShotAnalysis !== 'undefined' && ShotAnalysis.isBusy());
    $('btn-search').disabled = !serviceOnline || indexing;
    $('btn-sequence-search').disabled = !serviceOnline || indexing;
    $('btn-refine-results').disabled = !serviceOnline || indexing || !Search.hasResults();
    $('result-refine-weight').disabled = indexing;
    $('refine-search-submit').disabled = !serviceOnline || indexing;
    ['btn-index-primary', 'btn-index-menu-toggle'].forEach((id) => {
      $(id).disabled = !serviceOnline || indexing;
    });
    if (indexing) closeIndexModeMenu();
    $('btn-frame-visual').disabled = !serviceOnline || indexing;
    $('btn-frame-continue').disabled = !serviceOnline || indexing;
    if (typeof Warehouse !== 'undefined') Warehouse.syncBatchUpdate?.();
    if (typeof ShotAnalysis !== 'undefined') ShotAnalysis.updateButton();
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
      onSettled() { updateButtons(); },
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
        let cleanup = null;
        let cleanupError = '';
        if (status.state === 'done' && (status.prune_missing || status.cleanup_after_retry) && status.source === 'semantic-search') {
          $('index-progress-text').textContent = '正在清理主题中的失效素材…';
          refineContextGeneration += 1;
          refineSource = null;
          try {
            const library = await Bridge.resolveLibraryIdentity();
            if (library.id !== status.library_id) throw new Error('素材库已切换，请回到原库再次索引以清理主题');
            cleanup = await Warehouse.pruneMissingVideos(library.path, { expectedCount: libraryVideoCount(library.id) });
          } catch (error) { cleanupError = error?.message || String(error); }
        }
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
            message += `，清理 ${status.pruned} 项失效索引记录`;
          }
          if (cleanup?.topics) message += `，整理 ${cleanup.topics} 个主题（移除 ${cleanup.matches} 个失效片段）`;
          if (cleanupError) message += `；主题清理未完成：${cleanupError}`;
          if (outcome.newSkipped > 0 || outcome.newFailed > 0) {
            message += '（详情见服务日志）';
          }
          toast(message, !!cleanupError, cleanupError ? 10000 : 6000);
          // 新素材进入索引后，在后台按各主题原条件探测新命中（提示不覆盖本条索引结果）。
          if (status.state === 'done') setTimeout(() => Warehouse.autoCheckNewMaterials(), 8000);
        }
        return cleanup !== null && !cleanupError;
      },
      onError(message) {
        $('index-progress').classList.add('hidden');
        updateButtons();
        toast(`索引失败：${message}`, true, 6000);
      },
    };
  }

  // 每库上次确认的全库视频数，用于识别 Eagle 清单异常缩减；存储不可用时降级为本次会话。
  const LIBRARY_COUNT_KEY = 'eagle-semantic-library-video-counts';
  const sessionLibraryCounts = {};
  function libraryVideoCount(libraryId) {
    try {
      const value = JSON.parse(localStorage.getItem(LIBRARY_COUNT_KEY) || '{}')[libraryId];
      if (Number.isSafeInteger(value)) return value;
    } catch { /* 使用会话记录。 */ }
    return sessionLibraryCounts[libraryId] || 0;
  }
  function rememberLibraryVideoCount(libraryId, count) {
    sessionLibraryCounts[libraryId] = count;
    try {
      const counts = JSON.parse(localStorage.getItem(LIBRARY_COUNT_KEY) || '{}');
      counts[libraryId] = count;
      localStorage.setItem(LIBRARY_COUNT_KEY, JSON.stringify(counts));
    } catch { /* 保留会话记录。 */ }
  }
  function abnormalShrink(previous, current) {
    return previous > 0 && (current === 0 || (previous >= 20 && current < previous * 0.7));
  }

  // 全库索引提交前核对：清单骤减或会清理主题片段时需要确认；自动索引遇到骤减直接放弃。
  async function confirmFullIndex(mode, trigger, videos, library) {
    const previous = libraryVideoCount(library.id);
    const shrink = abnormalShrink(previous, videos.length);
    if (trigger === 'auto') {
      if (shrink) {
        console.warn(`[AutoIndex] 素材清单 ${videos.length} 个，少于上次的 ${previous} 个，已跳过自动全库同步`);
        return false;
      }
      rememberLibraryVideoCount(library.id, videos.length);
      return true;
    }
    toast('正在核对素材清单与主题中的失效片段…', false, 2500);
    let preview = null;
    let previewError = '';
    try { preview = await Warehouse.previewPrune(library.path, videos); }
    catch (error) { previewError = error?.message || String(error); }
    if (!shrink && !previewError && !preview?.matches && trigger !== 'shortcut') {
      rememberLibraryVideoCount(library.id, videos.length);
      return true;
    }
    const body = [`将对当前库 ${videos.length} 个视频${mode === 'rebuild' ? '全量重建' : '同步'}索引${previous ? `（上次全库 ${previous} 个）` : ''}，并清理已不在库中的素材的索引记录。`];
    if (shrink) body.push(h('p', { className: 'form-error', text: `素材数量比上次少了 ${previous - videos.length} 个。如果 Eagle 仍在加载或同步，请取消并稍后再试，否则对应索引和主题片段会被清理。` }));
    if (previewError) body.push(h('p', { className: 'form-error', text: `无法预先统计主题清理：${previewError}` }));
    else if (preview.matches) {
      body.push(`索引完成后，${preview.topics} 个主题将移除共 ${preview.matches} 个已删除素材的片段（主题可从「备份 / 回收站」恢复）：`);
      const list = h('ul', { className: 'confirm-list' }, preview.affected.slice(0, 8)
        .map((topic) => h('li', { text: `${topic.name}：${topic.count}/${topic.total} 个片段` })));
      if (preview.affected.length > 8) list.append(h('li', { text: `…另有 ${preview.affected.length - 8} 个主题` }));
      body.push(list);
    } else body.push('主题中没有需要清理的片段。');
    const confirmed = await Dom.confirm({ title: mode === 'rebuild' ? '确认全量重建索引' : '确认索引整个库', body,
      confirmText: shrink ? '仍然继续' : '开始索引', danger: shrink || !!preview?.matches });
    if (confirmed) rememberLibraryVideoCount(library.id, videos.length);
    return confirmed;
  }

  async function startIndexing(mode, { trigger = 'button' } = {}) {
    if (Search.isBusy()) { toast('搜索进行中，请稍候再建索引'); return; }
    closeIndexModeMenu();
    await ensureIndexOutcomeBaseline();
    const result = await Indexer.start(mode, indexHandlers(), {
      beforeSubmit: (videos, library) => confirmFullIndex(mode, trigger, videos, library),
    });
    updateButtons();
    if (!result.started) {
      if (!result.cancelled) toast(result.message, true);
      else if (trigger === 'auto') console.warn('[AutoIndex]', result.message);
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

  // ---------- 搜索范围选择器（整库 / 跟随 Eagle 选中 / 指定 / 排除，均递归子文件夹）----------
  let scopeDialogChecked = new Set(); // 对话框内当前勾选的文件夹 id
  let scopeDialogExpanded = new Set(); // 展开状态按素材库记在本机，重新打开沿用
  let scopeFolderRoots = [];
  let scopeDialogTarget = null;
  const scopeExpandedKey = () => `scopeFolderExpanded:${SearchRecipe.normalize(eagle.library.path)}`;

  function loadScopeExpanded() {
    try {
      const ids = JSON.parse(localStorage.getItem(scopeExpandedKey()) || '[]');
      return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
    } catch { return new Set(); }
  }

  function saveScopeExpanded() {
    try { localStorage.setItem(scopeExpandedKey(), JSON.stringify([...scopeDialogExpanded])); } catch { /* 仅为便利，失败不影响范围 */ }
  }
  let scopeOperation = 0;
  let scopeContextGeneration = 0;
  let excludingFolder = false;

  function updateScopeButton() {
    const cfg = Config.get();
    let label = '范围: 整个库';
    if (cfg.scopeMode === 'selected') label = '范围: 跟随 Eagle 选中';
    else if (cfg.scopeMode === 'custom') label = `范围: ${cfg.scopeFolderIds.length} 个文件夹`;
    else if (cfg.scopeMode === 'exclude') label = `范围: 排除 ${cfg.scopeFolderIds.length} 个文件夹`;
    if (cfg.scopeExcludeFolderIds.length) label += `，另排除 ${cfg.scopeExcludeFolderIds.length} 个`;
    for (const id of ['btn-scope', 'topic-filter-scope']) {
      $(id).textContent = label;
      $(id).classList.toggle('scoped', cfg.scopeMode !== 'all');
    }
  }

  function resetSearchScope() {
    scopeOperation += 1;
    Config.setScope();
    Search.setScopeFilter(null, eagle.library.path);
    updateScopeButton();
  }

  /* 换库后文件夹 id 失效，自动回退为整库 */
  function resetScopeIfLibraryChanged() {
    const cfg = Config.get();
    if (cfg.scopeLibrary && cfg.scopeLibrary !== eagle.library.path) resetSearchScope();
  }

  function scopeContext() {
    return { library: eagle.library.path, generation: scopeContextGeneration, page: document.body.dataset.page,
      topic: document.body.dataset.topic === 'true' ? Warehouse.getScopeContext() : null };
  }

  function isScopeContextCurrent(target) {
    if (target.library !== eagle.library.path || target.generation !== scopeContextGeneration
        || target.page !== document.body.dataset.page || Search.isBusy()) return false;
    if (target.topic) {
      try {
        const current = Warehouse.getScopeContext();
        return current.id === target.topic.id && current.generation === target.topic.generation;
      } catch { return false; }
    }
    return document.body.dataset.topic !== 'true';
  }

  async function applySessionScope(config, target, shouldApply = () => true) {
    const operation = ++scopeOperation;
    let scope = { mode: 'all' };
    if (config.scopeMode === 'selected') {
      const folders = await eagle.folder.getSelected();
      if (!folders?.length) throw new Error('请先在 Eagle 中选中要搜索的文件夹');
      scope = { mode: 'folders', folderIds: folders.map((folder) => folder.id) };
    } else if (['custom', 'exclude'].includes(config.scopeMode)) {
      scope = { mode: config.scopeMode === 'custom' ? 'folders' : 'exclude', folderIds: config.scopeFolderIds };
    }
    if (config.scopeExcludeFolderIds?.length) scope.excludeFolderIds = config.scopeExcludeFolderIds;
    const resolved = await SearchRecipe.resolveScope(scope, { mode: 'all' });
    if (operation !== scopeOperation || !shouldApply()) return false;
    if (!isScopeContextCurrent(target)) throw new Error('页面或素材库已切换，请重新选择范围');
    Config.setScope({ ...config, scopeLibrary: target.library });
    Search.setScopeFilter(resolved.paths, target.library);
    updateScopeButton();
    return true;
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
          saveScopeExpanded();
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
        // 排除模式保留；其他模式勾选后切到指定文件夹。
        if (!document.querySelector('input[name="scope-mode"][value="exclude"]').checked) {
          document.querySelector('input[name="scope-mode"][value="custom"]').checked = true;
        }
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
    if (Search.isBusy()) return;
    resetScopeIfLibraryChanged();
    const target = scopeDialogTarget = scopeContext();
    const cfg = Config.get();
    scopeDialogChecked = new Set(cfg.scopeFolderIds || []);
    scopeDialogExpanded = loadScopeExpanded();
    scopeFolderRoots = [];
    document.querySelectorAll('input[name="scope-mode"]').forEach((r) => {
      r.checked = r.value === (cfg.scopeMode || 'all');
    });
    const tree = $('folder-tree');
    tree.innerHTML = '<p class="hint">读取文件夹列表…</p>';
    $('scope-dialog').showModal();
    $('scope-extra-exclusions').textContent = cfg.scopeExcludeFolderIds.length
      ? `当前指定范围内另排除了 ${cfg.scopeExcludeFolderIds.length} 个文件夹；点击应用将以本次选择替换完整范围。` : '';
    try {
      const roots = await Bridge.getFolderTree();
      if (!$('scope-dialog').open || target !== scopeDialogTarget || !isScopeContextCurrent(target)) return;
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

  async function applyScopeDialog() {
    const mode = document.querySelector('input[name="scope-mode"]:checked')?.value || 'all';
    const ids = ['custom', 'exclude'].includes(mode) ? [...scopeDialogChecked] : [];
    if (['custom', 'exclude'].includes(mode) && ids.length === 0) {
      toast('请先在列表中勾选至少一个文件夹', true);
      return;
    }
    const target = scopeDialogTarget;
    const shouldApply = () => $('scope-dialog').open && scopeDialogTarget === target;
    $('btn-scope-apply').disabled = true;
    try {
      const applied = await applySessionScope({ scopeMode: mode, scopeFolderIds: ids }, target, shouldApply);
      if (!applied || !shouldApply()) return;
      $('scope-dialog').close();
      updateScopeButton();
    } catch (error) { toast(error.message, true); }
    finally { $('btn-scope-apply').disabled = false; }
  }

  /* 按当前范围设置返回路径集合；整库返回 null（不过滤） */
  async function resolveSearchScope() {
    resetScopeIfLibraryChanged();
    const operation = scopeOperation;
    const target = scopeContext();
    const context = await SearchRecipe.currentContext();
    if (operation !== scopeOperation || !isScopeContextCurrent(target)) throw new Error('搜索范围或页面已改变，请重新搜索');
    Search.setScopeFilter(context.scopePaths, context.library);
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
    const actions = document.createElement('div'); actions.className = 'dialog-actions'; dialog.appendChild(actions);
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.onclick = () => dialog.close(); actions.appendChild(close);
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
        window.showLegacyMigration = () => LibraryTools.showLegacyMigration(legacy);
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
        await startIndexing('all', { trigger: 'auto' });
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
  function openRefineSearch() {
    if (!serviceOnline || Indexer.isRunning() || Search.isBusy()) return;
    const matches = Search.getAllMatches();
    if (!matches.length) { toast('当前筛选下没有可继续搜索的镜头'); return; }
    const recipe = Search.getRecipe();
    refineSource = { matches, library: eagle.library.path, modelName: recipe?.config.modelName,
      time: Search.getArchiveTime(), generation: refineContextGeneration,
      label: Warehouse.getCurrentName() || (recipe?.refinement
        ? `${recipe.refinement.label} → ${Search.getLastQuery()}` : Search.getLastQuery()) || '当前结果' };
    $('refine-search-summary').textContent = `在「${refineSource.label}」的 ${matches.length} 个镜头中继续搜索（包括尚未滚动显示的结果）。`;
    $('refine-search-query').value = '';
    $('refine-search-weight').value = 10;
    $('refine-search-old').textContent = '0';
    $('refine-search-new').textContent = '10';
    $('refine-search-error').textContent = '';
    $('refine-search-dialog').showModal();
    $('refine-search-query').focus();
  }

  async function doRefineSearch(event) {
    event.preventDefault();
    const source = refineSource;
    const query = $('refine-search-query').value.trim();
    if (!query || !source || $('refine-search-submit').disabled) return;
    const weight = Number($('refine-search-weight').value);
    $('refine-search-submit').disabled = true;
    try {
      // 候选已包含当前所有筛选；继续搜索无需再扫描全库解析文件夹或日期。
      const context = { config: SearchRecipe.options(Config.get()), library: source.library,
        scope: { mode: 'all' }, time: source.time, paths: null };
      if (source !== refineSource || source.generation !== refineContextGeneration
          || source.library !== eagle.library.path) return;
      if (!serviceOnline || Indexer.isRunning() || Search.isBusy()) throw new Error('搜索服务未就绪或正在处理其他任务');
      $('refine-search-dialog').close();
      hideResolvedIndexHintForSearch();
      const result = await Search.refine(query, Number($('threshold').value), context, source, weight);
      if (result.cancelled || result.stale) return;
      if (!result.ok) { toast(result.message, true, 5000); return; }
      $('query').value = query;
      SearchRecipe.writeTime(source.time);
      toast(result.count ? `在原结果中找到 ${result.count} 个匹配镜头` : '当前权重和阈值下没有结果，可调整权重或筛选条件');
      pushHistory(query);
    } catch (error) {
      if ($('refine-search-dialog').open) $('refine-search-error').textContent = error.message;
      else toast(`搜索出错：${error.message}`, true, 5000);
    } finally { updateButtons(); }
  }

  async function doSearch() {
    const query = $('query').value.trim();
    if (!query) return;
    hideResolvedIndexHintForSearch();
    const btn = $('btn-search');
    btn.disabled = true;
    btn.textContent = '搜索中…';
    try {
      const cfg = Config.get();
      const threshold = parseFloat($('threshold').value);
      const steps = ExampleSearch.parseSequence(query);
      if (steps) {
        // 「A → B」直接走时序搜索；每步按当前阈值在服务端过滤，不弹 AI 改写预览。
        Config.save({ threshold });
        const r = await ExampleSearch.sequence(steps, cfg.sequenceMaxGap ?? 5, threshold);
        ExampleSearch.report(r);
        if (r.ok) pushHistory(query);
        return;
      }
      let aiPlan = null;
      if (cfg.aiEnhance && cfg.aiPlanPreview && serviceOnline) {
        btn.textContent = 'AI 改写中…';
        aiPlan = await AiPlanReview.review(query, cfg);
        if (aiPlan === undefined) return;
        btn.textContent = '搜索中…';
      }
      const scope = await resolveSearchScope();
      Config.save({ threshold });
      const r = await Search.run(query, threshold, scope, aiPlan);
      if (r.cancelled || r.stale) return;
      if (!r.ok) toast(r.message, true, 5000);
      else if (r.count === 0) toast('当前筛选下没有结果，可调整筛选条件');
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

  // ---------- 设置（表单读写见 settingsPanel.js） ----------
  const openSettings = () => SettingsPanel.open();

  async function rebuildIndex() {
    $('settings-dialog').close();
    toast('开始全量重建当前库索引（清理失效条目并应用当前索引参数）…', false, 5000);
    await startIndexing('rebuild');
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
    $('btn-selection-timeline').disabled = Search.isBusy() || matches.length === 0;
    $('btn-selection-exclude-folder').disabled = organizing || excludingFolder || Search.isBusy()
      || targets.ids.length !== 1 || targets.missing > 0;
    // 预览区「⋯」菜单中的同类操作只作用于当前预览片段。
    const preview = Bridge.selectionTargets(previewMatches());
    for (const id of ['btn-preview-tag', 'btn-preview-folder']) {
      $(id).disabled = organizing || Search.isBusy() || preview.ids.length === 0;
    }
    const noPreview = Search.isBusy() || !Search.getActiveMatch();
    for (const id of ['btn-preview-topic-add', 'btn-preview-topic-remove', 'btn-preview-topic-score', 'btn-preview-timeline']) {
      $(id).disabled = noPreview;
    }
    $('btn-preview-exclude-folder').disabled = organizing || excludingFolder || Search.isBusy()
      || preview.ids.length !== 1 || preview.missing > 0;
    ExampleSearch.updateButtons();
  }

  const previewMatches = () => [Search.getActiveMatch()].filter(Boolean);

  /* getMatches：已选片段或当前预览片段；处理期间对象变化即放弃。 */
  async function excludeSelectedFolder(getMatches = () => Search.getSelectedMatches()) {
    const button = getMatches === previewMatches ? $('btn-preview-exclude-folder') : $('btn-selection-exclude-folder');
    if (button.disabled) return;
    const target = scopeContext();
    const itemId = Bridge.selectionTargets(getMatches()).ids[0];
    const stillSelected = () => {
      const selection = Bridge.selectionTargets(getMatches());
      return isScopeContextCurrent(target) && selection.ids.length === 1 && selection.ids[0] === itemId && !selection.missing;
    };
    excludingFolder = true;
    updateSelectionActions();
    let dialog;
    try {
      const folders = await Bridge.smallestItemFolders(itemId);
      if (!stillSelected()) return;
      let folder = folders[0];
      if (folders.length > 1) {
        folder = await new Promise((resolve) => {
          dialog = document.createElement('dialog');
          dialog.className = 'warehouse-batch-dialog';
          dialog.id = 'exclude-folder-dialog';
          const heading = document.createElement('h3');
          heading.textContent = '素材属于多个最小文件夹，请选择要排除的一个';
          dialog.appendChild(heading);
          const list = document.createElement('div');
          list.className = 'exclude-folder-options';
          folders.forEach((candidate) => {
            const button = document.createElement('button');
            button.type = 'button'; button.textContent = candidate.path;
            button.addEventListener('click', () => { resolve(candidate); dialog.close(); });
            list.appendChild(button);
          });
          dialog.appendChild(list);
          const cancel = document.createElement('button');
          cancel.textContent = '取消'; cancel.type = 'button';
          cancel.addEventListener('click', () => dialog.close());
          dialog.addEventListener('close', () => resolve(null), { once: true });
          dialog.appendChild(cancel); document.body.appendChild(dialog); dialog.showModal();
        });
      }
      if (!folder || !stillSelected()) return;
      const config = Config.get();
      const next = { scopeMode: config.scopeMode, scopeFolderIds: [...config.scopeFolderIds],
        scopeExcludeFolderIds: [...config.scopeExcludeFolderIds] };
      if (next.scopeMode === 'all') next.scopeMode = 'exclude';
      const ids = next.scopeMode === 'exclude' ? next.scopeFolderIds : next.scopeExcludeFolderIds;
      if (!ids.includes(folder.id)) ids.push(folder.id);
      if (await applySessionScope(next, target, stillSelected)) toast(`本次打开已排除「${folder.path}」及其子文件夹`);
    } catch (error) { toast(error.message, true); }
    finally { dialog?.remove(); excludingFolder = false; updateSelectionActions(); }
  }

  function openOrganize(kind, matches = Search.getSelectedMatches()) {
    if (organizing || Search.isBusy()) return;
    const targets = Bridge.selectionTargets(matches);
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
      const focusQuery = (tries = 30) => {
        const query = $('query');
        if (query.offsetParent !== null) { query.focus(); query.select(); return; }
        if (tries > 0) requestAnimationFrame(() => focusQuery(tries - 1));
      };
      // 主题页和仓库页隐藏搜索框，先回到新搜索（恢复原搜索会话）再聚焦。
      if ($('query').offsetParent === null) $('topic-search').click();
      focusQuery();
    }, { description: '聚焦搜索框' });

    // Ctrl+I: 开始索引（全库模式提交前一律确认）
    Shortcuts.register('ctrl+i', () => {
      if (!$('btn-index-primary').disabled) {
        startIndexing(indexMode, { trigger: 'shortcut' });
      }
    }, { description: '开始索引' });

    // Ctrl+B: 打开仓库。Ctrl+W 可能被宿主窗口当作关闭快捷键。
    Shortcuts.register('ctrl+b', () => {
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
    const keyLabel = (key) => ({ ctrl: 'Ctrl', escape: 'Esc' }[key] || key.toUpperCase());
    const dialog = h('dialog', { className: 'shortcuts-help-dialog' },
      h('h3', { text: '快捷键列表' }),
      h('div', { className: 'shortcuts-list' }, Shortcuts.getAll().map((s) => h('div', { className: 'shortcut-item' },
        h('span', { className: 'shortcut-keys' }, s.shortcut.split('+').map((key, i) => [i ? ' + ' : null, h('kbd', { text: keyLabel(key) })])),
        h('span', { text: s.description })))),
      h('div', { className: 'dialog-actions' },
        h('button', { type: 'button', text: '关闭', onclick: () => dialog.close() })));
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove());
  }

  // ---------- 初始化 ----------
  function wireEvents() {
    const menus = [...document.querySelectorAll('.compact-menu')];
    const filterMenu = $('result-filter-menu');
    const positionFilterMenu = () => {
      if (!filterMenu.open) return;
      const content = filterMenu.querySelector('.menu-content');
      const anchor = filterMenu.querySelector('summary').getBoundingClientRect();
      const top = Math.min(anchor.bottom + 7, window.innerHeight - 120);
      content.style.left = `${Math.max(12, Math.min(anchor.right - content.offsetWidth, window.innerWidth - content.offsetWidth - 12))}px`;
      content.style.top = `${top}px`;
      content.style.maxHeight = `${Math.max(100, window.innerHeight - top - 12)}px`;
    };
    window.addEventListener('resize', positionFilterMenu);
    const mainWorkspace = document.querySelector('.main-workspace');
    new ResizeObserver(positionFilterMenu).observe(mainWorkspace);
    mainWorkspace.addEventListener('scroll', positionFilterMenu, { passive: true });
    const selectionMenu = $('result-selection-menu');
    const selectionContent = selectionMenu.querySelector('.menu-content');
    const resetContextMenu = () => {
      selectionContent.classList.remove('result-context-menu');
      selectionContent.style.removeProperty('left');
      selectionContent.style.removeProperty('top');
    };
    const closeContextMenu = () => {
      if (!selectionContent.classList.contains('result-context-menu')) return;
      selectionMenu.open = false;
      resetContextMenu();
    };
    selectionMenu.querySelector('summary').addEventListener('click', resetContextMenu);
    $('results').addEventListener('contextmenu', (event) => {
      event.preventDefault();
      menus.forEach((menu) => { if (menu !== selectionMenu) menu.open = false; });
      selectionContent.classList.add('result-context-menu');
      selectionMenu.open = true;
      const box = selectionContent.getBoundingClientRect();
      selectionContent.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - box.width - 8))}px`;
      selectionContent.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - box.height - 8))}px`;
      selectionContent.querySelector('button:not(.hidden):not(:disabled)')?.focus({ preventScroll: true });
    });
    $('results').addEventListener('scroll', closeContextMenu);
    document.addEventListener('contextmenu', (event) => {
      if (!$('results').contains(event.target) && !selectionMenu.contains(event.target)) closeContextMenu();
    });
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('blur', closeContextMenu);
    document.addEventListener('search-context', () => { scopeContextGeneration += 1; closeContextMenu(); });
    document.addEventListener('search-scope-clear', resetSearchScope);
    document.addEventListener('search-busy', closeContextMenu);
    menus.forEach((menu) => {
      menu.addEventListener('toggle', () => {
        if (menu.open) menus.forEach((other) => { if (other !== menu) other.open = false; });
        else if (menu === selectionMenu) resetContextMenu();
        if (menu === filterMenu) positionFilterMenu();
      });
      menu.addEventListener('click', (event) => {
        if (event.target.closest('button') && menu.id !== 'result-filter-menu') menu.open = false;
      });
    });
    document.addEventListener('click', (event) => {
      menus.forEach((menu) => { if (!menu.contains(event.target)) menu.open = false; });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menus.some((menu) => menu.open)) {
        const menu = menus.find((value) => value.open);
        menus.forEach((value) => { value.open = false; });
        menu.querySelector('summary').focus();
      }
    });
    Search.setSelectionHandler(updateSelectionActions);
    $('btn-clear-selection').addEventListener('click', () => Search.clearSelection());
    document.addEventListener('search-busy', updateSelectionActions);
    $('btn-selection-tag').addEventListener('click', () => openOrganize('tag'));
    $('btn-selection-folder').addEventListener('click', () => openOrganize('folder'));
    $('btn-selection-exclude-folder').addEventListener('click', () => excludeSelectedFolder());
    $('btn-preview-tag').addEventListener('click', () => openOrganize('tag', previewMatches()));
    $('btn-preview-exclude-folder').addEventListener('click', () => excludeSelectedFolder(previewMatches));
    // 预览区「⋯」：预览区会裁剪溢出，菜单 fixed 定位贴在按钮下方（空间不足时翻到上方）。
    const previewMenus = [$('preview-more-menu'), $('continuation-menu')];
    const closePreviewMenu = () => previewMenus.forEach((menu) => { menu.open = false; });
    document.addEventListener('preview-change', () => { closePreviewMenu(); updateSelectionActions(); });
    previewMenus.forEach((menu) => menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      const content = menu.querySelector('.menu-content');
      const anchor = menu.querySelector('summary').getBoundingClientRect();
      const box = content.getBoundingClientRect();
      const below = anchor.bottom + 6;
      const top = below + box.height > window.innerHeight - 8 ? Math.max(8, anchor.top - 6 - box.height) : below;
      content.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))}px`;
      content.style.top = `${top}px`;
    }));
    $('preview-panel').addEventListener('scroll', closePreviewMenu, { passive: true });
    $('inspector').addEventListener('scroll', closePreviewMenu, { passive: true });
    window.addEventListener('resize', closePreviewMenu);
    $('btn-preview-topic-add').addEventListener('click', () => {
      try { ManualAdd.openFor(previewMatches()); } catch (error) { toast(error.message, true); }
    });
    $('btn-preview-folder').addEventListener('click', () => openOrganize('folder', previewMatches()));
    const timelineName = () => Warehouse.getCurrentName() || Search.getLastQuery() || '语义搜索片段';
    $('btn-preview-timeline').addEventListener('click', () => TimelineExport.exportMatches(previewMatches(), timelineName()));
    $('btn-selection-timeline').addEventListener('click', () => {
      closeContextMenu();
      selectionMenu.open = false;
      TimelineExport.exportMatches(Search.getSelectedMatches() || [], timelineName());
    });
    $('btn-export-timeline-all').addEventListener('click', (event) => {
      event.target.closest('details').open = false;
      TimelineExport.exportMatches(Search.getAllMatches(), timelineName());
    });
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
      if (document.body.dataset.topic !== 'true' && document.body.dataset.page !== 'warehouse') {
        Search.setArchiveFilter({ ...Search.getArchiveFilter(), minScore: Number($('threshold').value) || null });
      }
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
    $('btn-restart-service').addEventListener('click', SettingsPanel.restartService);
    $('btn-rebuild-index').addEventListener('click', rebuildIndex);
    $('btn-view-log').addEventListener('click', SettingsPanel.viewServiceLog);
    $('btn-index-jobs').addEventListener('click', openIndexJobs);
    $('btn-refresh-library').addEventListener('click', async () => {
      try { Bridge.invalidateCache(); await Bridge.refreshPathMap(true); toast('素材缓存已刷新，下次搜索使用最新素材范围'); }
      catch (error) { toast(error.message, true); }
    });
    // 视图栏：排序 / 时长过滤 / 分组
    $('view-sort').addEventListener('change', () => Search.setView({ sortBy: $('view-sort').value }));
    $('view-min-dur').addEventListener('change', () => {
      try {
        const input = $('view-min-dur');
        if (!input.validity.valid) throw new Error('请输入有效的非负时长下限');
        Search.setView({ minDur: input.value === '' ? 0 : Number(input.value) });
      } catch (error) { $('view-min-dur').value = Search.getView().minDur; toast(error.message, true); }
    });
    $('view-grouped').addEventListener('change', () => {
      Search.setView({ grouped: $('view-grouped').checked });
    });
    $('btn-save-results').addEventListener('click', saveResults);
    $('btn-refine-results').addEventListener('click', openRefineSearch);
    $('refine-search-form').addEventListener('submit', doRefineSearch);
    $('refine-search-cancel').addEventListener('click', () => $('refine-search-dialog').close());
    $('refine-search-dialog').addEventListener('close', () => { refineSource = null; });
    $('refine-search-weight').addEventListener('input', () => {
      const weight = Number($('refine-search-weight').value);
      $('refine-search-old').textContent = 10 - weight;
      $('refine-search-new').textContent = weight;
    });
    $('result-refine-weight').addEventListener('input', () => {
      try { Search.setRefinementWeight(Number($('result-refine-weight').value)); }
      catch (error) { toast(error.message, true); }
    });
    document.addEventListener('search-context', () => {
      refineContextGeneration += 1;
      if ($('refine-search-dialog').open) $('refine-search-dialog').close();
      updateButtons();
    });
    $('btn-scope').addEventListener('click', () => openScopeDialog());
    $('topic-filter-scope').addEventListener('click', () => openScopeDialog(true));
    $('btn-scope-apply').addEventListener('click', applyScopeDialog);
    $('btn-scope-cancel').addEventListener('click', () => $('scope-dialog').close());
    document.addEventListener('paste', handlePaste);
    $('btn-settings').addEventListener('click', openSettings);
    $('settings-form').addEventListener('submit', (event) => SettingsPanel.save(event));
    $('btn-recover-settings').addEventListener('click', (event) => SettingsPanel.save(event, true));
    $('btn-cancel-settings').addEventListener('click', () => $('settings-dialog').close());
    document.addEventListener('click', (e) => {
      if (!$('index-mode-menu').classList.contains('hidden')
          && !e.target.closest('#index-mode-picker')) {
        closeIndexModeMenu();
      }
    });
    document.addEventListener('search-busy', updateButtons);
    document.addEventListener('search-selection', updateButtons);
    document.addEventListener('frame-search-busy', updateButtons);
    document.addEventListener('shot-analysis-busy', updateButtons);
  }

  eagle.onPluginCreate((plugin) => {
    Config.init(plugin.path);
    ThumbDiskCache.init(require('path').join(plugin.path, 'cache', 'thumbnails'));
    Search.configureThumbnailCache(Config.get());
    Config.onError?.((message) => toast(message, true, 7000));
    if (Config.getLoadError?.()) toast(Config.getLoadError(), true, 10000);
    applyTheme();
    Search.bindDom();
    MediaDrag.init({ toast });
    Warehouse.init({ toast, canSearch: () => serviceOnline && !Indexer.isRunning() });
    LayoutPanels.init();
    LibraryTools.init({ isServiceOnline: () => serviceOnline });
    ShotAnalysis.init({ canAnalyze: () => serviceOnline && !Indexer.isRunning() });
    wireEvents();
    FrameSearch.init({ toast,
      canSearch: () => serviceOnline && !Indexer.isRunning(),
      resolveScope: resolveSearchScope,
    });
    SettingsPanel.init({
      setServiceStatus,
      applied: () => {
        applyTheme();
        Search.configureThumbnailCache(Config.get());
        applyAutoIndexSetting();
      },
    });
    ExampleSearch.init({
      isServiceOnline: () => serviceOnline && !Indexer.isRunning(),
      resolveScope: async () => { hideResolvedIndexHintForSearch(); return resolveSearchScope(); },
      closeMenus: () => {
        const menu = $('result-selection-menu');
        const content = menu.querySelector('.menu-content');
        menu.open = false;
        content.classList.remove('result-context-menu');
        content.style.removeProperty('left');
        content.style.removeProperty('top');
      },
      afterSearch: () => updateButtons(),
    });
    EvalRecorder.init({ pluginPath: Config.pluginPath(), isServiceOnline: () => serviceOnline && !Indexer.isRunning() });
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
    pluginReady = true;
    if (showPending || document.visibilityState === 'visible') showPlugin({ fromInit: true });
  });

  let skipInitialShow = false;
  function showPlugin({ fromInit = false } = {}) {
    if (!pluginReady) { showPending = true; return; }
    // 已收到过宿主显示事件时，初始化只是重放它，不再等待第二次事件。
    if (fromInit) skipInitialShow = !showPending;
    else if (skipInitialShow) { skipInitialShow = false; return; }
    showPending = false;
    WarehouseNavigation.save();
    resetSearchScope();
    WarehouseNavigation.show();
    if (!serviceOnline) {
      setServiceStatus('starting', '加载搜索服务…');
      Service.ensure(setServiceStatus);
    }
    else if (!Indexer.isRunning()) refreshIndexHint();
  }

  // 窗口隐藏后，下一次显示一定是重开，不能当作初始化的重复事件。
  document.addEventListener('visibilitychange', () => { if (document.hidden) skipInitialShow = false; });
  eagle.onPluginShow(() => showPlugin());

  eagle.onThemeChanged(() => applyTheme());

  eagle.onLibraryChanged(() => {
    // 换库后：索引名、路径映射、结果全部失效
    location.reload();
  });
})();
