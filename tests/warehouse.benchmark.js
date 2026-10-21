/* Synthetic storage baseline only; does not read real libraries or claim UI timing. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-warehouse-bench-'));
const context = { require };
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../js/archiveStore.js'), 'utf8')}\nthis.archive = ArchiveStore;`, context);
try {
  for (const images of [false, true]) for (const count of [100, 500]) {
    const library = `D:/synthetic-${count}-${images}.library`;
    const file = path.join(root, 'warehouse', `${crypto.createHash('sha256').update(library.replace(/\//g, '\\').toLowerCase()).digest('hex').slice(0, 24)}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = { version: 1, library, imported: [], categories: [], entries: Array.from({ length: count }, (_, i) => ({
      id: String(i), name: `主题 ${i}`, categoryId: '', view: { minDur: 0, grouped: false, sortBy: 'sim' },
      recipe: images ? { query: `query-${i}`, payload: { image_base64: 'a'.repeat(128 * 1024) } } : null,
      ...(images ? { cover: { dataUrl: `data:image/jpeg;base64,${'b'.repeat(32 * 1024)}`, frame: i } } : {}),
      matches: Array.from({ length: 100 }, (_, j) => ({ video_path: `D:/fixture/${j}.mp4`, start_frame: j * 50, end_frame: j * 50 + 40 })),
    })) };
    fs.writeFileSync(file, JSON.stringify(data));
    const store = context.archive.open(root, library);
    const times = [];
    for (let i = 0; i < 5; i++) { const start = performance.now(); store.list(); times.push(performance.now() - start); }
    times.sort((a, b) => a - b);
    const legacyBytes = fs.statSync(file).size;
    const migrationStart = performance.now(); store.category('add', '', 'benchmark');
    const migrationMs = performance.now() - migrationStart;
    const optimized = [];
    for (let i = 0; i < 5; i++) { const start = performance.now(); store.list(); optimized.push(performance.now() - start); }
    optimized.sort((a, b) => a - b);
    const writeTimes = [];
    for (let i = 0; i < 5; i++) { const start = performance.now(); store.category('add', '', `benchmark-${i}`); writeTimes.push(performance.now() - start); }
    writeTimes.sort((a, b) => a - b);
    const categoryId = store.list().categories[0].id;
    const sampleEntries = store.list().entries.slice(0, 20);
    const individualStart = performance.now();
    for (const entry of sampleEntries) store.setCategory(entry.id, categoryId, entry.updatedAt, entry.revision);
    const individualCategoryMs = performance.now() - individualStart;
    const requests = store.list().entries.slice(0, 20).map((entry) => ({ id: entry.id, updatedAt: entry.updatedAt, revision: entry.revision }));
    const batchStart = performance.now();
    const batch = store.setCategories(requests, '');
    const batchCategoryMs = performance.now() - batchStart;
    if (!batch.results.every((result) => result.ok)) throw new Error('Synthetic batch failed');
    console.log(JSON.stringify({ themes: count, matchesPerTheme: 100, imageBytesPerTheme: images ? 160 * 1024 : 0,
      legacyBytes, manifestBytes: fs.statSync(file).size, iterations: 5,
      legacyMedianReadMs: +times[2].toFixed(2), legacyMaxReadMs: +times[4].toFixed(2),
      manifestMedianReadMs: +optimized[2].toFixed(2), manifestMaxReadMs: +optimized[4].toFixed(2),
      medianMetadataWriteMs: +writeTimes[2].toFixed(2), maxMetadataWriteMs: +writeTimes[4].toFixed(2),
      categoryBatchSize: sampleEntries.length,
      individualCategoryMs: +individualCategoryMs.toFixed(2), batchCategoryMs: +batchCategoryMs.toFixed(2),
      migrationMs: +migrationMs.toFixed(2),
      note: 'synthetic warm filesystem, shared fixture matches; timings exclude DOM and real-library IO; first-write legacy migration remains synchronous' }));
  }
} finally {
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('eagle-warehouse-bench-')) fs.rmSync(root, { recursive: true, force: true });
}
