/* 人工收录：评分属于目标主题，来源分数不自动沿用。 */
const SceneScores = (() => {
  const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  function adjust(value, direction, coarse = false) {
    const base = valid(value) ? value : 0;
    const adjusted = Math.round((base + direction * (coarse ? 1 : 0.1)) * 10) / 10;
    return Number.isFinite(adjusted) ? Math.max(0, adjusted) : base;
  }
  function references(matches) {
    const sorted = matches.filter((match) => valid(match.similarity)).slice()
      .sort((a, b) => b.similarity - a.similarity);
    if (!sorted.length) return [];
    const positions = [[0, '高分'], [Math.floor((sorted.length - 1) / 2), '中间'], [sorted.length - 1, '低分']];
    const seen = new Set();
    return positions.filter(([index]) => { if (seen.has(index)) return false; seen.add(index); return true; })
      .map(([index, label]) => ({ label, match: sorted[index] }));
  }
  function nextUnscored(scores, index) {
    for (let offset = 1; offset <= scores.length; offset += 1) {
      const candidate = (index + offset) % scores.length;
      if (!valid(scores[candidate].value)) return candidate;
    }
    return -1;
  }
  return { valid, adjust, references, nextUnscored };
})();

const ManualAdd = (() => {
  const $ = (id) => document.getElementById(id);
  let hooks;
  let session = null;
  let sourceVersion = 0;
  let targetGeneration = 0;
  let committing = false;
  const OVERVIEW_SIZE = 60;
  const recentTargets = new Map();
  const recentKey = (library) => `eagle-semantic-recent-target:${String(library).replace(/\//g, '\\').toLowerCase()}`;
  function recentTarget(library, id) {
    const key = recentKey(library);
    if (id !== undefined) {
      recentTargets.set(key, id);
      try { localStorage.setItem(key, id); } catch { /* 会话内仍记住目标。 */ }
      return id;
    }
    try { return recentTargets.get(key) || localStorage.getItem(key) || ''; }
    catch { return recentTargets.get(key) || ''; }
  }
  const store = () => ArchiveStore.open(Config.pluginPath(), eagle.library.path);
  const emptyScore = () => ({ value: null, text: '', mode: 'custom' });
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }
  function status(message = '', error = false) {
    $('manual-add-status').textContent = message;
    $('manual-add-status').dataset.error = String(error);
  }
  function guard() {
    hooks.checkIdle();
    if (!session || session.library !== eagle.library.path || session.sourceVersion !== sourceVersion) {
      throw new Error('来源搜索或素材库已改变，请关闭后重新选择片段');
    }
    hooks.validateSource();
  }
  function keepExisting(index) {
    return !session?.editing && $('manual-add-existing-mode').value === 'keep' && !!session?.existing?.[index];
  }
  function ready(index) {
    return keepExisting(index) || SceneScores.valid(session.scores[index].value);
  }
  function inspectTarget() {
    const target = session.target;
    const existing = target?.matches || [];
    const removed = (target?.removedMatches || []).map((record) => record.match);
    const findExisting = ArchiveStore.sceneLookup(existing);
    const findRemoved = ArchiveStore.sceneLookup(removed);
    session.existing = session.matches.map((match) => existing[findExisting(match)] || null);
    session.restoring = session.matches.map((match, index) => !session.existing[index] && findRemoved(match) !== undefined);
    const duplicates = session.existing.filter(Boolean).length;
    const restored = session.restoring.filter(Boolean).length;
    $('manual-add-impact').textContent = target
      ? `新增 ${session.matches.length - duplicates - restored} · 已收录 ${duplicates} · 重新加入 ${restored}` : '';
  }
  function sync() {
    const filled = session?.scores.filter((_, index) => ready(index)).length || 0;
    $('manual-add-progress').textContent = session ? `已就绪 ${filled} / ${session.matches.length} 个片段` : '';
    $('manual-add-submit').disabled = committing || !session?.target || filled !== session.matches.length;
    const canTop = SceneScores.valid(session?.highest);
    $('manual-add-top').disabled = !canTop || keepExisting(session?.index);
    $('manual-add-score').disabled = !!session && keepExisting(session.index);
    $('manual-add-bulk-top').disabled = !canTop;
    $('manual-add-prev').disabled = !session || session.index === 0;
    $('manual-add-next').disabled = !session || session.index === session.matches.length - 1;
    $('manual-add-next-empty').disabled = !session || filled === session.matches.length;
    const onlyEmpty = $('manual-add-only-empty').checked;
    $('manual-add-bulk-apply').textContent = onlyEmpty ? '填写未评分' : '覆盖全部分数';
    $('manual-add-bulk-top').textContent = onlyEmpty ? '未评分设为置顶' : '全部设为置顶';
    renderOverview();
  }
  function renderOverview() {
    const list = $('manual-add-overview');
    list.replaceChildren();
    if (!session) return;
    const start = session.overviewPage * OVERVIEW_SIZE;
    const end = Math.min(start + OVERVIEW_SIZE, session.matches.length);
    for (let index = start; index < end; index += 1) {
      const match = session.matches[index];
      const score = session.scores[index];
      const filled = ready(index);
      const button = node('button', 'manual-add-overview-item');
      button.type = 'button';
      button.dataset.index = String(index);
      button.dataset.filled = String(filled);
      button.setAttribute('aria-pressed', String(index === session.index));
      button.title = `${match.video_name || match.video_path} · ${frameTime(match)} – ${frameTime(match, true)}`;
      button.append(node('span', 'manual-add-overview-name', `${index + 1}. ${match.video_name || match.video_path}`),
        node('small', '', `${frameTime(match)} – ${frameTime(match, true)}`),
        node('b', 'manual-add-overview-value', keepExisting(index)
          ? `保留原分 · ${session.existing[index].similarity ?? '未知'}`
          : filled ? `${score.text} 分${score.mode === 'top' ? ' · 固定置顶' : ''}` : '未评分'));
      button.addEventListener('click', () => { session.index = index; renderActive(); $('manual-add-score').focus(); });
      list.append(button);
    }
    $('manual-add-overview-range').textContent = `${start + 1}–${end} / ${session.matches.length}`;
    $('manual-add-overview-prev').disabled = start === 0;
    $('manual-add-overview-next').disabled = end === session.matches.length;
  }
  function frameTime(match, end = false) {
    const frame = end ? (match.original_end_frame ?? match.end_frame) : (match.original_start_frame ?? match.start_frame);
    const fps = Number(match.fps) > 0 ? Number(match.fps) : 25;
    const ms = Math.max(0, Math.round((Number(frame) || 0) / fps * 1000));
    const seconds = Math.floor(ms / 1000);
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map((part) => String(part).padStart(2, '0')).join(':') + `.${String(ms % 1000).padStart(3, '0')}`;
  }
  function thumbnail(match) {
    const item = Bridge.itemForPath(match.video_path);
    const box = node('span', 'manual-add-thumb');
    const image = node('img'); image.alt = '';
    image.addEventListener('load', () => image.classList.add('ready'));
    box.append(image);
    const fallback = () => {
      if (item?.thumbnailURL) Search.loadThumbnail(image, item.thumbnailURL, () => image.remove());
      else image.remove();
    };
    Search.loadThumbnail(image, Api.previewUrl(item?.filePath || match.video_path,
      match.original_start_frame ?? match.start_frame ?? 0), fallback);
    return box;
  }
  function renderActive() {
    if (!session) return;
    const match = session.matches[session.index];
    const score = session.scores[session.index];
    $('manual-add-position').textContent = `${session.index + 1} / ${session.matches.length}`;
    $('manual-add-scene-name').textContent = match.video_name || match.video_path;
    $('manual-add-scene-name').title = match.video_path;
    $('manual-add-scene-time').textContent = `${frameTime(match)} – ${frameTime(match, true)}`;
    $('manual-add-scene-image').replaceChildren(thumbnail(match));
    $('manual-add-score').value = score.text;
    const existing = session.existing?.[session.index];
    $('manual-add-existing-info').textContent = session.editing ? '' : existing
      ? `已收录 · 目标原分 ${existing.similarity ?? '未知'}${existing.manualScore?.mode === 'top' ? ' · 固定置顶' : ''}`
      : session.restoring?.[session.index] ? '此前已移除 · 添加后解除排除' : session.target ? '新片段' : '';
    $('manual-add-score-mode').textContent = keepExisting(session.index) ? '将保留目标原分，不修改评分' : score.mode === 'top'
      ? session.editing ? '固定置顶分，保留当前填写的完整数值' : '已取本次最高分，之后保持固定'
      : '人工评分';
    sync();
  }
  function setScore(index, value, mode = 'custom') {
    if (keepExisting(index)) return;
    session.scores[index] = { value, text: value === Math.round(value * 10) / 10
      ? value.toFixed(1) : String(value), mode };
  }
  function editingMatches(entry, matches) {
    const exact = new Map(entry.matches.map((match) => [ArchiveStore.sceneKey(match), match]));
    const pathKey = (match) => ArchiveStore.sceneKey({ ...match, eagleItemId: undefined });
    const aliases = new Map();
    for (const match of entry.matches) {
      const key = pathKey(match);
      const values = aliases.get(key) || [];
      values.push(match); aliases.set(key, values);
    }
    const selected = matches.map((match) => exact.get(ArchiveStore.sceneKey(match))
      || aliases.get(pathKey(match))?.find((value) => !value.eagleItemId || !match.eagleItemId));
    const missing = selected.filter((match) => !match).length;
    if (missing) throw new Error(`${missing} 个选中片段已不在当前主题，请关闭面板后重新选择`);
    return selected;
  }
  function renderReferences() {
    const list = $('manual-add-references'); list.replaceChildren();
    if (!session?.target) { list.append(node('p', 'hint', '选择目标主题后显示参考片段')); return; }
    const refs = SceneScores.references(session.target.matches);
    session.highest = refs[0]?.match.similarity ?? null;
    $('manual-add-reference-summary').textContent = refs.length
      ? `「${session.target.name}」· 最高 ${session.highest.toFixed(1)} 分 · 点击参考片段可填写当前分数`
      : `「${session.target.name}」暂无可参考的分数，请手动填写`;
    if (!refs.length) list.append(node('p', 'hint', '目标主题为空或没有有效分数'));
    for (const { label, match } of refs) {
      const button = node('button', 'manual-add-reference'); button.type = 'button';
      button.title = `使用此分数填写当前片段：${match.similarity}`;
      button.append(node('span', 'manual-add-reference-label', `${label} · ${match.similarity.toFixed(1)} 分`), thumbnail(match),
        node('b', '', match.video_name || match.video_path), node('small', '', `${frameTime(match)} – ${frameTime(match, true)}`));
      button.addEventListener('click', () => { setScore(session.index, match.similarity); renderActive(); status(); });
      list.append(button);
    }
    sync();
  }
  function filterTargets() {
    if (!session) return;
    if (session.editing) {
      const entry = session.entries[0];
      $('manual-add-target').replaceChildren(new Option(`${entry.favorite ? '★ ' : ''}${entry.name} · ${entry.matches.length} 个片段`, entry.id));
      return;
    }
    const query = $('manual-add-target-query').value.trim().toLowerCase();
    const chosen = $('manual-add-target').value;
    $('manual-add-target').replaceChildren(new Option('选择已有主题…', ''));
    const targets = session.entries.slice().sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite));
    const categories = ArchiveStore.categoryTree(session.categories).byId;
    for (const entry of targets) {
      const category = categories.get(entry.categoryId)?.path || '未分类';
      if (entry.id !== chosen && !`${entry.name} ${category}`.toLowerCase().includes(query)) continue;
      const count = entry.summary?.matches ?? entry.matches.length;
      $('manual-add-target').append(new Option(`${entry.favorite ? '★ ' : ''}${entry.name} · ${category} · ${count} 个片段`, entry.id));
    }
    $('manual-add-target').value = chosen;
  }
  async function selectTarget(resetScores = true) {
    if (!session) return;
    const savedSession = session;
    const generation = ++targetGeneration;
    const id = session.editing ? session.editTargetId : $('manual-add-target').value;
    session.target = null; session.highest = null;
    session.existing = []; session.restoring = [];
    $('manual-add-impact').textContent = '';
    if (resetScores && !session.editing) {
      session.scores = session.matches.map(emptyScore);
      $('manual-add-bulk-score').value = '';
      renderActive();
    }
    $('manual-add-reference-summary').textContent = '';
    renderReferences(); sync();
    if (!id) { status(); return; }
    status('正在读取目标主题…');
    try {
      guard();
      const archive = store();
      const entry = archive.list().entries.find((value) => value.id === id);
      if (!entry) throw new Error('目标主题已不存在，请重新选择');
      await archive.hydrateEntry(entry, ['matches', 'removedMatches']);
      if (session !== savedSession || generation !== targetGeneration) return;
      guard();
      if (session.editing) {
        const matches = editingMatches(entry, session.matches);
        session.matches = matches.map((match) => SearchRecipe.clone(match));
        session.entries = [entry];
        filterTargets(); renderActive();
      }
      session.target = entry;
      inspectTarget(); renderActive(); renderReferences(); sync();
      status(session.editing ? '参考已刷新，请核对分数后保存调整' : resetScores ? '' : '参考已刷新，请核对分数后添加');
    } catch (error) {
      if (session === savedSession && generation === targetGeneration) { status(error.message, true); sync(); }
    }
  }
  function open(editEntry = null) {
    hooks.checkIdle(); hooks.validateSource();
    const selected = Search.getSelectedMatches() || [];
    if (!selected.length) return;
    const editing = editEntry !== null;
    if (editing && (!editEntry?.id || !Array.isArray(editEntry.matches))) throw new Error('当前主题尚未加载，请重新打开主题');
    const target = editing ? SearchRecipe.clone(editEntry) : null;
    const listing = editing ? null : store().list();
    const entries = editing ? [target] : listing.entries;
    if (!entries.length) throw new Error('还没有仓库主题，请先保存一个主题');
    const matches = editing ? editingMatches(target, selected).map((match) => SearchRecipe.clone(match)) : selected.map((match) => {
      const item = Bridge.itemForPath(match.video_path);
      return { ...SearchRecipe.clone(match), eagleItemId: match.eagleItemId || item?.id };
    });
    Search.pausePreview();
    session = { library: eagle.library.path, sourceVersion, entries, categories: listing?.categories || [],
      editing, editTargetId: target?.id, matches, scores: matches.map(emptyScore), index: 0, overviewPage: 0, target, highest: null,
      existing: [], restoring: [] };
    if (editing) matches.forEach((match, index) => {
      if (SceneScores.valid(match.manualScore?.value)) setScore(index, match.manualScore.value, match.manualScore.mode);
    });
    $('manual-add-title').textContent = editing ? '调整当前主题评分' : '添加片段到主题';
    $('manual-add-submit').textContent = editing ? '保存评分调整' : '添加到主题';
    $('manual-add-target-query').value = '';
    $('manual-add-target-query').classList.toggle('hidden', editing);
    $('manual-add-target').disabled = editing;
    $('manual-add-target').replaceChildren();
    filterTargets();
    $('manual-add-existing-mode').value = 'keep';
    $('manual-add-duplicates').classList.toggle('hidden', editing);
    $('manual-add-impact').textContent = '';
    $('manual-add-bulk-score').value = '';
    $('manual-add-only-empty').checked = true;
    $('manual-add-reference-summary').textContent = '';
    status(); renderActive(); renderReferences();
    $('manual-add-dialog').showModal();
    $(editing ? 'manual-add-score' : 'manual-add-target').focus();
    if (!editing) {
      const recent = recentTarget(session.library);
      if (entries.some((entry) => entry.id === recent)) {
        $('manual-add-target').value = recent;
        selectTarget();
      }
    }
  }
  function move(direction) {
    if (!session) return;
    const next = Math.max(0, Math.min(session.matches.length - 1, session.index + direction));
    if (next !== session.index) { session.index = next; session.overviewPage = Math.floor(next / OVERVIEW_SIZE); renderActive(); }
  }
  function nextUnscored() {
    if (!session) return;
    const next = SceneScores.nextUnscored(session.scores.map((score, index) => keepExisting(index) ? { value: 0 } : score), session.index);
    if (next < 0) return;
    session.index = next; session.overviewPage = Math.floor(next / OVERVIEW_SIZE);
    renderActive(); $('manual-add-score').focus();
  }
  function applyBulk(value, mode = 'custom') {
    if (!session) return;
    const onlyEmpty = $('manual-add-only-empty').checked;
    let changed = 0;
    session.scores.forEach((score, index) => {
      if (keepExisting(index)) return;
      if (onlyEmpty && SceneScores.valid(score.value)) return;
      setScore(index, value, mode); changed += 1;
    });
    renderActive(); status(changed ? `已填写 ${changed} 个片段`
      : session.scores.every((_, index) => keepExisting(index)) ? '这些片段均已收录；选择“重新评分”后可修改'
      : '没有未评分片段；取消“只填未评分”可覆盖全部分数，已收录片段仍遵循重复保护');
  }
  function editScores(entry) {
    if (!entry) throw new Error('请先打开当前主题再调整评分');
    open(entry);
  }
  function submit(event) {
    event.preventDefault();
    try {
      guard();
      if (!session.target) throw new Error('请选择目标主题');
      if (session.scores.some((_, index) => !ready(index))) throw new Error('请为新增、重新加入或重评片段填写有效分数');
      committing = true; sync();
      const target = session.target;
      const editing = session.editing;
      const archive = store();
      let matches = session.matches;
      if (editing) {
        const latest = archive.list().entries.find((entry) => entry.id === target.id);
        if (!latest) throw new Error('当前主题已不存在，请关闭面板后重新打开主题');
        if (latest.updatedAt !== target.updatedAt || (latest.revision || 0) !== (target.revision || 0)) {
          throw new Error('主题已被其他操作更新，请点击“刷新参考”后核对分数再保存');
        }
        matches = editingMatches(latest, session.matches);
      }
      const additions = matches.map((match, index) => ({ match, score: session.scores[index].value,
        scoreMode: session.scores[index].mode, keepExisting: keepExisting(index) }));
      const result = archive.addMatches(target.id, additions, target.updatedAt, target.revision || 0);
      hooks.onCommitted(result.entry, result.undoToken, { editing, targetId: target.id, library: session.library,
        beforeRevision: target.revision || 0, undoBytes: result.undoBytes,
        targetName: target.name, label: editing ? '调整评分' : '收录片段' });
      if (!editing) recentTarget(session.library, target.id);
      Search.clearSelection();
      $('manual-add-dialog').close();
      hooks.toast(editing ? `已调整「${target.name}」中 ${result.rescored} 个片段的评分`
        : `已加入「${target.name}」：新增 ${result.added} 个，更新评分 ${result.rescored} 个，重新加入 ${result.restored} 个，保留原分 ${result.kept || 0} 个`);
    } catch (error) { status(error.message, true); }
    finally { committing = false; sync(); }
  }
  function init(callbacks) {
    hooks = callbacks;
    $('btn-topic-add').addEventListener('click', () => { try { open(); } catch (error) { hooks.toast(error.message, true); } });
    $('manual-add-target-query').addEventListener('input', filterTargets);
    $('manual-add-target').addEventListener('change', () => selectTarget());
    $('manual-add-refresh').addEventListener('click', () => selectTarget(false));
    $('manual-add-existing-mode').addEventListener('change', () => { if (session) { renderActive(); status(); } });
    $('manual-add-prev').addEventListener('click', () => move(-1));
    $('manual-add-next').addEventListener('click', () => move(1));
    $('manual-add-next-empty').addEventListener('click', nextUnscored);
    $('manual-add-only-empty').addEventListener('change', sync);
    $('manual-add-overview-prev').addEventListener('click', () => {
      if (session?.overviewPage > 0) { session.overviewPage -= 1; renderOverview(); }
    });
    $('manual-add-overview-next').addEventListener('click', () => {
      if (session && (session.overviewPage + 1) * OVERVIEW_SIZE < session.matches.length) {
        session.overviewPage += 1; renderOverview();
      }
    });
    $('manual-add-score').addEventListener('input', () => {
      if (!session) return;
      if (keepExisting(session.index)) return;
      const text = $('manual-add-score').value;
      const value = text === '' ? null : Number(text);
      session.scores[session.index] = { value: SceneScores.valid(value) ? value : null, text, mode: 'custom' };
      $('manual-add-score-mode').textContent = '人工评分'; sync();
    });
    $('manual-add-top').addEventListener('click', () => {
      if (SceneScores.valid(session?.highest)) { setScore(session.index, session.highest, 'top'); renderActive(); status(); }
    });
    $('manual-add-bulk-top').addEventListener('click', () => {
      if (!SceneScores.valid(session?.highest)) return;
      applyBulk(session.highest, 'top');
      $('manual-add-bulk-score').value = String(session.highest);
    });
    $('manual-add-bulk-apply').addEventListener('click', () => {
      if (!session) return;
      const text = $('manual-add-bulk-score').value;
      const value = text === '' ? null : Number(text);
      if (!SceneScores.valid(value)) { status('请填写有效的统一分数', true); return; }
      applyBulk(value);
    });
    $('manual-add-dialog').addEventListener('keydown', (event) => {
      if (!session || event.altKey || event.metaKey) return;
      const target = event.target;
      if (target.id === 'manual-add-target-query' || target.tagName === 'SELECT') return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); event.stopPropagation(); move(event.key === 'ArrowLeft' ? -1 : 1);
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault(); event.stopPropagation();
        const direction = event.key === 'ArrowUp' ? 1 : -1;
        if (target.id === 'manual-add-bulk-score') {
          const value = target.value === '' ? null : Number(target.value);
          target.value = SceneScores.adjust(value, direction, event.ctrlKey).toFixed(1);
        } else {
          setScore(session.index, SceneScores.adjust(session.scores[session.index].value, direction, event.ctrlKey));
          $('manual-add-score').value = session.scores[session.index].text;
          $('manual-add-score-mode').textContent = '人工评分'; sync();
        }
      }
    });
    $('manual-add-form').addEventListener('submit', submit);
    $('manual-add-cancel').addEventListener('click', () => { if (!committing) $('manual-add-dialog').close(); });
    $('manual-add-dialog').addEventListener('cancel', (event) => { if (committing) event.preventDefault(); });
    $('manual-add-dialog').addEventListener('close', () => {
      targetGeneration += 1; session = null;
      $('manual-add-references').replaceChildren(); $('manual-add-scene-image').replaceChildren();
      $('manual-add-overview').replaceChildren();
    });
    document.addEventListener('search-context', () => { sourceVersion += 1; });
  }
  return { init, editScores };
})();
