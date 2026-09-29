/* 仓库页面、主题编辑与保存流程。结果浏览继续使用 Search 的预览和批量操作。 */
const Warehouse = (() => {
  const $ = (id) => document.getElementById(id);
  let hooks;
  let data;
  let current = null;
  let editing = null;
  let draft = null;
  let savingMatches = [];
  let savingView = null;
  let updating = false;
  let coverSaving = false;
  let editorToken = 0;
  let thumbnailObserver;
  const localTimes = new Map();
  let itemsById = new Map();
  let viewMode = 'card';
  const selectedEntries = new Set();
  const timeKey = (entry) => `${SearchRecipe.normalize(eagle.library.path)}:${entry.id}`;
  const localTime = (entry) => localTimes.get(timeKey(entry)) || { mode: 'all' };
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
    if (updating || coverSaving || Search.isBusy()) throw new Error('已有搜索、更新或封面保存正在进行，请稍候');
  }
  async function attempt(action) {
    try { await action(); } catch (error) { hooks.toast(error.message, true, 6500); }
  }

  function showSearch() {
    document.body.dataset.page = 'search';
    $('warehouse-page').classList.add('hidden');
  }
  function detachTopic() {
    current = null;
    document.body.dataset.topic = 'false';
    $('warehouse-topic').classList.add('hidden');
    $('btn-save-results').textContent = '保存到仓库';
    $('preview-cover-actions').classList.add('hidden');
    Search.setArchiveTime({ mode: 'all' });
  }

  function renderCards() {
    thumbnailObserver?.disconnect();
    const grid = $('warehouse-grid');
    grid.replaceChildren();
    grid.className = `warehouse-grid ${viewMode === 'list' ? 'list-view' : ''}`;
    const query = $('warehouse-query').value.trim().toLocaleLowerCase();
    const category = $('warehouse-category').value;
    const entries = data.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query)
      && (category === '*' || entry.categoryId === category))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    $('warehouse-summary').textContent = `${data.entries.length} 个主题 · ${data.categories.length} 个分类 · 最近更新优先`;
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
    thumbnailObserver = new IntersectionObserver((observations) => {
      observations.forEach(async (observation) => {
        if (!observation.isIntersecting) return;
        const cover = observation.target;
        thumbnailObserver.unobserve(cover);
        const entry = entries.find((value) => value.id === cover.dataset.id);
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
    entries.forEach((entry) => {
      const card = node('article', 'warehouse-card');
      card.dataset.entryId = entry.id;
      if (selectedEntries.has(entry.id)) card.classList.add('selected');
      const openButton = node('button', 'warehouse-card-open');
      openButton.type = 'button';
      openButton.setAttribute('aria-label', `打开主题 ${entry.name}`);
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
        showContextMenu(event.clientX, event.clientY);
      });
      const actions = node('div', 'warehouse-card-actions');
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
      actions.append(chooseCover, edit, update);
      card.append(openButton, actions);
      grid.appendChild(card);
      thumbnailObserver.observe(cover);
    });
  }

  let lastSelectedIndex = -1;
  function toggleSelection(entryId, shiftKey) {
    const entries = data.entries;
    const index = entries.findIndex((entry) => entry.id === entryId);
    if (shiftKey && lastSelectedIndex >= 0) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      for (let i = start; i <= end; i++) {
        selectedEntries.add(entries[i].id);
      }
    } else {
      if (selectedEntries.has(entryId)) selectedEntries.delete(entryId);
      else selectedEntries.add(entryId);
      lastSelectedIndex = index;
    }
    syncBatchActions();
    renderCards();
  }

  function syncBatchActions() {
    const count = selectedEntries.size;
    $('warehouse-batch-category').disabled = count === 0;
    $('warehouse-selection-count').textContent = count ? `已选择 ${count} 个主题` : '';
  }

  function showContextMenu(x, y) {
    const menu = document.createElement('div');
    menu.className = 'warehouse-context-menu';
    menu.style.cssText = `position: fixed; left: ${x}px; top: ${y}px; z-index: 10000;`;
    const batchCategory = node('button', '', '批量修改分类');
    batchCategory.addEventListener('click', () => {
      menu.remove();
      attempt(batchChangeCategory);
    });
    menu.append(batchCategory);
    document.body.appendChild(menu);
    const close = () => {
      menu.remove();
      document.removeEventListener('click', close);
    };
    setTimeout(() => document.addEventListener('click', close), 100);
  }

  function batchChangeCategory() {
    checkIdle();
    if (selectedEntries.size === 0) throw new Error('请先选择要修改的主题');
    const dialog = document.createElement('dialog');
    dialog.className = 'warehouse-batch-dialog';
    const title = node('h3', '', `批量修改分类（已选择 ${selectedEntries.size} 个主题）`);
    const select = node('select');
    categoryOptions(select, false, '');
    const actions = node('div', 'dialog-actions');
    const cancel = node('button', '', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dialog.close());
    const confirm = node('button', 'primary', '确认');
    confirm.type = 'button';
    confirm.addEventListener('click', () => attempt(() => {
      const archive = store();
      let count = 0;
      selectedEntries.forEach((id) => {
        try {
          const entry = data.entries.find((e) => e.id === id);
          if (entry) {
            archive.setCategory(id, select.value, entry.updatedAt);
            count++;
          }
        } catch (error) {
          console.error(`修改主题 ${id} 分类失败:`, error);
        }
      });
      data = archive.list();
      selectedEntries.clear();
      dialog.close();
      renderCards();
      hooks.toast(`已修改 ${count} 个主题的分类`);
    }));
    actions.append(cancel, confirm);
    dialog.append(title, select, actions);
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove());
  }

  async function open() {
    await attempt(async () => {
      checkIdle();
      try { data = store().list(); }
      catch (error) { recoveryDialog(); throw error; }
      const pathMap = await Bridge.refreshPathMap();
      itemsById = new Map([...pathMap.values()].map((item) => [item.id, item]));
      Search.pausePreview();
      categoryOptions($('warehouse-category'), true, $('warehouse-category').value || '*');
      document.body.dataset.page = 'warehouse';
      $('warehouse-page').classList.remove('hidden');
      renderCards();
    });
  }

  function syncTopicMeta() {
    $('topic-meta').textContent = `${countText(current)} · 最近更新 ${dateText(current.updatedAt)}`;
  }

  function syncTopic() {
    document.body.dataset.topic = 'true';
    $('warehouse-topic').classList.remove('hidden');
    $('topic-name').textContent = current.name;
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
  }

  async function saveCover() {
    checkIdle();
    if (!current) throw new Error('请先在仓库中打开一个主题');
    const entry = current;
    const library = eagle.library.path;
    const archive = store();
    coverSaving = true;
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
      button.disabled = false;
      button.textContent = '当前帧设为封面';
    }
  }

  async function load(entry) {
    checkIdle();
    const library = eagle.library.path;
    await store().hydrateEntry(entry);
    if (library !== eagle.library.path) throw new Error('素材库已切换，请重新打开主题');
    await Search.loadResults(entry.matches, entry.recipe?.query || entry.query || entry.name,
      entry.recipe, entry.view, entry.newKeys || [], localTime(entry));
    current = entry;
    $('query').value = entry.recipe?.query || entry.query || '';
    $('view-sort').value = entry.view.sortBy;
    $('view-min-dur').value = entry.view.minDur;
    $('view-grouped').checked = entry.view.grouped;
    showSearch();
    syncTopic();
  }

  async function refreshEntry(entry, recipe, savedView = entry.view) {
    checkIdle();
    const library = eagle.library.path;
    const archive = store();
    await archive.hydrateEntry(entry);
    if (library !== eagle.library.path) throw new Error('素材库已切换，请重新打开主题');
    recipe = recipe === undefined ? entry.recipe : recipe;
    if (!recipe) { await editEntry(entry); return; }
    if (!hooks.canSearch()) throw new Error('搜索服务未就绪或正在建索引，请稍后更新');
    updating = true;
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
      updated = archive.replace(updated, entry.updatedAt);
      data = archive.list();
      // 此时更新已落盘，才允许装载；load 内仍防止其他搜索并发。
      updating = false;
      await load(updated);
      hooks.toast(`更新完成：${matches.length} 个片段，本次新增 ${updated.newKeys.length}`
        + (result.missingDates ? `；${result.missingDates} 个素材缺少导入时间，已排除` : ''), false, 6500);
      return updated;
    } finally {
      updating = false;
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
    await store().hydrateEntry(entry);
    Search.pausePreview();
    data = store().list();
    editing = SearchRecipe.clone(entry);
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

  async function saveCurrent() {
    await attempt(async () => {
      checkIdle();
      const recipe = Search.getRecipe();
      if (!recipe) throw new Error('旧存档请先在仓库中编辑并补齐条件');
      savingMatches = SearchRecipe.clone(Search.getAllMatches());
      savingView = Search.getView();
      if (!savingMatches.length) throw new Error('当前筛选下没有可保存的结果');
      data = store().list();
      draft = await SearchRecipe.persistSource(recipe);
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
          await refreshEntry(renamed, persisted, view);
        } else {
          renamed = store().replace(renamed, editing.updatedAt);
          data = store().list();
          if (current?.id === renamed.id && document.body.dataset.page !== 'warehouse') await load(renamed);
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
    const run = async (action) => { try { await action(); } catch (error) { status.textContent = error.message; } };
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
    exportButton.addEventListener('click', () => run(() => {
      guard(); const blob = new Blob([archive.exportBundle()], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const link = node('a');
      link.href = url; link.download = `warehouse-${Date.now()}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
    const input = node('input'); input.type = 'file'; input.accept = '.json';
    const moveLabel = node('label', '', '我确认这是搬家后的同一素材库：允许导入异路径仓库（仅快照，更新前需重设条件）');
    const moveCheck = node('input'); moveCheck.type = 'checkbox'; moveLabel.prepend(moveCheck);
    input.setAttribute('aria-label', '导入同库仓库包（合并，不覆盖同 ID 主题）');
    input.addEventListener('change', () => run(async () => {
      const file = input.files[0]; if (!file) return;
      if (file.size > 128 * 1024 * 1024) throw new Error('仓库包超过 128 MB，请分批整理后导入');
      const text = await file.text(); guard();
      const count = archive.importBundle(text, { allowLibraryMove: moveCheck.checked });
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
          guard(); archive.restore(item.trashId); button.disabled = true; status.textContent = '主题已恢复'; await open();
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
        archive.restoreBackup(item.name); button.disabled = true; detachTopic();
        status.textContent = '已恢复；恢复前的文件已另存为备份'; return open();
      })); row.append(button); dialog.append(row);
    });
    const close = node('button', '', '关闭'); close.type = 'button';
    close.addEventListener('click', () => dialog.close()); dialog.append(close);
    if (!dialog.open) dialog.showModal();
  }

  function init(callbacks) {
    hooks = callbacks;
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
    $('warehouse-query').addEventListener('input', renderCards);
    $('warehouse-category').addEventListener('change', renderCards);
    $('warehouse-view-card').addEventListener('click', () => {
      viewMode = 'card';
      $('warehouse-view-card').classList.add('active');
      $('warehouse-view-list').classList.remove('active');
      renderCards();
    });
    $('warehouse-view-list').addEventListener('click', () => {
      viewMode = 'list';
      $('warehouse-view-list').classList.add('active');
      $('warehouse-view-card').classList.remove('active');
      renderCards();
    });
    $('warehouse-batch-category').addEventListener('click', () => attempt(batchChangeCategory));
    $('topic-back').addEventListener('click', () => {
      selectedEntries.clear();
      open();
    });
    $('topic-search').addEventListener('click', () => attempt(() => { checkIdle(); detachTopic(); $('query').focus(); }));
    $('topic-edit').addEventListener('click', () => attempt(() => editEntry(current)));
    $('topic-update').addEventListener('click', () => attempt(() => refreshEntry(current)));
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
