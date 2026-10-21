/* 真实包导入与浏览器渲染安全回归；所有网络被拦截，无真实素材或服务请求。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-search-security-'));
  const library = 'D:/security-fixture.library';
  const marker = '<img src="missing" onerror="window.__securityMarker=41">';
  const match = { video_path: 'D:/fixture/demo.mp4', video_name: marker, start_frame: 3, end_frame: 25,
    fps: 25, similarity: 12, start: marker, end: marker, duration_display: marker,
    matched_queries: [{ text: marker, similarity: 12 }, { text: 'ordinary', similarity: 11 }] };
  const payload = JSON.stringify({ version: 2, library, categories: [], imported: [],
    entries: [{ id: 'audit', name: marker, view: {}, matches: [match] }] });
  const bundle = JSON.stringify({ format: 'eagle-warehouse', version: 1, library,
    checksum: crypto.createHash('sha256').update(payload).digest('hex'), payload });
  const storeContext = { require };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'js/archiveStore.js'), 'utf8') + '\nthis.Archive = ArchiveStore;', storeContext);
  let browser;
  try {
    const archive = storeContext.Archive.open(fixture, library);
    assert.strictEqual(archive.importBundle(bundle), 1);
    const reopened = storeContext.Archive.open(fixture, library);
    const stored = await reopened.hydrateEntry(reopened.list().entries[0]);
    assert.strictEqual(stored.matches[0].start, marker, '旧合法包保持兼容，安全在显示边界保证');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent('<html><body><video id="video"></video><div id="info"></div><div id="panel"></div><div id="status"></div><button id="retry"></button><button id="locate"></button></body></html>');
    await page.evaluate(() => {
      window.Bridge = { itemForPath: () => null, normalizePath: (value) => value };
      window.Api = { previewUrl: () => 'blocked-preview', clipUrl: () => 'blocked-clip' };
      window.ArchiveStore = { sceneKey: (m) => String(m.start_frame) };
    });
    const source = fs.readFileSync(path.join(root, 'js/search.js'), 'utf8')
      .replace('  return {\n    bindDom,', `
  window.securityFixture = { buildCard, openPreview, setup() {
    el.previewVideo = document.getElementById('video'); el.previewInfo = document.getElementById('info');
    el.previewPanel = document.getElementById('panel'); el.previewStatus = document.getElementById('status');
    el.previewRetry = document.getElementById('retry'); el.btnLocate = document.getElementById('locate');
  } };
  return {\n    bindDom,`);
    await page.addScriptTag({ content: source });
    await page.evaluate((m) => {
      window.securityFixture.setup();
      document.body.appendChild(window.securityFixture.buildCard(m, 0, 0));
      window.securityFixture.openPreview(m);
    }, stored.matches[0]);
    assert.strictEqual(await page.locator('img[onerror]').count(), 0, '导入后重开的卡片和预览不可创建注入元素');
    assert.strictEqual(await page.evaluate(() => window.__securityMarker), undefined, '无害注入标记不可执行');
    assert((await page.locator('.sub').textContent()).includes(marker), '卡片时间显示为原样文本');
    assert((await page.locator('#info').textContent()).includes(`（${marker}）`), '预览时长显示为原样文本');
    console.log('imported warehouse card and preview browser security regression passed');
  } finally {
    if (browser) await browser.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
