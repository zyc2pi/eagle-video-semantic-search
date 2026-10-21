const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const calls = [];
const context = {
  Api: {
    listIndexJobs: async () => [],
    startIndex: async (...args) => {
      calls.push(args);
      return { ok: false, status: 500, data: { error: 'test stop' } };
    },
  },
  Bridge: {
    resolveLibraryIdentity: async () => ({ id: 'library', path: 'D:/library', index_name: 'library' }),
    collectLibraryVideos: async () => [{ filePath: 'D:/library/a.mp4' }],
    collectFolderVideos: async () => [{ filePath: 'D:/library/folder.mp4' }],
    collectSelectedVideos: async () => [{ filePath: 'D:/library/selected.mp4' }],
    indexNameForLibrary: () => 'library',
  },
  Config: { get: () => ({ modelName: 'model' }) },
  clearInterval,
  require,
  clearTimeout,
  setTimeout,
  console,
  setInterval,
};

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'indexer.js'), 'utf8');
vm.runInNewContext(`${source}\nthis.__Indexer = Indexer;`, context, { filename: 'indexer.js' });
const indexer = context.__Indexer;

async function main() {
  await indexer.start('all', {});
  assert.strictEqual(calls.at(-1)[4], true, '整库增量索引应清理失效路径');

  await indexer.start('folder', {});
  assert.strictEqual(calls.at(-1)[4], false, '文件夹索引不能清理其他路径');

  await indexer.start('selected', {});
  assert.strictEqual(calls.at(-1)[4], false, '选中素材索引不能清理其他路径');

  context.Bridge.collectLibraryVideos = async () => [];
  await indexer.start('all', {});
  assert.strictEqual(calls.at(-1)[0].length, 0, '空素材库仍应提交清理任务');
  assert.strictEqual(calls.at(-1)[4], true, '空素材库必须能清空全部失效路径');

  console.log('indexer stale-path cleanup contract tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
