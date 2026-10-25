const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let revision = 'version-1';
let service = 'http://127.0.0.1:5006';
let requests = 0;
const context = {
  require, console,
  Config: { get: () => ({ modelName: 'model' }), baseUrl: () => service },
  eagle: { library: { path: 'library' } },
  Bridge: { resolveLibraryIdentity: async () => ({ id: 'id', index_name: 'library' }),
    refreshPathMap: async () => new Map(), normalizePath: (value) => value },
  SearchRecipe: { normalize: (value) => value },
  Api: {
    listIndexes: async () => [{ name: 'library_model.lance', model: 'model', path: 'same-index', revision }],
    search: async (_query, indexes) => {
      assert.deepStrictEqual(Array.from(indexes), ['same-index']);
      requests++;
      return { ok: true, data: { success: true, matches: [{ version: revision, service, request: requests }] } };
    },
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/searchCache.js'), 'utf8'), context);
const source = fs.readFileSync(path.join(__dirname, '../js/search.js'), 'utf8')
  .replace('  return {\n    bindDom,', '  this.requestRecipe = requestRecipe;\n  return {\n    bindDom,');
vm.runInContext(source + '\nthis.Search = Search;', context);
const recipe = { kind: 'text', query: 'same query', library: 'library', config: { modelName: 'model', threshold: 11 } };
const execute = () => context.requestRecipe(recipe, { paths: null });

async function main() {
  assert.deepStrictEqual(Array.from(await context.Search.findLibraryIndexes()), ['same-index'], '公共索引查询仍返回路径数组');
  const first = await execute();
  assert.strictEqual(first.data.matches[0].version, 'version-1');
  assert.strictEqual((await execute()).data.matches[0].request, 1);
  assert.strictEqual(requests, 1, '相同版本同查询命中缓存');
  revision = 'version-2';
  assert.strictEqual((await execute()).data.matches[0].version, 'version-2', '同路径外部更新后的查询不得使用旧缓存');
  assert.strictEqual(requests, 2);
  service = 'http://127.0.0.1:5999';
  assert.strictEqual((await execute()).data.matches[0].service, service, '切换服务不共享缓存');
  assert.strictEqual(requests, 3);
  revision = null;
  await execute();
  await execute();
  assert.strictEqual(requests, 5, '旧服务无revision可搜索且不持久复用未知索引缓存');
  revision = 'version-3';
  recipe.query = '眨眼';
  await execute();
  await execute();
  assert.strictEqual(requests, 6, '移除专项核验后，动作词复用普通搜索缓存');
  console.log('search index revision and service cache regression passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
