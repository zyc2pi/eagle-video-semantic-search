const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { evaluate, median, percentile } = require('../tools/evaluate-search');

function run(cases) { return evaluate({ schemaVersion: 1, cases }); }
function sample(extra = {}) { return { id: 'test', judgments: {}, results: null, latencyMs: null, ...extra }; }
const template = JSON.parse(fs.readFileSync(path.join(__dirname, '../tools/search-evaluation.template.json'), 'utf8'));
assert.strictEqual(template.cases.length, 30);
const baseline = evaluate(template);
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
