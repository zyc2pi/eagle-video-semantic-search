/* 评测记录与性能自检。
   评测记录模式：每次搜索完成后把查询、排名结果（片段 ID）、往返耗时与服务端分阶段耗时写入
   插件目录 evaluation/<日期>.json，格式与 tools/evaluate-search.js 一致（schemaVersion 1）；
   用户在结果中选中片段后标“相关/不相关”，写入当前 case 的 judgments。只记录，不改变搜索。
   性能自检：在真实库上测量素材清单、路径映射、仓库清单和同一查询冷/热两次搜索的耗时。 */
const EvalRecorder = (() => {
  const { $, toast, h } = Dom;
  const fs = require('fs');
  const path = require('path');
  const MAX_RESULTS = 100;
  let dir = null;
  let current = null; // 最近一次搜索对应的 case id

  const today = () => new Date().toISOString().slice(0, 10);
  const fileFor = (date = today()) => path.join(dir, `${date}.json`);
  const enabled = () => !!Config.get().evalMode;

  function sceneId(match) {
    const id = match.eagleItemId || Bridge.itemForPath(match.video_path)?.id || match.video_path;
    return `${id}:${match.original_start_frame ?? match.start_frame}:${match.original_end_frame ?? match.end_frame}`;
  }

  function uniqueResults(matches) {
    const seen = new Set();
    const results = [];
    for (const match of matches) {
      const id = sceneId(match);
      if (seen.has(id)) continue;
      seen.add(id);
      results.push({ id, score: match.similarity });
      if (results.length >= MAX_RESULTS) break;
    }
    return results;
  }

  function read(file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.schemaVersion === 1 && Array.isArray(data.cases)) return data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`评测文件无法读取：${error.message}`);
    }
    return { schemaVersion: 1, notes: '由插件评测记录模式生成；judgments 为人工标注，未标注项不计入质量指标。', cases: [] };
  }

  function write(file, data) {
    fs.mkdirSync(dir, { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  }

  function variantOf(recipe) {
    const config = recipe.config || {};
    return [config.modelName, recipe.kind, config.aiEnhance ? `ai-${config.aiMode || 'balanced'}${config.aiExpand ? '+expand' : ''}` : 'no-ai']
      .filter(Boolean).join(' / ');
  }

  function onSearchComplete(event) {
    if (!enabled() || !dir) return;
    const { recipe, latencyMs, fromCache, timings } = event.detail;
    try {
      const file = fileFor();
      const data = read(file);
      const caseId = `${today()}-${String(data.cases.length + 1).padStart(3, '0')}`;
      const numericTimings = Object.fromEntries(Object.entries(timings || {})
        .filter(([, value]) => Number.isFinite(value) && value >= 0));
      data.cases.push({
        id: caseId, kind: recipe.kind, query: recipe.query, tags: [recipe.kind],
        variant: variantOf(recipe), cachePhase: fromCache ? 'cache' : 'service',
        library: recipe.library, recordedAt: new Date().toISOString(),
        results: uniqueResults(Search.getAllMatches()),
        latencyMs: Math.round(latencyMs * 10) / 10,
        ...(Object.keys(numericTimings).length ? { timings: numericTimings } : {}),
        judgments: {},
      });
      write(file, data);
      current = { file, caseId };
      updateButtons();
    } catch (error) {
      toast(`评测记录写入失败：${error.message}`, true, 5000);
    }
  }

  function judge(relevant) {
    try {
      if (!current) throw new Error('当前结果不是在评测记录模式下搜索得到的');
      const matches = Search.getSelectedMatches() || [];
      if (!matches.length) throw new Error('请先选中要标注的片段');
      const data = read(current.file);
      const item = data.cases.find((value) => value.id === current.caseId);
      if (!item) throw new Error('评测记录已被移除');
      matches.forEach((match) => { item.judgments[sceneId(match)] = relevant; });
      write(current.file, data);
      const labeled = Object.keys(item.judgments).length;
      toast(`已标注 ${matches.length} 个为${relevant ? '相关' : '不相关'}（本次查询共标注 ${labeled} 个）`);
      Search.clearSelection();
    } catch (error) {
      toast(`标注失败：${error.message}`, true, 5000);
    }
  }

  function summarize() {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort() : [];
    if (!files.length) throw new Error('还没有评测记录；在设置中开启“评测记录模式”后搜索并标注');
    const { evaluate } = require(path.join(dir, '..', 'tools', 'evaluate-search.js'));
    const cases = files.flatMap((name) => read(path.join(dir, name)).cases);
    return { files, report: evaluate({ schemaVersion: 1, cases }) };
  }

  function fmt(value, digits = 2) {
    return value == null ? '—' : typeof value === 'number' ? String(Math.round(value * 10 ** digits) / 10 ** digits) : String(value);
  }

  function showDialog(title, nodes, copyText) {
    const dialog = h('dialog', { className: 'index-admin-dialog' },
      h('div', { className: 'settings-form stats-form' },
        h('h3', { text: title }), h('div', { className: 'stats-body' }, ...nodes),
        h('div', { className: 'dialog-actions' },
          copyText ? h('button', { type: 'button', text: '复制 JSON', onclick: async () => {
            try { await navigator.clipboard.writeText(copyText); toast('已复制'); } catch { toast('复制失败', true); }
          } }) : null,
          h('button', { type: 'button', text: '打开评测目录', onclick: () => {
            fs.mkdirSync(dir, { recursive: true }); eagle.shell.openPath(dir);
          } }),
          h('button', { type: 'button', className: 'primary', text: '关闭', onclick: () => dialog.close() }))));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
  }

  function openSummary() {
    try {
      const { files, report } = summarize();
      const o = report.summary;
      const rows = [
        ['评测文件', files.join('、')],
        ['查询数 / 已执行', `${o.cases} / ${o.runCases}`],
        ['P@10（前 10 已全部标注）', `${fmt(o.meanPrecisionAt10)}（${o.precisionEligibleCases} 项）`],
        ['标注子集召回', `${fmt(o.meanLabeledSubsetRecall)}（${o.recallEligibleCases} 项）`],
        ['前 10 标注覆盖率', fmt(o.top10JudgmentCoverage)],
        ['耗时中位 / P95 / 最大 (ms)', `${fmt(o.latencyMedianMs, 0)} / ${fmt(o.latencyP95Ms, 0)} / ${fmt(o.latencyMaxMs, 0)}`],
      ];
      showDialog('评测汇总', [
        h('p', { className: 'hint', text: '指标口径见 EVALUATION.md：未标注的返回项不当作负例；覆盖率低或各组查询不同，不能据此比较模型。' }),
        ...rows.map(([label, value]) => h('div', { className: 'archive-row' },
          h('span', { className: 'archive-name', text: label }), h('b', { text: value }))),
      ], JSON.stringify(report, null, 2));
    } catch (error) {
      toast(error.message, true, 6000);
    }
  }

  /* 性能自检：只读；搜索使用固定查询词，第二次通常命中插件结果缓存。 */
  async function runBenchmark(isServiceOnline) {
    const steps = [];
    const time = async (label, fn) => {
      const started = performance.now();
      const value = await fn();
      steps.push({ label, ms: performance.now() - started, value });
      return value;
    };
    const body = [h('p', { className: 'hint', text: '正在测量…' })];
    try {
      const videos = await time('读取素材清单', () => Bridge.collectLibraryVideos(true));
      steps.at(-1).note = `${videos.length} 个视频`;
      await time('刷新路径映射', () => Bridge.refreshPathMap(false, videos));
      const archive = await time('读取仓库清单', () => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list());
      steps.at(-1).note = `${archive.entries.length} 个主题`;
      if (isServiceOnline() && !Search.isBusy()) {
        const indexes = await time('查询当前库索引', () => Search.findLibraryIndexes());
        steps.at(-1).note = `${indexes.length} 个索引`;
        const cfg = Config.get();
        for (const phase of ['首次', '再次']) {
          const response = await time(`文本搜索（${phase}）`, () => Api.search('人物 特写', indexes, cfg.threshold, null, cfg));
          const timings = response.data?.timings || {};
          steps.at(-1).note = `${response.data?.matches?.length ?? '?'} 条` + (timings.totalMs != null
            ? `；服务端 ${Math.round(timings.totalMs)}ms（编码 ${Math.round(timings.encodeMs || 0)} / 读索引 ${Math.round(timings.indexLoadMs || 0)} / 打分 ${Math.round(timings.scoreMs || 0)}）` : '');
        }
      } else {
        steps.push({ label: '文本搜索', ms: null, note: '服务未连接或正在搜索，已跳过' });
      }
    } catch (error) {
      steps.push({ label: '中断', ms: null, note: error.message });
    }
    const report = { measuredAt: new Date().toISOString(), library: eagle.library.path,
      steps: steps.map(({ label, ms, note }) => ({ label, ms: ms == null ? null : Math.round(ms), note: note || '' })) };
    showDialog('性能自检', [
      h('p', { className: 'hint', text: '在当前真实素材库上只读测量；搜索使用固定词“人物 特写”且不使用插件结果缓存。第二次搜索可反映服务端模型与索引已在内存时的耗时。' }),
      ...report.steps.map((step) => h('div', { className: 'archive-row' },
        h('span', { className: 'archive-name', text: `${step.label}${step.note ? ` · ${step.note}` : ''}`, title: step.note }),
        h('b', { text: step.ms == null ? '—' : `${step.ms} ms` }))),
    ], JSON.stringify(report, null, 2));
    return report;
  }

  function updateButtons() {
    const on = enabled();
    ['btn-eval-relevant', 'btn-eval-irrelevant'].forEach((id) => {
      $(id).classList.toggle('hidden', !on);
      $(id).disabled = !current || !(Search.getSelectedMatches()?.length);
    });
  }

  function init({ pluginPath, isServiceOnline }) {
    dir = path.join(pluginPath, 'evaluation');
    document.addEventListener('search-complete', onSearchComplete);
    document.addEventListener('search-selection', updateButtons);
    $('btn-eval-relevant').addEventListener('click', () => judge(true));
    $('btn-eval-irrelevant').addEventListener('click', () => judge(false));
    $('btn-eval-summary').addEventListener('click', openSummary);
    $('btn-perf-check').addEventListener('click', () => runBenchmark(isServiceOnline));
    updateButtons();
  }

  return { init, updateButtons, judge, openSummary, runBenchmark, sceneId };
})();
