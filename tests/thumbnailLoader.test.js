const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture(lazy = true, observerAvailable = true, network = false, limits = {}) {
  const observers = [];
  const starts = [];
  const requests = [];
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
  if (network) Object.assign(context, {
    AbortController, setTimeout, clearTimeout,
    fetch: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    FileReader: class {
      readAsDataURL(blob) { this.result = blob.data; this.onload(); }
    },
  });
  if (observerAvailable) context.IntersectionObserver = Observer;
  vm.createContext(context);
  if (lazy) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/shortcuts.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(__dirname, '../js/search.js'), 'utf8')
    .replace('let maxEntries = 5000;', `let maxEntries = ${limits.entries || 5000};`)
    .replace('let maxBytes = 128 * 1024 * 1024;', `let maxBytes = ${limits.bytes || 128 * 1024 * 1024};`)
    .replace('  return {\n    bindDom,', '  this.loader = ThumbLoader;\n  return {\n    bindDom,');
  vm.runInContext(source, context);
  const enter = (images) => observers[0]?.callback(images.map((target) => ({ target, isIntersecting: true })));
  const respond = async (request, data = 'data:image/jpeg;base64,original') => {
    request.resolve({ ok: true, blob: async () => ({ type: 'image/jpeg', data }) });
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { loader: context.loader, Image, starts, enter, observers, requests, respond };
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

async function cacheRegression() {
  const url = 'http://localhost/get_preview?video_path=library/a.mp4&frame=10';
  const f = fixture(true, true, true);
  const first = new f.Image();
  const duplicate = new f.Image();
  f.loader.load(first, url);
  f.loader.load(duplicate, url);
  assert.strictEqual(f.requests.length, 0, '未缓存的离屏图片不下载');
  f.enter([first, duplicate]);
  assert.strictEqual(f.requests.length, 1, '同一图片的并发读取合并');
  f.loader.clear();
  const nextPage = new f.Image();
  f.loader.load(nextPage, url);
  f.enter([nextPage]);
  assert.strictEqual(f.requests.length, 1, '换页复用尚未完成的请求');
  await f.respond(f.requests[0]);
  for (const img of [first, duplicate, nextPage]) img.fire('load');
  f.loader.clear();
  const revisit = new f.Image();
  f.loader.load(revisit, url);
  assert.strictEqual(revisit.url, first.url, '重复主题/搜索直接使用原图片数据，无需等待观察器');
  assert.strictEqual(f.requests.length, 1, '缓存命中不再访问服务');

  const otherFrame = new f.Image();
  const otherLibrary = new f.Image();
  const otherServer = new f.Image();
  f.loader.load(otherFrame, url + '0');
  f.loader.load(otherLibrary, url.replace('library/', 'other-library/'));
  f.loader.load(otherServer, url.replace('localhost', 'other-server'));
  f.enter([otherFrame, otherLibrary, otherServer]);
  assert.strictEqual(f.requests.length, 4, '帧号、库路径和服务地址不同不能串图');
  await Promise.all(f.requests.slice(1).map((r) => f.respond(r)));
  [otherFrame, otherLibrary, otherServer].forEach((img) => img.fire('load'));

  for (const limits of [{ entries: 2 }, { bytes: 260 }]) {
    const bounded = fixture(false, true, true, limits);
    for (const suffix of ['a', 'b']) {
      const img = new bounded.Image();
      bounded.loader.load(img, `http://image/${suffix}`);
      await bounded.respond(bounded.requests.at(-1));
      img.fire('load');
    }
    bounded.loader.load(new bounded.Image(), 'http://image/a');
    const third = new bounded.Image();
    bounded.loader.load(third, 'http://image/c');
    await bounded.respond(bounded.requests.at(-1));
    third.fire('load');
    const hot = new bounded.Image();
    bounded.loader.load(hot, 'http://image/a');
    assert(hot.url.startsWith('data:'), '常访问图片优先保留');
    const evicted = new bounded.Image();
    bounded.loader.load(evicted, 'http://image/b');
    assert.strictEqual(bounded.requests.length, 4, '条数/字节超限都淘汰最久未使用图片');
    await bounded.respond(bounded.requests.at(-1));
    evicted.fire('load');
  }

  const failed = fixture(false, true, true);
  let fallbacks = 0;
  const broken = new failed.Image();
  failed.loader.load(broken, url, () => fallbacks++);
  failed.requests[0].reject(new Error('offline'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(broken.url, url, 'fetch失败仍能走原生加载');
  broken.fire('error');
  assert.strictEqual(fallbacks, 1, '原生失败仍调用现有备用图逻辑');
  const retry = new failed.Image();
  failed.loader.load(retry, url);
  assert.strictEqual(failed.requests.length, 2, '失败不进入缓存，下次可重试');
  await failed.respond(failed.requests[1]);
  retry.fire('error');
  const badImageRetry = new failed.Image();
  failed.loader.load(badImageRetry, url);
  assert.strictEqual(failed.requests.length, 3, '无法解码的成功响应也不进入缓存');
  await failed.respond(failed.requests[2]);
  badImageRetry.fire('load');
  failed.loader.configure({ thumbnailCacheMaxEntries: 0, thumbnailCacheMaxMB: 128 });
  const disabled = new failed.Image();
  failed.loader.load(disabled, url);
  assert.strictEqual(disabled.url, url, '设为0立即清空缓存并恢复原生加载');
  disabled.fire('load');
  failed.loader.configure({ thumbnailCacheMaxEntries: 5000, thumbnailCacheMaxMB: 128 });
  const enabled = new failed.Image();
  failed.loader.load(enabled, url);
  assert.strictEqual(failed.requests.length, 4, '重新开启后恢复缓存读取');
  await failed.respond(failed.requests[3]);
  enabled.fire('load');
  failed.loader.configure({ thumbnailCacheMaxEntries: 5000, thumbnailCacheMaxMB: 0 });
  const zeroBytes = new failed.Image();
  failed.loader.load(zeroBytes, url);
  assert.strictEqual(zeroBytes.url, url, '内存上限设为0也立即清空缓存');
  zeroBytes.fire('load');
  console.log('thumbnail loader regression passed');
}
cacheRegression().catch((error) => { console.error(error); process.exitCode = 1; });
