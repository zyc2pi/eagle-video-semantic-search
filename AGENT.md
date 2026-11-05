# AGENT.md — Eagle 视频语义搜索插件

> 给接手本项目的 AI 助手 / 开发者的工程说明。用户文档见 README.md。

## 这是什么

Eagle（素材管理软件）的窗口插件，提供视频的语义检索：中文/英文文本搜索、剪贴板以图搜视频、
预览当前帧找相似、正负样本反馈检索、时序组合检索（A → B），以及历史片段和文本×视觉混合主题重放。
推理由本地 Python 服务提供（Auto-scenes-extraction，端口 5006），插件是纯前端 + Node 能力的 Electron 页面。

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
| `js/service.js` | Python 服务生命周期：spawn text_search.py（detached，Windows 绑定 Eagle 主进程）、health 轮询、日志重定向到 service.log、注入 DEEPSEEK_API_KEY |
| `js/api.js` | 5006 `/api/v1/*` 客户端封装；搜索请求里聚合设置页的全部参数；含 AI 计划、反馈/时序检索、索引统计/回收 |
| `js/eagleBridge.js` | Eagle API 桥：filePath↔item 映射、文件夹树/递归、定位（folder.open+select）、找/建文件夹 |
| `js/indexer.js` | 建索引：收集视频 → POST /index → 轮询 /index/status（服务端队列）|
| `js/search.js` | 结果渲染核心：分批渲染+缩略图限流(6并发)、分组/排序/过滤视图、运镜/景别快捷筛选、右侧预览面板及详情、勾选；所有检索种类（text/visual/hybrid/feedback/sequence）经 runCaptured/requestRecipe，完成时派发 `search-complete`；媒体播放交给 PreviewPlayer |
| `js/thumbDiskCache.js` | 预览图磁盘缓存（ThumbLoader 第二层）：插件目录 `cache/thumbnails`，键为规范化视频路径+帧号，记录素材 size:lastModified 指纹，沿用缓存张数/MB 上限按文件字节 LRU 淘汰；缺少 fs/Buffer 能力时自动停用 |
| `js/previewPlayer.js` | `PreviewPlayer.create(el, …)`：悬停小窗播放、预览面板原视频接管/定位/停滞恢复/逐帧与截图代次；与 Search 共用同一个 `el`，接管时替换 `el.previewVideo`；须先于 search.js 加载 |
| `js/searchRecipe.js` | 搜索参数白名单快照、导入日期边界及文件夹交集、视觉查询来源与反馈样例的持久化和重放 |
| `js/archiveStore.js` | 按库隔离的搜索仓库 JSON、原子替换、旧 saves 迁移、片段新增比较与分类持久化 |
| `js/coverFrame.js` | 原视频逐帧定位、源帧号换算、封面 JPEG 截图 |
| `js/frameSearch.js` | 固定当前画面进行视觉单帧查询、取消及查询画面展示；历史文字主题仍由 Search 重放 |
| `js/aiPlanReview.js` | 搜索前 AI 改写预览对话框：取计划、编辑/删除/补充查询，返回 precomputed_plan |
| `js/exampleSearch.js` | 正负样本反馈（找更像所选/加入正例/不要这类）与时序组合查询的入口、对话框和按钮状态 |
| `js/evalRecorder.js` | 评测记录模式（搜索结果/耗时写 evaluation/<日期>.json、人工相关性标注、评测汇总）与性能自检 |
| `js/mediaDrag.js` | 缩略图原生拖出完整原视频、勾选去重、库与文件有效性校验 |
| `js/timelineExport.js` | 片段导出 FCP7 XML（xmeml v4）：原视频 pathurl、按片段帧率的入出点、可选音频轨，供 PR / DaVinci 导入 |
| `js/manualAdd.js` | 从搜索或主题收录选中片段；目标参考、逐片段/批量人工分数及键盘调整 |
| `js/topicUndo.js` | 按库保存本会话收录/评分撤销栈；容量限制、连续逆撤销与版本祖先校验 |
| `js/topicRelations.js` | 按库读取主题片段归属、缓存版本快照、比较共有/独有片段及本地预览 |
| `js/searchCache.js` | 完整搜索参数 SHA256 键、最多50条LRU、按索引精确清除 |
| `js/warehouse.js` | Warehouse 公共入口、主题加载、浏览位置恢复、片段整理与分类管理；协调子模块并统一校验库和导航代次 |
| `js/warehouseCards.js` | 仓库卡片/列表、分页缩略图、框选、右键批量分类与删除，持有列表视图和选择状态 |
| `js/warehouseCategories.js` | 共用分类选择器、现场新建及按库记忆最近使用顺序 |
| `js/warehouseEditor.js` | 保存/编辑主题表单、条件回填、文件夹读取与提交，持有编辑草稿及异步回填代次 |
| `js/warehouseUpdates.js` | 更新变化预览、按全部/分类批量更新主题、新素材检查（手动/后台自动及导航 +N 提示）、单主题历史恢复与完整副本 |
| `js/warehouseRecovery.js` | 备份/回收站弹窗、整库恢复、仓库包导入导出及遗留锁维护 |
| `js/warehouseNavigation.js` | 全高左侧分类/主题导航、拖拽栏宽及按库持久化最近浏览位置 |
| `js/dom.js` | 共用 DOM 工具 `Dom`（`$`/`esc`/`toast`/`h()` 元素构建/`confirm`）与图片懒加载 `LazyLoad`；最先加载 |
| `js/layoutPanels.js` | 预览方式切换、右侧素材详情调宽、顶部预览调高，偏好存 localStorage |
| `js/libraryTools.js` | 设置页素材库工具：库统计、语义查重、索引管理（统计/移入回收目录）、离线索引维护说明、旧索引迁移指南 |
| `js/settingsPanel.js` | 设置页：`FIELDS` 声明式映射控件与配置键，打开/保存、模型下拉、服务日志、重启服务 |
| `js/shortcuts.js` | 全局快捷键注册与分发 |
| `js/plugin.js` | 入口与业务接线：服务状态、建索引、搜索、范围选择器、索引任务、整理所选 |
| `css/style.css` | 单文件样式，按「设计变量 → 通用组件 → 应用框架 → 功能模块 → 响应式」分区；新增样式使用变量，断点只用 900/640/480 |
| `tools/pack-backend.ps1` | 后端分发打包脚本（存在 models/transnetv2 时一并复制） |
| `tools/evaluate-search.js` | 离线评测指标（插件评测汇总复用），说明见 EVALUATION.md |

