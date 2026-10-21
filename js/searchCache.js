/**
 * searchCache.js
 * 搜索结果缓存 - 减少重复查询
 *
 * 功能：
 * - 缓存最近的搜索结果（包括文本搜索和视觉搜索）
 * - 基于查询参数自动生成缓存键
 * - LRU 策略，自动清理最旧的缓存
 * - 支持手动清除缓存
 */

const SearchCache = (() => {
  const MAX_CACHE_SIZE = 50; // 最多缓存 50 个查询结果
  const MAX_CACHE_AGE_MS = 5 * 60 * 1000; // 外部更新的兼容兜底，读取不延长有效期
  const cache = new Map(); // key -> { results, timestamp, indexNames }
  const accessOrder = []; // LRU 顺序
  const crypto = require('crypto');
  const UNORDERED_FIELDS = new Set(['indexNames', 'index_names', 'allowedVideoPaths', 'allowed_video_paths']);

  // 仅候选范围为无序集合；帧列表等其他数组保持顺序，避免改变查询语义。
  function canonicalize(value, field = '') {
    if (Array.isArray(value)) {
      const entries = value.map(entry => canonicalize(entry));
      return UNORDERED_FIELDS.has(field)
        ? entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        : entries;
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort()
        .filter(key => value[key] !== undefined)
        .map(key => [key, canonicalize(value[key], key)]));
    }
    return value;
  }

  /**
   * 生成缓存键
   * @param {Object} params - 搜索参数
   * @returns {string} 缓存键
   */
  function makeKey(params) {
    // 完整参数包含查询种类、帧/图片内容、设置、库身份和候选范围。
    // 哈希后缓存键不会持有大幅 base64，也不会因分隔符或对象属性顺序碰撞。
    return crypto.createHash('sha256').update(JSON.stringify(canonicalize(params))).digest('hex');
  }

  /**
   * 获取缓存的搜索结果
   * @param {Object} params - 搜索参数
   * @returns {Array|null} 缓存的结果，如果不存在返回 null
   */
  function get(params) {
    const key = makeKey(params);
    const cached = cache.get(key);

    if (!cached) {
      return null;
    }
    if (Date.now() - cached.timestamp >= MAX_CACHE_AGE_MS) {
      cache.delete(key);
      const index = accessOrder.indexOf(key);
      if (index > -1) accessOrder.splice(index, 1);
      return null;
    }

    // 更新访问顺序（LRU）
    const index = accessOrder.indexOf(key);
    if (index > -1) {
      accessOrder.splice(index, 1);
    }
    accessOrder.push(key);

    return cached.results;
  }

  /**
   * 存储搜索结果到缓存
   * @param {Object} params - 搜索参数
   * @param {Array} results - 搜索结果
   */
  function set(params, results) {
    const key = makeKey(params);

    // 如果缓存已满，删除最旧的条目
    if (cache.size >= MAX_CACHE_SIZE && !cache.has(key)) {
      const oldestKey = accessOrder.shift();
      cache.delete(oldestKey);
    }

    cache.set(key, {
      results: results,
      timestamp: Date.now(),
      indexNames: [...(params.indexNames || params.index_names || [])]
    });

    // 更新访问顺序
    const index = accessOrder.indexOf(key);
    if (index > -1) {
      accessOrder.splice(index, 1);
    }
    accessOrder.push(key);
  }

  /**
   * 清除所有缓存
   */
  function clear() {
    cache.clear();
    accessOrder.length = 0;
  }

  /**
   * 清除特定索引相关的缓存
   * @param {string} indexName - 索引名称
   */
  function clearForIndex(indexName) {
    const keysToDelete = [];

    for (const [key, entry] of cache.entries()) {
      if (entry.indexNames.includes(indexName)) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => {
      cache.delete(key);
      const index = accessOrder.indexOf(key);
      if (index > -1) {
        accessOrder.splice(index, 1);
      }
    });
  }

  /**
   * 获取缓存统计信息
   * @returns {Object} 统计信息
   */
  function stats() {
    return {
      size: cache.size,
      maxSize: MAX_CACHE_SIZE,
      keys: Array.from(cache.keys())
    };
  }

  return {
    get,
    set,
    clear,
    clearForIndex,
    stats
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SearchCache;
}
