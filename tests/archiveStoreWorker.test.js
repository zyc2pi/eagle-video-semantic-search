const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-worker-test-'));
const source = fs.readFileSync(path.join(__dirname, '../js/archiveStore.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(__dirname, '../js/archiveWorker.js'), 'utf8');
const context = { require };
vm.runInNewContext(`${source}\nthis.archive = ArchiveStore;`, context);
const fixture = (name) => {
  const location = path.join(root, name);
  fs.mkdirSync(path.join(location, 'js'), { recursive: true });
  fs.writeFileSync(path.join(location, 'js', 'archiveStore.js'), source);
  fs.writeFileSync(path.join(location, 'js', 'archiveWorker.js'), workerSource);
  return location;
};
const manifest = (location) => path.join(location, 'warehouse', fs.readdirSync(path.join(location, 'warehouse')).find((name) => name.endsWith('.json')));

(async () => {
  try {
    const library = 'D:/worker-fixture.library';
    const originalRoot = fixture('source');
    const store = context.archive.open(originalRoot, library);
    const entry = store.add({ name: 'synthetic snapshot', recipe: { query: 'fixture', payload: { image_base64: 'a'.repeat(1024 * 1024) } },
      view: {}, matches: Array.from({ length: 1000 }, (_, i) => ({ video_path: 'D:/fixture.mp4', start_frame: i, end_frame: i + 1 })) });
    store.setCover(entry.id, { dataUrl: 'data:image/jpeg;base64,YQ==', frame: 10 });
    store.remove(entry.id);
    const bundle = await store.exportBundleAsync();
    assert.strictEqual(JSON.parse(bundle).version, 1);
    const portableRoot = fixture('portable');
    const portable = context.archive.open(portableRoot, library);
    assert.strictEqual(await portable.importBundleAsync(bundle), 0);
    const restored = portable.restore(portable.list().trash[0].trashId);
    await portable.hydrateEntry(restored);
    assert.strictEqual(restored.matches.length, 1000);
    assert.strictEqual(restored.recipe.payload.image_base64.length, 1024 * 1024);
    assert.strictEqual(restored.cover.frame, 10);
    const before = fs.readFileSync(manifest(portableRoot), 'utf8');
    await assert.rejects(() => portable.importBundleAsync('{}'), /格式或校验和/);
    assert.strictEqual(fs.readFileSync(manifest(portableRoot), 'utf8'), before);
    fs.writeFileSync(`${manifest(portableRoot)}.lock`, JSON.stringify({ pid: process.pid }));
    await assert.rejects(() => portable.importBundleAsync(bundle), /其他窗口/);
    assert.strictEqual(fs.readFileSync(manifest(portableRoot), 'utf8'), before);
    fs.unlinkSync(`${manifest(portableRoot)}.lock`);

    // Gate startup to guarantee a main-window modification while an import is
    // queued. Only temporary fixture source is instrumented.
    const gate = path.join(portableRoot, 'continue-worker');
    const workerFile = path.join(portableRoot, 'js', 'archiveWorker.js');
    fs.writeFileSync(workerFile, `while (!require('fs').existsSync(${JSON.stringify(gate)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);\n${workerSource}`);
    const pending = portable.importBundleAsync(bundle);
    portable.category('add', '', 'concurrent category');
    const changed = fs.readFileSync(manifest(portableRoot), 'utf8');
    fs.writeFileSync(gate, 'continue');
    await assert.rejects(() => pending, /后台处理期间被其他操作更新/);
    assert.strictEqual(fs.readFileSync(manifest(portableRoot), 'utf8'), changed);

    fs.writeFileSync(workerFile, 'process.exit(0);');
    await assert.rejects(() => portable.exportBundleAsync(), /未返回结果/);
    fs.writeFileSync(workerFile, "require('worker_threads').parentPort.postMessage({ unexpected: true }); setInterval(() => {}, 1000);");
    await assert.rejects(() => portable.exportBundleAsync(), /无效结果/);
    fs.writeFileSync(workerFile, "require('worker_threads').parentPort.postMessage({ ok: true, value: 1 }); setInterval(() => {}, 1000);");
    await assert.rejects(() => portable.exportBundleAsync(), /无效结果/);
    for (const value of ['"1"', '-1', 'null']) {
      fs.writeFileSync(workerFile, `require('worker_threads').parentPort.postMessage({ ok: true, value: ${value} }); setInterval(() => {}, 1000);`);
      await assert.rejects(() => portable.importBundleAsync(bundle), /无效结果/);
      assert.strictEqual(fs.readFileSync(manifest(portableRoot), 'utf8'), changed);
    }
    fs.writeFileSync(workerFile, 'throw new Error("fixture crash");');
    await assert.rejects(() => portable.importBundleAsync(bundle), /写入结果尚未知/);
    assert.strictEqual(fs.readFileSync(manifest(portableRoot), 'utf8'), changed);
    fs.writeFileSync(workerFile, 'setInterval(() => {}, 1000);');
    await assert.rejects(() => portable.exportBundleAsync({ timeoutMs: 100 }), /超时/);
    fs.writeFileSync(workerFile, workerSource);
    assert.strictEqual(await portable.importBundleAsync(bundle), 0, 'later operations remain available after worker failures');

    const unsupported = context.archive.open(path.join(root, 'missing-worker'), library);
    await assert.rejects(() => unsupported.exportBundleAsync(), /缺少仓库后台处理程序/);
    const noWorkerContext = { require: (name) => {
      if (name === 'worker_threads') throw new Error('not supported');
      return require(name);
    } };
    vm.runInNewContext(`${source}\nthis.archive = ArchiveStore;`, noWorkerContext);
    await assert.rejects(() => noWorkerContext.archive.open(originalRoot, library).exportBundleAsync(), /不支持仓库后台处理/);

    const packed = JSON.parse(fs.readFileSync(manifest(originalRoot), 'utf8'));
    fs.writeFileSync(path.join(manifest(originalRoot).replace(/\.json$/, '-assets'), packed.trash[0].entry.matchesRef), '[]');
    await assert.rejects(() => store.exportBundleAsync(), /校验失败/);
    console.log('worker bundle roundtrip, concurrent revision, failure protection, exit, timeout and compatibility tests passed');
  } finally {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('eagle-worker-test-')) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
