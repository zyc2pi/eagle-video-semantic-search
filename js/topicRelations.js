/* 跨主题归属及完整快照比较；只读仓库，不调用搜索或模型。 */
const TopicRelations = (() => {
  const $ = (id) => document.getElementById(id);
  const pathKey = (match) => ArchiveStore.sceneKey({ ...match, eagleItemId: undefined });
  let hooks;
  let cache = null;
  let pendingSnapshot = null;
  let refreshGeneration = 0;
  let dialogGeneration = 0;
  let timer;
  let dialog;
  let dialogLibrary;
  let comparison = null;
  let mode = 'common';
  let request = null;
  let previewGeneration = 0;

  function* membershipSteps(entries) {
    const exact = new Map(); const paths = new Map();
    let count = 0;
    for (const entry of entries) {
      const topic = { id: entry.id, name: entry.name };
      for (const match of entry.matches) {
        const key = ArchiveStore.sceneKey(match);
        if (!exact.has(key)) exact.set(key, new Map());
        exact.get(key).set(entry.id, topic);
        const alias = pathKey(match);
        if (!paths.has(alias)) paths.set(alias, []);
        paths.get(alias).push({ id: match.eagleItemId, topic });
        if (++count % 256 === 0) yield;
      }
    }
    return (match) => {
      const found = new Map(exact.get(ArchiveStore.sceneKey(match)));
      for (const record of paths.get(pathKey(match)) || []) {
        if (!match.eagleItemId || !record.id) found.set(record.topic.id, record.topic);
      }
      return [...found.values()];
    };
  }

  function buildMembership(entries) {
    const steps = membershipSteps(entries);
    let step;
    do { step = steps.next(); } while (!step.done);
    return step.value;
  }

  async function buildMembershipAsync(entries, isCurrent) {
    const steps = membershipSteps(entries);
    let started = Date.now();
    while (true) {
      if (!isCurrent()) throw Object.assign(new Error('主题归属读取已被新的刷新取代'), { name: 'AbortError' });
      const step = steps.next();
      if (step.done) return step.value;
      if (Date.now() - started >= 8) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        started = Date.now();
      }
    }
  }

  function compare(left, right) {
    const inLeft = ArchiveStore.sceneLookup(left.matches);
    const inRight = ArchiveStore.sceneLookup(right.matches);
    return {
      common: left.matches.filter((match) => inRight(match) !== undefined),
      left: left.matches.filter((match) => inRight(match) === undefined),
      right: right.matches.filter((match) => inLeft(match) === undefined),
    };
  }

  async function readSnapshot() {
    const library = eagle.library.path;
    const archive = ArchiveStore.open(Config.pluginPath(), library);
    const snapshot = archive.list();
    const signature = JSON.stringify(snapshot.entries.map((entry) => [entry.id, entry.name, entry.revision, entry.updatedAt]));
    if (cache?.library === library && cache.signature === signature) return cache;
    if (pendingSnapshot?.library === library && pendingSnapshot.signature === signature) return pendingSnapshot.promise;
    const pending = { library, signature };
    pendingSnapshot = pending;
    const isCurrent = () => pendingSnapshot === pending && library === eagle.library.path;
    pending.promise = (async () => {
      // Let the result list paint before background membership work starts.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const entries = [];
      for (const entry of snapshot.entries) {
        if (!isCurrent()) throw Object.assign(new Error('素材库或主题快照已切换，请重新打开'), { name: 'AbortError' });
        await archive.hydrateEntry(entry, ['matches']);
        entries.push(entry);
      }
      const find = await buildMembershipAsync(entries, isCurrent);
      const latest = archive.list();
      const latestSignature = JSON.stringify(latest.entries.map((entry) => [entry.id, entry.name, entry.revision, entry.updatedAt]));
      if (signature !== latestSignature) throw new Error('主题在读取期间发生变化，请刷新后重试');
      return { library, signature, entries, find, warnings: latest.warnings };
    })();
    try { return await pending.promise; }
    finally { if (pendingSnapshot === pending) pendingSnapshot = null; }
  }

  async function refresh() {
    const generation = ++refreshGeneration;
    if (cache?.library !== eagle.library.path) { cache = null; Search.refreshTopicMembership(null); }
    try {
      const snapshot = await readSnapshot();
      if (generation !== refreshGeneration || snapshot.library !== eagle.library.path) return;
      cache = snapshot;
      Search.refreshTopicMembership(snapshot.find);
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (generation === refreshGeneration) { cache = null; Search.refreshTopicMembership(null, '归属读取失败，点击重试'); }
    }
  }

  function scheduleRefresh() {
    clearTimeout(timer); timer = setTimeout(refresh, 0);
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function stopPreview() {
    previewGeneration += 1;
    const video = $('relations-video');
    video.onerror = null; video.onloadedmetadata = null; video.ontimeupdate = null;
    video.pause(); video.removeAttribute('src'); video.load();
    video.classList.add('hidden');
    $('relations-preview-status').textContent = '';
  }

  function begin(title) {
    hooks.checkIdle();
    Search.pausePreview();
    const generation = ++dialogGeneration;
    dialogLibrary = eagle.library.path;
    comparison = null;
    stopPreview();
    $('relations-title').textContent = title;
    $('relations-status').textContent = '正在读取当前素材库的主题…';
    $('relations-controls').replaceChildren();
    $('relations-tabs').replaceChildren();
    $('relations-list').replaceChildren();
    if (!dialog.open) dialog.showModal();
    return { generation, library: dialogLibrary };
  }

  const isCurrent = (session) => dialog.open && session.generation === dialogGeneration && session.library === eagle.library.path;
  function report(error, session) { if (isCurrent(session)) $('relations-status').textContent = error.message; }

  async function openEntry(id, session) {
    if (!isCurrent(session)) return;
    try {
      hooks.checkIdle();
      dialog.close();
      await hooks.openEntry(id);
    } catch (error) { hooks.toast(error.message, true); }
  }

  async function showMembership(match) {
    const session = begin('片段的主题归属');
    request = { match };
    try {
      const snapshot = await readSnapshot();
      if (!isCurrent(session)) return;
      cache = snapshot; Search.refreshTopicMembership(snapshot.find);
      const topics = snapshot.find(match);
      $('relations-status').textContent = `${match.video_name || match.video_path} · 已收录到 ${topics.length} 个主题。${snapshot.warnings?.join('；') || ''}`;
      for (const topic of topics) {
        const button = node('button', 'relations-topic', topic.name);
        button.type = 'button'; button.addEventListener('click', () => openEntry(topic.id, session));
        $('relations-list').append(button);
      }
      if (!topics.length) $('relations-list').append(node('p', 'hint', '此片段尚未收录到当前库的主题。已移除片段不计入归属。'));
    } catch (error) { report(error, session); }
  }

  function preview(match, session) {
    if (!isCurrent(session)) return;
    stopPreview();
    const item = Bridge.itemForPath(match.video_path);
    const generation = previewGeneration;
    const validPreview = () => isCurrent(session) && generation === previewGeneration;
    const path = item?.filePath || match.video_path;
    const video = $('relations-video');
    const start = match.start_frame / (match.fps || 30);
    const end = match.end_frame / (match.fps || 30);
    let fallback = false;
    video.classList.remove('hidden');
    $('relations-preview-status').textContent = match.video_name || path;
    video.onloadedmetadata = () => {
      if (!validPreview()) return;
      video.currentTime = fallback ? 0 : start;
      video.play().catch(() => {});
    };
    video.ontimeupdate = () => { if (validPreview() && !fallback && video.currentTime >= end) video.pause(); };
    video.onerror = () => {
      if (!validPreview()) return;
      if (fallback) { $('relations-preview-status').textContent = '预览失败，请检查素材路径及本地服务后重试'; return; }
      fallback = true;
      $('relations-preview-status').textContent = '正在加载片段预览…';
      video.src = Api.clipUrl(path, match.start_frame, match.end_frame);
    };
    video.src = item?.fileURL || `file:///${String(path).replace(/\\/g, '/')}`;
    video.load();
  }

  function renderComparison(session) {
    stopPreview();
    const list = $('relations-list'); list.replaceChildren();
    const matches = comparison.diff[mode];
    $('relations-tabs').querySelectorAll('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    });
    $('relations-status').textContent = `完整已存结果：A「${comparison.left.name}」${comparison.left.matches.length} 个，B「${comparison.right.name}」${comparison.right.matches.length} 个。按原始帧边界匹配；不受结果内筛选影响。${comparison.warnings?.join('；') || ''}`;
    let shown = 0;
    const more = node('button', 'relations-more', '加载更多');
    const append = () => {
      more.remove();
      for (const match of matches.slice(shown, shown + 60)) {
        const row = node('div', 'relations-row');
        const text = node('div', 'relations-scene');
        text.append(node('strong', '', match.video_name || match.video_path),
          node('small', 'hint', `${match.start || match.start_frame} – ${match.end || match.end_frame} · ${Number(match.duration_seconds || 0).toFixed(2)} 秒`));
        const play = node('button', '', '预览'); play.type = 'button';
        play.addEventListener('click', () => preview(match, session));
        row.append(text, play); list.append(row);
      }
      shown += 60;
      if (shown < matches.length) list.append(more);
    };
    more.addEventListener('click', append); append();
    if (!matches.length) list.append(node('p', 'hint', '此组没有片段。'));
  }

  async function showCompare(ids = []) {
    const session = begin('跨主题比较');
    request = { ids };
    try {
      const snapshot = await readSnapshot();
      if (!isCurrent(session)) return;
      cache = snapshot; Search.refreshTopicMembership(snapshot.find);
      if (snapshot.entries.length < 2) { $('relations-status').textContent = '当前素材库至少需要两个主题才能比较。'; return; }
      const entries = snapshot.entries;
      const left = node('select'); const right = node('select');
      left.id = 'relations-left'; right.id = 'relations-right';
      left.setAttribute('aria-label', '主题 A'); right.setAttribute('aria-label', '主题 B');
      for (const entry of entries) { left.add(new Option(entry.name, entry.id)); right.add(new Option(entry.name, entry.id)); }
      left.value = ids[0] && entries.some((entry) => entry.id === ids[0]) ? ids[0] : entries[0].id;
      right.value = ids[1] && entries.some((entry) => entry.id === ids[1]) ? ids[1] : entries.find((entry) => entry.id !== left.value).id;
      const openLeft = node('button', '', '打开 A'); const openRight = node('button', '', '打开 B');
      openLeft.addEventListener('click', () => openEntry(left.value, session));
      openRight.addEventListener('click', () => openEntry(right.value, session));
      $('relations-controls').append(node('label', '', 'A'), left, node('label', '', 'B'), right, openLeft, openRight);
      const update = () => {
        if (!isCurrent(session)) return;
        request = { ids: [left.value, right.value] };
        stopPreview();
        if (left.value === right.value) {
          comparison = null; $('relations-tabs').replaceChildren(); $('relations-list').replaceChildren();
          $('relations-status').textContent = '请选择两个不同的主题。'; return;
        }
        const a = entries.find((entry) => entry.id === left.value); const b = entries.find((entry) => entry.id === right.value);
        comparison = { left: a, right: b, diff: compare(a, b), warnings: snapshot.warnings };
        $('relations-tabs').replaceChildren();
        for (const [key, title] of [['common', '共有'], ['left', 'A 独有'], ['right', 'B 独有']]) {
          const button = node('button', '', `${title} ${comparison.diff[key].length}`); button.dataset.mode = key;
          button.addEventListener('click', () => { if (isCurrent(session)) { mode = key; renderComparison(session); } });
          $('relations-tabs').append(button);
        }
        renderComparison(session);
      };
      left.addEventListener('change', update); right.addEventListener('change', update);
      mode = 'common'; update();
    } catch (error) { report(error, session); }
  }

  function init(callbacks) {
    hooks = callbacks;
    dialog = node('dialog'); dialog.id = 'topic-relations-dialog'; dialog.setAttribute('aria-labelledby', 'relations-title');
    // 模板只有固定文案，素材及主题名称均通过 textContent 插入。
    dialog.innerHTML = '<h2 id="relations-title"></h2><div id="relations-controls"></div>'
      + '<p id="relations-status" class="hint" role="status"></p><div id="relations-tabs" role="group" aria-label="比较范围"></div>'
      + '<video id="relations-video" class="hidden" controls preload="metadata"></video><p id="relations-preview-status" class="hint" role="status"></p>'
      + '<div id="relations-list"></div><div class="dialog-actions"><button id="relations-reload" type="button">刷新</button><button id="relations-close" type="button">关闭</button></div>';
    document.body.append(dialog);
    $('relations-close').addEventListener('click', () => dialog.close());
    $('relations-reload').addEventListener('click', () => {
      cache = null;
      if (dialogLibrary !== eagle.library.path) { $('relations-status').textContent = '素材库已切换，请关闭面板后重新打开'; return; }
      if (request?.match) showMembership(request.match).catch((error) => hooks.toast(error.message, true));
      else showCompare(request?.ids).catch((error) => hooks.toast(error.message, true));
    });
    dialog.addEventListener('close', () => { ++dialogGeneration; stopPreview(); comparison = null; });
    document.addEventListener('search-context', () => {
      if (cache?.library !== eagle.library.path) { cache = null; Search.refreshTopicMembership(null); }
      if (dialog.open && dialogLibrary !== eagle.library.path) { dialog.close(); hooks.toast('素材库已切换，主题比较已关闭'); }
      scheduleRefresh();
    });
  }
  async function openTopic(id, library) {
    try {
      if (library !== eagle.library.path) throw new Error('素材库已切换，请重新选择片段');
      hooks.checkIdle();
      await hooks.openEntry(id);
    } catch (error) { hooks.toast(error.message, true); }
  }
  return { init, showCompare, buildMembership, compare, refresh: scheduleRefresh,
    openTopic,
    showMembership: (match) => showMembership(match).catch((error) => hooks.toast(error.message, true)) };
})();
