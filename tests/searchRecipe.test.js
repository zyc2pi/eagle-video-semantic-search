const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const context = { Date, require, Config: { get: () => ({ modelName: 'test', threshold: 11, deepseekKey: 'never-save-this' }) }, eagle: { library: { path: 'D:/test.library' } } };
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../js/searchRecipe.js'), 'utf8')}\nthis.recipe = SearchRecipe;`, context);
const recipe = context.recipe;

const now = new Date(2026, 8, 5, 12);
const halfYear = recipe.bounds({ mode: '6' }, now);
assert.strictEqual(halfYear.from, new Date(2026, 2, 5).getTime());
assert.strictEqual(recipe.bounds({ mode: '12' }, new Date(2024, 1, 29, 12)).from, new Date(2023, 1, 28).getTime());
assert.strictEqual(recipe.bounds({ mode: '6' }, new Date(2026, 7, 31, 12)).from, new Date(2026, 1, 28).getTime());
assert.throws(() => recipe.bounds({ mode: 'custom', start: '2026-09-06', end: '2026-09-05' }), /开始日期/);
assert.throws(() => recipe.bounds({ mode: 'custom', start: '2026-02-30', end: '2026-09-05' }), /日期无效/);
assert.throws(() => recipe.bounds({ mode: 'custom', start: '', end: '' }), /完整/);
const custom = { mode: 'custom', start: '2026-09-01', end: '2026-09-05' };
assert.deepStrictEqual(JSON.parse(JSON.stringify(recipe.bounds(custom, now))),
  JSON.parse(JSON.stringify(recipe.bounds(custom, new Date(2027, 8, 5)))));
const result = recipe.filterItems([
  { filePath: 'D:/a.mp4', importedAt: new Date(2026, 8, 5, 23, 59, 59).getTime() },
  { filePath: 'D:/b.mp4', importedAt: new Date(2026, 8, 6).getTime() },
  { filePath: 'D:/c.mp4', importedAt: new Date(2026, 8, 1).getTime() },
  { filePath: 'D:/d.mp4', modifiedAt: now.getTime() },
  { filePath: 'D:/e.mp4', importedAt: now.getTime() },
], custom, new Set(['d:\\a.mp4', 'd:\\b.mp4', 'd:\\c.mp4', 'd:\\d.mp4']), now);
assert.deepStrictEqual([...result.paths], ['d:\\a.mp4', 'd:\\c.mp4']);
assert.strictEqual(result.missingDates, 1, '不允许用修改时间代替导入时间');
assert.strictEqual(recipe.filterItems([], { mode: 'all' }).paths, null);
assert.strictEqual(recipe.filterItems([], { mode: 'all' }, new Set()).paths.size, 0, '空范围不能退回整库');
const savedMatches = Object.freeze([
  Object.freeze({ id: 'start' }), Object.freeze({ id: 'end' }),
  Object.freeze({ id: 'outside' }), Object.freeze({ id: 'missing' }),
]);
const stamps = { start: new Date(2026, 8, 1).getTime(), end: new Date(2026, 8, 5, 23, 59, 59).getTime(),
  outside: new Date(2026, 8, 6).getTime() };
const lookup = (match) => ({ importedAt: stamps[match.id], modifiedAt: now.getTime() });
assert.deepStrictEqual(recipe.filterMatches(savedMatches, custom, lookup, now).map((match) => match.id), ['start', 'end']);
assert.strictEqual(recipe.filterMatches(savedMatches, { mode: 'all' }, () => { throw new Error('不限时间无需读取日期'); }).length, 4);
assert.strictEqual(savedMatches.length, 4, '本地筛选不得删除快照片段');
const captured = recipe.capture('text', '城市', null, {
  scope: { mode: 'folders', folderIds: ['parent'] }, time: { mode: '6' }, library: 'D:/test.library',
}, 15);
assert.strictEqual(captured.config.threshold, 15);
assert(!JSON.stringify(captured).includes('never-save-this'));
assert.strictEqual(captured.scope.folderIds[0], 'parent');
console.log('search recipe dates, boundary, scope intersection and config isolation tests passed');

async function checkExcludedFolders() {
  const folders = [
    { id: 'parent', children: [{ id: 'child', children: [] }] },
    { id: 'other', children: [] }, { id: 'empty', children: [] },
  ];
  const items = [
    { id: 'a', filePath: 'D:/a.mp4', folders: ['parent'], importedAt: stamps.start },
    { id: 'b', filePath: 'D:/b.mp4', folders: ['child', 'other'] },
    { id: 'c', filePath: 'D:/c.mp4', folders: ['other'], importedAt: stamps.outside },
    { id: 'd', filePath: 'D:/d.mp4', folders: [], importedAt: stamps.start },
  ].map((item) => ({ ...item, ext: 'mp4' }));
  context.eagle.folder = { getByIds: async (ids) => [...folders, ...folders[0].children].filter((f) => ids.includes(f.id)) };
  context.eagle.item = { getAll: async () => items,
    get: async ({ folders: ids }) => items.filter((item) => ids.every((id) => item.folders.includes(id))) };
  vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../js/eagleBridge.js'), 'utf8')}\nthis.Bridge = Bridge;`, context);
  const saved = (ids, time = { mode: 'all' }) => recipe.capture('text', '城市', null, {
    scope: { mode: 'exclude', folderIds: ids }, time, library: context.eagle.library.path,
  });
  assert.deepStrictEqual([...(await recipe.resolve(saved(['parent']))).paths], ['d:\\c.mp4', 'd:\\d.mp4'], '排除父目录包含子目录和多归属素材');
  assert.deepStrictEqual([...(await recipe.resolve(saved(['parent', 'other']))).paths], ['d:\\d.mp4'], '多个目录取排除并集，未分类素材保留');
  assert.deepStrictEqual([...(await recipe.resolve(saved(['parent'], custom))).paths], ['d:\\d.mp4'], '排除后再与导入日期求交集');
  assert.strictEqual((await recipe.resolve(saved(['empty']))).paths.size, 4, '空文件夹不排除其他素材');
  await assert.rejects(recipe.resolve(saved([])), /请选择搜索文件夹/);
  await assert.rejects(recipe.resolve(saved(['missing'])), /已不存在/);
  context.Config.get = () => ({ scopeMode: 'exclude', scopeFolderIds: ['parent'], modelName: 'test' });
  context.document = { getElementById: () => ({ value: 'all' }) };
  const current = await recipe.currentContext();
  assert.strictEqual(current.scope.mode, 'exclude');
  assert.deepStrictEqual([...current.paths], ['d:\\c.mp4', 'd:\\d.mp4']);
  const snapshot = recipe.capture('visual', '图片', { image_base64: 'fixture' }, current);
  assert.deepStrictEqual([...(await recipe.resolve(snapshot)).paths], [...current.paths], '保存与重放保持排除条件');
  items[3].folders = ['other'];
  assert.strictEqual((await recipe.resolve(saved(['parent', 'other']))).paths.size, 0, '全部排除保持空范围');
  console.log('folder exclusion, descendants, union, dates, capture and replay tests passed');
}
checkExcludedFolders().catch((error) => { console.error(error); process.exitCode = 1; });
