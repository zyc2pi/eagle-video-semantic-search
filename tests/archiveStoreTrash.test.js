const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-trash-test-'));
const context = { require };
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../js/archiveStore.js'), 'utf8')}\nthis.archive = ArchiveStore;`, context);
const copy = (value) => JSON.parse(JSON.stringify(value));
const getManifest = (location) => path.join(location, 'warehouse', fs.readdirSync(path.join(location, 'warehouse')).find((name) => name.endsWith('.json')));

(async () => {
  try {
    const library = 'D:/trash.library';
    const store = context.archive.open(root, library);
    const matches = Array.from({ length: 1000 }, (_, i) => ({ video_path: 'D:/fixture.mp4', start_frame: i * 10, end_frame: i * 10 + 9 }));
    const entry = store.add({ name: 'large snapshot', recipe: { query: 'fixture', payload: { image_base64: 'a'.repeat(100000) } }, view: {}, matches });
    store.setCover(entry.id, { dataUrl: 'data:image/jpeg;base64,YQ==', frame: 10 });
    const manifest = getManifest(root);
    const activeRefs = JSON.parse(fs.readFileSync(manifest, 'utf8')).entries[0];
    store.remove(entry.id);
    let deleted = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert(fs.statSync(manifest).size < 3000, 'deletion keeps the main manifest small');
    for (const key of ['matches', 'recipe', 'cover']) {
      assert.strictEqual(deleted.trash[0].entry[`${key}Ref`], activeRefs[`${key}Ref`]);
      assert.strictEqual(deleted.trash[0].entry[key], undefined);
    }
    const trashId = deleted.trash[0].trashId;
    assert(Object.getOwnPropertyDescriptor(store.list().trash[0].entry, 'matches').get, 'trash loads lazily');
    const bundle = store.exportBundle();
    const portable = context.archive.open(path.join(root, 'portable'), library);
    assert.strictEqual(portable.importBundle(bundle), 0, 'trash import does not inflate active-entry count');
    assert.strictEqual(portable.list().trash.length, 1);
    assert.strictEqual(portable.importBundle(bundle), 0);
    assert.strictEqual(portable.list().trash.length, 1, 'trash import is idempotent by trash ID');
    const restored = portable.restore(trashId);
    assert(Object.getOwnPropertyDescriptor(restored, 'matches').get, 'restore preserves lazy resources');
    await portable.hydrateEntry(restored);
    assert.deepStrictEqual(copy(restored.matches), matches);
    assert.strictEqual(restored.recipe.payload.image_base64.length, 100000);
    assert.strictEqual(restored.cover.frame, 10);
    assert(fs.statSync(getManifest(path.join(root, 'portable'))).size < 3000);

    const moved = context.archive.open(path.join(root, 'moved'), 'E:/moved.library');
    moved.importBundle(bundle, { allowLibraryMove: true });
    const movedEntry = moved.restore(trashId);
    assert.strictEqual(movedEntry.recipe, null);
    assert.strictEqual(movedEntry.previousRecipe.payload.image_base64.length, 100000);
    assert.strictEqual(movedEntry.sourceLibrary, library);

    store.category('add', '', 'backup trigger');
    const trashBackup = store.backups().find((item) => item.valid && JSON.parse(fs.readFileSync(path.join(manifest.replace(/\.json$/, '-backups'), item.name), 'utf8')).trash?.some((record) => record.trashId === trashId));
    assert(trashBackup);
    store.restore(trashId);
    store.restoreBackup(trashBackup.name);
    assert.strictEqual(store.list().entries.length, 0);
    assert.strictEqual(store.list().trash[0].entry.matches.length, 1000);
    assert(fs.statSync(manifest).size < 3000, 'backup restore repacks all trash resources');

    // Upgrade old embedded trash while retaining unknown historical records.
    deleted = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    deleted.trash = JSON.parse(JSON.parse(bundle).payload).trash;
    const unknown = { trashId: 'unknown', deletedAt: '2000-01-01', entry: { id: 'future', newFormat: true }, extension: 'preserve' };
    deleted.trash.push(unknown);
    fs.writeFileSync(manifest, JSON.stringify(deleted));
    store.setRetention(10, 0);
    const upgraded = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert(upgraded.trash[0].entry.matchesRef);
    assert(!upgraded.trash[0].entry.matches);
    assert.deepStrictEqual(upgraded.trash[1], unknown);
    store.setRetention(10, 30);
    assert.deepStrictEqual(copy(store.list().trash[1]), unknown, 'unknown old trash never expires');
    assert.throws(() => store.restore('unknown'), /原始内容已保留/);

    const asset = path.join(manifest.replace(/\.json$/, '-assets'), upgraded.trash[0].entry.matchesRef);
    const beforeCorruption = fs.readFileSync(manifest, 'utf8');
    fs.writeFileSync(asset, '[]');
    assert.throws(() => store.restoreBackup(trashBackup.name), /校验失败/);
    assert.strictEqual(fs.readFileSync(manifest, 'utf8'), beforeCorruption);
    const expired = JSON.parse(beforeCorruption);
    expired.trash[0].deletedAt = '2000-01-01T00:00:00Z';
    fs.writeFileSync(manifest, JSON.stringify(expired));
    store.setRetention(10, 30);
    assert.strictEqual(store.list().trash.length, 2, 'expired trash with a corrupt existing resource is preserved');
    assert.strictEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).trash[0].entry.matchesRef, upgraded.trash[0].entry.matchesRef);
    assert.strictEqual(fs.readFileSync(asset, 'utf8'), '[]', 'corrupt resource evidence remains untouched');
    fs.unlinkSync(asset);
    assert.strictEqual(store.backups().find((item) => item.name === trashBackup.name).valid, false, 'backup validity changes when trash resource disappears');
    store.category('add', '', 'preserve broken trash');
    assert.strictEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).trash[0].entry.matchesRef, upgraded.trash[0].entry.matchesRef);
    assert.throws(() => store.restore(trashId), /原始内容已保留/);
    console.log('trash references, lazy restore, portable bundle, migration and damaged-resource preservation tests passed');
  } finally {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('eagle-trash-test-')) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
