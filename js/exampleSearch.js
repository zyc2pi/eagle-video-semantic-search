/* 组合检索入口：正负样本反馈（找更像所选 / 排除所选这类）与时序组合查询（A → B）。
   检索本身在 Search.runFeedback / runSequence；本模块只负责收集条件与界面状态。 */
const ExampleSearch = (() => {
  const { $, toast, h } = Dom;
  const MAX_EXAMPLES = 50;
  const SEQUENCE_SPLIT = /\s*(?:→|>>)\s*/;
  let hooks = {
    isServiceOnline: () => false,
    resolveScope: async () => { throw new Error('搜索范围未初始化'); },
    closeMenus: () => {},
    afterSearch: () => {},
  };

  const exampleKey = (example) => `${Bridge.normalizePath(example.video_path)}#${example.start_frame}`;

  function mergeExamples(base, extra, exclude = []) {
    const seen = new Set(exclude.map(exampleKey));
    const result = [];
    [...base, ...extra].forEach((example) => {
      const key = exampleKey(example);
      if (seen.has(key)) return;
      seen.add(key);
      result.push(example);
    });
    return result;
  }

  function feedbackLabel(examples) {
    return `更像 ${examples.positives.length} 个片段`
      + (examples.negatives.length ? `，排除 ${examples.negatives.length} 个` : '');
  }

  function report(result) {
    if (result.cancelled || result.stale) return;
    if (!result.ok) { toast(result.message, true, 5000); return; }
    toast(result.count ? `找到 ${result.count} 个匹配场景` : '没有匹配结果，可调整样例或筛选条件');
    hooks.afterSearch();
  }

  /* mode: new = 以所选为正例重新开始；more = 追加正例；less = 追加负例（后两者需当前为反馈结果）。 */
  async function feedback(mode) {
    hooks.closeMenus();
    try {
      if (!hooks.isServiceOnline() || Search.isBusy()) throw new Error('搜索服务未就绪或正在处理其他任务');
      const selected = (Search.getSelectedMatches() || []).map(Search.exampleFromMatch);
      if (!selected.length) throw new Error('请先选中片段');
      const recipe = Search.getRecipe();
      const previous = mode !== 'new' && recipe?.kind === 'feedback' ? recipe.payload.feedback
        : { positives: [], negatives: [], negativeWeight: 0.5 };
      const examples = { ...previous,
        positives: mode === 'less' ? previous.positives : mergeExamples(previous.positives, selected),
        negatives: mode === 'less' ? mergeExamples(previous.negatives, selected, previous.positives) : previous.negatives };
      if (mode === 'more') examples.negatives = examples.negatives.filter((n) => !selected.some((s) => exampleKey(s) === exampleKey(n)));
      if (examples.positives.length > MAX_EXAMPLES || examples.negatives.length > MAX_EXAMPLES) {
        throw new Error(`正例、负例各最多 ${MAX_EXAMPLES} 个片段，请减少选择`);
      }
      const context = await hooks.resolveScope();
      report(await Search.runFeedback(examples, context, feedbackLabel(examples)));
    } catch (error) {
      toast(`反馈搜索失败：${error.message}`, true, 5000);
    }
  }

  function parseSequence(text) {
    if (!SEQUENCE_SPLIT.test(text)) return null;
    const steps = String(text).split(SEQUENCE_SPLIT).map((step) => step.trim()).filter(Boolean);
    return steps;
  }

  async function sequence(steps, maxGap, threshold) {
    if (steps.length < 2 || steps.length > 4) throw new Error('时序搜索需要 2～4 个步骤，用 → 或 >> 分隔');
    if (!Number.isFinite(maxGap) || maxGap < 0 || maxGap > 120) throw new Error('步骤间隔应为 0～120 秒');
    if (!hooks.isServiceOnline() || Search.isBusy()) throw new Error('搜索服务未就绪或正在处理其他任务');
    const context = await hooks.resolveScope();
    return Search.runSequence({ steps, maxGap }, context, threshold);
  }

  function openSequenceDialog(initialSteps = []) {
    const steps = h('div', { className: 'ai-plan-list' });
    const addStep = (value = '') => {
      const input = h('input', { type: 'text', value, placeholder: `第 ${steps.children.length + 1} 步画面描述`,
        attrs: { 'aria-label': '时序步骤' } });
      steps.append(h('div', { className: 'ai-plan-row' }, input,
        h('button', { type: 'button', text: '×', title: '删除此步骤', onclick: (event) => event.target.closest('.ai-plan-row').remove() })));
      return input;
    };
    (initialSteps.length ? initialSteps : ['', '']).forEach((value) => addStep(value));
    const gap = h('input', { type: 'number', min: 0, max: 120, step: 0.5, value: Config.get().sequenceMaxGap ?? 5 });
    const error = h('p', { className: 'form-error', attrs: { role: 'status' } });
    const dialog = h('dialog', { className: 'warehouse-batch-dialog confirm-dialog ai-plan-dialog' },
      h('h3', { text: '时序搜索' }),
      h('p', { className: 'hint', text: '在同一视频内按顺序查找：后一步的镜头在前一步镜头之后开始，且与前一步结尾的间隔不超过设定秒数。每一步都按当前阈值过滤。也可以直接在搜索框输入「开门 → 走进房间」。' }),
      steps,
      h('div', { className: 'sequence-options' },
        h('button', { type: 'button', text: '＋ 添加步骤', onclick: () => {
          if (steps.children.length >= 4) { error.textContent = '最多 4 个步骤'; return; }
          addStep().focus();
        } }),
        h('label', {}, '相邻步骤最大间隔（秒）', gap)),
      error,
      h('div', { className: 'dialog-actions' },
        h('button', { type: 'button', text: '取消', onclick: () => dialog.close() }),
        h('button', { type: 'button', className: 'primary', text: '搜索', onclick: async () => {
          const values = [...steps.querySelectorAll('input')].map((input) => input.value.trim()).filter(Boolean);
          const maxGap = Number(gap.value);
          try {
            if (values.length < 2) throw new Error('至少填写 2 个步骤');
            if (!gap.validity.valid || gap.value === '') throw new Error('请输入 0～120 的间隔秒数');
            dialog.close();
            Config.save({ sequenceMaxGap: maxGap });
            $('query').value = values.join(' → ');
            report(await sequence(values, maxGap, Number($('threshold').value)));
          } catch (err) {
            if (dialog.open) error.textContent = err.message;
            else toast(`时序搜索失败：${err.message}`, true, 5000);
          }
        } })));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
    steps.querySelector('input').focus();
  }

  function updateButtons() {
    const selected = Search.getSelectedMatches()?.length || 0;
    const feedbackActive = Search.getRecipe()?.kind === 'feedback';
    const disabled = !hooks.isServiceOnline() || Search.isBusy() || !selected;
    $('btn-selection-similar').disabled = disabled;
    ['btn-selection-more', 'btn-selection-less'].forEach((id) => {
      $(id).classList.toggle('hidden', !feedbackActive);
      $(id).disabled = disabled;
    });
  }

  function init(options) {
    hooks = { ...hooks, ...options };
    $('btn-selection-similar').addEventListener('click', () => feedback('new'));
    $('btn-selection-more').addEventListener('click', () => feedback('more'));
    $('btn-selection-less').addEventListener('click', () => feedback('less'));
    $('btn-sequence-search').addEventListener('click', () => openSequenceDialog(parseSequence($('query').value.trim()) || []));
  }

  return { init, updateButtons, parseSequence, sequence, report, openSequenceDialog, mergeExamples };
})();
