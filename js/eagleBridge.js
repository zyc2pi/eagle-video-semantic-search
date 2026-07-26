/* Eagle 素材 ↔ 视频文件路径 桥接 */
const Bridge = (() => {
  // 与 create_video_index 的 supported_ext 保持一致
  const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv']);
  // <video> 标签可直接播放的格式，其余走 /get_clip 转码
  const WEB_PLAYABLE = new Set(['mp4', 'webm', 'mov']);
  // 可作为以图搜视频查询源的图片格式
  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff']);

  let pathMap = new Map(); // normalize(filePath) -> item

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

  /* 与 Python 侧 sanitize_name 对齐：保留字母数字（含中文）与 空格 . _ - */
  function sanitizeName(name) {
    const kept = Array.from(String(name || ''))
      .filter((c) => /[\p{L}\p{N} ._-]/u.test(c))
      .join('')
      .trim();
    return kept || 'Untitled';
  }

  function indexNameForLibrary() {
    const libPath = eagle.library.path || '';
    const libName = libPath.split(/[\\/]/).pop().replace(/\.library$/i, '');
    return `eagle_${sanitizeName(libName)}`;
  }

  async function collectLibraryVideos() {
    const items = await eagle.item.getAll();
    return items.filter(isVideoItem);
  }

  /* 递归收集文件夹及其所有子文件夹的 id */
  function collectFolderIdsRecursive(folders) {
    const ids = [];
    const walk = (f) => {
      if (!f || !f.id) return;
      ids.push(f.id);
      (f.children || []).forEach(walk);
    };
    (folders || []).forEach(walk);
    return ids;
  }

  /* 取选中文件夹（含子文件夹）内的所有视频素材，按 id 去重 */
  async function collectFolderVideos() {
    const folders = await eagle.folder.getSelected();
    if (!folders || folders.length === 0) return null;
    const ids = collectFolderIdsRecursive(folders);
    const items = await eagle.item.get({ folders: ids });
    const seen = new Set();
    return items.filter((it) => {
      if (!isVideoItem(it) || seen.has(it.id)) return false;
      seen.add(it.id);
      return true;
    });
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
    const items = await eagle.item.get({ folders: ids });
    return new Set(items.filter(isVideoItem).map((it) => normalizePath(it.filePath)));
  }

  async function collectSelectedVideos() {
    const items = await eagle.item.getSelected();
    if (!items || items.length === 0) return null;
    return items.filter(isVideoItem);
  }

  /* 搜索前刷新一次映射，供结果 video_path 反查 Eagle item */
  async function refreshPathMap() {
    const videos = await collectLibraryVideos();
    pathMap = new Map(videos.map((it) => [normalizePath(it.filePath), it]));
    return pathMap;
  }

  function itemForPath(videoPath) {
    return pathMap.get(normalizePath(videoPath)) || null;
  }

  async function locateInEagle(itemIds) {
    if (!itemIds || itemIds.length === 0) return;
    try {
      // 单素材定位：先把主窗口切到素材所在文件夹，否则 select 只改选中状态、
      // 当前视图看不到任何变化（多素材定位不跳转——它们可能分散在不同文件夹）
      if (itemIds.length === 1) {
        try {
          const item = await eagle.item.getById(itemIds[0]);
          const folderId = item && Array.isArray(item.folders) && item.folders.length
            ? item.folders[0] : null;
          if (folderId) {
            await eagle.folder.open(folderId);
            await new Promise((r) => setTimeout(r, 400)); // 等视图切换完成再选中
          }
        } catch (e) {
          console.warn('跳转素材所在文件夹失败，仅执行选中', e);
        }
      }
      if (typeof eagle.item.select === 'function') {
        await eagle.item.select(itemIds);
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
    sanitizeName,
    indexNameForLibrary,
    collectLibraryVideos,
    collectFolderVideos,
    collectSelectedVideos,
    collectFolderIdsRecursive,
    folderScopePathSet,
    getFolderTree,
    pathSetFromFolderIds,
    refreshPathMap,
    itemForPath,
    locateInEagle,
    isWebPlayable,
  };
})();
