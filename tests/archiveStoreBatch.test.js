const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-category-test-'));
let commits = 0;
let locks = 0;
let assetReads = 0;
let failCommit = false;
const fakeFs = { ...fs,
  readFileSync(filename, ...args) {
    if (String(filename).includes('-assets')) assetReads += 1;
    return fs.readFileSync(filename, ...args);
  },
  writeFileSync(filename, ...args) {
    if (String(filename).endsWith('.lock')) locks += 1;
    return fs.writeFileSync(filename, ...args);
  },
  renameSync(source, target) {
    if (path.dirname(target) === path.join(root, 'warehouse')) {
      commits += 1;
      if (failCommit) throw new Error('batch commit failed');
    }
    return fs.renameSync(source, target);
  },
};
const context = { require: (name) => name === 'fs' ? fakeFs : require(name) };
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../js/archiveStore.js'), 'utf8')}\nthis.archive = ArchiveStore;`, context);
const snapshot = (entry) => ({ id: entry.id, updatedAt: entry.updatedAt, revision: entry.revision || 0 });

try {
  const store = context.archive.open(root, 'D:/batch.library');
  const entries = Array.from({ length: 4 }, (_, i) => store.add({ name: `topic ${i}`,
    recipe: { query: 'fixture', payload: { image_base64: 'a'.repeat(100000) } },
    view: {}, matches: [{ video_path: `D:/fixture-${i}.mp4`, start_frame: 1, end_frame: 2 }] }));
  store.category('add', '', 'destination');
  const categoryId = store.list().categories[0].id;
  const old = JSON.parse(JSON.stringify(entries[0]));
  const expected = entries.map(snapshot);
  commits = 0; locks = 0; assetReads = 0;
  let result = store.setCategories(expected, categoryId);
  assert(result.results.every((item) => item.ok && item.revision === 1));
  assert.strictEqual(commits, 1, 'whole batch commits one manifest');
  assert.strictEqual(locks, 1, 'whole batch acquires one lock');
  assert.strictEqual(assetReads, 0, 'classification never loads matches, cover or query images');
  assert.throws(() => store.replace({ ...old, name: 'stale edit' }, old.updatedAt), /其他操作更新/);
  assert(store.list().entries.every((entry) => entry.categoryId === categoryId && entry.updatedAt === entry.createdAt));

  let current = store.list().entries;
  commits = 0;
  result = store.setCategories([expected[0], snapshot(current[1]), { id: 'deleted', updatedAt: '', revision: 0 }], '');
  assert.strictEqual(result.results[0].ok, false);
  assert.strictEqual(result.results[0].code, 'conflict');
  assert.strictEqual(result.results[1].ok, true);
  assert.strictEqual(result.results[2].code, 'missing');
  assert.strictEqual(commits, 1);
  current = store.list().entries;
  assert.strictEqual(current[0].categoryId, categoryId);
  assert.strictEqual(current[1].categoryId, '');
  commits = 0;
  store.setCategories([expected[0]], '');
  assert.strictEqual(commits, 0, 'all-conflict batch does not back up or write');

  const beforeFailure = current.map(snapshot);
  const manifest = path.join(root, 'warehouse', fs.readdirSync(path.join(root, 'warehouse')).find((name) => name.endsWith('.json')));
  const original = fs.readFileSync(manifest, 'utf8');
  failCommit = true;
  assert.throws(() => store.setCategories(beforeFailure, ''), /batch commit failed/);
  assert.strictEqual(fs.readFileSync(manifest, 'utf8'), original, 'failed commit preserves all entries');
  assert(!fs.existsSync(`${manifest}.lock`));
  failCommit = false;
  assert(store.setCategories(beforeFailure, '').results.every((item) => item.ok), 'same requests can retry after write failure');

  current = store.list().entries;
  assetReads = 0;
  const lightweight = store.setCategory(current[0].id, categoryId, current[0].updatedAt, current[0].revision);
  assert.strictEqual(lightweight.matches, undefined);
  assert.strictEqual(assetReads, 0);
  assert.throws(() => store.setCategory(current[0].id, '', current[0].updatedAt, current[0].revision), /已被修改/);
  const beforeRename = store.list().entries[0];
  store.category('rename', categoryId, 'renamed');
  assert.throws(() => store.replace(beforeRename, beforeRename.updatedAt), /其他操作更新/);
  const beforeDelete = store.list().entries[0];
  store.category('remove', categoryId);
  assert.throws(() => store.replace(beforeDelete, beforeDelete.updatedAt), /其他操作更新/);
  assert.strictEqual(store.list().entries[0].categoryId, '');
  console.log('batch category commit, conflict, lightweight result and revision tests passed');
} finally {
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('eagle-category-test-')) fs.rmSync(root, { recursive: true, force: true });
}
