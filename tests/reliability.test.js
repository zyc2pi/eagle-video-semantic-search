const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { EventEmitter } = require('events');

function load(name, context) {
  return vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '..', 'js', `${name.toLowerCase()}.js`), 'utf8')}\n${name};`, context);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-reliability-'));
  try {
    let fail = false;
    const proxyFs = { ...fs, renameSync: (...args) => { if (fail) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.renameSync(...args); } };
    const config = load('Config', { require: (name) => name === 'fs' ? proxyFs : require(name), console });
    config.init(root);
    config.save({ visualThreshold: 0 });
    assert.strictEqual(config.get().visualThreshold, 0);
    const previous = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    fail = true;
    assert.throws(() => config.save({ visualThreshold: 30 }), /旧配置未改变/);
    assert.strictEqual(config.get().visualThreshold, 0);
    assert.strictEqual(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), previous);
    assert.deepStrictEqual(fs.readdirSync(root), ['config.json']);
    fail = false;
    for (const value of [NaN, -1, 121, '30']) assert.throws(() => config.save({ visualThreshold: value }));
    assert.throws(() => config.save({ port: 1.5 }));
    fs.writeFileSync(path.join(root, 'config.json'), '{bad');
    config.init(root);
    assert.match(config.getLoadError(), /原文件已保留/);
    assert.throws(() => config.save({ visualThreshold: 20 }), /禁止覆盖/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), '{bad');
    config.save({ visualThreshold: 0 }, { recover: true });
    assert.strictEqual(config.getLoadError(), '');
    const original = fs.readdirSync(root).find((name) => name.endsWith('.bak'));
    assert.strictEqual(fs.readFileSync(path.join(root, original), 'utf8'), '{bad');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  let spawns = 0;
  const states = [];
  const service = load('Service', {
    require: (name) => name === 'fs' ? { existsSync: () => true, openSync: () => { throw new Error('mock'); } }
      : name === 'child_process' ? { spawn: () => { spawns += 1; const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child; } } : require(name),
    Config: { get: () => ({ projectRoot: 'D:/mock', port: 5006 }), pluginPath: () => 'D:/mock' },
    Api: { health: async () => false }, process: { env: {} }, setTimeout, clearTimeout, console,
  });
  const first = service.ensure((s) => states.push(s));
  const second = service.ensure((s) => states.push(s));
  assert.strictEqual(first, second, '并发启动共用 Promise');
  assert.strictEqual(await first, false);
  assert.strictEqual(spawns, 1);
  assert.strictEqual(states.filter((s) => s === 'offline').length, 2);

  let scheduled = null;
  let failing = true;
  let submitted = 0;
  const notices = [];
  const indexer = load('Indexer', {
    require, console,
    setTimeout: (callback, ms) => { scheduled = { callback, ms }; return 1; }, clearTimeout: () => { scheduled = null; },
    Config: { get: () => ({ modelName: 'model' }) },
    Bridge: { resolveLibraryIdentity: async () => ({ id: 'library', path: 'D:/library', index_name: 'eagle_v2_library' }), collectLibraryVideos: async () => [{ filePath: 'D:/library/a.mp4' }] },
    Api: {
      listIndexJobs: async () => [],
      startIndex: async () => { submitted += 1; return { ok: true, data: { job_id: 'job1' } }; },
      indexStatus: async (id) => { assert.strictEqual(id, 'job1'); if (failing) throw new Error('offline'); return { state: 'done' }; },
      cancelIndex: async (id) => { assert.strictEqual(id, 'job1'); throw new Error('offline'); },
    },
  });
  assert.strictEqual((await indexer.start('all', { onConnection: (...args) => notices.push(args) })).started, true);
  for (let i = 0; i < 5; i += 1) { const tick = scheduled.callback; scheduled = null; await tick(); assert(scheduled); }
  assert.strictEqual(indexer.isRunning(), true, '掉线时保持未知任务身份，防止重复写入');
  assert(notices.some((value) => value[1].includes('状态未知')));
  assert.strictEqual(scheduled.ms, 30000);
  assert.strictEqual((await indexer.start('all')).started, false);
  assert.strictEqual(submitted, 1);
  assert.strictEqual((await indexer.cancel()).ok, false);
  failing = false;
  await scheduled.callback();
  assert.strictEqual(indexer.isRunning(), false);
  assert.strictEqual(scheduled, null);
  console.log('atomic config, shared startup, serial reconnect and targeted cancel tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
