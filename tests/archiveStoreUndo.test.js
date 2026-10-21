const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-undo-test-'));
let failCommit = false;
const proxyFs = { ...fs, renameSync(from, to) {
  if (failCommit && path.basename(path.dirname(to)) === 'warehouse') throw new Error('commit failed');
  return fs.renameSync(from, to);
} };
const context = { require: (name) => name === 'fs' ? proxyFs : require(name) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/archiveStore.js'), 'utf8') + '\nthis.archive = ArchiveStore;', context);
const archive = context.archive;
const copy = (value) => JSON.parse(JSON.stringify(value));
const library = 'D:/undo.library';
const scene = (start, id = 'video', videoPath = 'D:/video.mp4') => ({
  eagleItemId: id, video_path: videoPath, video_name: 'test', start_frame: start, end_frame: start + 9,
  original_start_frame: start, original_end_frame: start + 9, similarity: 18, fps: 25,
});
const input = (match, score = 14.2, scoreMode = 'custom') => ({ match, score, scoreMode });
const create = (store, matches) => store.add({ name: 'topic', matches,
  recipe: { kind: 'text', query: 'test', config: {} }, view: { minDur: 0, sortBy: 'sim', grouped: false } });
const add = (store, entry, inputs) => store.addMatches(entry.id, inputs, entry.updatedAt, entry.revision || 0);
const undo = (store, entry, token) => store.undoMatches(entry.id, token, entry.updatedAt, entry.revision || 0);
const manifest = (storeRoot) => path.join(storeRoot, 'warehouse', fs.readdirSync(path.join(storeRoot, 'warehouse')).find((name) => name.endsWith('.json')));

(async () => {
  try {
    const directory = path.join(root, 'basic');
    const store = archive.open(directory, library);
    const original = { ...scene(10), both_hit: true, matched_queries: [{ text: 'original', similarity: 18 }] };
    const alreadyManual = { ...scene(30), manualScore: { value: 18, mode: 'top', scoredAt: '2026-10-03T00:00:00Z' } };
    const legacy = scene(50, undefined, 'D:/OLD.MP4');
    delete legacy.eagleItemId;
    let entry = create(store, [original, alreadyManual, legacy, scene(70)]);
    const category = store.category('add', '', 'category');
    const categoryId = store.list().categories[0].id;
    entry = { ...entry, newKeys: entry.matches.map(archive.sceneKey), categoryId };
    entry = store.replace(entry, entry.updatedAt);
    entry = store.setCover(entry.id, { dataUrl: 'data:image/jpeg;base64,YQ==', frame: 4 }, entry.updatedAt);
    entry = store.removeMatches(entry.id, [archive.sceneKey(legacy), archive.sceneKey(scene(70))], entry.updatedAt, entry.revision).entry;
    const before = copy(entry);
    const result = add(store, entry, [input(original, 12), input({ ...legacy, eagleItemId: 'promoted', video_path: 'd:\\old.mp4' }, 10),
      input(scene(90), 17, 'top'), input(scene(90), 19)]);
    assert(result.undoToken && typeof result.undoToken === 'object');
    assert(result.undoBytes > 0);
    assert.deepStrictEqual([result.added, result.rescored, result.restored], [2, 1, 1]);
    assert.strictEqual(result.entry.revision, before.revision + 1);
    const restored = undo(store, result.entry, result.undoToken);
    entry = restored.entry;
    for (const field of ['matches', 'removedMatches', 'newKeys', 'recipe', 'cover', 'categoryId', 'updatedAt']) {
      assert.deepStrictEqual(copy(entry[field]), before[field], `undo restores ${field}`);
    }
    assert.strictEqual(entry.revision, result.entry.revision + 1);
    assert.throws(() => undo(store, entry, result.undoToken), /撤销记录/);
    assert.throws(() => undo(store, entry, {}), /撤销记录/);
    assert.throws(() => undo(store, entry, copy(result.undoToken)), /撤销记录/);

    const second = add(store, entry, [input(original, 20)]);
    const third = add(store, second.entry, [input(original, 25), input(scene(100), 9)]);
    assert.throws(() => undo(store, third.entry, second.undoToken), /片段已变化|撤销记录/);
    const thirdUndo = undo(store, third.entry, third.undoToken);
    assert.deepStrictEqual(copy(thirdUndo.entry.matches), copy(second.entry.matches));
    const secondUndo = undo(store, thirdUndo.entry, second.undoToken);
    assert.deepStrictEqual(copy(secondUndo.entry.matches), copy(entry.matches));
    assert.strictEqual(secondUndo.entry.revision, third.entry.revision + 2);

    const emptyFile = fs.readFileSync(manifest(directory), 'utf8');
    const empty = add(store, secondUndo.entry, []);
    assert.strictEqual(empty.undoToken, null);
    assert.strictEqual(empty.undoBytes, 0);
    assert.strictEqual(fs.readFileSync(manifest(directory), 'utf8'), emptyFile);
    assert.throws(() => add(store, secondUndo.entry, [input(original), input(scene(110), NaN)]), /格式无效/);
    assert.strictEqual(fs.readFileSync(manifest(directory), 'utf8'), emptyFile, 'partial invalid input is atomic');

    const pending = add(store, secondUndo.entry, [input(original, 31)]);
    const pendingFile = fs.readFileSync(manifest(directory), 'utf8');
    failCommit = true;
    assert.throws(() => undo(store, pending.entry, pending.undoToken), /commit failed/);
    failCommit = false;
    assert.strictEqual(fs.readFileSync(manifest(directory), 'utf8'), pendingFile);
    const retried = undo(store, pending.entry, pending.undoToken);
    assert.deepStrictEqual(copy(retried.entry.matches), copy(secondUndo.entry.matches));

    const another = archive.open(path.join(root, 'other'), library);
    another.importBundle(store.exportBundle());
    const scoped = add(store, retried.entry, [input(original, 32)]);
    const otherEntry = another.list().entries[0];
    assert.throws(() => undo(another, otherEntry, scoped.undoToken), /撤销记录/);
    const otherLibrary = archive.open(directory, 'D:/other.library');
    assert.throws(() => undo(otherLibrary, scoped.entry, scoped.undoToken), /撤销记录/);
    const reopened = archive.open(directory, library);
    const loaded = reopened.list().entries[0];
    assert(Object.getOwnPropertyDescriptor(loaded, 'matches').get, 'lazy resources stay lazy at listing');
    const reopenedUndo = undo(reopened, loaded, scoped.undoToken);
    assert.deepStrictEqual(copy(reopenedUndo.entry.matches), copy(retried.entry.matches));

    const conflict = add(store, reopenedUndo.entry, [input(original, 40)]);
    let edited = store.setFavorite(conflict.entry.id, true, conflict.entry.updatedAt, conflict.entry.revision);
    assert.throws(() => undo(store, conflict.entry, conflict.undoToken), /其他操作更新/);
    assert.strictEqual(edited.favorite, true);
    assert.strictEqual(edited.updatedAt, conflict.entry.updatedAt);
    assert.strictEqual(edited.revision, conflict.entry.revision + 1);
    assert.strictEqual(edited.matches, undefined, 'favorite returns lightweight metadata');
    assert.throws(() => store.setFavorite(edited.id, false, edited.updatedAt, edited.revision - 1), /其他操作更新/);
    assert.throws(() => store.setFavorite(edited.id, 'true', edited.updatedAt, edited.revision), /星标/);
    failCommit = true;
    assert.throws(() => store.setFavorite(edited.id, false, edited.updatedAt, edited.revision), /commit failed/);
    failCommit = false;
    assert.strictEqual(store.list().entries[0].favorite, true);
    assert.strictEqual(another.list().entries[0].favorite, false, 'favorite does not cross store boundaries');
    const moved = archive.open(path.join(root, 'move'), library);
    moved.importBundle(store.exportBundle());
    assert.strictEqual(moved.list().entries[0].favorite, true, 'bundle preserves favorite');
    moved.remove(edited.id);
    const trash = moved.list().trash[0];
    assert.strictEqual(trash.entry.favorite, true, 'trash keeps favorite');
    const untrashed = moved.restore(trash.trashId);
    assert.strictEqual(untrashed.favorite, true);
    const favoriteBackup = moved.backups().find((backup) => backup.valid);
    moved.setFavorite(untrashed.id, false, untrashed.updatedAt, untrashed.revision);
    moved.restoreBackup(favoriteBackup.name);
    assert.strictEqual(moved.list().entries[0]?.favorite || moved.list().trash[0]?.entry.favorite, true, 'backup keeps favorite');

    const budgetStore = archive.open(path.join(root, 'budget'), library);
    let budgetEntry = create(budgetStore, [{ ...scene(10), metadata: Array.from({ length: 1000 }, () => ({})) }]);
    budgetEntry = budgetStore.replace({ ...budgetEntry, recipe: { kind: 'visual', payload: { image_base64: 'A'.repeat(300000) } } }, budgetEntry.updatedAt);
    const budgetResult = add(budgetStore, budgetEntry, [input(scene(10), 5)]);
    assert(budgetResult.undoBytes > 64000, 'nested object overhead is included in byte estimate');
    assert(budgetResult.undoBytes < 150000, 'query image is not retained by undo diff');
    assert.strictEqual(undo(budgetStore, budgetResult.entry, budgetResult.undoToken).entry.matches[0].metadata.length, 1000);

    const promotionStore = archive.open(path.join(root, 'promotion'), library);
    const promotionEntry = create(promotionStore, [legacy]);
    const promoted = add(promotionStore, promotionEntry, [input({ ...legacy, eagleItemId: 'stable-id' }, 15)]);
    const unpromoted = undo(promotionStore, promoted.entry, promoted.undoToken).entry;
    assert.deepStrictEqual(copy(unpromoted.matches), copy(promotionEntry.matches), 'undo restores old path-only identity');
    assert.strictEqual(unpromoted.removedMatches, undefined, 'absent legacy removed field stays absent');

    // Favorite changes do not hydrate large/corrupt immutable assets.
    const data = JSON.parse(fs.readFileSync(manifest(directory), 'utf8'));
    const assets = manifest(directory).replace(/\.json$/, '-assets');
    const brokenRaw = '[]';
    const ref = `${crypto.createHash('sha256').update(brokenRaw).digest('hex')}.json`;
    fs.writeFileSync(path.join(assets, ref), brokenRaw);
    data.entries[0].recipeRef = ref;
    fs.writeFileSync(manifest(directory), JSON.stringify(data));
    const corruptEntry = store.list().entries[0];
    const starred = store.setFavorite(corruptEntry.id, false, corruptEntry.updatedAt, corruptEntry.revision);
    assert.strictEqual(starred.favorite, false);
    assert.throws(() => undo(store, starred, conflict.undoToken), /内容无效|片段已变化|撤销记录/);
    console.log('transaction scene diff undo, reverse history, versions, failure retry, scopes, favorite and lazy assets passed');
  } finally {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('eagle-undo-test-')) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
