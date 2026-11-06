/* 设置页中的素材库工具：库统计、语义查重、离线索引维护说明与旧索引迁移指南。 */
const LibraryTools = (() => {
  const { $, esc, toast, h } = Dom;
  let isServiceOnline = () => false;

  // ---------- 素材库统计 ----------
  function statsBar(label, count, max, extra = '') {
    const pct = max > 0 ? Math.max((count / max) * 100, 1.5) : 0;
    return `<div class="stat-row"><span class="stat-label" title="${esc(label)}">${esc(label)}</span>`
      + `<span class="stat-track"><span class="stat-fill" style="width:${pct}%"></span></span>`
      + `<span class="stat-num">${count}${extra}</span></div>`;
  }

  async function openStats() {
    const body = $('stats-body');
    body.innerHTML = '<p class="hint">统计中…</p>';
    $('stats-dialog').showModal();
    const online = isServiceOnline();
    try {
      const videos = await Bridge.collectLibraryVideos();
      const total = videos.length;

      // 索引覆盖率
      let indexedCount = 0;
      if (online) {
        const indices = await Search.findLibraryIndexes();
        const coverages = [];
        for (const p of indices) {
          coverages.push(await Api.indexCoverage(p));
        }
        const summary = Bridge.summarizeIndexCoverage(videos, coverages);
        indexedCount = summary.indexed;
      }

      // 标签分布 + 提纯产出
      const tagCount = new Map();
      let purified = 0;
      videos.forEach((v) => {
        const tags = Array.isArray(v.tags) ? v.tags : [];
        tags.forEach((t) => tagCount.set(t, (tagCount.get(t) || 0) + 1));
        if (tags.includes('自动提纯')) purified += 1;
      });
      const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

      // 时长分布（Eagle 视频素材的 duration 单位为秒）
      const buckets = [
        ['0-2 秒', 0, 2], ['2-5 秒', 2, 5], ['5-15 秒', 5, 15],
        ['15-60 秒', 15, 60], ['1-5 分钟', 60, 300], ['>5 分钟', 300, Infinity],
      ];
      const durCounts = buckets.map(() => 0);
      let unknownDur = 0;
      videos.forEach((v) => {
        const d = Number(v.duration);
        if (!Number.isFinite(d) || d <= 0) { unknownDur += 1; return; }
        const i = buckets.findIndex(([, lo, hi]) => d >= lo && d < hi);
        if (i >= 0) durCounts[i] += 1;
      });

      const maxTag = topTags.length ? topTags[0][1] : 0;
      const maxDur = Math.max(...durCounts, 1);
      body.innerHTML = `
        <div class="stat-summary">
          视频素材 <b>${total}</b> 个 ·
          已索引 <b>${online ? indexedCount : '?'}</b>（${online && total ? Math.round(indexedCount / total * 100) : '?'}%） ·
          提纯产出片段 <b>${purified}</b> 个
        </div>
        <h4>时长分布${unknownDur ? `（${unknownDur} 个未知时长未计入）` : ''}</h4>
        ${buckets.map(([label], i) => statsBar(label, durCounts[i], maxDur)).join('')}
        <h4>标签 Top ${topTags.length}</h4>
        ${topTags.length ? topTags.map(([t, n]) => statsBar(t, n, maxTag)).join('')
          : '<p class="hint">还没有任何标签（提纯或打标签后这里会出现分布）</p>'}
      `;
    } catch (e) {
      body.innerHTML = `<p class="hint form-error">统计失败：${esc(e.message)}</p>`;
    }
  }

  // ---------- 语义查重 ----------
  async function openCoverage() {
    const library = eagle.library.path;
    const model = h('select', { attrs: { 'aria-label': '索引模型' } });
    const status = h('select', { attrs: { 'aria-label': '覆盖状态' } },
      ...[['missing', '未处理'], ['failed', '失败'], ['skipped', '跳过'], ['indexed', '已索引'], ['unknown', '已处理，状态未知']]
        .map(([value, text]) => h('option', { value, text })));
    const summary = h('p', { className: 'hint', attrs: { role: 'status' }, text: '正在读取覆盖清单…' });
    const list = h('div', { className: 'coverage-list' });
    const more = h('button', { type: 'button', text: '加载更多', hidden: true });
    const dialog = h('dialog', { className: 'ai-plan-dialog confirm-dialog' },
      h('h3', { text: '当前素材库索引覆盖清单' }),
      h('div', { className: 'sequence-options' }, model, status), summary, list, more,
      h('div', { className: 'dialog-actions' }, h('button', { type: 'button', text: '关闭', onclick: () => dialog.close() })));
    let rows = [];
    let generation = 0;
    let shown = 0;
    const append = () => {
      const matching = rows.filter((row) => row.status === status.value);
      for (const row of matching.slice(shown, shown + 100)) list.append(h('div', { className: 'coverage-row' },
        h('span', { text: row.item.name, title: row.item.filePath }),
        h('button', { type: 'button', text: '在全部中显示', onclick: async () => {
          try {
            if (library !== eagle.library.path) throw new Error('素材库已切换，请重新打开覆盖清单');
            await Bridge.revealInAll(row.item.id);
          } catch (error) { toast(error.message, true); }
        } })));
      shown = Math.min(shown + 100, matching.length);
      more.hidden = shown >= matching.length;
    };
    const render = () => { shown = 0; list.replaceChildren(); append(); };
    const load = async () => {
      const token = ++generation;
      rows = [];
      list.replaceChildren(); more.hidden = true;
      summary.textContent = '正在读取覆盖清单…';
      try {
        if (!isServiceOnline()) throw new Error('请先连接搜索服务');
        const identity = await Bridge.resolveLibraryIdentity();
        const indexes = (await Api.listIndexes(identity.id)).filter((index) => index.model === model.value);
        const videos = await Bridge.collectLibraryVideos();
        const coverages = await Promise.all(indexes.map((index) => Api.indexCoverage(index.path)));
        if (!dialog.open || token !== generation) return;
        if (library !== eagle.library.path) throw new Error('素材库已切换，请重新打开覆盖清单');
        const paths = {};
        for (const [key, field] of [['indexed', 'indexedPaths'], ['skipped', 'skippedPaths'], ['failed', 'failedPaths'], ['unknown', 'processedPaths']]) {
          paths[key] = new Set(coverages.flatMap((coverage) => coverage[field]).map(Bridge.normalizePath));
        }
        rows = videos.map((item) => ({ item, status: ['indexed', 'skipped', 'failed', 'unknown']
          .find((key) => paths[key].has(Bridge.normalizePath(item.filePath))) || 'missing' }));
        summary.textContent = [...status.options].map((option) => `${option.text} ${rows.filter((row) => row.status === option.value).length}`).join(' · ')
          + (indexes.length ? '。具体原因可查看对应索引任务记录。' : '。该模型尚无索引。');
        render();
      } catch (error) { if (dialog.open && token === generation) summary.textContent = error.message; }
    };
    model.append(h('option', { value: Config.get().modelName, text: Config.get().modelName }));
    status.addEventListener('change', render);
    model.addEventListener('change', load);
    more.addEventListener('click', append);
    dialog.addEventListener('close', () => { generation += 1; dialog.remove(); });
    document.body.append(dialog); dialog.showModal();
    try {
      const identity = await Bridge.resolveLibraryIdentity();
      const indexes = await Api.listIndexes(identity.id);
      if (!dialog.open || library !== eagle.library.path) return;
      const names = [...new Set([Config.get().modelName, ...indexes.map((index) => index.model)])];
      model.replaceChildren(...names.map((name) => h('option', { value: name, text: name })));
      await load();
    } catch (error) { if (dialog.open) summary.textContent = error.message; }
  }

  async function runDedupScan() {
    const body = $('dedup-body');
    body.innerHTML = '<p class="hint">扫描中（读取索引向量并聚类）…</p>';
    try {
      const indices = await Search.findLibraryIndexes();
      if (indices.length === 0) {
        body.innerHTML = '<p class="hint">当前素材库还没有索引，请先建索引。</p>';
        return;
      }
      await Bridge.refreshPathMap();
      const threshold = Math.min(Math.max(parseFloat($('dedup-threshold').value) || 0.93, 0.8), 0.99);
      const resp = await Api.dedupScan(indices, threshold);
      if (!resp.ok || !resp.data || !resp.data.success) {
        body.innerHTML = `<p class="hint form-error">扫描失败：${esc((resp.data && resp.data.error) || resp.status)}</p>`;
        return;
      }
      const groups = resp.data.groups || [];
      if (groups.length === 0) {
        body.innerHTML = `<p class="hint">没有发现相似度 ≥ ${threshold} 的重复视频（共扫描 ${resp.data.video_count} 个）。可调低阈值再试。</p>`;
        return;
      }
      body.replaceChildren(h('p', { className: 'hint',
        text: `共扫描 ${resp.data.video_count} 个视频，发现 ${resp.data.group_count} 组相似（每组保留哪个由你决定，可先「选中」在 Eagle 中查看）` }));
      groups.forEach((g, gi) => {
        const names = g.videos.map((v) => {
          const item = Bridge.itemForPath(v.video_path);
          return item ? item.name : v.video_path.split(/[\\/]/).pop();
        });
        const info = h('span', { className: 'archive-name',
          text: `组${gi + 1}（${g.videos.length} 个）：${names.join('、')}`,
          title: g.videos.map((v) => `${v.video_path}（相似度 ${v.similarity}）`).join('\n') });
        const locate = h('button', { type: 'button', text: '在 Eagle 中选中', onclick: async () => {
          const ids = g.videos.map((v) => Bridge.itemForPath(v.video_path))
            .filter(Boolean).map((it) => it.id);
          if (ids.length === 0) {
            toast('这组素材已不在库中', true);
            return;
          }
          await Bridge.locateInEagle(ids);
        } });
        body.appendChild(h('div', { className: 'archive-row' }, info, locate));
      });
    } catch (e) {
      console.error(e);
      body.innerHTML = `<p class="hint form-error">扫描出错：${esc(e.message)}</p>`;
    }
  }

  function openDedupScan() {
    $('dedup-dialog').showModal();
    runDedupScan();
  }

  // ---------- 索引管理：统计 + 移入后端回收目录 ----------
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '?';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes; let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  async function renderIndexAdmin(body, generation) {
    body.replaceChildren(h('p', { className: 'hint', text: '读取索引统计…' }));
    const health = await Api.healthInfo();
    if (!health?.capabilities?.index_admin) throw new Error('搜索服务版本较旧，请在设置中重启搜索服务后再试');
    const library = await Bridge.resolveLibraryIdentity();
    const indexes = await Api.indexStats(library.id);
    if (generation !== indexAdminGeneration) return;
    const libraryPath = eagle.library.path;
    if (!indexes.length) {
      body.replaceChildren(h('p', { className: 'hint', text: '当前素材库还没有新版索引。' }));
      return;
    }
    const current = Config.get().modelName;
    body.replaceChildren(
      h('p', { className: 'hint', text: '统计只读取场景元数据，不加载向量。删除会把索引移到后端 indexes/.trash，可在服务停止后手动移回；索引任务排队或运行时不能删除。' }),
      ...indexes.map((item) => {
        const stats = item.error ? `读取失败：${item.error}`
          : `${item.video_count} 个视频 · ${item.scene_count} 个场景 · ${item.vector_count} 个向量`;
        const extra = [`占用 ${formatBytes(item.size_bytes)}`,
          item.skipped_count ? `无有效场景 ${item.skipped_count}` : '',
          item.failed_count ? `处理失败 ${item.failed_count}` : '',
          item.updated_at ? `更新于 ${new Date(item.updated_at * 1000).toLocaleString()}` : ''].filter(Boolean).join(' · ');
        const remove = h('button', { type: 'button', className: 'danger-text', text: '删除', onclick: async () => {
          const confirmed = await Dom.confirm({ title: '删除这个索引？', danger: true, confirmText: '移到回收目录',
            body: [`${item.model} / ${item.name}`, item.model === current
              ? '这是当前检索模型的索引，删除后搜索会提示未建索引，需要重新建索引。' : '其他模型的索引，删除不影响当前模型的搜索。',
            '已保存的主题和片段不受影响。'] });
          if (!confirmed) return;
          remove.disabled = true;
          try {
            if (eagle.library.path !== libraryPath) throw new Error('素材库已切换，请重新打开索引管理');
            const result = await Api.trashIndex(library.id, item.name);
            SearchCache.clear();
            toast(`已移到回收目录：${result.trash_path}`, false, 6000);
            await renderIndexAdmin(body, ++indexAdminGeneration);
          } catch (error) {
            remove.disabled = false;
            toast(`删除失败：${error.message}`, true, 6000);
          }
        } });
        return h('div', { className: 'archive-row index-admin-row' },
          h('div', { className: 'index-admin-info' },
            h('b', { text: item.model + (item.model === current ? '（当前模型）' : '') }),
            h('span', { className: 'hint', text: stats, title: item.path }),
            h('span', { className: 'hint', text: extra })),
          remove);
      }));
  }

  let indexAdminGeneration = 0;
  function openIndexAdmin() {
    if (!isServiceOnline()) { toast('搜索服务未连接', true); return; }
    const body = h('div', { className: 'stats-body' });
    const dialog = h('dialog', { className: 'index-admin-dialog' },
      h('div', { className: 'settings-form stats-form' },
        h('h3', { text: '索引管理' }), body,
        h('div', { className: 'dialog-actions' },
          h('button', { type: 'button', text: '刷新', onclick: () => load() }),
          h('button', { type: 'button', text: '关闭', onclick: () => dialog.close() }))));
    const load = () => renderIndexAdmin(body, ++indexAdminGeneration).catch((error) => {
      body.replaceChildren(h('p', { className: 'hint form-error', text: `读取失败：${error.message}` }));
    });
    dialog.addEventListener('close', () => { indexAdminGeneration += 1; dialog.remove(); });
    document.body.appendChild(dialog);
    dialog.showModal();
    load();
  }

  // 在线目录不能直接覆盖；离线维护工具会校验进程锁、包清单并保存回滚记录。
  function exportIndexes() {
    toast('索引导出已改为安全离线维护：关闭 5006/5007 服务后，使用后端 tools/index_package.py export；详见更新说明。不会压缩运行中的索引。', true, 10000);
  }

  function importIndexes() {
    toast('索引导入已改为安全离线维护：关闭 5006/5007 服务后，使用后端 tools/index_package.py import；自动校验并保留回滚备份。不会直接覆盖运行中的索引。', true, 10000);
  }

  // ---------- 旧索引迁移指南（静默检测，仅供控制台 window.showLegacyMigration() 打开） ----------
  function showLegacyMigration(legacy) {
    const dialog = document.createElement('dialog');
    dialog.className = 'legacy-migration-dialog';

    // 从旧索引名称移除 .lance 后缀
    const sourceIndexName = legacy.name.replace(/\.lance$/, '');
    const targetIndexName = legacy.currentName;
    const model = legacy.model || 'qihoo360-fg-clip2-base';

    const migrationCommand = `python\\python.exe tools\\index_package.py migrate --source "${sourceIndexName}" --target "${targetIndexName}" --model "${model}"`;

    dialog.innerHTML = `
      <h3>旧索引迁移指南</h3>
      <p class="hint">检测到旧版本的索引数据（<strong>${legacy.count.toLocaleString()}</strong> 条记录），需要迁移到新版本才能使用。</p>
      <div class="migration-info">
        <p><strong>旧索引：</strong><code>${esc(sourceIndexName)}</code></p>
        <p><strong>新索引：</strong><code>${esc(targetIndexName)}</code></p>
        <p><strong>模型：</strong><code>${esc(model)}</code></p>
      </div>
      <h4>迁移步骤</h4>
      <ol class="migration-steps">
        <li><strong>关闭服务：</strong>在后端目录运行 <code>stop-service.bat</code>（或手动关闭 5006 和 5007 端口服务）</li>
        <li><strong>运行迁移：</strong>在后端目录打开命令行，执行以下命令（已为您准备好，点击下方按钮可复制）：
          <pre class="migration-command">${esc(migrationCommand)}</pre>
        </li>
        <li><strong>启动服务：</strong>运行 <code>start-service.bat</code> 重新启动搜索服务</li>
        <li><strong>验证迁移：</strong>在插件中重新加载，索引提示应消失，搜索应正常工作</li>
      </ol>
      <div class="migration-warning">
        <p>⚠️ <strong>重要提示：</strong></p>
        <ul>
          <li>迁移过程中不要操作 Eagle 或搜索插件</li>
          <li>迁移会保留原索引，不会删除或覆盖数据</li>
          <li>如果迁移失败，原索引仍然完整，可以重试</li>
          <li>迁移成功后，旧索引仍然保留在后端，可手动删除或保留作为备份</li>
        </ul>
      </div>
      <div class="dialog-actions">
        <button type="button" data-action="close">知道了</button>
        <button type="button" data-action="copy" class="primary">复制迁移命令</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector('[data-action="close"]').addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-action="copy"]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(migrationCommand);
        toast('迁移命令已复制到剪贴板');
      } catch (e) {
        toast('复制失败，请手动复制命令', true);
      }
    });
    dialog.addEventListener('close', () => dialog.remove());
  }

  function init(options = {}) {
    if (typeof options.isServiceOnline === 'function') isServiceOnline = options.isServiceOnline;
    $('btn-stats').addEventListener('click', openStats);
    $('btn-index-coverage').addEventListener('click', openCoverage);
    $('btn-dedup-scan').addEventListener('click', openDedupScan);
    $('btn-index-admin').addEventListener('click', openIndexAdmin);
    $('btn-dedup-rescan').addEventListener('click', runDedupScan);
    $('btn-close-dedup').addEventListener('click', () => $('dedup-dialog').close());
    $('btn-close-stats').addEventListener('click', () => $('stats-dialog').close());
    $('btn-export-indexes').addEventListener('click', exportIndexes);
    $('btn-import-indexes').addEventListener('click', importIndexes);
  }

  return { init, openStats, openDedupScan, runDedupScan, openIndexAdmin, exportIndexes, importIndexes, showLegacyMigration };
})();
