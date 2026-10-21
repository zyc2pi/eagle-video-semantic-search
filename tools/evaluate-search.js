#!/usr/bin/env node
'use strict';

const fs = require('fs');

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, fraction = 0.95) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(rows) {
  const scored = rows.filter((row) => row.precisionAt10 != null);
  const recall = rows.filter((row) => row.labeledSubsetRecall != null);
  const times = rows.map((row) => row.latencyMs).filter((value) => value != null);
  const topCount = rows.reduce((sum, row) => sum + (row.returnedTop10Count || 0), 0);
  const judgedCount = rows.reduce((sum, row) => sum + (row.judgedTop10Count || 0), 0);
  const stages = [...new Set(rows.flatMap((row) => Object.keys(row.timings || {})))];
  return {
    cases: rows.length,
    runCases: rows.filter((row) => row.status !== 'not_run').length,
    precisionEligibleCases: scored.length,
    meanPrecisionAt10: scored.length ? scored.reduce((sum, row) => sum + row.precisionAt10, 0) / scored.length : null,
    top10JudgmentCoverage: topCount ? judgedCount / topCount : null,
    recallEligibleCases: recall.length,
    meanLabeledSubsetRecall: recall.length ? recall.reduce((sum, row) => sum + row.labeledSubsetRecall, 0) / recall.length : null,
    latencySampleCount: times.length,
    latencyMedianMs: median(times),
    latencyP95Ms: percentile(times),
    latencyMaxMs: times.length ? times.reduce((max, value) => Math.max(max, value), 0) : null,
    stageTimings: Object.fromEntries(stages.map((stage) => {
      const values = rows.map((row) => row.timings?.[stage]).filter((value) => value != null);
      return [stage, { samples: values.length, medianMs: median(values), p95Ms: percentile(values) }];
    })),
  };
}

function evaluate(input) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.cases)) {
    throw new Error('需要 schemaVersion: 1 和 cases 数组');
  }
  const ids = new Set();
  const rows = input.cases.map((item) => {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) {
      throw new Error('case id 必须非空且唯一');
    }
    ids.add(item.id);
    const judgments = item.judgments;
    if (!judgments || typeof judgments !== 'object' || Array.isArray(judgments)
        || Object.entries(judgments).some(([id, value]) => !id || typeof value !== 'boolean')) {
      throw new Error(`${item.id}: judgments 必须是素材/片段 ID 到人工相关性布尔值的映射`);
    }
    if (item.latencyMs != null && (!Number.isFinite(item.latencyMs) || item.latencyMs < 0)) {
      throw new Error(`${item.id}: latencyMs 必须为非负有限数字或 null`);
    }
    const run = Array.isArray(item.results);
    if (!run && item.results != null) throw new Error(`${item.id}: results 必须为数组或 null`);
    if (!run && item.latencyMs != null) throw new Error(`${item.id}: 未执行查询不能填写耗时`);
    if (item.timings != null && (typeof item.timings !== 'object' || Array.isArray(item.timings)
        || Object.values(item.timings).some((value) => !Number.isFinite(value) || value < 0))) {
      throw new Error(`${item.id}: timings 必须为非负有限数字映射`);
    }
    if (!run && item.timings != null) throw new Error(`${item.id}: 未执行查询不能填写分阶段耗时`);
    const results = item.results || [];
    const resultIds = new Set();
    for (const result of results) {
      if (!result || typeof result.id !== 'string' || !result.id || resultIds.has(result.id)) {
        throw new Error(`${item.id}: 排名结果 id 必须非空且唯一；片段用稳定片段 ID`);
      }
      resultIds.add(result.id);
    }
    const hasLabel = (id) => Object.prototype.hasOwnProperty.call(judgments, id);
    const top = results.slice(0, 10);
    const labeledTop = top.filter((result) => hasLabel(result.id));
    const positiveIds = Object.keys(judgments).filter((id) => judgments[id]);
    const hasJudgments = Object.keys(judgments).length > 0;
    const precisionEligible = run && hasJudgments && labeledTop.length === top.length;
    const hits = top.filter((result) => hasLabel(result.id) && judgments[result.id]).length;
    return {
      id: item.id,
      status: !run ? 'not_run' : !hasJudgments ? 'unjudged'
        : !precisionEligible ? 'partially_judged' : 'judged',
      resultCount: run ? results.length : null,
      judgedTop10Count: run ? labeledTop.length : null,
      returnedTop10Count: run ? top.length : null,
      top10JudgmentCoverage: run && top.length ? labeledTop.length / top.length : null,
      precisionAt10: precisionEligible ? hits / 10 : null,
      // This denominator is the human-labeled pool, never the whole library.
      labeledSubsetRecall: run && positiveIds.length
        ? positiveIds.filter((id) => resultIds.has(id)).length / positiveIds.length : null,
      relevantJudgmentCount: positiveIds.length,
      latencyMs: run ? item.latencyMs ?? null : null,
      kind: item.kind || 'text',
      tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string') : [],
      variant: item.variant || 'baseline',
      cachePhase: item.cachePhase || 'unspecified',
      timings: run ? Object.fromEntries(Object.entries(item.timings || {}).filter(([key]) => key.endsWith('Ms'))) : {},
    };
  });
  const groupBy = (valuesForRow) => {
    const groups = new Map();
    rows.forEach((row) => valuesForRow(row).forEach((key) => {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }));
    return Object.fromEntries([...groups].map(([key, members]) => [key, summarize(members)]));
  };
  return {
    schemaVersion: 1,
    warning: '只衡量离线人工标注池；未知标签不当作不相关，子集召回不代表整库召回。未执行或未标注项不计入质量均值。',
    summary: summarize(rows),
    byKind: groupBy((row) => [row.kind]),
    byTag: groupBy((row) => row.tags),
    byVariant: groupBy((row) => [row.variant]),
    byCachePhase: groupBy((row) => [row.cachePhase]),
    cases: rows,
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('用法：node tools/evaluate-search.js <离线评估.json>');
    const result = evaluate(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { evaluate, median, percentile };
