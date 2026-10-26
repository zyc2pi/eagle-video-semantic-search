/* 独立浏览器端到端测试。需通过 NODE_PATH 提供 playwright；不访问用户的 Eagle 库或配置。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let page;
  let fixtureDir;
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.fulfill({ status: 200, body: '' }));
    await page.goto('http://warehouse.fixture/');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
    await page.setContent(html);
    await page.addStyleTag({ path: path.join(root, 'css/style.css') });
    await page.evaluate(() => {
      const files = new Map();
      const directories = new Set();
      let nextId = 0;
      window.__files = files;
      window.__requests = [];
      window.__describeRequests = [];
      window.__round = 0;
      window.__fail = false;
      window.__writeFail = false;
      window.__sourceMissing = false;
      const fsMock = {
        existsSync: (file) => files.has(file) || directories.has(file) || file.startsWith('D:/fixture/'),
        readFileSync: (file) => { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
        writeFileSync: (file, value, options) => {
          if (options?.flag === 'wx' && files.has(file)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
          files.set(file, value);
        },
        statSync: (file) => {
          if (!files.has(file) && !file.startsWith('D:/fixture/')) throw new Error('ENOENT');
          return { size: String(files.get(file) || 'fixture').length, mtimeMs: 1, isFile: () => true };
        },
        promises: { readFile: async (file) => { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); } },
        renameSync: (from, to) => {
          if (window.__writeFail) throw new Error('模拟写盘失败');
          files.set(to, files.get(from)); files.delete(from);
        },
        mkdirSync: (dir) => directories.add(dir),
        unlinkSync: (file) => files.delete(file),
        readdirSync: (dir) => [...files.keys()].filter((file) => file.startsWith(`${dir}/`)).map((file) => file.slice(dir.length + 1)),
      };
      window.require = (module) => {
        if (module === 'fs') return fsMock;
        if (module === 'process') return { pid: 12345, kill: (pid) => { if (pid !== 12345) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); } };
        if (module === 'path') return { join: (...parts) => parts.join('/'), resolve: (value) => value, sep: '/',
          isAbsolute: (value) => /^(?:[A-Z]:|\/)/i.test(value),
          relative: (from, to) => to === from ? '' : to.startsWith(from + '/') ? to.slice(from.length + 1) : '../../' + to };
        if (module === 'crypto') return { randomUUID: () => `test-id-${++nextId}`, createHash: () => ({ update: (value) => ({ digest: () => {
          let hash = 2166136261;
          for (const ch of String(value)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
          return hash.toString(16).padStart(8, '0').repeat(8);
        } }) }) };
        throw new Error(`Unexpected module: ${module}`);
      };
      const now = Date.now();
      window.__items = [
        { id: 'a', name: '城市街道', filePath: 'D:/fixture/a.mp4', ext: 'mp4', importedAt: now - 86400000, duration: 1000, folders: ['parent'], thumbnailURL: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="400" height="200"%3E%3Crect width="400" height="200" fill="%23465f73"/%3E%3C/svg%3E' },
        { id: 'b', name: '旧素材', filePath: 'D:/fixture/b.mp4', ext: 'mp4', importedAt: now - 86400000 * 900, duration: 100, folders: ['parent'] },
        { id: 'c', name: '新加入夜景', filePath: 'D:/fixture/c.mp4', ext: 'mp4', importedAt: now, duration: 100, folders: ['child'] },
      ];
      const folders = [{ id: 'parent', name: '风景', children: [{ id: 'child', name: '夜景', children: [] }] }];
      window.__createdFolders = [];
      window.__saves = [];
      window.__items.forEach((item) => {
        item.tags = ['原标签'];
        item.save = async () => { if (window.__organizeFail) throw new Error('模拟素材保存失败'); window.__saves.push(item.id); };
      });
      window.eagle = {
        drag: { startDrag: async (paths) => { (window.__drags ||= []).push(paths); } },
        dialog: { showOpenDialog: async () => window.__directoryResult || { canceled: false, filePaths: ['D:/edit-clips'] } },
        library: { path: 'D:/fixture.library', info: async () => ({ folders }) },
        app: { isDarkColors: () => true, show: async () => {} },
        folder: { getAll: async () => folders, getSelected: async () => folders,
          create: async ({ name }) => {
            const folder = { id: `created-${window.__createdFolders.length}`, name };
            window.__createdFolders.push(folder); return folder;
          },
          getByIds: async (ids) => [...folders, ...folders[0].children, ...window.__createdFolders].filter((f) => ids.includes(f.id)) },
        item: { getAll: async () => window.__items, getSelected: async () => [window.__items[0]],
          get: async ({ folders: ids }) => window.__items.filter((item) => item.folders.some((id) => ids.includes(id))),
          getById: async (id) => window.__sourceMissing ? null : window.__items.find((item) => item.id === id),
          select: async () => {},
        },
        onPluginCreate: (callback) => { window.__create = callback; },
        onPluginShow: (callback) => { window.__show = callback; },
        onThemeChanged: () => {}, onLibraryChanged: () => {},
      };
      window.Service = { ensure: async (callback) => {
        window.__serviceCallback = callback;
        if (!window.__delayService) callback('online', '测试搜索服务已连接');
      } };
      const match = (id, frame, duration = 4) => ({ video_path: `D:/fixture/${id}.mp4`, video_name: id,
        original_start_frame: frame, original_end_frame: frame + duration * 25,
        start_frame: frame - 2, end_frame: frame + duration * 25 + 2,
        duration_seconds: duration, similarity: 20, fps: 25, start: '00:00:01', end: '00:00:05' });
      window.fetch = async (url, init) => {
        let result;
        if (url.includes('/indexes')) result = { indexes: [{ model: 'qihoo360-fg-clip2-base', name: 'eagle_v2_fixture_qihoo360-fg-clip2-base.lance', path: 'fixture.lance' }] };
        else if (url.endsWith('/health')) result = { success: true, protocol_version: 2, capabilities: { library_identity: true, index_jobs_v2: true, edit_clip: true } };
        else if (url.endsWith('/prepare_edit_clip')) {
          (window.__clipRequests ||= []).push(JSON.parse(init.body));
          if (window.__clipDelay) await new Promise((resolve) => { window.__releaseClip = resolve; });
          if (window.__clipFail) return { ok: false, status: 500, json: async () => ({ success: false, error: '模拟片段生成失败' }) };
          files.set('D:/edit-clips/clip.mp4', 'prepared video');
          result = { success: true, output_path: 'D:/edit-clips/clip.mp4' };
        }
        else if (url.endsWith('/libraries/resolve')) result = { success: true, library: { id: 'fixture', path: 'D:/fixture.library', index_name: 'eagle_v2_fixture' } };
        else if (url.includes('/index/jobs')) result = { jobs: [] };
        else if (url.includes('/index/contents')) result = { video_paths: window.__items.map((i) => i.filePath) };
        else if (url.endsWith('/describe')) {
          const body = JSON.parse(init.body);
          window.__describeRequests.push({ url, body });
          if (window.__describeDelay) {
            window.__describeDelay = false;
            window.__describeAborted = false;
            init.signal?.addEventListener('abort', () => { window.__describeAborted = true; }, { once: true });
            await new Promise((resolve) => { window.__releaseDescribe = resolve; });
          }
          if (window.__describeFail) return { ok: false, status: 500,
            json: async () => ({ success: false, error: '模拟画面模型失败' }) };
          result = { success: true, prompts: ['a colorful moving pattern', 'bright shapes on a dark background'] };
        }
        else if (url.includes('/search')) {
          const body = JSON.parse(init.body);
          window.__requests.push({ url, body });
          if (window.__delayNext) {
            window.__delayNext = false;
            await new Promise((resolve) => { window.__releaseSearch = resolve; });
          }
          if (window.__fail) return { ok: false, status: 500, json: async () => ({ success: false, error: '模拟搜索失败' }) };
          let matches = Array.from({ length: 70 }, (_, i) => match('a', i * 150 + 5));
          matches.push(match('a', 20000, 1), match('a', 20100, 1), match('b', 5));
          if (window.__round > 0) {
            matches.shift(); matches.push(match('c', 5), match('a', 30000));
          }
          if (window.__round === 2) matches = [];
          if (window.__scoreBoostFrame != null) matches.forEach((m) => {
            if (m.original_start_frame === window.__scoreBoostFrame) m.similarity = 40;
          });
          if (body.allowed_video_paths) matches = matches.filter((m) => body.allowed_video_paths.includes(m.video_path.replace(/\//g, '\\').toLowerCase()));
          result = { success: true, matches };
        } else result = { success: true };
        return { ok: true, status: 200, json: async () => result };
      };
    });
    for (const name of ['config', 'api', 'eagleBridge', 'searchRecipe', 'archiveStore', 'topicUndo', 'coverFrame', 'indexer', 'searchCache', 'search', 'mediaDrag', 'frameSearch', 'folderTree', 'manualAdd', 'topicRelations', 'warehouse', 'shortcuts', 'plugin']) {
      await page.addScriptTag({ path: path.join(root, 'js', `${name}.js`) });
    }
    await page.evaluate(async (delay) => {
      window.__delayService = delay;
      window.__create({ path: '/fixture-plugin' }); await window.__show();
    }, !!process.env.WAREHOUSE_LAYOUT_ONLY);
    if (process.env.WAREHOUSE_LAYOUT_ONLY) {
      await runCompactLayoutSmoke(page);
      await runMediaDragSmoke(page);
      await runResultRelationsSmoke(page);
      assert.deepStrictEqual(errors, []);
      console.log('compact menus, right inspector, filters, navigation, original drag and theme comparison smoke passed');
      return;
    }
    if (process.env.WAREHOUSE_DRAG_ONLY) {
      await runMediaDragSmoke(page);
      assert.deepStrictEqual(errors, []);
      console.log('original drag, deduplication, missing file and library guards smoke passed');
      return;
    }
    if (process.env.WAREHOUSE_RELATIONS_ONLY) {
      await runResultRelationsSmoke(page);
      assert.deepStrictEqual(errors, []);
      console.log('result combination filters, membership and topic comparison browser smoke passed');
      return;
    }
    assert.strictEqual(await page.locator('.search-options #search-time').count(), 1);
    assert.strictEqual(await page.locator('#btn-visual-selected').count(), 0);
    await page.locator('#btn-settings').click();
    await page.locator('#cfg-visual-threshold').fill('0');
    await page.locator('#btn-save-settings').click();
    assert.strictEqual(await page.evaluate(() => Config.get().visualThreshold), 0, '合法零阈值不被默认值覆盖');
    await page.locator('#btn-settings').click();
    await page.locator('#cfg-visual-threshold').fill('40');
    await page.evaluate(() => { window.__writeFail = true; });
    await page.locator('#btn-save-settings').click();
    assert.strictEqual(await page.evaluate(() => Config.get().visualThreshold), 0, '写失败保留内存');
    assert.strictEqual(await page.evaluate(() => document.getElementById('settings-dialog').open), true);
    assert((await page.locator('#settings-error').textContent()).includes('保存配置失败'));
    await page.evaluate(() => { window.__writeFail = false; });
    await page.locator('#btn-save-settings').click();
    assert.strictEqual(await page.evaluate(() => Config.get().visualThreshold), 40);
    await page.locator('#query').fill('城市夜景');
    await revealControl(page, '#search-time');
    await page.locator('#search-time').selectOption('6');
    await page.locator('#btn-search').click();
    await page.waitForFunction(() => Search.getRawMatches().length === 72);
    assert(await page.locator('#btn-selection-tag').isDisabled());
    await closeCompactMenus(page);
    await page.locator('#results .card').nth(0).click({ button: 'right' });
    await closeCompactMenus(page);
    await page.locator('#results .card').nth(1).click({ button: 'right' });
    assert((await page.locator('#selection-count').textContent()).includes('2 个片段 / 1 个素材'));
    await revealControl(page, '#btn-clear-selection');
    await page.locator('#btn-clear-selection').click();
    assert.strictEqual(await page.evaluate(() => Search.getSelectedMatches()), null);
    assert.strictEqual(await page.locator('#results .card.selected, #results .pick:checked').count(), 0);
    assert(await page.locator('#btn-clear-selection').isDisabled());
    assert(await page.locator('#btn-selection-tag').isDisabled());
    assert(await page.locator('#btn-selection-folder').isDisabled());
    await closeCompactMenus(page);
    await page.locator('#results .card').nth(0).click({ button: 'right' });
    await closeCompactMenus(page);
    await page.locator('#results .card').nth(1).click({ button: 'right' });
    await page.locator('#query').fill('尚未执行的搜索');
    await revealControl(page, '#btn-selection-tag');
    await page.locator('#btn-selection-tag').click();
    assert.strictEqual(await page.locator('#organize-name').inputValue(), '城市夜景');
    await page.locator('#organize-cancel').click();
    assert.deepStrictEqual(await page.evaluate(() => window.__saves), []);
    await revealControl(page, '#btn-selection-tag');
    await page.locator('#btn-selection-tag').click();
    await page.locator('#organize-name').fill('夜景收藏');
    await page.evaluate(() => { window.__organizeFail = true; });
    await page.locator('#organize-submit').click();
    await page.waitForFunction(() => document.getElementById('organize-status').textContent.includes('失败 1 个'));
    assert.strictEqual(await page.locator('#organize-submit').textContent(), '仅重试失败项');
    await page.evaluate(() => { window.__organizeFail = false; });
    await page.locator('#organize-submit').click();
    await page.waitForFunction(() => document.getElementById('organize-status').textContent.includes('成功 1 个'));
    assert.deepStrictEqual(await page.evaluate(() => window.__items[0].tags), ['原标签', '夜景收藏']);
    assert.deepStrictEqual(await page.evaluate(() => window.__saves), ['a']);
    await page.locator('#organize-cancel').click();
    await revealControl(page, '#btn-selection-folder');
    await page.locator('#btn-selection-folder').click();
    assert.strictEqual(await page.locator('#organize-name').inputValue(), '城市夜景');
    await page.locator('#organize-name').fill('夜景素材');
    await page.locator('#organize-submit').click();
    await page.waitForFunction(() => document.getElementById('organize-status').textContent.includes('成功 1 个'));
    assert.deepStrictEqual(await page.evaluate(() => window.__createdFolders.map((f) => f.name)), ['夜景素材']);
    assert.deepStrictEqual(await page.evaluate(() => window.__items[0].folders), ['parent', 'created-0']);
    await page.locator('#organize-cancel').click();
    await page.locator('#query').fill('城市夜景');
    await revealControl(page, '#view-min-dur');
    await page.locator('#view-min-dur').fill('3');
    await revealControl(page, '#view-min-dur');
    await page.locator('#view-min-dur').dispatchEvent('change');
    assert.strictEqual(await page.evaluate(() => Search.getAllMatches().length), 70);
    assert((await page.locator('#results .card').count()) < 70, '测试必须覆盖未加载到 DOM 的结果');
    await revealControl(page, '#threshold');
    await page.locator('#threshold').fill('25');
    await page.locator('#btn-save-results').click();
    await page.locator('#entry-name').fill('城市夜景精选');
    await page.locator('#entry-submit').click();
    await page.waitForFunction(() => document.body.dataset.topic === 'true');
    await closeCompactMenus(page);
    await page.locator('#results .card .pick').first().check();
    await revealControl(page, '#btn-selection-tag');
    await page.locator('#btn-selection-tag').click();
    assert.strictEqual(await page.locator('#organize-name').inputValue(), '城市夜景精选');
    await page.locator('#organize-cancel').click();
    const saved = await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries[0]);
    assert.strictEqual(saved.matches.length, 70);
    assert.strictEqual(saved.recipe.config.threshold, 11, '搜索之后拖动滑条不能污染已完成搜索的条件');
    assert.strictEqual(saved.recipe.time.mode, '6');
    await page.locator('#topic-back').click();
    await page.locator('#warehouse-categories').click();
    await page.locator('#category-name').fill('风景');
    await page.locator('#warehouse-category-form button[type=submit]').click();
    await page.locator('#category-close').click();
    await page.locator('.warehouse-card-actions').first().getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('#entry-name').fill('城市与夜景');
    const cat = await page.locator('#entry-category option').last().getAttribute('value');
    await page.locator('#entry-category').selectOption(cat);
    await page.locator('#entry-submit').click();
    await page.waitForFunction(() => !document.getElementById('warehouse-editor').open);
    assert.strictEqual(await page.evaluate(() => window.__requests.length), 1, '重命名和移动分类不得重新搜索');
    await page.locator('#warehouse-category').selectOption(cat);
    await page.locator('#warehouse-query').fill('城市');
    assert.strictEqual(await page.locator('.warehouse-card').count(), 1);
    const dimensions = await page.locator('.warehouse-card').boundingBox();
    assert(dimensions.height > 200 && dimensions.width > 200);
    await page.locator('.warehouse-card-open').click();
    await page.evaluate(() => { window.__round = 1; SearchCache.clear(); });
    await page.locator('#topic-update').click();
    await page.locator('#topic-changes-dialog').waitFor();
    assert.strictEqual(await page.evaluate(() => Search.getAllMatches().length), 70, '确认前保留原结果');
    const beforeCancel = await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries[0]);
    await page.locator('#topic-changes-cancel').click();
    assert.deepStrictEqual(await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries[0]), beforeCancel);
    await page.locator('#topic-update').click();
    await page.locator('#topic-changes-apply').click();
    await page.waitForFunction(() => Search.getAllMatches().length === 71);
    assert.strictEqual(await page.locator('#topic-only-new, #topic-cover-hint').count(), 0);
    const topicMeta = await page.locator('#topic-meta').textContent();
    assert(!topicMeta.includes('未分类') && !topicMeta.includes('本次新增'));
    const topicBox = await page.locator('#warehouse-topic').boundingBox();
    assert(topicBox.height < 90, '主题栏不应被说明文字撑高');
    await page.locator('#topic-back').click();
    await page.locator('.warehouse-card-open').click();
    assert.strictEqual(await page.evaluate(() => Search.getAllMatches().length), 71);
    const beforeFailure = await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries[0]);
    await page.evaluate(() => { window.__fail = true; SearchCache.clear(); });
    await page.locator('#topic-update').click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('模拟搜索失败'));
    assert.deepStrictEqual(await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries[0]), beforeFailure);
    await page.evaluate(() => { window.__fail = false; window.__writeFail = true; });
    await page.locator('#topic-update').click();
    await page.locator('#topic-changes-apply').click();
    await page.waitForFunction(() => document.getElementById('topic-changes-error')?.textContent.includes('模拟写盘失败'));
    assert.deepStrictEqual(await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries[0]), beforeFailure);
    const requestsBeforeRetry = await page.evaluate(() => window.__requests.length);
    await page.evaluate(() => { window.__writeFail = false; });
    await page.locator('#topic-changes-apply').click();
    await page.waitForFunction(() => !document.getElementById('topic-changes-dialog'));
    assert.strictEqual(await page.evaluate(() => window.__requests.length), requestsBeforeRetry, '重试写入不重新搜索');
    await revealControl(page, '#topic-edit');
    await page.locator('#topic-edit').click();
    await page.locator('#entry-threshold').fill('18');
    await page.locator('#entry-scope').selectOption('folders');
    await page.locator('#entry-folders input[value=parent]').check();
    await page.locator('#entry-submit').click();
    await page.locator('#topic-changes-dialog').waitFor();
    await page.keyboard.press('Escape');
    assert.strictEqual(await page.locator('#warehouse-editor').evaluate((element) => element.open), true, '取消预览保留条件编辑器');
    assert.strictEqual(await page.locator('#entry-threshold').inputValue(), '18');
    await page.locator('#entry-submit').click();
    await page.locator('#topic-changes-apply').click();
    await page.waitForFunction(() => !document.getElementById('warehouse-editor').open);
    const lastBody = await page.evaluate(() => window.__requests.at(-1).body);
    assert.strictEqual(lastBody.threshold, 18);
    assert.deepStrictEqual(lastBody.allowed_video_paths.sort(), ['d:\\fixture\\a.mp4', 'd:\\fixture\\c.mp4']);
    await page.evaluate(() => { window.__round = 2; SearchCache.clear(); });
    await page.locator('#topic-update').click();
    await page.locator('#topic-changes-dialog').waitFor();
    assert((await page.locator('#topic-changes-dialog').textContent()).includes('→ 0 个片段'));
    const disappeared = page.locator('#topic-changes-dialog details').filter({ has: page.locator('summary', { hasText: '消失' }) });
    await disappeared.locator('summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#topic-changes-dialog details[open] > div > p').length === 50);
    await disappeared.getByRole('button', { name: '显示更多' }).click();
    assert.strictEqual(await disappeared.locator('div > p').count(), await page.evaluate(() => Search.getRawMatches().length), '变化列表分批展示完整片段');
    await page.locator('#topic-changes-apply').click();
    await page.waitForFunction(() => document.getElementById('topic-meta').textContent.includes('0 个素材 / 0 个片段'));
    assert.strictEqual(await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries[0].matches.length), 0);
    // 单帧视觉查询保存固定截图；卡片只打开预览，不立即提交片段搜索。
    await page.locator('#topic-search').click();
    await page.evaluate(() => { window.__round = 0; SearchCache.clear(); });
    await page.locator('#btn-search').click();
    await page.waitForFunction(() => Search.getRawMatches().length > 0 && !Search.isBusy());
    await page.locator('#results .card').first().hover();
    const beforeSelectFrame = await page.evaluate(() => window.__requests.length);
    await closeCompactMenus(page);
    await page.locator('#results .similar-btn').first().click();
    assert.strictEqual(await page.evaluate(() => window.__requests.length), beforeSelectFrame, '选帧入口不立即搜索');
    await page.evaluate(() => {
      window.__originalCaptureFrame = Search.captureFrame;
      Search.captureFrame = async () => ({ dataUrl: 'data:image/jpeg;base64,fixture-single-frame',
        frame: 12, fps: 25, videoPath: 'D:/fixture/a.mp4', videoName: 'a' });
    });
    await page.locator('#btn-frame-visual').click();
    await page.waitForFunction(() => Search.getRecipe()?.kind === 'visual');
    await page.evaluate(() => { Search.captureFrame = window.__originalCaptureFrame; });
    await page.locator('#btn-save-results').click();
    await page.locator('#entry-name').fill('视觉参考');
    await page.locator('#entry-submit').click();
    await page.waitForFunction(() => document.getElementById('topic-name').textContent === '视觉参考');
    assert.strictEqual(await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries[1].recipe.payload.source_frame), 12);
    await page.evaluate(() => { SearchCache.clear(); });
    await page.locator('#topic-update').click();
    await page.locator('#topic-changes-apply').click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('更新完成'));
    assert((await page.evaluate(() => window.__requests.at(-1).url)).endsWith('/search_visual'));
    assert.strictEqual(await page.evaluate(() => window.__requests.at(-1).body.source_video_path), 'D:/fixture/a.mp4');
    assert.strictEqual(await page.evaluate(() => window.__requests.at(-1).body.image_base64), 'data:image/jpeg;base64,fixture-single-frame');
    assert.strictEqual(await page.evaluate(() => window.__requests.at(-1).body.scene_aggregation), 'max');
    const requestsBeforeMissingSource = await page.evaluate(() => window.__requests.length);
    await page.evaluate(() => { window.__sourceMissing = true; });
    const missingLegacy = await page.evaluate(async () => {
      const recipe = { ...Search.getRecipe(), sourceItemId: 'a', payload: { video_path: 'D:/fixture/a.mp4', start_frame: 5, end_frame: 105 } };
      try { await Search.replay(recipe); return ''; } catch (error) { return error.message; }
    });
    assert(missingLegacy.includes('查询来源素材已失效'));
    assert.strictEqual(await page.evaluate(() => window.__requests.length), requestsBeforeMissingSource);
    await page.evaluate(() => { window.__sourceMissing = false; });
    // 混合查询和剪贴板图片保存后，也能按原查询种类重放。
    await page.locator('#topic-search').click();
    await page.evaluate(async () => {
      await Search.runHybrid('混合查询', { video_path: 'D:/fixture/a.mp4', start_frame: 5, end_frame: 105 }, await SearchRecipe.currentContext(), 14);
    });
    await page.locator('#btn-save-results').click();
    await page.locator('#entry-name').fill('混合主题');
    await page.locator('#entry-submit').click();
    await page.waitForFunction(() => document.getElementById('topic-name').textContent === '混合主题');
    await page.locator('#topic-update').click();
    await page.locator('#topic-changes-apply').click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('更新完成'));
    assert((await page.evaluate(() => window.__requests.at(-1).url)).endsWith('/search_hybrid'));
    assert.strictEqual(await page.evaluate(() => window.__requests.at(-1).body.text_threshold), 14);
    await page.locator('#topic-search').click();
    await page.evaluate(async () => {
      await Search.runVisual({ image_base64: 'fixture-image-bytes' }, await SearchRecipe.currentContext(), '图片查询');
    });
    await page.locator('#btn-save-results').click();
    await page.locator('#entry-name').fill('图片主题');
    await page.locator('#entry-submit').click();
    await page.waitForFunction(() => document.getElementById('topic-name').textContent === '图片主题');
    await page.locator('#topic-update').click();
    await page.locator('#topic-changes-apply').click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('更新完成'));
    assert.strictEqual(await page.evaluate(() => window.__requests.at(-1).body.image_base64), 'fixture-image-bytes');
    await page.evaluate(() => {
      SearchCache.clear();
      window.__delayNext = true;
      window.__pendingSearch = Search.replay(Search.getRecipe());
    });
    await page.waitForFunction(() => typeof window.__releaseSearch === 'function');
    assert.strictEqual(await page.evaluate(() => Search.isBusy()), true);
    assert.strictEqual(await page.evaluate(async () => (await Search.run('不应并发', 11, await SearchRecipe.currentContext())).ok), false);
    assert.strictEqual(await page.evaluate(async () => {
      try { await Search.loadResults([], '不应覆盖'); return false; } catch { return true; }
    }), true);
    await page.evaluate(async () => { window.__releaseSearch(); await window.__pendingSearch; });
    assert.strictEqual(await page.evaluate(() => Search.isBusy()), false);

    // 时间筛选只出现在主题内：离线可用、零搜索请求、零写盘。
    await page.locator('#topic-back').click();
    await page.locator('#warehouse-query').fill('');
    await page.locator('#warehouse-category').selectOption('*');
    const imageCard = page.locator('.warehouse-card').filter({ has: page.getByRole('heading', { name: '图片主题', exact: true }) });
    assert.strictEqual(await page.locator('.warehouse-card select').count(), 0);
    assert.strictEqual(await page.locator('#btn-export, #btn-tag, #btn-shot-tag, #btn-select-all-results, #cfg-export-mode').count(), 0);
    await imageCard.getByRole('button', { name: '打开主题 图片主题', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.page === 'search');
    const timeFilter = page.locator('#topic-time-filter');
    const visibleBeforeTimeFilter = await page.evaluate(() => Search.getAllMatches().length);
    const beforeFilter = await page.evaluate(() => ({ requests: window.__requests.length,
      files: JSON.stringify([...window.__files]),
      entry: ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.find((entry) => entry.name === '图片主题') }));
    await page.evaluate(() => { window.__fail = true; });
    await timeFilter.locator('.warehouse-time-select').selectOption('custom');
    await timeFilter.getByLabel('开始日期', { exact: true }).fill('2026-09-06');
    await timeFilter.getByLabel('结束日期', { exact: true }).fill('2026-09-05');
    await timeFilter.getByLabel('结束日期', { exact: true }).blur();
    assert((await timeFilter.locator('.warehouse-time-control small').textContent()).includes('开始日期不能晚于'));
    const dates = await page.evaluate(() => {
      const format = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const today = new Date(); const start = new Date(); start.setDate(start.getDate() - 2);
      return { start: format(start), end: format(today) };
    });
    await timeFilter.getByLabel('开始日期', { exact: true }).fill(dates.start);
    await timeFilter.getByLabel('结束日期', { exact: true }).fill(dates.end);
    await timeFilter.getByLabel('结束日期', { exact: true }).blur();
    assert.strictEqual(await page.locator('#topic-time-filter select').inputValue(), 'custom');
    await page.locator('#topic-time-filter').getByLabel('开始日期', { exact: true }).fill('2000-01-01');
    await page.locator('#topic-time-filter').getByLabel('结束日期', { exact: true }).fill('2000-01-02');
    await page.locator('#topic-time-filter').getByLabel('结束日期', { exact: true }).blur();
    assert.strictEqual(await page.evaluate(() => Search.getAllMatches().length), 0);
    assert.strictEqual(await page.evaluate(() => Search.getRawMatches().length), beforeFilter.entry.matches.length);
    await page.locator('#topic-time-filter select').selectOption('all');
    assert.strictEqual(await page.evaluate(() => Search.getAllMatches().length), visibleBeforeTimeFilter,
      '清除时间筛选恢复原展示，仍保留主题的最短时长过滤');
    assert.deepStrictEqual(await page.evaluate(() => ({ requests: window.__requests.length,
      files: JSON.stringify([...window.__files]),
      entry: ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.find((entry) => entry.name === '图片主题') })), beforeFilter);
    await page.locator('#topic-time-filter select').selectOption('custom');
    await page.locator('#topic-time-filter').getByLabel('开始日期', { exact: true }).fill(dates.start);
    await page.locator('#topic-time-filter').getByLabel('结束日期', { exact: true }).fill(dates.end);
    await page.locator('#topic-time-filter').getByLabel('结束日期', { exact: true }).blur();
    await page.evaluate(() => { window.__fail = false; });

    // 实际编码的小视频验证暂停、逐帧和画布截图；不会读取用户素材。
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-warehouse-media-'));
    const fixturePath = path.join(fixtureDir, 'frames.mp4');
    execFileSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', fixturePath],
    { windowsHide: true, timeout: 15000 });
    await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      window.__fixtureVideo = new Blob([bytes], { type: 'video/mp4' });
      window.__items[0].fileURL = URL.createObjectURL(window.__fixtureVideo);
    }, fs.readFileSync(fixturePath).toString('base64'));
    await closeCompactMenus(page);
    await page.locator('#results .card').first().click();
    await page.waitForFunction(() => {
      const video = document.getElementById('preview-video');
      return video.readyState >= 2 && !video.seeking && !video.error;
    });
    await page.evaluate(async () => {
      const video = document.getElementById('preview-video'); video.pause();
      const seek = (time) => new Promise((resolve) => { video.addEventListener('seeked', resolve, { once: true }); video.currentTime = time; });
      if (!Number.isFinite(video.duration)) await seek(100000);
      await seek(0.48);
    });
    assert(await page.locator('#preview-cover-actions').isVisible());
    const beforeLayoutSwitch = await page.evaluate(() => {
      window.__previewBeforeSwitch = document.getElementById('preview-video');
      const video = window.__previewBeforeSwitch;
      return { src: video.src, time: video.currentTime, paused: video.paused, requests: window.__requests.length };
    });
    await selectPreviewLayout(page, 'top');
    assert(await page.locator('#preview-panel').isVisible());
    await selectPreviewLayout(page, 'sidebar');
    const afterLayoutSwitch = await page.evaluate(() => {
      const video = document.getElementById('preview-video');
      return { src: video.src, time: video.currentTime, paused: video.paused, requests: window.__requests.length,
        same: video === window.__previewBeforeSwitch };
    });
    assert(afterLayoutSwitch.same, '切换布局复用同一播放器');
    assert.deepStrictEqual({ src: afterLayoutSwitch.src, time: afterLayoutSwitch.time,
      paused: afterLayoutSwitch.paused, requests: afterLayoutSwitch.requests }, beforeLayoutSwitch,
    '真实解码画面的暂停、时间与源地址不变，不重新搜索');
    assert.strictEqual(await page.locator('#btn-describe, #btn-purify').count(), 0);
    assert.strictEqual(await page.locator('#preview-status').textContent(), '', '原生预览成功后不显示就绪提示');
    assert(!(await page.locator('#preview-status').isVisible()), '空提示不能继续占用预览宽度');
    for (const width of [1100, 800]) {
      await page.setViewportSize({ width, height: 740 });
      const buttons = await page.locator('.preview-actions button').evaluateAll((nodes) => nodes.map((button) => {
        const rect = button.getBoundingClientRect();
        return { top: rect.top, height: rect.height, nowrap: getComputedStyle(button).whiteSpace };
      }));
      assert(buttons.every((button) => button.height < 40), '右侧按钮允许分行排列，文字不折行');
      assert(buttons.every((button) => button.nowrap === 'nowrap' && button.height < 40), '按钮文字不能折行');
      const frameButtons = await page.locator('.preview-frame-actions button').evaluateAll((nodes) => nodes.map((button) => {
        const rect = button.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, nowrap: getComputedStyle(button).whiteSpace };
      }));
      assert.strictEqual(frameButtons.length, 2, '上一帧和下一帧应独立成行');
      assert(frameButtons.every((button) => button.bottom <= buttons[0].top && button.nowrap === 'nowrap'),
        '逐帧按钮应位于其他操作上一行且文字不折行');
      assert(Math.abs(frameButtons[0].top - frameButtons[1].top) < 1, '两个逐帧按钮应处于同一行');
      if (process.env.PREVIEW_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.PREVIEW_SCREENSHOT_DIR, `preview-${width}.png`) });
    }
    await page.setViewportSize({ width: 1100, height: 740 });
    await page.locator('#btn-cover-next-frame').click();
    await page.waitForFunction(() => !document.getElementById('preview-video').seeking);
    assert.strictEqual(await page.evaluate(() => document.getElementById('preview-video').paused), true, '逐帧操作不能自动恢复播放');
    const selectedFrame = await page.evaluate(() => Math.round(document.getElementById('preview-video').currentTime * 25));
    const beforeCover = await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.find((entry) => entry.name === '图片主题'));
    await page.locator('#btn-set-topic-cover').click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('已将当前画面设为'));
    const afterCover = await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.find((entry) => entry.name === '图片主题'));
    assert.strictEqual(afterCover.cover.frame, selectedFrame);
    assert.strictEqual(afterCover.updatedAt, beforeCover.updatedAt);
    assert(afterCover.cover.dataUrl.startsWith('data:image/jpeg;base64,'));
    assert.deepStrictEqual(afterCover.matches, beforeCover.matches);
    await page.evaluate(() => { window.__writeFail = true; });
    await page.locator('#btn-set-topic-cover').click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('模拟写盘失败'));
    assert.deepStrictEqual(await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.find((entry) => entry.name === '图片主题').cover), afterCover.cover);
    await page.evaluate(() => { window.__writeFail = false; });
    await page.locator('#topic-back').click();
    assert.strictEqual(await imageCard.locator('select').count(), 0);
    await page.waitForFunction(() => [...document.querySelectorAll('.warehouse-card')].find((card) => card.querySelector('h2').textContent === '图片主题')?.querySelector('.warehouse-cover img')?.src.startsWith('data:image/jpeg;'));
    await imageCard.getByRole('button', { name: '选封面', exact: true }).click();
    assert.strictEqual(await page.locator('#topic-time-filter select').inputValue(), 'custom');
    await page.locator('#topic-update').click();
    await page.locator('#topic-changes-apply').click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('更新完成'));
    assert.strictEqual(await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.find((entry) => entry.name === '图片主题').cover.dataUrl), afterCover.cover.dataUrl);
    assert.deepStrictEqual(await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.find((entry) => entry.name === '图片主题').recipe.time), beforeFilter.entry.recipe.time, '更新仍使用原搜索条件，不使用临时筛选时间');
    await revealControl(page, '#topic-reset-cover');
    await page.locator('#topic-reset-cover').click();
    assert.strictEqual(await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.find((entry) => entry.name === '图片主题').cover), undefined);
    // 普通结果支持精确选帧；视觉与文字入口都使用实际解码的固定 JPEG。
    await page.locator('#topic-search').click();
    await revealControl(page, '#search-time');
    await page.locator('#search-time').selectOption('all');
    await page.locator('#query').fill('单帧操作测试');
    await page.locator('#btn-search').click();
    await page.waitForFunction(() => Search.getLastQuery() === '单帧操作测试' && !Search.isBusy());
    const openFixtureFrame = async (time) => {
      await closeCompactMenus(page);
      await page.locator('#results .card').first().click();
      await page.waitForFunction(() => {
        const video = document.getElementById('preview-video');
        // readyState 可能仍来自上次媒体；等待本次预览初次定位/播放处理完成。
        return document.getElementById('preview-panel').dataset.state === 'ready'
          && video.readyState >= 2 && !video.seeking && !video.error;
      });
      await page.evaluate(async (target) => {
        const video = document.getElementById('preview-video'); video.pause();
        if (Math.abs(video.currentTime - target) > 0.001) {
          await new Promise((resolve) => { video.addEventListener('seeked', resolve, { once: true }); video.currentTime = target; });
        }
        video.pause();
      }, time);
      assert.strictEqual(await page.evaluate(() => document.getElementById('preview-video').paused), true,
        '选帧fixture须在初次预览定位之后稳定暂停');
      assert.strictEqual(await page.evaluate(() => Math.round(document.getElementById('preview-video').currentTime * 25)),
        Math.round(time * 25), '选帧fixture精确保持目标帧');
    };
    await openFixtureFrame(0.4);
    assert(await page.locator('#btn-cover-prev-frame').isVisible(), '普通结果也可回退一帧');
    assert(await page.locator('#btn-cover-next-frame').isVisible(), '普通结果也可前进一帧');
    assert(!(await page.locator('#btn-set-topic-cover').isVisible()), '普通结果不展示主题封面写入');
    const frameOne = await page.evaluate(async () => Search.captureFrame());
    const visualRequestCount = await page.evaluate(() => window.__requests.length);
    await page.locator('#btn-frame-visual').click();
    await page.waitForFunction(() => Search.getRecipe()?.kind === 'visual' && !FrameSearch.isBusy());
    assert.strictEqual(await page.evaluate(() => window.__requests.length), visualRequestCount + 1);
    const visualOne = await page.evaluate(() => window.__requests.at(-1).body);
    assert.strictEqual(visualOne.image_base64, frameOne.dataUrl);
    assert.strictEqual(visualOne.source_frame, frameOne.frame);
    assert.strictEqual(visualOne.source_video_path, frameOne.videoPath);
    assert.strictEqual(visualOne.source_fps, frameOne.fps);
    assert.strictEqual(visualOne.scene_aggregation, 'max');
    assert.strictEqual(visualOne.start_frame, undefined, '单帧入口不提交原片段范围');
    assert(await page.locator('#frame-query-reference').isVisible());
    assert.strictEqual(await page.locator('#frame-query-image').getAttribute('src'), frameOne.dataUrl);
    await openFixtureFrame(0.8);
    const frameTwo = await page.evaluate(async () => Search.captureFrame());
    assert.notStrictEqual(frameTwo.dataUrl, frameOne.dataUrl, '实际不同帧必须产生不同图片');
    await page.locator('#btn-frame-visual').click();
    await page.waitForFunction(() => Search.getRecipe()?.payload?.source_frame === 20 && !FrameSearch.isBusy());
    assert.strictEqual(await page.evaluate(() => window.__requests.length), visualRequestCount + 2,
      '同视频不同帧不得命中上一帧缓存');
    assert.strictEqual(await page.evaluate(() => window.__requests.at(-1).body.image_base64), frameTwo.dataUrl);
    // 历史单帧文字主题仍可重放；当前界面不再提供生成文字入口。
    await page.evaluate(async (frame) => {
      await Search.runFrameText('edited frame description', { image_base64: frame.dataUrl,
        source_frame: frame.frame, source_fps: frame.fps, source_video_path: frame.videoPath,
        source_name: frame.videoName }, await SearchRecipe.currentContext(), 18);
    }, frameTwo);
    await page.locator('#btn-save-results').click();
    await page.locator('#entry-name').fill('单帧文字主题');
    await page.locator('#entry-submit').click();
    await page.waitForFunction(() => document.getElementById('topic-name').textContent === '单帧文字主题');
    const describedCount = await page.evaluate(() => window.__describeRequests.length);
    await page.locator('#topic-update').click();
    await page.locator('#topic-changes-apply').click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('更新完成'));
    assert.strictEqual(await page.evaluate(() => window.__describeRequests.length), describedCount, '文字主题重放不重复生成描述');
    assert.strictEqual(await page.evaluate(() => Search.getRecipe().payload.image_base64), frameTwo.dataUrl);
    await page.locator('#topic-search').click();
    await page.evaluate(() => Warehouse.open());
    // 至少三排卡片：单排卡片无法复现限高网格把文字和按钮裁掉的问题。
    await page.evaluate(() => {
      const store = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
      const sample = store.list().entries.find((entry) => entry.matches.length);
      for (const name of ['窗前人物', '雨中的城市街道与远处灯光', '牵手', '烟花', '风景']) {
        store.add({ name, categoryId: '', recipe: sample.recipe, view: sample.view, matches: sample.matches });
      }
    });
    await page.evaluate(() => Warehouse.open());
    await page.locator('#warehouse-query').fill('');
    await page.locator('#warehouse-category').selectOption('*');
    for (const width of [800, 1100]) {
      await page.setViewportSize({ width, height: 720 });
      assert(await page.locator('.warehouse-card').first().isVisible());
      assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      const layout = await page.locator('.warehouse-card').evaluateAll((cards) => cards.map((card) => {
        const rect = card.getBoundingClientRect();
        const actions = card.querySelector('.warehouse-card-actions').getBoundingClientRect();
        const title = card.querySelector('h2').getBoundingClientRect();
        return { height: rect.height, bottom: rect.bottom, actionsBottom: actions.bottom, titleBottom: title.bottom };
      }));
      assert(layout.every((card) => card.actionsBottom <= card.bottom && card.titleBottom <= card.bottom),
        `仓库卡片内容被裁切：${JSON.stringify(layout)}`);
    }
    // 按当前筛选/排序选择；选择不替换 DOM、封面，也不引入搜索或写盘。
    await page.evaluate(() => {
      const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
      const sample = archive.list().entries[0];
      const names = ['批次测试可见 A', '批次测试隐藏 X', '批次测试可见 B', '批次测试隐藏 Y', '批次测试可见 C'];
      names.forEach((name, i) => {
        const entry = archive.add({ name, categoryId: '', recipe: sample.recipe, view: sample.view, matches: [] });
        archive.replace({ ...entry, updatedAt: `2025-01-0${5 - i}T00:00:00.000Z` }, entry.updatedAt);
      });
    });
    await page.evaluate(() => Warehouse.open());
    await page.locator('#warehouse-query').fill('批次测试可见');
    await page.waitForFunction(() => document.querySelectorAll('.warehouse-card').length === 3);
    assert.deepStrictEqual(await page.locator('.warehouse-card h2').allTextContents(),
      ['批次测试可见 A', '批次测试可见 B', '批次测试可见 C']);
    const selectionBefore = await page.evaluate(() => {
      window.__firstWarehouseCard = document.querySelector('.warehouse-card');
      return { files: JSON.stringify([...window.__files]), requests: window.__requests.length };
    });
    await page.locator('.warehouse-card-open').first().click({ modifiers: ['Control'] });
    await page.locator('.warehouse-card-open').last().click({ modifiers: ['Shift'] });
    assert.strictEqual(await page.locator('.warehouse-card.selected').count(), 3);
    assert.strictEqual(await page.locator('#warehouse-selection-count').textContent(), '已选择 3 个主题');
    assert.strictEqual(await page.evaluate(() => window.__firstWarehouseCard === document.querySelector('.warehouse-card')), true);
    assert.deepStrictEqual(await page.evaluate(() => ({ files: JSON.stringify([...window.__files]), requests: window.__requests.length })), selectionBefore);
    assert.strictEqual(await page.locator('.warehouse-card-open[aria-pressed="true"]').count(), 3);
    await page.locator('#warehouse-query').fill('批次测试可见 B');
    await page.waitForFunction(() => document.querySelectorAll('.warehouse-card').length === 1);
    assert.strictEqual(await page.locator('#warehouse-selection-count').textContent(), '已选择 1 个主题');
    await page.locator('#warehouse-query').fill('批次测试可见');
    await page.waitForFunction(() => document.querySelectorAll('.warehouse-card').length === 3);
    await page.locator('.warehouse-card-open').first().click({ modifiers: ['Control'] });
    await page.locator('.warehouse-card-open').last().click({ modifiers: ['Shift'] });
    // 右键菜单保持单例，在视口中，Escape 返回到触发卡片。
    await page.locator('.warehouse-card-open').last().click({ button: 'right' });
    await page.locator('.warehouse-card-open').last().dispatchEvent('contextmenu', { clientX: 1098, clientY: 718 });
    assert.strictEqual(await page.locator('.warehouse-context-menu').count(), 1);
    const menuBox = await page.locator('.warehouse-context-menu').boundingBox();
    assert(menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= 1100 && menuBox.y + menuBox.height <= 720);
    await page.keyboard.press('Escape');
    assert.strictEqual(await page.locator('.warehouse-context-menu').count(), 0);
    assert.strictEqual(await page.locator('.warehouse-card-open').last().evaluate((button) => button === document.activeElement), true);
    // 全失败保留对话框、原选择与名称/错误明细；成功重试才清空。
    await page.locator('#warehouse-batch-category').click();
    const batchDialog = page.locator('.warehouse-batch-dialog');
    await batchDialog.locator('select').selectOption(cat);
    await page.evaluate(() => { window.__writeFail = true; });
    await batchDialog.getByRole('button', { name: '确认', exact: true }).click();
    assert(await batchDialog.isVisible());
    assert((await batchDialog.locator('.warehouse-batch-status').textContent()).includes('失败 3 个'));
    assert((await batchDialog.locator('.warehouse-batch-status').textContent()).includes('模拟写盘失败'));
    assert.strictEqual(await page.locator('.warehouse-card.selected').count(), 3);
    await page.evaluate(() => { window.__writeFail = false; });
    await batchDialog.getByRole('button', { name: '重试失败项', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.warehouse-batch-dialog'));
    assert.strictEqual(await batchDialog.count(), 0);
    assert(await page.locator('#warehouse-batch-category').isDisabled());
    // 部分失败只重试失败 ID，同一个确认中的分类保持固定。
    await page.locator('.warehouse-card-open').first().click({ modifiers: ['Control'] });
    await page.locator('.warehouse-card-open').last().click({ modifiers: ['Shift'] });
    await page.evaluate(() => {
      window.__originalArchiveOpen = ArchiveStore.open;
      window.__batchCalls = [];
      ArchiveStore.open = (...args) => {
        const archive = window.__originalArchiveOpen(...args);
        return { ...archive, setCategories: (requests, categoryId) => {
          window.__batchCalls.push(requests.map((request) => request.id));
          if (window.__batchCalls.length === 1) {
            const succeeded = archive.setCategories(requests.slice(0, 2), categoryId).results;
            return { results: [...succeeded, { id: requests[2].id, ok: false, error: '模拟暂时失败' }] };
          }
          return archive.setCategories(requests, categoryId);
        } };
      };
    });
    await page.locator('#warehouse-batch-category').click();
    await batchDialog.getByRole('button', { name: '确认', exact: true }).click();
    assert.strictEqual(await page.locator('.warehouse-card.selected').count(), 1);
    assert.strictEqual(await batchDialog.locator('select').isDisabled(), true);
    await batchDialog.getByRole('button', { name: '重试失败项', exact: true }).click();
    assert.deepStrictEqual(await page.evaluate(() => window.__batchCalls.map((ids) => ids.length)), [3, 1]);
    await page.evaluate(() => { ArchiveStore.open = window.__originalArchiveOpen; });
    // 冲突不能以最新版本静默覆盖；需关闭、重新打开并再次确认。
    await page.locator('.warehouse-card-open').first().click({ modifiers: ['Control'] });
    await page.locator('#warehouse-batch-category').click();
    await page.evaluate(() => {
      const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
      const entry = archive.list().entries.find((value) => value.name === '批次测试可见 A');
      archive.setCategory(entry.id, '', entry.updatedAt);
    });
    await batchDialog.getByRole('button', { name: '确认', exact: true }).click();
    assert(await batchDialog.getByRole('button', { name: '重试失败项', exact: true }).isDisabled());
    assert((await batchDialog.locator('.warehouse-batch-status').textContent()).includes('重新打开仓库'));
    assert.strictEqual(await page.locator('.warehouse-card.selected').count(), 1);
    await batchDialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.evaluate(() => Warehouse.open());
    await page.locator('#warehouse-batch-category').click();
    await batchDialog.getByRole('button', { name: '确认', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.warehouse-batch-dialog'));
    assert.strictEqual(await batchDialog.count(), 0);
    // 跨批完整范围选择，首批限制 DOM 数量；视图偏好可持久保存。
    await page.evaluate(() => {
      const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
      const sample = archive.list().entries[0];
      for (let i = 0; i < 130; i++) archive.add({ name: `分页测试 ${i}`, categoryId: '', recipe: sample.recipe, view: sample.view, matches: [] });
    });
    await page.locator('#warehouse-query').fill('分页测试');
    await page.evaluate(() => Warehouse.open());
    await page.waitForFunction(() => document.querySelectorAll('.warehouse-card').length === 60);
    await page.locator('.warehouse-card-open').first().click({ modifiers: ['Control'] });
    await page.locator('.warehouse-load-more').click();
    assert.strictEqual(await page.locator('.warehouse-card').count(), 120);
    await page.locator('.warehouse-card-open').last().click({ modifiers: ['Shift'] });
    assert.strictEqual(await page.locator('#warehouse-selection-count').textContent(), '已选择 120 个主题');
    await page.locator('.warehouse-load-more').click();
    assert.strictEqual(await page.locator('.warehouse-card').count(), 130);
    await page.locator('.warehouse-card-open').last().click({ modifiers: ['Shift'] });
    assert.strictEqual(await page.locator('.warehouse-card.selected').count(), 130);
    await page.locator('#warehouse-view-list').click();
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('eagle-semantic-warehouse-view')), 'list');
    assert.strictEqual(await page.locator('#warehouse-grid').evaluate((grid) => grid.classList.contains('list-view')), true);
    assert.strictEqual(await page.locator('#warehouse-view-list').getAttribute('aria-pressed'), 'true');
    const preferencePage = await page.context().newPage();
    try {
      await preferencePage.route('**/*', (route) => route.fulfill({ status: 200, body: '' }));
      await preferencePage.goto('http://warehouse.fixture/');
      await preferencePage.setContent(html);
      await preferencePage.addScriptTag({ path: path.join(root, 'js/warehouse.js') });
      await preferencePage.evaluate(() => { window.Search = { setContextMenuHandler() {} }; Warehouse.init({}); });
      assert.strictEqual(await preferencePage.locator('#warehouse-view-list').getAttribute('aria-pressed'), 'true',
        '新窗口初始化恢复条栏视图');
      await preferencePage.locator('#warehouse-view-card').click();
      assert.strictEqual(await preferencePage.evaluate(() => localStorage.getItem('eagle-semantic-warehouse-view')), 'card');
    } finally { await preferencePage.close(); }
    const blockedPreferencePage = await browser.newPage();
    try {
      await blockedPreferencePage.setContent(html);
      await blockedPreferencePage.evaluate(() => {
        Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('偏好不可用'); } });
      });
      await blockedPreferencePage.addScriptTag({ path: path.join(root, 'js/warehouse.js') });
      await blockedPreferencePage.evaluate(() => { window.Search = { setContextMenuHandler() {} }; Warehouse.init({}); });
      await blockedPreferencePage.locator('#warehouse-view-list').click();
      assert.strictEqual(await blockedPreferencePage.locator('#warehouse-view-list').getAttribute('aria-pressed'), 'true',
        '偏好存储不可用仍能切换视图');
    } finally { await blockedPreferencePage.close(); }
    await page.locator('#warehouse-view-card').click();
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('eagle-semantic-warehouse-view')), 'card');
    await page.locator('#warehouse-query').fill('');
    await page.locator('#warehouse-category').selectOption('*');
    await page.waitForFunction(() => document.querySelectorAll('.warehouse-card').length === 60);
    // Opening warehouse topics must not replace the live search session.
    await page.locator('#warehouse-back').click();
    if (await page.locator('#topic-search').isVisible()) await page.locator('#topic-search').click();
    await revealControl(page, '#search-time');
    await page.locator('#search-time').selectOption('all');
    await page.locator('#query').fill('烟花');
    await page.locator('#btn-search').click();
    await page.waitForFunction(() => Search.getLastQuery() === '烟花' && !Search.isBusy());
    await revealControl(page, '#view-sort');
    await page.locator('#view-sort').selectOption('name');
    await revealControl(page, '#view-min-dur');
    await page.locator('#view-min-dur').fill('3');
    await revealControl(page, '#view-min-dur');
    await page.locator('#view-min-dur').dispatchEvent('change');
    await closeCompactMenus(page);
    await page.locator('#results .card').first().click({ button: 'right' });
    const liveSearch = await page.evaluate(() => ({
      query: Search.getLastQuery(), matches: Search.getRawMatches(), recipe: Search.getRecipe(),
      view: Search.getView(), selected: Search.getSelectedMatches(), requests: window.__requests.length,
    }));
    await page.evaluate(() => {
      const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
      for (const name of ['导航主题 A', '导航主题 B']) {
        const recipe = Search.getRecipe(); recipe.query = name;
        archive.add({ name, recipe, matches: Search.getRawMatches().slice(0, 1),
          view: { sortBy: 'dur', minDur: 0, grouped: false } });
      }
    });
    await page.locator('#btn-archives').click();
    await page.locator('#warehouse-query').fill('导航主题');
    const navCard = (name) => page.locator('.warehouse-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await navCard('导航主题 A').locator('.warehouse-card-open').click();
    assert.strictEqual(await page.locator('#query').inputValue(), '导航主题 A');
    await page.locator('#topic-back').click();
    await navCard('导航主题 B').locator('.warehouse-card-open').click();
    await page.locator('#topic-time-filter select').selectOption('6');
    await page.locator('#topic-search').click();
    await page.waitForFunction(() => document.body.dataset.topic === 'false');
    assert.strictEqual(await page.locator('#query').inputValue(), '烟花', '新搜索恢复进入仓库前的搜索词');
    assert.strictEqual(await page.evaluate(() => Search.getLastQuery()), liveSearch.query);
    assert.deepStrictEqual(await page.evaluate(() => Search.getRawMatches()), liveSearch.matches);
    assert.deepStrictEqual(await page.evaluate(() => Search.getRecipe()), liveSearch.recipe);
    assert.deepStrictEqual(await page.evaluate(() => Search.getView()), liveSearch.view);
    assert.deepStrictEqual(await page.evaluate(() => Search.getSelectedMatches()), liveSearch.selected);
    assert.strictEqual(await page.locator('#view-sort').inputValue(), 'name');
    assert.strictEqual(await page.locator('#view-min-dur').inputValue(), '3');
    assert.strictEqual(await page.evaluate(() => window.__requests.length), liveSearch.requests, '返回不重新搜索');
    await page.locator('#query').fill('雪花');
    await page.locator('#btn-search').click();
    await page.waitForFunction(() => Search.getLastQuery() === '雪花' && !Search.isBusy());
    await page.locator('#btn-archives').click();
    await navCard('导航主题 A').locator('.warehouse-card-open').click();
    await page.locator('#topic-search').click();
    assert.strictEqual(await page.locator('#query').inputValue(), '雪花', '下一次仓库访问恢复最新搜索');
    // A completed search while viewing a topic discards the old return target.
    await page.locator('#btn-archives').click();
    await navCard('导航主题 B').locator('.warehouse-card-open').click();
    await page.evaluate(async () => Search.run('星空', 11, await SearchRecipe.currentContext()));
    assert.strictEqual(await page.evaluate(() => document.body.dataset.topic), 'false');
    await page.locator('#query').fill('星空');
    await page.locator('#btn-archives').click();
    await navCard('导航主题 A').locator('.warehouse-card-open').click();
    await page.locator('#topic-search').click();
    assert.strictEqual(await page.evaluate(() => Search.getLastQuery()), '星空');
    assert.strictEqual(await page.locator('#query').inputValue(), '星空');
    await runRemovalSmoke(page);
    await runManualAddSmoke(page);
    await runWarehouseUsabilitySmoke(page);
    await runOrganizingFeaturesSmoke(page);
    await runContinuousCollectionSmoke(page);
    await runTopicHistorySmoke(page);
    await runTopicCopySmoke(page);
    await runResultRelationsSmoke(page);
    await page.evaluate(() => {
      Search.restoreState(null);
      document.getElementById('query').value = '';
      document.dispatchEvent(new CustomEvent('search-completed'));
    });
    await page.locator('#btn-archives').click();
    await navCard('导航主题 A').locator('.warehouse-card-open').click();
    await page.locator('#topic-search').click();
    assert.strictEqual(await page.locator('#query').inputValue(), '', '没有历史搜索时恢复空搜索页');
    assert.strictEqual(await page.evaluate(() => Search.getRawMatches().length), 0);
    await page.locator('#btn-archives').click();
    await page.locator('#warehouse-query').fill('');
    await page.waitForFunction(() => document.querySelectorAll('.warehouse-card').length === 60);
    // Browser wiring stays isolated; real worker/file IO is covered by the
    // archiveStoreWorker test. Hold a background task to verify busy/error UI.
    await page.evaluate(() => {
      window.__bundleOpen = ArchiveStore.open;
      ArchiveStore.open = (...args) => {
        const archive = window.__bundleOpen(...args);
        return { ...archive,
          exportBundleAsync: () => new Promise((resolve, reject) => { window.__rejectBundle = reject; }),
          importBundleAsync: (text, options) => new Promise((resolve) => {
            window.__completeImport = () => resolve(archive.importBundle(text, options));
          }),
        };
      };
    });
    await page.locator('#warehouse-recovery').click();
    const recovery = page.locator('#warehouse-recovery-dialog');
    await recovery.getByRole('button', { name: '导出仓库包', exact: true }).click();
    assert.strictEqual(await recovery.getAttribute('aria-busy'), 'true');
    assert(await recovery.getByRole('button', { name: '关闭', exact: true }).isDisabled());
    await page.keyboard.press('Escape');
    assert(await recovery.isVisible(), '后台包操作时 Esc 不关闭面板');
    await page.evaluate(() => window.__rejectBundle(new Error('后台线程模拟失败')));
    await page.waitForFunction(() => document.getElementById('warehouse-recovery-dialog').getAttribute('aria-busy') === 'false');
    assert((await recovery.textContent()).includes('后台线程模拟失败'));
    assert(!(await recovery.getByRole('button', { name: '关闭', exact: true }).isDisabled()));
    const importText = await page.evaluate(() => window.__bundleOpen(Config.pluginPath(), eagle.library.path).exportBundle());
    await recovery.locator('input[type=file]').setInputFiles({ name: 'warehouse-fixture.json',
      mimeType: 'application/json', buffer: Buffer.from(importText) });
    await page.waitForFunction(() => document.getElementById('warehouse-recovery-dialog').getAttribute('aria-busy') === 'true');
    assert((await recovery.textContent()).includes('正在校验并合并'));
    await page.evaluate(() => window.__completeImport());
    await page.waitForFunction(() => document.getElementById('warehouse-recovery-dialog').getAttribute('aria-busy') === 'false');
    assert((await recovery.textContent()).includes('已合并 0 个新主题'));
    await recovery.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => { ArchiveStore.open = window.__bundleOpen; });
    await page.locator('#warehouse-back').click();
    const actionSearch = await page.evaluate(async () => {
      const context = await SearchRecipe.currentContext();
      const before = window.__requests.length;
      const first = await Search.run('眨眼', 11, context);
      const snapshot = Search.captureState();
      const camera = await Search.run('相机穿梭', 11, context);
      Search.restoreState(snapshot);
      return { first: first.ok, camera: camera.ok,
        requests: window.__requests.slice(before).filter((request) => request.url.includes('/api/v1/search')) };
    });
    assert(actionSearch.first && actionSearch.camera, '眨眼和运镜均可通过普通搜索返回');
    assert.strictEqual(actionSearch.requests.length, 2);
    assert(actionSearch.requests.every((request) => !('temporal_search' in request.body)));
    assert.strictEqual(await page.locator('#temporal-status').count(), 0);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    if (process.env.WAREHOUSE_SCREENSHOT) await page.screenshot({ path: process.env.WAREHOUSE_SCREENSHOT });
    assert.deepStrictEqual(errors, []);
    console.log('warehouse browser smoke passed: local scene lookup, in-place score editing, browse position/fading notice, manual scene add, reference scores, keyboard/bulk scoring, fixed top ties, update retention, cancel/write failure/conflicts, source topic preservation, empty targets, responsive layout, frame search, search restoration, scene removal/restore, navigation, categories, recovery and cross-library guards');
  } catch (error) {
    console.error(error);
    console.error('browser diagnostics', errors, await page?.evaluate(() => ({
      toast: document.querySelector('.toast')?.textContent,
      editorError: document.getElementById('warehouse-editor-error')?.textContent,
      requests: window.__requests,
      dialogs: [...document.querySelectorAll('dialog[open]')].map((dialog) => dialog.id),
      focus: document.activeElement?.id,
      describeAborted: window.__describeAborted,
      frameBusy: typeof FrameSearch !== 'undefined' ? FrameSearch.isBusy() : null,
      results: typeof Search !== 'undefined' ? Search.getRawMatches().length : null,
      preview: (() => { const v = document.getElementById('preview-video'); return {
        src: v?.src, ready: v?.readyState, seeking: v?.seeking, time: v?.currentTime,
        duration: v?.duration, error: v?.error?.message, fixtureSize: window.__fixtureVideo?.size,
      }; })(),
    })));
    throw error;
  } finally {
    await browser.close();
    if (fixtureDir && path.dirname(fixtureDir) === os.tmpdir()
        && path.basename(fixtureDir).startsWith('eagle-warehouse-media-')) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
}
async function runRemovalSmoke(page) {
  const warehouseQuery = await page.locator('#warehouse-query').inputValue();
  const fixture = await page.evaluate(async () => {
    window.__round = 0; window.__fail = false;
    const recipe = SearchRecipe.clone(Search.getRecipe());
    recipe.query = '人工整理测试'; recipe.scope = { mode: 'all' }; recipe.time = { mode: 'all' };
    const result = await Search.replay(recipe);
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const entry = archive.add({ name: '人工整理测试', recipe, view: { minDur: 0, sortBy: 'sim', grouped: false },
      matches: result.matches.filter((match) => match.eagleItemId === 'a').slice(0, 5) });
    const sibling = archive.add({ name: '人工整理对照', recipe, view: entry.view, matches: entry.matches });
    window.__removalFixture = entry;
    return { id: entry.id, siblingId: sibling.id, library: eagle.library.path, requests: window.__requests.length,
      items: JSON.stringify(window.__items) };
  });
  const persisted = () => page.evaluate((id) => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list()
    .entries.find((entry) => entry.id === id), fixture.id);
  const openTopic = async (name = '人工整理测试') => {
    await page.locator('#btn-archives').click();
    await page.locator('#warehouse-query').fill(name);
    const card = page.locator('.warehouse-card').filter({ has: page.locator('h2', { hasText: name }) }).first();
    await card.locator('.warehouse-card-open').click();
    await page.waitForFunction(() => !Search.isBusy() && document.body.dataset.page === 'search');
  };
  await openTopic();
  assert(await page.locator('#btn-topic-remove').isDisabled());
  await revealControl(page, '#view-sort');
  await page.locator('#view-sort').selectOption('name');
  await revealControl(page, '#view-grouped');
  await page.locator('#view-grouped').check();
  await closeCompactMenus(page);
  await page.locator('#results .pick').nth(0).check();
  await closeCompactMenus(page);
  await page.locator('#results .pick').nth(1).check();
  const original = await persisted();
  await page.evaluate(() => { window.__writeFail = true; });
  await revealControl(page, '#btn-topic-remove');
  await page.locator('#btn-topic-remove').click();
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('模拟写盘失败'));
  assert.deepStrictEqual(await persisted(), original, '移除写失败保留原快照和排除记录');
  assert.strictEqual(await page.evaluate(() => Search.getSelectedMatches().length), 2, '失败保留勾选便于重试');
  assert(!(await page.locator('#topic-removal-notice').isVisible()));
  await page.evaluate(() => { window.__writeFail = false; });
  await revealControl(page, '#btn-topic-remove');
  await page.locator('#btn-topic-remove').click();
  let edited = await persisted();
  assert.strictEqual(edited.matches.length, 3, '只移除选中片段，同视频其他镜头保留');
  assert.strictEqual(edited.removedMatches.length, 2);
  assert.strictEqual(edited.updatedAt, original.updatedAt, '人工移除不冒充搜索更新');
  assert(await page.locator('#view-grouped').isChecked());
  assert.strictEqual(await page.locator('#view-sort').inputValue(), 'name');
  assert.strictEqual(await page.evaluate(() => Search.getSelectedMatches()), null);
  await page.locator('#topic-removal-undo').click();
  assert.strictEqual((await persisted()).matches.length, 5);
  assert.strictEqual((await persisted()).removedMatches.length, 0);
  assert(!(await page.locator('#topic-removal-notice').isVisible()));
  await closeCompactMenus(page);
  await page.locator('#results .pick').nth(0).check();
  await closeCompactMenus(page);
  await page.locator('#results .pick').nth(1).check();
  await closeCompactMenus(page);
  await page.locator('#results .card').nth(2).click({ button: 'right' });
  await page.locator('.result-context-menu').getByRole('menuitem').click();
  assert.strictEqual((await persisted()).matches.length, 4, '右键未选中的卡片只移除该片段');
  assert.strictEqual(await page.evaluate(() => Search.getSelectedMatches().length), 2, '保留其他片段勾选');
  await page.locator('#topic-removal-undo').click();
  await closeCompactMenus(page);
  await page.locator('#results .card.selected').first().click({ button: 'right' });
  assert((await page.locator('.result-context-menu').textContent()).includes('选中 2 个片段'));
  await page.locator('.result-context-menu').getByRole('menuitem').click();
  edited = await persisted();
  const excluded = edited.removedMatches.map((record) => record.key);
  assert.strictEqual(edited.matches.length, 3);
  assert.strictEqual(await page.evaluate((id) => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list()
    .entries.find((entry) => entry.id === id).matches.length, fixture.siblingId), 5, '不影响其他主题');
  assert.strictEqual(await page.evaluate(() => window.__requests.length), fixture.requests, '本地编辑不搜索');
  await page.locator('#topic-back').click();
  await page.locator('.warehouse-card').filter({ has: page.locator('h2', { hasText: '人工整理测试' }) }).first()
    .locator('.warehouse-card-open').click();
  await page.waitForFunction(() => Search.getRawMatches().length === 3 && !Search.isBusy());
  assert((await page.locator('#topic-removed').textContent()).includes('(2)'));
  await page.locator('#topic-update').click();
  await page.locator('#topic-changes-apply').click();
  await page.waitForFunction(() => document.getElementById('topic-update').textContent === '更新结果' && !Search.isBusy());
  edited = await persisted();
  const refreshedKeys = edited.matches.map((match) => JSON.stringify([match.eagleItemId, match.original_start_frame, match.original_end_frame]));
  assert(excluded.every((key) => !refreshedKeys.includes(key)), '更新后持续排除已移除片段');
  assert(excluded.every((key) => !edited.newKeys.includes(key)), '被排除片段不能计入本次新增');
  assert.strictEqual(edited.removedMatches.length, 2);
  const requestsAfterUpdate = await page.evaluate(() => window.__requests.length);
  await revealControl(page, '#view-min-dur');
  await page.locator('#view-min-dur').fill('5');
  await revealControl(page, '#view-min-dur');
  await page.locator('#view-min-dur').dispatchEvent('change');
  await revealControl(page, '#topic-removed');
  await page.locator('#topic-removed').click();
  await page.locator('#topic-removed-query').fill('不存在的视频');
  assert.strictEqual(await page.locator('#topic-removed-list input').count(), 0);
  await page.locator('#topic-removed-query').fill('城市街道');
  assert.strictEqual(await page.locator('#topic-removed-list input').count(), 2);
  await page.locator('#topic-removed-list input').first().check();
  const beforeRestore = edited.matches.length;
  await page.locator('#topic-removed-restore').click();
  edited = await persisted();
  assert.strictEqual(edited.matches.length, beforeRestore + 1, '恢复立即返回完整主题快照');
  assert.strictEqual(await page.evaluate(() => Search.getAllMatches().length), 0, '恢复不绕过当前时长筛选');
  assert.strictEqual(edited.removedMatches.length, 1);
  assert.strictEqual(await page.locator('#topic-removed-list input').count(), 1);
  await page.locator('#topic-removed-all').check();
  await page.evaluate(() => { window.__writeFail = true; });
  await page.locator('#topic-removed-restore').click();
  assert((await page.locator('#topic-removed-status').textContent()).includes('模拟写盘失败'));
  assert.strictEqual((await persisted()).removedMatches.length, 1, '恢复写失败保留排除');
  assert(await page.locator('#topic-removed-list input').first().isChecked(), '失败保留恢复选择');
  await page.evaluate(() => { window.__writeFail = false; });
  if (process.env.TOPIC_REMOVAL_SCREENSHOT_DIR) {
    await page.screenshot({ path: path.join(process.env.TOPIC_REMOVAL_SCREENSHOT_DIR, 'removed-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(process.env.TOPIC_REMOVAL_SCREENSHOT_DIR, 'removed-light.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  }
  await page.locator('#topic-removed-restore').click();
  assert.strictEqual((await persisted()).removedMatches.length, 0);
  assert((await page.locator('#topic-removed-list').textContent()).includes('暂无已移除片段'));
  await page.keyboard.press('Escape');
  assert(!(await page.locator('#topic-removed-dialog').isVisible()));
  assert.strictEqual(await page.evaluate(() => window.__requests.length), requestsAfterUpdate, '恢复不请求搜索');
  assert.strictEqual(await page.evaluate(() => JSON.stringify(window.__items)), fixture.items, '不写入 Eagle 原素材');
  await revealControl(page, '#view-min-dur');
  await page.locator('#view-min-dur').fill('0');
  await revealControl(page, '#view-min-dur');
  await page.locator('#view-min-dur').dispatchEvent('change');
  await page.evaluate((id) => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const source = archive.list().entries.find((entry) => entry.id === id);
    const entry = archive.add({ name: '人工整理大列表', recipe: source.recipe, view: source.view, matches: source.matches });
    archive.removeMatches(entry.id, entry.matches.map(ArchiveStore.sceneKey), entry.updatedAt, entry.revision || 0);
  }, fixture.id);
  await openTopic('人工整理大列表');
  await revealControl(page, '#topic-removed');
  await page.locator('#topic-removed').click();
  assert.strictEqual(await page.locator('#topic-removed-list input').count(), 60, '已移除列表分批渲染');
  await page.locator('.removed-scene-more').click();
  assert.strictEqual(await page.locator('#topic-removed-list input').count(), 73);
  await page.locator('#topic-removed-all').check();
  for (const width of [1100, 480]) {
    await page.setViewportSize({ width, height: 740 });
    const bounds = await page.locator('#topic-removed-dialog').boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width, '恢复面板在窄窗口内完整显示');
    if (process.env.TOPIC_REMOVAL_SCREENSHOT_DIR) await page.screenshot({
      path: path.join(process.env.TOPIC_REMOVAL_SCREENSHOT_DIR, `removed-list-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1100, height: 740 });
  await page.locator('#topic-removed-restore').click();
  assert.strictEqual(await page.evaluate(() => Search.getRawMatches().length), 73, '全选恢复包含整份已移除列表');
  await page.locator('#topic-removed-close').click();
  await page.evaluate(() => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const source = window.__removalFixture;
    const matches = source.matches.slice(0, 3).map((match) => { const copy = { ...match }; delete copy.eagleItemId; return copy; });
    archive.add({ name: '人工整理旧主题', recipe: null, view: source.view, matches });
  });
  await openTopic('人工整理旧主题');
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await revealControl(page, '#btn-topic-remove');
  await page.locator('#btn-topic-remove').click();
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await revealControl(page, '#btn-topic-remove');
  await page.locator('#btn-topic-remove').click();
  assert.strictEqual(await page.evaluate(() => Search.getRawMatches().length), 1, '旧路径片段支持连续移除');
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await revealControl(page, '#btn-topic-remove');
  await page.locator('#btn-topic-remove').click();
  assert.strictEqual(await page.evaluate(() => Search.getRawMatches().length), 0);
  await revealControl(page, '#topic-removed');
  assert(await page.locator('#topic-removed').isVisible(), '清空主题后仍能打开已移除列表');
  await revealControl(page, '#topic-removed');
  await page.locator('#topic-removed').click();
  await page.locator('#topic-removed-all').check();
  await page.locator('#topic-removed-restore').click();
  assert.strictEqual(await page.evaluate(() => Search.getRawMatches().length), 3, '空主题可立即恢复所有片段');
  await page.locator('#topic-removed-close').click();
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  const otherBefore = await page.evaluate(async () => {
    const old = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const bundle = old.exportBundle();
    eagle.library.path = 'D:/other-fixture.library';
    const other = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    other.importBundle(bundle, { allowLibraryMove: true });
    await Warehouse.open();
    return JSON.stringify(other.list());
  });
  await page.locator('#warehouse-back').click();
  await page.evaluate(() => document.getElementById('btn-topic-remove').dispatchEvent(new MouseEvent('click')));
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('素材库已切换'));
  assert.strictEqual(await page.evaluate(() => JSON.stringify(ArchiveStore.open(Config.pluginPath(), eagle.library.path).list())),
    otherBefore, '同 ID 导入主题也不能被跨库旧会话修改');
  await page.evaluate((library) => { eagle.library.path = library; }, fixture.library);
  await page.locator('#topic-search').click();
  await revealControl(page, '#btn-topic-remove');
  assert(!(await page.locator('#btn-topic-remove').isVisible()), '新搜索隐藏主题移除入口');
  assert.strictEqual(await page.evaluate(() => Search.getLastQuery()), '星空', '人工整理不覆盖独立搜索会话');
  await page.evaluate((query) => {
    const input = document.getElementById('warehouse-query');
    input.value = query; input.dispatchEvent(new Event('input'));
  }, warehouseQuery);
}
async function runManualAddSmoke(page) {
  const warehouseQuery = await page.locator('#warehouse-query').inputValue();
  await revealControl(page, '#view-sort');
  await page.locator('#view-sort').selectOption('sim');
  await revealControl(page, '#view-grouped');
  await page.locator('#view-grouped').uncheck();
  await revealControl(page, '#btn-clear-selection');
  await page.locator('#btn-clear-selection').click({ force: true });
  assert(await page.locator('#btn-topic-add').isDisabled());
  await closeCompactMenus(page);
  await page.locator('#results .pick').nth(0).check();
  await closeCompactMenus(page);
  await page.locator('#results .pick').nth(1).check();
  const fixture = await page.evaluate(() => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const selected = SearchRecipe.clone(Search.getSelectedMatches());
    const raw = SearchRecipe.clone(Search.getRawMatches());
    const recipe = SearchRecipe.clone(Search.getRecipe());
    recipe.query = '人工收录目标'; recipe.scope = { mode: 'all' }; recipe.time = { mode: 'all' };
    const matches = [selected[0], selected[1], ...raw.slice(5, 8)].map((match, index) => ({ ...match,
      similarity: [2, 2, 30.25, 20, 7][index] }));
    const target = archive.add({ name: '人工收录目标', recipe,
      view: { minDur: 0, sortBy: 'sim', grouped: false }, matches });
    const removed = archive.removeMatches(target.id, [ArchiveStore.sceneKey(matches[1])], target.updatedAt, 0).entry;
    const empty = archive.add({ name: '人工收录空目标', recipe, view: target.view, matches: [] });
    const source = archive.add({ name: '人工收录来源', recipe, view: target.view,
      matches: [{ ...selected[0], similarity: 999 }, raw[2]] });
    window.__manualFixture = { selected, raw, target, source, empty };
    return { id: target.id, emptyId: empty.id, sourceId: source.id, target: removed,
      raw: JSON.stringify(raw), query: Search.getLastQuery(), view: Search.getView(),
      requests: window.__requests.length, library: eagle.library.path };
  });
  const persisted = (id = fixture.id) => page.evaluate(async (targetId) => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const entry = archive.list().entries.find((value) => value.id === targetId);
    await archive.hydrateEntry(entry); return entry;
  }, id);
  const openPanel = async (id = fixture.id) => {
    await revealControl(page, '#btn-topic-add');
    await page.locator('#btn-topic-add').click();
    await page.locator('#manual-add-target').selectOption(id);
    await page.waitForFunction(() => !document.getElementById('manual-add-status').textContent.includes('正在读取'));
    await page.locator('#manual-add-existing-mode').selectOption('rescore');
  };
  const openTopic = async (name) => {
    await page.locator('#btn-archives').click();
    await page.locator('#warehouse-query').fill(name);
    await page.locator('.warehouse-card').filter({ has: page.locator('h2', { hasText: name }) }).first()
      .locator('.warehouse-card-open').click();
    await page.waitForFunction(() => !Search.isBusy() && document.body.dataset.page === 'search');
  };
  await openPanel();
  assert.strictEqual(await page.locator('#manual-add-references button').count(), 3);
  assert((await page.locator('#manual-add-references').textContent()).includes('30.3'));
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '', '不自动沿用来源分数');
  assert(await page.locator('#manual-add-submit').isDisabled());
  await page.locator('#manual-add-score').focus();
  await page.keyboard.press('ArrowUp');
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '0.1');
  await page.keyboard.press('Control+ArrowUp');
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '1.1');
  await page.keyboard.press('ArrowRight');
  assert.strictEqual(await page.locator('#manual-add-position').textContent(), '2 / 2');
  await page.locator('#manual-add-score').fill('18.6');
  await page.keyboard.press('ArrowLeft');
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '1.1', '切换保留已填分数');
  await page.locator('#manual-add-bulk-score').fill('19.8');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Control+ArrowUp');
  assert.strictEqual(await page.locator('#manual-add-bulk-score').inputValue(), '20.9');
  await page.locator('#manual-add-only-empty').uncheck();
  await page.locator('#manual-add-bulk-apply').click();
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '20.9');
  await page.locator('#manual-add-next').click();
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '20.9');
  await page.locator('#manual-add-score').fill('15.2');
  await page.locator('#manual-add-target-query').fill('人工收录目标');
  await page.keyboard.press('ArrowLeft');
  assert.strictEqual(await page.locator('#manual-add-position').textContent(), '2 / 2', '主题搜索框左右键保持原生行为');
  await page.locator('#manual-add-score').focus();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('manual-add-dialog').open);
  assert(!(await page.locator('#manual-add-dialog').isVisible()));
  assert.deepStrictEqual(await persisted(), fixture.target, '取消不写目标主题');
  assert.strictEqual(await page.evaluate(() => Search.getSelectedMatches().length), 2);
  await openPanel();
  await page.locator('#manual-add-bulk-top').click();
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '30.25', '置顶分展示实际保存精度');
  await page.locator('#manual-add-next').click();
  await page.locator('#manual-add-score').fill('15.2');
  for (const width of [1100, 480]) {
    await page.setViewportSize({ width, height: 740 });
    const bounds = await page.locator('#manual-add-dialog').boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width, '打分面板在窄窗口完整显示');
    assert(await page.locator('#manual-add-dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1));
    if (process.env.MANUAL_ADD_SCREENSHOT_DIR) await page.screenshot({
      path: path.join(process.env.MANUAL_ADD_SCREENSHOT_DIR, `manual-add-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1100, height: 740 });
  await page.evaluate(() => { window.__writeFail = true; });
  await page.locator('#manual-add-submit').click();
  assert((await page.locator('#manual-add-status').textContent()).includes('模拟写盘失败'));
  assert.deepStrictEqual(await persisted(), fixture.target, '失败完整保留目标');
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '15.2');
  assert.strictEqual(await page.evaluate(() => Search.getSelectedMatches().length), 2);
  await page.evaluate(() => { window.__writeFail = false; });
  await page.locator('#manual-add-submit').click();
  assert(!(await page.locator('#manual-add-dialog').isVisible()));
  let edited = await persisted();
  assert.strictEqual(edited.matches.length, 5, '重复片段仅更新分数，已移除片段重新加入');
  assert.strictEqual(edited.removedMatches.length, 0);
  assert.strictEqual(edited.updatedAt, fixture.target.updatedAt);
  assert.deepStrictEqual(edited.matches.filter((match) => match.manualScore).map((match) => match.similarity).sort((a, b) => b - a), [30.25, 15.2]);
  assert.strictEqual(await page.evaluate(() => document.body.dataset.topic), 'false', '添加后留在来源搜索');
  assert.strictEqual(await page.evaluate(() => Search.getSelectedMatches()), null);
  assert.strictEqual(await page.evaluate(() => JSON.stringify(Search.getRawMatches())), fixture.raw, '来源结果分数不变');
  assert.deepStrictEqual(await page.evaluate(() => Search.getView()), fixture.view);
  assert.strictEqual(await page.evaluate(() => Search.getLastQuery()), fixture.query);
  assert.strictEqual(await page.evaluate(() => window.__requests.length), fixture.requests, '添加只写本地主题');
  await openTopic('人工收录目标');
  assert.strictEqual(await page.locator('#results .card').first().locator('.badge-manual').count(), 1, '置顶分在同分前面');
  await page.evaluate(() => {
    window.__round = 1; window.__scoreBoostFrame = window.__manualFixture.raw[2].original_start_frame;
    SearchCache.clear();
  });
  await page.locator('#topic-update').click();
  await page.locator('#topic-changes-apply').click();
  await page.waitForFunction(() => document.getElementById('topic-update').textContent === '更新结果' && !Search.isBusy());
  edited = await persisted();
  assert(edited.matches.some((match) => match.manualScore?.mode === 'top' && match.similarity === 30.25), '更新仍保留不再命中的固定人工分');
  assert(edited.matches.some((match) => match.similarity === 40 && !match.manualScore));
  assert.strictEqual(await page.locator('#results .card').first().locator('.badge-manual').count(), 0, '后来更高分正常排在固定置顶分前');
  await page.evaluate(() => { window.__round = 0; delete window.__scoreBoostFrame; });
  await openTopic('人工收录来源');
  const sourceBefore = await persisted(fixture.sourceId);
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await openPanel();
  await page.locator('#manual-add-score').fill('12.3');
  await page.evaluate((id) => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const entry = archive.list().entries.find((value) => value.id === id);
    archive.replace(entry, entry.updatedAt);
  }, fixture.id);
  const conflictBefore = await persisted();
  await page.locator('#manual-add-submit').click();
  assert((await page.locator('#manual-add-status').textContent()).includes('已被其他操作更新'));
  assert.deepStrictEqual(await persisted(), conflictBefore, '冲突不覆盖目标');
  await page.locator('#manual-add-refresh').click();
  await page.waitForFunction(() => document.getElementById('manual-add-status').textContent.includes('参考已刷新'));
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '12.3', '显式刷新参考保留待提交分数');
  await page.locator('#manual-add-submit').click();
  assert.strictEqual(await page.locator('#topic-name').textContent(), '人工收录来源', '跨主题添加留在来源主题');
  assert.deepStrictEqual(await persisted(fixture.sourceId), sourceBefore, '来源主题原有分数不变');
  assert((await persisted()).matches.some((match) => match.manualScore?.value === 12.3));
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await openPanel(fixture.emptyId);
  assert(await page.locator('#manual-add-top').isDisabled(), '空主题无置顶参考');
  await page.locator('#manual-add-bulk-score').fill('0');
  await page.locator('#manual-add-bulk-apply').click();
  await page.locator('#manual-add-submit').click();
  assert.strictEqual((await persisted(fixture.emptyId)).matches[0].manualScore.value, 0);
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await openPanel();
  await page.locator('#manual-add-score').fill('8');
  const crossBefore = await persisted();
  await page.evaluate(() => { eagle.library.path = 'D:/different-scoring.library'; });
  await page.locator('#manual-add-submit').click();
  assert((await page.locator('#manual-add-status').textContent()).includes('素材库已改变'));
  await page.evaluate((library) => { eagle.library.path = library; }, fixture.library);
  assert.deepStrictEqual(await persisted(), crossBefore, '跨库旧面板不能写入');
  await page.locator('#manual-add-cancel').click();
  await page.locator('#topic-search').click();
  assert.strictEqual(await page.evaluate(() => Search.getLastQuery()), fixture.query, '人工收录不覆盖搜索返回会话');
  await page.evaluate((query) => {
    const input = document.getElementById('warehouse-query'); input.value = query; input.dispatchEvent(new Event('input'));
  }, warehouseQuery);
}
async function runWarehouseUsabilitySmoke(page) {
  const warehouseQuery = await page.locator('#warehouse-query').inputValue();
  const fixture = await page.evaluate(() => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const recipe = SearchRecipe.capture('text', '交互测试', null, {
      config: Config.get(), scope: { mode: 'all' }, time: { mode: 'all' }, library: eagle.library.path,
    }, 11);
    const matches = Array.from({ length: 180 }, (_, index) => ({
      video_path: `D:/fixture/${index < 100 ? 'a' : index < 150 ? 'b' : 'c'}.mp4`, eagleItemId: index < 100 ? 'a' : index < 150 ? 'b' : 'c',
      video_name: index < 100 ? '城市街道' : index < 150 ? '旧素材' : '新加入夜景', start_frame: index * 150, end_frame: index * 150 + 100,
      original_start_frame: index * 150, original_end_frame: index * 150 + 100,
      fps: 25, duration_seconds: 4, similarity: 20,
    }));
    for (const [index, value, mode] of [[30, 30.25, 'top'], [33, 9.2, 'custom']]) {
      matches[index].similarity = value;
      matches[index].manualScore = { value, mode, scoredAt: new Date().toISOString() };
    }
    const view = { minDur: 0, sortBy: 'sim', grouped: false };
    const main = archive.add({ name: '交互测试主主题', recipe, view, matches });
    archive.add({ name: '交互测试另一主题', recipe, view, matches: matches.slice(0, 3) });
    for (let index = 0; index < 75; index++) archive.add({ name: `位置测试 ${String(index).padStart(2, '0')}`, recipe, view, matches: matches.slice(0, 1) });
    window.__usabilityFixture = { main, matches };
    return { id: main.id, library: eagle.library.path, manualKeys: [matches[30], matches[33]].map(ArchiveStore.sceneKey) };
  });
  const openTopic = async (name) => {
    if (await page.evaluate(() => document.body.dataset.page !== 'warehouse')) await page.locator('#btn-archives').click();
    await page.locator('#warehouse-query').fill(name);
    const card = page.locator('.warehouse-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await card.locator('.warehouse-card-open').click();
    await page.waitForFunction((expected) => !Search.isBusy() && document.body.dataset.page === 'search'
      && document.getElementById('topic-name').textContent === expected, name);
  };
  const persisted = () => page.evaluate(async (id) => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const entry = archive.list().entries.find((value) => value.id === id);
    await archive.hydrateEntry(entry); return entry;
  }, fixture.id);
  const selectKey = (key) => page.evaluate((wanted) => {
    const card = [...document.querySelectorAll('#results .card')].find((value) => value.dataset.sceneKey === wanted);
    if (!card) throw new Error('测试片段未显示');
    if (!card.querySelector('.pick').checked) card.querySelector('.pick').click();
  }, key);
  await openTopic('交互测试主主题');
  const localBefore = await page.evaluate(() => ({ files: JSON.stringify([...window.__files]), requests: window.__requests.length }));
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await revealControl(page, '#topic-scene-query');
  await page.locator('#topic-scene-query').fill('城市街道');
  await page.waitForFunction(() => Search.getAllMatches().length === 100);
  await revealControl(page, '#topic-scene-source');
  await page.locator('#topic-scene-source').selectOption('manual');
  assert.strictEqual(await page.evaluate(() => Search.getAllMatches().length), 2);
  await revealControl(page, '#topic-scene-source');
  await page.locator('#topic-scene-source').selectOption('auto');
  assert.strictEqual(await page.evaluate(() => Search.getAllMatches().length), 98);
  assert.strictEqual(await page.evaluate(() => Search.getSelectedMatches()), null, '查找清除隐藏片段的勾选');
  await revealControl(page, '#topic-scene-query');
  await page.locator('#topic-scene-query').fill('没有这段视频');
  await page.waitForFunction(() => Search.getAllMatches().length === 0);
  assert((await page.locator('#empty-state').textContent()).includes('组合筛选'));
  await page.locator('#topic-back').click();
  await openTopic('交互测试另一主题');
  assert.strictEqual(await page.locator('#topic-scene-query').inputValue(), '', '不同主题的查找条件隔离');
  await page.locator('#topic-back').click();
  await openTopic('交互测试主主题');
  assert.strictEqual(await page.locator('#topic-scene-query').inputValue(), '没有这段视频');
  await revealControl(page, '#topic-scene-query');
  await page.locator('#topic-scene-query').fill('城市街道');
  await revealControl(page, '#topic-scene-source');
  await page.locator('#topic-scene-source').selectOption('manual');
  await page.waitForFunction(() => Search.getAllMatches().length === 2);
  assert.deepStrictEqual(await page.evaluate(() => ({ files: JSON.stringify([...window.__files]), requests: window.__requests.length })), localBefore,
    '主题内查找与切换零写盘、零搜索请求');

  for (const key of fixture.manualKeys) await selectKey(key);
  await revealControl(page, '#btn-topic-score');
  await page.locator('#btn-topic-score').click();
  assert.strictEqual(await page.locator('#manual-add-title').textContent(), '调整当前主题评分');
  assert(await page.locator('#manual-add-target').isDisabled());
  assert(!(await page.locator('#manual-add-target-query').isVisible()));
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '30.25');
  await page.locator('#manual-add-next').click();
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '9.2');
  await page.locator('#manual-add-cancel').click();
  assert.strictEqual(await page.evaluate(() => Search.getSelectedMatches().length), 2);
  const scoreBefore = await persisted();
  await revealControl(page, '#btn-topic-score');
  await page.locator('#btn-topic-score').click();
  await page.locator('#manual-add-score').fill('15.6');
  await page.locator('#manual-add-next').click();
  await page.locator('#manual-add-score').fill('14.2');
  await page.evaluate(() => { window.__writeFail = true; });
  await page.locator('#manual-add-submit').click();
  assert((await page.locator('#manual-add-status').textContent()).includes('模拟写盘失败'));
  assert.deepStrictEqual(await persisted(), scoreBefore);
  assert.strictEqual(await page.evaluate(() => Search.getSelectedMatches().length), 2);
  await page.evaluate(() => { window.__writeFail = false; });
  await page.locator('#manual-add-submit').click();
  assert(!(await page.locator('#manual-add-dialog').isVisible()));
  const scored = await persisted();
  assert.deepStrictEqual(scored.matches.filter((match) => match.manualScore).map((match) => match.similarity), [15.6, 14.2]);
  assert.strictEqual(scored.updatedAt, scoreBefore.updatedAt);
  assert.strictEqual(scored.matches.length, 180);
  assert.strictEqual(await page.locator('#topic-scene-query').inputValue(), '城市街道');
  assert.strictEqual(await page.evaluate(() => Search.getSelectedMatches()), null);

  await selectKey(fixture.manualKeys[0]);
  await revealControl(page, '#btn-topic-score');
  await page.locator('#btn-topic-score').click();
  await page.locator('#manual-add-score').fill('16.7');
  await page.evaluate((id) => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const entry = archive.list().entries.find((value) => value.id === id);
    archive.replace(entry, entry.updatedAt);
  }, fixture.id);
  await page.locator('#manual-add-submit').click();
  assert((await page.locator('#manual-add-status').textContent()).includes('刷新参考'));
  await page.locator('#manual-add-refresh').click();
  await page.waitForFunction(() => document.getElementById('manual-add-status').textContent.includes('参考已刷新'));
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '16.7');
  await page.locator('#manual-add-submit').click();
  await selectKey(fixture.manualKeys[0]);
  await revealControl(page, '#btn-topic-score');
  await page.locator('#btn-topic-score').click();
  await page.evaluate(({ id, key }) => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const entry = archive.list().entries.find((value) => value.id === id);
    archive.removeMatches(id, [key], entry.updatedAt, entry.revision || 0);
  }, { id: fixture.id, key: fixture.manualKeys[0] });
  await page.locator('#manual-add-refresh').click();
  await page.waitForFunction(() => document.getElementById('manual-add-status').dataset.error === 'true');
  assert(await page.locator('#manual-add-submit').isDisabled(), '已移除片段不能被评分操作重新加入');
  assert.strictEqual((await persisted()).removedMatches.length, 1);
  await page.locator('#manual-add-cancel').click();
  await page.locator('#topic-back').click();
  await openTopic('交互测试主主题');
  await revealControl(page, '#topic-scene-source');
  await page.locator('#topic-scene-source').selectOption('auto');
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await revealControl(page, '#btn-topic-score');
  await page.locator('#btn-topic-score').click();
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '', '直接改分也不自动沿用机器分数');
  await page.locator('#manual-add-score').fill('8.4');
  await page.evaluate(() => { eagle.library.path = 'D:/other-score.library'; });
  await page.locator('#manual-add-submit').click();
  assert((await page.locator('#manual-add-status').textContent()).includes('素材库已改变'));
  await page.evaluate((library) => { eagle.library.path = library; }, fixture.library);
  await page.locator('#manual-add-submit').click();
  assert.strictEqual((await persisted()).matches.filter((match) => match.manualScore).length, 2);

  await page.locator('#topic-back').click();
  await page.locator('#warehouse-query').fill('位置测试');
  await page.locator('#warehouse-view-list').click();
  await page.waitForFunction(() => document.querySelectorAll('.warehouse-card').length === 60);
  await page.locator('.warehouse-load-more').click();
  assert.strictEqual(await page.locator('.warehouse-card').count(), 75);
  const gridTop = await page.evaluate(() => {
    const grid = document.getElementById('warehouse-grid');
    const target = grid.querySelectorAll('.warehouse-card')[50];
    grid.scrollTop += target.getBoundingClientRect().top - grid.getBoundingClientRect().top - 12;
    return grid.scrollTop;
  });
  await page.locator('.warehouse-card-open').nth(50).click();
  await page.locator('#topic-back').click();
  await page.waitForFunction((top) => document.querySelectorAll('.warehouse-card').length === 75
    && Math.abs(document.getElementById('warehouse-grid').scrollTop - top) < 2, gridTop);
  assert(await page.locator('#browse-position-notice').isVisible());
  await page.waitForFunction(() => document.getElementById('browse-position-notice').classList.contains('hidden'), null, { timeout: 4000 });
  await page.locator('.warehouse-card-open').nth(50).click();
  await page.locator('#topic-back').click();
  await page.waitForFunction(() => document.getElementById('browse-position-notice').classList.contains('visible'));
  await page.locator('#browse-position-top').click();
  assert.strictEqual(await page.locator('#warehouse-grid').evaluate((grid) => grid.scrollTop), 0);

  await openTopic('交互测试主主题');
  await revealControl(page, '#topic-scene-query');
  await page.locator('#topic-scene-query').fill('');
  await revealControl(page, '#topic-scene-source');
  await page.locator('#topic-scene-source').selectOption('all');
  await page.waitForFunction(() => Search.getAllMatches().length === 179);
  for (const total of [120, 179]) {
    await page.locator('#results').evaluate((results) => { results.scrollTop = results.scrollHeight; });
    await page.waitForFunction((count) => document.querySelectorAll('#results .card').length >= count, total);
  }
  const resultTop = await page.evaluate(() => {
    const results = document.getElementById('results');
    const target = results.querySelectorAll('.card')[100];
    results.scrollTop += target.getBoundingClientRect().top - results.getBoundingClientRect().top - 16;
    return results.scrollTop;
  });
  await page.locator('#topic-back').click();
  await openTopic('交互测试另一主题');
  await page.locator('#topic-back').click();
  await openTopic('交互测试主主题');
  assert.strictEqual(await page.locator('#results').evaluate((results) => results.scrollTop), 0, '打开主题先从顶部显示');
  assert(await page.locator('#browse-position-resume').isVisible(), '提供点击回到上次浏览位置的短暂提示');
  assert(!(await page.locator('#browse-position-top').isVisible()));
  await page.locator('#browse-position-resume').click();
  await page.waitForFunction((top) => Math.abs(document.getElementById('results').scrollTop - top) < 2, resultTop);
  assert.strictEqual(await page.locator('#results .card').count(), 179, '恢复分批加载后的结果位置');
  assert(await page.locator('#browse-position-notice').isVisible());
  for (const width of [1100, 480]) {
    await page.setViewportSize({ width, height: 740 });
    assert(await page.locator('#topic-scene-filter').evaluate((element) => element.scrollWidth <= element.clientWidth));
    if (process.env.WAREHOUSE_USABILITY_SCREENSHOT_DIR) await page.screenshot({
      path: path.join(process.env.WAREHOUSE_USABILITY_SCREENSHOT_DIR, `warehouse-usability-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1100, height: 740 });
  await page.locator('#topic-back').click();
  await openTopic('交互测试主主题');
  assert(await page.locator('#browse-position-resume').isVisible());
  await page.waitForFunction(() => document.getElementById('browse-position-notice').classList.contains('hidden'), null, { timeout: 6000 });
  assert.strictEqual(await page.locator('#results').evaluate((results) => results.scrollTop), 0, '提示超时不自动跳回历史位置');
  await page.locator('#results').evaluate((results) => { results.scrollTop = 400; });
  await page.locator('#topic-back').click();
  await openTopic('交互测试主主题');
  assert(await page.locator('#browse-position-resume').isVisible());
  await revealControl(page, '#view-sort');
  await page.locator('#view-sort').selectOption('name');
  assert(!(await page.locator('#browse-position-notice').isVisible()), '筛选排序变化清除旧位置入口');
  await revealControl(page, '#view-grouped');
  await page.locator('#view-grouped').check();
  const group = page.locator('#results .vgroup').first();
  await group.locator('.group-load-more').click();
  await page.locator('#results').evaluate((results) => { results.scrollTop = results.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll('#results .vgroup').length === 3);
  await closeCompactMenus(page);
  await page.locator('#results .vgroup').nth(1).locator('summary').click();
  const groupState = await page.evaluate(() => [...document.querySelectorAll('#results .vgroup')].map((value) => ({
    path: value.dataset.videoPath, open: value.open, loaded: value.dataset.loaded,
  })));
  await page.locator('#topic-back').click();
  await openTopic('交互测试另一主题');
  await page.locator('#topic-back').click();
  await openTopic('交互测试主主题');
  assert(await page.locator('#view-grouped').isChecked());
  assert.deepStrictEqual(await page.evaluate(() => [...document.querySelectorAll('#results .vgroup')].map((value) => ({
    path: value.dataset.videoPath, open: value.open, loaded: value.dataset.loaded,
  }))), groupState, '恢复分组折叠及每组已加载片段数');
  assert.strictEqual(await page.evaluate(() => window.__requests.length), localBefore.requests, '全部整理与浏览操作不搜索');
  await page.locator('#topic-search').click();
  assert.strictEqual(await page.locator('#result-filter-menu summary').isVisible(),
    await page.evaluate(() => Search.getRawMatches().length > 0), '普通搜索同样提供结果内筛选');
  assert.strictEqual(await page.evaluate(() => Search.getArchiveFilter().source), 'all');
  await page.locator('#btn-archives').click();
  await page.locator('#warehouse-query').fill(warehouseQuery);
  await page.locator('#warehouse-view-card').click();
  await page.locator('#warehouse-back').click();
}
async function runOrganizingFeaturesSmoke(page) {
  const query = await page.locator('#warehouse-query').inputValue();
  const fixture = await page.evaluate(() => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const recipe = SearchRecipe.clone(Search.getRecipe());
    recipe.query = '新整理功能'; recipe.time = { mode: 'all' }; recipe.scope = { mode: 'all' };
    const a = archive.add({ name: '功能验证 A', recipe, view: { minDur: 0, sortBy: 'sim', grouped: false }, matches: [] });
    const b = archive.add({ name: '功能验证 B', recipe, view: a.view, matches: [] });
    return { a: a.id, b: b.id, updatedAt: a.updatedAt, library: eagle.library.path };
  });
  const read = (id = fixture.a) => page.evaluate(async (id) => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const entry = archive.list().entries.find((value) => value.id === id);
    await archive.hydrateEntry(entry); return entry;
  }, id);
  const card = (name) => page.locator('.warehouse-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await page.locator('#btn-archives').click();
  await page.locator('#warehouse-query').fill('功能验证');
  await page.waitForFunction(() => document.querySelectorAll('.warehouse-card').length === 2);
  await card('功能验证 A').locator('.warehouse-favorite').click();
  assert.strictEqual((await read()).favorite, true);
  assert.strictEqual((await read()).updatedAt, fixture.updatedAt, '星标不改变搜索更新时间');
  assert.strictEqual(await page.locator('.warehouse-card h2').first().textContent(), '功能验证 A');
  await page.locator('#warehouse-favorites').click();
  assert.strictEqual(await page.locator('.warehouse-card').count(), 1);
  await page.locator('#warehouse-favorites').click();
  await page.locator('#warehouse-view-list').click();
  assert.strictEqual(await card('功能验证 A').locator('.warehouse-favorite').getAttribute('aria-pressed'), 'true');
  await page.locator('#warehouse-back').click();
  await page.evaluate(async () => Search.run('新整理功能', 11, await SearchRecipe.currentContext()));
  const requests = await page.evaluate(() => window.__requests.length);
  const rawBefore = await page.evaluate(() => JSON.stringify(Search.getRawMatches()));
  await closeCompactMenus(page);
  for (let index = 0; index < 3; index++) await page.locator('#results .pick').nth(index).check();
  await revealControl(page, '#btn-topic-add');
  await page.locator('#btn-topic-add').click();
  assert((await page.locator('#manual-add-target option').nth(1).textContent()).startsWith('★ 功能验证 A'));
  await page.locator('#manual-add-target').selectOption(fixture.a);
  await page.waitForFunction(() => !document.getElementById('manual-add-status').textContent.includes('正在读取'));
  assert(await page.locator('#manual-add-only-empty').isChecked());
  assert.strictEqual(await page.locator('#manual-add-overview button').count(), 3);
  await page.locator('#manual-add-score').fill('13.276');
  await page.locator('#manual-add-next-empty').click();
  assert.strictEqual(await page.locator('#manual-add-position').textContent(), '2 / 3');
  await page.locator('#manual-add-bulk-score').fill('4');
  await page.locator('#manual-add-bulk-apply').click();
  await page.locator('#manual-add-overview button').first().click();
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '13.276', '只填未评分保留精确人工值');
  assert(await page.locator('#manual-add-next-empty').isDisabled());
  for (const width of [1100, 480]) {
    await page.setViewportSize({ width, height: 720 });
    const layout = await page.locator('#manual-add-dialog').evaluate((dialog) => ({
      width: dialog.clientWidth, scroll: dialog.scrollWidth,
      submitVisible: dialog.querySelector('#manual-add-submit').getBoundingClientRect().width > 0,
    }));
    assert(layout.scroll <= layout.width + 1 && layout.submitVisible, `${width}px评分面板不横向溢出`);
    await page.screenshot({ path: path.join(os.tmpdir(), `eagle-organizing-${width}.png`) });
  }
  await page.setViewportSize({ width: 1100, height: 720 });
  const beforeModalUndo = await read();
  await page.locator('#manual-add-bulk-apply').focus();
  await page.keyboard.press('Control+z');
  assert.deepStrictEqual(await read(), beforeModalUndo, '面板打开时不撤销已保存事务');
  await page.locator('#manual-add-submit').click();
  assert(!(await page.locator('#manual-add-dialog').isVisible()));
  const added = await read();
  assert.deepStrictEqual(added.matches.map((match) => match.similarity), [13.276, 4, 4]);
  assert.strictEqual(await page.evaluate(() => JSON.stringify(Search.getRawMatches())), rawBefore);
  assert(!(await page.locator('#btn-organize-undo').isDisabled()));
  await page.locator('#query').focus();
  await page.keyboard.press('Control+z');
  assert.deepStrictEqual((await read()).matches, added.matches, '输入框内Ctrl+Z不撤销主题数据');
  await page.locator('#btn-archives').focus();
  await page.keyboard.press('Control+z');
  assert.strictEqual((await read()).matches.length, 0, 'Ctrl+Z撤销收录');
  assert.strictEqual((await read()).favorite, true, '撤销收录保留星标');
  assert.strictEqual(await page.evaluate(() => JSON.stringify(Search.getRawMatches())), rawBefore);

  // Two commits to the same theme, then undo both without navigation.
  for (let index = 0; index < 2; index++) {
    await closeCompactMenus(page);
    await page.locator('#results .pick').first().check();
    await revealControl(page, '#btn-topic-add');
    await page.locator('#btn-topic-add').click();
    await page.locator('#manual-add-target').selectOption(fixture.a);
    await page.waitForFunction(() => !document.getElementById('manual-add-status').textContent.includes('正在读取'));
    await page.locator('#manual-add-existing-mode').selectOption('rescore');
    await page.locator('#manual-add-score').fill(String(10 + index));
    await page.locator('#manual-add-submit').click();
  }
  assert.strictEqual((await read()).matches[0].similarity, 11);
  await page.locator('#btn-archives').focus();
  await page.keyboard.press('Control+z');
  assert.strictEqual((await read()).matches[0].similarity, 10);
  await page.keyboard.press('Control+z');
  assert.strictEqual((await read()).matches.length, 0, '同主题连续撤销恢复提交前状态');

  // Undo an in-place score adjustment, including write failure and retry.
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await revealControl(page, '#btn-topic-add');
  await page.locator('#btn-topic-add').click();
  await page.locator('#manual-add-target').selectOption(fixture.a);
  await page.waitForFunction(() => !document.getElementById('manual-add-status').textContent.includes('正在读取'));
  await page.locator('#manual-add-score').fill('17.123');
  await page.locator('#manual-add-submit').click();
  await page.locator('#btn-archives').click();
  await page.locator('#warehouse-query').fill('功能验证 A');
  await card('功能验证 A').locator('.warehouse-card-open').click();
  await page.waitForFunction(() => !Search.isBusy() && document.getElementById('topic-name').textContent === '功能验证 A');
  assert.strictEqual(await page.locator('#topic-favorite').getAttribute('aria-pressed'), 'true');
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await revealControl(page, '#btn-topic-score');
  await page.locator('#btn-topic-score').click();
  assert.strictEqual(await page.locator('#manual-add-score').inputValue(), '17.123');
  await page.locator('#manual-add-score').fill('18.765');
  await page.locator('#manual-add-submit').click();
  await page.evaluate(() => { window.__writeFail = true; });
  await page.locator('#btn-organize-undo').click();
  assert.strictEqual((await read()).matches[0].similarity, 18.765, '撤销写失败保留原数据');
  assert(!(await page.locator('#btn-organize-undo').isDisabled()), '失败后仍可重试撤销');
  await page.evaluate(() => { window.__writeFail = false; });
  await page.locator('#btn-organize-undo').focus();
  await page.keyboard.press('Control+z');
  assert.strictEqual((await read()).matches[0].similarity, 17.123);
  assert.strictEqual(await page.evaluate(() => Search.getRawMatches()[0].similarity), 17.123, '就地撤销刷新当前结果');
  assert.strictEqual(await page.evaluate(() => window.__requests.length), requests, '全部整理及撤销不发搜索请求');

  await page.locator('#topic-favorite').click();
  assert.strictEqual((await read()).favorite, false);
  await page.locator('#btn-organize-undo').click();
  assert.strictEqual((await read()).matches[0].similarity, 17.123, '后来版本变化阻止旧撤销');
  assert((await page.locator('.toast').textContent()).includes('其他操作更新'));
  await page.locator('#topic-search').click();
  await page.locator('#btn-archives').click();
  await page.locator('#warehouse-query').fill('功能验证 A');
  assert.strictEqual(await card('功能验证 A').locator('.warehouse-favorite').getAttribute('aria-pressed'), 'false');
  await page.locator('#warehouse-query').fill(query);
  await page.locator('#warehouse-view-card').click();
  await page.locator('#warehouse-back').click();
}

async function runContinuousCollectionSmoke(page) {
  const query = await page.locator('#warehouse-query').inputValue();
  const fixture = await page.evaluate(() => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const matches = SearchRecipe.clone(Search.getRawMatches().slice(0, 5));
    matches.forEach((match, index) => { match.similarity = 30 - index; delete match.manualScore; delete match.reviewedAt; });
    const recipe = Search.getRecipe();
    const entry = archive.add({ name: '连续收录来源', recipe, matches,
      view: { sortBy: 'sim', grouped: false, minDur: 0 } });
    const target = archive.add({ name: '连续收录验证', recipe, view: entry.view, matches: [matches[0]] });
    return { id: entry.id, targetId: target.id, keys: matches.map(ArchiveStore.sceneKey),
      library: eagle.library.path, updatedAt: entry.updatedAt, requests: window.__requests.length };
  });
  const read = (id = fixture.id) => page.evaluate(async (id) => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const entry = archive.list().entries.find((value) => value.id === id);
    await archive.hydrateEntry(entry); return entry;
  }, id);
  const open = async (name = '连续收录来源') => {
    if (await page.evaluate(() => document.body.dataset.page !== 'warehouse')) await page.locator('#btn-archives').click();
    await page.locator('#warehouse-query').fill(name);
    await page.locator('.warehouse-card').filter({ has: page.getByRole('heading', { name, exact: true }) })
      .locator('.warehouse-card-open').click();
    await page.waitForFunction((value) => !Search.isBusy() && document.getElementById('topic-name').textContent === value, name);
  };
  await open();
  // Continuous collection: protect the target's existing score and remember it.
  await revealControl(page, '#btn-clear-selection');
  await page.locator('#btn-clear-selection').click({ force: true });
  await closeCompactMenus(page);
  await page.locator('#results .pick').nth(0).check();
  await closeCompactMenus(page);
  await page.locator('#results .pick').nth(1).check();
  await revealControl(page, '#btn-topic-add');
  await page.locator('#btn-topic-add').click();
  await page.locator('#manual-add-target').selectOption(fixture.targetId);
  await page.waitForFunction(() => document.getElementById('manual-add-impact').textContent.includes('已收录 1'));
  assert.strictEqual(await page.locator('#manual-add-existing-mode').inputValue(), 'keep');
  assert(await page.locator('#manual-add-score').isDisabled());
  await page.locator('#manual-add-next-empty').click();
  await page.locator('#manual-add-score').fill('12.345');
  await page.locator('#manual-add-submit').click();
  let target = await read(fixture.targetId);
  assert.strictEqual(target.matches[0].similarity, 30, '重复片段保留目标原机器分');
  assert.strictEqual(target.matches[0].manualScore, undefined);
  assert.strictEqual(target.matches[1].similarity, 12.345);
  assert(target.matches.every((match) => !match.reviewedAt), '来源审阅状态不传播到目标');
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await revealControl(page, '#btn-topic-add');
  await page.locator('#btn-topic-add').click();
  await page.waitForFunction((id) => document.getElementById('manual-add-target').value === id
    && !document.getElementById('manual-add-submit').disabled, fixture.targetId);
  assert((await page.locator('#manual-add-existing-info').textContent()).includes('30'));
  await page.screenshot({ path: path.join(os.tmpdir(), 'eagle-continuous-collection.png') });
  const noOpBefore = JSON.stringify(target);
  await page.locator('#manual-add-submit').click();
  assert.strictEqual(JSON.stringify(await read(fixture.targetId)), noOpBefore, '纯重复保留不改分或版本');
  assert.strictEqual(await page.evaluate(() => window.__requests.length), fixture.requests, '连续收录不请求搜索服务');

  await page.locator('#topic-search').click();
  await page.locator('#btn-archives').click();
  await page.locator('#warehouse-query').fill(query);
  await page.locator('#warehouse-view-card').click();
  await page.locator('#warehouse-back').click();
}

async function runTopicHistorySmoke(page) {
  const fixture = await page.evaluate(() => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const matches = Search.getRawMatches().slice(0, 3);
    const entry = archive.add({ name: '历史恢复验证', recipe: Search.getRecipe(),
      matches, view: { minDur: 0, sortBy: 'sim', grouped: false } });
    const other = archive.add({ name: '历史隔离验证', recipe: null, matches: [], view: {} });
    const edited = archive.replace({ ...entry, matches: [], summary: { matches: 0, videos: 0 }, name: '历史恢复验证当前' }, entry.updatedAt);
    return { entry, edited, other: archive.list().entries.find((item) => item.id === other.id),
      requests: window.__requests.length };
  });
  await page.locator('#btn-archives').click();
  const query = await page.locator('#warehouse-query').inputValue();
  await page.locator('#warehouse-query').fill('历史恢复验证当前');
  await page.getByRole('button', { name: '打开主题 历史恢复验证当前', exact: true }).click();
  await revealControl(page, '#topic-history');
  await page.locator('#topic-history').click();
  await page.locator('#topic-history-dialog .topic-history-row button').first().click();
  await page.locator('#topic-changes-dialog').waitFor();
  for (const width of [1100, 480]) {
    await page.setViewportSize({ width, height: 720 });
    const bounds = await page.locator('#topic-changes-dialog').boundingBox();
    assert(bounds.x >= 15 && bounds.x + bounds.width <= width - 15 && bounds.y >= 15, '历史预览居中且窄窗完整可见');
    await page.screenshot({ path: path.join(os.tmpdir(), `eagle-topic-history-${width}.png`) });
  }
  await page.locator('#topic-changes-cancel').click();
  assert.strictEqual(await page.evaluate(() => Search.getRawMatches().length), 0, '取消历史预览不改当前结果');
  await page.locator('#topic-history-dialog .topic-history-row button').first().click();
  await page.evaluate(() => { window.__writeFail = true; });
  await page.locator('#topic-changes-apply').click();
  await page.waitForFunction(() => document.getElementById('topic-changes-error').textContent.includes('模拟写盘失败'));
  await page.evaluate(() => { window.__writeFail = false; });
  await page.locator('#topic-changes-apply').click();
  await page.waitForFunction(() => document.getElementById('topic-name').textContent === '历史恢复验证');
  const restored = await page.evaluate((id) => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.find((entry) => entry.id === id), fixture.entry.id);
  assert(restored.revision > fixture.edited.revision);
  assert.deepStrictEqual(restored.matches, fixture.entry.matches);
  assert.deepStrictEqual(await page.evaluate((id) => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.find((entry) => entry.id === id), fixture.other.id), fixture.other);
  assert.strictEqual(await page.evaluate(() => window.__requests.length), fixture.requests, '历史恢复不调用搜索服务');
  await page.setViewportSize({ width: 1100, height: 720 });
  // 已落盘后显示失败须明确告知，不能把成功写入当成待重试事务。
  await revealControl(page, '#topic-history');
  await page.locator('#topic-history').click();
  await page.locator('#topic-history-dialog .topic-history-row button').first().click();
  await page.locator('#topic-changes-dialog').waitFor();
  await page.evaluate(() => {
    const original = Search.loadResults;
    Search.loadResults = async (...args) => {
      Search.loadResults = original;
      throw new Error('模拟界面刷新失败');
    };
  });
  await page.locator('#topic-changes-apply').click();
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('恢复已保存，界面刷新失败'));
  await page.locator('#topic-back').click();
  await page.locator('#warehouse-query').fill('历史恢复验证当前');
  await page.getByRole('button', { name: '打开主题 历史恢复验证当前', exact: true }).click();
  // 预览期间其他窗口改动主题，不能用旧候选覆盖。
  await page.locator('#topic-update').click();
  await page.locator('#topic-changes-dialog').waitFor();
  await page.evaluate((id) => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const entry = archive.list().entries.find((item) => item.id === id);
    archive.replace({ ...entry, name: '其他窗口修改' }, entry.updatedAt);
  }, fixture.entry.id);
  await page.locator('#topic-changes-apply').click();
  await page.waitForFunction(() => document.getElementById('topic-changes-error').textContent.includes('其他操作更新'));
  await page.evaluate(() => { eagle.library.path = 'D:/another.library'; });
  await page.locator('#topic-changes-apply').click();
  await page.waitForFunction(() => document.getElementById('topic-changes-error').textContent.includes('已切换'));
  await page.evaluate(() => { eagle.library.path = 'D:/fixture.library'; });
  await page.locator('#topic-changes-cancel').click();
  await page.locator('#topic-back').click();
  await page.locator('#warehouse-query').fill('其他窗口修改');
  await page.getByRole('button', { name: '打开主题 其他窗口修改', exact: true }).click();
  await page.locator('#topic-update').click();
  await page.locator('#topic-changes-dialog').waitFor();
  const beforeLateSwitch = await page.evaluate(() => Search.getRawMatches());
  await page.evaluate(() => document.getElementById('topic-changes-dialog').addEventListener('close', () => {
    eagle.library.path = 'D:/another.library';
  }, { once: true, capture: true }));
  await page.locator('#topic-changes-apply').click();
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('已保存到原素材库'));
  assert.deepStrictEqual(await page.evaluate(() => Search.getRawMatches()), beforeLateSwitch, '提交后切库不把旧库候选装入新库页面');
  await page.evaluate(() => { eagle.library.path = 'D:/fixture.library'; });
  await page.locator('#topic-search').click();
  await page.locator('#btn-archives').click();
  await page.locator('#warehouse-query').fill(query);
  await page.locator('#warehouse-back').click();
}

async function runTopicCopySmoke(page) {
  const fixture = await page.evaluate(() => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const match = { ...Search.getRawMatches()[0], similarity: 23.75, reviewedAt: '2026-10-20T00:00:00Z',
      manualScore: { value: 23.75, mode: 'custom', scoredAt: '2026-10-20T00:00:00Z' } };
    const removed = { ...match, original_start_frame: 99900, original_end_frame: 99950 };
    let source = archive.add({ name: '复制完整主题验证', recipe: Search.getRecipe(),
      matches: [match], view: { sortBy: 'sim', grouped: false, minDur: 0 } });
    source = archive.replace({ ...source, favorite: true, cover: { dataUrl: 'data:image/jpeg;base64,YQ==' },
      removedMatches: [{ key: ArchiveStore.sceneKey(removed), match: removed, removedAt: '2026-10-20T00:00:00Z' }] }, source.updatedAt);
    return { source: archive.list().entries.find((entry) => entry.id === source.id),
      count: archive.list().entries.length, requests: window.__requests.length };
  });
  await page.locator('#btn-archives').click();
  const query = await page.locator('#warehouse-query').inputValue();
  await page.locator('#warehouse-query').fill('复制完整主题验证');
  const card = page.locator('.warehouse-card').filter({ has: page.locator('h2', { hasText: '复制完整主题验证' }) });
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#entry-name').fill('尚未保存的名称');
  await page.locator('#entry-copy').click();
  assert.strictEqual(await page.locator('#topic-copy-name').inputValue(), '复制完整主题验证 副本');
  await page.keyboard.press('Escape');
  assert.strictEqual(await page.locator('#entry-name').inputValue(), '尚未保存的名称', '取消副本保留原编辑输入');
  await page.locator('#entry-copy').click();
  await page.locator('#topic-copy-name').fill('新的独立副本');
  for (const width of [1100, 480]) {
    await page.setViewportSize({ width, height: 720 });
    const bounds = await page.locator('#topic-copy-dialog').boundingBox();
    assert(bounds.x >= 15 && bounds.x + bounds.width <= width - 15);
    await page.screenshot({ path: path.join(os.tmpdir(), `eagle-topic-copy-${width}.png`) });
  }
  await page.evaluate(() => { eagle.library.path = 'D:/another.library'; });
  await page.locator('#topic-copy-dialog button[type=submit]').click();
  assert((await page.locator('#topic-copy-error').textContent()).includes('已切换'));
  await page.evaluate(() => { eagle.library.path = 'D:/fixture.library'; window.__writeFail = true; });
  await page.locator('#topic-copy-dialog button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('topic-copy-error').textContent.includes('模拟写盘失败'));
  assert.strictEqual(await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.length), fixture.count);
  await page.evaluate(() => { window.__writeFail = false; });
  await page.locator('#topic-copy-dialog button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('topic-name').textContent === '新的独立副本');
  const copy = await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.find((entry) => entry.name === '新的独立副本'));
  assert.notStrictEqual(copy.id, fixture.source.id);
  assert.deepStrictEqual(copy.matches, fixture.source.matches);
  assert.deepStrictEqual(copy.removedMatches, fixture.source.removedMatches);
  assert.deepStrictEqual(copy.cover, fixture.source.cover);
  assert.strictEqual(copy.updatedAt, fixture.source.updatedAt);
  assert.deepStrictEqual(await page.evaluate((id) => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.find((entry) => entry.id === id), fixture.source.id), fixture.source);
  assert.strictEqual(await page.evaluate(() => window.__requests.length), fixture.requests, '复制主题不搜索');
  await page.setViewportSize({ width: 1100, height: 720 });
  await revealControl(page, '#topic-edit');
  await page.locator('#topic-edit').click();
  await page.locator('#entry-copy').click();
  await page.evaluate((id) => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const entry = archive.list().entries.find((item) => item.id === id);
    archive.setFavorite(id, false, entry.updatedAt, entry.revision);
  }, copy.id);
  await page.locator('#topic-copy-dialog button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('topic-copy-error').textContent.includes('其他操作更新'));
  assert.strictEqual(await page.evaluate(() => ArchiveStore.open(Config.pluginPath(), eagle.library.path).list().entries.length), fixture.count + 1);
  await page.locator('#topic-copy-dialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('#entry-cancel').click();
  await page.locator('#topic-search').click();
  await page.locator('#btn-archives').click();
  await page.locator('#warehouse-query').fill(query);
  await page.locator('#warehouse-back').click();
}

async function revealControl(page, selector) {
  const menu = page.locator(selector).locator('xpath=ancestor::details[contains(@class,"compact-menu")]');
  if (await menu.count() && await menu.getAttribute('open') === null) await menu.locator('summary').click();
}

async function closeCompactMenus(page) {
  for (const menu of await page.locator('.compact-menu[open]').all()) await menu.locator('summary').click();
}

async function selectPreviewLayout(page, value) {
  await revealControl(page, '#preview-layout');
  await page.locator('#preview-layout').selectOption(value);
  await closeCompactMenus(page);
}

async function runCompactLayoutSmoke(page) {
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  assert.strictEqual(await page.locator('.topbar').count(), 0, '删除标题和常驻服务状态栏');
  assert.strictEqual(await page.locator('#service-text').textContent(), '加载搜索服务…');
  assert(await page.locator('#service-text').isVisible());
  assert(await page.locator('#btn-index-primary').isDisabled());
  await page.evaluate(() => __serviceCallback('offline', '模拟搜索服务连接失败'));
  assert((await page.locator('#service-dot').getAttribute('class')).includes('offline'));
  assert((await page.locator('#service-status').getAttribute('title')).includes('连接失败'));
  await page.evaluate(() => __serviceCallback('online', '搜索服务已连接'));
  assert((await page.locator('#service-dot').getAttribute('class')).includes('online'));
  assert(!(await page.locator('#service-text').isVisible()), '连接后仅保留绿灯');
  assert.strictEqual(await page.locator('#service-status + #index-mode-picker').count(), 1);
  assert.strictEqual(await page.locator('#btn-archives + #topic-search + #btn-settings').count(), 1);
  assert(!(await page.locator('#btn-organize-undo').isVisible()), '普通搜索不显示撤销整理');
  assert.strictEqual(await page.locator('#btn-prepare-clip, #btn-drag-clip, #btn-clip-directory, #btn-frame-text, #result-orientation, #topic-review, #frame-text-dialog').count(), 0);
  await page.locator('.search-options summary').click();
  await revealControl(page, '#search-time');
  assert(await page.locator('#search-time').isVisible());
  await revealControl(page, '#search-time');
  await page.locator('#search-time').selectOption('custom');
  await revealControl(page, '#search-time-start');
  assert(await page.locator('#search-time-start').isVisible());
  await revealControl(page, '#search-time');
  await page.locator('#search-time').selectOption('all');
  await page.keyboard.press('Escape');
  assert.strictEqual(await page.locator('.compact-menu[open]').count(), 0);
  await page.locator('#query').fill('侧栏布局验证');
  await page.locator('#btn-search').click();
  await page.waitForFunction(() => Search.getRawMatches().length > 0);
  assert(await page.locator('#inspector-empty').isVisible());
  const fixture = await page.evaluate(() => {
    Object.assign(window.__items[0], { width: 1920, height: 1080, size: 10485760, star: 3,
      lastModified: Date.UTC(2026, 9, 1), tags: ['原标签', ...Array.from({ length: 13 }, (_, i) => `标签 ${i}`)] });
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const entry = archive.add({ name: '右侧主题 <测试>', matches: Search.getRawMatches().slice(0, 1),
      recipe: Search.getRecipe(), view: Search.getView() });
    TopicRelations.refresh();
    return { name: entry.name, files: JSON.stringify([...window.__files]), requests: window.__requests.length };
  });
  await closeCompactMenus(page);
  await page.locator('#results .card .name').first().click();
  assert(await page.locator('#preview-panel').isVisible());
  assert(!(await page.locator('#inspector-empty').isVisible()));
  assert.strictEqual(await page.locator('#preview-tags button').count(), 14);
  assert((await page.locator('#preview-rating').textContent()).includes('★★★☆☆'));
  assert((await page.locator('#preview-details').textContent()).includes('1920 × 1080'));
  assert((await page.locator('#preview-details').textContent()).includes('10.00 MB'));
  await page.waitForFunction((name) => document.getElementById('preview-membership').textContent.includes(name), fixture.name);
  assert.strictEqual(await page.locator('#preview-membership button img').count(), 0);
  for (const width of [1450, 1100, 800, 480]) {
    await page.setViewportSize({ width, height: 740 });
    const geometry = await page.evaluate(() => {
      const list = document.getElementById('results').getBoundingClientRect();
      const inspector = document.querySelector('.inspector').getBoundingClientRect();
      return { listRight: list.right, inspectorLeft: inspector.left, inspectorRight: inspector.right,
        top: list.top, height: list.height, width: document.body.scrollWidth,
        sideOverflow: document.querySelector('.inspector').scrollWidth - document.querySelector('.inspector').clientWidth };
    });
    assert(geometry.inspectorLeft >= geometry.listRight - 1, '详情栏位于结果右侧');
    assert(geometry.inspectorRight <= width + 1 && geometry.width <= width, `${width}px 页面不横向溢出`);
    assert(geometry.sideOverflow <= 1 && geometry.height > 350, '侧栏不横向溢出且结果保留高度');
    assert(geometry.top < (width <= 600 ? 280 : 235), '收纳选项后结果首屏保持紧凑');
    await page.screenshot({ path: path.join(os.tmpdir(), `eagle-inspector-light-${width}.png`) });
  }
  await page.setViewportSize({ width: 1100, height: 740 });
  const resizer = page.locator('#inspector-resizer');
  const originalWidth = await page.locator('#inspector').evaluate((element) => element.getBoundingClientRect().width);
  const edge = await resizer.boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 100);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 100, edge.y + 100, { steps: 5 });
  await page.mouse.up();
  const wider = await page.locator('#inspector').evaluate((element) => element.getBoundingClientRect().width);
  assert(Math.abs(wider - originalWidth - 100) <= 1, '接缝向左拖动增大右栏');
  assert.strictEqual(Number(await page.evaluate(() => localStorage.getItem('eagle-semantic-inspector-width'))), wider);
  assert(!(await page.locator('body').getAttribute('class') || '').includes('resizing-inspector'), '结束拖动恢复页面交互');
  await page.setViewportSize({ width: 480, height: 740 });
  await page.waitForFunction(() => document.getElementById('inspector').offsetWidth <= 274);
  assert.strictEqual(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1100, height: 740 });
  await page.waitForFunction((width) => Math.abs(document.getElementById('inspector').offsetWidth - width) <= 1, wider);
  await resizer.focus();
  await page.keyboard.press('ArrowRight');
  assert.strictEqual(Number(await resizer.getAttribute('aria-valuenow')), wider - 10);
  assert.strictEqual(await page.locator('#results .preview-active').count(), 1, '调宽快捷键不切换预览');
  await page.keyboard.press('End');
  assert.strictEqual(await resizer.getAttribute('aria-valuenow'), await resizer.getAttribute('aria-valuemax'));
  await page.keyboard.press('Home');
  assert.strictEqual(await resizer.getAttribute('aria-valuenow'), await resizer.getAttribute('aria-valuemin'));
  await page.keyboard.press('ArrowLeft');
  const layoutSnapshot = await page.evaluate(() => ({
    active: ArchiveStore.sceneKey(Search.getActiveMatch()), matches: Search.getRawMatches().length,
    requests: window.__requests.length, files: JSON.stringify([...window.__files]),
  }));
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await selectPreviewLayout(page, 'top');
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('eagle-semantic-preview-layout')), 'top');
  assert(!(await resizer.isVisible()));
  assert(!(await page.locator('#preview-membership').isVisible()));
  assert(await page.locator('#preview-panel').isVisible());
  for (const width of [1100, 800, 480]) {
    await page.setViewportSize({ width, height: 740 });
    const boxes = await page.evaluate(() => {
      const preview = document.getElementById('preview-panel').getBoundingClientRect();
      const results = document.getElementById('results').getBoundingClientRect();
      return { previewBottom: preview.bottom, resultsTop: results.top, resultsWidth: results.width,
        pageWidth: document.body.scrollWidth, viewport: innerWidth };
    });
    assert(boxes.previewBottom <= boxes.resultsTop + 1, '顶部预览位于列表上方');
    assert(Math.abs(boxes.resultsWidth - width) <= 1 && boxes.pageWidth <= width, '顶部模式释放右栏空间');
    await page.screenshot({ path: path.join(os.tmpdir(), `eagle-preview-top-${width}.png`) });
  }
  await selectPreviewLayout(page, 'sidebar');
  await page.setViewportSize({ width: 1100, height: 740 });
  assert(await resizer.isVisible());
  assert.strictEqual(Number(await resizer.getAttribute('aria-valuenow')), 230, '恢复右栏原有宽度偏好');
  assert.deepStrictEqual(await page.evaluate(() => ({
    active: ArchiveStore.sceneKey(Search.getActiveMatch()), matches: Search.getRawMatches().length,
    requests: window.__requests.length, files: JSON.stringify([...window.__files]),
  })), layoutSnapshot, '切换布局保留当前片段与结果，不搜索或写仓库');
  assert.strictEqual(await page.locator('#results .pick:checked').count(), 1);
  await revealControl(page, '#btn-clear-selection');
  await page.locator('#btn-clear-selection').click();
  await page.locator('#result-filter-menu summary').click();
  await page.keyboard.press('Escape');
  assert(await page.locator('#preview-panel').isVisible(), 'Esc 优先关闭菜单，保留预览');
  await page.locator('#preview-membership button').click();
  await page.waitForFunction((name) => document.getElementById('topic-name').textContent === name, fixture.name);
  assert(await page.locator('#btn-organize-undo').isVisible(), '具体主题内显示撤销整理');
  assert.strictEqual(await page.locator('#view-bar #btn-save-results + #btn-organize-undo').count(), 1);
  await page.locator('#btn-archives').click();
  await page.waitForFunction(() => document.body.dataset.page === 'warehouse');
  assert(!(await page.locator('#btn-organize-undo').isVisible()), '仓库列表不显示撤销整理');
  assert(await page.locator('#btn-settings').isVisible());
  await page.locator('#warehouse-back').click();
  await page.locator('#topic-search').click();
  assert(!(await page.locator('#btn-organize-undo').isVisible()), '回到普通搜索隐藏撤销整理');
  assert.strictEqual(await page.evaluate(() => JSON.stringify([...window.__files])), fixture.files, '查看详情和主题跳转不写盘');
  assert.strictEqual(await page.evaluate(() => window.__requests.length), fixture.requests, '查看详情不重新推理');
  await closeCompactMenus(page);
  await page.locator('#results .card .name').first().click();
  await page.locator('#btn-close-preview').click();
  assert(await page.locator('#inspector-empty').isVisible());
  await closeCompactMenus(page);
  await page.locator('#results .card .name').first().click();
  await page.keyboard.press('ArrowRight');
  assert.strictEqual(await page.locator('#results .preview-active').count(), 1);
  await page.keyboard.press('Escape');
  assert(!(await page.locator('#preview-panel').isVisible()));
}

async function runResultRelationsSmoke(page) {
  const fixture = await page.evaluate(async () => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const source = Search.captureState();
    const items = window.__items;
    items[0].width = 1920; items[0].height = 1080;
    items[1].width = 1080; items[1].height = 1920;
    items[2].width = 600; items[2].height = 600;
    const matches = items.map((item, i) => ({ eagleItemId: item.id, video_path: item.filePath, video_name: item.name,
      start_frame: 70000 + i * 100, end_frame: 70100 + i * 100, fps: 25, similarity: 30 - i,
      start: '00:01', end: '00:05', duration_seconds: 4 + i }));
    const view = { sortBy: 'sim', grouped: false, minDur: 0 };
    const a = archive.add({ name: '组合比较 A', matches: matches.slice(0, 2), view, recipe: Search.getRecipe() });
    const b = archive.add({ name: '组合比较 B', matches: [matches[0], matches[2]], view, recipe: Search.getRecipe() });
    await Search.loadResults(matches, '组合比较来源', Search.getRecipe(), view);
    return { source, a: a.id, b: b.id, matches, files: JSON.stringify([...window.__files]), requests: window.__requests.length };
  });
  await revealControl(page, '#topic-scene-query');
  await page.locator('#topic-scene-query').fill('城市');
  await revealControl(page, '#result-tags');
  await page.locator('#result-tags').fill('原标签');
  await revealControl(page, '#result-max-dur');
  await page.locator('#result-max-dur').fill('4');
  await revealControl(page, '#result-max-dur');
  await page.locator('#result-max-dur').blur();
  await page.waitForFunction(() => Search.getAllMatches().length === 1);
  assert.strictEqual(await page.locator('#result-count').textContent(), '1/3 条');
  assert.strictEqual(await page.locator('#topic-scene-filter').evaluate((el) => el.scrollWidth <= el.clientWidth), true);
  await closeCompactMenus(page);
  await page.locator('#results .pick').first().check();
  await revealControl(page, '#topic-scene-query');
  await page.locator('#topic-scene-query').fill('不存在的名称');
  await page.waitForFunction(() => Search.getAllMatches().length === 0);
  assert.strictEqual(await page.evaluate(() => Search.getSelectedMatches()), null, '隐藏片段不会残留勾选');
  await revealControl(page, '#result-filter-clear');
  await page.locator('#result-filter-clear').click();
  assert.strictEqual(await page.evaluate(() => Search.getAllMatches().length), 3);
  await revealControl(page, '#result-max-dur');
  await page.locator('#result-max-dur').fill('2'); await page.locator('#result-max-dur').blur();
  await revealControl(page, '#view-min-dur');
  await page.locator('#view-min-dur').fill('3'); await page.locator('#view-min-dur').blur();
  assert.strictEqual(await page.locator('#view-min-dur').inputValue(), '0', '上下限冲突不应用无效条件');
  await revealControl(page, '#result-filter-clear');
  await page.locator('#result-filter-clear').click();
  await closeCompactMenus(page);
  await page.locator('#results .card .name').first().click();
  await page.waitForFunction(() => document.getElementById('preview-membership').textContent.includes('组合比较 A'));
  for (const width of [1100, 480]) {
    await page.setViewportSize({ width, height: 720 });
    assert(await page.locator('#topic-scene-filter').evaluate((el) => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: path.join(os.tmpdir(), `eagle-result-filters-${width}.png`) });
  }
  await page.setViewportSize({ width: 1100, height: 720 });
  assert.strictEqual(await page.locator('#preview-membership button').count(), 2);
  await page.locator('#preview-membership').getByRole('button', { name: '组合比较 A', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('topic-name').textContent === '组合比较 A');
  assert.strictEqual(await page.evaluate(() => Search.getRawMatches().length), 2, '归属面板可打开对应主题');
  await page.locator('#topic-search').click();
  assert.strictEqual(await page.evaluate(() => Search.getRawMatches().length), 3, '从归属主题返回保留来源会话');
  await page.evaluate(({ a, b }) => TopicRelations.showCompare([a, b]), fixture);
  assert.strictEqual(await page.locator('#relations-tabs button').allTextContents().then((v) => v.join(',')), '共有 1,A 独有 1,B 独有 1');
  for (const tab of ['common', 'left', 'right']) {
    await page.locator(`#relations-tabs [data-mode=${tab}]`).click();
    assert.strictEqual(await page.locator('#relations-list .relations-row').count(), 1);
  }
  await page.locator('#relations-list').getByRole('button', { name: '预览' }).click();
  assert(await page.locator('#relations-video').isVisible());
  for (const width of [1100, 480]) {
    await page.setViewportSize({ width, height: 720 });
    const box = await page.locator('#topic-relations-dialog').boundingBox();
    assert(box.x >= 15 && box.x + box.width <= width - 15, '比较面板不超出视口');
    assert(await page.locator('#topic-relations-dialog').evaluate((el) => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: path.join(os.tmpdir(), `eagle-result-relations-${width}.png`) });
  }
  await page.locator('#relations-right').selectOption(fixture.a);
  assert((await page.locator('#relations-status').textContent()).includes('不同的主题'));
  assert.strictEqual(await page.locator('#relations-list .relations-row').count(), 0);
  await page.locator('#relations-right').selectOption(fixture.b);
  await page.locator('#relations-close').click();
  assert.strictEqual(await page.evaluate(() => JSON.stringify([...window.__files])), fixture.files, '筛选、归属、比较及预览不写仓库');
  assert.strictEqual(await page.evaluate(() => window.__requests.length), fixture.requests, '组合筛选和比较不重新推理');
  await page.evaluate(({ a, b }) => TopicRelations.showCompare([a, b]), fixture);
  await page.evaluate(async ({ a, b, matches }) => {
    const archive = ArchiveStore.open(Config.pluginPath(), eagle.library.path);
    const left = archive.list().entries.find((entry) => entry.id === a);
    archive.removeMatches(a, [ArchiveStore.sceneKey(matches[0])], left.updatedAt, left.revision || 0);
    const right = archive.list().entries.find((entry) => entry.id === b);
    await archive.hydrateEntry(right);
    archive.replace({ ...right, name: '组合比较 B 改名' }, right.updatedAt);
  }, fixture);
  await page.locator('#relations-reload').click();
  await page.waitForFunction(() => document.querySelector('#relations-tabs button')?.textContent === '共有 0');
  assert.strictEqual(await page.locator('#relations-tabs button').allTextContents().then((v) => v.join(',')), '共有 0,A 独有 1,B 独有 2');
  await page.locator('#relations-close').click();
  await closeCompactMenus(page);
  await page.locator('#results .card .name').first().click();
  await page.waitForFunction(() => document.getElementById('preview-membership').textContent === '组合比较 B 改名');
  await page.evaluate(({ a, b }) => TopicRelations.showCompare([a, b]), fixture);
  await page.evaluate(() => { eagle.library.path = 'D:/other-relations.library'; });
  await page.locator('#relations-reload').click();
  assert((await page.locator('#relations-status').textContent()).includes('已切换'));
  await page.locator('#relations-close').click();
  await page.evaluate((source) => { eagle.library.path = 'D:/fixture.library'; Search.restoreState(source); }, fixture.source);
  await page.setViewportSize({ width: 1100, height: 720 });
}

async function runMediaDragSmoke(page) {
  await page.locator('#query').fill('拖拽验证');
  await page.locator('#btn-search').click();
  await page.waitForFunction(() => Search.getRawMatches().length > 0);
  const thumbs = page.locator('#results .thumb-box');
  assert(await thumbs.first().getAttribute('draggable') === 'true');
  await thumbs.first().dispatchEvent('dragstart');
  assert.strictEqual(await page.evaluate(() => __drags[0].length), 1);
  await closeCompactMenus(page);
  await page.locator('#results .pick').nth(0).check();
  await closeCompactMenus(page);
  await page.locator('#results .pick').nth(1).check();
  await thumbs.first().dispatchEvent('dragstart');
  assert.strictEqual(await page.evaluate(() => __drags[1].length), 1, '同素材多个片段只拖一份');
  assert.strictEqual(await page.evaluate(() => window.__clipRequests?.length || 0), 0, '原视频拖拽不调用生成接口');
  // 点击文字打开预览，避开刚拖拽后的缩略图点击抑制。
  await closeCompactMenus(page);
  await page.locator('#results .card .name').first().click();
  assert.strictEqual(await page.locator('#btn-drag-clip, #btn-prepare-clip, #btn-clip-directory').count(), 0);
  const count = await page.evaluate(() => __drags.length);
  await page.evaluate(() => { eagle.library.path = 'D:/other.library'; });
  await thumbs.first().dispatchEvent('dragstart');
  assert.strictEqual(await page.evaluate(() => __drags.length), count, '跨库拒绝原视频拖出');
  await page.evaluate(() => { eagle.library.path = 'D:/fixture.library'; });
  const beforeMissing = await page.evaluate(() => __drags.length);
  await page.evaluate(() => { window.__missingDragFile = __items[0].filePath; });
  // 素材映射失效后不得继续拖出旧路径。
  await page.evaluate(() => { Bridge.invalidateCache(); });
  await thumbs.first().dispatchEvent('dragstart');
  assert.strictEqual(await page.evaluate(() => __drags.length), beforeMissing);
  await page.evaluate(() => Bridge.refreshPathMap());
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
