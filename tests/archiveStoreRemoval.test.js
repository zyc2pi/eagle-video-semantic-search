const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-removal-test-'));
let failCommit = false;
let removalReads = 0;
const fakeFs = { ...fs,
  promises: { ...fs.promises, readFile: async (...args) => { removalReads += 1; return fs.promises.readFile(...args); } },
  renameSync: (source, target) => {
    if (failCommit && path.basename(path.dirname(target)) === 'warehouse') throw new Error('commit failed');
    fs.renameSync(source, target);
  },
};
const context = { require: (name) => name === 'fs' ? fakeFs : require(name) };
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../js/archiveStore.js'), 'utf8')}\nthis.archive = ArchiveStore;`, context);
const archive = context.archive;
const copy = (value) => JSON.parse(JSON.stringify(value));
const library = 'D:/removal.library';
const open = (name, lib = library) => archive.open(path.join(root, name), lib);
const manifest = (name) => {
  const dir = path.join(root, name, 'warehouse');
  return path.join(dir, fs.readdirSync(dir).find((file) => file.endsWith('.json')));
};
const match = (start, id = 'video-a', videoPath = 'D:/video.mp4') => ({
  eagleItemId: id, video_path: videoPath, start_frame: start - 1, end_frame: start + 11,
  original_start_frame: start, original_end_frame: start + 10, fps: 25, similarity: 23,
});
const add = (store, matches, name = '人工主题') => store.add({ name, matches,
  recipe: { kind: 'text', query: 'fixture' }, view: { minDur: 0, sortBy: 'sim', grouped: false } });
const remove = (store, entry, keys) => store.removeMatches(entry.id, keys, entry.updatedAt, entry.revision || 0);
const restore = (store, entry, keys) => store.restoreMatches(entry.id, keys, entry.updatedAt, entry.revision || 0);

