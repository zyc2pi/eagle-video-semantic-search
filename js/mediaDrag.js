/* 原生文件拖出；准备片段保存在用户选择的长期目录。 */
const MediaDrag = (() => {
  const fs = require('fs');
  const path = require('path');
  const $ = (id) => document.getElementById(id);
  let hooks;
  let pending = false;
  let prepared = null;
  let generation = 0;

  function checkLibrary(library) {
    if (library !== eagle.library.path) throw new Error('素材库已切换，请重新选择素材');
  }

  function fileStamp(file) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || !stat.size) throw new Error('文件不存在或为空，请重新准备');
    return `${stat.size}:${stat.mtimeMs}`;
  }

  function sourcePath(match) {
    const item = Bridge.itemForPath(match.video_path);
    if (!item || (match.eagleItemId && item.id !== match.eagleItemId)) throw new Error('素材已失效，请刷新结果');
    fileStamp(item.filePath);
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
        beforeDrag?.();
        startDrag([...unique.values()]);
      } catch (error) { hooks.toast(error.message, true); }
    });
    element.addEventListener('click', (event) => {
      if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; }
    }, true);
  }

  function sync() {
    const active = Search.getActiveMatch();
    const ready = prepared && prepared.match === active && prepared.library === eagle.library.path;
    $('btn-prepare-clip').disabled = pending || !active;
    $('btn-prepare-clip').textContent = pending ? '准备中…' : '准备片段';
    $('btn-drag-clip').disabled = !ready;
    $('btn-drag-clip').draggable = !!ready;
    $('btn-drag-clip').title = ready ? `按住拖到 PR / AE：${prepared.output}` : '先准备当前片段，再按住此按钮拖出';
    $('btn-clip-directory').disabled = pending;
    $('btn-clip-directory').title = Config.get().editClipDirectory || '选择长期保存目录；生成文件不会自动清理';
  }

  async function chooseDirectory() {
    const library = eagle.library.path;
    const result = await eagle.dialog.showOpenDialog({ title: '选择剪辑片段的长期保存目录',
      defaultPath: Config.get().editClipDirectory || undefined, properties: ['openDirectory'] });
    checkLibrary(library);
    if (result.canceled || !result.filePaths?.length) return null;
    const directory = result.filePaths[0];
    checkDirectory(directory, library);
    Config.save({ editClipDirectory: directory });
    prepared = null;
    sync();
    return directory;
  }

  function checkDirectory(directory, library) {
    const relative = path.relative(path.resolve(library), path.resolve(directory));
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('请选择 Eagle 素材库之外的目录');
    }
  }

  async function prepare() {
    if (pending) return;
    const match = Search.getActiveMatch();
    if (!match) return;
    const library = eagle.library.path;
    const token = generation;
    pending = true;
    prepared = null;
    sync();
    try {
      const source = sourcePath(match);
      const stamp = fileStamp(source);
      const directory = Config.get().editClipDirectory || await chooseDirectory();
      if (!directory || token !== generation) return;
      checkLibrary(library);
      checkDirectory(directory, library);
      const result = await Api.prepareEditClip({ video_path: source, output_dir: directory,
        start_frame: match.original_start_frame ?? match.start_frame,
        end_frame: match.original_end_frame ?? match.end_frame });
      if (token !== generation || library !== eagle.library.path) {
        hooks.toast(`片段已保存到 ${result.output_path}；请回到原片段重新准备以拖出`, false, 7000);
        return;
      }
      if (fileStamp(source) !== stamp) throw new Error('源视频已变化，请重新准备');
      const outputStamp = fileStamp(result.output_path);
      prepared = { match, library, source, stamp, output: result.output_path, outputStamp };
      hooks.toast('片段已就绪，按住「拖出片段」拖到 PR / AE；文件将长期保留', false, 6000);
    } catch (error) { hooks.toast(`准备失败：${error.message}`, true, 7000); }
    finally { pending = false; sync(); }
  }

  function init(options) {
    hooks = options;
    $('btn-prepare-clip').addEventListener('click', prepare);
    $('btn-clip-directory').addEventListener('click', () => chooseDirectory().catch((error) => hooks.toast(error.message, true)));
    $('btn-drag-clip').addEventListener('click', () => hooks.toast('请按住此按钮并拖到 PR / AE 项目面板'));
    $('btn-drag-clip').addEventListener('dragstart', (event) => {
      event.preventDefault(); event.stopPropagation();
      try {
        if (!prepared || prepared.match !== Search.getActiveMatch()) throw new Error('请先准备当前片段');
        checkLibrary(prepared.library);
        if (sourcePath(prepared.match) !== prepared.source || fileStamp(prepared.source) !== prepared.stamp
            || fileStamp(prepared.output) !== prepared.outputStamp) throw new Error('文件已变化，请重新准备片段');
        startDrag([prepared.output]);
      } catch (error) { prepared = null; sync(); hooks.toast(error.message, true); }
    });
    document.addEventListener('preview-change', () => { generation += 1; prepared = null; sync(); });
    sync();
  }

  return { init, bindOriginal };
})();
