const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { evaluate, compare, median, percentile } = require('../tools/evaluate-search');

function run(cases) { return evaluate({ schemaVersion: 1, cases }); }
function sample(extra = {}) { return { id: 'test', judgments: {}, results: null, latencyMs: null, ...extra }; }
const template = JSON.parse(fs.readFileSync(path.join(__dirname, '../tools/search-evaluation.template.json'), 'utf8'));
assert.strictEqual(template.cases.length, 30);
const baseline = evaluate(template);
assert.strictEqual(compare(template, template).precisionEligiblePairs, 0);
const fixed = sample({ library: 'test-library', query: '雨天', judgments: { a: true, b: false },
  results: [{ id: 'b' }], cachePhase: 'first-request', latencyMs: 100 });
const comparison = (overrides) => compare({ schemaVersion: 1, cases: [fixed] },
  { schemaVersion: 1, cases: [{ ...fixed, results: [{ id: 'a' }], latencyMs: 80, ...overrides }] });
assert.strictEqual(comparison({}).meanPrecisionAt10Delta, 0.1);
assert.strictEqual(comparison({}).latencyByPhase['first-request'].medianDeltaMs, -20);
assert.strictEqual(comparison({ cachePhase: 'cache' }).cases[0].latencyDeltaMs, null);
assert.strictEqual(comparison({ results: [{ id: 'unknown' }] }).precisionEligiblePairs, 0);
for (const changed of [{ query: '晴天' }, { library: 'other' }, { judgments: {} }, { scope: {} }, { id: 'other' }]) {
  assert.throws(() => comparison(changed), /不一致|缺少/);
}
assert.strictEqual(baseline.summary.runCases, 0);
assert.strictEqual(baseline.summary.meanPrecisionAt10, null);
assert.strictEqual(baseline.summary.meanLabeledSubsetRecall, null);
assert.strictEqual(baseline.summary.latencyMedianMs, null);
assert.strictEqual(median([9, 1, 3, 5]), 4);
assert.strictEqual(median([9, 1, 3]), 3);
assert.strictEqual(percentile([]), null);
assert.strictEqual(percentile(Array.from({ length: 20 }, (_, i) => i + 1)), 19);

const missing = run([sample({ results: [{ id: 'unknown' }], latencyMs: 0 })]);
assert.strictEqual(missing.cases[0].status, 'unjudged');
assert.strictEqual(missing.summary.meanPrecisionAt10, null);
assert.strictEqual(missing.summary.top10JudgmentCoverage, 0);
assert.strictEqual(missing.summary.latencyMaxMs, 0);
const mixed = run([sample({ judgments: { a: true, b: true, c: false }, results: [{ id: 'a' }, { id: 'x' }], latencyMs: 200 })]);
assert.strictEqual(mixed.summary.meanPrecisionAt10, null, '不能把未知标签当作负例');
assert.strictEqual(mixed.summary.top10JudgmentCoverage, 0.5);
assert.strictEqual(mixed.summary.meanLabeledSubsetRecall, 0.5);
const full = run([sample({ judgments: { a: true, b: true, c: false }, results: [{ id: 'a' }, { id: 'c' }], latencyMs: 300 }),
  sample({ id: 'empty', judgments: { b: true }, results: [], latencyMs: 100 })]);
