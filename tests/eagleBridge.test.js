const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBridge(eagle) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'eagleBridge.js'),
    'utf8',
  );
  const context = vm.createContext({
    console,
    eagle,
    setTimeout,
  });
  vm.runInContext(`${source}\nglobalThis.__bridge = Bridge;`, context);
  return context.__bridge;
}

function createEagleMock() {
  const parentFolder = {
    id: 'parent',
    name: '一级文件夹',
    children: [
      {
        id: 'child',
        name: '二级文件夹',
        children: [
          { id: 'grandchild', name: '三级文件夹', children: [] },
        ],
      },
    ],
  };
  const items = [
    {
      id: 'parent-video',
      ext: 'mp4',
      filePath: 'D:\\library\\parent.mp4',
      folders: ['parent'],
    },
    {
      id: 'child-video',
      ext: 'mov',
      filePath: 'D:\\library\\child.mov',
      folders: ['child'],
    },
    {
      id: 'grandchild-video',
      ext: 'mkv',
      filePath: 'D:\\library\\grandchild.mkv',
      folders: ['grandchild'],
    },
    {
      id: 'shared-video',
      ext: 'webm',
      filePath: 'D:\\library\\shared.webm',
      folders: ['parent', 'child'],
    },
    {
      id: 'parent-image',
      ext: 'jpg',
      filePath: 'D:\\library\\cover.jpg',
      folders: ['parent'],
    },
  ];

  return {
    library: { path: 'D:\\library\\demo.library' },
    folder: {
      getSelected: async () => [parentFolder],
      getByIds: async () => [parentFolder],
    },
    item: {
      // Eagle 的 folders 数组按交集过滤：素材必须同时属于传入的全部文件夹。
      get: async ({ folders }) => items.filter(
        (item) => folders.every((folderId) => item.folders.includes(folderId)),
      ),
    },
  };
}

