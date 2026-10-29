/* 每个 Eagle 库独立存储；同目录临时文件 + rename，写入失败不覆盖旧快照。 */
const ArchiveStore = (() => {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const normalize = (value) => String(value || '').replace(/\//g, '\\').toLowerCase();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const references = new WeakMap();
  const backupCache = new Map();
  // Only tokens issued by successful in-memory transactions can undo a write.
  // Imports/JSON cannot manufacture a token or expose its retained scene diff.
  const undoTransactions = new WeakMap();

  // 旧分类没有 parentId，仍作为根文件夹；异常归属放回根部，避免整支不可见。
  function categoryTree(categories) {
    const byId = new Map(categories.map((category) => [category.id,
      { ...category, parentId: category.parentId || '', children: [], ids: new Set([category.id]) }]));
    for (const category of byId.values()) {
      const visited = new Set([category.id]);
      let parent = category.parentId;
      while (parent) {
        if (!byId.has(parent) || visited.has(parent)) { category.parentId = ''; break; }
        visited.add(parent); parent = byId.get(parent).parentId;
      }
    }
    const roots = [];
    for (const category of byId.values()) {
      if (category.parentId) byId.get(category.parentId).children.push(category);
      else roots.push(category);
    }
    const items = [];
    const visit = (category, path, depth) => {
      category.path = [...path, category.name].join(' / '); category.depth = depth;
      items.push(category);
      for (const child of category.children) {
        visit(child, [...path, category.name], depth + 1);
        child.ids.forEach((id) => category.ids.add(id));
      }
    };
    roots.forEach((category) => visit(category, [], 0));
    return { roots, byId, items };
  }

  function retainedBytes(value) {
    // Conservative JSON-shaped heap estimate, not a process RSS guarantee.
    let bytes = 0;
    const pending = [value];
    while (pending.length) {
      const current = pending.pop();
      if (typeof current === 'string') bytes += 48 + current.length * 2;
      else if (Array.isArray(current)) {
        bytes += 48 + current.length * 8;
        current.forEach((child) => pending.push(child));
      }
      else if (current && typeof current === 'object') {
        const keys = Object.keys(current);
        bytes += 64 + keys.reduce((sum, key) => sum + 48 + key.length * 2, 0);
        keys.forEach((key) => pending.push(current[key]));
      } else bytes += 8;
    }
    return bytes;
  }

  function sceneKey(match) {
    return JSON.stringify([
      match.eagleItemId || normalize(match.video_path),
      match.original_start_frame ?? match.start_frame,
      match.original_end_frame ?? match.end_frame,
    ]);
  }

  const pathSceneKey = (match) => sceneKey({ ...match, eagleItemId: undefined });
  function validManualScore(match) {
    if (match.manualScore === undefined) return true;
    const score = match.manualScore;
    return score && typeof score === 'object' && !Array.isArray(score)
      && typeof score.value === 'number' && Number.isFinite(score.value) && score.value >= 0
      && ['custom', 'top'].includes(score.mode)
      && typeof score.scoredAt === 'string' && Number.isFinite(Date.parse(score.scoredAt))
      && match.similarity === score.value;
  }
  function validMatch(match, requireBounds = false) {
    if (!match || typeof match !== 'object' || Array.isArray(match)
        || typeof match.video_path !== 'string' || !match.video_path.trim()
        || (match.eagleItemId != null && (typeof match.eagleItemId !== 'string' || !match.eagleItemId))
        || ['start', 'end', 'duration_display'].some((key) => match[key] != null
          && (typeof match[key] !== 'string' || match[key].length > 1024))
        || (match.reviewedAt !== undefined && (typeof match.reviewedAt !== 'string'
          || !Number.isFinite(Date.parse(match.reviewedAt))))
        || !validManualScore(match)) return false;
    if (!requireBounds) return true;
    const start = match.original_start_frame ?? match.start_frame;
    const end = match.original_end_frame ?? match.end_frame;
    return Number.isInteger(start) && start >= 0 && Number.isInteger(end) && end >= start;
  }
  // ID identity survives moves. A path alias is eligible only when one side is
  // legacy (no ID), so two known items sharing a historical path stay distinct.
  function sceneLookup(matches) {
    const exact = new Map();
    const paths = new Map();
    const indexed = [];
    const set = (index, match) => {
      const previous = indexed[index];
      if (previous) {
        if (exact.get(sceneKey(previous)) === index) exact.delete(sceneKey(previous));
        const aliases = paths.get(pathSceneKey(previous));
        aliases?.delete(index);
        if (aliases?.size === 0) paths.delete(pathSceneKey(previous));
      }
      indexed[index] = match;
      if (!exact.has(sceneKey(match))) exact.set(sceneKey(match), index);
      const key = pathSceneKey(match);
      const values = paths.get(key) || new Set();
      values.add(index); paths.set(key, values);
    };
    matches.forEach((match, index) => set(index, match));
    const find = (match) => {
      const direct = exact.get(sceneKey(match));
      if (direct !== undefined) return direct;
      const aliases = paths.get(pathSceneKey(match));
      if (aliases) for (const index of aliases) {
        if (!match.eagleItemId || !indexed[index].eagleItemId) return index;
      }
      return undefined;
    };
    find.set = set;
    return find;
  }
  function validRemovedMatches(value) {
    const keys = new Set();
    return Array.isArray(value) && value.every((record) => {
      const match = record?.match;
      const start = match?.original_start_frame ?? match?.start_frame;
      const end = match?.original_end_frame ?? match?.end_frame;
      if (!validMatch(match)
          || !Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < start
          || typeof record.key !== 'string' || record.key !== sceneKey(match)
          || typeof record.removedAt !== 'string' || !Number.isFinite(Date.parse(record.removedAt)) || keys.has(record.key)) return false;
      keys.add(record.key);
      return true;
    });
  }

  function exclusionFilter(records) {
    const find = sceneLookup(records.map((record) => record.match));
    return (match) => find(match) === undefined;
  }

  function updatedEntry(previous, matches, recipe, view, now = new Date().toISOString()) {
    const findOld = sceneLookup(previous.matches);
    const manual = previous.matches.filter((match) => match.manualScore !== undefined);
    if (!manual.every(validManualScore)) throw new Error('仓库人工分数无效');
    const findManual = sceneLookup(manual);
    const retained = new Set();
    const removedMatches = previous.removedMatches || [];
    matches = matches.filter(exclusionFilter(removedMatches)).map((match) => {
      const oldIndex = findOld(match);
      const reviewedAt = oldIndex === undefined ? undefined : previous.matches[oldIndex].reviewedAt;
      match = { ...match };
      delete match.reviewedAt;
      if (reviewedAt !== undefined) match.reviewedAt = reviewedAt;
      const index = findManual(match);
      if (index === undefined) return match;
      retained.add(index);
      const stored = manual[index];
      const merged = { ...stored, ...match, manualScore: stored.manualScore, similarity: stored.manualScore.value };
      if (!match.eagleItemId && stored.eagleItemId) {
        merged.eagleItemId = stored.eagleItemId; merged.video_path = stored.video_path;
      }
      delete merged.both_hit; delete merged.matched_queries;
      return merged;
    });
    // Deduplicate aliases after promotion; do not join different known IDs.
    const unique = [];
    const exact = new Set();
    const legacy = new Map();
    const identifiedPaths = new Set();
    matches.concat(manual.filter((_, index) => !retained.has(index))).forEach((match) => {
      const key = sceneKey(match); const alias = pathSceneKey(match);
      if (exact.has(key) || (!match.eagleItemId && identifiedPaths.has(alias))) return;
      if (legacy.has(alias)) {
        if (!match.eagleItemId) return;
        const index = legacy.get(alias);
        const previousMatch = unique[index];
        exact.delete(sceneKey(previousMatch));
        unique[index] = previousMatch.manualScore ? { ...match, manualScore: previousMatch.manualScore,
          similarity: previousMatch.manualScore.value } : match;
        if (previousMatch.reviewedAt) unique[index] = { ...unique[index], reviewedAt: previousMatch.reviewedAt };
        exact.add(key); legacy.delete(alias); identifiedPaths.add(alias);
        return;
      }
      exact.add(key);
      if (match.eagleItemId) identifiedPaths.add(alias);
      else legacy.set(alias, unique.length);
      unique.push(match);
    });
    matches = unique;
    return { ...previous, recipe: clone(recipe), view: clone(view), matches: clone(matches), removedMatches: clone(removedMatches),
      newKeys: matches.filter((match) => !match.manualScore && findOld(match) === undefined).map(sceneKey), updatedAt: now,
      summary: { matches: matches.length, videos: new Set(matches.map((m) => m.eagleItemId || normalize(m.video_path))).size,
        removed: removedMatches.length } };
  }

  function entryChanges(previous, candidate, rawMatches) {
    const before = sceneLookup(previous.matches);
    const after = sceneLookup(candidate.matches);
    const raw = rawMatches ? sceneLookup(rawMatches) : null;
    const added = candidate.matches.filter((match) => before(match) === undefined);
    const removed = previous.matches.filter((match) => after(match) === undefined);
    const manual = raw ? candidate.matches.filter((match) =>
      match.manualScore && before(match) !== undefined && raw(match) === undefined) : [];
    return { added, removed, manual, retained: candidate.matches.length - added.length };
  }

  function open(root, library) {
    const dir = path.join(root, 'warehouse');
    const hash = crypto.createHash('sha256').update(normalize(library)).digest('hex').slice(0, 24);
    const file = path.join(dir, `${hash}.json`);
    const backupsDir = path.join(dir, `${hash}-backups`);
    const revisionClock = path.join(backupsDir, 'revision-clock');
    const assetsDir = path.join(dir, `${hash}-assets`);
    const lockFile = `${file}.lock`;
    const recognizedTrash = new WeakSet();
    const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
    const ownedBackup = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
    function revisionHighWater(data) {
      const revisions = [data.revision, ...data.entries.map((entry) => entry.revision),
        ...data.trash.map((item) => item?.entry?.revision)];
      return revisions.reduce((highest, value) => Number.isSafeInteger(value) && value >= 0
        ? Math.max(highest, value) : highest, 0);
    }
    function reserveRevisions(data) {
      let highWater = revisionHighWater(data);
      if (fs.existsSync(revisionClock)) {
        const stored = JSON.parse(fs.readFileSync(revisionClock, 'utf8'));
        if (!Number.isSafeInteger(stored) || stored < 0) throw new Error('仓库版本记录已损坏，未覆盖原仓库');
        highWater = Math.max(highWater, stored);
      }
      if (data._restoring || data._restoringEntryId !== undefined) {
        if (highWater >= Number.MAX_SAFE_INTEGER) throw new Error('仓库版本已达到上限，未覆盖原仓库');
        highWater += 1;
        data.entries.forEach((entry) => {
          if (data._restoring || entry.id === data._restoringEntryId) entry.revision = highWater;
        });
        if (data._restoring) data.trash.forEach((item) => { if (recognizedTrash.has(item)) item.entry.revision = highWater; });
      }
      // Persist the high-water mark before the manifest. A failed commit may
      // leave a harmless gap, but neither a restore nor a corrupt manifest can
      // make a revision held by an old editor valid again.
      fs.mkdirSync(backupsDir, { recursive: true });
      const temporary = `${revisionClock}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(highWater), { encoding: 'utf8', flag: 'wx' });
        fs.renameSync(temporary, revisionClock);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
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
      const valid = key === 'matches' ? Array.isArray(value) && value.every((match) => validMatch(match))
        : key === 'removedMatches' ? validRemovedMatches(value)
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
        else if (key === 'matches' || key === 'removedMatches' || key === 'cover' || key === 'recipe') {
          if (key === 'removedMatches' || key === 'matches') checkAsset(key, entry[key]);
          if (entry[key] != null) packed[`${key}Ref`] = saveAsset(entry[key]);
          else packed[key] = entry[key];
        } else packed[key] = entry[key];
      });
      if (!entry.summary || !Object.getOwnPropertyDescriptor(entry, 'matches')?.get) {
        packed.summary = { matches: entry.matches.length,
          videos: new Set(entry.matches.map((m) => m.eagleItemId || normalize(m.video_path))).size };
      }
      packed.summary = { ...packed.summary, removed: Object.getOwnPropertyDescriptor(entry, 'removedMatches')?.get
        && Number.isSafeInteger(entry.summary?.removed) ? entry.summary.removed : (entry.removedMatches || []).length };
      return packed;
    }
    async function hydrateEntry(entry, keys = ['matches', 'recipe', 'cover', 'removedMatches']) {
      await Promise.all(keys.map(async (key) => {
        const ref = references.get(entry)?.[key];
        if (!ref || !Object.getOwnPropertyDescriptor(entry, key)?.get) return;
        const value = checkAsset(key, decodeAsset(ref, await fs.promises.readFile(assetPath(ref), 'utf8')));
        Object.defineProperty(entry, key, { value, enumerable: true, configurable: true, writable: true });
      }));
      return entry;
    }

    function unpackEntry(entry) {
      if (entry && typeof entry === 'object') entry.favorite = entry.favorite === true;
      for (const key of ['matches', 'recipe', 'cover', 'removedMatches']) {
        if (entry?.[`${key}Ref`]) { lazyAsset(entry, key, entry[`${key}Ref`]); delete entry[`${key}Ref`]; }
      }
      return entry && typeof entry.id === 'string' && typeof entry.name === 'string'
        && (references.get(entry)?.matches || (Array.isArray(entry.matches)
        && entry.matches.every((match) => validMatch(match))))
        && entry.view && typeof entry.view === 'object'
        && (references.get(entry)?.removedMatches || entry.removedMatches == null || validRemovedMatches(entry.removedMatches))
        && (references.get(entry)?.recipe || entry.recipe == null || typeof entry.recipe === 'object');
    }

    function knownTrash(item) {
      return item && typeof item.trashId === 'string' && Number.isFinite(Date.parse(item.deletedAt))
        && item.entry && typeof item.entry.id === 'string' && typeof item.entry.name === 'string'
        && item.entry.view && typeof item.entry.view === 'object'
        && (references.get(item.entry)?.matches || typeof item.entry.matchesRef === 'string'
          || Array.isArray(item.entry.matches));
    }

    function packTrash(item) {
      return recognizedTrash.has(item) ? { ...item, entry: packEntry(item.entry) } : item;
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
          if (!unpackEntry(entry) || ids.has(entry.id)) {
            data.quarantine.push({ reason: '主题结构无效或 ID 重复', value: original }); return false;
          }
        } catch { data.quarantine.push({ reason: '主题资源缺失或引用无效', value: original }); return false; }
        ids.add(entry.id);
        return true;
      });
      data.trash = data.trash.map((item) => {
        if (!knownTrash(item)) return item;
        // Decode only recognized records. Keep unknown or broken originals as
        // evidence, without leaving getters that could throw on the next write.
        const original = { ...item, entry: { ...item.entry } };
        try { if (unpackEntry(item.entry)) { recognizedTrash.add(item); return item; } }
        catch { /* Preserve the original resource references. */ }
        return original;
      });
      data.categories = data.categories.filter((category) => category && typeof category.id === 'string' && typeof category.name === 'string');
      data.entries.forEach((entry) => {
        if (!references.get(entry)?.removedMatches) {
          entry.summary = { ...entry.summary, removed: (entry.removedMatches || []).length };
        }
        if (!data.categories.some((category) => category.id === entry.categoryId)) {
          if (entry.categoryId) entry.revision = (entry.revision || 0) + 1;
          entry.categoryId = '';
        }
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
        reserveRevisions(data);
        const policy = retention(data);
        // 0 means keep forever. Unknown/invalid historical trash is never purged.
        if (policy.trashDays > 0) data.trash = data.trash.filter((item) => {
          const deleted = Date.parse(item?.deletedAt);
          if (!recognizedTrash.has(item) || !Number.isFinite(deleted)
              || deleted > Date.now() - policy.trashDays * 86400000) return true;
          // Presence alone cannot justify purging a historical record. Check
          // only expired candidates, without consuming or changing lazy getters.
          try {
            for (const key of ['matches', 'recipe', 'cover', 'removedMatches']) {
              const ref = references.get(item.entry)?.[key];
              const value = ref ? decodeAsset(ref, fs.readFileSync(assetPath(ref), 'utf8')) : item.entry[key];
              if (key === 'matches' || value != null) checkAsset(key, value);
            }
            return false;
          } catch { return true; }
        });
        const packed = { ...data, entries: data.entries.map(packEntry), trash: data.trash.map(packTrash) };
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
              favorite: false,
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

    function resolveCategory(data, selection) {
      if (selection && typeof selection === 'object') {
        const name = typeof selection.name === 'string' ? selection.name.trim() : '';
        if (!name || name.length > 60) throw new Error('分类名称须为 1～60 个字符');
        const existing = data.categories.find((category) => category.name === name && !category.parentId);
        if (existing) return existing.id;
        const category = { id: crypto.randomUUID(), name };
        data.categories.push(category);
        return category.id;
      }
      if (selection && !data.categories.some((category) => category.id === selection)) throw new Error('分类不存在');
      return selection || '';
    }

    function add({ name, categoryId, recipe, view, matches, favorite = false }) {
      if (typeof favorite !== 'boolean') throw new Error('星标状态格式无效');
      const data = read();
      const now = new Date().toISOString();
      const entry = { id: crypto.randomUUID(), name: name.trim() || recipe?.query || '未命名',
        categoryId: resolveCategory(data, categoryId), favorite, query: recipe?.query || name, recipe, view, matches,
        createdAt: now, updatedAt: now, newKeys: [] };
      data.entries.push(clone(entry));
      write(data);
      return entry;
    }

    async function copyEntry(id, name, expectedUpdatedAt, expectedRevision, shouldApply = () => true) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('请输入副本名称');
      const data = read();
      const source = data.entries.find((entry) => entry.id === id);
      if (!source) throw new Error('原主题已被删除或资源无效');
      if (source.updatedAt !== expectedUpdatedAt || (source.revision || 0) !== (expectedRevision || 0)) {
        throw new Error('原主题已被其他操作更新，请重新打开后复制');
      }
      await hydrateEntry(source);
      for (const key of ['matches', 'recipe', 'cover', 'removedMatches']) {
        if (source[key] != null) checkAsset(key, source[key]);
      }
      if (!shouldApply()) throw new Error('素材库或当前页面已切换，未创建副本');
      const now = new Date().toISOString();
      const copy = { ...clone(source), id: crypto.randomUUID(), name: name.trim(), revision: 0,
        createdAt: now, metadataUpdatedAt: now };
      data.entries.push(copy);
      write(data);
      return copy;
    }

    function replace(entry, expectedUpdatedAt) {
      const data = read();
      const index = data.entries.findIndex((value) => value.id === entry.id);
      if (index < 0) throw new Error('主题已被删除');
      if (expectedUpdatedAt != null && data.entries[index].updatedAt !== expectedUpdatedAt) {
        throw new Error('主题已被其他操作更新，请重新打开后重试');
      }
      if ((entry.revision || 0) !== (data.entries[index].revision || 0)) throw new Error('主题已被其他操作更新，请重新打开后重试');
      const replacement = { ...clone(entry), categoryId: resolveCategory(data, entry.categoryId), revision: (entry.revision || 0) + 1 };
      data.entries[index] = replacement;
      write(data);
      return replacement;
    }

    function editMatches(id, keys, expectedUpdatedAt, expectedRevision, restoring) {
      if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) throw new Error('片段选择格式无效');
      const data = read();
      const entry = data.entries.find((value) => value.id === id);
      if (!entry) throw new Error('主题已被删除或资源无效');
      if ((expectedUpdatedAt != null && entry.updatedAt !== expectedUpdatedAt)
          || (entry.revision || 0) !== (expectedRevision || 0)) {
        throw new Error('主题已被其他操作更新，请重新打开后重试');
      }
      const selected = new Set(keys);
      const removed = entry.removedMatches || [];
      const changed = [];
      if (restoring) {
        const live = new Set(entry.matches.map(sceneKey));
        const matches = entry.matches.slice();
        entry.removedMatches = removed.filter((record) => {
          if (!selected.has(record.key)) return true;
          changed.push(record.key);
          const key = sceneKey(record.match);
          if (!live.has(key)) { matches.push(clone(record.match)); live.add(key); }
          return false;
        });
        entry.matches = matches;
      } else {
        const excluded = new Set(removed.map((record) => record.key));
        const records = removed.slice();
        const removedAt = new Date().toISOString();
        entry.matches = entry.matches.filter((match) => {
          const key = sceneKey(match);
          if (!selected.has(key)) return true;
          if (!excluded.has(key)) {
            records.push({ key, match: clone(match), removedAt });
            excluded.add(key); changed.push(key);
          }
          return false;
        });
        entry.removedMatches = records;
      }
      if (!changed.length) return { entry: clone(entry), keys: [] };
      const live = new Set(entry.matches.map(sceneKey));
      entry.newKeys = (entry.newKeys || []).filter((key) => live.has(key));
      entry.summary = { matches: entry.matches.length,
        videos: new Set(entry.matches.map((match) => match.eagleItemId || normalize(match.video_path))).size,
        removed: entry.removedMatches.length };
      entry.revision = (entry.revision || 0) + 1;
      // Resolve and validate all resources before committing, so a broken
      // recipe/cover cannot make the returned snapshot fail after a write.
      const result = clone(entry);
      write(data);
      return { entry: result, keys: changed };
    }

    const removeMatches = (id, keys, expectedUpdatedAt, expectedRevision) => editMatches(id, keys, expectedUpdatedAt, expectedRevision, false);
    const restoreMatches = (id, keys, expectedUpdatedAt, expectedRevision) => editMatches(id, keys, expectedUpdatedAt, expectedRevision, true);

    function setFavorite(id, favorite, expectedUpdatedAt, expectedRevision) {
      if (typeof favorite !== 'boolean') throw new Error('星标状态格式无效');
      const data = read();
      const entry = data.entries.find((value) => value.id === id);
      if (!entry) throw new Error('主题已被删除或资源无效');
      if ((expectedUpdatedAt != null && entry.updatedAt !== expectedUpdatedAt)
          || (entry.revision || 0) !== (expectedRevision || 0)) {
        throw new Error('主题已被其他操作更新，请重新打开后重试');
      }
      if (entry.favorite !== favorite) {
        entry.favorite = favorite;
        entry.revision = (entry.revision || 0) + 1;
        write(data);
      }
      return { id: entry.id, favorite: entry.favorite, updatedAt: entry.updatedAt, revision: entry.revision || 0 };
    }

    function setReviewed(id, keys, reviewed, expectedUpdatedAt, expectedRevision) {
      if (typeof reviewed !== 'boolean' || !Array.isArray(keys)
          || keys.some((key) => typeof key !== 'string')) throw new Error('审阅状态格式无效');
      const data = read();
      const entry = data.entries.find((value) => value.id === id);
      if (!entry) throw new Error('主题已被删除或资源无效');
      if ((expectedUpdatedAt != null && entry.updatedAt !== expectedUpdatedAt)
          || (entry.revision || 0) !== (expectedRevision || 0)) {
        throw new Error('主题已被其他操作更新，请重新打开后重试');
      }
      const selected = new Set(keys);
      const matches = entry.matches;
      if ([...selected].some((key) => !matches.some((match) => sceneKey(match) === key))) {
        throw new Error('片段已不在当前主题，请重新打开主题');
      }
      const reviewedAt = new Date().toISOString();
      let changed = false;
      entry.matches = matches.map((match) => {
        if (!selected.has(sceneKey(match)) || !!match.reviewedAt === reviewed) return match;
        const next = { ...match };
        if (reviewed) next.reviewedAt = reviewedAt;
        else delete next.reviewedAt;
        changed = true;
        return next;
      });
      if (!changed) return { entry: clone(entry) };
      entry.revision = (entry.revision || 0) + 1;
      const result = clone(entry);
      write(data);
      return { entry: result };
    }

    function addMatches(id, additions, expectedUpdatedAt, expectedRevision, { markReviewed = false } = {}) {
      if (typeof markReviewed !== 'boolean') throw new Error('审阅状态格式无效');
      if (!Array.isArray(additions) || additions.some((addition) => !addition
          || !validMatch(addition.match, true)
          || (addition.keepExisting !== undefined && typeof addition.keepExisting !== 'boolean')
          || (!addition.keepExisting && (typeof addition.score !== 'number'
            || !Number.isFinite(addition.score) || addition.score < 0
            || !['custom', 'top'].includes(addition.scoreMode))))) throw new Error('人工添加片段或分数格式无效');
      // Snapshot/validate the whole input before reading or writing the target.
      const incoming = clone(additions);
      if (incoming.some((addition) => !validMatch(addition.match, true))) throw new Error('人工添加片段格式无效');
      const data = read();
      const entry = data.entries.find((value) => value.id === id);
      if (!entry) throw new Error('主题已被删除或资源无效');
      if ((expectedUpdatedAt != null && entry.updatedAt !== expectedUpdatedAt)
          || (entry.revision || 0) !== (expectedRevision || 0)) {
        throw new Error('主题已被其他操作更新，请重新打开后重试');
      }
      const originalMatches = entry.matches;
      const matches = originalMatches.slice();
      const findMatch = sceneLookup(matches);
      const removed = entry.removedMatches || [];
      const originalNewKeys = entry.newKeys || [];
      const fieldState = (key) => !Object.prototype.hasOwnProperty.call(entry, key) ? 'absent'
        : entry[key] === null ? 'null' : 'array';
      const removedState = fieldState('removedMatches');
      const newKeysState = fieldState('newKeys');
      const findRemoved = sceneLookup(removed.map((record) => record.match));
      const cleared = new Set();
      const changed = new Set();
      const added = new Set(); const rescored = new Set();
      const kept = new Set();
      const scoredAt = new Date().toISOString();
      for (const addition of incoming) {
        const index = findMatch(addition.match);
        const prior = index === undefined ? null : matches[index];
        if (prior && addition.keepExisting) { kept.add(index); continue; }
        if (typeof addition.score !== 'number' || !Number.isFinite(addition.score) || addition.score < 0
            || !['custom', 'top'].includes(addition.scoreMode)) throw new Error('请为新增或重新加入的片段填写有效分数');
        const match = { ...addition.match,
          manualScore: { value: addition.score, mode: addition.scoreMode, scoredAt }, similarity: addition.score };
        if (!match.eagleItemId && prior?.eagleItemId) {
          match.eagleItemId = prior.eagleItemId; match.video_path = prior.video_path;
        }
        delete match.both_hit; delete match.matched_queries;
        const removedIndex = findRemoved(match);
        // Review state belongs to the target, never to a different source topic.
        delete match.reviewedAt;
        const reviewedAt = prior?.reviewedAt ?? (removedIndex === undefined ? undefined : removed[removedIndex].match.reviewedAt);
        if (markReviewed) match.reviewedAt = scoredAt;
        else if (reviewedAt !== undefined) match.reviewedAt = reviewedAt;
        if (removedIndex !== undefined) cleared.add(removedIndex);
        if (index === undefined) { added.add(matches.length); matches.push(match); }
        else { if (!added.has(index)) rescored.add(index); matches[index] = match; }
        const changedIndex = index === undefined ? matches.length - 1 : index;
        findMatch.set(changedIndex, match); changed.add(changedIndex);
      }
      if (!changed.size) return { entry: clone(entry), keys: [], added: 0, rescored: 0, restored: 0, kept: kept.size,
        undoToken: null, undoBytes: 0 };
      entry.matches = matches;
      entry.removedMatches = removed.filter((_, index) => !cleared.has(index));
      const automaticKeys = new Set(matches.filter((match) => !match.manualScore).map(sceneKey));
      entry.newKeys = (entry.newKeys || []).filter((key) => automaticKeys.has(key));
      const transaction = {
        file: normalize(path.resolve(file)), library: normalize(library), id,
        matches: [...changed].map((index) => ({ index,
          before: index < originalMatches.length ? clone(originalMatches[index]) : null,
          after: digest(JSON.stringify(matches[index])) })),
        removed: removed.flatMap((record, index) => cleared.has(index) ? [{ index, record: clone(record) }] : []),
        newKeys: originalNewKeys.flatMap((key, index) => !automaticKeys.has(key) ? [{ index, key }] : []),
        removedState, newKeysState,
        afterRemoved: digest(JSON.stringify(entry.removedMatches)), afterNewKeys: digest(JSON.stringify(entry.newKeys)),
      };
      const undoToken = Object.freeze({});
      // Count nested scene metadata too, but do not retain recipe/cover or whole
      // result arrays. The undo manager enforces its byte budget using this estimate.
      const undoBytes = retainedBytes(transaction) + 512;
      entry.summary = { matches: matches.length,
        videos: new Set(matches.map((match) => match.eagleItemId || normalize(match.video_path))).size,
        removed: entry.removedMatches.length };
      entry.revision = (entry.revision || 0) + 1;
      // Hydrate recipe/cover too before commit; callers never receive a failed
      // operation after the manifest has already been successfully replaced.
      const result = clone(entry);
      checkAsset('matches', result.matches); checkAsset('removedMatches', result.removedMatches);
      write(data);
      undoTransactions.set(undoToken, transaction);
      return { entry: result, keys: [...changed].map((index) => sceneKey(matches[index])),
        added: added.size, rescored: rescored.size, restored: cleared.size, kept: kept.size, undoToken, undoBytes };
    }

    function undoMatches(id, token, expectedUpdatedAt, expectedRevision) {
      const transaction = token && typeof token === 'object' ? undoTransactions.get(token) : null;
      if (!transaction || transaction.id !== id || transaction.library !== normalize(library)
          || transaction.file !== normalize(path.resolve(file))) throw new Error('撤销记录无效、已使用或不属于当前主题');
      const data = read();
      const entry = data.entries.find((value) => value.id === id);
      if (!entry) throw new Error('主题已被删除或资源无效');
      if ((expectedUpdatedAt != null && entry.updatedAt !== expectedUpdatedAt)
          || (entry.revision || 0) !== (expectedRevision || 0)) {
        throw new Error('主题已被其他操作更新，请重新打开后重试');
      }
      const matches = entry.matches;
      const removed = entry.removedMatches || [];
      const newKeys = entry.newKeys || [];
      if (transaction.matches.some((record) => !matches[record.index]
        || digest(JSON.stringify(matches[record.index])) !== record.after)
        || digest(JSON.stringify(removed)) !== transaction.afterRemoved
        || digest(JSON.stringify(newKeys)) !== transaction.afterNewKeys) {
        throw new Error('片段已变化，不能应用这条撤销记录');
      }
      const replacements = new Map(transaction.matches.map((record) => [record.index, record.before]));
      entry.matches = matches.flatMap((match, index) => !replacements.has(index) ? [match]
        : replacements.get(index) == null ? [] : [clone(replacements.get(index))]);
      const restoredRemoved = removed.slice();
      transaction.removed.forEach(({ index, record }) => restoredRemoved.splice(index, 0, clone(record)));
      const restoredKeys = newKeys.slice();
      transaction.newKeys.forEach(({ index, key }) => restoredKeys.splice(index, 0, key));
      const restoreField = (key, state, value) => {
        if (state === 'absent') delete entry[key];
        else entry[key] = state === 'null' ? null : value;
      };
      restoreField('removedMatches', transaction.removedState, restoredRemoved);
      restoreField('newKeys', transaction.newKeysState, restoredKeys);
      entry.summary = { matches: entry.matches.length,
        videos: new Set(entry.matches.map((match) => match.eagleItemId || normalize(match.video_path))).size,
        removed: restoredRemoved.length };
      entry.revision = (entry.revision || 0) + 1;
      // Hydrate/check all required resources before the commit. Failure keeps
      // both the current manifest and the token available for an explicit retry.
      const result = clone(entry);
      checkAsset('matches', result.matches); checkAsset('removedMatches', result.removedMatches || []);
      const keys = transaction.matches.map((record) => record.before ? sceneKey(record.before) : sceneKey(matches[record.index]));
      write(data);
      undoTransactions.delete(token);
      return { entry: result, keys };
    }

    function remove(id) {
      const data = read();
      const entry = data.entries.find((entry) => entry.id === id);
      if (entry) {
        const item = { entry, deletedAt: new Date().toISOString(), trashId: crypto.randomUUID() };
        recognizedTrash.add(item); data.trash.push(item);
      }
      data.entries = data.entries.filter((entry) => entry.id !== id);
      write(data);
    }

    function removeEntries(requests) {
      if (!Array.isArray(requests)) throw new Error('删除请求格式无效');
      const data = read();
      const entries = new Map(data.entries.map((entry) => [entry.id, entry]));
      const seen = new Set();
      const deleted = new Set();
      const results = requests.map((request) => {
        const id = request?.id;
        const entry = entries.get(id);
        if (seen.has(id)) return { id, ok: false, code: 'duplicate', error: '主题请求重复' };
        seen.add(id);
        if (!entry) return { id, ok: false, code: 'missing', error: '主题已不存在' };
        if (entry.updatedAt !== request.updatedAt || (entry.revision || 0) !== (request.revision || 0)) {
          return { id, ok: false, code: 'conflict', error: '主题已被修改，请重新打开仓库后重试' };
        }
        const item = { entry, deletedAt: new Date().toISOString(), trashId: crypto.randomUUID() };
        recognizedTrash.add(item);
        data.trash.push(item);
        deleted.add(id);
        return { id, ok: true };
      });
      if (deleted.size) {
        data.entries = data.entries.filter((entry) => !deleted.has(entry.id));
        write(data);
      }
      return { results };
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

    function category(action, id, name = '', parentId) {
      const data = read();
      const found = data.categories.find((c) => c.id === id);
      if (!['add', 'rename', 'remove'].includes(action)) throw new Error('分类操作无效');
      if (action !== 'add' && !found) throw new Error('分类已不存在');
      if (action !== 'remove') {
        name = name.trim();
        if (!name || name.length > 60) throw new Error('分类名称须为 1～60 个字符');
        parentId = parentId === undefined ? found?.parentId || '' : parentId;
        const tree = categoryTree(data.categories);
        if (parentId && !tree.byId.has(parentId)) throw new Error('上级分类已不存在');
        if (action === 'rename' && tree.byId.get(id).ids.has(parentId)) throw new Error('不能移到自身或子分类中');
        if (data.categories.some((c) => c.name === name && (c.parentId || '') === parentId && c.id !== id)) {
          throw new Error('同一文件夹下的分类名称已存在');
        }
      }
      if (action === 'add') data.categories.push({ id: crypto.randomUUID(), name, parentId });
      else if (action === 'rename') {
        const affected = categoryTree(data.categories).byId.get(id).ids;
        found.name = name; found.parentId = parentId;
        data.entries.forEach((entry) => { if (affected.has(entry.categoryId)) entry.revision = (entry.revision || 0) + 1; });
      } else if (action === 'remove') {
        // 只删除当前文件夹；子文件夹提升一级，主题继续遵循原有未分类语义。
        const siblings = data.categories.filter((c) => (c.parentId || '') === (found.parentId || '') && c.id !== id);
        const children = data.categories.filter((c) => c.parentId === id);
        if (children.some((child) => siblings.some((sibling) => sibling.name === child.name))) {
          throw new Error('子分类提升后有同名文件夹，请先重命名或调整上级');
        }
        const affected = categoryTree(data.categories).byId.get(id).ids;
        children.forEach((child) => { child.parentId = found.parentId || ''; });
        data.categories = data.categories.filter((c) => c.id !== id);
        data.entries.forEach((entry) => {
          if (affected.has(entry.categoryId)) entry.revision = (entry.revision || 0) + 1;
          if (entry.categoryId === id) entry.categoryId = '';
        });
      }
      write(data);
    }

    function setCategories(requests, categoryId) {
      if (!Array.isArray(requests)) throw new Error('分类请求格式无效');
      const data = read();
      categoryId = resolveCategory(data, categoryId);
      const seen = new Set();
      const entries = new Map(data.entries.map((entry) => [entry.id, entry]));
      const results = requests.map((request) => {
        const id = request?.id;
        const entry = entries.get(id);
        let error;
        let code;
        if (!entry) { error = '主题已不存在'; code = 'missing'; }
        else if (seen.has(id)) { error = '主题请求重复'; code = 'duplicate'; }
        else if (entry.updatedAt !== request.updatedAt || (entry.revision || 0) !== (request.revision || 0)) {
          error = '主题已被修改，请刷新后重试'; code = 'conflict';
        }
        seen.add(id);
        if (error) return { id, ok: false, error, code };
        entry.categoryId = categoryId || '';
        entry.revision = (entry.revision || 0) + 1;
        return { id, ok: true, revision: entry.revision, categoryId: entry.categoryId };
      });
      // A commit error throws for the whole batch; no success is returned until
      // the new manifest has replaced the old one.
      if (results.some((result) => result.ok)) write(data);
      return { results };
    }

    function setCategory(entryId, categoryId, expectedUpdatedAt, expectedRevision) {
      // Compatibility for existing three-argument callers. New batch callers
      // always carry the revision from their selection snapshot.
      const entry = read().entries.find((item) => item.id === entryId);
      if (!entry) throw new Error('主题已不存在');
      const request = { id: entryId, updatedAt: expectedUpdatedAt,
        revision: expectedRevision ?? (entry.revision || 0) };
      const result = setCategories([request], categoryId).results[0];
      if (!result.ok) throw new Error(result.error);
      return { id: entryId, name: entry.name, categoryId: result.categoryId, updatedAt: entry.updatedAt, revision: result.revision };
    }

    function restore(trashId) {
      const data = read();
      const index = data.trash.findIndex((item) => item.trashId === trashId);
      if (index < 0) throw new Error('回收站主题已不存在');
      if (!recognizedTrash.has(data.trash[index])) throw new Error('回收站主题格式或资源无效，原始内容已保留');
      const entry = data.trash[index].entry;
      if (data.entries.some((item) => item.id === entry.id)) { entry.id = crypto.randomUUID(); entry.name += '（恢复副本）'; }
      entry.revision = (entry.revision || 0) + 1;
      if (entry.categoryId && !data.categories.some((category) => category.id === entry.categoryId)) entry.categoryId = '';
      data.entries.push(entry); data.trash.splice(index, 1); write(data); return entry;
    }

    function backups() {
      if (!fs.existsSync(backupsDir)) return [];
      return fs.readdirSync(backupsDir).filter((name) => /^[\w-]+\.json$/.test(name)).sort().reverse().map((name) => {
        try {
          const filename = path.join(backupsDir, name);
          const stat = fs.statSync(filename);
          const cached = backupCache.get(filename);
          if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs
              && cached.result.valid && cached.resources.every((resource) => fs.existsSync(resource))) return cached.result;
          const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
          const expected = parsed.entries?.length;
          const data = validate(parsed);
          const result = { name, valid: data.entries.length === expected
            && data.trash.every((item) => !knownTrash(item) || recognizedTrash.has(item)), count: data.entries.length };
          const resources = [...data.entries, ...data.trash.filter((item) => recognizedTrash.has(item)).map((item) => item.entry)]
            .flatMap((entry) => Object.values(references.get(entry) || {}).map(assetPath));
          backupCache.set(filename, { size: stat.size, mtime: stat.mtimeMs, result, resources });
          return result;
        }
        catch { return { name, valid: false, count: 0 }; }
      });
    }

    function entryBackup(name, id) {
      if (!/^[\w-]+\.json$/.test(name)) throw new Error('历史版本名称无效');
      const source = JSON.parse(fs.readFileSync(path.join(backupsDir, name), 'utf8'));
      if (![1, 2, 3].includes(source.version) || normalize(source.library) !== normalize(library)
          || !Array.isArray(source.entries) || !Array.isArray(source.categories)) throw new Error('历史版本格式或素材库不匹配');
      const entries = source.entries.filter((entry) => entry?.id === id);
      if (entries.length !== 1) throw new Error('历史版本中主题缺失或 ID 重复');
      const revision = entries[0].revision;
      const fingerprint = digest(JSON.stringify({ entry: entries[0], categories: source.categories }));
      const data = validate({ version: source.version, library: source.library, entries,
        categories: source.categories, imported: [], trash: [], quarantine: [] });
      if (data.entries.length !== 1 || data.quarantine.length) throw new Error('主题历史版本已损坏');
      return { entry: data.entries[0], fingerprint, revision };
    }

    function entryHistory(id) {
      if (!fs.existsSync(backupsDir)) return [];
      const seen = new Set();
      const history = [];
      for (const name of fs.readdirSync(backupsDir).filter((value) => /^[\w-]+\.json$/.test(value)).sort().reverse()) {
        try {
          const { entry, fingerprint, revision } = entryBackup(name, id);
          const key = Number.isSafeInteger(revision) ? `revision:${revision}` : fingerprint;
          if (seen.has(key)) continue;
          seen.add(key);
          history.push({ name, title: entry.name, revision: entry.revision, summary: entry.summary,
            savedAt: /^\d{13}-/.test(name) ? new Date(Number(name.slice(0, 13))).toISOString() : '',
            updatedAt: entry.updatedAt });
        } catch { /* Unreadable snapshots remain on disk and in whole-library recovery. */ }
      }
      return history;
    }

    async function readEntryBackup(name, id) {
      const snapshot = entryBackup(name, id);
      await hydrateEntry(snapshot.entry);
      for (const key of ['matches', 'recipe', 'cover', 'removedMatches']) {
        if (snapshot.entry[key] != null) checkAsset(key, snapshot.entry[key]);
      }
      return { entry: clone(snapshot.entry), fingerprint: snapshot.fingerprint };
    }

    async function restoreEntryBackup(name, id, expectedUpdatedAt, expectedRevision, expectedFingerprint, shouldApply = () => true) {
      const snapshot = await readEntryBackup(name, id);
      if (expectedFingerprint && snapshot.fingerprint !== expectedFingerprint) throw new Error('历史版本已变化，请重新打开预览');
      if (!shouldApply()) throw new Error('素材库或当前页面已切换，请重新打开历史版本');
      const data = read();
      const index = data.entries.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error('主题已不存在');
      const current = data.entries[index];
      if (current.updatedAt !== expectedUpdatedAt || current.revision !== expectedRevision) {
        throw new Error('主题已被其他操作更新，请重新打开后重试');
      }
      const entry = snapshot.entry;
      if (!data.categories.some((category) => category.id === entry.categoryId)) entry.categoryId = '';
      // Older stores may predate revision-clock. Keep the replaced revision in
      // the high-water calculation before allocating a fresh one under the lock.
      entry.revision = Math.max(Number.isSafeInteger(entry.revision) ? entry.revision : 0,
        Number.isSafeInteger(current.revision) ? current.revision : 0);
      data.entries[index] = entry;
      Object.defineProperty(data, '_restoringEntryId', { value: id });
      write(data);
      return clone(entry);
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
      if (data.entries.length !== expected || data.trash.some((item) => knownTrash(item) && !recognizedTrash.has(item))) {
        throw new Error('备份含损坏主题或缺失资源，未替换当前仓库');
      }
      const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      Object.defineProperty(data, '_fingerprint', { value: raw == null ? null : digest(raw) });
      Object.defineProperty(data, '_restoring', { value: true });
      write(data);
    }

    function exportBundle() {
      const data = read();
      const payload = JSON.stringify(data);
      return JSON.stringify({ format: 'eagle-warehouse', version: 1, library, checksum: digest(payload), payload });
    }

    function importBundle(text, { allowLibraryMove = false, expectedFingerprint } = {}) {
      const bundle = JSON.parse(text);
      if (bundle.format !== 'eagle-warehouse' || bundle.version !== 1 || typeof bundle.payload !== 'string'
          || digest(bundle.payload) !== bundle.checksum) throw new Error('仓库包格式或校验和错误');
      const payload = JSON.parse(bundle.payload);
      if (normalize(payload.library) !== normalize(library) && allowLibraryMove) {
        const previousLibrary = payload.library;
        payload.library = library;
        // A moved library's file paths cannot be safely guessed. Preserve the
        // snapshot, disable replay until the user supplies current conditions.
        for (const entry of [...(payload.entries || []), ...(payload.trash || []).filter(knownTrash).map((item) => item.entry)]) {
          entry.sourceLibrary = previousLibrary;
          entry.previousRecipe = entry.recipe;
          entry.recipe = null;
          entry.legacy = true;
        }
      }
      const incoming = validate(payload);
      const data = read();
      if (expectedFingerprint !== undefined && data._fingerprint !== expectedFingerprint) {
        throw new Error('仓库已在后台处理期间被其他操作更新，请检查后重新导入');
      }
      let count = 0;
      incoming.categories.forEach((category) => { if (!data.categories.some((item) => item.id === category.id)) data.categories.push(category); });
      incoming.entries.forEach((entry) => { if (!data.entries.some((item) => item.id === entry.id)) { data.entries.push(entry); count += 1; } });
      incoming.trash.forEach((item) => {
        if (!item?.trashId || !data.trash.some((current) => current?.trashId === item.trashId)) data.trash.push(item);
      });
      incoming.quarantine.forEach((item) => {
        if (!data.quarantine.some((current) => JSON.stringify(current) === JSON.stringify(item))) data.quarantine.push(item);
      });
      write(data); return count;
    }

    function runBundleWorker(action, text, options = {}) {
      return new Promise((resolve, reject) => {
        let worker;
        let timer;
        let settled = false;
        const timers = require('timers');
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          if (timer) timers.clearTimeout(timer);
          if (error) reject(error); else resolve(value);
        };
        const interrupted = (reason) => {
          const error = new Error(action === 'import'
            ? `${reason}，写入结果尚未知；请检查仓库后再决定是否重试`
            : `${reason}，仓库包未生成，请重试`);
          error.code = 'WORKER_INTERRUPTED';
          return error;
        };
        try {
          const filename = path.join(root, 'js', 'archiveWorker.js');
          if (!fs.existsSync(filename)) throw new Error('当前安装缺少仓库后台处理程序，请更新插件后重试');
          let Worker;
          try { ({ Worker } = require('worker_threads')); }
          catch { throw new Error('当前环境不支持仓库后台处理，请升级 Eagle 后重试'); }
          const timeoutMs = options.timeoutMs ?? 120000;
          if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('后台操作超时设置无效');
          const expectedFingerprint = action === 'import' ? read()._fingerprint : undefined;
          worker = new Worker(filename, { workerData: { root, library, action, text,
            options: { allowLibraryMove: options.allowLibraryMove === true, expectedFingerprint } } });
          worker.once('message', (message) => {
            const validValue = action === 'export' ? typeof message?.value === 'string' && message.value.length > 0
              : Number.isSafeInteger(message?.value) && message.value >= 0;
            if (message?.ok === true && validValue) finish(null, message.value);
            else if (message?.ok === false && typeof message.error === 'string') finish(new Error(message.error));
            else {
              finish(interrupted('后台处理返回无效结果'));
              worker.terminate().catch(() => {});
            }
          });
          worker.once('error', () => finish(interrupted('仓库后台线程异常退出')));
          worker.once('exit', () => finish(interrupted('仓库后台线程未返回结果')));
          timer = timers.setTimeout(() => {
            finish(interrupted('仓库后台处理超时'));
            // A terminated import may have reached the atomic commit. Do not
            // claim rollback; retain any lock/temp evidence for manual recovery.
            worker.terminate().catch(() => {});
          }, timeoutMs);
        } catch (error) { finish(error); }
      });
    }

    const exportBundleAsync = (options) => runBundleWorker('export', undefined, options);
    const importBundleAsync = (text, options) => runBundleWorker('import', text, options);

    return { list, add, copyEntry, replace, remove, removeEntries, removeMatches, restoreMatches, addMatches, undoMatches, setReviewed, setFavorite, category, setCategory, setCategories, setCover, restore, backups, restoreBackup, entryHistory, readEntryBackup, restoreEntryBackup, exportBundle, importBundle, exportBundleAsync, importBundleAsync, setRetention, hydrateEntry, recoverLock };
  }
  return { open, sceneKey, sceneLookup, updatedEntry, entryChanges, categoryTree };
})();
