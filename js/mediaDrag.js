/* 缩略图原生拖出完整原视频；已选素材按路径去重。 */
const MediaDrag = (() => {
  const fs = require('fs');
  let hooks;

  function checkLibrary(library) {
    if (library !== eagle.library.path) throw new Error('素材库已切换，请重新选择素材');
  }

  function checkFile(file) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || !stat.size) throw new Error('原视频不存在或为空，请刷新结果');
  }

  function sourcePath(match) {
    const item = Bridge.itemForPath(match.video_path);
    if (!item || (match.eagleItemId && item.id !== match.eagleItemId)) throw new Error('素材已失效，请刷新结果');
    return item.filePath;
  }

  function startDrag(paths) {
    if (!eagle.drag?.startDrag) throw new Error('当前 Eagle 不支持原生文件拖拽，请升级 Eagle');
    // 在原生 dragstart 中直接调用，不等待网络或异步文件读取。
    Promise.resolve(eagle.drag.startDrag(paths)).catch((error) => hooks.toast(`拖出失败：${error.message}`, true));
  }

  function bindOriginal(element, getMatches, beforeDrag) {
    const library = eagle.library.path;
    element.draggable = true;
    element.title = '按住拖出原视频；已勾选时批量拖出（同视频去重）';
    let suppressClick = false;
    element.addEventListener('dragstart', (event) => {
      event.preventDefault();
      event.stopPropagation();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 500);
      try {
        checkLibrary(library);
        const unique = new Map();
        for (const match of getMatches() || []) {
          const file = sourcePath(match);
          unique.set(Bridge.normalizePath(file), file);
        }
        if (!unique.size) throw new Error('没有可拖出的素材');
        for (const file of unique.values()) checkFile(file);
        beforeDrag?.();
        startDrag([...unique.values()]);
      } catch (error) { hooks.toast(error.message, true); }
    });
    element.addEventListener('click', (event) => {
      if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; }
    }, true);
  }

  function init(options) {
    hooks = options;
  }

  return { init, bindOriginal };
})();
