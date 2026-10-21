const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.dataset = {};
    this.value = ''; this.checked = false; this.attributes = {};
    this.classList = { toggle() {}, add() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) {
    this.children = children;
    if (this.tagName === 'SELECT') this.value = children[0]?.value || '';
  }
  addEventListener(type, listener) { this.events[type] = listener; }
  setAttribute(key, value) { this.attributes[key] = value; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
  fire(type, more = {}) { return this.events[type]?.({ target: this, preventDefault() {}, stopPropagation() {}, ...more }); }
}
const elements = new Map();
const $ = (id) => {
  if (!elements.has(id)) { const element = new Element(id === 'manual-add-target' ? 'select' : 'div'); element.id = id; elements.set(id, element); }
  return elements.get(id);
};
const match = (i) => ({ eagleItemId: `id-${i}`, video_name: `片段${i}`, video_path: `D:/fixture/${i}.mp4`,
  start_frame: i * 25, end_frame: i * 25 + 50, fps: 25, similarity: 10 });
let selected = Array.from({ length: 125 }, (_, i) => match(i));
let targets = [{ id: 'plain', name: '同名', summary: { matches: 1 }, matches: [match(1)], revision: 2 },
  { id: 'star', name: '同名', favorite: true, categoryId: 'cat', summary: { matches: 1 },
    matches: [{ ...match(2), similarity: 30.251 }], revision: 2 }];
const clone = (value) => JSON.parse(JSON.stringify(value));
const events = [];
let writeFail = false;
let additions;
const undoToken = {};
const archive = {
  list: () => ({ entries: clone(targets), categories: [{ id: 'cat', name: '偏好分类' }] }),
  hydrateEntry: async (entry) => entry,
  addMatches: (id, items) => {
    if (writeFail) throw new Error('write failed');
    additions = items; events.push('write');
    const entry = { ...targets.find((target) => target.id === id), revision: 3 };
    return { entry, undoToken, undoBytes: 123, added: items.length, rescored: items.length, restored: 0 };
  },
};
const context = {
  console, document: { getElementById: $, createElement: (tag) => new Element(tag), addEventListener() {} },
  Option: class extends Element { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } },
  ArchiveStore: { open: () => archive, sceneKey: (m) => `${m.eagleItemId}-${m.start_frame}`,
    sceneLookup: vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/archiveStore.js'), 'utf8')
      + '\nArchiveStore.sceneLookup;', { require }) },
  Config: { pluginPath: () => 'fixture' }, eagle: { library: { path: 'library' } },
  localStorage: { getItem: () => 'plain', setItem() { throw new Error('quota exceeded'); } },
  Bridge: { itemForPath: () => null }, Api: { previewUrl: () => 'poster' }, SearchRecipe: { clone },
  Search: { getSelectedMatches: () => selected, pausePreview() {}, loadThumbnail() {}, clearSelection() { events.push('clear'); } },
};
const source = fs.readFileSync(path.join(__dirname, '../js/manualAdd.js'), 'utf8')
  .replace('  return { init, editScores };', '  this.inspectSession = () => session;\n  return { init, editScores };');
vm.runInNewContext(source + '\nthis.Manual = ManualAdd;', context);
context.Manual.init({ checkIdle() {}, validateSource() {}, toast() {}, onCommitted(entry, token, metadata) {
  events.push('commit-hook'); assert.strictEqual(token, undoToken); assert.strictEqual(metadata.undoBytes, 123);
  assert.strictEqual(metadata.beforeRevision, 2); assert.strictEqual(metadata.library, 'library');
  assert.strictEqual(entry.revision, 3);
} });

