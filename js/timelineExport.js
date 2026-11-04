/* 时间线导出：把片段按原视频入出点写成 FCP7 XML（xmeml v4），供 Premiere / DaVinci Resolve 直接导入，不转码。 */
const TimelineExport = (() => {
  const { esc, h, toast } = Dom;

  // 常见 NTSC 帧率用整数 timebase + ntsc 标记表示，其余按四舍五入的整数帧率。
  function rateOf(fps) {
    const value = Number(fps) > 0 ? Number(fps) : 25;
    const timebase = Math.round(value);
    const ntsc = Math.abs(value - timebase * 1000 / 1001) < 0.01 && timebase !== value;
    return { fps: value, timebase, ntsc };
  }

  function rateXml(rate) {
    return `<rate><timebase>${rate.timebase}</timebase><ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  }

  function pathUrl(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');
    const encoded = normalized.split('/').map((part, index) => (index === 0 && /^[a-z]:$/i.test(part)
      ? part : encodeURIComponent(part))).join('/');
    return `file://localhost/${encoded.replace(/^\/+/, '')}`;
  }

  /* 按片段原始帧边界生成剪辑项；end_frame 为包含帧，xmeml 的 out 为不包含帧。 */
  function clipsFor(matches) {
    const files = new Map();
    const clips = [];
    for (const match of matches) {
      const item = Bridge.itemForPath(match.video_path);
      const filePath = item?.filePath || match.video_path;
      if (!filePath) continue;
      const rate = rateOf(match.fps);
      const start = Math.max(0, Math.round(Number(match.original_start_frame ?? match.start_frame) || 0));
      const end = Math.max(start, Math.round(Number(match.original_end_frame ?? match.end_frame) || start));
      const sourceFrames = Number(item?.duration) > 0 ? Math.ceil(Number(item.duration) * rate.fps) : end + 1;
      const key = SearchRecipe.normalize(filePath);
      if (!files.has(key)) {
        files.set(key, { id: `file-${files.size + 1}`, filePath, rate, duration: Math.max(sourceFrames, end + 1),
          name: item?.name ? `${item.name}${item.ext ? `.${item.ext}` : ''}` : filePath.split(/[\\/]/).pop(),
          width: item?.width, height: item?.height });
      } else files.get(key).duration = Math.max(files.get(key).duration, end + 1);
      clips.push({ file: files.get(key), rate, inFrame: start, outFrame: end + 1,
        name: match.video_name || files.get(key).name });
    }
    return clips;
  }

  function buildXml(matches, { name = '语义搜索片段', audio = true } = {}) {
    const clips = clipsFor(matches);
    if (!clips.length) throw new Error('所选片段没有可导出的原视频');
    const sequenceRate = clips[0].rate;
    let cursor = 0;
    const placed = clips.map((clip, index) => {
      const length = Math.max(1, Math.round((clip.outFrame - clip.inFrame) / clip.rate.fps * sequenceRate.fps));
      const placedClip = { ...clip, index: index + 1, start: cursor, end: cursor + length };
      cursor += length;
      return placedClip;
    });
    const declared = new Set();
    const fileXml = (clip) => {
      const { file } = clip;
      if (declared.has(file.id)) return `<file id="${file.id}"/>`;
      declared.add(file.id);
      const size = file.width > 0 && file.height > 0
        ? `<samplecharacteristics><width>${file.width}</width><height>${file.height}</height></samplecharacteristics>` : '';
      return `<file id="${file.id}"><name>${esc(file.name)}</name><pathurl>${esc(pathUrl(file.filePath))}</pathurl>`
        + `${rateXml(file.rate)}<duration>${file.duration}</duration>`
        + `<media><video>${size}</video>${audio ? '<audio><channelcount>2</channelcount></audio>' : ''}</media></file>`;
    };
    const clipItem = (clip, kind) => `<clipitem id="${kind}-${clip.index}"><name>${esc(clip.name)}</name>`
      + `<duration>${clip.file.duration}</duration>${rateXml(clip.rate)}`
      + `<start>${clip.start}</start><end>${clip.end}</end><in>${clip.inFrame}</in><out>${clip.outFrame}</out>`
      + fileXml(clip)
      + (kind === 'audio' ? '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>' : '')
      + (audio ? `<link><linkclipref>video-${clip.index}</linkclipref><mediatype>video</mediatype></link>`
        + `<link><linkclipref>audio-${clip.index}</linkclipref><mediatype>audio</mediatype></link>` : '')
      + '</clipitem>';
    const videoTrack = `<track>${placed.map((clip) => clipItem(clip, 'video')).join('')}</track>`;
    const audioTrack = audio ? `<track>${placed.map((clip) => clipItem(clip, 'audio')).join('')}</track>` : '';
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">'
      + `<sequence id="sequence-1"><name>${esc(name)}</name><duration>${cursor}</duration>${rateXml(sequenceRate)}`
      + `<media><video>${videoTrack}</video><audio>${audioTrack}</audio></media></sequence></xmeml>\n`;
  }

  function safeFileName(name) {
    return String(name || '语义搜索片段').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || '语义搜索片段';
  }

  async function saveText(fileName, text) {
    if (typeof eagle !== 'undefined' && typeof eagle.dialog?.showSaveDialog === 'function') {
      const result = await eagle.dialog.showSaveDialog({ defaultPath: fileName,
        filters: [{ name: 'FCP7 XML（Premiere / DaVinci）', extensions: ['xml'] }] });
      if (result?.canceled || !result?.filePath) return null;
      await require('fs').promises.writeFile(result.filePath, text, 'utf8');
      return result.filePath;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/xml' }));
    const link = h('a', { href: url, download: fileName });
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return fileName;
  }

  /* 入口：确认片段数量与音频选项后保存。matches 按当前显示顺序排列。 */
  async function exportMatches(matches, name) {
    if (!matches?.length) { toast('没有可导出的片段', true); return; }
    const audio = h('input', { type: 'checkbox', checked: true });
    const confirmed = await Dom.confirm({
      title: '导出时间线',
      body: [
        `将按当前顺序把 ${matches.length} 个片段写入 FCP7 XML，记录原视频路径及入出点，不生成新视频。`,
        'Premiere：文件 → 导入；DaVinci Resolve：文件 → 导入 → 时间线。素材移动后需在剪辑软件中重新链接。',
        h('label', { className: 'scope-toggle' }, audio, ' 同时导入音频轨（无音轨的素材在剪辑软件中可能显示为离线音频）'),
      ],
      confirmText: '选择保存位置',
    });
    if (!confirmed) return;
    try {
      const xml = buildXml(matches, { name: name || '语义搜索片段', audio: audio.checked });
      const saved = await saveText(`${safeFileName(name)}.xml`, xml);
      if (saved) toast(`已导出 ${matches.length} 个片段的时间线：${saved}`, false, 6000);
    } catch (error) { toast(`导出失败：${error.message}`, true, 6000); }
  }

  return { exportMatches, buildXml };
})();
