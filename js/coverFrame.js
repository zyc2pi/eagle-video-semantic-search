/* 将预览视频的当前画面保存为封面；帧号统一换算到源视频。 */
const CoverFrame = (() => {
  function sourceFrame(currentTime, fps, offsetFrame = 0) {
    if (!Number.isFinite(currentTime) || currentTime < 0 || !Number.isFinite(fps) || fps <= 0
        || !Number.isFinite(offsetFrame) || offsetFrame < 0) throw new Error('无法读取当前帧位置');
    return Math.max(0, Math.round(currentTime * fps) + Math.round(offsetFrame));
  }

  function stepTime(currentTime, direction, fps, duration) {
    if (!Number.isFinite(currentTime) || currentTime < 0 || !Number.isFinite(duration)
        || duration <= 0 || !Number.isFinite(fps) || fps <= 0) {
      throw new Error('请等待视频加载完成');
    }
    const frame = Math.round(currentTime * fps) + (direction < 0 ? -1 : 1);
    return Math.max(0, Math.min(frame / fps, Math.max(0, duration - 1 / fps)));
  }

  function jpegFrom(source, width, height) {
    if (!width || !height) throw new Error('当前画面尚未加载，请稍候再设置封面');
    const scale = Math.min(1, 960 / width, 540 / height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.88);
  }

  async function capture(video, match, offsetFrame = 0) {
    if (!match || video.readyState < 2 || video.seeking || !video.videoWidth || video.error) {
      throw new Error('请等待视频画面加载或拖动定位完成，再设置封面');
    }
    video.pause();
    const frame = sourceFrame(video.currentTime, Number(match.fps) || 25, offsetFrame);
    let dataUrl;
    try {
      dataUrl = jpegFrom(video, video.videoWidth, video.videoHeight);
    } catch (error) {
      // 某些 Electron 环境不允许直接读取跨来源视频画布，按源帧抽图兜底。
      if (error.name !== 'SecurityError') throw error;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let bitmap;
      try {
        const response = await fetch(Api.previewUrl(match.video_path, frame), { signal: controller.signal });
        if (!response.ok) throw new Error('当前帧读取失败，原封面未改变');
        bitmap = await createImageBitmap(await response.blob());
        dataUrl = jpegFrom(bitmap, bitmap.width, bitmap.height);
      } finally { clearTimeout(timeout); bitmap?.close(); }
    }
    return { dataUrl, frame, fps: Number(match.fps) || 25,
      eagleItemId: match.eagleItemId || Bridge.itemForPath(match.video_path)?.id || '',
      videoPath: match.video_path, videoName: match.video_name,
      selectedAt: new Date().toISOString() };
  }
  return { sourceFrame, stepTime, capture };
})();
