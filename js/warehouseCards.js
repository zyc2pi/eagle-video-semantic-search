/* 仓库卡片/列表、分页、框选及右键批量操作。 */
const WarehouseCards = (() => {
  function create(hooks) {
    const { $, node, dateText, countVideos, categoryName, categoryOptions, categoryPicker, rememberCategory,
      store, checkIdle, attempt, hidePositionNotice, showPositionNotice, forgetWarehousePosition,
      load, editEntry, toggleFavorite, refreshEntry, detachTopic } = hooks;
    const state = { library: null, rendered: 0, viewMode: 'card', favoritesOnly: false };
    let data;
    let thumbnailObserver;
    let warehouseRenderToken = 0;
    const selectedEntries = new Set();
    let visibleEntryIds = [];
    let selectionAnchor = null;
    let queryTimer;
    let closeContextMenu = () => {};
    let cancelBoxSelection = () => {};
    const pageSize = 60;
    const viewPreferenceKey = 'eagle-semantic-warehouse-view';

    function renderCards(position = null) {
      data = hooks.getData();
      WarehouseNavigation.refresh();
      cancelBoxSelection();
      const token = ++warehouseRenderToken;
      hidePositionNotice();
      clearTimeout(queryTimer);
      closeContextMenu();
      thumbnailObserver?.disconnect();
      const grid = $('warehouse-grid');
      grid.replaceChildren();
      grid.scrollTop = 0;
      state.rendered = 0;
      grid.className = `warehouse-grid ${state.viewMode === 'list' ? 'list-view' : ''}`;
      const query = $('warehouse-query').value.trim().toLocaleLowerCase();
      const category = $('warehouse-category').value;
      const categoryIds = ArchiveStore.categoryTree(data.categories).byId.get(category)?.ids || new Set([category]);
      const entries = data.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query)
        && (category === '*' || categoryIds.has(entry.categoryId || '')) && (!state.favoritesOnly || entry.favorite === true))
        .sort((a, b) => Number(b.favorite === true) - Number(a.favorite === true)
          || String(b.updatedAt).localeCompare(String(a.updatedAt)));
      visibleEntryIds = entries.map((entry) => entry.id);
      const visibleIds = new Set(visibleEntryIds);
      for (const id of selectedEntries) if (!visibleIds.has(id)) selectedEntries.delete(id);
      if (!visibleIds.has(selectionAnchor)) selectionAnchor = null;
      $('warehouse-summary').textContent = `${data.entries.length} 个主题 · ${data.categories.length} 个分类 · 常用优先`;
      $('warehouse-favorites').setAttribute('aria-pressed', String(state.favoritesOnly));
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
        cover.append(node('span', 'warehouse-cover-mark', entry.name.slice(0, 2)));
        const body = node('div', 'warehouse-card-body');
        body.title = entry.name;
        const heading = node('div', 'warehouse-card-heading');
        heading.append(node('h2', '', entry.name), node('span', 'warehouse-category-badge', categoryName(entry.categoryId)));
        body.append(heading,
          node('p', 'warehouse-count', `${(entry.summary?.videos ?? countVideos(entry.matches)).toLocaleString('zh-CN')} 个素材 · ${(entry.summary?.matches ?? entry.matches.length).toLocaleString('zh-CN')} 个片段`),
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
        state.rendered = rendered;
        if (rendered < entries.length) {
          more.textContent = `显示更多（已显示 ${rendered} / ${entries.length}）`;
          grid.appendChild(more);
        }
      };
      more.addEventListener('click', appendPage);
      appendPage();
      if (position) requestAnimationFrame(() => {
        if (token !== warehouseRenderToken || document.body.dataset.page !== 'warehouse' || state.library !== eagle.library.path) return;
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
      $('warehouse-selection-count').textContent = count ? `已选择 ${count} 个主题` : '';
    }

    function initBoxSelection() {
      const grid = $('warehouse-grid');
      grid.addEventListener('contextmenu', (event) => {
        if (event.target.closest('.warehouse-card, button, input, select')) return;
        event.preventDefault();
        if (selectedEntries.size) showContextMenu(event.clientX, event.clientY, grid);
      });
      grid.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !event.isPrimary || document.body.dataset.page !== 'warehouse'
            || state.library !== eagle.library.path
            || event.target.closest('.warehouse-card, button, input, select')) return;
        const bounds = grid.getBoundingClientRect();
        if (event.clientX >= bounds.left + grid.clientWidth) return; // 保留原生滚动条。
        cancelBoxSelection();
        closeContextMenu();
        event.preventDefault();
        const original = new Set(selectedEntries);
        const additive = event.ctrlKey || event.metaKey || event.shiftKey;
        const anchor = selectionAnchor;
        const startX = event.clientX - bounds.left + grid.scrollLeft;
        const startY = event.clientY - bounds.top + grid.scrollTop;
        let x = event.clientX;
        let y = event.clientY;
        let dragging = false;
        let frame;
        const box = node('div', 'warehouse-selection-box');
        box.hidden = true;
        document.body.appendChild(box);
        grid.classList.add('selecting');
        grid.setPointerCapture(event.pointerId);
        const update = () => {
          const rect = grid.getBoundingClientRect();
          const endX = Math.max(0, Math.min(grid.clientWidth, x - rect.left)) + grid.scrollLeft;
          const endY = Math.max(0, Math.min(grid.clientHeight, y - rect.top)) + grid.scrollTop;
          if (!dragging && Math.hypot(endX - startX, endY - startY) < 4) return;
          dragging = true;
          const left = Math.min(startX, endX);
          const right = Math.max(startX, endX);
          const top = Math.min(startY, endY);
          const bottom = Math.max(startY, endY);
          const screenLeft = Math.max(rect.left, rect.left + left - grid.scrollLeft);
          const screenTop = Math.max(rect.top, rect.top + top - grid.scrollTop);
          box.hidden = false;
          box.style.left = `${screenLeft}px`;
          box.style.top = `${screenTop}px`;
          box.style.width = `${Math.max(0, Math.min(rect.left + grid.clientWidth, rect.left + right - grid.scrollLeft) - screenLeft)}px`;
          box.style.height = `${Math.max(0, Math.min(rect.top + grid.clientHeight, rect.top + bottom - grid.scrollTop) - screenTop)}px`;
          selectedEntries.clear();
          if (additive) original.forEach((id) => selectedEntries.add(id));
          grid.querySelectorAll('.warehouse-card').forEach((card) => {
            const cardRect = card.getBoundingClientRect();
            const cardLeft = cardRect.left - rect.left + grid.scrollLeft;
            const cardTop = cardRect.top - rect.top + grid.scrollTop;
            if (cardLeft < right && cardLeft + cardRect.width > left
                && cardTop < bottom && cardTop + cardRect.height > top) selectedEntries.add(card.dataset.entryId);
          });
          selectionAnchor = [...selectedEntries][0] || null;
          syncBatchActions(); syncSelectionCards();
        };
        const finish = (cancelled) => {
          cancelAnimationFrame(frame);
          grid.removeEventListener('pointermove', move);
          grid.removeEventListener('pointerup', up);
          grid.removeEventListener('pointercancel', cancel);
          grid.removeEventListener('lostpointercapture', cancel);
          grid.removeEventListener('scroll', update);
          document.removeEventListener('keydown', keyboard);
          window.removeEventListener('blur', cancel);
          if (grid.hasPointerCapture(event.pointerId)) grid.releasePointerCapture(event.pointerId);
          box.remove(); grid.classList.remove('selecting');
          cancelBoxSelection = () => {};
          if (cancelled || (!dragging && !additive)) {
            selectedEntries.clear();
            if (cancelled) original.forEach((id) => selectedEntries.add(id));
            selectionAnchor = cancelled ? anchor : null;
            syncBatchActions(); syncSelectionCards();
          }
        };
        const move = (next) => {
          if (next.pointerId !== event.pointerId) return;
          x = next.clientX; y = next.clientY; update();
        };
        const up = (next) => { if (next.pointerId === event.pointerId) { move(next); finish(false); } };
        const cancel = () => finish(true);
        const keyboard = (key) => { if (key.key === 'Escape') { key.preventDefault(); cancel(); } };
        const scroll = () => {
          if (document.body.dataset.page !== 'warehouse' || state.library !== eagle.library.path) { cancel(); return; }
          if (dragging) {
            const rect = grid.getBoundingClientRect();
            const speed = y < rect.top + 28 ? -Math.min(18, (rect.top + 28 - y) / 2)
              : y > rect.bottom - 28 ? Math.min(18, (y - rect.bottom + 28) / 2) : 0;
            if (speed) { grid.scrollTop += speed; update(); }
          }
          frame = requestAnimationFrame(scroll);
        };
        cancelBoxSelection = cancel;
        grid.addEventListener('pointermove', move);
        grid.addEventListener('pointerup', up);
        grid.addEventListener('pointercancel', cancel);
        grid.addEventListener('lostpointercapture', cancel);
        grid.addEventListener('scroll', update);
        document.addEventListener('keydown', keyboard);
        window.addEventListener('blur', cancel);
        frame = requestAnimationFrame(scroll);
      });
    }

    function showContextMenu(x, y, trigger) {
      closeContextMenu();
      const menu = document.createElement('div');
      menu.className = 'warehouse-context-menu';
      menu.setAttribute('role', 'menu');
      menu.style.cssText = `position: fixed; left: ${x}px; top: ${y}px; z-index: 10000;`;
      const actions = [
        { label: '批量修改分类', run: () => batchEditEntries() },
        { label: '删除所选主题', run: () => batchEditEntries(true) },
      ];
      actions.forEach((item) => {
        const button = node('button', '', item.label);
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.disabled = item.disabled || false;
        button.addEventListener('click', () => {
          closeContextMenu();
          attempt(item.run);
        });
        menu.append(button);
      });
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
      menu.querySelector('button').focus();
    }

    function batchEditEntries(deleting = false) {
      checkIdle();
      if (state.library !== eagle.library.path) throw new Error('素材库已切换，请重新打开仓库');
      if (selectedEntries.size === 0) throw new Error('请先选择要操作的主题');
      const verb = deleting ? '删除' : '修改';
      const dialog = document.createElement('dialog');
      dialog.className = 'warehouse-batch-dialog';
      const title = node('h3', '', `${deleting ? '删除所选主题' : '批量修改分类'}（已选择 ${selectedEntries.size} 个主题）`);
      const archive = store();
      const library = eagle.library.path;
      const picker = deleting ? null : categoryPicker('', library);
      let requests = [...selectedEntries].map((id) => {
        const entry = data.entries.find((value) => value.id === id);
        return { id, name: entry?.name || id, updatedAt: entry?.updatedAt, revision: entry?.revision };
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
        pending = true; confirm.disabled = true; cancel.disabled = true; picker?.setDisabled(true);
        lockedCategory ??= picker?.getValue();
        let results;
        try {
          checkIdle();
          if (library !== eagle.library.path) throw new Error('素材库已切换，请重新打开并确认');
          results = (await (deleting ? archive.removeEntries(requests) : archive.setCategories(requests, lockedCategory))).results;
        } catch (error) {
          results = requests.map(({ id }) => ({ id, ok: false, error: error.message }));
        }
        const resultById = new Map((results || []).map((result) => [result.id, result]));
        const failures = requests.map((request) => resultById.get(request.id)
          || { id: request.id, ok: false, error: '未收到保存结果，请重试' }).filter((result) => !result.ok);
        const count = requests.length - failures.length;
        const successfulCategory = !deleting && results?.find((result) => result.ok)?.categoryId;
        if (typeof successfulCategory === 'string') {
          lockedCategory = successfulCategory;
          rememberCategory(library, successfulCategory);
        }
        if (deleting && library === hooks.currentLibrary() && results?.some((result) => result.ok && result.id === hooks.current()?.id)) detachTopic();
        const requestNames = new Map(requests.map((request) => [request.id, request.name]));
        selectedEntries.clear();
        failures.forEach((result) => selectedEntries.add(result.id));
        const failedIds = new Set(failures.map((result) => result.id));
        requests = requests.filter((request) => failedIds.has(request.id));
        conflict = failures.some((result) => result.code === 'conflict' || result.code === 'missing'
          || /冲突|已修改|版本|重新打开|已切换/.test(result.error || ''));
        status.replaceChildren(node('p', '', `已${verb} ${count} 个主题，失败 ${failures.length} 个。`));
        failures.forEach((result) => status.appendChild(node('p', 'error',
          `${requestNames.get(result.id)}：${result.error || '保存失败'}`)));
        if (conflict) status.appendChild(node('p', 'error', '有主题或素材库已变化，请关闭对话框、重新打开仓库后再次选择并确认。'));
        if (library === eagle.library.path) {
          try { data = archive.list(); hooks.setData(data); } catch (error) { status.appendChild(node('p', 'error', error.message)); }
          categoryOptions($('warehouse-category'), true, $('warehouse-category').value);
        }
        // 保存后只更新当前卡片的分类；失败项仍然可见并保持选择。
        $('warehouse-grid').querySelectorAll('.warehouse-card').forEach((card) => {
          const entry = data.entries.find((value) => value.id === card.dataset.entryId);
          if (entry) card.querySelector('.warehouse-category-badge').textContent = categoryName(entry.categoryId);
          else if (deleting) card.remove();
        });
        syncBatchActions(); syncSelectionCards();
        pending = false; cancel.disabled = false;
        confirm.textContent = '重试失败项'; confirm.disabled = conflict;
        if (!failures.length) {
          dialog.close(); renderCards();
          hooks.toast(deleting ? `已删除 ${count} 个主题，可从「备份 / 回收站」恢复` : `已修改 ${count} 个主题的分类`);
        }
      });
      actions.append(cancel, confirm);
      dialog.append(title);
      if (deleting) dialog.append(node('p', 'hint', '所选主题将移入回收站，不删除 Eagle 中的原素材。'));
      else dialog.append(picker.element);
      dialog.append(status, actions);
      document.body.appendChild(dialog);
      dialog.showModal();
      picker?.focus();
      dialog.addEventListener('close', () => dialog.remove());
      dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
    }

    function syncViewButtons() {
      $('warehouse-view-card').classList.toggle('active', state.viewMode === 'card');
      $('warehouse-view-list').classList.toggle('active', state.viewMode === 'list');
      $('warehouse-view-card').setAttribute('aria-pressed', String(state.viewMode === 'card'));
      $('warehouse-view-list').setAttribute('aria-pressed', String(state.viewMode === 'list'));
    }

    function init() {
      try { if (localStorage.getItem(viewPreferenceKey) === 'list') state.viewMode = 'list'; }
      catch { /* 偏好不可用时保留会话状态。 */ }
      const setViewMode = (value) => {
        state.viewMode = value;
        try { localStorage.setItem(viewPreferenceKey, value); } catch { /* 降级为会话内记忆。 */ }
        syncViewButtons();
        if (data) renderCards();
      };
      setViewMode(state.viewMode);
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
        state.favoritesOnly = !state.favoritesOnly;
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
      initBoxSelection();
    }

    return { init, state, render: renderCards, syncViewButtons,
      clearSelection: () => selectedEntries.clear(), closeContextMenu: () => closeContextMenu(),
      cancelBoxSelection: () => cancelBoxSelection(), clearQuery: () => clearTimeout(queryTimer) };
  }

  return { create };
})();
