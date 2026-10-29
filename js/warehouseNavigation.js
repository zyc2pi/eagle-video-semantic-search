/* 常驻分类导航；只保存浏览偏好，不复制主题结果或搜索范围。 */
const WarehouseNavigation = (() => {
  const $ = (id) => document.getElementById(id);
  let hooks;
  let library;
  let started = false;
  let restoring = false;
  let timer;
  let collapsed = new Set();
  const storageKey = () => `eagle-semantic-navigation:${SearchRecipe.normalize(library)}`;
  const folderIcon = '▱';

  function save() {
    clearTimeout(timer);
    if (!started || restoring || library !== eagle.library.path) return;
    const state = hooks.capture();
    if (!state) return;
    try {
      localStorage.setItem(storageKey(), JSON.stringify({ ...state,
        collapsed: [...collapsed], sidebarScroll: $('library-tree').scrollTop,
        sidebarQuery: $('library-query').value }));
    } catch { /* 存储不可用时继续保留当前会话。 */ }
  }
  function scheduleSave() { clearTimeout(timer); timer = setTimeout(save, 180); }

  function row(label, icon, action, active, count) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'library-nav-row'; button.title = label;
    const symbol = document.createElement('span');
    symbol.textContent = icon; symbol.setAttribute('aria-hidden', 'true');
    if (icon === folderIcon) symbol.innerHTML = '<svg viewBox="0 0 16 16"><path d="M1.5 4h5l1.5 1.5h6.5v8h-13z"/><path d="M1.5 4V2.5h5L8 4h6.5v1.5"/></svg>';
    const text = document.createElement('span');
    text.className = 'library-nav-label'; text.textContent = label;
    button.append(symbol, text);
    if (count != null) {
      const badge = document.createElement('span');
      badge.className = 'library-nav-count'; badge.textContent = count;
      button.append(badge);
    }
    if (active) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => {
      if (library !== eagle.library.path) return;
      hooks.attempt(action);
    });
    return button;
  }

  function refresh() {
    if (!hooks || library !== eagle.library.path) return;
    const tree = $('library-tree');
    const scroll = tree.scrollTop;
    const focusId = tree.contains(document.activeElement) ? document.activeElement.dataset.navId : null;
    let snapshot;
    try { snapshot = hooks.snapshot(); }
    catch (error) {
      tree.textContent = `无法读取仓库：${error.message}`;
      return;
    }
    const state = hooks.active();
    const query = $('library-query').value.trim().toLocaleLowerCase();
    const fragment = document.createDocumentFragment();
    fragment.append(row('全部主题', '▦', () => hooks.openCollection('*', false),
      state.page === 'warehouse' && state.category === '*' && !state.favoritesOnly, snapshot.entries.length));
    fragment.append(row('常用主题', '☆', () => hooks.openCollection('*', true),
      state.page === 'warehouse' && state.favoritesOnly, snapshot.entries.filter((entry) => entry.favorite).length));
    const categories = ArchiveStore.categoryTree(snapshot.categories);
    const entriesByCategory = new Map();
    for (const entry of snapshot.entries) {
      const id = categories.byId.has(entry.categoryId) ? entry.categoryId : '';
      if (!entriesByCategory.has(id)) entriesByCategory.set(id, []);
      entriesByCategory.get(id).push(entry);
    }
    const renderGroup = (category) => {
      const expanded = !!query || !collapsed.has(category.id);
      const entries = (entriesByCategory.get(category.id) || []).slice().sort((a, b) =>
        Number(!!b.favorite) - Number(!!a.favorite) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const matches = category.path.toLocaleLowerCase().includes(query) ? entries
        : entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query));
      const children = expanded ? category.children.map(renderGroup).filter(Boolean) : [];
      if (query && !matches.length && !children.length && !category.path.toLocaleLowerCase().includes(query)) return null;
      const group = document.createElement('section'); group.className = 'library-group';
      const heading = document.createElement('div'); heading.className = 'library-group-heading';
      const disclosure = document.createElement('button');
      disclosure.type = 'button'; disclosure.className = 'library-disclosure';
      disclosure.dataset.navId = `folder:${category.id}`;
      disclosure.textContent = expanded ? '▾' : '▸';
      disclosure.setAttribute('aria-label', `${expanded ? '收起' : '展开'}${category.name}`);
      disclosure.setAttribute('aria-expanded', String(expanded));
      disclosure.addEventListener('click', () => {
        if (expanded) collapsed.add(category.id); else collapsed.delete(category.id);
        refresh(); scheduleSave();
      });
      const count = [...category.ids].reduce((total, id) => total + (entriesByCategory.get(id)?.length || 0), 0);
      const folder = row(category.name, folderIcon, () => hooks.openCollection(category.id, false),
        state.page === 'warehouse' && !state.favoritesOnly && state.category === category.id, count);
      folder.title = category.path; folder.dataset.navId = `category:${category.id}`;
      heading.append(disclosure, folder);
      group.append(heading);
      const content = document.createElement('div'); content.className = 'library-children';
      content.append(...children);
      if (expanded) for (const entry of matches) {
        const topic = row(entry.name, entry.favorite ? '★' : '▫', () => hooks.openTopic(entry.id),
          state.page !== 'warehouse' && state.topicId === entry.id);
        topic.classList.add('library-topic'); topic.dataset.navId = `topic:${entry.id}`;
        content.append(topic);
      }
      if (expanded) group.append(content);
      return group;
    };
    const roots = [...categories.roots, { id: '', name: '未分类', path: '未分类', children: [], ids: new Set(['']) }];
    fragment.append(...roots.map(renderGroup).filter(Boolean));
    if (query && !fragment.querySelector('.library-group')) {
      const empty = document.createElement('p'); empty.className = 'library-nav-empty';
      empty.textContent = '没有匹配的分类或主题。'; fragment.append(empty);
    }
    if (!snapshot.entries.length) {
      const empty = document.createElement('p'); empty.className = 'library-nav-empty';
      empty.textContent = '保存搜索结果后，主题会出现在这里。'; fragment.append(empty);
    }
    tree.replaceChildren(fragment); tree.scrollTop = scroll;
    if (focusId) [...tree.querySelectorAll('[data-nav-id]')]
      .find((item) => item.dataset.navId === focusId)?.focus({ preventScroll: true });
    $('library-new-search').setAttribute('aria-current', state.page !== 'warehouse' && !state.topicId ? 'page' : 'false');
    scheduleSave();
  }

  function initResize() {
    const resizer = $('library-resizer');
    const sidebar = $('library-sidebar');
    const key = 'eagle-semantic-library-width';
    let preferred = 240;
    let drag = null;
    try { const saved = Number(localStorage.getItem(key)); if (saved >= 120 && saved <= 560) preferred = saved; } catch { /* 会话内偏好。 */ }
    const bounds = () => {
      const max = Math.max(120, Math.min(560, document.body.clientWidth - 366));
      return { min: Math.min(180, max), max };
    };
    const apply = () => {
      const { min, max } = bounds();
      const width = Math.round(Math.max(min, Math.min(max, preferred)));
      document.body.style.setProperty('--library-width', `${width}px`);
      resizer.setAttribute('aria-valuemin', min); resizer.setAttribute('aria-valuemax', max);
      resizer.setAttribute('aria-valuenow', width);
    };
    const persist = () => { try { localStorage.setItem(key, String(preferred)); } catch { /* 会话内偏好。 */ } };
    const finish = (event) => {
      if (!drag || (event.pointerId != null && event.pointerId !== drag.id)) return;
      const id = drag.id; drag = null;
      document.body.classList.remove('resizing-library');
      if (resizer.hasPointerCapture(id)) resizer.releasePointerCapture(id);
      persist();
    };
    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      drag = { id: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width };
      resizer.setPointerCapture(event.pointerId); document.body.classList.add('resizing-library');
    });
    resizer.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const { min, max } = bounds();
      preferred = Math.max(min, Math.min(max, drag.width + event.clientX - drag.x)); apply();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((name) => resizer.addEventListener(name, finish));
    window.addEventListener('blur', finish);
    resizer.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const { min, max } = bounds();
      preferred = event.key === 'Home' ? min : event.key === 'End' ? max
        : Math.max(min, Math.min(max, sidebar.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10)));
      apply(); persist();
    });
    new ResizeObserver(apply).observe(document.body); apply();
  }

  function init(callbacks) {
    hooks = callbacks; library = eagle.library.path;
    initResize();
    $('library-new-search').addEventListener('click', () => hooks.attempt(hooks.newSearch));
    $('library-query').addEventListener('input', refresh);
    $('library-categories').addEventListener('click', () => $('warehouse-categories').click());
    $('library-recovery').addEventListener('click', () => $('warehouse-recovery').click());
    ['library-tree', 'warehouse-grid', 'results'].forEach((id) => $(id).addEventListener('scroll', scheduleSave, { passive: true }));
    document.addEventListener('search-context', scheduleSave);
    window.addEventListener('pagehide', save);
    window.addEventListener('beforeunload', save);
    window.addEventListener('blur', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
    refresh();
  }

  async function show() {
    if (library !== eagle.library.path) {
      library = eagle.library.path; started = false; collapsed = new Set();
      $('library-query').value = '';
    }
    if (restoring) return;
    if (started) {
      restoring = true;
      try { await hooks.resume(); }
      catch (error) { hooks.toast(`恢复浏览位置失败：${error.message}`, true); }
      finally { restoring = false; refresh(); }
      return;
    }
    started = true; restoring = true;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(storageKey()) || 'null'); } catch { /* 无有效历史时打开全部主题。 */ }
    if (Array.isArray(saved?.collapsed)) collapsed = new Set(saved.collapsed.filter((id) => typeof id === 'string'));
    if (typeof saved?.sidebarQuery === 'string') $('library-query').value = saved.sidebarQuery;
    refresh();
    $('library-tree').scrollTop = Math.max(0, Number(saved?.sidebarScroll) || 0);
    try { await hooks.restore(saved); }
    catch (error) { hooks.toast(`恢复浏览位置失败：${error.message}`, true); }
    finally {
      restoring = false; refresh();
    }
  }
  return { init, show, refresh, save };
})();
