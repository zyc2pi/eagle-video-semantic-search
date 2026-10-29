/* Eagle 素材 ↔ 视频文件路径 桥接 */
const Bridge = (() => {
  // 与 create_video_index 的 supported_ext 保持一致
  const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv']);
  // 悬停仅尝试这些常用格式；点击预览始终直接读取原文件。
  const WEB_PLAYABLE = new Set(['mp4', 'webm', 'mov']);
  // 可作为以图搜视频查询源的图片格式
  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff']);

  let pathMap = new Map(); // normalize(filePath) -> item
  let identity = null;
  let identityKey = '';
  let identityRequest = null;
  let videoCache = null;
  let videoRequest = null;

  async function resolveLibraryIdentity() {
    const libraryPath = eagle.library.path;
    if (!libraryPath) throw new Error('未打开素材库');
    const key = `${Config.baseUrl()}|${normalizePath(libraryPath)}`;
    if (identity && identityKey === key) return identity;
    if (identityRequest?.key === key) return identityRequest.promise;
    const promise = (async () => {
      const capabilities = await Api.healthInfo();
      if (!capabilities?.capabilities?.library_identity) throw new Error('搜索服务需要升级并重启，以支持安全素材库隔离');
      const result = await Api.resolveLibrary(libraryPath, libraryPath.split(/[\\/]/).filter(Boolean).pop());
      if (!result?.id || !result.index_name || normalizePath(libraryPath) !== normalizePath(eagle.library.path)
          || key !== `${Config.baseUrl()}|${normalizePath(eagle.library.path)}`) throw new Error('素材库或服务已切换，请重新操作');
      identity = { ...result, path: libraryPath }; identityKey = key;
      return identity;
    })();
    identityRequest = { key, promise };
    try { return await promise; } finally { if (identityRequest?.promise === promise) identityRequest = null; }
  }

  function invalidateCache() { videoCache = null; videoRequest = null; pathMap = new Map(); }

  function isVideoItem(item) {
    const ext = String(item.ext || '').toLowerCase().replace(/^\./, '');
    return VIDEO_EXTS.has(ext);
  }

  function isImageItem(item) {
    const ext = String(item.ext || '').toLowerCase().replace(/^\./, '');
    return IMAGE_EXTS.has(ext);
  }

  /* 按名称查找文件夹，不存在则创建（用于导出片段回导） */
  async function findOrCreateFolder(name) {
    const folders = await eagle.folder.getAll();
    const hit = folders.find((f) => f.name === name);
    if (hit) return hit.id;
    const created = await eagle.folder.create({ name });
    return created.id;
  }

  function normalizePath(p) {
    return String(p || '').replace(/\//g, '\\').toLowerCase();
  }

  /* 把一个或多个索引的覆盖清单映射回当前 Eagle 素材库。 */
  function summarizeIndexCoverage(videos, coverages) {
    const indexed = new Set();
    const skipped = new Set();
    const failed = new Set();
    const processed = new Set();
    (coverages || []).forEach((coverage) => {
      (coverage.indexedPaths || []).forEach((p) => indexed.add(normalizePath(p)));
      (coverage.skippedPaths || []).forEach((p) => skipped.add(normalizePath(p)));
      (coverage.failedPaths || []).forEach((p) => failed.add(normalizePath(p)));
      (coverage.processedPaths || []).forEach((p) => processed.add(normalizePath(p)));
    });
    indexed.forEach((p) => processed.add(p));
    skipped.forEach((p) => processed.add(p));
    failed.forEach((p) => processed.add(p));

    const currentPaths = new Set(
      (videos || []).map((video) => normalizePath(video.filePath)),
    );
    let staleCount = 0;
    processed.forEach((path) => {
      if (!currentPaths.has(path)) staleCount += 1;
    });

    let indexedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let missingCount = 0;
    (videos || []).forEach((video) => {
      const path = normalizePath(video.filePath);
      if (indexed.has(path)) indexedCount += 1;
      else if (skipped.has(path)) skippedCount += 1;
      else if (failed.has(path)) failedCount += 1;
      else if (!processed.has(path)) missingCount += 1;
    });
    return {
      indexed: indexedCount,
      skipped: skippedCount,
      failed: failedCount,
      missing: missingCount,
      stale: staleCount,
    };
  }

  /* 常驻工具栏只提醒真正尚未处理的新视频；跳过/失败只在本轮结束时提示一次。 */
  function indexHintText(coverage) {
    const missing = Number(coverage && coverage.missing) || 0;
    return missing > 0 ? `${missing} 个新视频未索引` : '';
  }

  function indexOutcomeDelta(coverage, previous, sameLibrary) {
    if (!sameLibrary) return { skipped: 0, failed: 0 };
    return {
      skipped: Math.max(0,
        (Number(coverage && coverage.skipped) || 0)
        - (Number(previous && previous.skipped) || 0)),
      failed: Math.max(0,
        (Number(coverage && coverage.failed) || 0)
        - (Number(previous && previous.failed) || 0)),
    };
  }

  /* 与 Python 侧 sanitize_name 对齐：保留字母数字（含中文）与 空格 . _ - */
  function sanitizeName(name) {
    const kept = Array.from(String(name || ''))
      .filter((c) => /[\p{L}\p{N} ._-]/u.test(c))
      .join('')
      .trim();
    return kept || 'Untitled';
  }

  function indexNameForLibrary() {
    if (!identity || identityKey !== `${Config.baseUrl()}|${normalizePath(eagle.library.path)}`) throw new Error('请先解析素材库身份');
    return identity.index_name;
  }

  async function collectLibraryVideos(force = false) {
    const library = normalizePath(eagle.library.path);
    if (!force && videoCache?.library === library && Date.now() - videoCache.time < 10000) return videoCache.items;
    if (videoRequest?.library === library) return videoRequest.promise;
    const promise = (async () => {
      const items = (await eagle.item.getAll()).filter(isVideoItem);
      if (normalizePath(eagle.library.path) !== library) throw new Error('素材库已切换，请重新操作');
      videoCache = { library, time: Date.now(), items };
      return items;
    })();
    videoRequest = { library, promise };
    try { return await promise; } finally { if (videoRequest?.promise === promise) videoRequest = null; }
  }

  /* 递归收集文件夹及其所有子文件夹的 id */
  function collectFolderIdsRecursive(folders) {
    const ids = [];
    const seen = new Set();
    const walk = (f) => {
      if (!f || !f.id || seen.has(f.id)) return;
      seen.add(f.id);
      ids.push(f.id);
      (f.children || []).forEach(walk);
    };
    (folders || []).forEach(walk);
    return ids;
  }

  /*
   * Eagle 会把 folders 数组当作交集条件。父、子文件夹 id 一次传入时，
   * 只会返回同时归属于所有文件夹的素材，通常就是空数组。逐文件夹查询后
   * 再按素材 id 取并集，才能同时包含本级和全部子文件夹。
   */
  async function collectItemsFromFolderIds(folderIds) {
    const groups = await Promise.all(
      (folderIds || []).map((folderId) => eagle.item.get({ folders: [folderId] })),
    );
    const seen = new Set();
    return groups.flat().filter((item) => {
      if (!item || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  /* 取选中文件夹（含子文件夹）内的所有视频素材，按 id 去重 */
  async function collectFolderVideos() {
    const folders = await eagle.folder.getSelected();
    if (!folders || folders.length === 0) return null;
    const ids = collectFolderIdsRecursive(folders);
    const items = await collectItemsFromFolderIds(ids);
    return items.filter(isVideoItem);
  }

  /**
   * 搜索范围限定：返回选中文件夹（含子文件夹）内视频的路径集合。
   * 没有选中文件夹时返回 null（由调用方提示用户）。
   */
  async function folderScopePathSet() {
    const videos = await collectFolderVideos();
    if (videos === null) return null;
    return new Set(videos.map((it) => normalizePath(it.filePath)));
  }

  function _withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时`)), ms)),
    ]);
  }

  /* Eagle 文件夹树（供范围选择器渲染）。
     不同 Eagle 版本返回结构有差异，按序兜底：
     1) library.info().folders（树形）
     2) folder.getAll()：children 是对象数组时取顶层；否则按 parent 字段组树 */
  async function getFolderTree() {
    try {
      const info = await _withTimeout(eagle.library.info(), 5000, 'library.info');
      const folders = info && (info.folders || (info.library && info.library.folders));
      if (Array.isArray(folders) && folders.length) {
        console.log(`[Scope] library.info 返回 ${folders.length} 个顶层文件夹`);
        return folders;
      }
    } catch (e) {
      console.warn('[Scope] library.info 失败:', e);
    }
    const all = await _withTimeout(eagle.folder.getAll(), 5000, 'folder.getAll');
    if (!Array.isArray(all) || all.length === 0) return [];
    console.log(`[Scope] folder.getAll 返回 ${all.length} 个文件夹`);

    const hasObjChildren = all.some(
      (f) => Array.isArray(f.children) && f.children.length && typeof f.children[0] === 'object');
    if (hasObjChildren) {
      const roots = all.filter((f) => !f.parent);
      return roots.length ? roots : all;
    }
    // 打平列表：按 parent 字段自行组树
    const byId = new Map(all.map((f) => [f.id, { id: f.id, name: f.name, children: [] }]));
    const roots = [];
    all.forEach((f) => {
      const node = byId.get(f.id);
      const parent = f.parent ? byId.get(f.parent) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    });
    return roots;
  }

  /* 按文件夹 id 列表（递归展开全部子文件夹）取视频路径集合 */
  async function pathSetFromFolderIds(folderIds) {
    if (!folderIds || folderIds.length === 0) return new Set();
    const folders = await eagle.folder.getByIds(folderIds);
    const ids = collectFolderIdsRecursive(folders || []);
    if (ids.length === 0) return new Set();
    const items = await collectItemsFromFolderIds(ids);
    return new Set(items.filter(isVideoItem).map((it) => normalizePath(it.filePath)));
  }

  async function collectSelectedVideos() {
    const items = await eagle.item.getSelected();
    if (!items || items.length === 0) return null;
    return items.filter(isVideoItem);
  }

  /* 搜索前刷新一次映射，供结果 video_path 反查 Eagle item */
  async function refreshPathMap(force = false) {
    const videos = await collectLibraryVideos(force);
    pathMap = new Map(videos.map((it) => [normalizePath(it.filePath), it]));
    return pathMap;
  }

  function itemForPath(videoPath) {
    return pathMap.get(normalizePath(videoPath)) || null;
  }

  // 只处理勾选片段对应的原素材；重复片段合并，失效素材单独计数。
  function selectionTargets(matches) {
    const ids = new Set();
    const missing = new Set();
    (matches || []).forEach((match) => {
      const item = itemForPath(match.video_path);
      if (item?.id) ids.add(item.id);
      else missing.add(normalizePath(match.video_path));
    });
    return { ids: [...ids], missing: missing.size };
  }

  // 多归属时只返回各分支中实际归属的最深层目录，不猜测文件夹顺序。
  async function smallestItemFolders(itemId) {
    const item = await eagle.item.getById(itemId);
    if (!item || item.isDeleted) throw new Error('素材已不在当前库中');
    const memberships = new Set(item.folders || []);
    if (!memberships.size) throw new Error('此素材未归入文件夹，无法排除所在文件夹');
    const roots = await getFolderTree();
    const folders = [];
    const visited = new Set();
    const walk = (folder, ancestors, names) => {
      if (!folder || visited.has(folder.id)) return;
      visited.add(folder.id);
      const path = [...names, folder.name || '(未命名)'];
      if (memberships.has(folder.id)) folders.push({ id: folder.id, path: path.join(' / '), ancestors });
      (folder.children || []).forEach((child) => walk(child, [...ancestors, folder.id], path));
    };
    roots.forEach((folder) => walk(folder, [], []));
    if ([...memberships].some((id) => !visited.has(id))) throw new Error('素材所属文件夹已失效，请刷新素材后重试');
    return folders.filter((folder) => !folders.some((other) => other.ancestors.includes(folder.id)))
      .map(({ id, path }) => ({ id, path }));
  }

  async function organizeItems(ids, kind, name, libraryPath, existingFolderId = null) {
    name = String(name || '').trim();
    if (!name) throw new Error('请输入名称');
    if (!['tag', 'folder'].includes(kind)) throw new Error('未知操作');
    const checkLibrary = () => {
      if (!libraryPath || normalizePath(eagle.library.path) !== normalizePath(libraryPath)) {
        throw new Error('素材库已切换，请重新搜索并选择素材');
      }
    };
    checkLibrary();
    const result = { success: 0, failed: 0, missing: 0, folderId: existingFolderId, items: [] };
    if (existingFolderId) {
      const folders = await eagle.folder.getByIds([existingFolderId]);
      if (!folders?.some((folder) => folder.id === existingFolderId)) throw new Error('原文件夹已删除，未创建重复文件夹；请关闭后重新操作');
    }
    const field = kind === 'tag' ? 'tags' : 'folders';
    for (const id of new Set(ids)) {
      let item;
      let previous;
      try {
        checkLibrary();
        item = await eagle.item.getById(id);
        checkLibrary();
        if (!item || item.isDeleted) {
          result.missing += 1; result.items.push({ id, name: item?.name || id, status: 'missing', reason: '素材不存在或已删除' }); continue;
        }
        if (kind === 'folder' && !result.folderId) {
          const folder = await eagle.folder.create({ name });
          if (!folder?.id) throw new Error('创建文件夹失败');
          result.folderId = folder.id;
        }
        checkLibrary();
        const value = kind === 'tag' ? name : result.folderId;
        previous = [...(item[field] || [])];
        if (!previous.includes(value)) {
          item[field] = [...previous, value];
          await item.save();
        }
        const cached = itemForPath(item.filePath);
        if (cached) cached[field] = [...item[field]];
        result.success += 1;
        result.items.push({ id, name: item.name || id, status: 'success' });
      } catch (error) {
        if (item && previous) item[field] = previous;
        result.failed += 1;
        result.items.push({ id, name: item?.name || id, status: 'failed', reason: error.message || '读取或保存失败' });
      }
    }
    return result;
  }

  async function locateInEagle(itemIds) {
    if (!itemIds || itemIds.length === 0) return;
    try {
      // 单素材定位：切到素材所在文件夹后选中。
      // 注意不能用 item.open()——它的"在完整列表中显示"是永远跳到"全部"视图，
      // 会覆盖文件夹上下文；而 Eagle 没有"文件夹视图内滚动到素材"的 API，
      // 只能靠选中高亮 + 延迟重选一次尽量触发列表滚动。
      if (itemIds.length === 1) {
        try {
          const item = await eagle.item.getById(itemIds[0]);
          const folderId = item && Array.isArray(item.folders) && item.folders.length
            ? item.folders[0] : null;
          if (folderId) {
            // 先选中再切文件夹：视图加载时带着已有选中项，更容易触发"滚动到选中"
            if (typeof eagle.item.select === 'function') {
              await eagle.item.select(itemIds).catch(() => {});
            }
            await eagle.folder.open(folderId);
            await new Promise((r) => setTimeout(r, 400)); // 等视图切换完成
          }
        } catch (e) {
          console.warn('跳转素材所在文件夹失败，仅执行选中', e);
        }
      }
      if (typeof eagle.item.select === 'function') {
        await eagle.item.select(itemIds);
        if (itemIds.length === 1) {
          // 列表可能尚未渲染完，稍后重选一次，尽量让 Eagle 滚动到选中项
          await new Promise((r) => setTimeout(r, 500));
          await eagle.item.select(itemIds);
        }
      } else {
        const item = await eagle.item.getById(itemIds[0]);
        if (item && typeof item.select === 'function') await item.select();
      }
      await eagle.app.show();
    } catch (e) {
      console.error('定位到 Eagle 失败', e);
      throw e;
    }
  }

  function isWebPlayable(item) {
    const ext = String(item.ext || '').toLowerCase().replace(/^\./, '');
    return WEB_PLAYABLE.has(ext);
  }

  return {
    VIDEO_EXTS,
    isVideoItem,
    isImageItem,
    findOrCreateFolder,
    normalizePath,
    summarizeIndexCoverage,
    indexHintText,
    indexOutcomeDelta,
    sanitizeName,
    indexNameForLibrary,
    resolveLibraryIdentity,
    invalidateCache,
    collectLibraryVideos,
    collectFolderVideos,
    collectSelectedVideos,
    collectFolderIdsRecursive,
    folderScopePathSet,
    getFolderTree,
    pathSetFromFolderIds,
    refreshPathMap,
    itemForPath,
    selectionTargets,
    smallestItemFolders,
    organizeItems,
    locateInEagle,
    isWebPlayable,
  };
})();
