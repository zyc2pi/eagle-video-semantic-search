/* 全局快捷键系统 */
const Shortcuts = (() => {
  const handlers = new Map();
  let enabled = true;

  function normalize(key, modifiers = {}) {
    const parts = [];
    if (modifiers.ctrl || modifiers.meta) parts.push('ctrl');
    if (modifiers.shift) parts.push('shift');
    if (modifiers.alt) parts.push('alt');
    parts.push(key.toLowerCase());
    return parts.join('+');
  }

  function parseEvent(event) {
    const key = event.key.toLowerCase();
    const modifiers = {
      ctrl: event.ctrlKey || event.metaKey,
      shift: event.shiftKey,
      alt: event.altKey,
    };
    return { key, modifiers, normalized: normalize(key, modifiers) };
  }

  function register(shortcut, handler, options = {}) {
    const { description = '', preventDefault = true } = options;
    handlers.set(shortcut, { handler, description, preventDefault });
  }

  function unregister(shortcut) {
    handlers.delete(shortcut);
  }

  function handle(event) {
    if (!enabled) return;

    // 忽略输入框中的快捷键（除了 Escape 和 Enter）
    const target = event.target;
    const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

    if (isInput && !['escape', 'enter'].includes(event.key.toLowerCase())) {
      return;
    }

    const parsed = parseEvent(event);
    const entry = handlers.get(parsed.normalized);

    if (entry) {
      if (entry.preventDefault) {
        event.preventDefault();
        event.stopPropagation();
      }
      entry.handler(event);
    }
  }

  function enable() {
    enabled = true;
  }

  function disable() {
    enabled = false;
  }

  function getAll() {
    return Array.from(handlers.entries()).map(([shortcut, entry]) => ({
      shortcut,
      description: entry.description,
    }));
  }

  // 初始化全局监听
  document.addEventListener('keydown', handle, true);

  return { register, unregister, enable, disable, getAll };
})();

/* 防抖函数 */
function debounce(fn, delay) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/* 节流函数 */
function throttle(fn, delay) {
  let lastCall = 0;
  return function throttled(...args) {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      fn.apply(this, args);
    }
  };
}

/* 图片懒加载 */
const LazyLoad = (() => {
  let observer = null;
  const pending = new Map(); // element -> { url, onLoad }

  function init() {
    if (observer) return;

    observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          const data = pending.get(img);

          if (data) {
            img.src = data.url;
            if (data.onLoad) {
              img.onload = () => {
                data.onLoad();
                img.onload = null;
              };
            }
            pending.delete(img);
            observer.unobserve(img);
          }
        }
      });
    }, {
      rootMargin: '50px', // 提前 50px 开始加载
      threshold: 0.01
    });
  }

  function observe(img, url, onLoad) {
    init();
    pending.set(img, { url, onLoad });
    observer.observe(img);
  }

  function unobserve(img) {
    if (observer && img) {
      observer.unobserve(img);
      pending.delete(img);
    }
  }

  function clear() {
    if (observer) {
      pending.forEach((_, img) => observer.unobserve(img));
      pending.clear();
    }
  }

  return { observe, unobserve, clear };
})();
