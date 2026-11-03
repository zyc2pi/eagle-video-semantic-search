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
        const result = await Search.replay(recipe);
        if (library !== eagle.library.path) throw new Error('素材库已切换，未写入更新结果');
        const matches = result.matches;
        const previous = { ...entry, matches: entry.matches.map((match) => ({ ...match,
          eagleItemId: match.eagleItemId || Bridge.itemForPath(match.video_path)?.id,
        })) };
        let updated = ArchiveStore.updatedEntry(previous, matches, recipe, savedView);
        updated.query = recipe.query;
        updated.legacy = false;
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

    return { refreshEntry, topicHistory, copyTopic, isBusy: () => updating || copying,
      isUpdating: () => updating };
  }

  return { create };
})();
