const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const TopicUndo = require('../js/topicUndo.js');

function fixture(options = {}) {
  let library = 'D:/library-a';
  const entries = new Map();
  const tokens = new WeakMap();
  const applied = [];
  let failures = 0;
  let writes = 0;
  let changed = 0;
  const key = (lib, id) => lib.replace(/\//g, '\\').toLowerCase() + '|' + id;
  const current = id => entries.get(key(library, id));
  const manager = TopicUndo.create({
    getLibrary: () => library,
    openStore: lib => ({ undoMatches(id, token, expectedUpdatedAt, expectedRevision) {
      const state = tokens.get(token);
      const entry = entries.get(key(lib, id));
      if (!entry || entry.updatedAt !== expectedUpdatedAt || entry.revision !== expectedRevision) throw new Error('主题已被其他操作更新');
      if (!state || state.key !== key(lib, id) || state.after !== entry.value) throw new Error('撤销内容冲突');
      if (failures) { failures--; throw new Error('write failed'); }
      writes++;
      const result = { ...entry, value: state.before, revision: entry.revision + 1 };
      entries.set(state.key, result); tokens.delete(token);
      return { entry: result, keys: ['scene'] };
    } }),
    onApplied: (entry, record) => applied.push({ id: entry.id, library: record.library }),
    onChanged: () => changed++,
    ...options,
  });
  function commit(id, value, extra = {}) {
    const prior = current(id) || { id, name: '主题 ' + id, value: 0, revision: 0, updatedAt: '2026-10-07T00:00:00Z' };
    const entry = { ...prior, value, revision: prior.revision + 1 };
    entries.set(key(library, id), entry);
    const token = {};
    tokens.set(token, { key: key(library, id), before: prior.value, after: value });
    const recorded = manager.record({ entry, undoToken: token, undoBytes: 100,
      beforeRevision: prior.revision, label: '调整评分', library, targetName: entry.name, ...extra });
    return { entry, token, recorded };
  }
  return { manager, commit, current, applied, entries, setLibrary: value => { library = value; },
    setFailures: count => { failures = count; }, writes: () => writes, changed: () => changed,
    mutate: (id, patch) => Object.assign(current(id), patch) };
}

function test(name, run) { run(); console.log('✓ ' + name); }

test('空历史禁用；无变更token不进入历史', () => {
  const f = fixture();
  assert.strictEqual(f.manager.canUndo(), false);
  assert.strictEqual(f.manager.peek(), null);
  assert.strictEqual(f.manager.undo().undone, false);
  assert.strictEqual(f.manager.record({ entry: { id: 'a' }, undoToken: null }).recorded, false);
  assert.strictEqual(f.writes(), 0);
});

test('同主题收录与改分逆序撤销，revision安全重基并保持单调', () => {
  const f = fixture();
  const first = f.commit('a', 1, { label: '收录片段' });
  first.entry.name = 'later mutated name';
  f.commit('a', 2, { label: '调整评分' });
  assert.strictEqual(f.manager.peek().label, '调整评分');
  const result = f.manager.undo();
  assert.strictEqual(result.undone, true);
  assert.strictEqual(f.current('a').value, 1);
  assert.strictEqual(f.current('a').revision, 3);
  assert.strictEqual(f.manager.peek().expectedRevision, 3);
  assert.strictEqual(f.manager.peek().targetName, '主题 a', '历史不保留可变entry对象');
  assert.strictEqual(f.manager.undo().entry.revision, 4);
  assert.strictEqual(f.current('a').value, 0);
  assert.strictEqual(f.manager.state().count, 0);
  assert.deepStrictEqual(f.applied.map(x => x.id), ['a', 'a']);
});

test('跨主题逆序撤销不导航，找到同目标最近祖先重基', () => {
  const f = fixture();
  f.commit('a', 1); f.commit('b', 10); f.commit('a', 2);
  f.manager.undo();
  assert.strictEqual(f.manager.peek().targetId, 'b');
  f.manager.undo();
  assert.strictEqual(f.manager.peek().expectedRevision, 3);
  f.manager.undo();
  assert.deepStrictEqual(f.applied.map(x => x.id), ['a', 'b', 'a']);
  assert.strictEqual(f.current('a').value, 0);
  assert.strictEqual(f.current('b').value, 0);
});

test('未记录的metadata修改不得伪造祖先链；冲突保留记录', () => {
  const f = fixture();
  f.commit('a', 1);
  f.mutate('a', { revision: 2, favorite: true });
  f.commit('a', 2);
  f.manager.undo();
  assert.strictEqual(f.manager.peek().expectedRevision, 1, '有版本间隙时不得重基');
  assert.throws(() => f.manager.undo(), /其他操作更新/);
  assert.strictEqual(f.manager.state().count, 1);
  assert.strictEqual(f.current('a').favorite, true);
  assert.strictEqual(f.current('a').value, 1);
});

test('写失败保留可重试token与版本', () => {
  const f = fixture();
  f.commit('a', 1); f.setFailures(1);
  assert.throws(() => f.manager.undo(), /write failed/);
  assert.strictEqual(f.manager.canUndo(), true);
  assert.strictEqual(f.manager.peek().expectedRevision, 1);
  assert.strictEqual(f.manager.state().busy, false);
  assert.strictEqual(f.manager.undo().undone, true);
  assert.strictEqual(f.writes(), 1);
});

test('历史按库隔离，跨库屏蔽与大小写路径规范化', () => {
  const f = fixture();
  f.commit('a', 1);
  f.setLibrary('D:/library-b');
  assert.strictEqual(f.manager.canUndo(), false);
  assert.strictEqual(f.manager.peek(), null);
  f.commit('b', 2); f.manager.undo();
  f.setLibrary('d:\\LIBRARY-A');
  assert.strictEqual(f.manager.canUndo(), true);
  f.manager.undo();
  assert.strictEqual(f.current('a').value, 0);
});

test('20步限制淘汰最早记录，保留连续祖先与容量统计', () => {
  const f = fixture();
  for (let i = 1; i <= 21; i++) f.commit('a', i);
  assert.strictEqual(f.manager.state().count, 20);
  for (let i = 0; i < 20; i++) f.manager.undo();
  assert.strictEqual(f.current('a').value, 1);
  assert.strictEqual(f.manager.state().totalBytes, 0);
});

test('会话总内存预算跨库淘汰最旧记录，超大或未知token拒绝保存', () => {
  const f = fixture({ maxBytes: 1200 });
  f.commit('a', 1);
  f.setLibrary('D:/library-b'); f.commit('b', 2);
  f.setLibrary('D:/library-c'); f.commit('c', 3);
  assert(f.manager.state().totalBytes <= 1200);
  f.setLibrary('D:/library-a');
  assert.strictEqual(f.manager.canUndo(), false, '全局预算必须覆盖其他库历史');
  assert.strictEqual(f.commit('a', 2, { undoBytes: TopicUndo.MAX_BYTES + 1 }).recorded.recorded, false);
  assert.strictEqual(f.commit('a', 3, { undoBytes: NaN }).recorded.recorded, false);
});

test('storage打开后切库拦截；同步撤销忙碌时不能递归或插入记录', () => {
  let f;
  let once = true;
  f = fixture({ openStore: () => {
    if (once) { once = false; f.setLibrary('D:/library-b'); }
    return { undoMatches() { throw new Error('should not write'); } };
  } });
  f.commit('a', 1);
  assert.throws(() => f.manager.undo(), /素材库已切换/);
  f.setLibrary('D:/library-a');
  assert.strictEqual(f.manager.state().count, 1);
  let reentrant;
  const observations = [];
  reentrant = fixture({ onChanged: () => {
    if (!reentrant?.manager.state().busy) return;
    let error;
    try { reentrant.manager.undo(); } catch (caught) { error = caught; }
    observations.push({ enabled: reentrant.manager.canUndo(), error, recorded: reentrant.manager.record({}).recorded });
  } });
  reentrant.commit('a', 1); reentrant.manager.undo();
  assert.strictEqual(reentrant.writes(), 1);
  assert.strictEqual(observations.length, 1);
  assert.strictEqual(observations[0].enabled, false);
  assert.match(observations[0].error.message, /正在撤销/);
  assert.strictEqual(observations[0].recorded, false);
});

test('展示回调失败不假称写盘失败，不重复消费已撤销token', () => {
  const f = fixture({ onApplied: () => { throw new Error('refresh failed'); } });
  f.commit('a', 1);
  const result = f.manager.undo();
  assert.strictEqual(result.undone, true);
  assert.strictEqual(result.refreshError.message, 'refresh failed');
  assert.strictEqual(f.manager.canUndo(), false);
  assert.strictEqual(f.current('a').value, 0);
  assert.strictEqual(f.writes(), 1);
  assert(f.changed() >= 3);
});

test('清空只释放当前库，全部清空释放会话预算', () => {
  const f = fixture();
  f.commit('a', 1); f.setLibrary('D:/library-b'); f.commit('b', 1);
  f.manager.clear();
  assert.strictEqual(f.manager.canUndo(), false);
  f.setLibrary('D:/library-a'); assert.strictEqual(f.manager.canUndo(), true);
  f.manager.clear({ all: true });
  assert.strictEqual(f.manager.state().totalBytes, 0);
});

test('真实存储token连续逆序撤销、写盘失败重试及星标版本间隙', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-topic-undo-'));
  let failCommit = false;
  const proxyFs = { ...fs, renameSync(source, destination) {
    if (failCommit && path.basename(path.dirname(destination)) === 'warehouse'
        && destination.endsWith('.json')) throw new Error('test commit failure');
    return fs.renameSync(source, destination);
  } };
  try {
    const context = { require: name => name === 'fs' ? proxyFs : require(name) };
    const archive = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/archiveStore.js'), 'utf8') + '\nArchiveStore;', context);
    const library = 'D:/undo-integration.library';
    const openStore = () => archive.open(root, library);
    const manager = TopicUndo.create({ getLibrary: () => library, openStore });
    const scene = start => ({ eagleItemId: 'video', video_path: 'D:/video.mp4',
      start_frame: start, end_frame: start + 10, fps: 25, similarity: 41 });
    const first = scene(0); const added = scene(20);
    let entry = openStore().add({ name: '目标', matches: [first], recipe: { kind: 'text', query: 'fireworks' }, view: {} });
    entry = openStore().replace({ ...entry, newKeys: [archive.sceneKey(first)] }, entry.updatedAt);
    const initialRevision = entry.revision;
    const initialUpdatedAt = entry.updatedAt;
    function add(additions) {
      const beforeRevision = entry.revision || 0;
      const result = openStore().addMatches(entry.id, additions, entry.updatedAt, beforeRevision);
      entry = result.entry;
      assert.strictEqual(manager.record({ ...result, beforeRevision, library, label: '收录' }).recorded, true);
    }
    add([{ match: first, score: 18, scoreMode: 'custom' }, { match: added, score: 22, scoreMode: 'top' }]);
    add([{ match: first, score: 25.3, scoreMode: 'custom' }]);
    failCommit = true;
    assert.throws(() => manager.undo(), /test commit failure/);
    assert.strictEqual(manager.state().count, 2);
    failCommit = false;
    entry = manager.undo().entry;
    assert.strictEqual(entry.matches[0].manualScore.value, 18);
    assert.strictEqual(entry.revision, initialRevision + 3);
    entry = manager.undo().entry;
    assert.strictEqual(entry.revision, initialRevision + 4);
    assert.strictEqual(entry.updatedAt, initialUpdatedAt);
    assert.strictEqual(entry.matches.length, 1);
    assert.strictEqual(entry.matches[0].similarity, 41);
    assert.strictEqual(entry.matches[0].manualScore, undefined);
    assert.deepStrictEqual(Array.from(entry.newKeys), [archive.sceneKey(first)]);

    add([{ match: first, score: 19, scoreMode: 'custom' }]);
    entry = openStore().setFavorite(entry.id, true, entry.updatedAt, entry.revision);
    add([{ match: first, score: 21, scoreMode: 'custom' }]);
    entry = manager.undo().entry;
    assert.strictEqual(entry.favorite, true);
    assert.throws(() => manager.undo(), /其他操作更新/);
    assert.strictEqual(manager.state().count, 1, '星标间隙不能被管理器伪造版本链绕过');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log('topic undo manager regression passed');
