const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const requests = [];
const context = {
  AbortController,
  clearTimeout,
  console,
  Config: {
    baseUrl: () => 'http://127.0.0.1:5006',
    get: () => ({
      aiEnhance: false,
      aiExpand: false,
      aiMode: 'balanced',
      dedup: false,
      dedupThreshold: 0.95,
      miniRerank: false,
      visualMargin: 15,
      visualAgg: 'mean',
      visualCentered: false,
      visualSceneFrames: 5,
      visualVideoFrames: 8,
      visualThreshold: 40,
      threshold: 11,
    }),
  },
  fetch: async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ success: true, matches: [] }) };
  },
  setTimeout,
};

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8');
vm.runInNewContext(`${source}\nthis.__Api = Api;`, context, { filename: 'api.js' });
const api = context.__Api;

async function main() {
  const scope = new Set(['D:/library/a.mp4', 'D:/library/b.mp4']);

  await api.search('猫', ['demo.lance'], 11, scope);
  assert.deepStrictEqual(
    Array.from(requests.at(-1).body.allowed_video_paths),
    Array.from(scope),
    '文本搜索应把 Eagle 范围传给后端',
  );

  await api.searchVisual({ image_path: 'D:/query.png' }, ['demo.lance'], 40, scope);
  assert.deepStrictEqual(
    Array.from(requests.at(-1).body.allowed_video_paths),
    Array.from(scope),
    '视觉搜索应把 Eagle 范围传给后端',
  );

  await api.searchHybrid('猫', { video_path: 'D:/query.mp4' }, ['demo.lance'], 11, scope);
  assert.deepStrictEqual(
    Array.from(requests.at(-1).body.allowed_video_paths),
    Array.from(scope),
    '混合搜索应把 Eagle 范围传给后端',
  );

  await api.search('猫', ['demo.lance'], 11, null);
  assert.strictEqual(
    Object.hasOwn(requests.at(-1).body, 'allowed_video_paths'),
    false,
    '全库搜索不应发送范围字段',
  );

  console.log('API search scope propagation tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
