const assert = require('assert');
const FolderTree = require('../js/folderTree');

const roots = [
  {
    id: 'root',
    name: '一级',
    children: [
      {
        id: 'child',
        name: '二级',
        children: [
          { id: 'grandchild', name: '三级', children: [] },
        ],
      },
    ],
  },
  { id: 'sibling', name: '另一个一级', children: [] },
];

const expandedIds = new Set();
let rows = FolderTree.flattenVisible(roots, expandedIds);
assert.deepStrictEqual(
  rows.map((row) => row.id),
  ['root', 'sibling'],
  '初始状态只能显示一级文件夹',
);
assert.strictEqual(rows[0].expanded, false);
assert.strictEqual(rows[0].hasChildren, true);

expandedIds.add('root');
rows = FolderTree.flattenVisible(roots, expandedIds);
assert.deepStrictEqual(
  rows.map((row) => row.id),
  ['root', 'child', 'sibling'],
  '展开一级后只能多显示它的直接子文件夹',
);

expandedIds.add('child');
rows = FolderTree.flattenVisible(roots, expandedIds);
assert.deepStrictEqual(
  rows.map((row) => row.id),
  ['root', 'child', 'grandchild', 'sibling'],
  '继续展开二级后才显示三级文件夹',
);

expandedIds.delete('root');
rows = FolderTree.flattenVisible(roots, expandedIds);
assert.deepStrictEqual(
  rows.map((row) => row.id),
  ['root', 'sibling'],
  '收起父文件夹应隐藏全部后代',
);

console.log('scope folder tree progressive expansion tests passed');