## 关键契约（改动需两侧同步）

详细条目按模块拆在 `docs/contracts/`，改动相关行为前先读对应文件，并在同一文件更新契约：

| 文件 | 覆盖范围 |
|---|---|
| [docs/contracts/search.md](docs/contracts/search.md) | 分数与阈值、单帧/视觉查询、缓存键、本地组合筛选与运镜/景别快捷筛选、文件夹/时间范围、搜索会话、在结果中搜索、AI 改写预览、正负样本反馈、时序组合查询、评测记录 |
| [docs/contracts/ui-preview.md](docs/contracts/ui-preview.md) | 三栏布局与页面状态、窄窗、主题配色、快捷键与开窗去重、设置页字段表、右侧详情与顶部预览、预览播放与停滞恢复、poster 错误、拖出原视频、时间线导出、缩略图内存/磁盘缓存 |
| [docs/contracts/warehouse.md](docs/contracts/warehouse.md) | 仓库存储 schema 与 revision、分类/星标、片段移除与选择、标签/文件夹整理、人工收录与评分、撤销、更新预览、手动/自动检查新素材、主题历史与副本、归属比较、浏览位置、仓库列表与仓库包 |
| [docs/contracts/index-service.md](docs/contracts/index-service.md) | 索引命名与库身份、索引任务与 revision、代表帧选择、TransNetV2 镜头切分、全库清理与确认、索引管理（统计/回收）、服务生命周期与关闭凭据、配置校验 |

