const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const plugin = fs.readFileSync(path.join(root, 'js', 'plugin.js'), 'utf8');
const search = fs.readFileSync(path.join(root, 'js', 'search.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');

const toolbar = html.match(/<section class="toolbar">([\s\S]*?)<\/section>/)?.[1] || '';
const viewBar = html.match(/<section id="view-bar"[\s\S]*?<\/section>/)?.[0] || '';
const modes = [...html.matchAll(/data-index-mode="([^"]+)"/g)].map((match) => match[1]);

assert(toolbar.includes('id="btn-archives"'), '存档入口必须位于初始可见的工具栏');
assert(!viewBar.includes('id="btn-archives"'), '存档入口不能继续放在搜索后才显示的视图栏');
assert(html.includes('id="btn-index-primary"'), '缺少索引主按钮');
assert(html.includes('id="btn-index-menu-toggle"'), '缺少索引下拉按钮');
assert.deepStrictEqual(modes, ['all', 'folder', 'selected']);
assert(plugin.includes("startIndexing(indexMode)"), '索引主按钮必须执行当前选中的模式');
assert(!plugin.includes("$('btn-index-all')"), '旧的三个独立索引按钮事件不应残留');
assert(search.includes("card.addEventListener('contextmenu'"), '结果卡片必须支持右键选中');
assert(css.includes('.card.selected'), '右键选中后必须有清晰的卡片状态');
assert(/\.card \.hover-video\s*\{[\s\S]*?opacity:\s*0/.test(css),
  '悬停视频首帧就绪前必须保持透明，让缩略图继续显示');
assert(css.includes('.card .hover-video.ready'), '首帧就绪后才允许显示悬停视频');
assert(search.includes('requestVideoFrameCallback'), '悬停预览应等待浏览器实际绘制视频帧');
assert(search.includes('matchThumbnails.get(match)') && search.includes('if (poster) video.poster = poster;'),
  '主预览加载期间应复用已加载的场景缩略图作封面，不额外请求抽帧');
assert(search.includes("video.removeAttribute('poster')"),
  '已解码的同源播放器必须移除封面，避免封面请求打断原视频');

console.log('toolbar, archive and preview interaction UI tests passed');
