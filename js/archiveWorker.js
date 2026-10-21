/* Worker-only bundle processing. Resource decoding and JSON work stay outside
 * the Electron renderer; the store keeps its existing lock/atomic-write rules. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parentPort, workerData } = require('worker_threads');

try {
  if (!parentPort || !['export', 'import'].includes(workerData?.action)) throw new Error('仓库后台任务无效');
  const source = fs.readFileSync(path.join(workerData.root, 'js', 'archiveStore.js'), 'utf8');
  const context = { require };
  vm.runInNewContext(`${source}\nthis.archive = ArchiveStore;`, context, { filename: 'archiveStore.js' });
  const store = context.archive.open(workerData.root, workerData.library);
  const value = workerData.action === 'export' ? store.exportBundle()
    : store.importBundle(workerData.text, workerData.options);
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  if (parentPort) parentPort.postMessage({ ok: false, error: error.message || '仓库后台处理失败' });
  else throw error;
}
