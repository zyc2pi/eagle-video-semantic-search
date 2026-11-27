const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function main() {
  const entries = [3, 1, 4].map((day) => ({ id: String(day), updatedAt: `2026-01-0${day}`, recipe: { day } }));
  let dateReads = 0;
  const videos = [[2, 'b'], [4, 'a'], [3, 'A'], [1, 'old']].map(([day, filePath]) => ({
    filePath, get importedAt() { dateReads++; return Date.parse(`2026-01-0${day}`); },
  }));
  const probes = [];
  const cache = new Map();
  const context = { require, AbortController, eagle: { library: { path: 'lib' } },
    console: { warn(message, error) { throw error; } },
    Config: { get: () => ({ autoCheckNew: true }) }, SearchRecipe: { normalize: (p) => p.toLowerCase() },
    Bridge: { collectLibraryVideos: async () => videos, refreshPathMap() {}, resolveLibraryIdentity: () => ({ id: 'lib' }) },
    Api: { listIndexes: () => [{ path: 'model', revision: 1 }] },
    Search: { isBusy: () => false, probe: (recipe, paths) => { probes.push([recipe.day, [...paths].sort()]); return { matches: [] }; } },
    ArchiveStore: { sceneLookup: () => () => undefined }, WarehouseNavigation: { refresh() {} },
    document: { addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: (key) => cache.get(key), setItem: (key, value) => cache.set(key, value) } };
  const source = fs.readFileSync(path.join(__dirname, '../js/warehouseUpdates.js'), 'utf8');
  const updates = vm.runInNewContext(source + '\nWarehouseUpdates;', context).create({
    canSearch: () => true, store: () => ({ list: () => ({ entries }), hydrateEntry() {} }),
  });
  await updates.autoCheckNewMaterials();
  assert.strictEqual(dateReads, videos.length);
  assert.deepStrictEqual(probes, [[3, ['a']], [1, ['a', 'b']]]);
  await updates.autoCheckNewMaterials();
  assert.strictEqual(probes.length, 2, '相同候选与索引复用此前检查');
  console.log('new material scan boundaries, deduplication and cache reuse passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
