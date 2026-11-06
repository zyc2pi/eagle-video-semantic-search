/* 当前预览片段的按需镜头分析；结果只在当前片段展示，确认后合并至 Eagle 素材标签。 */
const ShotAnalysis = (() => {
  const { $, h, toast } = Dom;
  let generation = 0;
  let canAnalyze = () => false;
  let pending = false;

  function updateButton() {
    $('btn-preview-analyze').disabled = pending || !canAnalyze() || Search.isBusy() || !Search.getActiveMatch();
  }

  async function analyze() {
    const match = Search.getActiveMatch();
    if (!match || pending || !canAnalyze() || Search.isBusy()) return;
    const token = ++generation;
    const library = eagle.library.path;
    const panel = $('shot-analysis');
    const current = () => token === generation && library === eagle.library.path && Search.getActiveMatch() === match;
    pending = true;
    document.dispatchEvent(new CustomEvent('shot-analysis-busy'));
    updateButton();
    panel.classList.remove('hidden');
    panel.replaceChildren(h('p', { className: 'hint', text: '正在分析运镜与景别…' }));
    try {
      const response = await Api.analyzeShot(match);
      if (!current()) return;
      if (!response.ok || !response.data?.success) throw new Error(response.data?.error || '镜头分析失败');
      const data = response.data;
      const rows = [];
      for (const [key, label] of [['motion', '运镜'], ['scale', '景别']]) {
        const result = data[key];
        if (!result) continue;
        const confidence = Number.isFinite(result.confidence) ? ` · 置信度 ${(result.confidence * 100).toFixed(0)}%` : '';
        rows.push(h('p', { text: `${label}：${result.label}${result.direction ? ` · ${result.direction}` : ''}${confidence}` }));
      }
      panel.replaceChildren(h('h3', { text: '当前片段分析' }), ...rows);
      if (data.notes?.length) panel.append(h('p', { className: 'hint', text: data.notes.join('；') }));
      const tags = Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === 'string') : [];
      if (tags.length) panel.append(h('button', { type: 'button', text: '确认添加到素材标签', onclick: async (event) => {
        const button = event.currentTarget;
        if (!current()) return;
        if (!await Dom.confirm({ title: '添加到素材标签', body: [`将 ${tags.join('、')} 添加到整个原素材的标签。分析范围为当前片段。`] })) return;
        if (!current()) return;
        button.disabled = true;
        let item;
        let previous;
        let saved = false;
        try {
          item = await eagle.item.getById(match.eagleItemId || Bridge.itemForPath(match.video_path)?.id);
          if (!current()) return;
          if (!item || item.isDeleted || Bridge.normalizePath(item.filePath) !== Bridge.normalizePath(match.video_path)) throw new Error('原素材已变化，请重新分析');
          previous = [...(item.tags || [])];
          item.tags = [...new Set([...(item.tags || []), ...tags])];
          await item.save();
          saved = true;
          if (library === eagle.library.path) {
            await Bridge.refreshPathMap(true);
            Search.refreshTags();
          }
          toast('已添加到素材标签');
        } catch (error) {
          if (!saved && item && previous) item.tags = previous;
          toast(error.message, true);
        }
        finally { if (current()) button.disabled = false; }
      } }));
    } catch (error) { if (current()) panel.replaceChildren(h('p', { className: 'form-error', text: error.message })); }
    finally { pending = false; document.dispatchEvent(new CustomEvent('shot-analysis-busy')); updateButton(); }
  }

  function init(options) {
    canAnalyze = options.canAnalyze;
    $('btn-preview-analyze').addEventListener('click', analyze);
    document.addEventListener('preview-change', () => {
      generation += 1;
      $('shot-analysis').classList.add('hidden');
      $('shot-analysis').replaceChildren();
      updateButton();
    });
    document.addEventListener('search-busy', updateButton);
    updateButton();
  }

  return { init, updateButton, isBusy: () => pending };
})();