最常踩的几条（完整说明见上表）：

- 相似度分数 = cosine × logit_scale(≈100)。文本阈值 fgclip2≈11 / clip≈21；视觉≈40 + 相对落差截断。
- 改后端 Python 后必须重启 5006 服务（POST /api/v1/shutdown 再拉起）才生效。
- 片段身份一律用 Eagle 素材 ID（旧数据回退路径）+ 原始帧边界（`original_start_frame/original_end_frame`），不用偏移后的预览帧或排序下标。
- 空范围 `[]`/空 Set 表示零候选，绝不能退回整库；`null` 才是不限。
- 新增设置：index.html 控件 + `Config.DEFAULTS`（及 `NUMBER_RULES`/枚举校验）+ `SettingsPanel.FIELDS` 一行。
- 迭代记录与后续方向见 ROADMAP.md

## 已踩过的坑（改 UI 前必读）

- 仓库列表使用可收缩内容列与独立操作列；操作按钮禁止换行，640px以下移到第二行。分类位于标题旁，不覆盖封面；选择边框不能改变卡片尺寸。备份/回收站位于页头最右侧，返回搜索统一使用顶部「新搜索」，筛选面板不放常驻操作说明；选中计数随筛选行显示，空选择时隐藏。卡片/列表共用数据及入口，缩略图沿用原限流队列。

1. **flex 子项设 overflow:hidden 后最小高度变 0**——限高容器里整行被压成 0 高（文件夹树曾全体隐身）。解法：`flex-shrink: 0`
2. **aspect-ratio 在 Eagle 环境曾失效**——缩略图用 padding-bottom:56.25% 占位盒，别改回去
3. **原生 datalist 在 Electron 定位/收起坏**——历史下拉是自绘的 `.history-panel`
4. 缩略图在服务端磁盘缓存未命中时需要 ffmpeg 抽帧，**未缓存请求必须走 ThumbLoader 限流**，且入队发生在插入 DOM 前（不能用 isConnected 过滤）
5. Eagle 无"文件夹视图内滚动到素材"API；`item.open()` 永远跳"全部"视图。「打开所在文件夹」=预选中+folder.open+延迟重选，已是能力上限；需要滚到素材时用「在全部中显示」（item.open）
6. **限高仓库网格的自动行会被压缩**：卡片有 overflow:hidden 时，三排以上会挤到约 140px 并裁掉文字和按钮。必须保留 `grid-auto-rows: max-content`；布局测试至少覆盖九张卡片。默认封面抽帧复用 Search 的缩略图队列，不能绕过 6 并发限制。
7. **smoke 夹具不要写死数量**：搜索返回数由夹具 stub 记录在 `window.__lastSearchMatches`，期望值按夹具素材导入时间推导；夹具内关闭后台「自动检查新素材」，否则 20 秒后的探测请求会打乱请求计数断言。
8. **内边距写在 dialog 自身时，吸底 `.dialog-actions` 必须 `bottom: calc(-1 * var(--dialog-pad))`**：Chromium 的 sticky 从滚动容器内边距内侧计算 bottom，配合负外边距会把操作栏上推一个内边距压住末行；内边距在内层表单（`.settings-form`）的弹窗不受影响。

## 验证

- 语法：`node --check js/*.js`（无构建步骤）
- 单元：`node tests/<name>.test.js`（全部 32 个，见 AGENTS.md 验证一节）
- 浏览器 smoke：`NODE_PATH=<@playwright/mcp>/node_modules node tests/warehouse.smoke.js`（Edge headless；`WAREHOUSE_*_ONLY` 环境变量跑单个分段）
- 后端接口：`python\python.exe -m unittest tests.test_api_v1 tests.test_scene_query tests.test_transnet_shots`（在后端目录）
- 端到端：重载插件 → 建索引 → 中文搜索 → 预览/定位/主题筛选
