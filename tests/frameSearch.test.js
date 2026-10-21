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
let describe = async () => ({ ok: true, data: { success: true, prompts: ['城市街道', '夜景'] } });
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
let successQuery;
FrameSearch.init({ canSearch: () => true,
  resolveScope: async () => ({ config, paths: new Set(['D:/video.mp4']) }),
  toast: (value) => toasts.push(value), onTextSuccess: (query) => { successQuery = query; } });
el('threshold').value = '18';
const submit = () => el('frame-text-form').events.submit({ preventDefault() {} });
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

  await FrameSearch.text();
  assert(el('frame-text-dialog').open);
  assert.strictEqual(requests.at(-1).payload.image_base64, visual.payload.image_base64, '两种搜索使用同一幅截图');
  assert.strictEqual(el('frame-text-query').value, '城市街道');
  el('frame-text-prompts').children[1].events.click();
  assert.strictEqual(el('frame-text-query').value, '夜景');
  el('frame-text-query').value = '编辑后的夜晚城市';
  await submit();
  assert.strictEqual(requests.at(-1).kind, 'text');
  assert.strictEqual(requests.at(-1).query, '编辑后的夜晚城市');
  assert.strictEqual(requests.at(-1).threshold, 18);
  assert.strictEqual(successQuery, '编辑后的夜晚城市');
  assert.strictEqual(cancelCount, 0, '成功关闭不能取消已完成搜索');
  assert.strictEqual(el('frame-text-dialog').open, false);

  let release;
  describe = async () => new Promise((resolve) => { release = resolve; });
  const delayed = FrameSearch.text();
  await flush();
  const oldRequest = requests.at(-1);
  assert(FrameSearch.isBusy());
  el('frame-text-cancel').events.click();
  assert(oldRequest.options.signal.aborted);
  assert.strictEqual(FrameSearch.isBusy(), false);
  describe = async () => ({ ok: true, data: { success: true, prompts: ['新画面'] } });
  await FrameSearch.text();
  release({ ok: true, data: { success: true, prompts: ['旧画面'] } });
  await delayed;
  assert.strictEqual(el('frame-text-query').value, '新画面', '取消后的迟到描述不能覆盖新对话框');
  el('frame-text-cancel').events.click();

  describe = async () => ({ ok: false, data: { error: '模型不可用' } });
  await FrameSearch.text();
  assert.strictEqual(el('frame-text-status').textContent, '模型不可用');
  assert.strictEqual(FrameSearch.isBusy(), false);
  assert.strictEqual(el('frame-text-submit').disabled, true);
  el('frame-text-query').value = '手动描述';
  el('frame-text-query').events.input();
  assert.strictEqual(el('frame-text-submit').disabled, false);
  context.eagle.library.path = 'other-library';
  const before = requests.length;
  await submit();
  assert.strictEqual(requests.length, before, '换库后不能提交旧截图');
  assert(el('frame-text-status').textContent.includes('素材库已切换'));
  context.eagle.library.path = 'library';
  el('frame-text-cancel').events.click();

  captureError = new Error('画面尚未加载');
  await FrameSearch.visual();
  assert.strictEqual(toasts.at(-1), '画面尚未加载');
  assert.strictEqual(FrameSearch.isBusy(), false);
  console.log('single-frame visual/text flows, cancellation, errors and library guards passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
