/* 主题更新预览、单主题历史恢复与完整副本。 */
const WarehouseUpdates = (() => {
  function create(hooks) {
    const { $, node, store, checkIdle, requireTopic, beginNavigation, currentNavigation,
      syncSceneActions, load, editEntry } = hooks;
    let updating = false;
    let copying = false;

    function previewChanges(previous, candidate, { rawMatches, restore = false, note = '', commit }) {
      const changes = ArchiveStore.entryChanges(previous, candidate, rawMatches);
      const dialog = node('dialog', 'topic-changes-dialog');
      dialog.id = 'topic-changes-dialog';
      dialog.append(node('h2', '', restore ? '恢复此主题 · 预览变化' : '更新结果 · 预览变化'),
        node('p', 'topic-changes-summary', `「${candidate.name}」：${previous.matches.length} → ${candidate.matches.length} 个片段`),
        node('p', 'hint', restore
          ? '将恢复此版本的结果、人工评分、审阅进度、移除记录、封面和主题设置。其他主题保持当前状态。'
          : `保留 ${changes.retained} 个片段，其中 ${changes.manual.length} 个本次未命中的人工片段继续保留。确认后才替换已存结果。`));
      if (note) dialog.appendChild(node('p', 'hint', note));
      if (restore) {
        const counts = (entry) => [entry.matches.filter((match) => match.manualScore).length,
          entry.matches.filter((match) => match.reviewedAt).length, (entry.removedMatches || []).length];
        const before = counts(previous); const after = counts(candidate);
        dialog.appendChild(node('p', 'hint', ['人工评分', '已审阅', '已移除']
          .map((label, index) => `${label} ${before[index]} → ${after[index]}`).join(' · ')));
      }
      const lists = node('div', 'topic-changes-lists');
      const groups = [['新增', changes.added], ['消失', changes.removed]];
      if (!restore) groups.push(['人工保留', changes.manual]);
      for (const [label, matches] of groups) {
        const section = node('details');
        section.appendChild(node('summary', '', `${label} · ${matches.length}`));
        let rendered = 0;
        const rows = node('div');
        const more = node('button', '', '显示更多');
        more.type = 'button';
        const render = () => {
          const end = Math.min(rendered + 50, matches.length);
          for (; rendered < end; rendered += 1) {
            const match = matches[rendered];
            const name = Bridge.itemForPath(match.video_path)?.name || match.video_path.split(/[\\/]/).pop();
            const start = match.start || `第 ${match.original_start_frame ?? match.start_frame ?? 0} 帧`;
            const endFrame = match.end || `第 ${match.original_end_frame ?? match.end_frame ?? 0} 帧`;
            rows.appendChild(node('p', '', `${name} · ${start} — ${endFrame}`));
          }
          more.hidden = rendered >= matches.length;
        };
        section.addEventListener('toggle', () => { if (section.open && !rendered) render(); });
        more.addEventListener('click', render);
        section.append(rows, more); lists.appendChild(section);
      }
      dialog.appendChild(lists);
      const error = node('p', 'error'); error.id = 'topic-changes-error'; error.setAttribute('role', 'alert');
      const actions = node('div', 'dialog-actions');
      const cancel = node('button', '', '取消'); cancel.id = 'topic-changes-cancel'; cancel.type = 'button';
      const apply = node('button', 'primary', restore ? '恢复此主题' : '应用更新');
      apply.id = 'topic-changes-apply'; apply.type = 'button';
      actions.append(cancel, apply); dialog.append(error, actions); document.body.appendChild(dialog);
      return new Promise((resolve) => {
        let pending = false;
        let saved = null;
        cancel.addEventListener('click', () => { if (!pending) dialog.close(); });
        dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
        dialog.addEventListener('close', () => { dialog.remove(); resolve(saved); }, { once: true });
        apply.addEventListener('click', async () => {
          if (pending) return;
          pending = true; apply.disabled = true; cancel.disabled = true; error.textContent = '';
          try { saved = await commit(); dialog.close(); }
          catch (failure) { error.textContent = failure.message; }
          finally { pending = false; apply.disabled = false; cancel.disabled = false; }
        });
        dialog.showModal(); cancel.focus();
      });
    }

    async function topicHistory() {
      requireTopic();
      const entry = hooks.current();
      const navigation = beginNavigation();
      const archive = store();
      const dialog = node('dialog', 'topic-changes-dialog');
      dialog.id = 'topic-history-dialog';
      dialog.append(node('h2', '', `「${entry.name}」的历史版本`),
        node('p', 'hint', '来自当前保留的整库备份，同一主题版本只显示一次。默认保留最近 10 次仓库写入，并非每个主题 10 份；缺失或损坏的版本无法恢复。'));
      const error = node('p', 'error'); error.setAttribute('role', 'alert');
      const close = node('button', '', '关闭'); close.type = 'button';
      let pending = false;
      const versions = archive.entryHistory(entry.id);
      if (!versions.length) dialog.appendChild(node('p', 'hint', '暂无可读取的主题历史版本。'));
      for (const version of versions) {
        const row = node('div', 'topic-history-row');
        const label = version.savedAt ? new Date(version.savedAt).toLocaleString() : version.name;
        const button = node('button', '', '预览'); button.type = 'button';
        row.append(node('span', '', `${label} · ${version.title} · ${version.summary?.matches ?? '—'} 个片段`), button);
        button.addEventListener('click', async () => {
          if (pending) return;
          pending = true; updating = true; syncSceneActions(); error.textContent = '';
          const controls = [...dialog.querySelectorAll('button')];
          controls.forEach((control) => { control.disabled = true; });
          try {
            if (!currentNavigation(navigation)) throw new Error('素材库或当前页面已切换，请重新打开');
            await archive.hydrateEntry(entry);
            const snapshot = await archive.readEntryBackup(version.name, entry.id);
            if (!currentNavigation(navigation)) throw new Error('素材库或当前页面已切换，请重新打开');
            const categories = archive.list().categories;
            const missingCategory = snapshot.entry.categoryId && !categories.some((item) => item.id === snapshot.entry.categoryId);
            const restored = await previewChanges(entry, snapshot.entry, { restore: true,
              note: missingCategory ? '历史分类已不存在，恢复后放入未分类。' : '',
              commit: () => archive.restoreEntryBackup(version.name, entry.id, entry.updatedAt, entry.revision,
                snapshot.fingerprint, () => currentNavigation(navigation)) });
            if (!restored) return;
            updating = false;
            dialog.close();
            if (!currentNavigation(navigation)) {
              hooks.toast('主题已恢复到原素材库，当前页面已切换');
              return;
            }
            try {
              hooks.setData(archive.list());
              await load(restored, { resetView: true });
              hooks.toast('已恢复此主题，恢复前的版本也已备份');
            } catch (failure) {
              hooks.toast(`恢复已保存，界面刷新失败，请重新打开主题：${failure.message}`, true, 6500);
            }
          } catch (failure) { error.textContent = failure.message; }
          finally {
            pending = false; updating = false; syncSceneActions();
            controls.forEach((control) => { control.disabled = false; });
          }
        });
        dialog.appendChild(row);
      }
      close.addEventListener('click', () => { if (!pending) dialog.close(); });
      dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      dialog.append(error, close); document.body.appendChild(dialog); dialog.showModal();
    }

    /* 新素材命中提示：按库保存最近一次检查结果，只在主题 updatedAt 未变时显示（更新后自然失效）。 */
    const newHits = new Map(); // normalizedLibrary -> Map(entryId -> { hits, videos, updatedAt })
    let autoCheck = null;

    function ownedEntries(library) {
      return store().list().entries.filter((entry) => !entry.sourceLibrary
        || SearchRecipe.normalize(entry.sourceLibrary) === SearchRecipe.normalize(library));
    }

    function recordNewHits(library, found) {
      newHits.set(SearchRecipe.normalize(library), new Map(found.map(({ entry, hits, videos }) =>
        [entry.id, { hits, videos, updatedAt: entry.updatedAt }])));
      WarehouseNavigation.refresh();
    }

    function newHitsFor(entry) {
      const hit = newHits.get(SearchRecipe.normalize(eagle.library.path))?.get(entry.id);
      return hit && hit.updatedAt === entry.updatedAt ? hit : null;
    }

    /* 只对主题上次更新后加入 Eagle 的视频按原条件重放，统计可能的新命中；不写入任何主题。
       signal 存在时为后台探测（不占用搜索忙碌状态）。 */
    async function scanNewMaterials({ isStopped = () => false, onProgress = () => {}, onFound = () => {}, signal } = {}) {
      const library = eagle.library.path;
      const archive = store();
      const owned = ownedEntries(library);
      const found = [];
      const skipped = [];
      let searched = 0;
      const videos = await Bridge.collectLibraryVideos(true);
      await Bridge.refreshPathMap(false, videos);
      for (const [index, entry] of owned.entries()) {
        if (isStopped() || library !== eagle.library.path) break;
        onProgress(index, owned.length, entry);
        const since = Date.parse(entry.updatedAt);
        if (!Number.isFinite(since)) { skipped.push(`${entry.name}（没有更新时间）`); continue; }
        const fresh = new Set(videos.filter((item) => Number(item.importedAt) > since)
          .map((item) => SearchRecipe.normalize(item.filePath)));
        if (!fresh.size) continue;
        await archive.hydrateEntry(entry);
        const recipe = entry.recipe;
        if (!recipe) { skipped.push(`${entry.name}（旧主题缺少搜索条件）`); continue; }
        if (recipe.refinement) { skipped.push(`${entry.name}（固定候选的继续搜索不扩展新素材）`); continue; }
        let result;
        try { result = await Search.probe(recipe, fresh, signal ? { signal } : undefined); }
        catch (error) {
          if (error.name === 'AbortError' || isStopped()) break;
          skipped.push(`${entry.name}（${error.message}）`); continue;
        }
        searched += 1;
        const known = ArchiveStore.sceneLookup([...(entry.matches || []),
          ...(entry.removedMatches || []).map((record) => record.match)]);
        const hits = result.matches.filter((match) => known(match) === undefined);
        if (!hits.length) continue;
        const item = { entry, hits: hits.length, videos: new Set(hits.map((match) => match.eagleItemId)).size };
        found.push(item);
        onFound(item);
      }
      return { found, skipped, searched, total: owned.length, library };
    }

    /* 自动检查：索引完成或开窗后在后台运行；任何搜索开始或手动检查时立即中止，不弹窗。 */
    async function autoCheckNewMaterials() {
      if (autoCheck || !Config.get().autoCheckNew || !hooks.canSearch() || Search.isBusy() || updating || copying) return;
      const controller = new AbortController();
      const stop = () => { if (Search.isBusy()) controller.abort(); };
      autoCheck = controller;
      document.addEventListener('search-busy', stop);
      try {
        const result = await scanNewMaterials({ isStopped: () => controller.signal.aborted, signal: controller.signal });
        if (controller.signal.aborted || result.library !== eagle.library.path) return;
        recordNewHits(result.library, result.found);
        if (result.found.length) {
          hooks.toast(`${result.found.length} 个主题可能有新命中，左侧主题旁已标出数量；打开主题点「更新结果」可预览变化`, false, 6000);
        }
      } catch (error) {
        console.warn('[自动检查新素材] 未完成：', error);
      } finally {
        document.removeEventListener('search-busy', stop);
        autoCheck = null;
      }
    }

    async function checkNewMaterials() {
      checkIdle();
      if (!hooks.canSearch()) throw new Error('搜索服务未就绪或正在建索引，请稍后再检查');
      autoCheck?.abort();
      const library = eagle.library.path;
      const owned = ownedEntries(library);
      const dialog = node('dialog', 'topic-changes-dialog');
      const status = node('p', 'hint', '正在读取素材清单…'); status.setAttribute('aria-live', 'polite');
      const list = node('div', 'topic-changes-lists');
      const actions = node('div', 'dialog-actions');
      const close = node('button', '', '停止'); close.type = 'button';
      actions.append(close);
      dialog.append(node('h2', '', '检查新素材'),
        node('p', 'hint', '只在各主题上次更新后加入 Eagle 的视频中按原条件搜索，结果仅供参考，不会改写主题。'),
        status, list, actions);
      document.body.appendChild(dialog);
      let running = true;
      let stopped = false;
      close.addEventListener('click', () => {
        if (running) { stopped = true; Search.cancel(); close.disabled = true; status.textContent = '正在停止…'; }
        else dialog.close();
      });
      dialog.addEventListener('cancel', (event) => { if (running) { event.preventDefault(); close.click(); } });
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      dialog.showModal();
      let result = { found: [], skipped: [], searched: 0 };
      try {
        result = await scanNewMaterials({
          isStopped: () => stopped,
          onProgress: (index, total, entry) => { status.textContent = `正在检查 ${index + 1}/${total}：${entry.name}`; },
          onFound: ({ entry, hits, videos }) => {
            const row = node('div', 'archive-row');
            const open = node('button', 'primary', '预览更新'); open.type = 'button';
            open.addEventListener('click', () => {
              if (running) return;
              dialog.close();
              hooks.attempt(() => refreshEntry(entry));
            });
            row.append(node('span', 'archive-name', `「${entry.name}」：${hits} 个新片段（${videos} 个新素材）`), open);
            list.appendChild(row);
          },
        });
        if (!stopped) recordNewHits(library, result.found);
      } catch (error) {
        result.skipped.push(error.message);
      } finally {
        running = false;
        close.disabled = false; close.textContent = '关闭';
      }
      const { found, skipped, searched } = result;
      status.textContent = `${stopped ? '已停止。' : '检查完成。'}共 ${owned.length} 个主题，搜索 ${searched} 个有新素材的主题，${found.length} 个可能有新命中。`
        + (found.length ? '点击「预览更新」先查看变化再决定是否应用。' : '');
      if (skipped.length) {
        const details = node('details');
        details.append(node('summary', '', `未检查 ${skipped.length} 个`), ...skipped.map((text) => node('p', 'hint', text)));
        list.appendChild(details);
      }
      return found;
    }

    /* 单主题与批量更新共用：按 recipe 重放并生成候选，不写盘。 */
    async function computeUpdate(entry, recipe, savedView, library) {
      const result = await Search.replay(recipe);
      if (library !== eagle.library.path) throw new Error('素材库已切换，未写入更新结果');
      const matches = result.matches;
      const previous = { ...entry, matches: entry.matches.map((match) => ({ ...match,
        eagleItemId: match.eagleItemId || Bridge.itemForPath(match.video_path)?.id,
      })) };
      const updated = ArchiveStore.updatedEntry(previous, matches, recipe, savedView);
      updated.query = recipe.query;
      updated.legacy = false;
      return { result, matches, previous, updated };
    }

    /* 批量更新：串行重放范围内主题，汇总变化后由用户勾选一次写入；每个主题独立原子提交。 */
    async function batchUpdate({ label, include = () => true }) {
      checkIdle();
      if (!hooks.canSearch()) throw new Error('搜索服务未就绪或正在建索引，请稍后更新');
      autoCheck?.abort();
      const library = eagle.library.path;
      const archive = store();
      const targets = ownedEntries(library).filter(include)
        .sort((a, b) => Number(b.favorite === true) - Number(a.favorite === true)
          || String(b.updatedAt).localeCompare(String(a.updatedAt)));
      if (!targets.length) throw new Error('当前范围没有可更新的主题');
      const navigation = beginNavigation();
      const dialog = node('dialog', 'topic-changes-dialog');
      dialog.id = 'batch-update-dialog';
      const status = node('p', 'topic-changes-summary', `将按各自保存的搜索条件依次重新搜索 ${targets.length} 个主题。`);
      status.id = 'batch-update-status'; status.setAttribute('aria-live', 'polite');
      const list = node('div', 'topic-changes-lists');
      const error = node('p', 'error'); error.setAttribute('role', 'alert');
      const actions = node('div', 'dialog-actions');
      const cancel = node('button', '', '取消'); cancel.id = 'batch-update-cancel'; cancel.type = 'button';
      const primary = node('button', 'primary', '开始'); primary.id = 'batch-update-start'; primary.type = 'button';
      actions.append(cancel, primary);
      dialog.append(node('h2', '', `${label} · 批量更新`),
        node('p', 'hint', '先逐个计算变化，全部完成后再勾选要写入的主题；未勾选的不改动。人工片段照常保留，无变化的主题不写入。'),
        status, list, error, actions);
      document.body.appendChild(dialog);

      let stage = 'confirm'; // confirm → running → review → writing → done
      let stopped = false;
      const changed = []; const unchanged = []; const failed = []; const skipped = [];
      const succeeded = [];
      let done = null;
      const finished = new Promise((resolve) => { done = resolve; });
      const failureList = () => {
        if (!failed.length && !skipped.length) return null;
        const details = node('details');
        details.append(node('summary', '', `失败 ${failed.length} · 跳过 ${skipped.length}`),
          ...failed.map(({ entry, message }) => node('p', 'error', `「${entry.name}」：${message}`)),
          ...skipped.map(({ entry, message }) => node('p', 'hint', `「${entry.name}」：${message}`)));
        return details;
      };
      const finish = () => {
        stage = 'done';
        updating = false; syncSceneActions();
        const notComputed = targets.length - changed.length - unchanged.length - failed.length - skipped.length;
        const unwritten = changed.length - succeeded.length - failed.filter((item) => item.writing).length;
        const text = `成功 ${succeeded.length} · 无变化 ${unchanged.length} · 失败 ${failed.length}`
          + (skipped.length ? ` · 跳过 ${skipped.length}` : '')
          + (unwritten > 0 ? ` · 未写入 ${unwritten}` : '') + (notComputed > 0 ? ` · 未计算 ${notComputed}` : '');
        status.textContent = `${stopped ? '已停止。' : '批量更新结束。'}${text}`;
        list.replaceChildren(...succeeded.map(({ entry, saved }) =>
          node('p', '', `「${entry.name}」：${saved.matches.length} 个片段，新增 ${saved.newKeys.length}`)));
        const failures = failureList(); if (failures) list.appendChild(failures);
        cancel.hidden = true; primary.hidden = false; primary.disabled = false; primary.textContent = '关闭';
        primary.onclick = () => dialog.close();
        primary.focus();
        if (succeeded.length) {
          if (currentNavigation(navigation)) {
            try { hooks.setData(archive.list()); hooks.renderCards(); }
            catch (failure) { hooks.toast(`更新已保存，仓库列表刷新失败：${failure.message}`, true, 6500); }
          }
          hooks.toast(`批量更新：${text}`, failed.length > 0, 6500);
        }
      };
      const review = () => {
        stage = 'review';
        list.replaceChildren();
        if (!changed.length) { finish(); return; }
        status.textContent = `${stopped ? '已停止，' : ''}${changed.length} 个主题有变化，无变化 ${unchanged.length}，失败 ${failed.length}`
          + (skipped.length ? `，跳过 ${skipped.length}` : '') + '。勾选后应用：';
        const boxes = changed.map((item) => {
          const row = node('label', 'batch-update-row');
          const box = node('input'); box.type = 'checkbox'; box.checked = true;
          const { added, removed, manual } = item.changes;
          row.append(box, node('span', '', `「${item.entry.name}」：${item.previous.matches.length} → ${item.updated.matches.length} 个片段 · 新增 ${added.length} · 消失 ${removed.length}`
            + (manual.length ? ` · 人工保留 ${manual.length}` : '')));
          list.appendChild(row);
          return box;
        });
        const failures = failureList(); if (failures) list.appendChild(failures);
        const sync = () => {
          const count = boxes.filter((box) => box.checked).length;
          primary.textContent = `应用所选 (${count})`; primary.disabled = !count;
        };
        boxes.forEach((box) => box.addEventListener('change', sync));
        cancel.textContent = '放弃'; cancel.disabled = false; primary.hidden = false; sync();
        primary.onclick = async () => {
          const selected = changed.filter((_, index) => boxes[index].checked);
          stage = 'writing'; cancel.disabled = true; primary.disabled = true;
          boxes.forEach((box) => { box.disabled = true; });
          for (const [index, item] of selected.entries()) {
            status.textContent = `正在写入 ${index + 1}/${selected.length}：${item.entry.name}`;
            try {
              if (!currentNavigation(navigation)) throw new Error('素材库或当前页面已切换，未写入更新结果');
              const saved = await archive.replace(item.updated, item.entry.updatedAt);
              succeeded.push({ entry: item.entry, saved });
            } catch (failure) { failed.push({ entry: item.entry, message: failure.message, writing: true }); }
          }
          finish();
        };
      };
      const run = async () => {
        stage = 'running'; updating = true; syncSceneActions();
        cancel.textContent = '停止'; primary.hidden = true;
        for (const [index, entry] of targets.entries()) {
          if (stopped) break;
          if (!currentNavigation(navigation)) { error.textContent = '素材库或当前页面已切换，已停止'; stopped = true; break; }
          if (!hooks.canSearch()) { error.textContent = '搜索服务离线或开始建索引，已停止'; stopped = true; break; }
          status.textContent = `正在重新搜索 ${index + 1}/${targets.length}：${entry.name}`;
          try {
            await archive.hydrateEntry(entry);
            if (!entry.recipe) { skipped.push({ entry, message: '旧主题缺少搜索条件，请打开主题后单独更新' }); continue; }
            const computed = await computeUpdate(entry, entry.recipe, entry.view, library);
            const changes = ArchiveStore.entryChanges(computed.previous, computed.updated, computed.matches);
            if (changes.added.length || changes.removed.length) changed.push({ entry, ...computed, changes });
            else unchanged.push(entry);
          } catch (failure) {
            if (stopped || failure.name === 'AbortError') break;
            failed.push({ entry, message: failure.message });
          }
        }
        review();
      };
      cancel.addEventListener('click', () => {
        if (stage === 'running') {
          stopped = true; Search.cancel(); cancel.disabled = true; status.textContent = '正在停止…';
        } else if (stage === 'confirm' || stage === 'review') dialog.close();
      });
      primary.onclick = () => { run(); };
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        if (stage === 'running' || stage === 'confirm' || stage === 'review') cancel.click();
        else if (stage === 'done') dialog.close();
      });
      dialog.addEventListener('close', () => {
        dialog.remove();
        if (stage !== 'done') { updating = false; syncSceneActions(); }
        done({ succeeded: succeeded.length, unchanged: unchanged.length, failed: failed.length, skipped: skipped.length });
      }, { once: true });
      dialog.showModal(); primary.focus();
      return finished;
    }

    async function refreshEntry(entry, recipe, savedView = entry.view) {
      checkIdle();
      const navigation = beginNavigation();
      const library = eagle.library.path;
      const archive = store();
      await archive.hydrateEntry(entry);
      if (!currentNavigation(navigation)) return;
      checkIdle();
      recipe = recipe === undefined ? entry.recipe : recipe;
      if (!recipe) { await editEntry(entry); return; }
      if (!hooks.canSearch()) throw new Error('搜索服务未就绪或正在建索引，请稍后更新');
      updating = true;
      syncSceneActions();
      const controls = $('warehouse-editor').open
        ? [...$('warehouse-form').elements].map((element) => ({ element, disabled: element.disabled })) : [];
      controls.forEach(({ element }) => { element.disabled = true; });
      document.body.classList.add('warehouse-updating');
      $('warehouse-page').setAttribute('aria-busy', 'true');
      $('warehouse-warning').textContent = `正在更新「${entry.name}」，原结果仍保留…`;
      $('topic-update').textContent = '更新中…';
      hooks.toast(`正在更新「${entry.name}」…`, false, 10000);
      try {
        const computed = await computeUpdate(entry, recipe, savedView, library);
        const { result, matches, previous } = computed;
        let { updated } = computed;
        updated = await previewChanges(previous, updated, { rawMatches: matches,
          note: result.missingDates ? `${result.missingDates} 个素材缺少导入时间，已排除。` : '',
          commit: () => {
            if (!currentNavigation(navigation)) throw new Error('素材库或当前页面已切换，未写入更新结果');
            return archive.replace(updated, entry.updatedAt);
          } });
        if (!updated) return null;
        // 此时更新已落盘，才允许装载；load 内仍防止其他搜索并发。
        updating = false;
        if (!currentNavigation(navigation)) {
          hooks.toast('更新已保存到原素材库，当前页面已切换');
          return updated;
        }
        try {
          hooks.setData(archive.list());
          await load(updated, { resetView: $('warehouse-editor').open });
        } catch (failure) {
          hooks.toast(`更新已保存，界面刷新失败，请重新打开主题：${failure.message}`, true, 6500);
          return updated;
        }
        hooks.toast(`更新完成：${updated.matches.length} 个片段，本次新增 ${updated.newKeys.length}`
          + (result.missingDates ? `；${result.missingDates} 个素材缺少导入时间，已排除` : ''), false, 6500);
        return updated;
      } finally {
        updating = false;
        syncSceneActions();
        controls.forEach(({ element, disabled }) => { element.disabled = disabled; });
        document.body.classList.remove('warehouse-updating');
        $('warehouse-page').setAttribute('aria-busy', 'false');
        $('warehouse-warning').textContent = [...new Set(hooks.warnings())].join('；');
        $('topic-update').textContent = '更新结果';
      }
    }

    function copyTopic(editing, editingLibrary) {
      checkIdle();
      if (!editing) return;
      if (editingLibrary !== eagle.library.path) throw new Error('素材库已切换，请重新打开主题后复制');
      const source = editing;
      const navigation = beginNavigation();
      const archive = store();
      const dialog = node('dialog', 'topic-changes-dialog topic-copy-dialog');
      dialog.id = 'topic-copy-dialog';
      const form = node('form');
      form.append(node('h2', '', '复制主题'),
        node('p', 'hint', `复制「${source.name}」的已保存版本，未保存的编辑不会带入。片段、评分、审阅进度、移除记录、封面和搜索条件完整保留，后续修改相互独立。`));
      const label = node('label', '', '副本名称');
      label.htmlFor = 'topic-copy-name';
      const name = node('input'); name.id = 'topic-copy-name'; name.type = 'text'; name.required = true;
      name.value = `${source.name} 副本`;
      const error = node('p', 'form-error'); error.id = 'topic-copy-error'; error.setAttribute('role', 'alert');
      const actions = node('div', 'dialog-actions');
      const cancel = node('button', '', '取消'); cancel.type = 'button';
      const submit = node('button', 'primary', '创建并打开副本'); submit.type = 'submit';
      actions.append(cancel, submit); form.append(label, name, error, actions);
      dialog.appendChild(form); document.body.appendChild(dialog);
      let pending = false;
      cancel.addEventListener('click', () => { if (!pending) dialog.close(); });
      dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (pending) return;
        error.textContent = '';
        try {
          checkIdle();
          if (!currentNavigation(navigation)) throw new Error('素材库或当前页面已切换，请重新打开主题');
          pending = true; copying = true; syncSceneActions();
          name.disabled = true; submit.disabled = true; cancel.disabled = true;
          const copy = await archive.copyEntry(source.id, name.value, source.updatedAt, source.revision,
            () => currentNavigation(navigation));
          copying = false;
          dialog.close(); $('warehouse-editor').close();
          if (!currentNavigation(navigation)) {
            hooks.toast('副本已保存到原素材库，当前页面已切换'); return;
          }
          try {
            hooks.setData(archive.list());
            await load(copy, { resetView: true });
            hooks.toast(`已创建副本「${copy.name}」`);
          } catch (failure) {
            hooks.toast(`副本已保存，打开失败，请从仓库重新打开：${failure.message}`, true, 6500);
          }
        } catch (failure) { error.textContent = failure.message; }
        finally {
          pending = false; copying = false; syncSceneActions();
          name.disabled = false; submit.disabled = false; cancel.disabled = false;
        }
      });
      dialog.showModal(); name.focus(); name.select();
    }

    return { refreshEntry, batchUpdate, checkNewMaterials, autoCheckNewMaterials, newHitsFor, topicHistory, copyTopic, isBusy: () => updating || copying,
      isUpdating: () => updating };
  }

  return { create };
})();
