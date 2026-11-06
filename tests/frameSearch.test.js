const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class Element {
  constructor() { this.events = {}; this.value = ''; this.children = []; this.dataset = {}; this.style = {}; this.classList = { toggle() {} }; }
  addEventListener(name, callback) { this.events[name] = callback; }
  setAttribute() {}
  removeAttribute() {}
  replaceChildren() { this.children = []; }
  appendChild(child) { this.children.push(child); }
  showModal() { this.open = true; }
  focus() {}
  close() { this.open = false; this.events.close?.(); }
}
const elements = new Map();
const el = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
const frame = { dataUrl: 'data:image/jpeg;base64,frame-75', frame: 75, fps: 25,
  videoName: '素材', videoPath: 'D:/video.mp4' };
const requests = [];
const toasts = [];
let recipe = null;
let captureError = null;
let cancelCount = 0;
const context = {
  console, AbortController, CustomEvent: class {},
  eagle: { library: { path: 'library' } },
  document: { getElementById: el, createElement: () => new Element(), dispatchEvent() {}, addEventListener() {} },
  SearchRecipe: { normalize: (value) => value },
  Config: { settings: { continuationMode: 'end', continuationSeconds: 1 },
    get() { return this.settings; }, save(partial) { this.settings = { ...this.settings, ...partial }; return this.settings; } },
  Search: {
    isBusy: () => false,
    activeMatch: { video_path: 'D:/video.mp4', video_name: '素材', fps: 25,
      start_frame: 98, end_frame: 252, original_start_frame: 100, original_end_frame: 250 },
    getActiveMatch() { return this.activeMatch; },
    getPreviewSourceFrame: () => 60,
    loadThumbnail: (img, url) => { img.src = url; },
    captureFrame: async () => { if (captureError) throw captureError; return { ...frame }; },
    getRecipe: () => recipe,
    runVisual: async (payload, scope, label) => {
      requests.push({ kind: 'visual', payload, scope, label });
      recipe = { kind: 'visual', payload };
      return { ok: true, count: 3 };
    },
    runFrameText: async (query, payload, scope, threshold) => {
      requests.push({ kind: 'text', query, payload, scope, threshold });
      recipe = { kind: 'text', payload };
      return { ok: true, count: 4 };
    },
    cancel: () => { cancelCount += 1; },
  },
  Api: { previewUrl: (video, frameNo) => `preview:${video}#${frameNo}`, describeFrame: (payload, options) => { requests.push({ kind: 'describe', payload, options }); return describe(payload, options); } },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/frameSearch.js'), 'utf8') + '\nthis.FrameSearch = FrameSearch;', context);
const { FrameSearch } = context;
const config = { visualAgg: 'mean' };
FrameSearch.init({ canSearch: () => true,
  resolveScope: async () => ({ config, paths: new Set(['D:/video.mp4']) }),
  toast: (value) => toasts.push(value) });
el('threshold').value = '18';
const flush = () => new Promise(setImmediate);

async function main() {
  await FrameSearch.visual();
  const visual = requests.at(-1);
  assert.strictEqual(visual.payload.image_base64, frame.dataUrl);
  assert.strictEqual(visual.payload.source_video_path, frame.videoPath);
  assert.strictEqual(visual.payload.source_frame, 75, '使用捕获的源帧位置');
  assert.strictEqual(visual.scope.config.visualAgg, 'max');
  assert.strictEqual(config.visualAgg, 'mean', '单帧聚合不能改写全局配置');
  assert.strictEqual(visual.payload.video_path, undefined, '搜索只编码截图，不再抽片段帧');
  assert.strictEqual(FrameSearch.isBusy(), false);

  let release;
  context.Search.captureFrame = () => new Promise((resolve) => { release = resolve; });
  const delayed = FrameSearch.visual();
  await flush();
  assert(FrameSearch.isBusy());
  FrameSearch.cancel();
  release({ ...frame });
  await delayed;
  assert.strictEqual(requests.length, 1, '取消后的迟到截图不能发起搜索');
  assert.strictEqual(cancelCount, 1);
  assert.strictEqual(FrameSearch.isBusy(), false);
  context.Search.captureFrame = async () => { if (captureError) throw captureError; return { ...frame }; };
  context.eagle.library.path = 'library';
  captureError = new Error('画面尚未加载');
  await FrameSearch.visual();
  assert.strictEqual(toasts.at(-1), '画面尚未加载');
  assert.strictEqual(FrameSearch.isBusy(), false);
  console.log('single-frame visual capture, cancellation and errors passed');

  // 找接续画面：片段结尾取原始帧边界内最后 N 秒；播放头模式以播放头为终点。
  const match = context.Search.activeMatch;
  assert.deepStrictEqual({ ...FrameSearch.continuationRange(match, 'end', 1) }, { start: 226, end: 250, fps: 25 });
  assert.deepStrictEqual({ ...FrameSearch.continuationRange(match, 'start', 1) }, { start: 100, end: 124, fps: 25 });
  assert.deepStrictEqual({ ...FrameSearch.continuationRange(match, 'start', 10) }, { start: 100, end: 250, fps: 25 });
  assert.deepStrictEqual({ ...FrameSearch.continuationRange(match, 'end', 10) }, { start: 100, end: 250, fps: 25 }, '不超出片段起点');
  assert.deepStrictEqual({ ...FrameSearch.continuationRange(match, 'playhead', 2, 30) }, { start: 0, end: 30, fps: 25 });
  assert.throws(() => FrameSearch.continuationRange(match, 'playhead', 1, null), /播放头/);

  config.visualAgg = 'mean';
  await FrameSearch.continuation();
  let request = requests.at(-1);
  assert.strictEqual(request.kind, 'visual');
  assert.strictEqual(request.payload.video_path, 'D:/video.mp4');
  assert.strictEqual(request.payload.start_frame, 226);
  assert.strictEqual(request.payload.end_frame, 250);
  assert.strictEqual(request.payload.image_base64, undefined, '按区间抽帧，不截图');
  assert.strictEqual(request.scope.config.visualAgg, 'max');
  assert.strictEqual(config.visualAgg, 'mean', '接续搜索不能改写全局配置');
  assert(request.label.startsWith('接续「'));

  context.Config.settings = { continuationMode: 'playhead', continuationSeconds: 1 };
  await FrameSearch.continuation();
  request = requests.at(-1);
  assert.strictEqual(request.payload.start_frame, 36);
  assert.strictEqual(request.payload.end_frame, 60);

  context.Search.activeMatch = null;
  await FrameSearch.continuation();
  assert.strictEqual(toasts.at(-1), '请先打开一个片段预览');
  assert.strictEqual(FrameSearch.isBusy(), false);
  console.log('continuation range search passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
