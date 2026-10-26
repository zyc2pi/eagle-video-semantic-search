const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class Element {
  constructor() { this.events = {}; this.value = ''; this.children = []; this.dataset = {}; this.classList = { toggle() {} }; }
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
  Search: {
    isBusy: () => false,
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
  Api: { describeFrame: (payload, options) => { requests.push({ kind: 'describe', payload, options }); return describe(payload, options); } },
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
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
