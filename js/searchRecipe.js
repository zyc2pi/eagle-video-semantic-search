/* 可重放的搜索条件。只保存搜索参数白名单，不包含服务路径或密钥。 */
const SearchRecipe = (() => {
  const OPTION_KEYS = [
    'modelName', 'threshold', 'visualThreshold', 'visualMargin', 'visualAgg',
    'visualCentered', 'visualSceneFrames', 'visualVideoFrames', 'aiEnhance',
    'aiExpand', 'aiMode', 'dedup', 'dedupThreshold', 'miniRerank',
  ];
  const MONTHS = [6, 12, 24, 36, 48, 60];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const normalize = (value) => String(value || '').replace(/\//g, '\\').toLowerCase();

  function options(config) {
    return Object.fromEntries(OPTION_KEYS.filter((key) => config[key] !== undefined)
      .map((key) => [key, config[key]]));
  }

  function parseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('请选择完整的起止日期');
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      throw new Error('日期无效');
    }
    return date;
  }

  function bounds(time = { mode: 'all' }, now = new Date()) {
    if (time.mode === 'all') return null;
    if (time.mode === 'custom') {
      const from = parseDate(time.start);
      const to = parseDate(time.end);
      if (from > to) throw new Error('开始日期不能晚于结束日期');
      to.setDate(to.getDate() + 1);
      return { from: from.getTime(), to: to.getTime() };
    }
    const months = Number(time.mode);
    if (!MONTHS.includes(months)) throw new Error('不支持的时间范围');
    const from = new Date(now);
    const day = from.getDate();
    from.setDate(1);
    from.setMonth(from.getMonth() - months);
    const lastDay = new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate();
    from.setDate(Math.min(day, lastDay));
    from.setHours(0, 0, 0, 0);
    return { from: from.getTime(), to: now.getTime() + 1 };
  }

  function filterItems(items, time, scopePaths = null, now = new Date()) {
    const range = bounds(time, now);
    let missingDates = 0;
    const paths = new Set();
    for (const item of items) {
      const path = normalize(item.filePath);
      if (scopePaths && !scopePaths.has(path)) continue;
      if (range) {
        const stamp = Number(item.importedAt);
        if (!Number.isFinite(stamp) || stamp <= 0) { missingDates += 1; continue; }
        if (stamp < range.from || stamp >= range.to) continue;
      }
      paths.add(path);
    }
    return { paths: !range && !scopePaths ? null : paths, missingDates, range };
  }

  // 只筛选已保存的片段，不解析搜索范围、不调用服务、不修改输入。
  function filterMatches(matches, time, itemForMatch, now = new Date()) {
    const range = bounds(time, now);
    if (!range) return matches.slice();
    return matches.filter((match) => {
      const stamp = Number(itemForMatch(match)?.importedAt);
      return Number.isFinite(stamp) && stamp > 0 && stamp >= range.from && stamp < range.to;
    });
  }

  function readTime(prefix = 'search-time') {
    const mode = document.getElementById(prefix).value;
    const time = mode === 'custom' ? {
      mode, start: document.getElementById(`${prefix}-start`).value,
      end: document.getElementById(`${prefix}-end`).value,
    } : { mode };
    bounds(time);
    return time;
  }

  function writeTime(time, prefix = 'search-time') {
    document.getElementById(prefix).value = time?.mode || 'all';
    document.getElementById(`${prefix}-start`).value = time?.start || '';
    document.getElementById(`${prefix}-end`).value = time?.end || '';
    document.getElementById(`${prefix}-dates`).classList.toggle('hidden', time?.mode !== 'custom');
  }

  function timeLabel(time) {
    if (!time || time.mode === 'all') return '不限时间';
    if (time.mode === 'custom') return `${time.start} 至 ${time.end}`;
    return Number(time.mode) === 6 ? '近半年' : `近 ${Number(time.mode) / 12} 年`;
  }

  async function resolveScope(scope, time) {
    let paths = null;
    if (scope.mode === 'folders' || scope.mode === 'exclude') {
      const ids = scope.folderIds || [];
      if (!ids.length) throw new Error('请选择搜索文件夹');
      const folders = await eagle.folder.getByIds(ids);
      if (ids.some((id) => !(folders || []).some((folder) => folder.id === id))) {
        throw new Error('保存的搜索文件夹已不存在，请编辑条件重新选择');
      }
      paths = await Bridge.pathSetFromFolderIds(ids);
    }
    const items = await Bridge.collectLibraryVideos();
    if (scope.mode === 'exclude') {
      paths = new Set(items.map((item) => normalize(item.filePath)).filter((path) => !paths.has(path)));
    }
    const result = filterItems(items, time, paths);
    if (result.missingDates) {
      // 时间全部不可用时拒绝刷新，避免因旧版 API 缺字段而清空仓库。
      const candidates = items.filter((item) => !paths || paths.has(normalize(item.filePath)));
      if (candidates.length === result.missingDates) {
        throw new Error('当前素材无法读取 Eagle 导入时间，请检查 Eagle 版本或改用“不限时间”');
      }
    }
    return result;
  }

  async function currentContext() {
    const config = { ...Config.get() };
    let scope = { mode: 'all' };
    if (config.scopeMode === 'selected') {
      const folders = await eagle.folder.getSelected();
      if (!folders?.length) throw new Error('请先在 Eagle 中选中要搜索的文件夹');
      scope = { mode: 'folders', folderIds: folders.map((f) => f.id), names: folders.map((f) => f.name) };
    } else if (config.scopeMode === 'custom' || config.scopeMode === 'exclude') {
      scope = { mode: config.scopeMode === 'exclude' ? 'exclude' : 'folders', folderIds: [...config.scopeFolderIds] };
    }
    const time = readTime();
    const library = eagle.library.path;
    const resolved = await resolveScope(scope, time);
    return { ...resolved, scope, time, library, config: options(config) };
  }

  function capture(kind, query, payload, context, threshold) {
    const config = options(context?.config || Config.get());
    if (threshold != null) config.threshold = threshold;
    return clone({ kind, query, payload, config,
      scope: context?.scope || { mode: 'all' },
      time: context?.time || { mode: 'all' },
      library: context?.library || eagle.library.path,
    });
  }

  async function persistSource(recipe) {
    const saved = clone(recipe);
    if (saved.payload?.image_path) {
      const fs = require('fs');
      if (fs.statSync(saved.payload.image_path).size > 8 * 1024 * 1024) {
        throw new Error('查询图片超过 8 MB，请使用较小图片后保存');
      }
      saved.payload.image_base64 = fs.readFileSync(saved.payload.image_path).toString('base64');
      delete saved.payload.image_path;
    }
    if (saved.payload?.image_base64 && saved.payload.image_base64.length > Math.ceil(8 * 1024 * 1024 / 3) * 4 + 100) {
      throw new Error('查询图片超过 8 MB，请使用较小图片后保存');
    }
    if (saved.payload?.video_path) {
      saved.sourceItemId = Bridge.itemForPath(saved.payload.video_path)?.id || saved.sourceItemId;
    }
    if (saved.payload?.source_video_path) {
      saved.sourceVideoItemId = Bridge.itemForPath(saved.payload.source_video_path)?.id || saved.sourceVideoItemId;
    }
    return saved;
  }

  async function resolve(recipe) {
    if (normalize(recipe.library) !== normalize(eagle.library.path)) throw new Error('请切换到主题所属的 Eagle 素材库');
    const resolved = await resolveScope(recipe.scope, recipe.time);
    const payload = clone(recipe.payload || {});
    // 固定截图已保存；源素材仅用于更新排除自身的路径，不是重放的必需文件。
    if (recipe.sourceVideoItemId) {
      const item = await eagle.item.getById(recipe.sourceVideoItemId);
      if (item && !item.isDeleted) payload.source_video_path = item.filePath;
    }
    if (recipe.sourceItemId) {
      const item = await eagle.item.getById(recipe.sourceItemId);
      if (!item || item.isDeleted) throw new Error('查询来源素材已失效，请重新选择来源后保存');
      payload.video_path = item.filePath;
    }
    if (payload.video_path && !require('fs').existsSync(payload.video_path)) {
      throw new Error('查询来源视频已失效，原结果仍保留');
    }
    return { ...resolved, payload };
  }

  return { options, bounds, filterItems, filterMatches, readTime, writeTime, timeLabel,
    currentContext, capture, persistSource, resolve, resolveScope, normalize, clone };
})();
