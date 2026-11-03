/* 保存/编辑主题表单、条件回填与提交。 */
const WarehouseEditor = (() => {
  function create(hooks) {
    const { $, node, countVideos, categoryPicker, rememberCategory, categoryOptions, store,
      checkIdle, attempt, beginNavigation, currentNavigation, load, refreshEntry,
      renderCards, confirmButton, detachTopic, open } = hooks;
    let editing = null;
    let editingLibrary = null;
    let editorCategoryPicker = null;
    let draft = null;
    let savingMatches = [];
    let savingView = null;
    let editorToken = 0;
    const boolKeys = ['visualCentered', 'aiEnhance', 'aiExpand', 'miniRerank'];
    const numberKeys = ['visualThreshold', 'visualMargin', 'visualSceneFrames', 'visualVideoFrames'];

    function fillEditor(entry, recipe, view) {
      $('warehouse-editor-error').textContent = '';
      $('entry-name').value = entry?.name || (recipe?.refinement
        ? `${recipe.refinement.label} → ${recipe.query}` : recipe?.query) || '未命名';
      editorCategoryPicker = categoryPicker(entry?.categoryId || '', eagle.library.path);
      $('entry-category').replaceChildren(editorCategoryPicker.element);
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
      $('entry-folders').classList.toggle('hidden', recipe.scope.mode === 'all');
      $('entry-extra-exclusions').textContent = recipe.scope.excludeFolderIds?.length
        ? `此条件另排除了 ${recipe.scope.excludeFolderIds.length} 个文件夹；改为“整个库”可清除这些排除。` : '';
      $('entry-replace-source').classList.toggle('hidden', recipe.kind === 'text');
      $('entry-source').textContent = recipe.kind === 'text' ? '文本搜索'
        : `${recipe.kind === 'hybrid' ? '文本 × 视觉混合搜索' : '视觉搜索'} · ${recipe.payload?.video_path || '已保存查询图片'}`;
      if (recipe.refinement) $('entry-source').textContent += ` · 在「${recipe.refinement.label}」的 ${recipe.refinement.scenes.length} 个固定候选镜头中搜索；上一轮权重 ${10 - recipe.refinement.weight} / 新词权重 ${recipe.refinement.weight}`;
      $('entry-refine-controls').classList.toggle('hidden', !recipe.refinement);
      $('entry-refine-weight').disabled = !recipe.refinement;
      $('entry-refine-weight').value = recipe.refinement?.weight ?? 10;
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
      hooks.reloadData();
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

    async function saveCurrent() {
      await attempt(async () => {
        checkIdle();
        const navigation = beginNavigation();
        const recipe = Search.getRecipe();
        if (!recipe) throw new Error('旧存档请先在仓库中编辑并补齐条件');
        if (!hooks.current()) {
          const context = await SearchRecipe.currentContext();
          if (!currentNavigation(navigation)) return;
          checkIdle();
          recipe.scope = context.scope;
          recipe.time = context.time;
          if (recipe.kind === 'text') recipe.config.threshold = Search.getArchiveFilter().minScore ?? 0;
        }
        savingMatches = SearchRecipe.clone(Search.getAllMatches());
        savingView = Search.getView();
        if (!savingMatches.length) throw new Error('当前筛选下没有可保存的结果');
        hooks.reloadData();
        draft = await SearchRecipe.persistSource(recipe);
        if (!currentNavigation(navigation)) return;
        checkIdle();
        editing = null;
        editingLibrary = eagle.library.path;
        $('warehouse-editor-title').textContent = '保存到仓库';
        $('warehouse-editor-hint').textContent = `保存 ${countVideos(savingMatches)} 个素材 / ${savingMatches.length} 个片段及当前筛选条件。`;
        fillEditor(null, draft, savingView);
        $('entry-submit').textContent = '保存主题';
        $('warehouse-editor').showModal();
      });
    }

    function readDraft() {
      const recipe = SearchRecipe.clone(draft);
      if (recipe.refinement) {
        const weight = Number($('entry-refine-weight').value);
        if (!Number.isFinite(weight) || weight < 0 || weight > 10) throw new Error('新词权重应为 0～10');
        recipe.refinement.weight = weight;
      }
      recipe.config = SearchRecipe.options(recipe.config);
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
      const scopeMode = $('entry-scope').value;
      const extra = recipe.scope.excludeFolderIds;
      recipe.scope = scopeMode === 'all' ? { mode: 'all' } : { mode: scopeMode, folderIds: ids };
      if (scopeMode !== 'all' && extra?.length) recipe.scope.excludeFolderIds = extra;
      if (scopeMode !== 'all' && !ids.length) throw new Error('请至少选择一个文件夹');
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
          if (copy.scope.excludeFolderIds) copy.scope.excludeFolderIds.sort();
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
        if (editingLibrary !== eagle.library.path) throw new Error('素材库已切换，请重新打开并确认');
        const categoryId = editorCategoryPicker.getValue();
        editorCategoryPicker.setDisabled(true);
        if (!editing) {
          const entry = store().add({ name, categoryId, recipe: draft, view: savingView, matches: savingMatches });
          rememberCategory(editingLibrary, entry.categoryId);
          hooks.reloadData();
          await load(entry);
          hooks.toast(`已保存主题「${name}」`);
        } else {
          const { recipe, view } = readDraft();
          let renamed = { ...editing, name, categoryId, view, metadataUpdatedAt: new Date().toISOString() };
          if (!equivalent(recipe, editing.recipe)) {
            const persisted = await SearchRecipe.persistSource(recipe);
            const updated = await refreshEntry(renamed, persisted, view);
            if (!updated) return;
            rememberCategory(editingLibrary, updated.categoryId);
          } else {
            renamed = store().replace(renamed, editing.updatedAt);
            rememberCategory(editingLibrary, renamed.categoryId);
            hooks.reloadData();
            categoryOptions($('warehouse-category'), true, $('warehouse-category').value);
            if (hooks.current()?.id === renamed.id && document.body.dataset.page !== 'warehouse') await load(renamed, { resetView: true });
            if (document.body.dataset.page === 'warehouse') renderCards();
            hooks.toast('主题信息已保存');
          }
        }
        $('warehouse-editor').close();
      } catch (error) {
        $('warehouse-editor-error').textContent = error.message;
      } finally {
        $('entry-submit').disabled = false; editorCategoryPicker.setDisabled(false);
        WarehouseNavigation.refresh();
      }
    }

    function init() {
      $('entry-time').addEventListener('change', () => $('entry-time-dates').classList.toggle('hidden', $('entry-time').value !== 'custom'));
      $('entry-scope').addEventListener('change', () => $('entry-folders').classList.toggle('hidden', $('entry-scope').value === 'all'));
      $('entry-copy')?.addEventListener('click', () => attempt(() => hooks.copyTopic(editing, editingLibrary)));
      $('warehouse-form').addEventListener('submit', submit);
      $('entry-cancel').addEventListener('click', () => { if (!hooks.isUpdating()) $('warehouse-editor').close(); });
      $('warehouse-editor').addEventListener('cancel', (event) => { if (hooks.isUpdating()) event.preventDefault(); });
      $('warehouse-editor').addEventListener('close', () => { editorToken += 1; });
      $('entry-delete').addEventListener('click', () => attempt(() => {
        checkIdle();
        confirmButton($('entry-delete'), () => {
          store().remove(editing.id);
          if (hooks.current()?.id === editing.id) detachTopic();
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
        delete draft.sourceMissing;
        $('entry-source').textContent = `新查询来源：${item.name}`;
      }));
    }

    return { init, editEntry, saveCurrent };
  }

  return { create };
})();
