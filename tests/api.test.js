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

  await api.startIndex(['D:/library/a.mp4'], 'library', 'model', false, true);
  assert.strictEqual(requests.at(-1).body.resume, true, '普通整库索引应继续采用增量模式');
  assert.strictEqual(
    requests.at(-1).body.prune_missing,
    true,
    '整库增量索引必须请求清理已不在 Eagle 库中的旧路径',
  );

  await api.startIndex(['D:/library/a.mp4'], 'library', 'model', false, false);
  assert.strictEqual(
    requests.at(-1).body.prune_missing,
    false,
    '局部索引不能清理范围之外的素材路径',
  );

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

  const saved = { ...context.Config.get(), aiEnhance: true, dedup: true, visualMargin: 7 };
  await api.search('仓库主题', ['demo.lance'], 18, new Set(), saved);
  assert.strictEqual(requests.at(-1).body.ai_search_enabled, true, '仓库使用保存参数，而非当前配置');
  assert.strictEqual(requests.at(-1).body.use_dedup, true);
  assert.deepStrictEqual(Array.from(requests.at(-1).body.allowed_video_paths), []);
  await api.searchVisual({ image_base64: 'test' }, ['demo.lance'], 35, null, saved);
  assert.strictEqual(requests.at(-1).body.relative_margin, 7);
  const frame = { image_base64: 'data:image/jpeg;base64,test', source_video_path: 'D:/query.mp4', source_frame: 75 };
  await api.searchVisual(frame, ['demo.lance'], 40, scope, { ...saved, visualAgg: 'max' });
  assert.strictEqual(requests.at(-1).body.source_frame, 75);
  assert.strictEqual(requests.at(-1).body.scene_aggregation, 'max');
  assert.strictEqual(requests.at(-1).body.image_base64, frame.image_base64);
  await api.describeFrame(frame);
  assert(requests.at(-1).url.endsWith('/api/v1/describe'));
  assert.strictEqual(requests.at(-1).body.source_frame, 75);
  assert.strictEqual(requests.at(-1).body.image_base64, frame.image_base64);
  assert.strictEqual(requests.at(-1).body.keep_model, false);
  await api.searchHybrid('主题', { video_path: 'D:/query.mp4' }, ['demo.lance'], 18, null, saved);
  assert.strictEqual(requests.at(-1).body.relative_margin, 7);

  assert(api.isTemporalQuery('凌波丽眨眼'));
  assert(api.isTemporalQuery('相机穿梭'));
  assert(api.isTemporalQuery('推拉摇移'));
  assert(!api.isTemporalQuery('照相机镜头特写'));
  assert(!api.isTemporalQuery('没有眨眼'));
  await api.search('眨眼', ['demo.lance'], 11);
  assert.strictEqual(requests.at(-1).body.temporal_search, 'auto');
  await api.search('眼睛特写', ['demo.lance'], 11);
  assert.strictEqual(requests.at(-1).body.temporal_search, 'off');
  console.log('API indexing and search propagation tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
