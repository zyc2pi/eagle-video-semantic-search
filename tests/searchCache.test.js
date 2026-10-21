/* searchCache.test.js - 搜索缓存功能测试 */

const SearchCache = require('../js/searchCache.js');

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exit(1);
  }
}

// 测试：基本的缓存存取
test('基本的缓存存取', () => {
  SearchCache.clear();

  const params = { query: '测试查询', model: 'test-model', indexNames: ['index1'] };
  const results = [{ id: 1, name: '结果1' }, { id: 2, name: '结果2' }];

  // 首次获取应该返回 null
  assertEqual(SearchCache.get(params), null, '首次获取应该返回 null');

  // 存储结果
  SearchCache.set(params, results);

  // 再次获取应该返回缓存的结果
  assertEqual(SearchCache.get(params), results, '应该返回缓存的结果');
});

// 测试：不同参数生成不同的缓存键
test('不同参数生成不同的缓存键', () => {
  SearchCache.clear();

  const params1 = { query: '查询1', model: 'model1', indexNames: ['index1'] };
  const params2 = { query: '查询2', model: 'model1', indexNames: ['index1'] };
  const results1 = [{ id: 1 }];
  const results2 = [{ id: 2 }];

  SearchCache.set(params1, results1);
  SearchCache.set(params2, results2);

  assertEqual(SearchCache.get(params1), results1, '应该返回查询1的结果');
  assertEqual(SearchCache.get(params2), results2, '应该返回查询2的结果');
});

// 测试：LRU 清理策略
test('LRU 清理策略', () => {
  SearchCache.clear();

  // 创建大量缓存条目
  for (let i = 0; i < 55; i++) {
    const params = { query: `查询${i}`, model: 'test', indexNames: ['index1'] };
    SearchCache.set(params, [{ id: i }]);
  }

  const stats = SearchCache.stats();

  // 应该只保留最多 50 个
  if (stats.size > 50) {
    throw new Error(`缓存大小应该 <= 50，实际: ${stats.size}`);
  }

  // 最旧的条目应该被清理
  const oldestParams = { query: '查询0', model: 'test', indexNames: ['index1'] };
  assertEqual(SearchCache.get(oldestParams), null, '最旧的条目应该被清理');

  // 最新的条目应该仍然存在
  const newestParams = { query: '查询54', model: 'test', indexNames: ['index1'] };
  assertEqual(SearchCache.get(newestParams), [{ id: 54 }], '最新的条目应该仍然存在');
});

// 测试：清除所有缓存
test('清除所有缓存', () => {
  SearchCache.clear();

  const params1 = { query: '查询1', model: 'model', indexNames: ['index1'] };
  const params2 = { query: '查询2', model: 'model', indexNames: ['index1'] };

  SearchCache.set(params1, [{ id: 1 }]);
  SearchCache.set(params2, [{ id: 2 }]);

  SearchCache.clear();

  assertEqual(SearchCache.get(params1), null, '清除后应该返回 null');
  assertEqual(SearchCache.get(params2), null, '清除后应该返回 null');
  assertEqual(SearchCache.stats().size, 0, '缓存大小应该为 0');
});

// 测试：清除特定索引的缓存
test('清除特定索引的缓存', () => {
  SearchCache.clear();

  const params1 = { query: '查询1', model: 'model', indexNames: ['index1'] };
  const params2 = { query: '查询2', model: 'model', indexNames: ['index2'] };

  SearchCache.set(params1, [{ id: 1 }]);
  SearchCache.set(params2, [{ id: 2 }]);

  SearchCache.clearForIndex('index1');

  assertEqual(SearchCache.get(params1), null, 'index1 的缓存应该被清除');
  assertEqual(SearchCache.get(params2), [{ id: 2 }], 'index2 的缓存应该仍然存在');
});

// 测试：视觉搜索缓存
test('视觉搜索缓存', () => {
  SearchCache.clear();

  const params = {
    imagePath: '/path/to/image.jpg',
    model: 'clip-model',
    indexNames: ['visual-index']
  };
  const results = [{ id: 1, similarity: 0.95 }];

  SearchCache.set(params, results);
  assertEqual(SearchCache.get(params), results, '应该返回视觉搜索的缓存结果');
});

