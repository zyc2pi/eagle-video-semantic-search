const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-resource-test-'));
let failCommit = false;
let asyncReads = 0;
let raceTarget;
const fakeFs = { ...fs, promises: { ...fs.promises, readFile: async (...args) => {
  asyncReads += 1; return fs.promises.readFile(...args);
} }, renameSync: (source, target) => {
  if (failCommit && path.dirname(target) === path.join(root, 'warehouse')) throw new Error('commit failed');
  return fs.renameSync(source, target);
}, writeFileSync: (target, ...args) => {
  const result = fs.writeFileSync(target, ...args);
  if (raceTarget && target.endsWith('.lock')) {
    const current = JSON.parse(fs.readFileSync(raceTarget, 'utf8'));
    current.revision += 1;
    fs.writeFileSync(raceTarget, JSON.stringify(current)); raceTarget = null;
  }
  return result;
} };
const context = { require: (name) => name === 'fs' ? fakeFs : name === 'process'
  ? { pid: process.pid, kill: (pid) => { if (pid === 777777) throw Object.assign(new Error('exited'), { code: 'ESRCH' }); } }
  : require(name) };
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../js/archiveStore.js'), 'utf8')}\nthis.archive = ArchiveStore;`, context);
(async () => {
  try {
    const library = 'D:/resources.library';
    const store = context.archive.open(root, library);
    const image = 'data:image/jpeg;base64,' + 'YQ=='.repeat(1);
    const entry = store.add({ name: 'resource', recipe: { query: 'fixture', payload: { image_base64: 'a'.repeat(100000) } },
      view: {}, matches: [{ video_path: 'D:/fixture.mp4', start_frame: 1, end_frame: 2 }] });
    store.setCover(entry.id, { dataUrl: image, frame: 1 });
    store.setCover(entry.id, { dataUrl: 'data:image/jpeg;base64,Yg==', frame: 2 });
    assert.strictEqual(store.list().entries[0].cover.frame, 2, 'replace a lazily loaded previous cover');
    const target = path.join(root, 'warehouse', fs.readdirSync(path.join(root, 'warehouse')).find((name) => name.endsWith('.json')));
    assert(fs.statSync(target).size < 2000, 'manifest must not embed images or matches');
    const listed = store.list().entries[0];
    assert.strictEqual(listed.summary.matches, 1);
    assert(Object.getOwnPropertyDescriptor(listed, 'matches').get);
    await context.archive.open(root, library).hydrateEntry(listed);
    assert.strictEqual(asyncReads, 3, 'separate open() must still hydrate asynchronously');
    assert.strictEqual(listed.matches.length, 1);
    const before = fs.readFileSync(target, 'utf8');
    failCommit = true;
    assert.throws(() => store.remove(entry.id), /commit failed/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), before);
    assert(!fs.existsSync(`${target}.lock`));
    fs.writeFileSync(`${target}.lock`, JSON.stringify({ pid: process.pid }));
    assert.throws(() => store.recoverLock(), /仍在运行/);
    fs.writeFileSync(`${target}.lock`, JSON.stringify({ pid: 777777 }));
    assert.strictEqual(store.recoverLock(), true);
    failCommit = false;
    raceTarget = target;
    assert.throws(() => store.remove(entry.id), /其他操作更新/);
    assert.strictEqual(store.list().entries.length, 1);
    assert(!fs.existsSync(`${target}.lock`));
    for (let i = 0; i < 12; i++) store.category('add', '', `category-${i}`);
    assert.strictEqual(store.backups().filter((item) => item.valid).length, 10);
    const backupDir = target.replace(/\.json$/, '-backups');
    fs.writeFileSync(path.join(backupDir, 'unknown.json'), before);
    fs.writeFileSync(path.join(backupDir, '1000000000000-00000000-0000-0000-0000-000000000000.json'), '{');
    store.setRetention(2, 0);
    assert(fs.existsSync(path.join(backupDir, 'unknown.json')));
    assert(fs.existsSync(path.join(backupDir, '1000000000000-00000000-0000-0000-0000-000000000000.json')));
    assert.strictEqual(store.backups().filter((item) => item.valid && item.name !== 'unknown.json').length, 2);
    store.remove(entry.id);
    const deleted = JSON.parse(fs.readFileSync(target, 'utf8'));
    deleted.trash[0].deletedAt = '2000-01-01T00:00:00Z';
    deleted.trash.push({ unrecognized: 'keep me' });
    fs.writeFileSync(target, JSON.stringify(deleted));
    store.setRetention(2, 0);
    assert.strictEqual(store.list().trash.length, 2, 'zero retains old trash');
    store.setRetention(2, 30);
    assert.strictEqual(store.list().trash.length, 1, 'expired known trash purged, unknown kept');
    store.restoreBackup('unknown.json');
    const bundle = store.exportBundle();
    const other = context.archive.open(path.join(root, 'portable'), library);
    assert.strictEqual(other.importBundle(bundle), 1, 'export is self contained across storage roots');
    assert.strictEqual(other.list().entries[0].recipe.payload.image_base64.length, 100000);
    const moved = context.archive.open(path.join(root, 'portable'), 'E:/moved.library');
    assert.throws(() => moved.importBundle(bundle), /损坏/);
    assert.strictEqual(moved.importBundle(bundle, { allowLibraryMove: true }), 1);
    assert.strictEqual(moved.list().entries[0].recipe, null);
    assert.strictEqual(moved.list().entries[0].sourceLibrary, library);
    const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
    const matchAsset = path.join(target.replace(/\.json$/, '-assets'), manifest.entries[0].matchesRef);
    fs.writeFileSync(matchAsset, '[]');
    const corruptedEntry = store.list().entries[0];
    await assert.rejects(() => store.hydrateEntry(corruptedEntry), /校验失败/);
    const current = fs.readFileSync(target, 'utf8');
    assert.throws(() => store.restoreBackup('unknown.json'), /校验失败/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), current);
    // Missing resources isolate only the affected record; a subsequent write
    // must not dereference the quarantined, invalid record.
    fs.unlinkSync(matchAsset);
    assert.strictEqual(store.list().entries.length, 0);
    store.category('add', '', 'after-quarantine');
    assert.strictEqual(store.list().quarantine.length, 1);
    console.log('warehouse resource, async hydration, retention, rollback and race tests passed');
  } finally {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('eagle-resource-test-')) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