(async () => {
  try {
    const store = open('basic');
    const first = match(10);
    const second = match(30);
    let entry = add(store, [first, second]);
    const twin = add(store, [first, second], '另一主题');
    const key = archive.sceneKey(first);
    entry = store.replace({ ...entry, newKeys: [key, archive.sceneKey(second)] }, entry.updatedAt);
    const initialTime = entry.updatedAt;
    const result = remove(store, entry, [key, key, 'missing']);
    assert.deepStrictEqual(copy(result.keys), [key]);
    entry = result.entry;
    assert.strictEqual(entry.matches.length, 1, '同视频的其他片段保留');
    assert.deepStrictEqual(copy(entry.removedMatches[0].match), first, '恢复记录保留完整片段快照');
    assert.strictEqual(entry.updatedAt, initialTime, '人工整理不改变搜索更新时间');
    assert.strictEqual(entry.summary.matches, 1);
    assert.strictEqual(entry.summary.videos, 1);
    assert.strictEqual(entry.summary.removed, 1);
    assert.deepStrictEqual(copy(entry.newKeys), [archive.sceneKey(second)]);
    const target = manifest('basic');
    const beforeRepeat = fs.readFileSync(target, 'utf8');
    assert.strictEqual(remove(store, entry, [key]).keys.length, 0);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), beforeRepeat, '重复移除不写盘或递增版本');
    assert.strictEqual(store.list().entries.find((item) => item.id === twin.id).matches.length, 2);
    assert.strictEqual(open('basic', 'D:/different.library').list().entries.length, 0);
    const reopened = open('basic').list().entries.find((item) => item.id === entry.id);
    assert.strictEqual(reopened.summary.removed, 1, '列表无需加载资源即可显示移除数量');
    assert(Object.getOwnPropertyDescriptor(reopened, 'removedMatches').get);
    removalReads = 0;
    await store.hydrateEntry(reopened, ['removedMatches']);
    assert.strictEqual(removalReads, 1);
    assert.strictEqual(reopened.removedMatches[0].key, key);

    const stale = copy(entry);
    entry = store.setCover(entry.id, { dataUrl: 'data:image/jpeg;base64,YQ==', frame: 10 }, entry.updatedAt);
    assert.throws(() => remove(store, stale, [archive.sceneKey(second)]), /其他操作更新/);
    assert.throws(() => restore(store, stale, [key]), /其他操作更新/);
    store.category('add', '', '分类');
    const category = store.list().categories[0];
    const preCategory = copy(entry);
    store.setCategory(entry.id, category.id, entry.updatedAt, entry.revision);
    assert.throws(() => restore(store, preCategory, [key]), /其他操作更新/);
    entry = store.list().entries.find((item) => item.id === entry.id);
    const fresh = archive.updatedEntry(entry, [
      { ...first, video_path: 'E:/moved.mp4', start_frame: 8, end_frame: 22 },
      second, match(10, 'different-item'), match(60),
    ], entry.recipe, entry.view, '2026-10-03T12:00:00Z');
    assert.strictEqual(fresh.matches.length, 3, '素材移路径后按 ID 排除；复用原路径的其他素材保留');
    assert(!fresh.newKeys.includes(key));
    const preUpdate = copy(entry);
    entry = store.replace(fresh, entry.updatedAt);
    assert.throws(() => remove(store, preUpdate, [archive.sceneKey(second)]), /其他操作更新/);
    entry = store.replace(archive.updatedEntry(entry, [], entry.recipe, entry.view), entry.updatedAt);
    assert.strictEqual(entry.matches.length, 0);
    entry = restore(store, entry, [key]).entry;
    assert.deepStrictEqual(copy(entry.matches), [first], '零结果主题也能立即恢复快照');
    assert.strictEqual(entry.removedMatches.length, 0);
    assert.strictEqual(entry.summary.removed, 0);
    assert.strictEqual(restore(store, entry, [key]).keys.length, 0);
    assert.strictEqual(archive.updatedEntry(entry, [first, second], entry.recipe, entry.view).matches.length, 2, '恢复解除排除');

    const beforeFailure = fs.readFileSync(target, 'utf8');
    failCommit = true;
    assert.throws(() => remove(store, entry, [key]), /commit failed/);
    failCommit = false;
    assert.strictEqual(fs.readFileSync(target, 'utf8'), beforeFailure);
    assert.strictEqual(store.list().entries.find((item) => item.id === entry.id).matches.length, 1);
    entry = remove(store, entry, [key]).entry;
    const beforeRestoreFailure = fs.readFileSync(target, 'utf8');
    failCommit = true;
    assert.throws(() => restore(store, entry, [key]), /commit failed/);
    failCommit = false;
    assert.strictEqual(fs.readFileSync(target, 'utf8'), beforeRestoreFailure);
    assert.strictEqual(store.list().entries.find((item) => item.id === entry.id).removedMatches.length, 1);

    const legacyStore = open('legacy');
    const legacy = { video_path: 'D:/OLD.MP4', start_frame: 10, end_frame: 20 };
    let oldEntry = add(legacyStore, [legacy]);
    const legacyFile = manifest('legacy');
    const legacyData = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    legacyData.version = 2;
    legacyData.entries[0] = copy(oldEntry);
    fs.writeFileSync(legacyFile, JSON.stringify(legacyData));
    assert.strictEqual(legacyStore.list().entries[0].summary.removed, 0);
    oldEntry = remove(legacyStore, oldEntry, [archive.sceneKey(legacy)]).entry;
    const legacyRefresh = archive.updatedEntry(oldEntry, [
      { ...legacy, video_path: 'd:\\old.mp4', eagleItemId: 'newly-resolved-id' },
      { ...legacy, start_frame: 30, end_frame: 40 },
    ], oldEntry.recipe, oldEntry.view);
    assert.strictEqual(legacyRefresh.matches.length, 1, '旧路径片段在补齐 Eagle ID 后继续排除');

    const largeStore = open('large');
    const many = Array.from({ length: 700 }, (_, i) => match(i * 30 + 10));
    let large = add(largeStore, many);
    large = remove(largeStore, large, many.map(archive.sceneKey)).entry;
    const largeFile = manifest('large');
    const packed = JSON.parse(fs.readFileSync(largeFile, 'utf8')).entries[0];
    assert(packed.removedMatchesRef);
    assert.strictEqual(packed.removedMatches, undefined);
    assert(fs.statSync(largeFile).size < 3000, '大量移除记录保存在独立不可变资源中');
    largeStore.category('add', '', 'backup-trigger');
    const backupDir = largeFile.replace(/\.json$/, '-backups');
    const backup = largeStore.backups().find((item) => item.valid
      && JSON.parse(fs.readFileSync(path.join(backupDir, item.name), 'utf8')).entries[0]?.summary.removed === 700);
    assert(backup);
    largeStore.remove(large.id);
    const trash = JSON.parse(fs.readFileSync(largeFile, 'utf8')).trash[0];
    assert.strictEqual(trash.entry.removedMatchesRef, packed.removedMatchesRef);
    assert(fs.statSync(largeFile).size < 3000, '回收站保留移除记录的资源引用');
    const portable = open('portable');
    assert.strictEqual(portable.importBundle(largeStore.exportBundle()), 0);
    let restoredTheme = portable.restore(trash.trashId);
    await portable.hydrateEntry(restoredTheme);
    assert.strictEqual(restoredTheme.removedMatches.length, 700, '导出导入完整保存回收站排除');
    restoredTheme = restore(portable, restoredTheme, [archive.sceneKey(many[0])]).entry;
    assert.strictEqual(restoredTheme.matches.length, 1);
    assert.strictEqual(restoredTheme.removedMatches.length, 699);
    largeStore.restoreBackup(backup.name);
    assert.strictEqual(largeStore.list().entries[0].removedMatches.length, 700, '备份恢复保留全部排除');
    const imported = open('active-import');
    assert.strictEqual(imported.importBundle(largeStore.exportBundle()), 1);
    assert.strictEqual(imported.list().entries[0].removedMatches.length, 700);

    const asset = path.join(largeFile.replace(/\.json$/, '-assets'), packed.removedMatchesRef);
    fs.writeFileSync(asset, '[]');
    const damaged = largeStore.list().entries[0];
    await assert.rejects(() => largeStore.hydrateEntry(damaged, ['removedMatches']), /校验失败/);
    const beforeCorruptWrite = fs.readFileSync(largeFile, 'utf8');
    assert.throws(() => remove(largeStore, damaged, [archive.sceneKey(many[0])]), /校验失败/);
    assert.throws(() => largeStore.restoreBackup(backup.name), /校验失败/);
    assert.strictEqual(fs.readFileSync(largeFile, 'utf8'), beforeCorruptWrite);
    fs.unlinkSync(asset);
    assert.strictEqual(largeStore.list().entries.length, 0, '缺失排除资源必须隔离主题，不能重新显示已移除片段');
    assert.strictEqual(largeStore.list().quarantine[0].value.removedMatchesRef, packed.removedMatchesRef);
    largeStore.category('add', '', 'after-quarantine');

    // Invalid inline records are preserved as quarantine evidence, not silently
    // discarded and turned into unfiltered themes.
    for (const [index, invalid] of [
      [{ key: 'incorrect', match: first, removedAt: '2026-10-03T00:00:00Z' }],
      [{ key, match: first, removedAt: 'not-a-date' }],
      [{ key, match: first, removedAt: '2026-10-03T00:00:00Z' }, { key, match: first, removedAt: '2026-10-03T00:00:00Z' }],
      { unexpected: true },
    ].entries()) {
      const invalidStore = open(`invalid-${index}`);
      const valid = add(invalidStore, [first]);
      const filename = manifest(`invalid-${index}`);
      const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
      data.entries[0].removedMatches = invalid;
      fs.writeFileSync(filename, JSON.stringify(data));
      assert.strictEqual(invalidStore.list().entries.length, 0);
      assert.deepStrictEqual(copy(invalidStore.list().quarantine[0].value.removedMatches), invalid);
      assert.throws(() => remove(invalidStore, valid, [key]), /已被删除或资源无效/);
    }
    console.log('theme scene removal, exclusion, immediate restore, revisions, resources and recovery tests passed');
  } finally {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('eagle-removal-test-')) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
