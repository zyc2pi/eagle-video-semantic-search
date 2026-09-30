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

console.log('搜索缓存测试全部通过');
