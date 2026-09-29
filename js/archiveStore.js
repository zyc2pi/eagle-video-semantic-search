/* 每个 Eagle 库独立存储；同目录临时文件 + rename，写入失败不覆盖旧快照。 */
const ArchiveStore = (() => {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const normalize = (value) => String(value || '').replace(/\//g, '\\').toLowerCase();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const references = new WeakMap();
  const backupCache = new Map();

  function sceneKey(match) {
    return JSON.stringify([
      match.eagleItemId || normalize(match.video_path),
      match.original_start_frame ?? match.start_frame,
      match.original_end_frame ?? match.end_frame,
    ]);
  }

  function updatedEntry(previous, matches, recipe, view, now = new Date().toISOString()) {
    const old = new Set(previous.matches.map(sceneKey));
    return { ...previous, recipe: clone(recipe), view: clone(view), matches: clone(matches),
      newKeys: [...new Set(matches.map(sceneKey).filter((key) => !old.has(key)))], updatedAt: now };
  }

  function open(root, library) {
    const dir = path.join(root, 'warehouse');
    const hash = crypto.createHash('sha256').update(normalize(library)).digest('hex').slice(0, 24);
    const file = path.join(dir, `${hash}.json`);
    const backupsDir = path.join(dir, `${hash}-backups`);
    const assetsDir = path.join(dir, `${hash}-assets`);
    const lockFile = `${file}.lock`;
    const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
    const ownedBackup = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
    const retention = (data) => ({
      backupCount: Number.isInteger(data.retention?.backupCount) && data.retention.backupCount >= 1
        ? data.retention.backupCount : 10,
      trashDays: Number.isInteger(data.retention?.trashDays) && data.retention.trashDays >= 0
        ? data.retention.trashDays : 30,
    });
    const assetPath = (ref) => {
      if (!/^[0-9a-f]{64}\.json$/.test(ref || '')) throw new Error('仓库资源引用无效');
      return path.join(assetsDir, ref);
    };
    function decodeAsset(ref, raw) {
      if (`${digest(raw)}.json` !== ref) throw new Error('仓库资源校验失败，原文件已保留');
      return JSON.parse(raw);
    }
    function checkAsset(key, value) {
      const valid = key === 'matches' ? Array.isArray(value)
        && value.every((match) => match && typeof match.video_path === 'string')
        : key === 'cover' ? value && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl || '')
          && value.dataUrl.length <= 2 * 1024 * 1024
        : value && typeof value === 'object' && !Array.isArray(value);
      if (!valid) throw new Error('仓库资源内容无效，请从备份恢复');
      return value;
    }
    function lazyAsset(object, key, ref) {
      const filename = assetPath(ref);
      if (!fs.existsSync(filename)) throw new Error('仓库资源缺失');
      references.set(object, { ...(references.get(object) || {}), [key]: ref });
      Object.defineProperty(object, key, { enumerable: true, configurable: true,
        get() { const value = checkAsset(key, decodeAsset(ref, fs.readFileSync(filename, 'utf8')));
          Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
          return value; },
        set(value) { Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true }); },
      });
    }
    function saveAsset(value) {
      const raw = JSON.stringify(value);
      const ref = `${digest(raw)}.json`;
      const target = assetPath(ref);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(assetsDir, { recursive: true });
        const temp = `${target}.${crypto.randomUUID()}.tmp`;
        try { fs.writeFileSync(temp, raw, { encoding: 'utf8', flag: 'wx' }); fs.renameSync(temp, target); }
        finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      } else if (`${digest(fs.readFileSync(target, 'utf8'))}.json` !== ref) throw new Error('仓库资源校验失败，未覆盖原文件');
      return ref;
    }
    function packEntry(entry) {
      const packed = {};
      Object.keys(entry).forEach((key) => {
        const ref = references.get(entry)?.[key];
        // Keep untouched immutable references without loading their contents.
        if (ref && Object.getOwnPropertyDescriptor(entry, key)?.get) packed[`${key}Ref`] = ref;
        else if (key === 'matches' || key === 'cover' || key === 'recipe') {
          if (entry[key] != null) packed[`${key}Ref`] = saveAsset(entry[key]);
          else packed[key] = entry[key];
        } else packed[key] = entry[key];
      });
      if (!entry.summary || !Object.getOwnPropertyDescriptor(entry, 'matches')?.get) {
        packed.summary = { matches: entry.matches.length,
          videos: new Set(entry.matches.map((m) => m.eagleItemId || normalize(m.video_path))).size };
      }
      return packed;
    }
    async function hydrateEntry(entry, keys = ['matches', 'recipe', 'cover']) {
      await Promise.all(keys.map(async (key) => {
        const ref = references.get(entry)?.[key];
        if (!ref || !Object.getOwnPropertyDescriptor(entry, key)?.get) return;
        const value = checkAsset(key, decodeAsset(ref, await fs.promises.readFile(assetPath(ref), 'utf8')));
        Object.defineProperty(entry, key, { value, enumerable: true, configurable: true, writable: true });
      }));
      return entry;
    }

    function validate(data) {
      if (![1, 2, 3].includes(data.version) || !Array.isArray(data.entries) || !Array.isArray(data.categories)
          || !Array.isArray(data.imported) || normalize(data.library) !== normalize(library)) {
        throw new Error('仓库格式不支持或已损坏，已保留原文件；可从备份恢复');
      }
      data.trash = Array.isArray(data.trash) ? data.trash : [];
      data.quarantine = Array.isArray(data.quarantine) ? data.quarantine : [];
      const ids = new Set();
      data.entries = data.entries.filter((entry) => {
        const original = entry && typeof entry === 'object' ? { ...entry } : entry;
        try {
          for (const key of ['matches', 'recipe', 'cover']) {
            if (entry?.[`${key}Ref`]) { lazyAsset(entry, key, entry[`${key}Ref`]); delete entry[`${key}Ref`]; }
          }
        } catch { data.quarantine.push({ reason: '主题资源缺失或引用无效', value: original }); return false; }
        const valid = entry && typeof entry.id === 'string' && !ids.has(entry.id)
          && typeof entry.name === 'string' && (references.get(entry)?.matches || (Array.isArray(entry.matches)
          && entry.matches.every((match) => match && typeof match.video_path === 'string')))
          && entry.view && typeof entry.view === 'object'
          && (references.get(entry)?.recipe || entry.recipe == null || typeof entry.recipe === 'object');
        if (!valid) { data.quarantine.push({ reason: '主题结构无效或 ID 重复', value: original }); return false; }
        ids.add(entry.id);
        return true;
      });
      data.categories = data.categories.filter((category) => category && typeof category.id === 'string' && typeof category.name === 'string');
      data.entries.forEach((entry) => {
        if (!data.categories.some((category) => category.id === entry.categoryId)) entry.categoryId = '';
        entry.view = { minDur: 0, sortBy: 'sim', grouped: false, ...entry.view };
        if (!references.get(entry)?.cover && entry.cover && !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(entry.cover.dataUrl || '')) {
          data.quarantine.push({ reason: '封面无效', value: entry.cover }); delete entry.cover;
        }
      });
      return data;
    }

    function read() {
      const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      let data;
      try { data = raw == null ? { version: 2, library, revision: 0, categories: [], entries: [], imported: [], trash: [], quarantine: [] } : validate(JSON.parse(raw)); }
      catch { throw new Error('仓库格式不支持或已损坏，已保留原文件；请使用备份恢复'); }
      Object.defineProperty(data, '_fingerprint', { value: raw == null ? null : digest(raw) });
      return data;
    }

    function write(data) {
      fs.mkdirSync(dir, { recursive: true });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      let locked = false;
      let committed = false;
      try {
        try { fs.writeFileSync(lockFile, JSON.stringify({ token: crypto.randomUUID(), pid: require('process').pid, createdAt: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' }); locked = true; }
        catch { throw new Error('仓库正在被其他窗口写入，请稍后重试；异常退出遗留锁请在关闭所有插件窗口后恢复'); }
        const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        if ((previous == null ? null : digest(previous)) !== data._fingerprint) throw new Error('仓库已被其他操作更新，请重新打开后重试');
        if (previous != null) {
          fs.mkdirSync(backupsDir, { recursive: true });
          fs.writeFileSync(path.join(backupsDir, `${Date.now()}-${crypto.randomUUID()}.json`), previous, { encoding: 'utf8', flag: 'wx' });
          try {
            const version = JSON.parse(previous).version;
            if ([1, 2].includes(version)) {
              const legacyBackup = path.join(backupsDir, `legacy-v${version}.json`);
              if (!fs.existsSync(legacyBackup)) fs.writeFileSync(legacyBackup, previous, { encoding: 'utf8', flag: 'wx' });
            }
          } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        }
        data.version = 3;
        data.revision = (Number(data.revision) || 0) + 1;
        const policy = retention(data);
        // 0 means keep forever. Unknown/invalid historical trash is never purged.
        if (policy.trashDays > 0) data.trash = data.trash.filter((item) => {
          const deleted = Date.parse(item?.deletedAt);
          return !item?.trashId || !item?.entry?.id || !Number.isFinite(deleted)
            || deleted > Date.now() - policy.trashDays * 86400000;
        });
        const packed = { ...data, entries: data.entries.map(packEntry) };
        fs.writeFileSync(temporary, JSON.stringify(packed), { encoding: 'utf8', flag: 'wx' });
        fs.renameSync(temporary, file);
        committed = true;
        // Prune only after a successful commit, and only valid, owned backups.
        // Corrupt/unknown files are evidence and must not be silently deleted.
        try {
          backups().filter((item) => item.valid && ownedBackup.test(item.name))
            .slice(policy.backupCount).forEach((item) => fs.unlinkSync(path.join(backupsDir, item.name)));
        } catch { /* Cleanup failure must not report a successfully committed write as failed. */ }
      } finally {
        try {
          if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
          if (locked && fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        } catch (error) { if (!committed) throw error; }
      }
    }

    function list() {
      const data = read();
      const legacyDir = path.join(root, 'saves');
      const warnings = data.quarantine.length ? [`${data.quarantine.length} 项损坏内容已隔离，原始内容仍保留`] : [];
      let changed = false;
      if (fs.existsSync(legacyDir)) {
        for (const name of fs.readdirSync(legacyDir).filter((name) => name.endsWith('.json'))) {
          if (data.imported.includes(name)) continue;
          try {
            const old = JSON.parse(fs.readFileSync(path.join(legacyDir, name), 'utf8'));
            if (!old.library) { warnings.push('有旧存档缺少所属库信息，原文件已保留'); continue; }
            if (normalize(old.library) !== normalize(library)) continue;
            if (!Array.isArray(old.matches)) throw new Error('结果格式无效');
            data.entries.push({ id: crypto.randomUUID(), name: old.query || '未命名', categoryId: '',
              createdAt: old.savedAt || '', updatedAt: old.savedAt || '',
              query: old.query || '', recipe: null, view: { minDur: 0, sortBy: 'sim', grouped: false },
              matches: old.matches, newKeys: [], legacy: true });
            data.imported.push(name);
            changed = true;
          } catch { warnings.push('有旧存档无法读取，原文件已保留'); }
        }
      }
      if (changed) write(data);
      return { ...data, warnings };
    }

    function add({ name, categoryId, recipe, view, matches }) {
      const data = read();
      const now = new Date().toISOString();
      const entry = { id: crypto.randomUUID(), name: name.trim() || recipe?.query || '未命名',
        categoryId: categoryId || '', query: recipe?.query || name, recipe, view, matches,
        createdAt: now, updatedAt: now, newKeys: [] };
      data.entries.push(clone(entry));
      write(data);
      return entry;
    }

    function replace(entry, expectedUpdatedAt) {
      const data = read();
      const index = data.entries.findIndex((value) => value.id === entry.id);
      if (index < 0) throw new Error('主题已被删除');
      if (expectedUpdatedAt != null && data.entries[index].updatedAt !== expectedUpdatedAt) {
        throw new Error('主题已被其他操作更新，请重新打开后重试');
      }
      if ((entry.revision || 0) !== (data.entries[index].revision || 0)) throw new Error('主题已被其他操作更新，请重新打开后重试');
      const replacement = { ...clone(entry), revision: (entry.revision || 0) + 1 };
      data.entries[index] = replacement;
      write(data);
      return replacement;
    }

    function remove(id) {
      const data = read();
      const entry = data.entries.find((entry) => entry.id === id);
      if (entry) data.trash.push({ entry, deletedAt: new Date().toISOString(), trashId: crypto.randomUUID() });
      data.entries = data.entries.filter((entry) => entry.id !== id);
      write(data);
    }

    function setCover(id, cover, expectedUpdatedAt) {
      const data = read();
      const entry = data.entries.find((value) => value.id === id);
      if (!entry) throw new Error('主题已被删除');
      if (expectedUpdatedAt != null && entry.updatedAt !== expectedUpdatedAt) {
        throw new Error('主题结果已更新，请重新打开后设置封面');
      }
      if (cover != null) {
        if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(cover.dataUrl || '')
            || cover.dataUrl.length > 2 * 1024 * 1024
            || !Number.isInteger(cover.frame) || cover.frame < 0) {
          throw new Error('封面数据无效，原封面未改变');
        }
        entry.cover = clone(cover);
      } else delete entry.cover;
      // 封面调整不改变“搜索结果最近更新”的时间，也不覆盖其他主题信息。
      entry.revision = (entry.revision || 0) + 1;
      write(data);
      return clone(entry);
    }

    function category(action, id, name = '') {
      const data = read();
      if (action !== 'remove') {
        name = name.trim();
        if (!name) throw new Error('请输入分类名称');
        if (data.categories.some((c) => c.name === name && c.id !== id)) throw new Error('分类名称已存在');
      }
      if (action === 'add') data.categories.push({ id: crypto.randomUUID(), name });
      else if (action === 'rename') {
        const found = data.categories.find((c) => c.id === id);
        if (!found) throw new Error('分类已不存在');
        found.name = name;
      } else if (action === 'remove') {
        data.categories = data.categories.filter((c) => c.id !== id);
        data.entries.forEach((entry) => { if (entry.categoryId === id) entry.categoryId = ''; });
      }
      write(data);
    }

    function setCategory(entryId, categoryId, expectedUpdatedAt) {
      const data = read();
      const entry = data.entries.find((item) => item.id === entryId);
      if (!entry) throw new Error('主题已不存在');
      if (entry.updatedAt !== expectedUpdatedAt) throw new Error('主题已被修改，请刷新后重试');
      if (categoryId && !data.categories.some((c) => c.id === categoryId)) throw new Error('分类不存在');
      entry.categoryId = categoryId;
      write(data);
      return clone(entry);
    }

    function restore(trashId) {
      const data = read();
      const index = data.trash.findIndex((item) => item.trashId === trashId);
      if (index < 0) throw new Error('回收站主题已不存在');
      const entry = clone(data.trash[index].entry);
      if (data.entries.some((item) => item.id === entry.id)) { entry.id = crypto.randomUUID(); entry.name += '（恢复副本）'; }
      data.entries.push(entry); data.trash.splice(index, 1); write(data); return entry;
    }

    function backups() {
      if (!fs.existsSync(backupsDir)) return [];
      return fs.readdirSync(backupsDir).filter((name) => /^[\w-]+\.json$/.test(name)).sort().reverse().map((name) => {
        try {
          const filename = path.join(backupsDir, name);
          const stat = fs.statSync(filename);
          const cached = backupCache.get(filename);
          if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) return cached.result;
          const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
          const expected = parsed.entries?.length;
          const data = validate(parsed);
          const result = { name, valid: data.entries.length === expected, count: data.entries.length };
          backupCache.set(filename, { size: stat.size, mtime: stat.mtimeMs, result });
          return result;
        }
        catch { return { name, valid: false, count: 0 }; }
      });
    }

    function recoverLock() {
      if (!fs.existsSync(lockFile)) return false;
      const raw = fs.readFileSync(lockFile, 'utf8');
      let owner;
      try { owner = JSON.parse(raw); } catch { throw new Error('旧锁缺少进程信息；请关闭 Eagle 后手工保留备份并移走 .lock 文件'); }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('旧锁缺少进程信息；请关闭 Eagle 后手工保留备份并移走 .lock 文件');
      try { require('process').kill(owner.pid, 0); throw new Error('持锁进程仍在运行，请先关闭相关插件后重试'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      if (fs.readFileSync(lockFile, 'utf8') !== raw) throw new Error('锁已变化，请重试');
      fs.unlinkSync(lockFile); return true;
    }

    function setRetention(backupCount, trashDays) {
      if (!Number.isInteger(backupCount) || backupCount < 1 || backupCount > 100
          || !Number.isInteger(trashDays) || trashDays < 0 || trashDays > 3650) {
        throw new Error('备份份数须为 1～100；回收站天数须为 0～3650（0 为永久保留）');
      }
      const data = read();
      data.retention = { backupCount, trashDays };
      write(data);
    }

    function restoreBackup(name) {
      if (!backups().some((item) => item.name === name && item.valid)) throw new Error('备份不存在或已损坏');
      // Resolve and verify every resource before replacing anything. A lightweight
      // backup listing can establish presence, but is not a checksum verification.
      const source = JSON.parse(fs.readFileSync(path.join(backupsDir, name), 'utf8'));
      const expected = source.entries?.length;
      const data = validate(clone(validate(source)));
      if (data.entries.length !== expected) throw new Error('备份含损坏主题或缺失资源，未替换当前仓库');
      const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      Object.defineProperty(data, '_fingerprint', { value: raw == null ? null : digest(raw) });
      write(data);
    }

    function exportBundle() {
      const data = read();
      const payload = JSON.stringify(data);
      return JSON.stringify({ format: 'eagle-warehouse', version: 1, library, checksum: digest(payload), payload });
    }

    function importBundle(text, { allowLibraryMove = false } = {}) {
      const bundle = JSON.parse(text);
      if (bundle.format !== 'eagle-warehouse' || bundle.version !== 1 || typeof bundle.payload !== 'string'
          || digest(bundle.payload) !== bundle.checksum) throw new Error('仓库包格式或校验和错误');
      const payload = JSON.parse(bundle.payload);
      if (normalize(payload.library) !== normalize(library) && allowLibraryMove) {
        const previousLibrary = payload.library;
        payload.library = library;
        // A moved library's file paths cannot be safely guessed. Preserve the
        // snapshot, disable replay until the user supplies current conditions.
        for (const entry of payload.entries || []) {
          entry.sourceLibrary = previousLibrary;
          entry.previousRecipe = entry.recipe;
          entry.recipe = null;
          entry.legacy = true;
        }
      }
      const incoming = validate(payload);
      const data = read();
      let count = 0;
      incoming.categories.forEach((category) => { if (!data.categories.some((item) => item.id === category.id)) data.categories.push(category); });
      incoming.entries.forEach((entry) => { if (!data.entries.some((item) => item.id === entry.id)) { data.entries.push(entry); count += 1; } });
      write(data); return count;
    }

    return { list, add, replace, remove, category, setCategory, setCover, restore, backups, restoreBackup, exportBundle, importBundle, setRetention, hydrateEntry, recoverLock };
  }
  return { open, sceneKey, updatedEntry };
})();
