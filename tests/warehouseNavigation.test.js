const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pending = new Map();
const elements = new Map();
const events = [];
const element = (id) => {
  if (!elements.has(id)) elements.set(id, { value: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} }, focus() {} });
  return elements.get(id);
};
const document = { body: { dataset: { page: 'warehouse' } }, getElementById: element };
let displayed = 'original';
const context = {
  document, console, clearTimeout,
  eagle: { library: { path: 'D:/navigation.library' } },
  Config: { pluginPath: () => '/fixture' },
  ArchiveStore: { open: () => ({ hydrateEntry: (entry) => pending.get(entry.id)?.promise || Promise.resolve() }) },
  SearchRecipe: { normalize: (value) => value.toLowerCase(), clone: (value) => JSON.parse(JSON.stringify(value)) },
  Search: {
    isBusy: () => false, captureState: () => ({ library: 'd:/navigation.library', position: null }),
    loadResults: async (_matches, query, _recipe, _view, _keys, _time, _filter, options) => {
      if (!options.shouldApply()) return null;
      displayed = query; events.push(query); return 0;
    },
    getView: () => ({ sortBy: 'sim', minDur: 0 }),
    getRawMatches: () => [],
    restoreState: () => { displayed = 'original'; },
    setArchiveTime() {}, pausePreview() {}, captureBrowsePosition: () => null,
    restoreBrowsePosition: async () => false,
  },
};
const source = fs.readFileSync(path.join(__dirname, '../js/warehouse.js'), 'utf8');
const returnAt = source.lastIndexOf('  return {');
assert(returnAt >= 0);
const seam = `
  rememberTopicPosition = () => {};
  rememberWarehousePosition = () => {};
  clearRemovalUi = () => {};
  syncSceneActions = () => {};
  syncTopic = () => {};
  restoreTopicPosition = async () => {};
  this.inspect = { load, returnToSearch, showSearch, detachTopic, current: () => current };
`;
vm.runInNewContext(source.slice(0, returnAt) + seam + source.slice(returnAt), context);
const topic = (id) => ({ id, matches: [], view: {}, recipe: { query: id }, newKeys: [] });
function delay(id) {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  pending.set(id, { promise, release });
  return release;
}
(async () => {
  const releaseA = delay('A');
  const slowA = context.inspect.load(topic('A'));
  await context.inspect.load(topic('B'));
  releaseA();
  assert.strictEqual(await slowA, false);
  assert.strictEqual(displayed, 'B', '迟到 A 不得覆盖最后打开的 B');
  assert.deepStrictEqual(events, ['B']);

  const releaseC = delay('C');
  const slowC = context.inspect.load(topic('C'));
  await context.inspect.returnToSearch();
  releaseC();
  assert.strictEqual(await slowC, false);
  assert.strictEqual(displayed, 'original', '返回搜索后迟到主题不得抢回结果');
  assert.strictEqual(context.inspect.current(), null);

  const releaseD = delay('D');
  const slowD = context.inspect.load(topic('D'));
  context.inspect.detachTopic(); // Successful new search releases topic state.
  context.inspect.showSearch();
  displayed = 'new-query';
  releaseD();
  assert.strictEqual(await slowD, false);
  assert.strictEqual(displayed, 'new-query', '成功新搜索不能被旧主题读取覆盖');

  const releaseE = delay('E');
  const slowE = context.inspect.load(topic('E'));
  context.eagle.library.path = 'D:/other.library';
  releaseE();
  assert.strictEqual(await slowE, false);
  assert.strictEqual(displayed, 'new-query', '跨库迟到结果不得写入界面');
  console.log('warehouse late loads, latest navigation, search return and library guards passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