async function run() {
  const savedIds = [];
  const createdNames = [];
  const items = ['a', 'b'].map((id) => ({
    id, ext: 'mp4', filePath: `D:/${id}.mp4`, tags: ['原标签'], folders: ['原文件夹'],
    async save() { if (this.fail) throw new Error('写入失败'); savedIds.push(this.id); },
  }));
  const eagle = {
    library: { path: 'D:/test.library' },
    item: { getAll: async () => items, getById: async (id) => items.find((item) => item.id === id) },
    folder: { create: async ({ name }) => { createdNames.push(name); return { id: 'new-folder' }; } },
  };
  const actions = loadBridge(eagle);
  await actions.refreshPathMap();
  const targets = actions.selectionTargets([
    { video_path: 'd:/a.mp4' }, { video_path: 'D:/a.mp4' }, { video_path: 'D:/missing.mp4' },
  ]);
  assert.deepStrictEqual(Array.from(targets.ids), ['a']);
  assert.strictEqual(targets.missing, 1);
  let outcome = await actions.organizeItems(['a', 'a'], 'tag', ' 新标签 ', eagle.library.path);
  assert.strictEqual(outcome.success, 1);
  assert.deepStrictEqual(Array.from(items[0].tags), ['原标签', '新标签']);
  await actions.organizeItems(['a'], 'tag', '新标签', eagle.library.path);
  assert.deepStrictEqual(savedIds, ['a'], '重复标签不重复保存');
  items[1].fail = true;
  outcome = await actions.organizeItems(['a', 'b', 'deleted'], 'folder', '新文件夹', eagle.library.path);
  assert.strictEqual(outcome.success, 1);
  assert.strictEqual(outcome.failed, 1);
  assert.strictEqual(outcome.missing, 1);
  assert.deepStrictEqual(Array.from(items[0].folders), ['原文件夹', 'new-folder']);
  assert.deepStrictEqual(Array.from(items[1].folders), ['原文件夹']);
  assert.deepStrictEqual(createdNames, ['新文件夹']);
  assert.strictEqual(outcome.items.find((item) => item.id === 'b').status, 'failed');
  items[1].fail = false;
  items[1].folders.push('期间手动添加');
  eagle.folder.getByIds = async () => [{ id: 'new-folder' }];
  const retry = await actions.organizeItems(['b'], 'folder', '新文件夹', eagle.library.path, outcome.folderId);
  assert.strictEqual(retry.success, 1);
  assert.strictEqual(createdNames.length, 1, '失败重试复用原文件夹');
  assert(items[1].folders.includes('期间手动添加'));
  eagle.folder.getByIds = async () => [];
  await assert.rejects(actions.organizeItems(['b'], 'folder', '新文件夹', eagle.library.path, outcome.folderId), /原文件夹已删除/);
  await actions.organizeItems(['deleted'], 'folder', '不创建空夹', eagle.library.path);
  assert.strictEqual(createdNames.length, 1);
  await assert.rejects(actions.organizeItems(['a'], 'tag', ' ', eagle.library.path), /请输入名称/);
  await assert.rejects(actions.organizeItems(['a'], 'tag', '名称', '其他库'), /素材库已切换/);
  eagle.folder.create = async () => { throw new Error('创建失败'); };
  outcome = await actions.organizeItems(['a'], 'folder', '失败文件夹', eagle.library.path);
  assert.strictEqual(outcome.failed, 1);
  assert.match(outcome.items[0].reason, /创建失败/);
  assert.deepStrictEqual(Array.from(items[0].folders), ['原文件夹', 'new-folder']);

  const bridge = loadBridge(createEagleMock());

  const videos = await bridge.collectFolderVideos();
  assert.deepStrictEqual(
    Array.from(videos, (item) => item.id),
    ['parent-video', 'shared-video', 'child-video', 'grandchild-video'],
    '选择一级文件夹时应包含本级及全部子文件夹中的视频',
  );

  const paths = await bridge.pathSetFromFolderIds(['parent']);
  assert.deepStrictEqual(
    Array.from(paths).sort(),
    [
      'd:\\library\\child.mov',
      'd:\\library\\grandchild.mkv',
      'd:\\library\\parent.mp4',
      'd:\\library\\shared.webm',
    ],
    '自定义文件夹范围也应包含本级及全部子文件夹中的视频',
  );

  const coverage = bridge.summarizeIndexCoverage(
    [
      { filePath: 'D:\\library\\searchable.mp4' },
      { filePath: 'D:\\library\\blank.mp4' },
      { filePath: 'D:\\library\\broken.mp4' },
      { filePath: 'D:\\library\\new.mp4' },
    ],
    [{
      indexedPaths: ['d:/library/searchable.mp4'],
      skippedPaths: ['D:/LIBRARY/blank.mp4'],
      failedPaths: ['d:/library/broken.mp4'],
      processedPaths: [
        'd:/library/searchable.mp4',
        'D:/LIBRARY/blank.mp4',
        'd:/library/broken.mp4',
        'd:/library/deleted.mp4',
      ],
    }],
  );
  assert.deepStrictEqual(
    { ...coverage },
    { indexed: 1, skipped: 1, failed: 1, missing: 1, stale: 1 },
    '无有效场景的素材应计为已处理跳过，而不是反复计入未索引',
  );

  assert.strictEqual(
    bridge.indexHintText({ missing: 0, skipped: 620, failed: 1 }),
    '',
    '没有新素材时不应反复展示历史跳过和失败数量',
  );
  assert.strictEqual(
    bridge.indexHintText({ missing: 4, skipped: 620, failed: 1 }),
    '4 个新视频未索引',
    '检测到新素材时只提示真正未索引的数量',
  );
  assert.deepStrictEqual(
    { ...bridge.indexOutcomeDelta(
      { skipped: 623, failed: 2 },
      { skipped: 620, failed: 1 },
      true,
    ) },
    { skipped: 3, failed: 1 },
    '索引完成时只提示本轮新增的跳过和失败数量',
  );
  assert.deepStrictEqual(
    { ...bridge.indexOutcomeDelta(
      { skipped: 623, failed: 2 },
      { skipped: 0, failed: 0 },
      false,
    ) },
    { skipped: 0, failed: 0 },
    '首次建立素材库基线时不应重放历史跳过提示',
  );
}

run()
  .then(() => console.log('eagleBridge folder recursion regression test passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