async function main() {
  $('btn-topic-add').fire('click');
  assert.strictEqual($('manual-add-only-empty').checked, true);
  assert.strictEqual($('manual-add-target').children[1].value, 'star', '星标目标优先');
  assert($('manual-add-target').children[1].textContent.includes('★ 同名 · 偏好分类'), '同名目标可通过分类辨认');
  assert.strictEqual($('manual-add-overview').children.length, 60, '总览首批有界');
  $('manual-add-overview-next').fire('click');
  assert.strictEqual($('manual-add-overview').children[0].dataset.index, '60');
  $('manual-add-overview').children[3].fire('click');
  assert.strictEqual(context.inspectSession().index, 63, '总览点击跳到指定片段');
  $('manual-add-score').value = '12.34567'; $('manual-add-score').fire('input');
  $('manual-add-next-empty').fire('click');
  assert.strictEqual(context.inspectSession().index, 64);
  $('manual-add-target').value = 'star'; await $('manual-add-target').fire('change');
  assert($('manual-add-impact').textContent.includes('已收录 1'));
  assert.strictEqual(context.inspectSession().existing[2].similarity, 30.251);
  $('manual-add-existing-mode').value = 'rescore'; $('manual-add-existing-mode').fire('change');
  $('manual-add-score').value = '12.34567'; $('manual-add-score').fire('input');
  $('manual-add-bulk-score').value = '0'; $('manual-add-bulk-apply').fire('click');
  assert.strictEqual(context.inspectSession().scores[64].value, 12.34567, '默认批量不覆盖单独填好的完整精度');
  assert.strictEqual(context.inspectSession().scores[0].value, 0, '零分可批量填写空白');
  assert.strictEqual($('manual-add-next-empty').disabled, true);
  $('manual-add-bulk-top').fire('click');
  assert.strictEqual(context.inspectSession().scores[0].value, 0, '默认批量置顶也不覆盖已有值');
  $('manual-add-only-empty').checked = false; $('manual-add-only-empty').fire('change');
  $('manual-add-bulk-top').fire('click');
  assert(context.inspectSession().scores.every((score) => score.value === 30.251 && score.mode === 'top'));
  assert($('manual-add-overview').children[4].children[2].textContent.includes('固定置顶'), '总览展示固定置顶与精度');
  writeFail = true; $('manual-add-form').fire('submit');
  assert.strictEqual($('manual-add-dialog').open, true); assert.strictEqual(events.length, 0, '写失败不登记撤销/清选择');
  writeFail = false; $('manual-add-form').fire('submit');
  assert.deepStrictEqual(events, ['write', 'commit-hook', 'clear'], '撤销登记回调先于页面选择变化');
  assert.strictEqual(additions.length, 125); assert.strictEqual($('manual-add-dialog').open, false);

  selected = [match(2)];
  $('btn-topic-add').fire('click');
  await new Promise(setImmediate);
  assert.strictEqual($('manual-add-target').value, 'star', '成功收录后按库记住目标');
  assert.strictEqual($('manual-add-existing-mode').value, 'keep');
  assert.strictEqual($('manual-add-score').disabled, true, '默认保留重复片段原分');
  assert.strictEqual($('manual-add-submit').disabled, false, '全部重复无需填写分数');
  assert($('manual-add-existing-info').textContent.includes('30.251'));
  $('manual-add-form').fire('submit');
  assert.strictEqual(additions[0].keepExisting, true);
  assert.strictEqual(additions[0].score, null);
  context.eagle.library.path = 'another-library';
  $('btn-topic-add').fire('click');
  assert.notStrictEqual($('manual-add-target').value, 'star', '不同库不沿用最近目标');
  $('manual-add-cancel').fire('click');
  context.eagle.library.path = 'library';

  const edited = { ...targets[1], matches: [{ ...match(1), manualScore: { value: 99.123456, mode: 'top' } }, match(2)] };
  selected = edited.matches; targets = [edited];
  context.Manual.editScores(edited);
  assert.strictEqual($('manual-add-only-empty').checked, true, '新面板重置为保护已有评分');
  assert.strictEqual($('manual-add-score').value, '99.123456', '编辑预填完整人工精度');
  $('manual-add-next-empty').fire('click');
  assert.strictEqual(context.inspectSession().index, 1);
  $('manual-add-prev').fire('click');
  assert.strictEqual($('manual-add-score').value, '99.123456', '切换总览与左右导航不丢精度');
  $('manual-add-bulk-score').value = '8.8'; $('manual-add-bulk-apply').fire('click');
  assert.strictEqual(context.inspectSession().scores[0].value, 99.123456);
  assert.strictEqual(context.inspectSession().scores[1].value, 8.8, '编辑只填写非人工评分片段');
  $('manual-add-cancel').fire('click');
  assert.strictEqual($('manual-add-overview').children.length, 0, '取消清理总览');
  console.log('manual score overview, protected bulk fill, unscored navigation and commit callback passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
