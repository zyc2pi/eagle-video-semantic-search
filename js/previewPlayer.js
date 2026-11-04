/* 预览播放器：卡片悬停小窗播放与预览面板的原视频加载、定位、停滞恢复及逐帧；结果渲染与详情由 Search 负责。 */
const PreviewPlayer = (() => {
  /*
   * el 为 Search 的同一个 DOM 引用对象（previewVideo / previewPanel / previewStatus / previewRetry），
   * 悬停接管时替换 el.previewVideo，双方读取的始终是当前播放器。
   */
  function create(el, { previewStartFrame }) {
    const hover = { video: null, box: null };
    let previewLoadToken = 0;     // 连续切换结果时废弃上一轮异步媒体事件
    let cancelPreviewLoad = () => {};

    function clearPreviewMediaEvents(video) {
      for (const name of ['loadedmetadata', 'seeking', 'seeked', 'timeupdate', 'playing', 'waiting', 'pause', 'ended', 'error', 'canplay', 'loadeddata', 'progress']) {
        video[`on${name}`] = null;
      }
    }

    /* ---------- 悬停自动播放（小窗静音循环该片段） ---------- */
    function stopHoverPreview() {
      if (hover.video) {
        clearPreviewMediaEvents(hover.video);
        hover.video.pause();
        hover.video.removeAttribute('src');
        hover.video.load();
        hover.video.remove();
        hover.video = null;
      }
      if (hover.box) {
        hover.box.classList.remove('hovering');
        hover.box = null;
      }
    }

    function startHoverPreview(box, m, isActive = false) {
      // 当前大预览已持有此片段，不再为同一张卡片创建第二个解码器。
      if (isActive) return;
      const item = Bridge.itemForPath(m.video_path);
      // 悬停仅尝试常用浏览器格式；其他格式点击后也只播放原文件，不转码。
      if (!item || !item.fileURL || !Bridge.isWebPlayable(item)) return;

      const fps = m.fps || 25;
      const startSec = previewStartFrame(m) / fps;
      const endSec = Math.max(m.end_frame / fps, startSec + 0.2);

      const v = document.createElement('video');
      v.className = 'hover-video';
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      let revealRequested = false;
      let located = false;
      let starting = false;

      const revealAfterPaint = () => {
        if (revealRequested || hover.video !== v) return;
        revealRequested = true;
        const reveal = () => {
          if (hover.video === v) v.classList.add('ready');
        };
        // loadeddata 只表示帧已解码；等待浏览器真正绘制后再盖住缩略图，消除黑闪。
        if (typeof v.requestVideoFrameCallback === 'function') {
          v.requestVideoFrameCallback(reveal);
        } else {
          requestAnimationFrame(reveal);
        }
      };

      const playFromScene = () => {
        if (hover.video !== v || starting || !located) return;
        starting = true;
        v.play().then(revealAfterPaint).catch((error) => {
          if (hover.video === v && error.name !== 'AbortError') stopHoverPreview();
        });
      };
      v.onloadedmetadata = () => {
        located = true;
        if (Math.abs(v.currentTime - startSec) >= 0.04) v.currentTime = startSec;
        playFromScene();
      };
      v.onseeked = () => { located = true; playFromScene(); };
      v.oncanplay = playFromScene;
      v.onprogress = playFromScene;
      v.onerror = () => {
        if (hover.video === v) stopHoverPreview();
      };
      v.ontimeupdate = () => {
        if (v.currentTime >= endSec) v.currentTime = startSec; // 片段内循环
      };
      box.appendChild(v);
      box.classList.add('hovering');
      hover.video = v;
      hover.box = box;
      v.src = item.fileURL;
    }

    function bindHover(box, m, isActive) {
      box.addEventListener('mouseenter', () => {
        stopHoverPreview();
        startHoverPreview(box, m, isActive(m));
      });
      box.addEventListener('mouseleave', stopHoverPreview);
    }

    /* ---------- 预览面板 ---------- */
    /* 取消上一轮加载，并接管同源的悬停播放器（包括在途加载），保留主播放器的音量/静音/速度。 */
    function prepare(item) {
      cancelPreviewLoad();
      const warmVideo = hover.video;
      let tookOver = false;
      if (warmVideo && item?.fileURL === warmVideo.getAttribute('src') && !warmVideo.error) {
        // 连正在加载的播放器一起接管，随后定位回片段开头，不重新加载源文件。
        tookOver = true;
        hover.video = null;
        const previous = el.previewVideo;
        clearPreviewMediaEvents(warmVideo);
        warmVideo.controls = true; warmVideo.muted = previous.muted;
        warmVideo.volume = previous.volume; warmVideo.playbackRate = previous.playbackRate;
        clearPreviewMediaEvents(previous);
        previous.pause(); previous.removeAttribute('src'); previous.load();
        warmVideo.id = 'preview-video'; warmVideo.className = '';
        previous.replaceWith(warmVideo);
        el.previewVideo = warmVideo;
      }
      stopHoverPreview();
      return tookOver;
    }

    /* 在 prepare 之后加载并播放片段；poster 为可用的卡片缩略图或 Eagle 缩略图。 */
    function start({ item, startSec, endSec, poster }) {
      const loadToken = ++previewLoadToken;
      const video = el.previewVideo;
      clearPreviewMediaEvents(video);
      video.pause();
      video.preload = 'auto';
      if (item?.fileURL && video.getAttribute?.('src') === item.fileURL && video.readyState >= 2 && !video.error) {
        // 已有解码画面时不再请求封面，避免抽帧请求干扰正在播放的源视频。
        video.removeAttribute('poster');
      } else {
        if (poster) video.poster = poster;
        else video.removeAttribute('poster');
      }

      const isCurrent = () => loadToken === previewLoadToken;
      let positioned = false;
      let pendingPlayback = true;
      let attempt = 0;
      let stallTimer = null;
      let bufferingTimer = null;
      let nativeReloaded = false;
      let locateNative = null;
      let lastPlaybackTime = null;
      let seekPending = false;
      const clearStallTimer = () => {
        if (stallTimer !== null) clearTimeout(stallTimer);
        stallTimer = null;
      };
      cancelPreviewLoad = () => {
        clearStallTimer();
        if (bufferingTimer !== null) clearTimeout(bufferingTimer);
        bufferingTimer = null;
        pendingPlayback = false;
        lastPlaybackTime = null;
        attempt += 1;
      };
      const setPreviewState = (state, message) => {
        if (!isCurrent()) return;
        if (bufferingTimer !== null) clearTimeout(bufferingTimer);
        bufferingTimer = null;
        el.previewPanel.dataset.state = state;
        el.previewStatus.textContent = message;
        el.previewStatus.hidden = !message;
        el.previewRetry.hidden = state !== 'error';
      };
      setPreviewState('loading', '正在加载预览…');
      const fail = (message = '无法直接播放原视频，请重试或在 Eagle 中打开素材。') => {
        if (!isCurrent()) return;
        cancelPreviewLoad();
        clearPreviewMediaEvents(video);
        video.pause();
        setPreviewState('error', message);
      };
      const watchForStall = () => {
        if (!isCurrent() || stallTimer !== null) return;
        const watchedAttempt = attempt;
        const timer = setTimeout(() => {
          if (!isCurrent() || watchedAttempt !== attempt || stallTimer !== timer) return;
          stallTimer = null;
          // 主线程繁忙时，超时可能先于积压的媒体事件执行；先复核真实状态。
          if (!pendingPlayback && (video.paused || video.ended)) {
            cancelPreviewLoad();
            setPreviewState('ready', '');
            return;
          }
          if (!pendingPlayback && !seekPending && !video.seeking && lastPlaybackTime !== null
            && video.currentTime > lastPlaybackTime) {
            lastPlaybackTime = video.currentTime;
            setPreviewState('ready', '');
            watchForStall();
            return;
          }
          if (!nativeReloaded && locateNative) {
            // 解码管线可能在接管/seek 后停住，仅重开原文件一次。
            nativeReloaded = true;
            attempt += 1;
            pendingPlayback = true;
            positioned = false;
            seekPending = false;
            lastPlaybackTime = null;
            video.pause();
            const reloadAttempt = attempt;
            video.onloadedmetadata = () => {
              if (!isCurrent() || attempt !== reloadAttempt) return;
              video.onloadedmetadata = locateNative;
              locateNative();
            };
            setPreviewState('native', '正在重新加载预览…');
            video.load();
            watchForStall();
          } else fail('原视频播放停滞，请重试或在 Eagle 中打开素材。');
        }, 1500);
        stallTimer = timer;
      };
      const playCurrent = () => {
        if (!isCurrent() || !pendingPlayback || !positioned) return;
        // play() 本身会等待浏览器缓冲，并驱动继续读取；额外门槛只会推迟起播。
        pendingPlayback = false;
        video.onloadedmetadata = null;
        video.oncanplay = null; video.onloadeddata = null; video.onprogress = null;
        const playingAttempt = attempt;
        video.play().then(() => {
          if (!isCurrent() || playingAttempt !== attempt) return;
          setPreviewState('ready', '');
        }).catch((error) => {
          if (!isCurrent() || playingAttempt !== attempt || error.name === 'AbortError') return;
          if (error.name === 'NotAllowedError') {
            clearStallTimer();
            setPreviewState('ready', '预览已就绪，请点击播放');
          }
          else fail();
        });
      };

      video.oncanplay = playCurrent; video.onloadeddata = playCurrent; video.onprogress = playCurrent;
      video.onseeking = () => {
        if (!isCurrent()) return;
        seekPending = true;
        lastPlaybackTime = null;
      };
      video.onseeked = () => {
        if (!isCurrent()) return;
        seekPending = false;
        lastPlaybackTime = video.currentTime;
        if (!pendingPlayback && !video.paused) watchForStall();
      };
      video.onplaying = () => {
        if (!isCurrent()) return;
        if (!pendingPlayback && !seekPending && !video.seeking) {
          if (lastPlaybackTime === null) lastPlaybackTime = video.currentTime;
          watchForStall();
          setPreviewState('ready', '');
        }
      };
      video.onwaiting = () => {
        if (isCurrent() && !video.paused) {
          if (!seekPending && !video.seeking && lastPlaybackTime === null) lastPlaybackTime = video.currentTime;
          if (bufferingTimer === null) {
            const noticeAttempt = attempt;
            const timer = setTimeout(() => {
              if (bufferingTimer !== timer) return;
              bufferingTimer = null;
              if (isCurrent() && attempt === noticeAttempt && !video.paused) setPreviewState('buffering', '正在缓冲预览…');
            }, 200);
            bufferingTimer = timer;
          }
          watchForStall();
        }
      };
      video.onpause = video.onended = () => {
        if (!isCurrent() || !video.paused || pendingPlayback) return;
        cancelPreviewLoad();
        setPreviewState('ready', '');
      };
      video.ontimeupdate = () => {
        if (!isCurrent()) return;
        // 只用定位后的正向播放进度续期，持续监测后续停帧，不把 seek 跳转计入。
        if (!pendingPlayback && !seekPending && !video.paused && !video.seeking
          && lastPlaybackTime !== null && video.currentTime > lastPlaybackTime) {
          lastPlaybackTime = video.currentTime;
          clearStallTimer();
          watchForStall();
          setPreviewState('ready', '');
        }
        if (video.currentTime >= endSec) video.pause();
      };

      if (item && item.fileURL) {
        setPreviewState('native', '正在加载源视频…');
        // Chromium 108 的 poster 失败也会向 video 派发 error，但不设置 MediaError。
        video.onerror = () => {
          if (!video.error) return;
          fail();
        };
        watchForStall();
        const locate = () => {
          if (!isCurrent() || video.onloadedmetadata !== locate) return;
          video.onloadedmetadata = null;
          if (Math.abs(video.currentTime - startSec) >= 0.04) {
            seekPending = true;
            video.currentTime = startSec;
          }
          lastPlaybackTime = video.currentTime;
          // 先发定位再 play；浏览器在定位完成后起播，同时驱动被暂停的预加载。
          positioned = true;
          playCurrent();
        };
        locateNative = locate;
        video.onloadedmetadata = locate;
        if (video.getAttribute?.('src') === item.fileURL && !video.error) {
          if (video.readyState >= 1) locate();
        } else video.src = item.fileURL;
      } else {
        fail('原视频已不在当前 Eagle 库中，请刷新结果。');
      }
    }

    /* 废弃当前加载代次；随后由 teardown 释放播放器并收起面板。 */
    function close() {
      cancelPreviewLoad();
      previewLoadToken += 1;
    }

    function teardown() {
      if (el.previewVideo) {
        clearPreviewMediaEvents(el.previewVideo);
        el.previewVideo.pause();
        el.previewVideo.removeAttribute('src');
        el.previewVideo.removeAttribute('poster');
        el.previewVideo.load();
        el.previewPanel.classList.add('hidden');
      }
    }

    async function captureFrame(match) {
      const token = previewLoadToken;
      const cover = await CoverFrame.capture(el.previewVideo, match);
      if (token !== previewLoadToken) throw new Error('预览素材已切换，请重新选择画面');
      return cover;
    }

    function stepFrame(match, direction) {
      const video = el.previewVideo;
      if (!match || video.readyState < 2 || video.seeking || video.error) {
        throw new Error('请等待视频加载或定位完成');
      }
      video.pause();
      cancelPreviewLoad();
      video.onloadedmetadata = null;
      video.oncanplay = null; video.onloadeddata = null; video.onprogress = null;
      video.currentTime = CoverFrame.stepTime(video.currentTime, direction, Number(match.fps) || 25, video.duration);
    }

    return { hover, clearPreviewMediaEvents, stopHoverPreview, startHoverPreview, bindHover,
      prepare, start, close, teardown, captureFrame, stepFrame, cancel: () => cancelPreviewLoad() };
  }

  return { create };
})();
