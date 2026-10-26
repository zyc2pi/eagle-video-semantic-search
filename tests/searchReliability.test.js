const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

class Element {
  constructor() { this.children = []; this.events = {}; this.dataset = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute() {}
  removeAttribute() {}
  pause() {}
  load() {}
  remove() {}
  play() { this.playCount = (this.playCount || 0) + 1; return Promise.resolve(); }
}
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'search.js'), 'utf8');
const deferred = [];
const context = {
  console, AbortController, setTimeout, clearTimeout,
  CustomEvent: class {},
  document: { body: { dataset: { page: 'search' } }, getElementById: () => null, dispatchEvent() {}, createElement: () => new Element() },
  Config: { get: () => ({ modelName: 'model' }) },
  eagle: { library: { path: 'library' } },
  Bridge: {
    resolveLibraryIdentity: async () => ({ id: 'stable-id', index_name: 'library' }),
    refreshPathMap: async () => new Map(),
    normalizePath: (p) => p,
    itemForPath: () => ({ fileURL: 'file:///test', id: 'test' }),
    isWebPlayable: () => true,
  },
  SearchRecipe: {
    clone: (value) => JSON.parse(JSON.stringify(value)),
    capture: (kind, query) => ({ kind, query, library: 'library', config: {} }),
    normalize: (p) => p,
    resolve: async () => ({ paths: null }),
  },
  ArchiveStore: { sceneKey: (m) => m.start_frame },
  Api: {
    listIndexes: async (id) => {
      assert.strictEqual(id, 'stable-id');
      return [{ name: 'library_model.lance', model: 'model', path: 'index' },
        { name: 'library_other_model.lance', model: 'model', path: 'wrong-index' }];
    },
    search: (_query, indices) => {
      assert.deepStrictEqual(Array.from(indices), ['index'], '仅使用当前稳定库身份的精确模型索引');
      return new Promise((resolve) => deferred.push(resolve));
    },
    previewUrl: () => 'poster',
  },
};
const injection = `
  this.inspect = {
    setup(matches) { lastMatches = matches; displayList = matches.map((_, i) => i);
      el.previewVideo = new Element(); el.previewInfo = new Element();
      el.previewStatus = new Element(); el.previewRetry = new Element();
      el.previewPanel = new Element(); el.btnLocate = new Element(); },
    buildCard, buildGroup, computeDisplayList, openPreview, closePreview, startHoverPreview, stopHoverPreview, hover, el,
    setResults(root) { el.results = root; },
    simulateRestore(total) {
      const previous = renderNextChunk;
      view.grouped = false; flatPtr = 60; displayList = Array.from({ length: total }, (_, i) => i);
      renderNextChunk = () => { flatPtr = Math.min(total, flatPtr + 60); };
      return { shown: () => flatPtr, finish: () => { renderNextChunk = previous; } };
    },
    disableRender() { render = () => {}; },
  };
`;
context.Element = Element;
vm.runInNewContext(source.replace('  return {\n    bindDom,', injection + '  return {\n    bindDom,') + '\nthis.Search = Search;', context);
const { Search, inspect } = context;

