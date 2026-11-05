/* 搜索前预览 AI 改写：取 /ai_search_plan，可编辑/删除/补充查询后作为 precomputed_plan 搜索。 */
const AiPlanReview = (() => {
  const { toast, h } = Dom;
  const MAX_QUERIES = 8;

  /* 确认返回计划；取消返回 undefined；获取失败返回 null（交回后端按常规流程自动改写）。 */
  async function review(query, cfg) {
    let plan;
    try { plan = await Api.aiSearchPlan(query, cfg); }
    catch (error) { toast(`AI 改写预览失败，将按常规流程搜索：${error.message}`, true, 5000); return null; }
    return new Promise((resolve) => {
      let result;
      const list = h('div', { className: 'ai-plan-list' });
      const addRow = (item = {}) => {
        const input = h('input', { type: 'text', value: item.text || '', spellcheck: false,
          attrs: { 'aria-label': '检索查询' }, placeholder: '输入一条检索查询' });
        const row = h('div', { className: 'ai-plan-row', dataset: { lang: item.lang || 'mixed', source: item.source || 'user' } },
          input,
          h('span', { className: 'hint', text: [item.lang, item.reason].filter(Boolean).join(' · ') || '手动添加', title: item.reason || '' }),
          h('button', { type: 'button', text: '×', title: '删除这条查询', onclick: () => row.remove() }));
        list.append(row);
        return input;
      };
      plan.queries.forEach(addRow);
      const error = h('p', { className: 'form-error', attrs: { role: 'status' } });
      const dialog = h('dialog', { className: 'warehouse-batch-dialog confirm-dialog ai-plan-dialog' },
        h('h3', { text: 'AI 改写预览' }),
        h('p', { className: 'hint', text: `原始描述：${query}。下列查询会分别检索后合并结果，最多 ${MAX_QUERIES} 条。` }),
        ...(plan.warnings || []).map((warning) => h('p', { className: 'hint', text: `提示：${warning}` })),
        list,
        h('button', { type: 'button', text: '＋ 添加查询', onclick: () => {
          if (list.children.length >= MAX_QUERIES) { error.textContent = `最多 ${MAX_QUERIES} 条查询`; return; }
          addRow().focus();
        } }),
        error,
        h('div', { className: 'dialog-actions' },
          h('button', { type: 'button', text: '取消', onclick: () => dialog.close() }),
          h('button', { type: 'button', className: 'primary', text: '按此计划搜索', onclick: () => {
            const queries = [...list.querySelectorAll('.ai-plan-row')].map((row, index) => ({
              id: `q${index + 1}`, text: row.querySelector('input').value.trim(),
              lang: row.dataset.lang, source: row.dataset.source, reason: '', weight: 1,
            })).filter((item) => item.text);
            if (!queries.length) { error.textContent = '至少保留一条查询'; return; }
            result = { ...plan, queries: queries.slice(0, MAX_QUERIES) };
            dialog.close();
          } })));
      dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
      document.body.appendChild(dialog);
      dialog.showModal();
      dialog.querySelector('.dialog-actions .primary').focus();
    });
  }

  return { review };
})();
