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

expandedIds.clear();
const selected = FolderTree.revealFolders(roots, ['grandchild', 'sibling', 'grandchild', 'missing'], expandedIds);
assert.deepStrictEqual(selected, ['grandchild', 'sibling'], '只加入当前树中存在的文件夹并去重');
assert.deepStrictEqual([...expandedIds], ['root', 'child'], '选中深层文件夹时展开其全部祖先');
assert(FolderTree.flattenVisible(roots, expandedIds).some((row) => row.id === 'grandchild'), '加入的深层文件夹必须可见');
assert(!expandedIds.has('grandchild'), '只展开祖先，不额外展开选中文件夹');
const before = [...expandedIds];
assert.deepStrictEqual(FolderTree.revealFolders(roots, [], expandedIds), []);
assert.deepStrictEqual(FolderTree.revealFolders(roots, ['missing'], expandedIds), []);
assert.deepStrictEqual([...expandedIds], before, '空选择或失效文件夹不改变展开状态');

console.log('scope folder tree expansion and selected folder reveal tests passed');
