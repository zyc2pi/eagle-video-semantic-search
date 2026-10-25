/* 仓库页面、主题编辑与保存流程。结果浏览继续使用 Search 的预览和批量操作。 */
const Warehouse = (() => {
  const $ = (id) => document.getElementById(id);
  let hooks;
  let data;
  let current = null;
  let currentLibrary = null;
  let searchSession = null; // 打开第一个主题前的独立搜索状态，主题间切换不覆盖。
  let searchBrowsePosition = null;
  let editing = null;
  let editingLibrary = null;
  let draft = null;
  let savingMatches = [];
  let savingView = null;
  let updating = false;
  let coverSaving = false;
  let scenesSaving = false;
  let lastRemoval = null;
  let removedSession = null;
  let editorToken = 0;
  let thumbnailObserver;
  const localTimes = new Map();
  const localFilters = new Map();
  const topicPositions = new Map();
  const warehousePositions = new Map();
  let warehouseLibrary = null;
  let renderedEntryCount = 0;
  let warehouseRenderToken = 0;
  let navigationGeneration = 0;
  const beginNavigation = () => ({ generation: ++navigationGeneration, library: eagle.library.path });
  const currentNavigation = (navigation) => navigation.generation === navigationGeneration
    && navigation.library === eagle.library.path;
  let sceneQueryTimer;
  let positionNoticeTimer;
  let positionHideTimer;
  let positionTarget = null;
  let itemsById = new Map();
  let viewMode = 'card';
  let favoritesOnly = false;
  let undoManager = null;
  const selectedEntries = new Set();
  let visibleEntryIds = [];
  let selectionAnchor = null;
  let queryTimer;
  let closeContextMenu = () => {};
  const pageSize = 60;
  const viewPreferenceKey = 'eagle-semantic-warehouse-view';
  const timeKey = (entry) => `${SearchRecipe.normalize(eagle.library.path)}:${entry.id}`;
  const localTime = (entry) => localTimes.get(timeKey(entry)) || { mode: 'all' };
  const localFilter = (entry) => localFilters.get(timeKey(entry)) || { query: '', source: 'all' };
  function filteredMatches(entry) {
    return SearchRecipe.filterMatches(entry.matches, localTime(entry),
      (match) => itemsById.get(match.eagleItemId) || Bridge.itemForPath(match.video_path));
  }
  function countText(entry) {
    const matches = filteredMatches(entry);
    return `${countVideos(matches)} 个素材 / ${matches.length} 个片段`
      + (localTime(entry).mode !== 'all' ? `（已存 ${entry.matches.length} 个）` : '');
  }
  const boolKeys = ['visualCentered', 'aiEnhance', 'aiExpand', 'dedup', 'miniRerank'];
  const numberKeys = ['visualThreshold', 'visualMargin', 'visualSceneFrames', 'visualVideoFrames', 'dedupThreshold'];

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
  function categoryName(id) { return data.categories.find((c) => c.id === id)?.name || '未分类'; }
  function categoryOptions(select, all = false, selected = '') {
    select.replaceChildren();
    if (all) select.appendChild(new Option('全部分类', '*'));
    select.appendChild(new Option('未分类', ''));
    data.categories.forEach((category) => select.appendChild(new Option(category.name, category.id)));
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
    if (updating || coverSaving || scenesSaving || Search.isBusy()) throw new Error('已有搜索、更新或保存正在进行，请稍候');
  }
  async function attempt(action) {
    try { await action(); } catch (error) { hooks.toast(error.message, true, 6500); }
  }

  function syncUndoActions() {
    const button = $('btn-organize-undo');
    if (!button) return;
    const pending = updating || coverSaving || scenesSaving || Search.isBusy();
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
        || (document.body.dataset.page === 'warehouse' ? warehouseLibrary !== library : currentLibrary !== library)) {
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
    clearTimeout(sceneQueryTimer);
    if (!current || currentLibrary !== eagle.library.path || document.body.dataset.page === 'warehouse') return;
    const filter = Search.getArchiveFilter();
    localFilters.set(timeKey(current), filter);
    const reviewPosition = typeof TopicReview !== 'undefined' ? TopicReview.getBrowsePosition() : null;
    topicPositions.set(timeKey(current), { view: Search.getView(), position: reviewPosition || Search.captureBrowsePosition() });
  }
  function rememberWarehousePosition() {
    if (document.body.dataset.page !== 'warehouse' || warehouseLibrary !== eagle.library.path) return;
    const grid = $('warehouse-grid');
    const rect = grid.getBoundingClientRect();
    const anchor = [...grid.querySelectorAll('.warehouse-card')].find((card) => card.getBoundingClientRect().bottom > rect.top);
    warehousePositions.set(SearchRecipe.normalize(warehouseLibrary), {
      query: $('warehouse-query').value, category: $('warehouse-category').value, viewMode,
      favoritesOnly,
      rendered: renderedEntryCount, scrollTop: grid.scrollTop,
      anchorId: anchor?.dataset.entryId || null,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - rect.top : 0,
    });
  }
  function forgetWarehousePosition() {
    if (warehouseLibrary) warehousePositions.delete(SearchRecipe.normalize(warehouseLibrary));
  }
  async function restoreTopicPosition(position) {
    const library = eagle.library.path;
    const generation = navigationGeneration;
    const restored = await Search.restoreBrowsePosition(position);
    if (restored && generation === navigationGeneration && library === eagle.library.path) showPositionNotice($('results'));
  }

  function showSearch({ preserveNavigation = false } = {}) {
    if (!preserveNavigation) navigationGeneration += 1;
    rememberWarehousePosition();
    hidePositionNotice();
    closeContextMenu();
    clearTimeout(queryTimer);
    document.body.dataset.page = 'search';
    $('warehouse-page').classList.add('hidden');
    if (typeof TopicRelations !== 'undefined') TopicRelations.refresh();
  }
  function detachTopic(resetTime = true) {
    if (typeof TopicReview !== 'undefined') TopicReview.stop(false);
    navigationGeneration += 1;
    clearTimeout(sceneQueryTimer);
    clearRemovalUi();
    current = null;
    currentLibrary = null;
    searchSession = null;
    searchBrowsePosition = null;
    document.body.dataset.topic = 'false';
    $('warehouse-topic').classList.add('hidden');
    $('topic-scene-filter').classList.toggle('hidden', !Search.getRawMatches().length);
    $('btn-save-results').textContent = '保存到仓库';
    $('preview-cover-actions').classList.add('hidden');
    syncSceneActions();
    if (resetTime) Search.setArchiveTime({ mode: 'all' });
  }
  async function returnToSearch() {
    checkIdle();
    rememberTopicPosition();
    const session = searchSession;
    const sameLibrary = session?.state.library === SearchRecipe.normalize(eagle.library.path);
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

  function renderCards(position = null) {
    const token = ++warehouseRenderToken;
    hidePositionNotice();
    clearTimeout(queryTimer);
    closeContextMenu();
    thumbnailObserver?.disconnect();
    const grid = $('warehouse-grid');
    grid.replaceChildren();
    grid.scrollTop = 0;
    renderedEntryCount = 0;
    grid.className = `warehouse-grid ${viewMode === 'list' ? 'list-view' : ''}`;
    const query = $('warehouse-query').value.trim().toLocaleLowerCase();
    const category = $('warehouse-category').value;
    const entries = data.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query)
      && (category === '*' || entry.categoryId === category) && (!favoritesOnly || entry.favorite === true))
      .sort((a, b) => Number(b.favorite === true) - Number(a.favorite === true)
        || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    visibleEntryIds = entries.map((entry) => entry.id);
    const visibleIds = new Set(visibleEntryIds);
    for (const id of selectedEntries) if (!visibleIds.has(id)) selectedEntries.delete(id);
    if (!visibleIds.has(selectionAnchor)) selectionAnchor = null;
    $('warehouse-summary').textContent = `${data.entries.length} 个主题 · ${data.categories.length} 个分类 · 常用优先`;
    $('warehouse-favorites').setAttribute('aria-pressed', String(favoritesOnly));
    $('warehouse-warning').textContent = [...new Set(data.warnings)].join('；');
    syncBatchActions();
    if (!entries.length) {
      const empty = node('div', 'warehouse-empty');
      empty.append(node('h2', '', data.entries.length ? '没有找到对应主题' : '把一次搜索，留作下次的起点'),
        node('p', 'hint', data.entries.length ? '试试其他名称或分类。' : '搜索并筛选素材后，点击”保存到仓库”。旧存档会自动出现在这里。'));
      grid.appendChild(empty);
      return;
    }
    // 自选封面直接读快照；默认抽取命中片段画面，复用全局缩略图并发队列。
    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    const observer = new IntersectionObserver((observations) => {
      observations.forEach(async (observation) => {
        if (!observation.isIntersecting) return;
        const cover = observation.target;
        observer.unobserve(cover);
        const entry = entriesById.get(cover.dataset.id);
        if (!entry) return;
        try { await store().hydrateEntry(entry, ['cover', 'matches']); }
        catch { cover.title = '封面或结果资源无法读取，请从历史版本恢复'; return; }
        if (!cover.isConnected) return;
        const match = entry.matches[0];
        const image = node('img');
        image.alt = entry.cover ? `${entry.name}的自选封面` : `${entry.name}的片段封面`;
        cover.prepend(image);
        const loadDefault = () => {
          if (!match) { image.remove(); return; }
          const frame = Math.min(Math.max(Number(match.start_frame) || 0, 3), Number(match.end_frame) || 3);
          Search.loadThumbnail(image, Api.previewUrl(match.video_path, frame), () => {
            const item = Bridge.itemForPath(match.video_path);
            if (item?.thumbnailURL) Search.loadThumbnail(image, item.thumbnailURL, () => image.remove());
            else image.remove();
          });
        };
        if (/^data:image\/jpeg;base64,/.test(entry.cover?.dataUrl || '')) {
          image.onerror = () => { image.onerror = null; loadDefault(); };
          image.src = entry.cover.dataUrl;
        } else loadDefault();
      });
    }, { root: grid, rootMargin: '160px' });
    thumbnailObserver = observer;
    const appendCard = (entry) => {
      const card = node('article', 'warehouse-card');
      card.dataset.entryId = entry.id;
      if (selectedEntries.has(entry.id)) card.classList.add('selected');
      const openButton = node('button', 'warehouse-card-open');
      openButton.type = 'button';
      openButton.setAttribute('aria-label', `打开主题 ${entry.name}`);
      openButton.setAttribute('aria-pressed', String(selectedEntries.has(entry.id)));
      const cover = node('div', 'warehouse-cover');
      cover.dataset.id = entry.id;
      cover.append(node('span', 'warehouse-cover-mark', entry.name.slice(0, 2)),
        node('span', 'warehouse-category-badge', categoryName(entry.categoryId)));
      const body = node('div', 'warehouse-card-body');
      body.title = entry.name;
      body.append(node('h2', '', entry.name),
        node('p', 'warehouse-count', `${entry.summary?.videos ?? countVideos(entry.matches)} 个素材 / ${entry.summary?.matches ?? entry.matches.length} 个片段`),
        node('p', 'warehouse-date', `最近更新 ${dateText(entry.updatedAt)}`));
      if (entry.legacy || Object.getOwnPropertyDescriptor(entry, 'recipe')?.value === null) body.append(node('span', 'warehouse-legacy', '旧存档 · 更新前补齐条件'));
      else if (entry.newKeys?.length) body.append(node('span', 'warehouse-added', `本次新增 ${entry.newKeys.length} 个片段`));
      openButton.append(cover, body);
      openButton.addEventListener('click', (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          event.preventDefault();
          toggleSelection(entry.id, event.shiftKey);
        } else {
          attempt(() => load(entry));
        }
      });
      card.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (!selectedEntries.has(entry.id)) {
          selectedEntries.clear();
          toggleSelection(entry.id, false);
        }
        showContextMenu(event.clientX, event.clientY, openButton);
      });
      const actions = node('div', 'warehouse-card-actions');
      const favorite = node('button', 'warehouse-favorite', entry.favorite === true ? '★' : '☆');
      favorite.type = 'button';
      favorite.setAttribute('aria-pressed', String(entry.favorite === true));
      favorite.setAttribute('aria-label', entry.favorite === true ? `取消常用主题 ${entry.name}` : `设为常用主题 ${entry.name}`);
      favorite.title = entry.favorite === true ? '取消常用' : '设为常用';
      favorite.addEventListener('click', (event) => { event.stopPropagation(); attempt(() => toggleFavorite(entry)); });
      const chooseCover = node('button', '', '选封面');
      chooseCover.type = 'button';
      chooseCover.title = '打开主题，选择素材并将预览的当前帧设为封面';
      chooseCover.addEventListener('click', () => attempt(async () => {
        await load(entry);
        hooks.toast('选择一个素材，拖动预览进度或逐帧调整，再点击”当前帧设为封面”。', false, 6500);
      }));
      const edit = node('button', '', '编辑');
      edit.type = 'button';
      edit.addEventListener('click', () => attempt(() => editEntry(entry)));
      const update = node('button', '', '更新结果');
      update.type = 'button';
      update.title = '按已保存的搜索条件重新搜索并替换结果';
      update.addEventListener('click', () => attempt(() => refreshEntry(entry)));
      actions.append(favorite, chooseCover, edit, update);
      card.append(openButton, actions);
      observer.observe(cover);
      return card;
    };
    let rendered = 0;
    const more = node('button', 'warehouse-load-more');
    more.type = 'button';
    const appendPage = () => {
      more.remove();
      const end = Math.min(rendered + (rendered === 0 ? Math.max(pageSize, position?.rendered || 0) : pageSize), entries.length);
      const fragment = document.createDocumentFragment();
      // 卡片先在离线片段中组装，抽帧仍由可见性观察器与全局队列控制。
      while (rendered < end) {
        fragment.appendChild(appendCard(entries[rendered++]));
      }
      grid.appendChild(fragment);
      renderedEntryCount = rendered;
      if (rendered < entries.length) {
        more.textContent = `显示更多（已显示 ${rendered} / ${entries.length}）`;
        grid.appendChild(more);
      }
    };
    more.addEventListener('click', appendPage);
    appendPage();
    if (position) requestAnimationFrame(() => {
      if (token !== warehouseRenderToken || document.body.dataset.page !== 'warehouse' || warehouseLibrary !== eagle.library.path) return;
      const anchor = [...grid.querySelectorAll('.warehouse-card')].find((card) => card.dataset.entryId === position.anchorId);
      const desired = anchor
        ? grid.scrollTop + anchor.getBoundingClientRect().top - grid.getBoundingClientRect().top - position.anchorOffset
        : position.scrollTop;
      grid.scrollTop = Math.max(0, Number(desired) || 0);
      if (grid.scrollTop > 0) showPositionNotice(grid);
    });
  }

  function toggleSelection(entryId, shiftKey) {
    const index = visibleEntryIds.indexOf(entryId);
    if (index < 0) return;
    const anchorIndex = visibleEntryIds.indexOf(selectionAnchor);
    if (shiftKey && anchorIndex >= 0) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      for (let i = start; i <= end; i++) {
        selectedEntries.add(visibleEntryIds[i]);
      }
    } else {
      if (selectedEntries.has(entryId)) selectedEntries.delete(entryId);
      else selectedEntries.add(entryId);
      selectionAnchor = entryId;
    }
    syncBatchActions();
    syncSelectionCards();
  }

  function syncSelectionCards() {
    $('warehouse-grid').querySelectorAll('.warehouse-card').forEach((card) => {
      const selected = selectedEntries.has(card.dataset.entryId);
      card.classList.toggle('selected', selected);
      card.querySelector('.warehouse-card-open').setAttribute('aria-pressed', String(selected));
    });
  }

  function syncBatchActions() {
    const count = selectedEntries.size;
    $('warehouse-batch-category').disabled = count === 0;
    $('warehouse-selection-count').textContent = count ? `已选择 ${count} 个主题` : '';
  }

  function showContextMenu(x, y, trigger, action = null) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'warehouse-context-menu' + (action ? ' result-context-menu' : '');
    menu.setAttribute('role', 'menu');
    menu.style.cssText = `position: fixed; left: ${x}px; top: ${y}px; z-index: 10000;`;
    const batchCategory = node('button', '', action?.label || '批量修改分类');
    batchCategory.type = 'button';
    batchCategory.setAttribute('role', 'menuitem');
    batchCategory.disabled = action?.disabled || false;
    batchCategory.addEventListener('click', () => {
      closeContextMenu();
      attempt(action?.run || batchChangeCategory);
    });
    menu.append(batchCategory);
    document.body.appendChild(menu);
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - bounds.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - bounds.height - 4))}px`;
    const outside = (event) => { if (!menu.contains(event.target)) closeContextMenu(); };
    const keyboard = (event) => { if (event.key === 'Escape') { event.preventDefault(); closeContextMenu(); } };
    closeContextMenu = () => {
      menu.remove();
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keyboard);
      closeContextMenu = () => {};
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyboard);
    batchCategory.focus();
  }

  function batchChangeCategory() {
    checkIdle();
    if (selectedEntries.size === 0) throw new Error('请先选择要修改的主题');
    const dialog = document.createElement('dialog');
    dialog.className = 'warehouse-batch-dialog';
    const title = node('h3', '', `批量修改分类（已选择 ${selectedEntries.size} 个主题）`);
    const select = node('select');
    categoryOptions(select, false, '');
    const archive = store();
    const library = eagle.library.path;
    let requests = [...selectedEntries].map((id) => {
      const entry = data.entries.find((value) => value.id === id);
      return { id, updatedAt: entry?.updatedAt, revision: entry?.revision };
    });
    const status = node('div', 'warehouse-batch-status');
    status.setAttribute('aria-live', 'polite');
    let lockedCategory = null;
    let conflict = false;
    let pending = false;
    const actions = node('div', 'dialog-actions');
    const cancel = node('button', '', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dialog.close());
    const confirm = node('button', 'primary', '确认');
    confirm.type = 'button';
    confirm.addEventListener('click', async () => {
      if (pending || conflict) return;
      pending = true; confirm.disabled = true; cancel.disabled = true; select.disabled = true;
      lockedCategory ??= select.value;
      let results;
      try {
        checkIdle();
        if (library !== eagle.library.path) throw new Error('素材库已切换，请重新打开并确认');
        results = (await archive.setCategories(requests, lockedCategory)).results;
      } catch (error) {
        results = requests.map(({ id }) => ({ id, ok: false, error: error.message }));
      }
      const resultById = new Map((results || []).map((result) => [result.id, result]));
      const failures = requests.map((request) => resultById.get(request.id)
        || { id: request.id, ok: false, error: '未收到保存结果，请重试' }).filter((result) => !result.ok);
      const count = requests.length - failures.length;
      selectedEntries.clear();
      failures.forEach((result) => selectedEntries.add(result.id));
      const failedIds = new Set(failures.map((result) => result.id));
      requests = requests.filter((request) => failedIds.has(request.id));
      conflict = failures.some((result) => result.code === 'conflict'
        || /冲突|已修改|版本|重新打开|已切换/.test(result.error || ''));
      status.replaceChildren(node('p', '', `已修改 ${count} 个主题，失败 ${failures.length} 个。`));
      failures.forEach((result) => status.appendChild(node('p', 'error',
        `${data.entries.find((entry) => entry.id === result.id)?.name || result.id}：${result.error || '保存失败'}`)));
      if (conflict) status.appendChild(node('p', 'error', '有主题或素材库已变化，请关闭对话框、重新打开仓库后再次选择并确认。'));
      try { data = archive.list(); } catch (error) { status.appendChild(node('p', 'error', error.message)); }
      // 保存后只更新当前卡片的分类；失败项仍然可见并保持选择。
      $('warehouse-grid').querySelectorAll('.warehouse-card').forEach((card) => {
        const entry = data.entries.find((value) => value.id === card.dataset.entryId);
        if (entry) card.querySelector('.warehouse-category-badge').textContent = categoryName(entry.categoryId);
      });
      syncBatchActions(); syncSelectionCards();
      pending = false; cancel.disabled = false;
      confirm.textContent = '重试失败项'; confirm.disabled = conflict;
      if (!failures.length) { dialog.close(); renderCards(); hooks.toast(`已修改 ${count} 个主题的分类`); }
    });
    actions.append(cancel, confirm);
    dialog.append(title, select, status, actions);
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
  }

  async function open() {
    await attempt(async () => {
      checkIdle();
      const navigation = beginNavigation();
      rememberTopicPosition();
      rememberWarehousePosition();
      if (!current && document.body.dataset.page !== 'warehouse') searchBrowsePosition = Search.captureBrowsePosition();
      const library = eagle.library.path;
      const position = warehousePositions.get(SearchRecipe.normalize(library));
      try { data = store().list(); }
      catch (error) { recoveryDialog(); throw error; }
      const pathMap = await Bridge.refreshPathMap();
      if (!currentNavigation(navigation)) return;
      checkIdle();
      itemsById = new Map([...pathMap.values()].map((item) => [item.id, item]));
      Search.pausePreview();
      $('warehouse-query').value = position?.query ?? (warehouseLibrary === library ? $('warehouse-query').value : '');
      categoryOptions($('warehouse-category'), true, position?.category ?? (warehouseLibrary === library ? $('warehouse-category').value || '*' : '*'));
      if (position) viewMode = position.viewMode;
      favoritesOnly = position?.favoritesOnly ?? (warehouseLibrary === library ? favoritesOnly : false);
      warehouseLibrary = library;
      syncViewButtons();
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
    closeContextMenu();
  }

  function syncSceneActions() {
    const hasTopic = !!current && currentLibrary === eagle.library.path && document.body.dataset.topic === 'true';
    const saving = updating || coverSaving || scenesSaving || Search.isBusy();
    syncUndoActions();
    $('btn-topic-add').disabled = saving || !(Search.getSelectedMatches() || []).length;
    $('btn-topic-remove').classList.toggle('hidden', !hasTopic);
    $('btn-topic-remove').disabled = !hasTopic || saving || !(Search.getSelectedMatches() || []).length;
    $('btn-topic-score').classList.toggle('hidden', !hasTopic);
    $('btn-topic-score').disabled = !hasTopic || saving || !(Search.getSelectedMatches() || []).length;
    $('topic-removed').disabled = saving;
    if ($('topic-review')) $('topic-review').disabled = !hasTopic || saving || !Search.getAllMatches().length;
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

  function sceneContextMenu(event, match) {
    if (!current || document.body.dataset.page === 'warehouse') return false;
    const selected = Search.getSelectedMatches() || [];
    const key = ArchiveStore.sceneKey(match);
    const matches = selected.some((value) => ArchiveStore.sceneKey(value) === key) ? selected : [match];
    const id = current.id;
    const library = eagle.library.path;
    showContextMenu(event.clientX, event.clientY, event.currentTarget, {
      label: matches.length > 1 ? `从主题移除选中 ${matches.length} 个片段` : '从主题移除此片段',
      disabled: currentLibrary !== library || updating || coverSaving || scenesSaving || Search.isBusy(),
      run: () => { requireTopic(id, library); removeTopicMatches(matches); },
    });
    return true;
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
    const openingTopic = document.body.dataset.page === 'warehouse' || current?.id !== entry.id;
    const navigation = beginNavigation();
    rememberTopicPosition();
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
    if (openingTopic) {
      await Search.restoreBrowsePosition(browse?.position, { scroll: false });
      if (currentNavigation(navigation) && browse?.position?.scrollTop > 0) {
        showPositionNotice($('results'), { position: browse.position, navigation, id: entry.id });
      }
    } else await restoreTopicPosition(browse?.position);
    if (!currentNavigation(navigation)) return false;
    if (removedSession?.id === entry.id) {
      removedSession.records = entry.removedMatches || [];
      renderRemovedMatches();
    }
    return true;
  }

  function previewChanges(previous, candidate, { rawMatches, restore = false, note = '', commit }) {
    const changes = ArchiveStore.entryChanges(previous, candidate, rawMatches);
    const dialog = node('dialog', 'topic-changes-dialog');
    dialog.id = 'topic-changes-dialog';
    dialog.append(node('h2', '', restore ? '恢复此主题 · 预览变化' : '更新结果 · 预览变化'),
      node('p', 'topic-changes-summary', `「${candidate.name}」：${previous.matches.length} → ${candidate.matches.length} 个片段`),
      node('p', 'hint', restore
        ? '将恢复此版本的结果、人工评分、审阅进度、移除记录、封面和主题设置。其他主题保持当前状态。'
        : `保留 ${changes.retained} 个片段，其中 ${changes.manual.length} 个本次未命中的人工片段继续保留。确认后才替换已存结果。`));
    if (note) dialog.appendChild(node('p', 'hint', note));
    if (restore) {
      const counts = (entry) => [entry.matches.filter((match) => match.manualScore).length,
        entry.matches.filter((match) => match.reviewedAt).length, (entry.removedMatches || []).length];
      const before = counts(previous); const after = counts(candidate);
      dialog.appendChild(node('p', 'hint', ['人工评分', '已审阅', '已移除']
        .map((label, index) => `${label} ${before[index]} → ${after[index]}`).join(' · ')));
    }
    const lists = node('div', 'topic-changes-lists');
    const groups = [['新增', changes.added], ['消失', changes.removed]];
    if (!restore) groups.push(['人工保留', changes.manual]);
    for (const [label, matches] of groups) {
      const section = node('details');
      section.appendChild(node('summary', '', `${label} · ${matches.length}`));
      let rendered = 0;
      const rows = node('div');
      const more = node('button', '', '显示更多');
      more.type = 'button';
      const render = () => {
        const end = Math.min(rendered + 50, matches.length);
        for (; rendered < end; rendered += 1) {
          const match = matches[rendered];
          const name = Bridge.itemForPath(match.video_path)?.name || match.video_path.split(/[\\/]/).pop();
          const start = match.start || `第 ${match.original_start_frame ?? match.start_frame ?? 0} 帧`;
          const endFrame = match.end || `第 ${match.original_end_frame ?? match.end_frame ?? 0} 帧`;
          rows.appendChild(node('p', '', `${name} · ${start} — ${endFrame}`));
        }
        more.hidden = rendered >= matches.length;
      };
      section.addEventListener('toggle', () => { if (section.open && !rendered) render(); });
      more.addEventListener('click', render);
      section.append(rows, more); lists.appendChild(section);
    }
    dialog.appendChild(lists);
    const error = node('p', 'error'); error.id = 'topic-changes-error'; error.setAttribute('role', 'alert');
    const actions = node('div', 'dialog-actions');
    const cancel = node('button', '', '取消'); cancel.id = 'topic-changes-cancel'; cancel.type = 'button';
    const apply = node('button', 'primary', restore ? '恢复此主题' : '应用更新');
    apply.id = 'topic-changes-apply'; apply.type = 'button';
    actions.append(cancel, apply); dialog.append(error, actions); document.body.appendChild(dialog);
    return new Promise((resolve) => {
      let pending = false;
      let saved = null;
      cancel.addEventListener('click', () => { if (!pending) dialog.close(); });
      dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
      dialog.addEventListener('close', () => { dialog.remove(); resolve(saved); }, { once: true });
      apply.addEventListener('click', async () => {
        if (pending) return;
        pending = true; apply.disabled = true; cancel.disabled = true; error.textContent = '';
        try { saved = await commit(); dialog.close(); }
        catch (failure) { error.textContent = failure.message; }
        finally { pending = false; apply.disabled = false; cancel.disabled = false; }
      });
      dialog.showModal(); cancel.focus();
    });
  }

  async function topicHistory() {
    requireTopic();
    const entry = current;
    const navigation = beginNavigation();
    const archive = store();
    const dialog = node('dialog', 'topic-changes-dialog');
    dialog.id = 'topic-history-dialog';
    dialog.append(node('h2', '', `「${entry.name}」的历史版本`),
      node('p', 'hint', '来自当前保留的整库备份，同一主题版本只显示一次。默认保留最近 10 次仓库写入，并非每个主题 10 份；缺失或损坏的版本无法恢复。'));
    const error = node('p', 'error'); error.setAttribute('role', 'alert');
    const close = node('button', '', '关闭'); close.type = 'button';
    let pending = false;
    const versions = archive.entryHistory(entry.id);
    if (!versions.length) dialog.appendChild(node('p', 'hint', '暂无可读取的主题历史版本。'));
    for (const version of versions) {
      const row = node('div', 'topic-history-row');
      const label = version.savedAt ? new Date(version.savedAt).toLocaleString() : version.name;
      const button = node('button', '', '预览'); button.type = 'button';
      row.append(node('span', '', `${label} · ${version.title} · ${version.summary?.matches ?? '—'} 个片段`), button);
      button.addEventListener('click', async () => {
        if (pending) return;
        pending = true; updating = true; syncSceneActions(); error.textContent = '';
        const controls = [...dialog.querySelectorAll('button')];
        controls.forEach((control) => { control.disabled = true; });
        try {
          if (!currentNavigation(navigation)) throw new Error('素材库或当前页面已切换，请重新打开');
          await archive.hydrateEntry(entry);
          const snapshot = await archive.readEntryBackup(version.name, entry.id);
          if (!currentNavigation(navigation)) throw new Error('素材库或当前页面已切换，请重新打开');
          const categories = archive.list().categories;
          const missingCategory = snapshot.entry.categoryId && !categories.some((item) => item.id === snapshot.entry.categoryId);
          const restored = await previewChanges(entry, snapshot.entry, { restore: true,
            note: missingCategory ? '历史分类已不存在，恢复后放入未分类。' : '',
            commit: () => archive.restoreEntryBackup(version.name, entry.id, entry.updatedAt, entry.revision,
              snapshot.fingerprint, () => currentNavigation(navigation)) });
          if (!restored) return;
          updating = false;
          dialog.close();
          if (!currentNavigation(navigation)) {
            hooks.toast('主题已恢复到原素材库，当前页面已切换');
            return;
          }
          try {
            data = archive.list();
            await load(restored, { resetView: true });
            hooks.toast('已恢复此主题，恢复前的版本也已备份');
          } catch (failure) {
            hooks.toast(`恢复已保存，界面刷新失败，请重新打开主题：${failure.message}`, true, 6500);
          }
        } catch (failure) { error.textContent = failure.message; }
        finally {
          pending = false; updating = false; syncSceneActions();
          controls.forEach((control) => { control.disabled = false; });
        }
      });
      dialog.appendChild(row);
    }
    close.addEventListener('click', () => { if (!pending) dialog.close(); });
    dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.append(error, close); document.body.appendChild(dialog); dialog.showModal();
  }

  async function refreshEntry(entry, recipe, savedView = entry.view) {
    checkIdle();
    const navigation = beginNavigation();
    const library = eagle.library.path;
    const archive = store();
    await archive.hydrateEntry(entry);
    if (!currentNavigation(navigation)) return;
    checkIdle();
    recipe = recipe === undefined ? entry.recipe : recipe;
    if (!recipe) { await editEntry(entry); return; }
    if (!hooks.canSearch()) throw new Error('搜索服务未就绪或正在建索引，请稍后更新');
    updating = true;
    syncSceneActions();
    const controls = $('warehouse-editor').open
      ? [...$('warehouse-form').elements].map((element) => ({ element, disabled: element.disabled })) : [];
    controls.forEach(({ element }) => { element.disabled = true; });
    document.body.classList.add('warehouse-updating');
    $('warehouse-page').setAttribute('aria-busy', 'true');
    $('warehouse-warning').textContent = `正在更新「${entry.name}」，原结果仍保留…`;
    $('topic-update').textContent = '更新中…';
    hooks.toast(`正在更新「${entry.name}」…`, false, 10000);
    try {
      const result = await Search.replay(recipe);
      if (library !== eagle.library.path) throw new Error('素材库已切换，未写入更新结果');
      const matches = result.matches;
      const previous = { ...entry, matches: entry.matches.map((match) => ({ ...match,
        eagleItemId: match.eagleItemId || Bridge.itemForPath(match.video_path)?.id,
      })) };
      let updated = ArchiveStore.updatedEntry(previous, matches, recipe, savedView);
      updated.query = recipe.query;
      updated.legacy = false;
      updated = await previewChanges(previous, updated, { rawMatches: matches,
        note: result.missingDates ? `${result.missingDates} 个素材缺少导入时间，已排除。` : '',
        commit: () => {
          if (!currentNavigation(navigation)) throw new Error('素材库或当前页面已切换，未写入更新结果');
          return archive.replace(updated, entry.updatedAt);
        } });
      if (!updated) return null;
      // 此时更新已落盘，才允许装载；load 内仍防止其他搜索并发。
      updating = false;
      if (!currentNavigation(navigation)) {
        hooks.toast('更新已保存到原素材库，当前页面已切换');
        return updated;
      }
      try {
        data = archive.list();
        await load(updated, { resetView: $('warehouse-editor').open });
      } catch (failure) {
        hooks.toast(`更新已保存，界面刷新失败，请重新打开主题：${failure.message}`, true, 6500);
        return updated;
      }
      hooks.toast(`更新完成：${updated.matches.length} 个片段，本次新增 ${updated.newKeys.length}`
        + (result.missingDates ? `；${result.missingDates} 个素材缺少导入时间，已排除` : ''), false, 6500);
      return updated;
    } finally {
      updating = false;
      syncSceneActions();
      controls.forEach(({ element, disabled }) => { element.disabled = disabled; });
      document.body.classList.remove('warehouse-updating');
      $('warehouse-page').setAttribute('aria-busy', 'false');
      $('warehouse-warning').textContent = [...new Set(data?.warnings || [])].join('；');
      $('topic-update').textContent = '更新结果';
    }
  }

  function fillEditor(entry, recipe, view) {
    $('warehouse-editor-error').textContent = '';
    $('entry-name').value = entry?.name || recipe?.query || '未命名';
    categoryOptions($('entry-category'), false, entry?.categoryId || '');
    $('entry-delete').classList.toggle('hidden', !entry);
    $('entry-copy')?.classList.toggle('hidden', !entry);
    $('entry-delete').textContent = '删除主题';
    $('entry-delete').dataset.confirming = '';
    $('entry-conditions').classList.toggle('hidden', !entry);
    // 初次保存保持条件不可变，确保保存结果与条件一一对应。
    $('entry-conditions').querySelectorAll('input, select, button').forEach((el) => { el.disabled = !entry; });
    if (!entry) return;
    $('entry-query').value = recipe.query || '';
    $('entry-threshold').value = recipe.config.threshold;
    $('entry-duration').value = view.minDur;
    $('entry-sort').value = view.sortBy;
    $('entry-grouped').checked = view.grouped;
    $('entry-model').value = recipe.config.modelName;
    boolKeys.forEach((key) => { $(`entry-${key}`).checked = !!recipe.config[key]; });
    numberKeys.forEach((key) => { $(`entry-${key}`).value = recipe.config[key] ?? ''; });
    $('entry-visualAgg').value = recipe.config.visualAgg || 'mean';
    $('entry-aiMode').value = recipe.config.aiMode || 'balanced';
    SearchRecipe.writeTime(recipe.time, 'entry-time');
    $('entry-scope').value = recipe.scope.mode;
    $('entry-folders').classList.toggle('hidden', recipe.scope.mode !== 'folders');
    $('entry-replace-source').classList.toggle('hidden', recipe.kind === 'text');
    $('entry-source').textContent = recipe.kind === 'text' ? '文本搜索'
      : `${recipe.kind === 'hybrid' ? '文本 × 视觉混合搜索' : '视觉搜索'} · ${recipe.payload?.video_path || '已保存查询图片'}`;
  }

  async function fillFolders(recipe, token) {
    $('entry-folders').textContent = '正在读取文件夹…';
    try {
      const folders = await Bridge.getFolderTree();
      if (token !== editorToken) return;
      $('entry-folders').replaceChildren();
      const wanted = new Set(recipe.scope.folderIds || []);
      const seen = new Set();
      const walk = (nodes, parent, depth = 0) => {
        for (const folder of nodes) {
          if (seen.has(folder.id)) continue;
          seen.add(folder.id);
          const row = node('label', 'check-row');
          row.style.paddingLeft = `${Math.min(depth, 8) * 14}px`;
          const check = node('input');
          check.type = 'checkbox';
          check.value = folder.id;
          check.checked = wanted.has(folder.id);
          row.append(check, document.createTextNode(folder.name));
          parent.appendChild(row);
          walk(folder.children || [], parent, depth + 1);
        }
      };
      walk(folders, $('entry-folders'));
      wanted.forEach((id) => {
        if (!seen.has(id)) {
          const row = node('label', 'check-row');
          const check = node('input');
          check.type = 'checkbox'; check.value = id; check.checked = true;
          row.append(check, document.createTextNode(`已失效的文件夹 (${id})，请取消勾选`));
          $('entry-folders').appendChild(row);
        }
      });
    } catch (error) {
      if (token === editorToken) $('entry-folders').textContent = `文件夹读取失败：${error.message}`;
    }
  }

  async function editEntry(entry) {
    checkIdle();
    const navigation = beginNavigation();
    await store().hydrateEntry(entry);
    if (!currentNavigation(navigation)) return;
    checkIdle();
    Search.pausePreview();
    data = store().list();
    editing = SearchRecipe.clone(entry);
    editingLibrary = eagle.library.path;
    draft = entry.recipe ? SearchRecipe.clone(entry.recipe) : {
      kind: 'text', query: entry.query || entry.name, payload: null,
      config: SearchRecipe.options(Config.get()), scope: { mode: 'all' }, time: { mode: 'all' }, library: eagle.library.path,
    };
    $('warehouse-editor-title').textContent = '编辑主题';
    $('warehouse-editor-hint').textContent = entry.recipe
      ? '名称、分类、排序、分组及最短时长仅本地保存；改变搜索条件才重新搜索。最短时长只过滤显示，不删除已存片段。'
      : '旧存档缺少完整条件。请确认下方条件，以文本搜索重新建立主题；原文件会保留。';
    fillEditor(entry, draft, entry.view);
    $('entry-submit').textContent = '保存 / 更新';
    $('warehouse-editor').showModal();
    const token = ++editorToken;
    await fillFolders(draft, token);
  }

  function copyTopic() {
    checkIdle();
    if (!editing) return;
    if (editingLibrary !== eagle.library.path) throw new Error('素材库已切换，请重新打开主题后复制');
    const source = editing;
    const navigation = beginNavigation();
    const archive = store();
    const dialog = node('dialog', 'topic-changes-dialog topic-copy-dialog');
    dialog.id = 'topic-copy-dialog';
    const form = node('form');
    form.append(node('h2', '', '复制主题'),
      node('p', 'hint', `复制「${source.name}」的已保存版本，未保存的编辑不会带入。片段、评分、审阅进度、移除记录、封面和搜索条件完整保留，后续修改相互独立。`));
    const label = node('label', '', '副本名称');
    label.htmlFor = 'topic-copy-name';
    const name = node('input'); name.id = 'topic-copy-name'; name.type = 'text'; name.required = true;
    name.value = `${source.name} 副本`;
    const error = node('p', 'form-error'); error.id = 'topic-copy-error'; error.setAttribute('role', 'alert');
    const actions = node('div', 'dialog-actions');
    const cancel = node('button', '', '取消'); cancel.type = 'button';
    const submit = node('button', 'primary', '创建并打开副本'); submit.type = 'submit';
    actions.append(cancel, submit); form.append(label, name, error, actions);
    dialog.appendChild(form); document.body.appendChild(dialog);
    let pending = false;
    cancel.addEventListener('click', () => { if (!pending) dialog.close(); });
    dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (pending) return;
      error.textContent = '';
      try {
        checkIdle();
        if (!currentNavigation(navigation)) throw new Error('素材库或当前页面已切换，请重新打开主题');
        pending = true; scenesSaving = true; syncSceneActions();
        name.disabled = true; submit.disabled = true; cancel.disabled = true;
        const copy = await archive.copyEntry(source.id, name.value, source.updatedAt, source.revision,
          () => currentNavigation(navigation));
        scenesSaving = false;
        dialog.close(); $('warehouse-editor').close();
        if (!currentNavigation(navigation)) {
          hooks.toast('副本已保存到原素材库，当前页面已切换'); return;
        }
        try {
          data = archive.list();
          await load(copy, { resetView: true });
          hooks.toast(`已创建副本「${copy.name}」`);
        } catch (failure) {
          hooks.toast(`副本已保存，打开失败，请从仓库重新打开：${failure.message}`, true, 6500);
        }
      } catch (failure) { error.textContent = failure.message; }
      finally {
        pending = false; scenesSaving = false; syncSceneActions();
        name.disabled = false; submit.disabled = false; cancel.disabled = false;
      }
    });
    dialog.showModal(); name.focus(); name.select();
  }

  async function saveCurrent() {
    await attempt(async () => {
      checkIdle();
      const navigation = beginNavigation();
      const recipe = Search.getRecipe();
      if (!recipe) throw new Error('旧存档请先在仓库中编辑并补齐条件');
      savingMatches = SearchRecipe.clone(Search.getAllMatches());
      savingView = Search.getView();
      if (!savingMatches.length) throw new Error('当前筛选下没有可保存的结果');
      data = store().list();
      draft = await SearchRecipe.persistSource(recipe);
      if (!currentNavigation(navigation)) return;
      checkIdle();
      editing = null;
      $('warehouse-editor-title').textContent = '保存到仓库';
      $('warehouse-editor-hint').textContent = `保存 ${countVideos(savingMatches)} 个素材 / ${savingMatches.length} 个片段及当前筛选条件。`;
      fillEditor(null, draft, savingView);
      $('entry-submit').textContent = '保存主题';
      $('warehouse-editor').showModal();
    });
  }

  function readDraft() {
    const recipe = SearchRecipe.clone(draft);
    recipe.query = $('entry-query').value.trim();
    if (!recipe.query) throw new Error('请输入搜索词');
    recipe.config.threshold = Number($('entry-threshold').value);
    recipe.config.modelName = $('entry-model').value.trim();
    boolKeys.forEach((key) => { recipe.config[key] = $(`entry-${key}`).checked; });
    numberKeys.forEach((key) => {
      if ($(`entry-${key}`).value !== '') recipe.config[key] = Number($(`entry-${key}`).value);
    });
    recipe.config.visualAgg = $('entry-visualAgg').value;
    recipe.config.aiMode = $('entry-aiMode').value;
    recipe.time = SearchRecipe.readTime('entry-time');
    const ids = [...$('entry-folders').querySelectorAll('input:checked')].map((input) => input.value);
    recipe.scope = $('entry-scope').value === 'all' ? { mode: 'all' } : { mode: 'folders', folderIds: ids };
    if (recipe.scope.mode === 'folders' && !ids.length) throw new Error('请至少选择一个文件夹');
    const view = { minDur: Number($('entry-duration').value), sortBy: $('entry-sort').value, grouped: $('entry-grouped').checked };
    return { recipe, view };
  }

  function equivalent(a, b) {
    // 文件夹显示名称不影响搜索，顺序也不影响范围。
    const clean = (value) => {
      const copy = SearchRecipe.clone(value);
      if (copy?.scope) {
        delete copy.scope.names;
        if (copy.scope.folderIds) copy.scope.folderIds.sort();
      }
      return copy;
    };
    const sorted = (value) => {
      if (Array.isArray(value)) return value.map(sorted);
      if (value && typeof value === 'object') return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, sorted(value[key])]),
      );
      return value;
    };
    return JSON.stringify(sorted(clean(a))) === JSON.stringify(sorted(clean(b)));
  }

  async function submit(event) {
    event.preventDefault();
    $('warehouse-editor-error').textContent = '';
    $('entry-submit').disabled = true;
    try {
      checkIdle();
      const name = $('entry-name').value.trim();
      if (!name) throw new Error('请输入主题名称');
      const categoryId = $('entry-category').value;
      if (!editing) {
        const entry = store().add({ name, categoryId, recipe: draft, view: savingView, matches: savingMatches });
        data = store().list();
        await load(entry);
        hooks.toast(`已保存主题「${name}」`);
      } else {
        const { recipe, view } = readDraft();
        let renamed = { ...editing, name, categoryId, view, metadataUpdatedAt: new Date().toISOString() };
        if (!equivalent(recipe, editing.recipe)) {
          const persisted = await SearchRecipe.persistSource(recipe);
          if (!await refreshEntry(renamed, persisted, view)) return;
        } else {
          renamed = store().replace(renamed, editing.updatedAt);
          data = store().list();
          if (current?.id === renamed.id && document.body.dataset.page !== 'warehouse') await load(renamed, { resetView: true });
          if (document.body.dataset.page === 'warehouse') renderCards();
          hooks.toast('主题信息已保存');
        }
      }
      $('warehouse-editor').close();
    } catch (error) {
      $('warehouse-editor-error').textContent = error.message;
    } finally { $('entry-submit').disabled = false; }
  }

  function confirmButton(button, action) {
    if (button.dataset.confirming === '1') { action(); return; }
    const original = button.textContent;
    button.dataset.confirming = '1';
    button.textContent = '再次点击确认删除';
    setTimeout(() => { button.dataset.confirming = ''; button.textContent = original; }, 4000);
  }

  function renderCategories() {
    data = store().list();
    $('category-list').replaceChildren();
    data.categories.forEach((category) => {
      const row = node('div', 'category-row');
      const input = node('input');
      input.value = category.name; input.maxLength = 60;
      input.setAttribute('aria-label', '分类名称');
      const rename = node('button', '', '重命名'); rename.type = 'button';
      const remove = node('button', '', '删除'); remove.type = 'button';
      const change = (action) => {
        try {
          store().category(action, category.id, input.value);
          renderCategories();
          categoryOptions($('warehouse-category'), true, $('warehouse-category').value);
          renderCards();
        } catch (error) { $('category-error').textContent = error.message; }
      };
      rename.addEventListener('click', () => change('rename'));
      remove.addEventListener('click', () => confirmButton(remove, () => change('remove')));
      row.append(input, rename, remove);
      $('category-list').appendChild(row);
    });
  }

  function recoveryDialog() {
    checkIdle();
    let dialog = $('warehouse-recovery-dialog');
    if (!dialog) {
      dialog = node('dialog'); dialog.id = 'warehouse-recovery-dialog';
      dialog.style.cssText = 'max-width:680px;width:80vw;max-height:80vh;overflow:auto';
      document.body.appendChild(dialog);
    }
    dialog.replaceChildren(node('h2', '', '仓库备份与回收站'),
      node('p', 'hint', '写入前自动备份，默认保留最近 10 个有效版本；回收站默认保留 30 天，下次成功写入时清理。未知或损坏的备份不自动删除。恢复前也会保存当前文件。'));
    const status = node('p', 'hint'); status.setAttribute('aria-live', 'polite');
    let processing = false;
    const run = async (action) => {
      if (processing) return;
      processing = true;
      const controls = [...dialog.querySelectorAll('button, input, select')]
        .map((element) => ({ element, disabled: element.disabled }));
      controls.forEach(({ element }) => { element.disabled = true; });
      dialog.setAttribute('aria-busy', 'true');
      try { await action(); } catch (error) { status.textContent = error.message; }
      finally {
        processing = false;
        controls.forEach(({ element, disabled }) => { element.disabled = disabled || element.dataset.completed === 'true'; });
        dialog.setAttribute('aria-busy', 'false');
      }
    };
    const archive = store();
    const library = eagle.library.path;
    const guard = () => { checkIdle(); if (library !== eagle.library.path) throw new Error('素材库已切换，请重新打开恢复面板'); };
    const policyRow = node('p');
    const countLabel = node('label', '', '备份份数 ');
    const countInput = node('input'); countInput.type = 'number'; countInput.min = '1'; countInput.max = '100'; countInput.value = '10';
    const daysLabel = node('label', '', ' 回收站天数（0 永久） ');
    const daysInput = node('input'); daysInput.type = 'number'; daysInput.min = '0'; daysInput.max = '3650'; daysInput.value = '30';
    try { const policy = archive.list().retention; if (policy) { countInput.value = policy.backupCount; daysInput.value = policy.trashDays; } } catch { /* Keep recovery accessible for a broken manifest. */ }
    const savePolicy = node('button', '', '保存清理策略'); savePolicy.type = 'button';
    savePolicy.addEventListener('click', () => run(() => {
      guard(); archive.setRetention(Number(countInput.value), Number(daysInput.value)); status.textContent = '清理策略已保存';
    }));
    countLabel.append(countInput); daysLabel.append(daysInput); policyRow.append(countLabel, daysLabel, savePolicy); dialog.append(policyRow);
    const exportButton = node('button', '', '导出仓库包'); exportButton.type = 'button';
    exportButton.addEventListener('click', () => run(async () => {
      guard(); status.textContent = '正在导出仓库包…';
      const bundle = await archive.exportBundleAsync();
      guard(); const blob = new Blob([bundle], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const link = node('a');
      link.href = url; link.download = `warehouse-${Date.now()}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = '仓库包已生成';
    }));
    const input = node('input'); input.type = 'file'; input.accept = '.json';
    const moveLabel = node('label', '', '我确认这是搬家后的同一素材库：允许导入异路径仓库（仅快照，更新前需重设条件）');
    const moveCheck = node('input'); moveCheck.type = 'checkbox'; moveLabel.prepend(moveCheck);
    input.setAttribute('aria-label', '导入同库仓库包（合并，不覆盖同 ID 主题）');
    input.addEventListener('change', () => run(async () => {
      const file = input.files[0]; if (!file) return;
      if (file.size > 128 * 1024 * 1024) throw new Error('仓库包超过 128 MB，请分批整理后导入');
      guard(); status.textContent = '正在校验并合并仓库包…';
      const text = await file.text(); guard();
      const count = await archive.importBundleAsync(text, { allowLibraryMove: moveCheck.checked });
      guard();
      status.textContent = `已合并 ${count} 个新主题（同 ID 主题不覆盖）`;
      detachTopic(); await open();
    }));
    const unlock = node('button', '', '恢复已退出进程的遗留锁'); unlock.type = 'button';
    unlock.addEventListener('click', () => run(() => { guard(); status.textContent = archive.recoverLock() ? '遗留锁已移除，可重试保存' : '没有遗留锁'; }));
    dialog.append(exportButton, moveLabel, input, unlock, status, node('h3', '', '回收站'));
    try {
      const trash = archive.list().trash || [];
      if (!trash.length) dialog.append(node('p', 'hint', '回收站为空'));
      trash.forEach((item) => {
        if (!item?.entry?.name || !item.trashId) { dialog.append(node('p', 'hint', '有未知格式回收站记录，已原样保留')); return; }
        const row = node('p', '', `${item.entry.name} · ${dateText(item.deletedAt)} `);
        const button = node('button', '', '恢复主题'); button.type = 'button';
        button.addEventListener('click', () => run(async () => {
          guard(); archive.restore(item.trashId); button.dataset.completed = 'true'; button.disabled = true;
          status.textContent = '主题已恢复'; await open();
        })); row.append(button); dialog.append(row);
      });
    } catch (error) { status.textContent = error.message; }
    dialog.append(node('h3', '', '历史版本'));
    const versions = archive.backups();
    if (!versions.length) dialog.append(node('p', 'hint', '暂无备份（首次成功写入后的下一次修改开始备份）'));
    versions.forEach((item) => {
      const row = node('p', '', `${dateText(Number(item.name.split('-')[0]))} · ${item.valid ? `${item.count} 个主题（恢复时校验资源）` : '损坏，不可恢复'} `);
      const button = node('button', '', '恢复此版本'); button.type = 'button'; button.disabled = !item.valid;
      button.addEventListener('click', () => run(() => {
        guard();
        if (button.dataset.confirming !== '1') {
          button.dataset.confirming = '1'; button.textContent = '再次点击确认恢复整库'; return;
        }
        archive.restoreBackup(item.name); button.dataset.completed = 'true'; button.disabled = true; detachTopic();
        status.textContent = '已恢复；恢复前的文件已另存为备份'; return open();
      })); row.append(button); dialog.append(row);
    });
    const close = node('button', '', '关闭'); close.type = 'button';
    close.addEventListener('click', () => dialog.close()); dialog.append(close);
    dialog.oncancel = (event) => { if (processing) event.preventDefault(); };
    if (!dialog.open) dialog.showModal();
  }

  function syncViewButtons() {
    $('warehouse-view-card').classList.toggle('active', viewMode === 'card');
    $('warehouse-view-list').classList.toggle('active', viewMode === 'list');
    $('warehouse-view-card').setAttribute('aria-pressed', String(viewMode === 'card'));
    $('warehouse-view-list').setAttribute('aria-pressed', String(viewMode === 'list'));
  }

  function init(callbacks) {
    hooks = callbacks;
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
    if (typeof TopicReview !== 'undefined') TopicReview.init({
      checkIdle, toast: hooks.toast,
      getContext: () => current && document.body.dataset.topic === 'true'
        && document.body.dataset.page !== 'warehouse' ? { entry: current, library: currentLibrary } : null,
      commit: (action, match, score, context) => {
        requireTopic(context.entry.id, context.library);
        if (action === 'remove') { removeTopicMatches([match]); return; }
        scenesSaving = true;
        syncSceneActions();
        try {
          const entry = current;
          const archive = store();
          const result = action === 'score'
            ? archive.addMatches(entry.id, [{ match, score, scoreMode: 'custom' }], entry.updatedAt,
              entry.revision || 0, { markReviewed: true })
            : archive.setReviewed(entry.id, [ArchiveStore.sceneKey(match)], action !== 'reset',
              entry.updatedAt, entry.revision || 0);
          if (result.undoToken) undoManager?.record({ entry: result.entry, undoToken: result.undoToken,
            undoBytes: result.undoBytes, beforeRevision: entry.revision || 0, library: currentLibrary,
            targetId: entry.id, targetName: entry.name, label: '审片评分' });
          applySceneEdit(result.entry);
        } finally { scenesSaving = false; syncSceneActions(); }
      },
    });
    try { if (localStorage.getItem(viewPreferenceKey) === 'list') viewMode = 'list'; }
    catch { /* 偏好不可用时保留会话状态。 */ }
    const setViewMode = (value) => {
      viewMode = value;
      try { localStorage.setItem(viewPreferenceKey, value); } catch { /* 降级为会话内记忆。 */ }
      syncViewButtons();
      if (data) renderCards();
    };
    setViewMode(viewMode);
    const recovery = node('button', '', '备份 / 回收站'); recovery.id = 'warehouse-recovery'; recovery.type = 'button';
    $('warehouse-categories').parentElement.appendChild(recovery);
    recovery.addEventListener('click', () => attempt(recoveryDialog));
    $('search-time').addEventListener('change', () => {
      $('search-time-dates').classList.toggle('hidden', $('search-time').value !== 'custom');
      $('time-warning').textContent = '';
    });
    $('entry-time').addEventListener('change', () => $('entry-time-dates').classList.toggle('hidden', $('entry-time').value !== 'custom'));
    $('entry-scope').addEventListener('change', () => $('entry-folders').classList.toggle('hidden', $('entry-scope').value !== 'folders'));
    $('warehouse-back').addEventListener('click', showSearch);
    $('warehouse-query').addEventListener('input', () => {
      forgetWarehousePosition();
      clearTimeout(queryTimer);
      queryTimer = setTimeout(renderCards, 120);
    });
    $('warehouse-category').addEventListener('change', () => {
      forgetWarehousePosition();
      clearTimeout(queryTimer); renderCards();
    });
    $('warehouse-favorites').addEventListener('click', () => {
      forgetWarehousePosition();
      favoritesOnly = !favoritesOnly;
      clearTimeout(queryTimer); renderCards();
    });
    $('warehouse-view-card').addEventListener('click', () => {
      forgetWarehousePosition();
      clearTimeout(queryTimer); setViewMode('card');
    });
    $('warehouse-view-list').addEventListener('click', () => {
      forgetWarehousePosition();
      clearTimeout(queryTimer); setViewMode('list');
    });
    $('warehouse-batch-category').addEventListener('click', () => attempt(batchChangeCategory));
    $('topic-back').addEventListener('click', () => {
      selectedEntries.clear();
      open();
    });
    $('topic-search').addEventListener('click', () => attempt(returnToSearch));
    $('topic-edit').addEventListener('click', () => attempt(() => editEntry(current)));
    $('topic-favorite').addEventListener('click', () => attempt(() => { requireTopic(); toggleFavorite(current); }));
    $('topic-update').addEventListener('click', () => attempt(() => refreshEntry(current)));
    $('topic-history')?.addEventListener('click', () => attempt(topicHistory));
    $('topic-compare').addEventListener('click', () => attempt(() => TopicRelations.showCompare([current?.id])));
    $('warehouse-compare').addEventListener('click', () => attempt(() => TopicRelations.showCompare([...selectedEntries])));
    $('entry-copy')?.addEventListener('click', () => attempt(copyTopic));
    $('topic-removed').addEventListener('click', () => attempt(showRemovedMatches));
    $('btn-topic-remove').addEventListener('click', () => attempt(() => removeTopicMatches(Search.getSelectedMatches())));
    $('btn-topic-score').addEventListener('click', () => attempt(() => { requireTopic(); ManualAdd.editScores(current); }));
    const applySceneFilter = () => attempt(() => {
      checkIdle();
      if (current) requireTopic();
      const maximum = $('result-max-dur');
      try {
        if (!maximum.validity.valid) throw new Error('请输入有效的非负时长上限');
        const filter = { query: $('topic-scene-query').value, source: $('topic-scene-source').value,
          tags: $('result-tags').value, orientation: $('result-orientation').value,
          maxDur: maximum.value === '' ? null : Number(maximum.value) };
        Search.setArchiveFilter(filter);
        if (current) localFilters.set(timeKey(current), Search.getArchiveFilter());
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
    ['result-orientation', 'result-max-dur'].forEach((id) => $(id).addEventListener('change', () => {
      clearTimeout(sceneQueryTimer); applySceneFilter();
    }));
    $('result-filter-clear').addEventListener('click', () => attempt(() => {
      checkIdle();
      if (current) requireTopic();
      clearTimeout(sceneQueryTimer);
      Search.setView({ minDur: 0 });
      $('view-min-dur').value = 0;
      Search.setArchiveFilter({ query: '', source: 'all' });
      $('result-filter-error').textContent = '';
      if (current) localFilters.set(timeKey(current), Search.getArchiveFilter());
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
    Search.setContextMenuHandler(sceneContextMenu);
    document.addEventListener('search-selection', syncSceneActions);
    document.addEventListener('search-busy', syncSceneActions);
    document.addEventListener('search-context', () => closeContextMenu());
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
    $('warehouse-form').addEventListener('submit', submit);
    $('entry-cancel').addEventListener('click', () => { if (!updating) $('warehouse-editor').close(); });
    $('warehouse-editor').addEventListener('cancel', (event) => { if (updating) event.preventDefault(); });
    $('warehouse-editor').addEventListener('close', () => { editorToken += 1; });
    $('entry-delete').addEventListener('click', () => attempt(() => {
      checkIdle();
      confirmButton($('entry-delete'), () => {
        store().remove(editing.id);
        if (current?.id === editing.id) detachTopic();
        $('warehouse-editor').close();
        open();
      });
    }));
    $('entry-replace-source').addEventListener('click', () => attempt(async () => {
      const items = await eagle.item.getSelected();
      const item = items.find((value) => Bridge.isVideoItem(value) || Bridge.isImageItem(value));
      if (!item) throw new Error('请先在 Eagle 选中一张图片或一个视频');
      draft.payload = Bridge.isVideoItem(item) ? { video_path: item.filePath } : { image_path: item.filePath };
      delete draft.sourceItemId;
      $('entry-source').textContent = `新查询来源：${item.name}`;
    }));
    $('warehouse-categories').addEventListener('click', () => attempt(() => {
      checkIdle(); $('category-error').textContent = ''; renderCategories(); $('warehouse-category-dialog').showModal();
    }));
    $('category-close').addEventListener('click', () => $('warehouse-category-dialog').close());
    $('warehouse-category-form').addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        store().category('add', '', $('category-name').value);
        $('category-name').value = ''; $('category-error').textContent = '';
        renderCategories(); categoryOptions($('warehouse-category'), true, $('warehouse-category').value); renderCards();
      } catch (error) { $('category-error').textContent = error.message; }
    });
    document.addEventListener('search-completed', () => { detachTopic(); showSearch(); });
  }

  return { init, open, saveCurrent, getCurrentName: () => current?.name || '' };
})();
