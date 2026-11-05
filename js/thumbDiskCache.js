/*
 * 预览图磁盘缓存：ThumbLoader 内存缓存的第二层，重载或重开插件后无需等待搜索服务即可显示已看过的预览图。
 * 键为「规范化视频路径 + 帧号」，不含服务地址；记录素材大小与修改时间，原文件被替换后不再使用旧图。
 * 张数与容量沿用设置中的预览图缓存上限（磁盘按实际文件字节计），按最近访问淘汰；任一上限为 0 时清空并停用。
 */
const ThumbDiskCache = (() => {
  let fs = null;
  let path = null;
  let crypto = null;
  try { fs = require('fs'); path = require('path'); crypto = require('crypto'); } catch { /* 浏览器环境不提供磁盘缓存。 */ }
  let dir = null;
  let indexFile = null;
  // key -> { f: 文件名, b: 字节数, s: 素材指纹, m: 图片类型 }；Map 顺序即最近访问顺序。
  const entries = new Map();
  let totalBytes = 0;
  let maxEntries = 5000;
  let maxBytes = 128 * 1024 * 1024;
  let dirty = false;
  let saveTimer = null;
  let enabled = false;

  const normalize = (value) => String(value || '').replace(/\//g, '\\').toLowerCase();

  function parse(url) {
    try {
      const parsed = new URL(url);
      if (!/\/get_preview$/.test(parsed.pathname)) return null;
      const video = parsed.searchParams.get('video_path');
      const frame = parsed.searchParams.get('frame');
      if (!video || frame == null) return null;
      return { key: `${normalize(video)}|${frame}`, video };
    } catch { return null; }
  }

  function stampOf(video) {
    const item = typeof Bridge !== 'undefined' ? Bridge.itemForPath(video) : null;
    return item ? `${item.size ?? ''}:${item.lastModified ?? ''}` : null;
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => { saveTimer = null; save(); }, 1500);
  }

  function save(sync = false) {
    if (!enabled || !dirty) return;
    dirty = false;
    const text = JSON.stringify({ version: 1, entries: [...entries] });
    const temporary = `${indexFile}.${process.pid}.tmp`;
    try {
      if (sync) { fs.writeFileSync(temporary, text); fs.renameSync(temporary, indexFile); return; }
      fs.promises.writeFile(temporary, text).then(() => fs.promises.rename(temporary, indexFile))
        .catch((error) => { dirty = true; console.warn('预览图磁盘缓存索引保存失败', error.message); });
    } catch (error) { dirty = true; console.warn('预览图磁盘缓存索引保存失败', error.message); }
  }

  function drop(key) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    totalBytes -= entry.b;
    fs.promises.unlink(path.join(dir, entry.f)).catch(() => {});
    scheduleSave();
  }

  function trim() {
    while (entries.size && (entries.size > maxEntries || totalBytes > maxBytes)) drop(entries.keys().next().value);
  }

  function init(directory) {
    // 缺少任一文件能力（浏览器测试环境等）时停用，只保留内存缓存。
    const capable = fs && path && crypto && typeof Buffer !== 'undefined' && typeof process !== 'undefined'
      && ['readFile', 'writeFile', 'rename', 'unlink'].every((name) => typeof fs.promises?.[name] === 'function')
      && ['writeFileSync', 'renameSync', 'readdirSync', 'unlinkSync'].every((name) => typeof fs[name] === 'function');
    if (!capable || !directory) return;
    try {
      fs.mkdirSync(directory, { recursive: true });
      dir = directory;
      indexFile = path.join(dir, 'index.json');
      enabled = true;
      if (fs.existsSync(indexFile)) {
        const stored = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        for (const [key, entry] of stored?.entries || []) {
          if (typeof key !== 'string' || typeof entry?.f !== 'string' || !/^[0-9a-f]{40}\.img$/.test(entry.f)
            || !Number.isSafeInteger(entry.b) || entry.b <= 0) continue;
          entries.set(key, entry);
          totalBytes += entry.b;
        }
      }
    } catch (error) {
      // 索引损坏时从空缓存开始，随后清理没有索引记录的图片。
      entries.clear(); totalBytes = 0;
      console.warn('预览图磁盘缓存索引不可用，已重新开始', error.message);
    }
    if (enabled) {
      // 只扫描本缓存目录的普通图片文件；崩溃或索引损坏留下的孤儿不能游离于容量限制之外。
      try {
        const referenced = new Set([...entries.values()].map((entry) => entry.f));
        for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
          if (file.isFile() && /^[0-9a-f]{40}\.img$/.test(file.name) && !referenced.has(file.name)) {
            fs.unlinkSync(path.join(dir, file.name));
          }
        }
      } catch (error) { console.warn('预览图孤儿缓存清理失败', error.message); }
    }
    window.addEventListener('beforeunload', () => save(true));
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(true); });
  }

  function configure(cfg) {
    maxEntries = cfg.thumbnailCacheMaxEntries ?? 5000;
    maxBytes = (cfg.thumbnailCacheMaxMB ?? 128) * 1024 * 1024;
    if (enabled) trim();
  }

  function active() { return enabled && maxEntries > 0 && maxBytes > 0; }

  /* 命中返回 data URL；文件缺失、素材已变化或读取失败返回 null，由调用方改走网络。 */
  async function read(url) {
    if (!active()) return null;
    const target = parse(url);
    const entry = target && entries.get(target.key);
    if (!entry) return null;
    const stamp = stampOf(target.video);
    if (stamp && entry.s && stamp !== entry.s) { drop(target.key); return null; }
    try {
      const data = await fs.promises.readFile(path.join(dir, entry.f));
      if (entries.get(target.key) !== entry) return null;
      entries.delete(target.key); entries.set(target.key, entry);
      scheduleSave();
      return `data:${entry.m || 'image/jpeg'};base64,${data.toString('base64')}`;
    } catch {
      drop(target.key);
      return null;
    }
  }

  /* 成功解码的图片写入磁盘；已有同指纹记录时只更新访问顺序。 */
  function write(url, dataUrl) {
    try { writeEntry(url, dataUrl); } catch (error) { console.warn('预览图磁盘缓存写入失败', error.message); }
  }

  function writeEntry(url, dataUrl) {
    if (!active()) return;
    const target = parse(url);
    const match = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(dataUrl || '');
    if (!target || !match) return;
    const stamp = stampOf(target.video);
    const existing = entries.get(target.key);
    if (existing && (!stamp || existing.s === stamp)) {
      entries.delete(target.key); entries.set(target.key, existing);
      scheduleSave();
      return;
    }
    const data = Buffer.from(match[2], 'base64');
    if (!data.length || data.length > maxBytes) return;
    const file = `${crypto.createHash('sha1').update(target.key).digest('hex')}.img`;
    const entry = { f: file, b: data.length, s: stamp, m: match[1] };
    fs.promises.writeFile(path.join(dir, file), data).then(() => {
      // 同一键沿用同一文件名，替换时只更新记录，不能删除刚写入的文件。
      const previous = entries.get(target.key);
      if (previous) totalBytes -= previous.b;
      entries.delete(target.key);
      entries.set(target.key, entry);
      totalBytes += entry.b;
      trim();
      scheduleSave();
    }).catch((error) => console.warn('预览图磁盘缓存写入失败', error.message));
  }

  /* 全库清理后移除已不在库中的视频的预览图；其余视频的缓存继续保留。 */
  function prune(inventory) {
    if (!enabled || !inventory?.byPath) return;
    for (const key of [...entries.keys()]) {
      if (!inventory.byPath.has(key.slice(0, key.lastIndexOf('|')))) drop(key);
    }
  }

  return { init, configure, read, write, prune, stats: () => ({ entries: entries.size, bytes: totalBytes }) };
})();