async function main() {
  inspect.setup([
    { similarity: 20 }, { similarity: 20, manualScore: { mode: 'custom' } },
    { similarity: 20, manualScore: { mode: 'top' } }, { similarity: 21 },
  ]);
  assert.deepStrictEqual(Array.from(inspect.computeDisplayList()), [3, 2, 0, 1],
    '固定置顶分只在同分时优先，更高分结果仍在前面');
  const matches = Array.from({ length: 1000 }, (_, i) => ({ video_path: 'video', video_name: 'video', start_frame: i,
    end_frame: i + 20, fps: 25, similarity: i === 999 ? 95 : 60, duration_seconds: 10 }));
  inspect.setup(matches);
  const group = inspect.buildGroup({ name: 'video', idxs: matches.map((_, i) => i) }, 0);
  assert(group.children[0].innerHTML.includes('最高 95.0'), '最高分不受时长排序影响');
  assert.strictEqual(group.children[1].children.length, 60, '1000条仅创建首批60');
  group.children[2].events.click();
  assert.strictEqual(group.children[1].children.length, 120);

  inspect.openPreview(matches[0]);
  const firstError = inspect.el.previewVideo.onerror;
  firstError();
  assert.strictEqual(inspect.el.previewPanel.dataset.state, 'native', '封面错误没有 MediaError，不能打断源视频');
  inspect.el.previewVideo.error = { code: 4 };
  firstError();
  assert.strictEqual(inspect.el.previewPanel.dataset.state, 'error', '真实媒体失败直接提示，不请求切片转码');
  assert.strictEqual(inspect.el.previewRetry.hidden, false);
  inspect.openPreview(matches[1]);
  firstError();
  assert.strictEqual(inspect.el.previewPanel.dataset.state, 'native', '过期媒体事件不能覆盖新预览');
  inspect.closePreview();
  assert.strictEqual(Search.getActiveMatch(), null);

  inspect.setup(matches);
  const bufferingVideo = inspect.el.previewVideo;
  bufferingVideo.readyState = 2;
  bufferingVideo.currentTime = 0.08;
  bufferingVideo.duration = 10;
  bufferingVideo.buffered = { length: 1, start: () => 0, end: () => 0.12 };
  inspect.openPreview(matches[0]);
  bufferingVideo.onloadedmetadata();
  assert.strictEqual(bufferingVideo.playCount, 1, '定位完成立即请求播放，由浏览器继续加载，不人为等待预缓冲');
  bufferingVideo.readyState = 4;
  bufferingVideo.buffered.end = () => 5;
  bufferingVideo.oncanplay?.();
  assert.strictEqual(bufferingVideo.playCount, 1, '后续缓冲事件不能重复请求播放');
  bufferingVideo.onseeked?.();
  assert.strictEqual(bufferingVideo.playCount, 1, '后续定位事件不能重复自动播放');
  inspect.closePreview();

  inspect.startHoverPreview(new Element(), matches[0]);
  const hoveringVideo = inspect.hover.video;
  Object.assign(hoveringVideo, { currentTime: 0, seeking: true });
  hoveringVideo.onloadedmetadata();
  assert.strictEqual(hoveringVideo.playCount, 1, '悬停元数据就绪即请求播放，不等意图定时器或 seeked');
  inspect.stopHoverPreview();

  inspect.setup(matches);
  const seekingVideo = inspect.el.previewVideo;
  Object.assign(seekingVideo, { readyState: 1, currentTime: 0, seeking: true });
  inspect.openPreview(matches[0]);
  seekingVideo.onloadedmetadata();
  assert.strictEqual(seekingVideo.playCount, 1, '已发出片段定位时就请求播放，不能等 seeked 才驱动加载');
  inspect.closePreview();

  // 浏览器可能在首帧就绪后停止预加载，必须主动 play 才会继续读取。
  const startupTimers = new Map();
  let nextStartupTimer = 0;
  context.setTimeout = (callback, delay) => {
    const id = ++nextStartupTimer;
    startupTimers.set(id, { callback, delay });
    return id;
  };
  context.clearTimeout = (id) => startupTimers.delete(id);
  inspect.setup(matches);
  const suspendedVideo = inspect.el.previewVideo;
  Object.assign(suspendedVideo, { readyState: 2, currentTime: 0.08, duration: 10,
    buffered: { length: 1, start: () => 0, end: () => 0.12 } });
  inspect.openPreview(matches[0]);
  suspendedVideo.onloadedmetadata();
  assert.strictEqual(startupTimers.size, 1, '启动超时仅负责停滞恢复，不推迟播放请求');
  assert.strictEqual(suspendedVideo.playCount, 1, '无后续媒体事件时也必须请求播放以恢复加载');
  await Promise.resolve();
  assert.strictEqual(inspect.el.previewPanel.dataset.state, 'ready');
  assert.strictEqual(startupTimers.size, 1, 'play Promise 成功不代表持续出帧，保留进度检测');
  suspendedVideo.currentTime = 0.4;
  suspendedVideo.paused = false;
  suspendedVideo.ontimeupdate();
  assert.strictEqual(startupTimers.size, 0, '真实播放进度足够后清理停滞检测');
  inspect.closePreview();
  for (const action of ['close', 'switch', 'step', 'error', 'reload']) {
    suspendedVideo.currentTime = 0.08;
    suspendedVideo.seeking = true;
    inspect.openPreview(matches[0]);
    const staleMetadata = suspendedVideo.onloadedmetadata;
    const staleTimer = [...startupTimers.values()][0].callback;
    const played = suspendedVideo.playCount;
    suspendedVideo.seeking = false;
    if (action === 'close') inspect.closePreview();
    if (action === 'switch') inspect.openPreview(matches[1]);
    if (action === 'step') {
      context.CoverFrame = { stepTime: (time) => time + 0.04 };
      Search.stepPreviewFrame(1);
    }
    if (action === 'error') {
      suspendedVideo.error = { code: 4 };
      suspendedVideo.onerror();
      suspendedVideo.error = null;
    }
    if (action === 'reload') {
      startupTimers.clear();
      staleTimer();
    }
    assert.strictEqual(startupTimers.size, ['switch', 'reload'].includes(action) ? 1 : 0, `${action} 清理旧定时器，仅保留新加载检测`);
    staleMetadata();
    staleTimer();
    assert.strictEqual(suspendedVideo.playCount, played, `${action} 后迟到定位回调不能自动播放`);
    inspect.closePreview();
  }
  inspect.setup(matches);
  const stalledVideo = inspect.el.previewVideo;
  inspect.openPreview(matches[0]);
  const nativeTimeout = [...startupTimers.values()][0];
  assert.strictEqual(nativeTimeout.delay, 1500);
  let reloads = 0;
  stalledVideo.load = () => { reloads += 1; };
  startupTimers.clear();
  nativeTimeout.callback();
  assert.strictEqual(reloads, 1, '停滞仅重载原视频一次');
  const reloadTimeout = [...startupTimers.values()][0];
  assert.strictEqual(reloadTimeout.delay, 1500);
  startupTimers.clear();
  reloadTimeout.callback();
  assert.strictEqual(inspect.el.previewPanel.dataset.state, 'error', '重载仍停滞时停止并提示，不等待切片转码');
  assert.strictEqual(startupTimers.size, 0);
  inspect.closePreview();

  inspect.openPreview(matches[0]);
  Object.assign(stalledVideo, { currentTime: 0.08, readyState: 2, seeking: false, paused: false });
  stalledVideo.onloadedmetadata();
  await Promise.resolve();
  stalledVideo.onwaiting();
  assert.strictEqual(inspect.el.previewPanel.dataset.state, 'ready', '短暂定位等待不闪烁缓冲提示');
  const notice = [...startupTimers.values()].find((timer) => timer.delay === 200);
  notice.callback();
  assert.strictEqual(inspect.el.previewPanel.dataset.state, 'buffering');
  const watchdog = [...startupTimers.values()].find((timer) => timer.delay === 1500);
  stalledVideo.onplaying();
  stalledVideo.currentTime = 0.12;
  stalledVideo.ontimeupdate();
  assert([...startupTimers.values()].includes(watchdog), 'playing 和一帧的进展不能取消停滞恢复');
  for (const [id, timer] of startupTimers) if (timer === notice) startupTimers.delete(id);
  assert.strictEqual(startupTimers.size, 1);
  stalledVideo.paused = true;
  stalledVideo.onpause();
  assert.strictEqual(inspect.el.previewPanel.dataset.state, 'ready', '暂停后清除缓冲提示');
  assert.strictEqual(startupTimers.size, 0, '暂停后不启动旧加载恢复');
  inspect.closePreview();
  context.setTimeout = setTimeout;
  context.clearTimeout = clearTimeout;

  const payload = '<img src="missing" onerror="window.__marker=1">';
  const malicious = { ...matches[0], start: payload, end: payload, duration_display: payload,
    video_name: payload, matched_queries: [{ text: payload }, { text: payload }] };
  const card = inspect.buildCard(malicious, 0, 0);
  assert(card.children[3].children[1].innerHTML.includes('&lt;img'), '时间字段作为文本转义');
  assert(!card.children[3].children[1].innerHTML.includes('<img'), '卡片不解析外部时间字段HTML');
  inspect.openPreview(malicious);
  assert(!inspect.el.previewInfo.innerHTML.includes('<img'), '预览时间、时长、查询和名称均不可注入HTML');
  inspect.closePreview();

  inspect.disableRender();
  const localMatches = [
    { video_name: 'City NIGHT', similarity: 10, duration_seconds: 4, start_frame: 1 },
    { video_name: 'City Day', similarity: 11, duration_seconds: 4, start_frame: 2, manualScore: { value: 11 } },
    { video_name: 'Forest', similarity: 12, duration_seconds: 4, start_frame: 3, manualScore: { value: 12 } },
  ];
  inspect.setup(localMatches);
  Search.setArchiveFilter({ query: ' CITY ', source: 'manual' });
  assert.deepStrictEqual(Array.from(inspect.computeDisplayList()), [1], '名称忽略大小写和两端空白，与人工筛选取交集');
  Search.setArchiveFilter({ query: 'city', source: 'auto' });
  assert.deepStrictEqual(Array.from(inspect.computeDisplayList()), [0], '未人工评分筛选不包含已有人工片段');
  Search.setArchiveFilter({ query: '不存在', source: 'all' });
  assert.strictEqual(inspect.computeDisplayList().length, 0);
  assert.strictEqual(Search.getRawMatches().length, 3, '本地查找不修改完整快照');
  assert.throws(() => Search.setArchiveFilter({ query: '', source: 'invalid' }), /条件无效/);
  Search.setArchiveFilter({ query: '', source: 'all' });
  const savedItemForPath = context.Bridge.itemForPath;
  const metadata = {
    horizontal: { tags: ['夜景', 'CITY'], width: 1920, height: 1080 },
    vertical: { tags: ['夜景'], width: 1080, height: 1920 },
    square: { tags: [], width: 600, height: 600 },
  };
  context.Bridge.itemForPath = (path) => metadata[path];
  inspect.setup([
    { video_path: 'horizontal', video_name: 'City night', duration_seconds: 4, similarity: 20 },
    { video_path: 'vertical', video_name: 'City night', duration_seconds: 8, similarity: 19 },
    { video_path: 'square', video_name: 'City square', duration_seconds: 3, similarity: 18 },
    { video_path: 'missing', video_name: 'City unknown', duration_seconds: 5, similarity: 17 },
  ]);
  Search.setView({ minDur: 4 });
  Search.setArchiveFilter({ query: 'city', source: 'all', tags: '夜景， city ', orientation: 'landscape', maxDur: 4 });
  assert.deepStrictEqual(Array.from(inspect.computeDisplayList()), [0], '组合筛选取交集，时长边界包含，完整标签忽略大小写');
  assert.strictEqual(Search.getRawMatches().length, 4, '筛选不删除原结果');
  const combined = Search.captureState();
  Search.setArchiveFilter({ query: '', source: 'all' });
  Search.restoreState(combined);
  assert.deepStrictEqual(Array.from(inspect.computeDisplayList()), [0], '返回搜索恢复组合条件');
  assert.throws(() => Search.setArchiveFilter({ query: '', source: 'all', maxDur: 3 }), /上限/);
  assert.throws(() => Search.setView({ minDur: 5 }), /下限/);
  assert.throws(() => Search.setArchiveFilter({ query: '', source: 'all', maxDur: NaN }), /条件无效/);
  Search.setView({ minDur: 0 });
  for (const [orientation, expected] of [['portrait', [1]], ['square', [2]], ['unknown', [3]]]) {
    Search.setArchiveFilter({ query: '', source: 'all', orientation });
    assert.deepStrictEqual(Array.from(inspect.computeDisplayList()), expected, '画幅使用素材尺寸，缺失数据单列未知');
  }
  Search.setArchiveFilter({ query: '', source: 'all', tags: '夜' });
  assert.strictEqual(inspect.computeDisplayList().length, 0, '标签按完整名称匹配');
  Search.setArchiveFilter({ query: '', source: 'all' });
  context.Bridge.itemForPath = savedItemForPath;
  inspect.setup(matches);
  const old = Search.run('old', 10, { paths: null });
  await new Promise(setImmediate);
  Search.cancel();
  assert.strictEqual(Search.isBusy(), false);
  assert.strictEqual(Search.getRawMatches().length, 1000, '取消保留旧结果');
  const fresh = Search.run('fresh', 10, { paths: null });
  await new Promise(setImmediate);
  deferred[0]({ ok: true, data: { success: true, matches: [] } });
  assert.strictEqual((await old).cancelled, true);
  assert.strictEqual(Search.isBusy(), true, '旧finally不得清除新查询busy');
  deferred[1]({ ok: true, data: { success: true, matches: [matches[0]] } });
  assert.strictEqual((await fresh).ok, true);
  assert.strictEqual(Search.getLastQuery(), 'fresh');

  const oldMapRefresh = context.Bridge.refreshPathMap;
  let releaseMap;
  let apply = true;
  context.Bridge.refreshPathMap = () => new Promise((resolve) => { releaseMap = resolve; });
  const abandonedLoad = Search.loadResults([], 'abandoned', null, null, [], { mode: 'all' },
    { query: '', source: 'all' }, { shouldApply: () => apply });
  apply = false;
  releaseMap(new Map());
  assert.strictEqual(await abandonedLoad, null, '读取素材映射期间返回/切换应丢弃旧主题');
  assert.strictEqual(Search.getLastQuery(), 'fresh', '迟到主题不覆盖当前搜索词');
  assert.strictEqual(Search.getRawMatches().length, 1, '迟到主题不覆盖当前结果');
  assert.strictEqual(Search.isBusy(), false, '丢弃主题释放busy');
  context.Bridge.refreshPathMap = oldMapRefresh;
  assert.strictEqual(Search.getRawMatches().length, 1);
  assert.strictEqual(Search.getArchiveFilter().source, 'all', '成功新搜索清除主题内查找条件');

  const searchState = Search.captureState();
  searchState.selected = [0];
  Search.restoreState(searchState);
  assert.strictEqual(Search.getSelectedMatches().length, 1, '恢复搜索同时恢复勾选');
  const originalMatch = Search.getRawMatches()[0];
  Search.replaceResults([{ ...originalMatch, start_frame: -1 }, originalMatch], ['added']);
  assert.strictEqual(Search.getSelectedMatches().length, 1, '主题编辑按片段身份保留剩余勾选');
  assert.strictEqual(Search.getSelectedMatches()[0].start_frame, originalMatch.start_frame);
  assert.strictEqual(Search.getLastQuery(), 'fresh', '本地主题编辑不覆盖查询');
  assert.deepStrictEqual(Search.getView(), searchState.view, '本地主题编辑保留视图条件');
  Search.replaceResults([], []);
  assert.strictEqual(Search.getSelectedMatches(), null, '移除所有片段后清空勾选');
  Search.restoreState({ ...searchState, library: 'other-library' });
  assert.strictEqual(Search.getRawMatches().length, 0, '不能恢复其他库的搜索片段');
  assert.strictEqual(Search.getLastQuery(), '');
  assert.strictEqual(Search.getRecipe(), null);
  Search.restoreState(searchState);
  assert.strictEqual(Search.getLastQuery(), 'fresh');

  const frames = [];
  context.requestAnimationFrame = (callback) => frames.push(callback);
  const scrollRoot = new Element();
  scrollRoot.scrollTop = 12;
  scrollRoot.getBoundingClientRect = () => ({ top: 0, bottom: 500 });
  scrollRoot.querySelectorAll = () => [];
  inspect.setResults(scrollRoot);
  const delayedPosition = Search.restoreBrowsePosition({ scrollTop: 400 });
  context.eagle.library.path = 'other-library';
  frames.shift()();
  assert.strictEqual(await delayedPosition, false, '切库后丢弃迟到的位置恢复');
  assert.strictEqual(scrollRoot.scrollTop, 12, '迟到恢复不能移动其他库的视图');
  context.eagle.library.path = 'library';
  const validPosition = Search.restoreBrowsePosition({ scrollTop: 400 });
  frames.shift()();
  assert.strictEqual(await validPosition, true);
  assert.strictEqual(scrollRoot.scrollTop, 400);
  const preparePosition = Search.restoreBrowsePosition({ scrollTop: 400 }, { scroll: false });
  frames.shift()();
  assert.strictEqual(await preparePosition, false);
  assert.strictEqual(scrollRoot.scrollTop, 0, '只恢复列表与分组加载状态时不自动跳转到历史位置');

  const restoreFixture = inspect.simulateRestore(6000);
  const deepRestore = Search.restoreBrowsePosition({ rendered: 6000 }, { scroll: false });
  assert.strictEqual(restoreFixture.shown(), 60, '历史加载数量不能阻塞首屏绘制');
  frames.shift()();
  await Promise.resolve();
  assert.strictEqual(restoreFixture.shown(), 120, '每帧至多恢复一批，保持界面可响应');
  scrollRoot.scrollTop = 50;
  let restored = false;
  deepRestore.then(() => { restored = true; });
  while (!restored) {
    assert(frames.length, '恢复过程须持续让出绘制机会');
    frames.shift()();
    await new Promise(setImmediate);
  }
  assert.strictEqual(restoreFixture.shown(), 6000, '最终保留原有历史加载数量');
  assert.strictEqual(scrollRoot.scrollTop, 50, '后台恢复期间不能把用户新滚动的位置跳回顶部');
  restoreFixture.finish();

  const replay = Search.replay({ kind: 'text', query: 'replay', library: 'library', config: {} });
  const replayRejected = assert.rejects(replay, { name: 'AbortError' });
  await new Promise(setImmediate);
  assert.throws(() => Search.restoreState(searchState), /已有搜索正在进行/,
    '进行中的更新不能被状态恢复覆盖');
  Search.cancel();
  deferred[2]({ ok: true, data: { success: true, matches: [] } });
  await replayRejected;
  assert.strictEqual(Search.getRawMatches().length, 1, '取消更新不能影响已有结果');

  const moved = Search.replay({ kind: 'text', query: 'replay', library: 'library', config: {} });
  const movedRejected = assert.rejects(moved, /素材库已切换/);
  await new Promise(setImmediate);
  context.eagle.library.path = 'other-library';
  deferred[3]({ ok: true, data: { success: true, matches: [] } });
  await movedRejected;
  assert.strictEqual(Search.getPhase(), '');
  context.eagle.library.path = 'library';
  context.Bridge.resolveLibraryIdentity = async () => ({});
  await assert.rejects(Search.run('unsafe', 10, { paths: null }), /身份不完整/);
  console.log('search cancellation, stale responses, batching and preview recovery passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
