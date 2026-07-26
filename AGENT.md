# AGENT.md — Eagle 视频语义搜索插件

> 给接手本项目的 AI 助手 / 开发者的工程说明。用户文档见 README.md。

## 这是什么

Eagle（素材管理软件）的窗口插件，提供视频的语义检索：中文/英文文本搜索、剪贴板以图搜视频、
以片段搜相似、MiniCPM 提示词生成 + 文本×视觉混合检索。推理由本地 Python 服务提供
（Auto-scenes-extraction，端口 5006），插件是纯前端 + Node 能力的 Electron 页面。

姊妹项目：`D:\eagle-video-purify`（自动提纯插件，共用同一后端）；
后端仓库 `D:\Auto-scenes-extraction-1.3.0\Auto-scenes-extraction-1.3.0`（github.com/zyc2pi/Auto-scenes-extraction）。

## 运行环境

- Eagle 4.0（Electron 22 / Chromium 108 / Node 16），插件内可 `require()` Node 内置模块，**CORS 已禁用**
- manifest `serviceMode: true`：随 Eagle 启动后台运行；开了"静默自动索引"才主动拉起 Python 服务
- 开发调试：Eagle 按 `P` → 开发者选项 → 导入本地项目；插件窗口 F12 开 DevTools

## 文件地图

| 文件 | 职责 |
|---|---|
| `js/config.js` | 配置持久化（插件目录 config.json；**含 DeepSeek key，已 gitignore**）|
| `js/service.js` | Python 服务生命周期：spawn text_search.py（detached）、health 轮询、日志重定向到 service.log、注入 DEEPSEEK_API_KEY |
| `js/api.js` | 5006 `/api/v1/*` 客户端封装；搜索请求里聚合设置页的全部参数 |
| `js/eagleBridge.js` | Eagle API 桥：filePath↔item 映射、文件夹树/递归、定位（folder.open+select）、找/建文件夹 |
| `js/indexer.js` | 建索引：收集视频 → POST /index → 轮询 /index/status（服务端队列）|
| `js/search.js` | 结果渲染核心：分批渲染+缩略图限流(6并发)、分组/排序/过滤视图、悬停自动播放、预览面板（时间轴/标签chips）、勾选 |
| `js/plugin.js` | 入口与全部业务接线：三种搜索、导出回导、打标签、范围选择器、存档、统计、索引迁移、提纯交接、设置页 |
| `tools/pack-backend.ps1` | 后端分发打包脚本 |

## 关键契约（改动需两侧同步）

- 索引命名：`indexes/<模型>/eagle_<sanitize(库名)>_<模型>.lance`——`Bridge.indexNameForLibrary()` 与提纯插件的 autoIndex 必须一致
- 相似度分数 = cosine × logit_scale(≈100)。文本阈值 fgclip2≈11 / clip≈21；视觉检索独立阈值(≈40)+相对落差截断
- 与提纯插件的交接文件：`<项目根>/purify_inbox.json`（数组 [{id,name,filePath,folderId}]），本插件写、提纯插件消费后删除
- 改后端 Python 后必须重启 5006 服务（POST /api/v1/shutdown 再拉起）才生效

## 已踩过的坑（改 UI 前必读）

1. **flex 子项设 overflow:hidden 后最小高度变 0**——限高容器里整行被压成 0 高（文件夹树曾全体隐身）。解法：`flex-shrink: 0`
2. **aspect-ratio 在 Eagle 环境曾失效**——缩略图用 padding-bottom:56.25% 占位盒，别改回去
3. **原生 datalist 在 Electron 定位/收起坏**——历史下拉是自绘的 `.history-panel`
4. 缩略图每张 = 服务端一次 ffmpeg 进程，**必须走 ThumbLoader 限流**，且入队发生在插入 DOM 前（不能用 isConnected 过滤）
5. Eagle 无"文件夹视图内滚动到素材"API；`item.open()` 永远跳"全部"视图。定位=预选中+folder.open+延迟重选，已是能力上限

## 验证

- 语法：`node --check js/*.js`（无构建步骤）
- 后端接口：`python\python.exe -m unittest tests.test_api_v1`（在后端目录，29 测试）
- 端到端：重载插件 → 建索引 → 中文搜索 → 预览/定位/导出
