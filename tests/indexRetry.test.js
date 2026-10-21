const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SearchCache = require('../js/searchCache.js');

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.open = false; this.disabled = false;
    this.textContent = ''; this.innerHTML = ''; this.style = {}; this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
}

async function main() {
  const elements = new Map();
  const node = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let scheduled;
  let jobState = 'error';
  let submitted = 0;
  const malicious = '<img src=x onerror="mockAttack()">';
  const library = { id: 'library', path: 'D:/library', index_name: 'eagle_v2_library' };
  const context = {
    require, console: { ...console, error() {} }, SearchCache, clearTimeout: () => { scheduled = null; },
    setTimeout: (callback, ms) => { scheduled = { callback, ms }; return 1; },
    Config: { get: () => ({ scopeMode: 'all', scopeFolderIds: [], modelName: 'model' }) },
    Search: { isBusy: () => false },
    document: { getElementById: node, querySelectorAll: () => [], body: new Element(), createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) },
    eagle: { library: { path: library.path }, onPluginCreate() {}, onPluginShow() {}, onThemeChanged() {}, onLibraryChanged() {} },
    Bridge: {
      resolveLibraryIdentity: async () => library,
      getFolderTree: async () => { throw new Error(malicious); },
      collectLibraryVideos: async () => { throw new Error(malicious); },
    },
    Api: {
      listIndexJobs: async () => [{ job_id: 'failed-job', source: 'semantic-search', state: jobState,
        file_results: [{ path: 'D:/library/bad.mp4', state: 'failed', reason: 'processing failed', retryable: true }] }],
      retryIndex: async (id, key) => { assert.strictEqual(id, 'failed-job'); assert(key); submitted++; jobState = 'running'; return { job_id: 'retry-job' }; },
      indexStatus: async id => { assert.strictEqual(id, 'retry-job'); return { state: 'error', error: 'partially written failure' }; },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/indexer.js'), 'utf8') + '\nthis.Indexer = Indexer;', context);
  const plugin = fs.readFileSync(path.join(__dirname, '../js/plugin.js'), 'utf8');
  vm.runInContext(plugin.replace('  eagle.onPluginCreate(', '  this.hooks = { openIndexJobs, openScopeDialog, openStats, setServiceStatus };\n  eagle.onPluginCreate('), context);

  SearchCache.clear();
  SearchCache.set({ query: 'before retry' }, [{ id: 1 }]);
  await context.hooks.openIndexJobs();
  const body = node('index-jobs-dialog').children[1];
  const row = body.children[0];
  assert(row.children[1].textContent.includes('failed: D:/library/bad.mp4 — processing failed'), '真实 state/reason 应显示且不得出现 undefined');
  await row.children[2].onclick();
  assert.strictEqual(submitted, 1);
  assert.strictEqual(context.Indexer.isRunning(), true, '任务历史重试必须接入同一 job 监视');
  await assert.rejects(() => context.Indexer.retry('failed-job', 'another-key'), /已有索引任务/);
  assert.strictEqual(submitted, 1, '已监视任务时不能重复提交重试');
  assert.strictEqual(SearchCache.stats().size, 0, '重试提交后不沿用旧缓存');
  assert.strictEqual(node('btn-search').disabled, true, '重试任务运行时搜索按钮禁用');
  SearchCache.set({ query: 'while retrying' }, [{ id: 2 }]);
  await scheduled.callback();
  assert.strictEqual(context.Indexer.isRunning(), false);
  assert.strictEqual(SearchCache.stats().size, 0, '失败终态也必须失效可能已部分写入的索引缓存');

  const terminalStates = [];
  for (const state of ['done', 'cancelled', 'interrupted', 'error']) {
    context.Api.indexStatus = async () => ({ state });
    await context.Indexer.retry('failed-job', 'key-' + state, { onTerminal: result => terminalStates.push(result.state) });
    await scheduled.callback();
    assert.strictEqual(context.Indexer.isRunning(), false);
  }
  context.Api.indexStatus = async () => { const error = new Error('missing job'); error.status = 404; throw error; };
  await context.Indexer.retry('failed-job', 'missing-key', { onTerminal: result => terminalStates.push(result.state) });
  await scheduled.callback();
  assert.deepStrictEqual(terminalStates, ['done', 'cancelled', 'interrupted', 'error', 'unknown'], '所有可能部分写入的终态统一通知');

  SearchCache.set({ query: 'old service' }, [{ id: 1 }]);
  context.hooks.setServiceStatus('starting', 'service changed');
  assert.strictEqual(SearchCache.stats().size, 0, '服务重连或重启立即失效缓存');

  await context.hooks.openScopeDialog();
  assert(!node('folder-tree').innerHTML.includes(malicious), '文件夹错误中的 HTML 不可注入');
  assert(node('folder-tree').innerHTML.includes('&lt;img'), '保留转义后的错误内容');
  await context.hooks.openStats();
  assert(!node('stats-body').innerHTML.includes(malicious), '统计错误中的 HTML 不可注入');
  assert(node('stats-body').innerHTML.includes('&lt;img'));
  console.log('index retry monitoring, terminal cache invalidation, service changes and escaped error regression passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
