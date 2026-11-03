/* 窗口尺寸与结果区布局：预览方式、素材详情宽度及顶部预览高度；偏好保存在 localStorage。 */
const LayoutPanels = (() => {
  const { $ } = Dom;

  async function initWindowSize() {
    if (typeof eagle.window?.setSize !== 'function') return;
    const preferenceKey = 'eagle-semantic-window-size';
    let restoring = true;
    let timer;
    let hasSavedSize = false;
    const save = () => {
      if (restoring || window.outerWidth < 800 || window.outerHeight < 560) return;
      try {
        localStorage.setItem(preferenceKey, JSON.stringify({ width: window.outerWidth, height: window.outerHeight }));
      } catch { /* 本次窗口尺寸仍保留，存储不可用时不阻断界面。 */ }
    };
    window.addEventListener('resize', () => {
      if (restoring) return;
      clearTimeout(timer);
      timer = setTimeout(save, 200);
    });
    window.addEventListener('beforeunload', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) || 'null');
      hasSavedSize = Number.isSafeInteger(saved?.width) && saved.width >= 800
        && Number.isSafeInteger(saved?.height) && saved.height >= 560;
      if (hasSavedSize) {
        const width = Math.max(800, Math.min(saved.width, screen.availWidth || saved.width));
        const height = Math.max(560, Math.min(saved.height, screen.availHeight || saved.height));
        await eagle.window.setSize(width, height);
      }
    } catch (error) { console.warn('窗口尺寸恢复失败', error.message); }
    finally { restoring = false; }
    if (!hasSavedSize) save();
  }

  function initPreviewLayout() {
    const workspace = document.querySelector('.result-workspace');
    const select = $('preview-layout');
    const preferenceKey = 'eagle-semantic-preview-layout';
    let layout = 'sidebar';
    try {
      if (localStorage.getItem(preferenceKey) === 'top') layout = 'top';
    } catch { /* 偏好不可用时使用右侧详情。 */ }
    const apply = () => {
      workspace.dataset.previewLayout = layout;
      select.value = layout;
      document.dispatchEvent(new CustomEvent('preview-layout-change'));
    };
    select.addEventListener('change', () => {
      layout = select.value === 'top' ? 'top' : 'sidebar';
      apply();
      try { localStorage.setItem(preferenceKey, layout); } catch { /* 保留会话选择。 */ }
    });
    apply();
  }

  function initInspectorResize() {
    const workspace = document.querySelector('.result-workspace');
    const inspector = $('inspector');
    const resizer = $('inspector-resizer');
    const preferenceKey = 'eagle-semantic-inspector-width';
    let preferredWidth = null;
    let drag = null;
    try {
      const saved = Number(localStorage.getItem(preferenceKey));
      if (Number.isFinite(saved) && saved >= 160 && saved <= 640) preferredWidth = saved;
    } catch { /* 偏好不可用时保留会话宽度。 */ }
    const bounds = () => {
      const max = Math.max(160, Math.min(640, workspace.clientWidth - 206));
      return { min: Math.min(220, max), max };
    };
    const applyWidth = () => {
      if (workspace.dataset.previewLayout === 'top') return;
      // 未选择片段时详情栏收起，宽度为 0；此时不记录宽度，展开后再计算。
      const current = inspector.getBoundingClientRect().width;
      if (preferredWidth === null && !current) return;
      if (preferredWidth === null) workspace.style.removeProperty('--inspector-width');
      const { min, max } = bounds();
      const width = Math.round(Math.max(min, Math.min(max, preferredWidth ?? inspector.getBoundingClientRect().width)));
      workspace.style.setProperty('--inspector-width', `${width}px`);
      resizer.setAttribute('aria-valuemin', String(min));
      resizer.setAttribute('aria-valuemax', String(max));
      resizer.setAttribute('aria-valuenow', String(width));
    };
    const saveWidth = () => {
      try { localStorage.setItem(preferenceKey, String(preferredWidth)); } catch { /* 保留会话宽度。 */ }
    };
    const finish = (event) => {
      if (!drag || (event.pointerId != null && drag.id !== event.pointerId)) return;
      const id = drag.id;
      drag = null;
      document.body.classList.remove('resizing-inspector');
      if (resizer.hasPointerCapture(id)) resizer.releasePointerCapture(id);
      saveWidth();
    };
    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      drag = { id: event.pointerId, x: event.clientX, width: inspector.getBoundingClientRect().width };
      preferredWidth = drag.width;
      resizer.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing-inspector');
    });
    resizer.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const { min, max } = bounds();
      preferredWidth = Math.max(min, Math.min(max, drag.width + drag.x - event.clientX));
      applyWidth();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((name) => resizer.addEventListener(name, finish));
    window.addEventListener('blur', finish);
    resizer.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const { min, max } = bounds();
      const step = event.shiftKey ? 40 : 10;
      preferredWidth = event.key === 'Home' ? min : event.key === 'End' ? max
        : Math.max(min, Math.min(max, inspector.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? step : -step)));
      applyWidth(); saveWidth();
    });
    const observer = new ResizeObserver(() => { if (workspace.clientWidth) applyWidth(); });
    observer.observe(workspace); observer.observe(inspector);
    document.addEventListener('preview-layout-change', applyWidth);
    applyWidth();
  }

  function initPreviewResize() {
    const workspace = document.querySelector('.result-workspace');
    const panel = $('preview-panel');
    const resizer = $('preview-resizer');
    const preferenceKey = 'eagle-semantic-preview-height';
    let preferredHeight = null;
    let drag = null;
    let frame = null;
    try {
      const saved = Number(localStorage.getItem(preferenceKey));
      if (Number.isFinite(saved) && saved >= 120 && saved <= 2000) preferredHeight = saved;
    } catch { /* 偏好不可用时保留会话高度。 */ }
    const bounds = () => {
      const fixed = ['view-bar', 'frame-query-reference', 'topic-removal-notice']
        .reduce((height, id) => height + $(id).getBoundingClientRect().height, 0);
      const max = Math.max(120, workspace.clientHeight - fixed - 206);
      return { min: Math.min(140, max), max };
    };
    const applyHeight = () => {
      if (workspace.dataset.previewLayout !== 'top' || !workspace.clientWidth || panel.classList.contains('hidden')) return;
      const { min, max } = bounds();
      workspace.dataset.previewSized = String(preferredHeight !== null);
      workspace.style.setProperty('--preview-max-height', `${preferredHeight === null ? Math.min(300, max) : max}px`);
      if (preferredHeight === null) workspace.style.removeProperty('--preview-height');
      else workspace.style.setProperty('--preview-height', `${Math.round(Math.max(min, Math.min(max, preferredHeight)))}px`);
      resizer.setAttribute('aria-valuemin', String(min)); resizer.setAttribute('aria-valuemax', String(max));
      resizer.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().height)));
    };
    const schedule = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = null; applyHeight(); });
    };
    const save = () => {
      try { localStorage.setItem(preferenceKey, String(Math.round(preferredHeight))); } catch { /* 保留会话高度。 */ }
    };
    const finish = (event) => {
      if (!drag || (event.pointerId != null && event.pointerId !== drag.id)) return;
      const id = drag.id; drag = null;
      document.body.classList.remove('resizing-preview');
      if (resizer.hasPointerCapture(id)) resizer.releasePointerCapture(id);
      save();
    };
    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      drag = { id: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height };
      preferredHeight = drag.height;
      resizer.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing-preview');
    });
    resizer.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const { min, max } = bounds();
      preferredHeight = Math.max(min, Math.min(max, drag.height + event.clientY - drag.y));
      applyHeight();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((name) => resizer.addEventListener(name, finish));
    window.addEventListener('blur', finish);
    resizer.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const { min, max } = bounds();
      preferredHeight = event.key === 'Home' ? min : event.key === 'End' ? max
        : Math.max(min, Math.min(max, panel.getBoundingClientRect().height + (event.key === 'ArrowDown' ? 1 : -1) * (event.shiftKey ? 40 : 10)));
      applyHeight(); save();
    });
    const observer = new ResizeObserver(schedule);
    observer.observe(workspace); observer.observe(panel);
    document.addEventListener('preview-change', (event) => { finish(event); schedule(); });
    document.addEventListener('preview-layout-change', (event) => { finish(event); schedule(); });
    schedule();
  }

  function init() {
    initWindowSize();
    initPreviewLayout();
    initInspectorResize();
    initPreviewResize();
  }

  return { init };
})();
