/* 本次会话的人工收录/改分撤销；只保留存储层签发的 opaque token。 */
const TopicUndo = (() => {
  const MAX_STEPS = 20;
  const MAX_BYTES = 64 * 1024 * 1024;
  const normalize = value => String(value || '').replace(/\//g, '\\').toLowerCase();

  function create(options = {}) {
    const { getLibrary, onApplied, onChanged, checkIdle } = options;
    const openStore = options.openStore || options.store;
    if (typeof getLibrary !== 'function' || typeof openStore !== 'function') {
      throw new Error('撤销管理器缺少素材库或存储接口');
    }
    // 允许测试/宿主降低预算；调用方不能突破会话硬上限。
    const maxSteps = Number.isSafeInteger(options.maxSteps) && options.maxSteps > 0
      ? Math.min(MAX_STEPS, options.maxSteps) : MAX_STEPS;
    const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
      ? Math.min(MAX_BYTES, options.maxBytes) : MAX_BYTES;
    const histories = new Map();
    const seen = new WeakSet();
    let totalBytes = 0;
    let sequence = 0;
    let busy = false;

    function libraryKey() { return normalize(getLibrary()); }
    function currentHistory() { return histories.get(libraryKey()) || []; }
    function metadata(record) {
      return { library: record.library, targetId: record.targetId, targetName: record.targetName,
        label: record.label, beforeRevision: record.beforeRevision,
        expectedRevision: record.expectedRevision, updatedAt: record.updatedAt, bytes: record.bytes };
    }
    function peek() {
      const history = currentHistory();
      return history.length ? metadata(history[history.length - 1]) : null;
    }
    function canUndo() {
      if (busy) return false;
      try { return currentHistory().length > 0 && (!checkIdle || checkIdle() !== false); }
      catch { return false; }
    }
    function state() {
      const history = currentHistory();
      return { busy, canUndo: canUndo(), count: history.length,
        bytes: history.reduce((sum, record) => sum + record.bytes, 0), totalBytes, maxSteps, maxBytes };
    }
    function notify() {
      try { onChanged?.(); } catch { /* 展示失败不能改变已记录的写入事实。 */ }
    }
    function removeOldest(key) {
      const history = histories.get(key);
      if (!history?.length) return;
      totalBytes -= history.shift().bytes;
      if (!history.length) histories.delete(key);
    }

    function record(input = {}) {
      if (busy) return { recorded: false, reason: 'busy' };
      const entry = input.entry;
      const token = input.undoToken;
      if (!token) return { recorded: false, reason: 'empty' };
      const key = normalize(input.library);
      if (!key || key !== libraryKey()) return { recorded: false, reason: 'library' };
      if (typeof token !== 'object' || !entry || typeof entry.id !== 'string' || !entry.id
          || typeof entry.updatedAt !== 'string' || !entry.updatedAt
          || !Number.isSafeInteger(input.beforeRevision) || input.beforeRevision < 0
          || !Number.isSafeInteger(entry.revision) || entry.revision <= input.beforeRevision
          || !Number.isSafeInteger(input.undoBytes) || input.undoBytes < 0) {
        return { recorded: false, reason: 'invalid' };
      }
      if (seen.has(token)) return { recorded: false, reason: 'duplicate' };
      const item = { library: String(input.library), targetId: entry.id,
        targetName: String(input.targetName ?? entry.name ?? ''), label: String(input.label || '整理'),
        token, beforeRevision: input.beforeRevision, expectedRevision: entry.revision,
        updatedAt: entry.updatedAt, sequence: ++sequence };
      // undoBytes 已包含存储diff；额外计算本管理器持有的字符串和固定对象开销。
      item.bytes = input.undoBytes + 256 + 2 * (item.library.length + item.targetId.length
        + item.targetName.length + item.label.length + item.updatedAt.length);
      if (item.bytes > maxBytes) return { recorded: false, reason: 'capacity' };
      const history = histories.get(key) || [];
      history.push(item); histories.set(key, history); seen.add(token); totalBytes += item.bytes;
      while ((histories.get(key)?.length || 0) > maxSteps) removeOldest(key);
      while (totalBytes > maxBytes) {
        let oldestKey;
        let oldestSequence = Infinity;
        for (const [candidate, records] of histories) {
          if (records[0].sequence < oldestSequence) { oldestKey = candidate; oldestSequence = records[0].sequence; }
        }
        removeOldest(oldestKey);
      }
      notify();
      return { recorded: true };
    }

    function undo() {
      if (busy) throw new Error('正在撤销，请稍候');
      if (checkIdle && checkIdle() === false) throw new Error('已有操作正在进行，请稍候撤销');
      const key = libraryKey();
      const history = histories.get(key);
      if (!history?.length) return { undone: false, reason: 'empty' };
      const item = history[history.length - 1];
      busy = true; notify();
      try {
        const archive = openStore(item.library);
        if (key !== libraryKey()) throw new Error('素材库已切换，请切回原库后撤销');
        const result = archive.undoMatches(item.targetId, item.token, item.updatedAt, item.expectedRevision);
        // 存储同步成功后立即消费历史；后续展示出错不能再次提交已消费的token。
        history.pop(); totalBytes -= item.bytes;
        if (!history.length) histories.delete(key);
        const entry = result.entry;
        const previous = [...history].reverse().find(value => value.targetId === item.targetId);
        if (previous && previous.expectedRevision === item.beforeRevision
            && Number.isSafeInteger(entry?.revision) && entry.revision > item.expectedRevision
            && entry.updatedAt === item.updatedAt) {
          previous.expectedRevision = entry.revision;
        }
        const applied = { ...result, undone: true, record: metadata(item) };
        if (key === libraryKey()) {
          try { onApplied?.(entry, applied.record); }
          catch (error) { applied.refreshError = error; }
        }
        return applied;
      } finally { busy = false; notify(); }
    }

    function clear(scope = {}) {
      if (busy) throw new Error('正在撤销，请稍候');
      if (scope.all === true) { histories.clear(); totalBytes = 0; }
      else {
        const key = normalize(scope.library || getLibrary());
        for (const item of histories.get(key) || []) totalBytes -= item.bytes;
        histories.delete(key);
      }
      notify();
    }

    return { peek, canUndo, state, record, undo, clear };
  }
  return { create, MAX_STEPS, MAX_BYTES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TopicUndo;
