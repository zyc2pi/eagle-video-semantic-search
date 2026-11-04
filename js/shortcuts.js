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
    // 弹窗打开时只保留 Esc，避免在弹窗背后启动索引或切换页面。
    if (document.querySelector('dialog[open]') && event.key.toLowerCase() !== 'escape') return;

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
