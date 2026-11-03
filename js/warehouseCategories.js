/* 分类选择器及按库保存的最近使用顺序。 */
const WarehouseCategories = (() => {
  const recentCategories = new Map();
  const categoryPreferenceKey = (library) => `eagle-semantic-recent-categories:${SearchRecipe.normalize(library)}`;
  const node = (tag, className, text) => Dom.h(tag, { className, text });

  function categoryHistory(library) {
    const key = categoryPreferenceKey(library);
    if (!recentCategories.has(key)) {
      let ids = [];
      try {
        const saved = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(saved)) ids = [...new Set(saved.filter((id) => typeof id === 'string'))];
      } catch { /* 偏好不可用时保留会话内顺序。 */ }
      recentCategories.set(key, ids);
    }
    return recentCategories.get(key);
  }

  function rememberCategory(library, id) {
    if (!id) return;
    const ids = [id, ...categoryHistory(library).filter((value) => value !== id)].slice(0, 100);
    recentCategories.set(categoryPreferenceKey(library), ids);
    try { localStorage.setItem(categoryPreferenceKey(library), JSON.stringify(ids)); }
    catch { /* 保存失败时仍保留会话内顺序。 */ }
  }

  function categoryPicker(selectedId, library, categoryList) {
    const element = node('div', 'category-picker');
    const input = node('input', 'category-picker-input');
    input.type = 'text'; input.maxLength = 60; input.autocomplete = 'off';
    input.placeholder = '搜索或输入新分类名称';
    input.setAttribute('aria-label', '搜索或新建分类');
    const selected = node('p', 'category-picker-selected');
    selected.setAttribute('aria-live', 'polite');
    const options = node('div', 'category-picker-options');
    const categories = ArchiveStore.categoryTree(categoryList).items.map((category) => ({ ...category, name: category.path }));
    let value = selectedId;
    const choose = (next) => {
      value = next; input.value = ''; render(); input.focus();
    };
    const addOption = (parent, id, name) => {
      const button = node('button', 'category-picker-option', name);
      button.type = 'button'; button.title = name;
      button.dataset.categoryId = id;
      button.setAttribute('aria-pressed', String(value === id));
      button.addEventListener('click', () => choose(id));
      parent.appendChild(button);
    };
    const render = () => {
      const query = input.value.trim();
      selected.textContent = `已选择：${typeof value === 'object' ? `${value.name}（新分类，确认后创建）`
        : categories.find((category) => category.id === value)?.name || '未分类'}`;
      options.replaceChildren();
      if (query && !categories.some((category) => category.name === query)) {
        const create = node('button', 'category-picker-create', `＋ 新建「${query}」`);
        create.type = 'button';
        create.addEventListener('click', () => choose({ name: query }));
        options.appendChild(create);
      }
      const matches = categories.filter((category) => category.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      const recent = categoryHistory(library).map((id) => matches.find((category) => category.id === id)).filter(Boolean);
      const recentIds = new Set(recent.map((category) => category.id));
      const groups = query ? [['匹配分类', matches]]
        : [['最近使用', recent], ['其他分类', matches.filter((category) => !recentIds.has(category.id))]];
      groups.forEach(([label, items]) => {
        if (!items.length) return;
        const group = node('div', 'category-picker-group');
        group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
        group.appendChild(node('p', 'category-picker-heading', `${label}（${items.length}）`));
        const grid = node('div', 'category-picker-grid');
        items.forEach((category) => addOption(grid, category.id, category.name));
        group.appendChild(grid); options.appendChild(group);
      });
      if (!query) addOption(options, '', '未分类');
    };
    const getValue = () => {
      const query = input.value.trim();
      return query ? categories.find((category) => category.name === query)?.id || { name: query } : value;
    };
    input.addEventListener('input', render);
    element.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.target === input && event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation();
        choose(getValue());
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = [...options.querySelectorAll('button:not(:disabled)')];
        if (!buttons.length) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement);
        if (index < 0) buttons[event.key === 'ArrowDown' ? 0 : buttons.length - 1].focus();
        else if ((index === 0 && event.key === 'ArrowUp') || (index === buttons.length - 1 && event.key === 'ArrowDown')) input.focus();
        else buttons[index + (event.key === 'ArrowDown' ? 1 : -1)].focus();
      }
    });
    element.append(input, selected, options, node('p', 'hint', '输入新名称后确认即可创建；也可用 ↑ ↓ 选择，Enter 选中。'));
    render();
    return { element, getValue, focus: () => input.focus(),
      setDisabled: (disabled) => element.querySelectorAll('input, button').forEach((control) => { control.disabled = disabled; }) };
  }

  return { picker: categoryPicker, remember: rememberCategory };
})();
