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
}

run()
  .then(() => console.log('eagleBridge folder recursion regression test passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
