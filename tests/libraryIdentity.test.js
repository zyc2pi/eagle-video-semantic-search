const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
async function main() {
  const eagle = { library: { path: 'D:/one/Same.library' }, item: { getAll: async () => { reads++; return [{ filePath: `${eagle.library.path}/a.mp4`, ext: 'mp4' }]; } } };
  let reads = 0;
  let resolved = 0;
  let supported = true;
  const bridge = vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../js/eagleBridge.js'), 'utf8')}\nBridge`, {
    eagle, console, Config: { baseUrl: () => 'http://fixture' },
    Api: { healthInfo: async () => ({ capabilities: { library_identity: supported } }),
      resolveLibrary: async (p) => { resolved++; return { id: p, path: 'canonical-path-not-current-alias', index_name: `id-${resolved}` }; } },
  });
  assert.throws(() => bridge.indexNameForLibrary(), /先解析/);
  const [one, shared] = await Promise.all([bridge.resolveLibraryIdentity(), bridge.resolveLibraryIdentity()]);
  assert.strictEqual(one, shared);
  assert.strictEqual(resolved, 1);
  assert.strictEqual(one.path, eagle.library.path, '提交当前Eagle路径，不使用登记别名canonical');
  const firstName = bridge.indexNameForLibrary();
  await Promise.all([bridge.collectLibraryVideos(), bridge.collectLibraryVideos()]);
  assert.strictEqual(reads, 1);
  await bridge.collectLibraryVideos();
  assert.strictEqual(reads, 1);
  await bridge.collectLibraryVideos(true);
  assert.strictEqual(reads, 2);
  eagle.library.path = 'D:/two/Same.library';
  await bridge.resolveLibraryIdentity();
  assert.notStrictEqual(bridge.indexNameForLibrary(), firstName, '同名不同路径库隔离');
  await bridge.collectLibraryVideos();
  assert.strictEqual(reads, 3);
  bridge.invalidateCache();
  await bridge.collectLibraryVideos();
  assert.strictEqual(reads, 4);
  supported = false; eagle.library.path = 'D:/three/Same.library';
  await assert.rejects(bridge.resolveLibraryIdentity(), /升级并重启/);
  console.log('library identity, canonical alias, shared cache and capability fail-closed tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