assert.strictEqual(full.cases[0].precisionAt10, 0.1, '少于10条，分母仍固定10');
assert.strictEqual(full.cases[1].precisionAt10, 0);
assert.strictEqual(full.summary.meanPrecisionAt10, 0.05);
assert.strictEqual(full.summary.meanLabeledSubsetRecall, 0.25);
assert.strictEqual(full.summary.latencyMedianMs, 200);
assert.strictEqual(full.summary.latencyMaxMs, 300);
assert.strictEqual(run([sample({ results: [] })]).summary.meanPrecisionAt10, null, '空结果且未标注不能假装已评估');
assert.strictEqual(run([sample({ judgments: { a: false }, results: [] })]).summary.meanLabeledSubsetRecall, null);
const ranked = Array.from({ length: 11 }, (_, i) => ({ id: String(i) }));
const labels = Object.fromEntries(ranked.map((r, i) => [r.id, i === 10]));
assert.strictEqual(run([sample({ judgments: labels, results: ranked })]).cases[0].precisionAt10, 0);
assert.strictEqual(run([sample({ judgments: labels, results: ranked })]).cases[0].labeledSubsetRecall, 1);
for (const invalid of [sample({ latencyMs: -1 }), sample({ latencyMs: Infinity }),
  sample({ latencyMs: 1 }), sample({ judgments: { a: 'yes' } }), sample({ results: {} }),
  sample({ results: [{ id: 'a' }, { id: 'a' }] }), sample({ results: [{ id: '' }] })]) {
  assert.throws(() => run([invalid]));
}
assert.throws(() => run([sample(), sample()]));
assert.throws(() => evaluate({ cases: [] }));
const grouped = run([
  sample({ id: 'regular', kind: 'text', tags: ['中文'], variant: 'baseline', cachePhase: 'first-request',
    results: [{ id: 'a' }], judgments: { a: true }, latencyMs: 100, timings: { scoreMs: 20, queryCount: 1 } }),
  sample({ id: 'zero', kind: 'text', tags: ['零命中'], variant: 'dedup', cachePhase: 'repeated-request',
    results: [], judgments: { a: false }, latencyMs: 200, timings: { scoreMs: 30 } }),
  sample({ id: 'visual', kind: 'visual', tags: ['视觉'], results: [{ id: 'unknown' }], latencyMs: 300 }),
]);
assert.strictEqual(grouped.byTag['中文'].meanPrecisionAt10, 0.1, '质量按类型分开，不混入零命中');
assert.strictEqual(grouped.byKind.visual.meanPrecisionAt10, null, '未知标注仍不参与质量');
assert.strictEqual(grouped.byVariant.dedup.latencyMedianMs, 200);
assert.strictEqual(grouped.byCachePhase['first-request'].latencySampleCount, 1);
assert.strictEqual(grouped.summary.latencyP95Ms, 300);
assert.deepStrictEqual(grouped.summary.stageTimings.scoreMs, { samples: 2, medianMs: 25, p95Ms: 30 });
assert.strictEqual(grouped.summary.stageTimings.queryCount, undefined, '计数不混入耗时指标');
for (const timings of [{ scoreMs: -1 }, { scoreMs: NaN }, [], 'invalid']) {
  assert.throws(() => run([sample({ results: [], timings })]));
}
assert.throws(() => run([sample({ timings: {} })]), /未执行查询/);
console.log('offline evaluation metrics, missing judgments and validation tests passed');

// 通过搜索完成事件及标注入口检查记录归属，所有文件操作均在内存里。
const files = new Map();
const memoryFs = {
  readFileSync(file) {
    if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return files.get(file);
  },
  mkdirSync() {},
  writeFileSync(file, text) { files.set(file, text); },
  renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
};
const listeners = new Map();
const match = { eagleItemId: 'item', start_frame: 0, end_frame: 9 };
const firstSession = Symbol();
let session = firstSession;
const notices = [];
const recorder = require('vm').runInNewContext(
  fs.readFileSync(path.join(__dirname, '../js/evalRecorder.js'), 'utf8') + '\nEvalRecorder;',
  { process, require: (name) => name === 'fs' ? memoryFs : require(name),
    Config: { get: () => ({ evalMode: true }) },
    document: { addEventListener: (name, fn) => listeners.set(name, fn) },
    Dom: { $: () => ({ addEventListener() {}, classList: { toggle() {} } }), toast: (message) => notices.push(message) },
    Search: { getAllMatches: () => [match], getSelectedMatches: () => [match], getActiveMatch: () => match,
      getResultSession: () => session } });
recorder.init({ pluginPath: 'fixture' });
const complete = () => listeners.get('search-complete')({ detail: { recipe: { kind: 'text' }, latencyMs: 5 } });
complete();
const [file] = files.keys();
const original = files.get(file);
session = null;
recorder.judge(true, [match]);
assert.strictEqual(files.get(file), original, '打开主题不能向此前搜索写标注');
session = firstSession;
recorder.judge(true, [match]);
assert.strictEqual(JSON.parse(files.get(file)).cases[0].judgments['item:0:9'], true);
const incompatible = '{"schemaVersion":2,"cases":[]}';
files.set(file, incompatible);
session = Symbol();
complete();
assert.match(notices.at(-1), /不支持的评测文件格式/);
assert.strictEqual(files.get(file), incompatible);
console.log('evaluation session ownership and incompatible file preservation passed');