// 测试：缓存统计信息
test('缓存统计信息', () => {
  SearchCache.clear();

  const params1 = { query: '查询1', model: 'model', indexNames: ['index1'] };
  const params2 = { query: '查询2', model: 'model', indexNames: ['index1'] };

  SearchCache.set(params1, []);
  SearchCache.set(params2, []);

  const stats = SearchCache.stats();

  assertEqual(stats.size, 2, '缓存大小应该为 2');
  assertEqual(stats.maxSize, 50, '最大缓存大小应该为 50');

  if (stats.keys.length !== 2) {
    throw new Error(`keys 长度应该为 2，实际: ${stats.keys.length}`);
  }
});

test('完整搜索参数区分来源帧、图片、类型、设置及候选范围', () => {
  SearchCache.clear();
  const params = {
    kind: 'visual', query: '同一个视频', library: { libraryId: 'lib-1', path: 'D:/library' },
    payload: { video_path: 'D:/video.mp4', start_frame: 10, end_frame: 20,
      image_base64: 'frame-image-one', source_frame: 12 },
    config: { modelName: 'clip', visualThreshold: 40, visualScoreMode: 'max',
      visualCentering: false, threshold: 11, topK: 100, dedup: true },
    indexNames: ['index1'], allowedVideoPaths: null
  };
  const results = [{ id: 'original' }];
  SearchCache.set(params, results);
  const variants = [
    { kind: 'text' }, { kind: 'hybrid' }, { query: '其他关键词' },
    { payload: { ...params.payload, video_path: 'D:/other.mp4' } },
    { payload: { ...params.payload, start_frame: 11 } },
    { payload: { ...params.payload, end_frame: 21 } },
    { payload: { ...params.payload, source_frame: 13 } },
    { payload: { ...params.payload, image_base64: 'frame-image-two' } },
    { config: { ...params.config, visualThreshold: 41 } },
    { config: { ...params.config, visualScoreMode: 'mean' } },
    { config: { ...params.config, visualCentering: true } },
    { config: { ...params.config, threshold: 12 } },
    { config: { ...params.config, topK: 200 } },
    { config: { ...params.config, dedup: false } },
    { config: { ...params.config, modelName: 'fgclip2' } },
    { library: { ...params.library, libraryId: 'lib-2' } },
    { indexNames: ['index2'] }, { allowedVideoPaths: [] },
    { allowedVideoPaths: ['D:/video.mp4'] }
  ];
  variants.forEach((variant, i) => {
    assertEqual(SearchCache.get({ ...params, ...variant }), null, `参数变化 ${i} 不应命中缓存`);
  });
  assertEqual(SearchCache.get(params), results, '原参数仍应命中');
});

test('对象属性、索引和候选路径顺序不影响缓存且不修改输入', () => {
  SearchCache.clear();
  const params = {
    kind: 'visual', payload: { image_base64: 'same-image', source: { frame: 5, path: 'video' } },
    config: { threshold: 11, nested: { a: 1, b: 2 } },
    indexNames: Object.freeze(['index2', 'index1']),
    allowedVideoPaths: Object.freeze(['D:/b.mp4', 'D:/a.mp4'])
  };
  const original = JSON.stringify(params);
  SearchCache.set(params, [{ id: 1 }]);
  const reordered = {
    allowedVideoPaths: ['D:/a.mp4', 'D:/b.mp4'], indexNames: ['index1', 'index2'],
    config: { nested: { b: 2, a: 1 }, threshold: 11 },
    payload: { source: { path: 'video', frame: 5 }, image_base64: 'same-image' }, kind: 'visual'
  };
  assertEqual(SearchCache.get(reordered), [{ id: 1 }], '集合及属性重排应命中同一结果');
  assertEqual(JSON.stringify(params), original, '生成键不得排序或修改调用方参数');
});

