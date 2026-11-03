/* 仓库包导入导出、回收站及整库备份恢复。 */
const WarehouseRecovery = (() => {
  function open(hooks) {
    const { $, node, dateText, checkIdle, store, detachTopic, open } = hooks;
    checkIdle();
    let dialog = $('warehouse-recovery-dialog');
    if (!dialog) {
      dialog = node('dialog'); dialog.id = 'warehouse-recovery-dialog';
      document.body.appendChild(dialog);
    }
    dialog.setAttribute('aria-labelledby', 'warehouse-recovery-title');
    const header = node('header', 'recovery-header');
    const title = node('h2', '', '备份与回收站'); title.id = 'warehouse-recovery-title';
    header.append(title, node('p', 'recovery-hint', '管理仓库历史，找回删除的主题。恢复前会自动备份当前仓库。'));
    const body = node('div', 'recovery-body');
    const footer = node('footer', 'recovery-footer');
    dialog.replaceChildren(header, body, footer);
    const status = node('p', 'recovery-status'); status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    let processing = false;
    const run = async (action) => {
      if (processing) return;
      processing = true;
      const controls = [...dialog.querySelectorAll('button, input, select')]
        .map((element) => ({ element, disabled: element.disabled }));
      controls.forEach(({ element }) => { element.disabled = true; });
      dialog.setAttribute('aria-busy', 'true');
      try { await action(); } catch (error) { status.textContent = error.message; }
      finally {
        processing = false;
        controls.forEach(({ element, disabled }) => { element.disabled = disabled || element.dataset.completed === 'true'; });
        dialog.setAttribute('aria-busy', 'false');
      }
    };
    const archive = store();
    const library = eagle.library.path;
    const guard = () => { checkIdle(); if (library !== eagle.library.path) throw new Error('素材库已切换，请重新打开恢复面板'); };
    const policySection = node('section', 'recovery-policy');
    policySection.append(node('h3', '', '自动清理策略'));
    const policyRow = node('div', 'recovery-policy-fields');
    const countLabel = node('label', '', '保留备份份数');
    const countInput = node('input'); countInput.type = 'number'; countInput.min = '1'; countInput.max = '100'; countInput.value = '10';
    const daysLabel = node('label', '', '回收站保留天数');
    const daysInput = node('input'); daysInput.type = 'number'; daysInput.min = '0'; daysInput.max = '3650'; daysInput.value = '30';
    try { const policy = archive.list().retention; if (policy) { countInput.value = policy.backupCount; daysInput.value = policy.trashDays; } } catch { /* Keep recovery accessible for a broken manifest. */ }
    daysInput.setAttribute('aria-describedby', 'recovery-policy-hint');
    const savePolicy = node('button', '', '保存策略'); savePolicy.type = 'button';
    savePolicy.addEventListener('click', () => run(() => {
      guard(); archive.setRetention(Number(countInput.value), Number(daysInput.value)); status.textContent = '清理策略已保存';
    }));
    countLabel.append(countInput); daysLabel.append(daysInput); policyRow.append(countLabel, daysLabel, savePolicy);
    const policyHint = node('p', 'recovery-hint', '写入前自动备份，下次成功写入时清理。天数设为 0 则永久保留；未知或损坏的备份不会自动删除。');
    policyHint.id = 'recovery-policy-hint';
    policySection.append(policyRow, policyHint); body.append(policySection);
    const exportButton = node('button', '', '导出仓库包'); exportButton.type = 'button';
    exportButton.addEventListener('click', () => run(async () => {
      guard(); status.textContent = '正在导出仓库包…';
      const bundle = await archive.exportBundleAsync();
      guard(); const blob = new Blob([bundle], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const link = node('a');
      link.href = url; link.download = `warehouse-${Date.now()}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = '仓库包已生成';
    }));
    const input = node('input', 'recovery-file'); input.type = 'file'; input.accept = '.json';
    const moveLabel = node('label', 'recovery-move', '这是搬家后的同一素材库，允许导入异路径仓库（仅快照，更新前需重设条件）');
    const moveCheck = node('input'); moveCheck.type = 'checkbox'; moveLabel.prepend(moveCheck);
    input.setAttribute('aria-label', '导入同库仓库包（合并，不覆盖同 ID 主题）');
    input.addEventListener('change', () => run(async () => {
      const file = input.files[0]; if (!file) return;
      if (file.size > 128 * 1024 * 1024) throw new Error('仓库包超过 128 MB，请分批整理后导入');
      guard(); status.textContent = '正在校验并合并仓库包…';
      const text = await file.text(); guard();
      const count = await archive.importBundleAsync(text, { allowLibraryMove: moveCheck.checked });
      guard();
      status.textContent = `已合并 ${count} 个新主题（同 ID 主题不覆盖）`;
      detachTopic(); await open();
    }));
    const unlock = node('button', '', '清理遗留锁'); unlock.type = 'button';
    unlock.addEventListener('click', () => run(() => { guard(); status.textContent = archive.recoverLock() ? '遗留锁已移除，可重试保存' : '没有遗留锁'; }));
    const trashSection = node('section', 'recovery-section');
    const trashHeading = node('h3', 'recovery-section-heading', '回收站');
    const trashList = node('div', 'recovery-list');
    trashSection.append(trashHeading, trashList); body.append(trashSection);
    try {
      const trash = archive.list().trash || [];
      trashHeading.append(node('span', 'recovery-count', String(trash.length)));
      if (!trash.length) trashList.append(node('p', 'recovery-empty', '回收站为空，删除的主题会出现在这里'));
      trash.forEach((item) => {
        if (!item?.entry?.name || !item.trashId) { trashList.append(node('p', 'recovery-empty', '有未知格式回收站记录，已原样保留')); return; }
        const row = node('div', 'recovery-row');
        const info = node('div', 'recovery-row-info');
        info.append(node('p', 'recovery-row-title', item.entry.name), node('p', 'recovery-hint', `删除于 ${dateText(item.deletedAt)}`));
        const button = node('button', '', '恢复主题'); button.type = 'button';
        button.addEventListener('click', () => run(async () => {
          guard(); archive.restore(item.trashId); button.dataset.completed = 'true'; button.disabled = true;
          status.textContent = '主题已恢复'; await open();
        })); row.append(info, button); trashList.append(row);
      });
    } catch (error) { status.textContent = error.message; }
    const history = node('section', 'recovery-section');
    const historyHeading = node('h3', 'recovery-section-heading', '历史版本');
    const historyList = node('div', 'recovery-list');
    history.append(historyHeading, node('p', 'recovery-hint recovery-section-note', '恢复将替换整个仓库；恢复时会校验主题资源。'), historyList); body.append(history);
    const versions = archive.backups();
    historyHeading.append(node('span', 'recovery-count', String(versions.length)));
    if (!versions.length) historyList.append(node('p', 'recovery-empty', '暂无备份，首次成功写入后的下一次修改开始备份'));
    versions.forEach((item) => {
      const row = node('div', 'recovery-row');
      const info = node('div', 'recovery-row-info');
      info.append(node('p', 'recovery-row-title', dateText(Number(item.name.split('-')[0]))),
        node('p', 'recovery-hint', item.valid ? `${item.count} 个主题` : '备份损坏，无法恢复'));
      const button = node('button', '', '恢复此版本'); button.type = 'button'; button.disabled = !item.valid;
      button.addEventListener('click', () => run(() => {
        guard();
        if (button.dataset.confirming !== '1') {
          button.dataset.confirming = '1'; button.textContent = '再次点击确认恢复整库'; return;
        }
        archive.restoreBackup(item.name); button.dataset.completed = 'true'; button.disabled = true; detachTopic();
        status.textContent = '已恢复；恢复前的文件已另存为备份'; return open();
      })); row.append(info, button); historyList.append(row);
    });
    const transfer = node('details', 'recovery-tools');
    transfer.append(node('summary', '', '导入、导出与维护'));
    const transferBody = node('div', 'recovery-tools-body');
    const exportRow = node('div', 'recovery-tool-row');
    exportRow.append(node('p', 'recovery-hint', '导出包含完整主题与资源的仓库包，用于备份或搬家。'), exportButton);
    const importGroup = node('div', 'recovery-import');
    importGroup.append(node('p', 'recovery-row-title', '导入仓库包'),
      node('p', 'recovery-hint', '选择 JSON 文件，合并新主题，同 ID 主题不会被覆盖。'), input, moveLabel);
    const unlockRow = node('div', 'recovery-tool-row');
    unlockRow.append(node('p', 'recovery-hint', '进程异常退出导致无法保存时，可清理其遗留锁。'), unlock);
    transferBody.append(exportRow, importGroup, unlockRow); transfer.append(transferBody); body.append(transfer);
    const close = node('button', '', '关闭'); close.type = 'button'; close.autofocus = true;
    close.addEventListener('click', () => dialog.close()); footer.append(status, close);
    dialog.oncancel = (event) => { if (processing) event.preventDefault(); };
    if (!dialog.open) dialog.showModal();
  }

  return { open };
})();
