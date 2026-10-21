const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture(lazy = true, observerAvailable = true) {
  const observers = [];
  const starts = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
  }
  class Image {
    constructor() { this.listeners = {}; }
    addEventListener(type, listener) { (this.listeners[type] ||= new Set()).add(listener); }
    removeEventListener(type, listener) { this.listeners[type]?.delete(listener); }
    set src(url) { this.url = url; starts.push(url); }
    fire(type) {
      const event = { type };
      this[`on${type}`]?.(event);
      for (const listener of [...(this.listeners[type] || [])]) listener(event);
    }
  }
  const context = { document: { addEventListener() {} }, console };
  if (observerAvailable) context.IntersectionObserver = Observer;
  vm.createContext(context);
  if (lazy) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/shortcuts.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(__dirname, '../js/search.js'), 'utf8')
    .replace('  return {\n    bindDom,', '  this.loader = ThumbLoader;\n  return {\n    bindDom,');
  vm.runInContext(source, context);
  const enter = (images) => observers[0]?.callback(images.map((target) => ({ target, isIntersecting: true })));
  return { loader: context.loader, Image, starts, enter, observers };
}

for (const lazy of [true, false]) {
  const f = fixture(lazy);
  const images = Array.from({ length: 20 }, () => new f.Image());
  images.forEach((image, i) => f.loader.load(image, `image-${i}`));
  if (lazy) assert.strictEqual(f.starts.length, 0, '离屏图不请求');
  f.enter(images);
  assert.strictEqual(f.starts.length, 6, '大量图片同时进入视口仍最多六个请求');
  let existingLoads = 0;
  images[0].addEventListener('load', () => existingLoads++);
  images[0].fire('load');
  assert.strictEqual(existingLoads, 1, '已有ready监听不被队列覆盖');
  assert.strictEqual(f.starts.length, 7, '完成释放一个槽位');
  images[0].fire('load');
  assert.strictEqual(f.starts.length, 7, '重复事件不重复释放');
}

{
  const f = fixture();
  const image = new f.Image();
  let fallbackCalls = 0;
  let removed = 0;
  f.loader.load(image, 'broken', () => {
    fallbackCalls++;
    f.loader.load(image, 'fallback', () => removed++);
  });
  f.enter([image]);
  image.fire('error');
  assert.strictEqual(fallbackCalls, 1, '首次失败调用回退');
  f.enter([image]);
  assert.deepStrictEqual(f.starts, ['broken', 'fallback']);
  image.fire('error');
  assert.strictEqual(removed, 1, '备用图失败只处理一次');
  image.fire('error');
  assert.strictEqual(removed, 1);
}

{
  const f = fixture();
  const oldImages = Array.from({ length: 12 }, () => new f.Image());
  let staleFallbacks = 0;
  oldImages.forEach((image, i) => f.loader.load(image, `old-${i}`, () => staleFallbacks++));
  f.enter(oldImages.slice(0, 10));
  f.loader.clear();
  const fresh = new f.Image();
  f.loader.load(fresh, 'fresh');
  f.enter([...oldImages, fresh]);
  assert.strictEqual(f.starts.length, 6, '换页时已开始请求继续占槽，清空不能产生超过六个请求');
  oldImages[0].fire('error');
  assert.strictEqual(staleFallbacks, 0, '换页不再触发旧页面备用图');
  assert.strictEqual(f.starts.at(-1), 'fresh');
  assert.strictEqual(f.starts.length, 7, '旧请求完成后正确启用新页请求');
}

{
  const f = fixture(true, false);
  f.loader.load(new f.Image(), 'eager');
  assert.deepStrictEqual(f.starts, ['eager'], '观察器不可用时安全降级');
}
console.log('thumbnail loader regression passed');
