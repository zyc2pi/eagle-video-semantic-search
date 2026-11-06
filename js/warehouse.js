/* 仓库入口、主题加载与浏览恢复，统一协调子模块及跨库导航。 */
const Warehouse = (() => {
  const $ = Dom.$;
  let hooks;
  let data;
  let current = null;
  let currentLibrary = null;
  let searchSession = null; // 打开第一个主题前的独立搜索状态，主题间切换不覆盖。
  let searchBrowsePosition = null;
  let categoryLibrary = null;
  let coverSaving = false;
  let scenesSaving = false;
  let cleaning = false;
  let lastRemoval = null;
  let removedSession = null;
  const localTimes = new Map();
  const localFilters = new Map();
  const topicPositions = new Map();
  const warehousePositions = new Map();
  let navigationGeneration = 0;
  let restoringBrowseGeneration = -1;
  const beginNavigation = () => ({ generation: ++navigationGeneration, library: eagle.library.path });
  const currentNavigation = (navigation) => navigation.generation === navigationGeneration
    && navigation.library === eagle.library.path;
  let sceneQueryTimer;
  let positionNoticeTimer;
  let positionHideTimer;
  let positionTarget = null;
  let itemsById = new Map();
  let undoManager = null;
  const pageSize = 60;
  const timeKey = (entry) => `${SearchRecipe.normalize(eagle.library.path)}:${entry.id}`;
  const localTime = (entry) => localTimes.get(timeKey(entry)) || { mode: 'all' };
  const localFilter = (entry) => localFilters.get(timeKey(entry)) || { query: '', source: 'all' };
  // 子模块持有各自的 UI 状态，跨页导航和当前主题由此处统一协调。
  const shared = { $, node, dateText, countVideos, categoryName, categoryOptions,
    categoryPicker: (id, library) => WarehouseCategories.picker(id, library, data.categories),
    rememberCategory: WarehouseCategories.remember,
    store, checkIdle, attempt, beginNavigation, currentNavigation,
    load: (...args) => load(...args),
    toast: (...args) => hooks.toast(...args),
    current: () => current, currentLibrary: () => currentLibrary,
    setData: (snapshot) => { data = snapshot; } };
  const cards = WarehouseCards.create({ ...shared,
    getData: () => data, hidePositionNotice, showPositionNotice, forgetWarehousePosition,
    editEntry: (entry) => editor.editEntry(entry), toggleFavorite,
    refreshEntry: (...args) => updates.refreshEntry(...args), detachTopic });
  const updates = WarehouseUpdates.create({ ...shared,
    requireTopic, syncSceneActions, editEntry: (entry) => editor.editEntry(entry), renderCards: () => renderCards(),
    warnings: () => data?.warnings || [], canSearch: () => hooks.canSearch() });
  const editor = WarehouseEditor.create({ ...shared,
    reloadData: () => { data = store().list(); },
    isUpdating: updates.isUpdating, refreshEntry: updates.refreshEntry, copyTopic: updates.copyTopic,
    renderCards, confirmButton, detachTopic, open });

  function renderCards(position = null) { cards.render(position); syncBatchUpdate(); }

  /* 批量更新范围与仓库分类筛选一致：全部分类或所选分类（含子分类）；不受名称查找与常用筛选影响。 */
  function batchScope() {
    const category = $('warehouse-category').value;
    if (category === '*') return { label: '全部主题', include: () => true };
    const ids = ArchiveStore.categoryTree(data.categories).byId.get(category)?.ids || new Set([category]);
    return { label: `分类「${categoryName(category)}」`, include: (entry) => ids.has(entry.categoryId || '') };
  }

  function syncBatchUpdate() {
    const button = $('warehouse-update-all');
    if (!button) return;
    const all = $('warehouse-category').value === '*';
    button.textContent = all ? '全部更新' : '更新该分类全部主题';
    const ready = !!hooks?.canSearch();
    const busy = cleaning || updates.isBusy() || coverSaving || scenesSaving || Search.isBusy();
    button.disabled = !ready || busy;
    button.title = !ready ? '搜索服务未就绪或正在建索引，暂不能更新'
      : `按各主题保存的搜索条件依次重新搜索${all ? '全部主题' : '该分类（含子分类）的主题'}，汇总变化后勾选写入`;
  }
  function recoveryDialog() { WarehouseRecovery.open({ ...shared, detachTopic, open }); }

  function filteredMatches(entry) {
    return SearchRecipe.filterMatches(entry.matches, localTime(entry),
      (match) => itemsById.get(match.eagleItemId) || Bridge.itemForPath(match.video_path));
  }
  function countText(entry) {
    const matches = filteredMatches(entry);
    return `${countVideos(matches)} 个素材 / ${matches.length} 个片段`
      + (localTime(entry).mode !== 'all' ? `（已存 ${entry.matches.length} 个）` : '');
  }

  function store() { return ArchiveStore.open(Config.pluginPath(), eagle.library.path); }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }
  function dateText(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '时间未知';
  }
  function countVideos(matches) {
    return new Set(matches.map((m) => m.eagleItemId || SearchRecipe.normalize(m.video_path))).size;
  }
  function categoryName(id) { return ArchiveStore.categoryTree(data.categories).byId.get(id)?.path || '未分类'; }
  function categoryOptions(select, all = false, selected = '') {
    select.replaceChildren();
    if (all) select.appendChild(new Option('全部分类', '*'));
    select.appendChild(new Option('未分类', ''));
    ArchiveStore.categoryTree(data.categories).items.forEach((category) => select.appendChild(new Option(category.path, category.id)));
    select.value = selected;
    if (select.selectedIndex < 0) select.value = all ? '*' : '';
  }

  function timeControl(saved, onChange) {
    const element = node('div', 'warehouse-time-control');
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', '筛选已存结果的素材加入时间');
    element.title = '即时筛选已保存结果；缺少加入 Eagle 时间的素材不参与时间筛选';
    const label = node('label', 'warehouse-time-label');
    const select = node('select', 'warehouse-time-select');
    select.setAttribute('aria-label', '筛选时间范围');
    [['all', '不限时间'], ['6', '近半年'], ['12', '近 1 年'], ['24', '近 2 年'],
      ['36', '近 3 年'], ['48', '近 4 年'], ['60', '近 5 年'], ['custom', '自定义日期']]
      .forEach(([value, text]) => select.appendChild(new Option(text, value)));
    select.value = saved?.mode || 'all';
    label.appendChild(select);
    const dates = node('div', 'warehouse-time-dates');
    const start = node('input'); start.type = 'date'; start.value = saved?.start || '';
    start.setAttribute('aria-label', '开始日期');
    const end = node('input'); end.type = 'date'; end.value = saved?.end || '';
    end.setAttribute('aria-label', '结束日期');
    dates.append(start, node('span', '', '至'), end);
    dates.classList.toggle('hidden', select.value !== 'custom');
    const hint = node('small', 'hint', '');
    hint.setAttribute('aria-live', 'polite');
    const apply = () => {
      dates.classList.toggle('hidden', select.value !== 'custom');
      const time = select.value === 'custom'
        ? { mode: 'custom', start: start.value, end: end.value } : { mode: select.value };
      try {
        SearchRecipe.bounds(time);
        onChange(time);
        hint.textContent = '';
      } catch (error) {
        hint.textContent = `${error.message}（仍保留上次筛选）`;
      }
    };
    select.addEventListener('change', apply);
    start.addEventListener('change', apply);
    end.addEventListener('change', apply);
    element.append(label, dates, hint);
    return { element };
  }
  function checkIdle() {
    if (cleaning || updates.isBusy() || coverSaving || scenesSaving || Search.isBusy()) throw new Error('已有搜索、更新、清理或保存正在进行，请稍候');
  }
  async function attempt(action) {
    try { await action(); } catch (error) { hooks.toast(error.message, true, 6500); }
    finally { WarehouseNavigation.refresh(); }
  }

  function syncUndoActions() {
    const button = $('btn-organize-undo');
    if (!button) return;
    button.classList.toggle('hidden', !current || currentLibrary !== eagle.library.path || document.body.dataset.topic !== 'true');
    const pending = updates.isBusy() || coverSaving || scenesSaving || Search.isBusy();
    const next = undoManager?.peek();
    button.disabled = pending || !undoManager?.canUndo();
    button.title = next ? `撤销${next.label}「${next.targetName}」（Ctrl+Z）`
      : '撤销最近一次收录或改分（Ctrl+Z，本次会话最多 20 步）';
    button.setAttribute('aria-label', next ? button.title : '没有可撤销的整理');
  }

  function applyManualEntry(entry) {
    if (typeof TopicRelations !== 'undefined') TopicRelations.refresh();
    if (current?.id === entry.id && currentLibrary === eagle.library.path) applySceneEdit(entry);
    else if (data?.entries && SearchRecipe.normalize(data.library) === SearchRecipe.normalize(eagle.library.path)) {
      const index = data.entries.findIndex((value) => value.id === entry.id);
      if (index >= 0) data.entries[index] = entry;
    }
    if (document.body.dataset.page === 'warehouse') {
      rememberWarehousePosition();
      data = store().list();
      renderCards(warehousePositions.get(SearchRecipe.normalize(eagle.library.path)));
    }
  }

  function undoManualEdit() {
    checkIdle();
    if (document.querySelector('dialog[open]')) throw new Error('请先关闭当前面板，再撤销收录或评分');
    const result = undoManager?.undo();
    if (!result?.undone) return;
    hooks.toast(result.refreshError ? '整理已撤销，界面刷新失败，请重新打开主题'
      : `已撤销${result.record.label}「${result.record.targetName}」`, !!result.refreshError);
    syncUndoActions();
  }

  function toggleFavorite(entry) {
    checkIdle();
    const library = eagle.library.path;
    if (SearchRecipe.normalize(data?.library) !== SearchRecipe.normalize(library)
        || (document.body.dataset.page === 'warehouse' ? cards.state.library !== library : currentLibrary !== library)) {
      throw new Error('素材库已切换，请重新打开主题后操作');
    }
    const result = store().setFavorite(entry.id, entry.favorite !== true, entry.updatedAt, entry.revision || 0);
    if (current?.id === entry.id && currentLibrary === library) {
      Object.assign(current, result); syncTopic();
    }
    if (document.body.dataset.page === 'warehouse') {
      rememberWarehousePosition();
      data = store().list();
      renderCards(warehousePositions.get(SearchRecipe.normalize(library)));
    } else {
      const saved = data?.entries.find((value) => value.id === entry.id);
      if (saved) Object.assign(saved, result);
    }
    hooks.toast(result.favorite ? `已将「${entry.name}」设为常用` : `已取消「${entry.name}」的常用标记`);
  }

  function hidePositionNotice() {
    clearTimeout(positionNoticeTimer);
    clearTimeout(positionHideTimer);
    positionTarget = null;
    $('browse-position-notice').classList.remove('visible');
    $('browse-position-notice').classList.add('hidden');
  }
  function showPositionNotice(root, resume = null) {
    hidePositionNotice();
    positionTarget = { root, library: eagle.library.path, page: document.body.dataset.page, resume };
    const notice = $('browse-position-notice');
    $('browse-position-message').textContent = resume ? '继续上次的浏览' : '已回到上次浏览位置';
    $('browse-position-resume').classList.toggle('hidden', !resume);
    $('browse-position-top').classList.toggle('hidden', !!resume);
    notice.classList.remove('hidden');
    void notice.offsetWidth;
    notice.classList.add('visible');
    positionNoticeTimer = setTimeout(() => {
      notice.classList.remove('visible');
      positionHideTimer = setTimeout(hidePositionNotice, 240);
    }, resume ? 4000 : 2000);
  }
  function rememberTopicPosition() {
    // 捕获浏览状态不会取消筛选输入的防抖应用，导航时单独清理。
    if (restoringBrowseGeneration !== -1) return;
    if (!current || currentLibrary !== eagle.library.path || document.body.dataset.page === 'warehouse') return;
    const filter = Search.getArchiveFilter();
    localFilters.set(timeKey(current), filter);
    const { query, source, tags, orientation, maxDur, minScore, membership, videoLimit, queryHits } = filter;
    topicPositions.set(timeKey(current), { view: Search.getView(), position: Search.captureBrowsePosition(),
      filter: { query, source, tags, orientation, maxDur, minScore, membership, videoLimit, queryHits }, time: localTime(current) });
  }
  function rememberWarehousePosition() {
    if (document.body.dataset.page !== 'warehouse' || cards.state.library !== eagle.library.path) return;
    const grid = $('warehouse-grid');
    const rect = grid.getBoundingClientRect();
    const anchor = [...grid.querySelectorAll('.warehouse-card')].find((card) => card.getBoundingClientRect().bottom > rect.top);
    warehousePositions.set(SearchRecipe.normalize(cards.state.library), {
      query: $('warehouse-query').value, category: $('warehouse-category').value, viewMode: cards.state.viewMode,
      favoritesOnly: cards.state.favoritesOnly,
      rendered: cards.state.rendered, scrollTop: grid.scrollTop,
      anchorId: anchor?.dataset.entryId || null,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - rect.top : 0,
    });
  }
  function forgetWarehousePosition() {
    if (cards.state.library) warehousePositions.delete(SearchRecipe.normalize(cards.state.library));
  }
  async function restoreTopicPosition(position) {
    const library = eagle.library.path;
    const generation = navigationGeneration;
    const restored = await Search.restoreBrowsePosition(position);
    if (restored && generation === navigationGeneration && library === eagle.library.path) showPositionNotice($('results'));
  }

  function showSearch({ preserveNavigation = false } = {}) {
    cards.cancelBoxSelection();
    if (!preserveNavigation) navigationGeneration += 1;
    rememberWarehousePosition();
    hidePositionNotice();
    cards.closeContextMenu();
    cards.clearQuery();
    document.body.dataset.page = 'search';
    $('warehouse-page').classList.add('hidden');
    WarehouseNavigation.refresh();
    if (typeof TopicRelations !== 'undefined') TopicRelations.refresh();
  }
  function detachTopic(resetTime = true) {
    navigationGeneration += 1;
    clearTimeout(sceneQueryTimer);
    clearRemovalUi();
    current = null;
    currentLibrary = null;
    searchSession = null;
    searchBrowsePosition = null;
    document.body.dataset.topic = 'false';
    $('warehouse-topic').classList.add('hidden');
    $('topic-scene-filter').classList.remove('hidden');
    $('btn-save-results').textContent = '保存到仓库';
    $('preview-cover-actions').classList.add('hidden');
    syncSceneActions();
    if (resetTime) Search.setArchiveTime({ mode: 'all' });
  }
  async function returnToSearch() {
    checkIdle();
    const navigation = beginNavigation();
    const library = eagle.library.path;
    clearTimeout(sceneQueryTimer);
    rememberTopicPosition();
    const session = searchSession;
    const sameLibrary = session?.state.library === SearchRecipe.normalize(eagle.library.path);
    if (sameLibrary && session.state.filter?.membership && session.state.filter.membership !== 'all') {
      await TopicRelations.ensure().catch((error) => hooks.toast(error.message, true));
    }
    if (!currentNavigation(navigation) || library !== eagle.library.path || session !== searchSession) return;
    checkIdle();
    detachTopic(false);
    Search.restoreState(sameLibrary ? session.state : null);
    $('query').value = sameLibrary ? session.queryInput : '';
    const view = Search.getView();
    $('view-sort').value = view.sortBy;
    $('view-min-dur').value = view.minDur;
    $('view-grouped').checked = view.grouped;
    showSearch();
    await restoreTopicPosition(sameLibrary ? session.state.position : null);
    $('query').focus();
  }

  async function open(options = {}) {
    await attempt(async () => {
      checkIdle();
      const navigation = beginNavigation();
      clearTimeout(sceneQueryTimer);
      rememberTopicPosition();
      rememberWarehousePosition();
      if (!current && document.body.dataset.page !== 'warehouse') searchBrowsePosition = Search.captureBrowsePosition();
      const library = eagle.library.path;
      const position = options.category !== undefined ? null : warehousePositions.get(SearchRecipe.normalize(library));
      try { data = store().list(); }
      catch (error) { recoveryDialog(); throw error; }
      const pathMap = await Bridge.refreshPathMap();
      if (!currentNavigation(navigation)) return;
      checkIdle();
      itemsById = new Map([...pathMap.values()].map((item) => [item.id, item]));
      Search.pausePreview();
      $('warehouse-query').value = position?.query ?? (cards.state.library === library ? $('warehouse-query').value : '');
      categoryOptions($('warehouse-category'), true, position?.category ?? (cards.state.library === library ? $('warehouse-category').value || '*' : '*'));
      if (position) cards.state.viewMode = position.viewMode;
      cards.state.favoritesOnly = position?.favoritesOnly ?? (cards.state.library === library ? cards.state.favoritesOnly : false);
      if (options.category !== undefined) {
        $('warehouse-query').value = '';
        $('warehouse-category').value = options.category;
        cards.state.favoritesOnly = options.favoritesOnly === true;
      }
      cards.state.library = library;
      cards.syncViewButtons();
      document.body.dataset.page = 'warehouse';
      $('warehouse-page').classList.remove('hidden');
      renderCards(position);
    });
  }

  function syncTopicMeta() {
    $('topic-meta').textContent = `${countText(current)} · 最近更新 ${dateText(current.updatedAt)}`;
  }

  function clearRemovalUi() {
    lastRemoval = null;
    removedSession = null;
    $('topic-removal-notice').classList.add('hidden');
    if ($('topic-removed-dialog').open) $('topic-removed-dialog').close();
    cards.closeContextMenu();
  }

  function syncSceneActions() {
    const hasTopic = !!current && currentLibrary === eagle.library.path && document.body.dataset.topic === 'true';
    const saving = updates.isBusy() || coverSaving || scenesSaving || Search.isBusy();
    syncUndoActions();
    syncBatchUpdate();
    $('btn-topic-add').disabled = saving || !(Search.getSelectedMatches() || []).length;
    $('btn-topic-remove').classList.toggle('hidden', !hasTopic);
    $('btn-topic-remove').disabled = !hasTopic || saving || !(Search.getSelectedMatches() || []).length;
    $('btn-topic-score').classList.toggle('hidden', !hasTopic);
    $('btn-topic-score').disabled = !hasTopic || saving || !(Search.getSelectedMatches() || []).length;
    $('topic-removed').disabled = saving;
    if ($('topic-history')) $('topic-history').disabled = !hasTopic || saving;
    $('topic-removal-undo').disabled = saving;
    if (!current) return;
    const removed = current.removedMatches || [];
    $('topic-removed').textContent = `已移除 (${removed.length})`;
    if (lastRemoval?.id === current.id && lastRemoval.library === eagle.library.path) {
      const keys = new Set(removed.map((record) => record.key));
      lastRemoval.keys = lastRemoval.keys.filter((key) => keys.has(key));
      if (!lastRemoval.keys.length) lastRemoval = null;
    }
    $('topic-removal-notice').classList.toggle('hidden', !lastRemoval);
    if (lastRemoval) $('topic-removal-message').textContent = `已从主题移除 ${lastRemoval.keys.length} 个片段，更新时也会排除。`;
  }

  function requireTopic(id = current?.id, library = currentLibrary) {
    checkIdle();
    if (!current || current.id !== id || currentLibrary !== library || eagle.library.path !== library
        || SearchRecipe.normalize(data?.library) !== SearchRecipe.normalize(library)) {
      throw new Error('主题或素材库已切换，请重新打开主题后操作');
    }
  }

  function applySceneEdit(entry) {
    rememberTopicPosition();
    const position = topicPositions.get(timeKey(entry))?.position;
    current = entry;
    const matches = entry.matches.map((match) => {
      const item = itemsById.get(match.eagleItemId) || Bridge.itemForPath(match.video_path);
      return item ? { ...match, video_path: item.filePath, video_name: item.name } : match;
    });
    Search.replaceResults(matches, entry.newKeys || []);
    const index = data.entries.findIndex((value) => value.id === entry.id);
    if (index >= 0) data.entries[index] = entry;
    syncTopic();
    restoreTopicPosition(position);
    if (removedSession?.id === entry.id) {
      removedSession.records = entry.removedMatches || [];
      renderRemovedMatches();
    }
  }

  function removeTopicMatches(matches) {
    requireTopic();
    const keys = [...new Set((matches || []).map(ArchiveStore.sceneKey))];
    if (!keys.length) return;
    scenesSaving = true;
    syncSceneActions();
    try {
      const result = store().removeMatches(current.id, keys, current.updatedAt, current.revision || 0);
      if (!result.keys.length) { hooks.toast('这些片段已不在当前主题中'); return; }
      lastRemoval = { id: current.id, library: eagle.library.path, keys: result.keys };
      applySceneEdit(result.entry);
      hooks.toast(`已从主题移除 ${result.keys.length} 个片段`);
    } finally { scenesSaving = false; syncSceneActions(); }
  }

  function restoreTopicMatches(keys, id = current?.id, library = currentLibrary) {
    requireTopic(id, library);
    scenesSaving = true;
    syncSceneActions();
    try {
      const result = store().restoreMatches(current.id, keys, current.updatedAt, current.revision || 0);
      applySceneEdit(result.entry);
      hooks.toast(result.keys.length ? `已恢复 ${result.keys.length} 个片段` : '这些片段已恢复');
    } finally { scenesSaving = false; syncSceneActions(); }
  }

  function removedMatchesForView() {
    const query = $('topic-removed-query').value.trim().toLowerCase();
    return (removedSession?.records || []).filter((record) => {
      const item = itemsById.get(record.match.eagleItemId) || Bridge.itemForPath(record.match.video_path);
      return `${item?.name || record.match.video_name || ''} ${record.match.video_path}`.toLowerCase().includes(query);
    });
  }

  function syncRemovedSelection() {
    const records = removedMatchesForView();
    const visible = new Set(records.map((record) => record.key));
    for (const key of removedSession.selected) if (!visible.has(key)) removedSession.selected.delete(key);
    const count = removedSession.selected.size;
    $('topic-removed-all').checked = records.length > 0 && count === records.length;
    $('topic-removed-all').indeterminate = count > 0 && count < records.length;
    $('topic-removed-all').disabled = !records.length;
    $('topic-removed-restore').disabled = !count || scenesSaving;
    $('topic-removed-status').dataset.error = 'false';
    $('topic-removed-status').textContent = `已选择 ${count} 个 / 当前列表 ${records.length} 个片段`;
  }

  function removedSceneTime(match, end = false) {
    const frame = end ? (match.original_end_frame ?? match.end_frame) : (match.original_start_frame ?? match.start_frame);
    const fps = Number(match.fps) > 0 ? Number(match.fps) : 25;
    const milliseconds = Math.max(0, Math.round((Number(frame) || 0) / fps * 1000));
    const seconds = Math.floor(milliseconds / 1000);
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map((part) => String(part).padStart(2, '0')).join(':') + `.${String(milliseconds % 1000).padStart(3, '0')}`;
  }

  function renderRemovedMatches() {
    if (!removedSession) return;
    const list = $('topic-removed-list');
    list.replaceChildren();
    const records = removedMatchesForView();
    syncRemovedSelection();
    if (!records.length) {
      list.append(node('p', 'hint', removedSession.records.length ? '没有符合搜索条件的已移除片段' : '暂无已移除片段'));
      return;
    }
    let shown = 0;
    const more = node('button', 'removed-scene-more', '加载更多'); more.type = 'button';
    const appendChunk = () => {
      more.remove();
      for (const record of records.slice(shown, shown + pageSize)) {
        const match = record.match;
        const item = itemsById.get(match.eagleItemId) || Bridge.itemForPath(match.video_path);
        const row = node('label', 'removed-scene-row'); row.title = item?.filePath || match.video_path;
        const pick = node('input'); pick.type = 'checkbox'; pick.value = record.key;
        pick.checked = removedSession.selected.has(record.key);
        pick.addEventListener('change', () => {
          if (pick.checked) removedSession.selected.add(record.key); else removedSession.selected.delete(record.key);
          syncRemovedSelection();
        });
        const image = node('img'); image.alt = '';
        Search.loadThumbnail(image, Api.previewUrl(item?.filePath || match.video_path,
          match.original_start_frame ?? match.start_frame ?? 0), () => {
          if (item?.thumbnailURL) Search.loadThumbnail(image, item.thumbnailURL, () => image.remove());
          else image.remove();
        });
        const info = node('span', 'removed-scene-info');
        info.append(node('b', '', item?.name || match.video_name || match.video_path),
          node('span', '', `${removedSceneTime(match)} – ${removedSceneTime(match, true)}`),
          node('small', '', `移除于 ${dateText(record.removedAt)}${item ? '' : ' · 素材已不在库中'}`));
        row.append(pick, image, info); list.append(row);
      }
      shown += pageSize;
      if (shown < records.length) list.append(more);
    };
    more.addEventListener('click', appendChunk);
    appendChunk();
  }

  async function showRemovedMatches() {
    requireTopic();
    const entry = current;
    const library = eagle.library.path;
    await store().hydrateEntry(entry, ['removedMatches']);
    requireTopic(entry.id, library);
    removedSession = { id: entry.id, library, records: entry.removedMatches || [], selected: new Set() };
    $('topic-removed-summary').textContent = `「${entry.name}」中已移除的片段。更新结果会持续排除；恢复后立即回到主题，并按当前条件筛选。`;
    $('topic-removed-query').value = '';
    renderRemovedMatches();
    if (!$('topic-removed-dialog').open) $('topic-removed-dialog').showModal();
  }

  function syncTopic() {
    document.body.dataset.topic = 'true';
    $('warehouse-topic').classList.remove('hidden');
    $('topic-name').textContent = current.name;
    $('topic-favorite').textContent = current.favorite === true ? '★' : '☆';
    $('topic-favorite').setAttribute('aria-pressed', String(current.favorite === true));
    $('topic-favorite').setAttribute('aria-label', current.favorite === true ? '取消常用主题' : '设为常用主题');
    $('topic-favorite').title = current.favorite === true ? '取消常用' : '设为常用';
    $('topic-scene-filter').classList.remove('hidden');
    $('topic-scene-query').value = localFilter(current).query;
    $('topic-scene-source').value = localFilter(current).source;
    syncTopicMeta();
    const topicTimeControl = timeControl(localTime(current), (value) => {
      localTimes.set(timeKey(current), value);
      Search.setArchiveTime(value);
      syncTopicMeta();
    });
    $('topic-time-filter').replaceChildren(topicTimeControl.element);
    $('btn-save-results').textContent = '另存为主题';
    $('preview-cover-actions').classList.remove('hidden');
    $('topic-reset-cover').classList.toggle('hidden', !current.cover);
    syncSceneActions();
    if (!Search.getRawMatches().length) $('empty-state').innerHTML = '<p>主题中暂无片段，可从“已移除”恢复，或更新结果。</p>';
  }

  async function saveCover() {
    checkIdle();
    if (!current) throw new Error('请先在仓库中打开一个主题');
    const entry = current;
    const library = eagle.library.path;
    const archive = store();
    coverSaving = true;
    syncSceneActions();
    const button = $('btn-set-topic-cover');
    button.disabled = true;
    button.textContent = '正在保存封面…';
    try {
      const cover = await Search.captureCover();
      if (current?.id !== entry.id || eagle.library.path !== library) throw new Error('主题已切换，请重新选择封面');
      current = archive.setCover(entry.id, cover, entry.updatedAt);
      data = archive.list();
      syncTopic();
      hooks.toast(`已将当前画面设为「${current.name}」的封面`);
    } finally {
      coverSaving = false;
      syncSceneActions();
      button.disabled = false;
      button.textContent = '当前帧设为封面';
    }
  }

  async function load(entry, { resetView = false } = {}) {
    checkIdle();
    const navigation = beginNavigation();
    clearTimeout(sceneQueryTimer);
    rememberTopicPosition();
    restoringBrowseGeneration = navigation.generation;
    try {
      const library = eagle.library.path;
      await store().hydrateEntry(entry);
      if (!currentNavigation(navigation)) return false;
      checkIdle();
      if (!current && !searchSession) {
        const state = Search.captureState();
        state.position = searchBrowsePosition || state.position;
        searchSession = { state, queryInput: $('query').value };
      }
      if (current?.id !== entry.id) clearRemovalUi();
      const browse = topicPositions.get(timeKey(entry));
      const result = await Search.loadResults(entry.matches, entry.recipe?.query || entry.query || entry.name,
        entry.recipe, !resetView && browse?.view || entry.view, entry.newKeys || [], localTime(entry), localFilter(entry),
        { shouldApply: () => currentNavigation(navigation) });
      if (result === null || !currentNavigation(navigation)) return false;
      current = entry;
      currentLibrary = library;
      $('query').value = entry.recipe?.query || entry.query || '';
      const view = Search.getView();
      $('view-sort').value = view.sortBy;
      $('view-min-dur').value = view.minDur;
      $('view-grouped').checked = view.grouped;
      showSearch({ preserveNavigation: true });
      syncTopic();
      await restoreTopicPosition(browse?.position);
      if (!currentNavigation(navigation)) return false;
      if (removedSession?.id === entry.id) {
        removedSession.records = entry.removedMatches || [];
        renderRemovedMatches();
      }
      return true;
    } finally {
      if (restoringBrowseGeneration === navigation.generation) restoringBrowseGeneration = -1;
      WarehouseNavigation.refresh();
    }
  }

  function confirmButton(button, action, label = '再次点击确认删除') {
    if (button.dataset.confirming === '1') { action(); return; }
    const original = button.textContent;
    button.dataset.confirming = '1';
    button.textContent = label;
    setTimeout(() => { button.dataset.confirming = ''; button.textContent = original; }, 4000);
  }

  function renderCategories() {
    data = store().list();
    WarehouseNavigation.refresh();
    const hierarchy = ArchiveStore.categoryTree(data.categories);
    const fillParents = (select, selected, excluded = new Set()) => {
      select.replaceChildren(new Option('根目录', ''));
      hierarchy.items.filter((category) => !excluded.has(category.id))
        .forEach((category) => select.appendChild(new Option(category.path, category.id)));
      select.value = selected;
      if (select.selectedIndex < 0) select.value = '';
    };
    fillParents($('category-parent'), $('category-parent').value);
    $('category-list').replaceChildren();
    if (!hierarchy.items.length) $('category-list').appendChild(node('p', 'hint category-empty', '还没有分类，在下方新建。'));
    hierarchy.items.forEach((category) => {
      const row = node('div', 'category-row');
      const name = node('div', 'category-name-cell');
      name.style.paddingLeft = `${Math.min(category.depth, 6) * 16}px`;
      const input = node('input');
      input.value = category.name; input.maxLength = 60;
      input.dataset.focusKey = `${category.id}:name`;
      input.setAttribute('aria-label', `${category.path}的名称`);
      name.appendChild(input);
      const parent = node('select'); parent.setAttribute('aria-label', `${category.path}的上级分类`);
      parent.dataset.focusKey = `${category.id}:parent`;
      fillParents(parent, category.parentId || '', category.ids);
      const remove = node('button', 'category-remove', '删除'); remove.type = 'button';
      remove.dataset.focusKey = `${category.id}:remove`;
      const change = (action) => {
        try {
          if (categoryLibrary !== eagle.library.path) throw new Error('素材库已切换，请重新打开管理分类');
          if (action === 'rename' && input.value.trim() === category.name && parent.value === (category.parentId || '')) {
            input.value = category.name;
            return;
          }
          store().category(action, category.id, input.value, parent.value);
          $('category-error').textContent = '';
          categoryOptions($('warehouse-category'), true, $('warehouse-category').value);
          renderCards();
        } catch (error) {
          $('category-error').textContent = error.message;
          input.value = category.name; parent.value = category.parentId || '';
          return;
        }
        // 等焦点移到下一个控件后再重绘，并把焦点放回同一位置。
        setTimeout(() => {
          const key = document.activeElement?.dataset?.focusKey;
          renderCategories();
          if (key) $('category-list').querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus();
        });
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
        else if (event.key === 'Escape' && input.value !== category.name) {
          event.preventDefault(); event.stopPropagation(); input.value = category.name; input.blur();
        }
      });
      input.addEventListener('change', () => change('rename'));
      parent.addEventListener('change', () => change('rename'));
      remove.addEventListener('click', () => confirmButton(remove, () => change('remove'), '确认删除'));
      row.append(name, parent, remove);
      $('category-list').appendChild(row);
    });
  }

  function init(callbacks) {
    hooks = callbacks;
    $('warehouse-check-new')?.addEventListener('click', () => attempt(updates.checkNewMaterials));
    $('warehouse-update-all')?.addEventListener('click', () => attempt(() => updates.batchUpdate(batchScope())));
    $('warehouse-category').addEventListener('change', syncBatchUpdate);
    WarehouseNavigation.init({
      attempt, toast: hooks.toast, snapshot: () => store().list(),
      newHits: (entry) => updates.newHitsFor(entry),
      active: () => ({ page: document.body.dataset.page, topicId: current?.id,
        category: $('warehouse-category').value, favoritesOnly: cards.state.favoritesOnly }),
      openCollection: (category, favorites) => open({ category, favoritesOnly: favorites }),
      openTopic: (id) => {
        checkIdle();
        data = store().list();
        const entry = data.entries.find((value) => value.id === id);
        if (!entry) throw new Error('主题已不存在，请选择其他主题');
        return load(entry);
      },
      capture: () => {
        if (restoringBrowseGeneration === navigationGeneration) return null;
        rememberTopicPosition(); rememberWarehousePosition();
        const page = document.body.dataset.page === 'warehouse' ? 'warehouse' : current ? 'topic' : 'search';
        if (page === 'search') searchBrowsePosition = Search.captureBrowsePosition();
        return { page, topicId: current?.id,
          browse: current ? topicPositions.get(timeKey(current)) : null,
          warehouse: warehousePositions.get(SearchRecipe.normalize(eagle.library.path)) };
      },
      resume: async () => {
        if (current && currentLibrary === eagle.library.path && document.body.dataset.page !== 'warehouse') {
          await restoreTopicPosition(topicPositions.get(timeKey(current))?.position);
        } else if (!current && document.body.dataset.page !== 'warehouse') {
          await restoreTopicPosition(searchBrowsePosition);
        }
      },
      restore: async (saved) => {
        const libraryKey = SearchRecipe.normalize(eagle.library.path);
        if (saved?.warehouse && typeof saved.warehouse === 'object') warehousePositions.set(libraryKey, saved.warehouse);
        if (saved?.page === 'topic' && typeof saved.topicId === 'string') {
          data = store().list();
          const entry = data.entries.find((value) => value.id === saved.topicId);
          if (entry) {
            if (saved.browse && typeof saved.browse === 'object') {
              topicPositions.set(timeKey(entry), saved.browse);
              if (saved.browse.filter && typeof saved.browse.filter === 'object') localFilters.set(timeKey(entry), saved.browse.filter);
              if (saved.browse.time && typeof saved.browse.time === 'object') localTimes.set(timeKey(entry), saved.browse.time);
            }
            await load(entry);
            return;
          }
          hooks.toast('上次浏览的主题已移除，已返回全部主题');
        }
        if (saved?.page === 'search') { showSearch(); return; }
        await open();
      },
    });
    if (typeof TopicRelations !== 'undefined') TopicRelations.init({
      checkIdle, toast: hooks.toast,
      openEntry: async (id) => {
        checkIdle();
        const library = eagle.library.path;
        const snapshot = store().list();
        const entry = snapshot.entries.find((value) => value.id === id);
        if (!entry) throw new Error('主题已不存在，请刷新后重试');
        if (library !== eagle.library.path) throw new Error('素材库已切换');
        data = snapshot;
        return load(entry);
      },
    });
    if (typeof TopicUndo !== 'undefined') undoManager = TopicUndo.create({
      getLibrary: () => eagle.library.path,
      openStore: (library) => ArchiveStore.open(Config.pluginPath(), library),
      checkIdle,
      onApplied: applyManualEntry,
      onChanged: syncUndoActions,
    });
    $('btn-organize-undo').addEventListener('click', () => attempt(undoManualEdit));
    if (typeof Shortcuts !== 'undefined') Shortcuts.register('ctrl+z', (event) => {
      if (event.isComposing || document.querySelector('dialog[open]') || !undoManager?.canUndo()) return;
      event.preventDefault(); event.stopPropagation();
      attempt(undoManualEdit);
    }, { description: '撤销最近一次收录或评分', preventDefault: false });
    if (typeof ManualAdd !== 'undefined') ManualAdd.init({
      toast: hooks.toast, checkIdle,
      validateSource: () => { if (current) requireTopic(); },
      onCommitted: (entry, undoToken, metadata = {}) => {
        if (undoToken) undoManager?.record({ entry, undoToken, ...metadata });
        try { applyManualEntry(entry); }
        catch { hooks.toast('整理已保存，界面刷新失败，请重新打开主题', true); }
      },
    });
    cards.init();
    const recovery = $('warehouse-recovery');
    recovery.addEventListener('click', () => attempt(recoveryDialog));
    const applySearchTime = () => {
      $('search-time-dates').classList.toggle('hidden', $('search-time').value !== 'custom');
      if (current || document.body.dataset.page === 'warehouse') return;
      try {
        Search.setArchiveTime(SearchRecipe.readTime());
        $('time-warning').textContent = '';
      } catch (error) { $('time-warning').textContent = error.message; }
    };
    ['search-time', 'search-time-start', 'search-time-end'].forEach((id) => {
      $(id).addEventListener('change', applySearchTime);
    });
    $('topic-back').addEventListener('click', () => {
      cards.clearSelection();
      open();
    });
    $('topic-search').addEventListener('click', () => attempt(returnToSearch));
    $('topic-edit').addEventListener('click', () => attempt(() => editor.editEntry(current)));
    $('topic-favorite').addEventListener('click', () => attempt(() => { requireTopic(); toggleFavorite(current); }));
    $('topic-update').addEventListener('click', () => attempt(() => updates.refreshEntry(current)));
    $('topic-history')?.addEventListener('click', () => attempt(updates.topicHistory));
    $('topic-removed').addEventListener('click', () => attempt(showRemovedMatches));
    $('btn-topic-remove').addEventListener('click', () => attempt(() => removeTopicMatches(Search.getSelectedMatches())));
    $('btn-topic-score').addEventListener('click', () => attempt(() => { requireTopic(); ManualAdd.editScores(current); }));
    // 预览区「⋯」：只作用于当前预览片段，不改动已选片段。
    const previewMatches = () => [Search.getActiveMatch()].filter(Boolean);
    $('btn-preview-topic-remove').addEventListener('click', () => attempt(() => removeTopicMatches(previewMatches())));
    $('btn-preview-topic-score').addEventListener('click', () => attempt(() => { requireTopic(); ManualAdd.editScores(current, previewMatches()); }));
    const applySceneFilter = () => attempt(async () => {
      checkIdle();
      if (current) requireTopic();
      const maximum = $('result-max-dur');
      try {
        if (!maximum.validity.valid) throw new Error('请输入有效的非负时长上限');
        const filter = { ...Search.getArchiveFilter(), query: $('topic-scene-query').value, source: $('topic-scene-source').value,
          tags: $('result-tags').value,
          membership: $('result-membership').value, videoLimit: Number($('result-video-limit').value),
          queryHits: Number($('result-query-hits').value),
          maxDur: maximum.value === '' ? null : Number(maximum.value) };
        const library = eagle.library.path;
        const topic = current;
        Search.setArchiveFilter(filter);
        if (current) localFilters.set(timeKey(current), Search.getArchiveFilter());
        if (filter.membership !== 'all') {
          await TopicRelations.ensure();
          if (library !== eagle.library.path || topic !== current || $('result-membership').value !== filter.membership) return;
        }
        $('result-filter-error').textContent = '';
      } catch (error) { $('result-filter-error').textContent = error.message; }
    });
    $('topic-scene-query').addEventListener('input', () => {
      clearTimeout(sceneQueryTimer);
      sceneQueryTimer = setTimeout(applySceneFilter, 120);
    });
    $('topic-scene-source').addEventListener('change', () => { clearTimeout(sceneQueryTimer); applySceneFilter(); });
    $('result-tags').addEventListener('input', () => {
      clearTimeout(sceneQueryTimer); sceneQueryTimer = setTimeout(applySceneFilter, 120);
    });
    $('result-tag-chips').addEventListener('click', (event) => {
      const tag = event.target.closest('.tag-chip')?.dataset.tag;
      if (!tag) return;
      const input = $('result-tags');
      const parts = input.value.split(/[,，]/).map((part) => part.trim()).filter(Boolean);
      const lower = tag.toLocaleLowerCase();
      const next = parts.some((part) => part.toLocaleLowerCase() === lower)
        ? parts.filter((part) => part.toLocaleLowerCase() !== lower) : [...parts, tag];
      input.value = next.join(', ');
      clearTimeout(sceneQueryTimer);
      applySceneFilter();
    });
    ['result-max-dur', 'result-membership', 'result-video-limit', 'result-query-hits'].forEach((id) => $(id).addEventListener('change', () => {
      clearTimeout(sceneQueryTimer); applySceneFilter();
    }));
    $('topic-filter-threshold').addEventListener('change', () => attempt(() => {
      checkIdle(); requireTopic();
      const input = $('topic-filter-threshold');
      if (!input.validity.valid) throw new Error('请输入有效的非负阈值');
      Search.setArchiveFilter({ ...Search.getArchiveFilter(), minScore: input.value === '' ? null : Number(input.value) });
      localFilters.set(timeKey(current), Search.getArchiveFilter());
    }));
    $('result-filter-clear').addEventListener('click', () => attempt(() => {
      checkIdle();
      if (current) requireTopic();
      clearTimeout(sceneQueryTimer);
      Search.setView({ minDur: 0 });
      $('view-min-dur').value = 0;
      Search.setArchiveFilter({ query: '', source: 'all' });
      document.dispatchEvent(new CustomEvent('search-scope-clear'));
      $('result-filter-error').textContent = '';
      if (current) {
        localFilters.set(timeKey(current), Search.getArchiveFilter());
        localTimes.set(timeKey(current), { mode: 'all' });
        Search.setArchiveTime({ mode: 'all' });
        syncTopic();
      } else {
        SearchRecipe.writeTime({ mode: 'all' });
        Search.setArchiveTime({ mode: 'all' });
        $('threshold').value = 0;
        $('threshold-val').textContent = '0';
        $('time-warning').textContent = '';
      }
    }));
    $('browse-position-top').addEventListener('click', () => {
      if (positionTarget?.library === eagle.library.path && positionTarget.page === document.body.dataset.page) positionTarget.root.scrollTop = 0;
      hidePositionNotice();
    });
    $('browse-position-resume').addEventListener('click', () => attempt(async () => {
      const target = positionTarget;
      if (!target?.resume || target.library !== eagle.library.path || target.page !== document.body.dataset.page
          || !currentNavigation(target.resume.navigation)) return;
      checkIdle();
      requireTopic(target.resume.id, target.library);
      hidePositionNotice();
      await restoreTopicPosition(target.resume.position);
    }));
    document.addEventListener('search-context', hidePositionNotice);
    $('topic-removal-undo').addEventListener('click', () => attempt(() => {
      if (lastRemoval) restoreTopicMatches(lastRemoval.keys, lastRemoval.id, lastRemoval.library);
    }));
    $('topic-removed-query').addEventListener('input', renderRemovedMatches);
    $('topic-removed-all').addEventListener('change', () => {
      if (!removedSession) return;
      const keys = removedMatchesForView().map((record) => record.key);
      removedSession.selected = new Set($('topic-removed-all').checked ? keys : []);
      for (const input of $('topic-removed-list').querySelectorAll('input[type="checkbox"]')) {
        input.checked = removedSession.selected.has(input.value);
      }
      syncRemovedSelection();
    });
    $('topic-removed-restore').addEventListener('click', () => {
      if (!removedSession) return;
      try { restoreTopicMatches([...removedSession.selected], removedSession.id, removedSession.library); }
      catch (error) {
        $('topic-removed-status').textContent = error.message;
        $('topic-removed-status').dataset.error = 'true';
      }
    });
    $('topic-removed-close').addEventListener('click', () => $('topic-removed-dialog').close());
    $('topic-removed-dialog').addEventListener('close', () => {
      removedSession = null;
      $('topic-removed-list').replaceChildren();
    });
    document.addEventListener('search-selection', syncSceneActions);
    document.addEventListener('search-busy', syncSceneActions);
    document.addEventListener('search-context', () => cards.closeContextMenu());
    $('btn-set-topic-cover').addEventListener('click', () => attempt(saveCover));
    $('btn-cover-prev-frame').addEventListener('click', () => attempt(() => { checkIdle(); Search.stepPreviewFrame(-1); }));
    $('btn-cover-next-frame').addEventListener('click', () => attempt(() => { checkIdle(); Search.stepPreviewFrame(1); }));
    $('topic-reset-cover').addEventListener('click', () => attempt(() => {
      checkIdle();
      current = store().setCover(current.id, null, current.updatedAt);
      data = store().list();
      syncTopic();
      hooks.toast('已恢复默认片段封面');
    }));
    editor.init();
    $('warehouse-categories').addEventListener('click', () => attempt(() => {
      checkIdle(); categoryLibrary = eagle.library.path;
      $('category-error').textContent = ''; renderCategories(); $('warehouse-category-dialog').showModal();
    }));
    $('category-close').addEventListener('click', () => $('warehouse-category-dialog').close());
    $('warehouse-category-form').addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        if (categoryLibrary !== eagle.library.path) throw new Error('素材库已切换，请重新打开管理分类');
        store().category('add', '', $('category-name').value, $('category-parent').value);
        $('category-name').value = ''; $('category-error').textContent = '';
        renderCategories(); categoryOptions($('warehouse-category'), true, $('warehouse-category').value); renderCards();
      } catch (error) { $('category-error').textContent = error.message; }
    });
    document.addEventListener('search-completed', () => { detachTopic(false); showSearch(); });
  }

  function inventoryFor(videos, pathMap) {
    return { byId: new Map(videos.map((item) => [item.id, item])), byPath: pathMap };
  }

  async function previewPrune(library, videos) {
    if (library !== eagle.library.path) throw new Error('素材库已切换，请重新操作');
    const pathMap = new Map(videos.map((item) => [SearchRecipe.normalize(item.filePath), item]));
    return store().previewMissingVideos(inventoryFor(videos, pathMap));
  }

  async function pruneMissingVideos(library, { expectedCount = 0 } = {}) {
    checkIdle();
    if (library !== eagle.library.path) throw new Error('素材库已切换，请回到原库后再次索引以清理主题');
    cleaning = true;
    try {
      const archive = store();
      const videos = await Bridge.collectLibraryVideos(true);
      if (library !== eagle.library.path) throw new Error('素材库已切换，主题清理未执行');
      // 索引期间 Eagle 返回的清单异常缩减时（库仍在加载、同步中断等）不能据此删除主题片段。
      if (expectedCount > 0 && (!videos.length || (expectedCount >= 20 && videos.length < expectedCount * 0.7))) {
        throw new Error(`当前读到 ${videos.length} 个视频，明显少于提交时的 ${expectedCount} 个，已跳过主题清理；确认素材库完整后再次全库索引`);
      }
      const pathMap = await Bridge.refreshPathMap(false, videos);
      const inventory = { byId: new Map(videos.map((item) => [item.id, item])), byPath: pathMap };
      const result = await archive.pruneMissingVideos(inventory, () => library === eagle.library.path);
      if (library !== eagle.library.path) return result;
      data = result.data;
      itemsById = inventory.byId;
      if (searchSession?.state.library === SearchRecipe.normalize(library)) {
        if (ArchiveStore.reconcileVideoReferences(searchSession.state, inventory)) searchSession.state.selected = [];
      }
      const foreignTopic = current?.sourceLibrary
        && SearchRecipe.normalize(current.sourceLibrary) !== SearchRecipe.normalize(library);
      if (!foreignTopic) Search.pruneMissingVideos(inventory);
      else Search.clearThumbnailCache();
      clearRemovalUi();
      if (result.topics) undoManager?.clear({ library });
      if (current && currentLibrary === library) {
        current = data.entries.find((entry) => entry.id === current.id) || null;
        if (current) syncTopic();
      }
      if (document.body.dataset.page === 'warehouse') renderCards();
      WarehouseNavigation.refresh();
      if (typeof TopicRelations !== 'undefined') TopicRelations.refresh();
      return result;
    } finally { cleaning = false; }
  }

  function getScopeContext() {
    requireTopic();
    return { id: current.id, library: currentLibrary, generation: navigationGeneration };
  }

  return { init, open, saveCurrent: editor.saveCurrent, pruneMissingVideos, previewPrune, getScopeContext, getCurrentName: () => current?.name || '',
    autoCheckNewMaterials: () => updates.autoCheckNewMaterials(), syncBatchUpdate };
})();
