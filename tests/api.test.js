const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const requests = [];
let supportsSmartFrames = true;
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
    requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, status: 200, json: async () => ({ success: true, matches: [],
      capabilities: { smart_frame_selection: supportsSmartFrames, content_adaptive_frames: supportsSmartFrames } }) };
  },
  setTimeout,
};

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8');
vm.runInNewContext(`${source}\nthis.__Api = Api;`, context, { filename: 'api.js' });
const api = context.__Api;

async function main() {
  const scope = new Set(['D:/library/a.mp4', 'D:/library/b.mp4']);

  await api.startIndex(['D:/library/a.mp4'], 'library', 'model', false, true);
  assert.strictEqual(requests.at(-1).body.options.frame_selection, 'triplet');
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

  const originalConfig = context.Config.get;
  context.Config.get = () => ({ ...originalConfig(), indexFrameSelection: 'dinov3_cses' });
  await api.startIndex(['D:/library/a.mp4'], 'library', 'model', false, false);
  assert.strictEqual(requests.at(-1).body.options.frame_selection, 'dinov3_cses');
  supportsSmartFrames = false;
  await assert.rejects(api.startIndex(['D:/library/a.mp4'], 'library', 'model'), /更新并重启/);
  assert(requests.at(-1).url.endsWith('/health'), '旧服务不支持时不能提交索引');
  supportsSmartFrames = true;
  context.Config.get = () => ({ ...originalConfig(), indexFrameSelection: 'content_adaptive', indexContentMaxFrames: 16 });
  await api.startIndex(['D:/library/a.mp4'], 'library', 'model');
  assert.strictEqual(requests.at(-1).body.options.frame_selection, 'content_adaptive');
  assert.strictEqual(requests.at(-1).body.options.content_max_frames, 16);
  supportsSmartFrames = false;
  await assert.rejects(api.startIndex(['D:/library/a.mp4'], 'library', 'model'), /更新并重启/);
  supportsSmartFrames = true;
  context.Config.get = originalConfig;

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

  for (const query of ['眨眼', '转身', '抬头', '相机穿梭', '推拉摇移']) {
    await api.search(query, ['demo.lance'], 11);
    assert.strictEqual(requests.at(-1).body.query, query);
    assert.strictEqual(requests.at(-1).body.threshold, 11);
    assert(!('temporal_search' in requests.at(-1).body), '动作词走普通搜索，不发送专项核验参数');
  }
  const originalFetch = context.fetch;
  context.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ success: true, capabilities: {} }) });
  await assert.rejects(api.prepareEditClip({}), /重启配套新版/);
  const clipBody = { video_path: 'D:/a.mp4', start_frame: 13, end_frame: 37, output_dir: 'D:/clips' };
  context.fetch = async (url, options) => {
    if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ capabilities: { edit_clip: true } }) };
    assert(url.endsWith('/api/v1/prepare_edit_clip'));
    assert.deepStrictEqual(JSON.parse(options.body), clipBody);
    return { ok: true, status: 200, json: async () => ({ success: true, output_path: 'D:/clips/a.mp4' }) };
  };
  assert.strictEqual((await api.prepareEditClip(clipBody)).output_path, 'D:/clips/a.mp4');
  context.fetch = originalFetch;
  console.log('API indexing, search propagation and editing clip capability tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
