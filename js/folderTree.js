/* 搜索范围文件夹树：只打平当前已展开分支，供界面逐级显示。 */
(function initScopeFolderTree(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScopeFolderTree = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function flattenVisible(roots, expandedIds = new Set()) {
    const rows = [];
    const visited = new Set();

    const walk = (node, depth) => {
      if (!node || typeof node !== 'object') return;
      const id = node.id || node.folderId;
      if (!id || visited.has(id)) return;
      visited.add(id);

      const children = Array.isArray(node.children) ? node.children : [];
      const expanded = children.length > 0 && expandedIds.has(id);
      rows.push({
        id,
        name: node.name || node.title || '(未命名)',
        depth: Math.min(depth, 10),
        childCount: children.length,
        hasChildren: children.length > 0,
        expanded,
      });

      if (expanded) children.forEach((child) => walk(child, depth + 1));
    };

    (roots || []).forEach((node) => walk(node, 0));
    return rows;
  }

  return { flattenVisible };
}));