test('普通数组保留查询顺序且零值与禁用设置参与键', () => {
  SearchCache.clear();
  const params = { payload: { frames: [1, 2] }, config: { threshold: 0, centering: false } };
  SearchCache.set(params, [{ id: 1 }]);
  assertEqual(SearchCache.get({ ...params, payload: { frames: [2, 1] } }), null, '查询帧顺序不得重排');
  assertEqual(SearchCache.get({ payload: params.payload, config: { centering: false } }), null, '零阈值不等于省略阈值');
  assertEqual(SearchCache.get({ payload: params.payload, config: { threshold: 0 } }), null, 'false 不等于省略');
});

test('缓存键只保存 SHA256，旧参数不存在分隔符碰撞', () => {
  SearchCache.clear();
  const imageUrl = `data:image/jpeg;base64,${'a'.repeat(100000)}`;
  SearchCache.set({ imageUrl }, []);
  const key = SearchCache.stats().keys[0];
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('缓存键必须是 SHA256 摘要');
  SearchCache.set({ query: 'foo|m:bar' }, [{ id: 1 }]);
  assertEqual(SearchCache.get({ query: 'foo', model: 'bar' }), null, '参数内容中的分隔符不能造成键碰撞');
  assertEqual(SearchCache.get({ imageUrl: imageUrl.replace(/a$/, 'b') }), null, '图片内容不同不得命中');
});

test('清除索引使用精确归属并保存独立索引快照', () => {
  SearchCache.clear();
  const params = { query: 'index1', indexNames: ['index1', 'index2'] };
  SearchCache.set(params, [{ id: 1 }]);
  const overlap = { query: 'index1', indexNames: ['index10'] };
  const queryOnly = { query: 'index1', indexNames: ['other'] };
  SearchCache.set(overlap, [{ id: 10 }]);
  SearchCache.set(queryOnly, [{ id: 'other' }]);
  params.indexNames.length = 0;
  SearchCache.clearForIndex('index1');
  assertEqual(SearchCache.get({ query: 'index1', indexNames: ['index1', 'index2'] }), null, '改变调用方数组后仍按原索引归属清除');
  assertEqual(SearchCache.get(overlap), [{ id: 10 }], 'index1 不应清除 index10');
  assertEqual(SearchCache.get(queryOnly), [{ id: 'other' }], '关键词中的索引名不影响清除');
});

test('命中和覆盖更新 LRU 顺序', () => {
  SearchCache.clear();
  for (let i = 0; i < 50; i++) SearchCache.set({ query: String(i) }, [i]);
  SearchCache.get({ query: '0' });
  SearchCache.set({ query: '1' }, ['updated']);
  SearchCache.set({ query: '50' }, [50]);
  assertEqual(SearchCache.get({ query: '2' }), null, '未访问的最旧条目应淘汰');
  assertEqual(SearchCache.get({ query: '0' }), [0], '命中的条目应保留');
  assertEqual(SearchCache.get({ query: '1' }), ['updated'], '覆盖更新的条目应保留');
  assertEqual(SearchCache.stats().size, 50, '覆盖不应额外占用容量');
});

test('缓存五分钟到期且读取不续期', () => {
  SearchCache.clear();
  const originalNow = Date.now;
  let now = 1000000;
  Date.now = () => now;
  try {
    const params = { query: 'ttl' };
    SearchCache.set(params, [{ id: 1 }]);
    now += 299999;
    assertEqual(SearchCache.get(params), [{ id: 1 }], '到期前可命中');
    now += 1;
    assertEqual(SearchCache.get(params), null, '到期时必须删除旧结果');
    assertEqual(SearchCache.stats().size, 0, '过期项释放容量');
  } finally { Date.now = originalNow; }
});

test('索引或服务变化不命中旧缓存', () => {
  SearchCache.clear();
  const params = { query: 'response', service: 'http://127.0.0.1:5006', indexRevisions: ['v1'] };
  const matches = [{ id: 1 }];
  SearchCache.set(params, matches);
  assertEqual(SearchCache.get(params), matches, '原服务与版本可命中');
  assertEqual(SearchCache.get({ ...params, indexRevisions: ['v2'] }), null, '索引版本改变必须重查');
  assertEqual(SearchCache.get({ ...params, service: 'http://127.0.0.1:5007' }), null, '服务改变必须重查');
});

console.log('搜索缓存测试全部通过');
