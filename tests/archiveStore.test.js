const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-warehouse-test-'));
let failRename = false;
const fakeFs = { ...fs, renameSync: (...args) => {
  if (failRename) throw new Error('simulated write failure');
  return fs.renameSync(...args);
} };
const context = { require: (name) => name === 'fs' ? fakeFs : require(name) };
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../js/archiveStore.js'), 'utf8')}\nthis.store = ArchiveStore;`, context);
const archive = context.store;
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../js/topicRelations.js'), 'utf8')}\nthis.relations = TopicRelations;`, context);
const shared = { eagleItemId: 'one', video_path: 'D:/old.mp4', start_frame: 10, end_frame: 20 };
const moved = { ...shared, video_path: 'D:/moved.mp4', original_start_frame: 10, original_end_frame: 20, start_frame: 8, end_frame: 22 };
const otherItem = { ...shared, eagleItemId: 'two' };
const legacyScene = { video_path: 'D:/legacy.mp4', start_frame: 2, end_frame: 8 };
const topics = [
  { id: 'a', name: 'A', matches: [shared, legacyScene] },
  { id: 'b', name: 'B', matches: [moved, { ...legacyScene, eagleItemId: 'legacy-id' }, otherItem], removedMatches: [{ match: { ...shared, start_frame: 90 } }] },
];
const diff = context.relations.compare(...topics);
assert.strictEqual(diff.common.length, 2, '移动路径及预览帧偏移仍按原始边界认定共有，兼容缺ID的旧数据');
assert.strictEqual(diff.left.length, 0);
assert.strictEqual(diff.right.length, 1, '已知不同素材ID不因同路径而混同');
const membership = context.relations.buildMembership(topics);
assert.deepStrictEqual(Array.from(membership(moved), (topic) => topic.id), ['a', 'b']);
assert.deepStrictEqual(Array.from(membership(otherItem), (topic) => topic.id), ['b']);
assert.strictEqual(membership({ ...shared, start_frame: 90 }).length, 0, '已移除片段不计入归属');
assert.strictEqual(membership({ ...shared, start_frame: 11 }).length, 0, '同视频相邻或重叠片段不能误认相同');
assert.strictEqual(context.relations.compare({ matches: [] }, { matches: [] }).common.length, 0);
try {
  const library = 'D:/test.library';
  fs.mkdirSync(path.join(root, 'saves'));
  const legacy = { query: '城市', library, savedAt: '2026-01-01T00:00:00Z', matches: [{ video_path: 'D:/a.mp4', start_frame: 3, end_frame: 20 }] };
  fs.writeFileSync(path.join(root, 'saves', 'old.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(root, 'saves', 'broken.json'), '{');
  const store = archive.open(root, library);
  let data = store.list();
  assert.strictEqual(data.entries.length, 1);
  assert.strictEqual(data.entries[0].recipe, null);
  assert(data.warnings.length > 0);
  assert.strictEqual(store.list().entries.length, 1, '迁移必须幂等');
  assert(fs.existsSync(path.join(root, 'saves', 'old.json')), '原存档必须保留');
  assert.strictEqual(archive.open(root, 'D:/another.library').list().entries.length, 0);
  assert.strictEqual(archive.open(root, 'd:\\test.library').list().entries.length, 1);
  store.category('add', '', '风景');
  const category = store.list().categories[0];
  let entry = store.add({ name: '夜景', categoryId: category.id, recipe: { query: '夜景' },
    view: { minDur: 2 }, matches: [{ eagleItemId: 'a', video_path: 'D:/a.mp4', original_start_frame: 5, original_end_frame: 18, start_frame: 3, end_frame: 20 }] });
  const cover = { dataUrl: 'data:image/jpeg;base64,Y292ZXI=', frame: 12, fps: 25, videoPath: 'D:/a.mp4' };
  entry = store.setCover(entry.id, cover, entry.updatedAt);
  assert.strictEqual(entry.updatedAt, entry.createdAt, '设封面不改变搜索更新时间');
  assert.strictEqual(store.list().entries.find((e) => e.id === entry.id).cover.frame, 12);
  assert.throws(() => store.setCover(entry.id, { ...cover, dataUrl: 'javascript:alert(1)' }), /封面数据无效/);
  failRename = true;
  assert.throws(() => store.setCover(entry.id, { ...cover, frame: 20 }), /simulated/);
  failRename = false;
  assert.strictEqual(store.list().entries.find((e) => e.id === entry.id).cover.frame, 12, '写失败保留旧封面');
  const updated = archive.updatedEntry(entry, [
    { ...entry.matches[0], video_path: 'D:/moved.mp4', start_frame: 2, end_frame: 21 },
    { eagleItemId: 'a', video_path: 'D:/moved.mp4', start_frame: 30, end_frame: 50 },
  ], entry.recipe, entry.view, '2026-09-05T12:00:00Z');
  assert.strictEqual(updated.newKeys.length, 1, '移路径和帧偏移不能误报新增；同素材新片段需标记');
  failRename = true;
  assert.throws(() => store.replace(updated, entry.updatedAt), /simulated/);
  assert.strictEqual(store.list().entries.find((e) => e.id === entry.id).matches.length, 1, '写盘失败必须保留旧快照');
  failRename = false;
  store.replace(updated, entry.updatedAt);
  assert.strictEqual(store.list().entries.find((e) => e.id === entry.id).cover.frame, 12, '搜索更新保留固定封面');
  assert.throws(() => store.replace(updated, entry.updatedAt), /其他操作更新/);
  data = store.list();
  assert.strictEqual(data.entries.find((e) => e.id === entry.id).newKeys.length, 1, '新增标记重开后仍保留');
  store.category('rename', category.id, '项目 A');
  assert.strictEqual(store.list().categories[0].name, '项目 A');
  store.category('remove', category.id);
  assert.strictEqual(store.list().entries.find((e) => e.id === entry.id).categoryId, '');
  entry = store.list().entries.find((e) => e.id === entry.id);
  store.replace(archive.updatedEntry(entry, [], entry.recipe, entry.view), entry.updatedAt);
  assert.strictEqual(store.list().entries.find((e) => e.id === entry.id).matches.length, 0, '成功零结果应保存空快照');
  entry = store.list().entries.find((e) => e.id === entry.id);
  const resetCover = store.setCover(entry.id, null, entry.updatedAt);
  assert.strictEqual(resetCover.cover, undefined);
  assert.strictEqual(resetCover.updatedAt, entry.updatedAt);
  const legacyId = store.list().entries.find((e) => e.legacy).id;
  store.remove(legacyId);
  assert(!store.list().entries.some((e) => e.legacy), '删除迁移主题后不应重新导入');
  console.log('archive migration, library isolation, update diff and failed-write preservation tests passed');
} finally {
  // 仅清理本测试创建、系统临时目录内的随机测试根目录。
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('eagle-warehouse-test-')) fs.rmSync(root, { recursive: true, force: true });
}

async function verifyMembershipLoading() {
  const entries = [{ id: 'a', name: 'A', revision: 1, matches: [shared] }];
  let reads = 0;
  let release;
  let gate = new Promise((resolve) => { release = resolve; });
  const testContext = {
    document: {}, setTimeout, clearTimeout,
    Search: { refreshTopicMembership() {} },
    eagle: { library: { path: 'library' } },
    Config: { pluginPath: () => '/fixture' },
    ArchiveStore: { sceneKey: archive.sceneKey, open: () => ({
      list: () => ({ entries, warnings: [] }),
      hydrateEntry: async () => { reads += 1; await gate; },
    }) },
  };
  const relationSource = fs.readFileSync(path.join(__dirname, '../js/topicRelations.js'), 'utf8');
  vm.runInNewContext(relationSource.replace('  return { init,',
    '  this.inspectRelations = { readSnapshot, buildMembershipAsync, refresh, publish: (snapshot) => { cache = snapshot; }, current: () => cache };\n  return { init,'), testContext);
  const { readSnapshot, buildMembershipAsync } = testContext.inspectRelations;
  const first = readSnapshot(); const second = readSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(reads, 1, '并行归属刷新共用一次资源读取');
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.strictEqual(left, right, '同版本请求复用同一份完整快照');
  assert.strictEqual(left.find(shared)[0].id, 'a');

  gate = new Promise((resolve) => { release = resolve; });
  const changed = readSnapshot();
  const rejected = assert.rejects(changed, /主题在读取期间发生变化/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  entries[0].revision += 1;
  release();
  await rejected;
  await assert.rejects(buildMembershipAsync(entries, () => false), /新的刷新取代/);

  gate = new Promise((resolve) => { release = resolve; });
  const obsolete = testContext.inspectRelations.refresh();
  await new Promise((resolve) => setTimeout(resolve, 10));
  entries[0].revision += 1;
  const releaseObsolete = release;
  gate = Promise.resolve();
  const latest = await readSnapshot();
  testContext.inspectRelations.publish(latest);
  releaseObsolete();
  await obsolete;
  assert.strictEqual(testContext.inspectRelations.current(), latest, '被取代的后台读取不能清空新版本归属');
  console.log('membership shared reads, version checks and cancellation passed');
}
verifyMembershipLoading().catch((error) => { console.error(error); process.exitCode = 1; });
