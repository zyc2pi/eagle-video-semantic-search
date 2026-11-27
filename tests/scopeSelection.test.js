const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FolderTree = require('../js/folderTree');

const plugin = fs.readFileSync(path.join(__dirname, '..', 'js', 'plugin.js'), 'utf8');
const start = plugin.indexOf('  async function addSelectedScopeFolders()');
const end = plugin.indexOf('  async function applyScopeDialog()', start);
assert(start >= 0 && end > start);
const handler = plugin.slice(start, end);

function setup(getSelected) {
  const elements = {
    'scope-dialog': { open: true },
    'btn-scope-add-selected': { disabled: false },
    'folder-tree': {},
  };
  const radio = { checked: false };
  const notices = [];
  const context = {
    scopeDialogTarget: {},
    scopeDialogChecked: new Set(['existing']),
    scopeDialogExpanded: new Set(),
    scopeFolderRoots: [{ id: 'parent', children: [{ id: 'child' }] }, { id: 'existing' }],
    isScopeContextCurrent: () => true,
    $: (id) => elements[id],
    document: { querySelector: () => radio },
    eagle: { folder: { getSelected } },
    ScopeFolderTree: FolderTree,
    saveScopeExpanded() {},
    renderFolderTree() { context.renders += 1; },
    toast: (message) => notices.push(message),
    renders: 0,
  };
  vm.createContext(context);
  vm.runInContext(handler, context);
  return { context, elements, radio, notices };
}

(async () => {
  const added = setup(async () => [{ id: 'child' }, { id: 'child' }]);
  await added.context.addSelectedScopeFolders();
  assert.deepStrictEqual([...added.context.scopeDialogChecked], ['existing', 'child'], '保留原选择并去重加入');
  assert(added.context.scopeDialogExpanded.has('parent'), '展开选中文件夹的祖先');
  assert(added.radio.checked, '切换到指定文件夹模式');
  assert.strictEqual(added.context.renders, 1);
  assert.strictEqual(added.elements['btn-scope-add-selected'].disabled, false);

  for (const getSelected of [async () => [], async () => [{ id: 'child' }, { id: 'missing' }], async () => { throw new Error('读取失败'); }]) {
    const failed = setup(getSelected);
    await failed.context.addSelectedScopeFolders();
    assert.deepStrictEqual([...failed.context.scopeDialogChecked], ['existing'], '无选择、失效或读取失败时不改变勾选');
    assert.strictEqual(failed.radio.checked, false);
    assert.strictEqual(failed.notices.length, 1, '明确提示失败原因');
  }

  for (const change of [
    (s) => { s.elements['scope-dialog'].open = false; },
    (s) => { s.context.scopeDialogTarget = {}; },
    (s) => { s.context.isScopeContextCurrent = () => false; },
  ]) {
    let resolve;
    const stale = setup(() => new Promise((done) => { resolve = done; }));
    const pending = stale.context.addSelectedScopeFolders();
    change(stale);
    resolve([{ id: 'child' }]);
    await pending;
    assert.deepStrictEqual([...stale.context.scopeDialogChecked], ['existing'], '取消、重开或上下文切换后丢弃迟到响应');
    assert.strictEqual(stale.context.renders, 0);
    assert.strictEqual(stale.notices.length, 0);
  }
  // 后台读取先开始，手动固定范围后开始。即使宿主仍显示旧配置，轮询也不能抢占手动操作。
  let finishPoll, finishManual;
  let folderReads = 0;
  const writes = [];
  const race = {
    scopeOperation: 0, applyingScope: null, followPolling: false, pluginVisible: true, followedKey: null,
    scopeContextGeneration: 0, document: { body: { dataset: {} } }, eagle: { library: { path: 'lib' } },
    Config: { get: () => ({ scopeFollow: true }), setScope: (cfg) => writes.push(cfg) },
    Search: { isBusy: () => false, setScopeFilter() {} }, updateScopeButton() {}, rememberFollowed() {}, saveScopeChoice() {},
    SearchRecipe: {
      scopeFromConfig(cfg) {
        if (!cfg.scopeFollow) return Promise.resolve({ scope: { mode: 'folders' } });
        folderReads++;
        return new Promise((done) => { finishPoll = done; });
      },
      resolveScope: () => new Promise((done) => { finishManual = done; }),
    },
  };
  vm.runInNewContext(plugin.slice(plugin.indexOf('  async function pollFollowedFolders()'), plugin.indexOf('  function renderFolderRows(')), race);
  const polling = race.pollFollowedFolders();
  const manual = race.applySessionScope({ scopeFollow: false, scopeMode: 'custom', scopeFolderIds: ['chosen'] }, race.scopeContext());
  finishPoll({ followKey: 'former', scope: { mode: 'folders' } });
  await polling;
  await race.pollFollowedFolders();
  assert.strictEqual(folderReads, 1);
  finishManual({ paths: new Set(['chosen']) });
  assert.strictEqual(await manual, true);
  assert.deepStrictEqual(writes.map((cfg) => [cfg.scopeFollow, ...cfg.scopeFolderIds]), [[false, 'chosen']]);

  const defaults = { scopeMode: 'all', scopeFollow: false, scopeFolderIds: [], scopeExcludeFolderIds: [] };
  let cfg = defaults;
  const storage = new Map();
  const choice = {
    scopeOperation: 0, eagle: { library: { path: 'library-a' } },
    SearchRecipe: { normalize: (library) => library }, Search: { setScopeFilter() {} },
    Config: { get: () => cfg, setScope: (scope) => { cfg = { ...defaults, ...scope }; } },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    rememberFollowed() {}, updateScopeButton() {},
  };
  vm.runInNewContext(plugin.slice(plugin.indexOf('  const scopeChoiceKey'), plugin.indexOf('  /* 实时跟随：')), choice);
  choice.resetSearchScope({ restore: true });
  assert.strictEqual(cfg.scopeMode, 'all');
  assert.strictEqual(cfg.scopeFollow, false);
  choice.saveScopeChoice('library-a', { ...defaults, scopeMode: 'custom', scopeFolderIds: ['chosen'] });
  choice.eagle.library.path = 'library-b';
  choice.resetSearchScope({ restore: true });
  assert.strictEqual(cfg.scopeMode, 'all');
  choice.eagle.library.path = 'library-a';
  choice.resetSearchScope({ restore: true });
  assert.strictEqual(cfg.scopeMode, 'custom');
  assert.strictEqual(cfg.scopeFolderIds[0], 'chosen');
  choice.resetSearchScope();
  choice.resetSearchScope({ restore: true });
  assert.strictEqual(cfg.scopeMode, 'all');
  assert.strictEqual(cfg.scopeFollow, false);
  console.log('scope selection, stale responses and manual priority passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
