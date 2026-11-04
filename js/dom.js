/* 共用 DOM 工具：转义、提示、元素构建与图片懒加载，供各界面模块复用。 */
const Dom = (() => {
  const $ = (id) => document.getElementById(id);

  /* 外部字符串（文件名/标签/查询词）进 innerHTML 前必须转义 */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function toast(message, isError = false, ms = 3500) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = document.createElement('div');
    t.className = 'toast' + (isError ? ' error' : '');
    t.setAttribute('role', isError ? 'alert' : 'status');
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  /*
   * 构建元素，文本一律走 textContent，避免拼接 HTML。
   * h('button', { className: 'primary', type: 'button', onclick }, '保存')
   * props: className / text / dataset / style / attrs / on<事件>，其余按属性赋值。
   */
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style') Object.assign(node.style, value);
      else if (key === 'attrs') for (const [name, attr] of Object.entries(value)) node.setAttribute(name, attr);
      else if (/^on[a-z]/.test(key) && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node[key] = value;
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  /* 通用确认弹窗：body 为字符串或节点数组；确认返回 true，取消/Esc 返回 false。 */
  function confirmDialog({ title, body = [], confirmText = '确认', danger = false } = {}) {
    return new Promise((resolve) => {
      let result = false;
      const dialog = h('dialog', { className: 'warehouse-batch-dialog confirm-dialog' },
        h('h3', { text: title }),
        ...body.map((part) => (part instanceof Node ? part : h('p', { className: 'hint', text: part }))),
        h('div', { className: 'dialog-actions' },
          h('button', { type: 'button', text: '取消', onclick: () => dialog.close() }),
          h('button', { type: 'button', className: danger ? 'primary danger' : 'primary', text: confirmText,
            onclick: () => { result = true; dialog.close(); } })));
      dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
      document.body.appendChild(dialog);
      dialog.showModal();
      dialog.querySelector('.dialog-actions .primary').focus();
    });
  }

  return { $, esc, toast, h, confirm: confirmDialog };
})();

/* 图片懒加载：进入视口后再交给 ThumbLoader 入队。 */
const LazyLoad = (() => {
  let observer = null;
  const pending = new Map(); // element -> 入队函数；实际请求统一交给 ThumbLoader。

  function init() {
    if (observer || typeof IntersectionObserver === 'undefined') return;
    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const img = entry.target;
        const enqueue = pending.get(img);
        if (enqueue) {
          pending.delete(img);
          observer.unobserve(img);
          enqueue();
        }
      });
    }, {
      rootMargin: '50px', // 提前 50px 开始加载
      threshold: 0.01,
    });
  }

  function observe(img, enqueue) {
    init();
    if (!observer) { enqueue(); return; }
    pending.set(img, enqueue);
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
