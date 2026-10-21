# AGENT.md — Eagle 视频语义搜索插件

> 给接手本项目的 AI 助手 / 开发者的工程说明。用户文档见 README.md。

## 这是什么

Eagle（素材管理软件）的窗口插件，提供视频的语义检索：中文/英文文本搜索、剪贴板以图搜视频、
预览当前帧找相似／转文字检索，以及历史片段和文本×视觉混合主题重放。推理由本地 Python 服务提供
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
| `js/searchRecipe.js` | 搜索参数白名单快照、导入日期边界及文件夹交集、视觉查询来源持久化和重放 |
| `js/archiveStore.js` | 按库隔离的搜索仓库 JSON、原子替换、旧 saves 迁移、片段新增比较与分类持久化 |
| `js/coverFrame.js` | 预览逐帧定位、转码片段到源视频的帧号换算、封面 JPEG 截图 |
| `js/frameSearch.js` | 固定当前画面；视觉单帧查询与可编辑描述的文本查询、取消及查询画面展示 |
| `js/manualAdd.js` | 从搜索或主题收录选中片段；目标参考、逐片段/批量人工分数及键盘调整 |
| `js/topicUndo.js` | 按库保存本会话收录/评分撤销栈；容量限制、连续逆撤销与版本祖先校验 |
| `js/topicReview.js` | 主题快速审片队列、大预览与快捷键；写入成功后推进，退出恢复列表位置 |
| `js/searchCache.js` | 完整搜索参数 SHA256 键、最多50条LRU、按索引精确清除 |
| `js/warehouse.js` | 独立仓库卡片页、主题编辑、手动更新、分类管理；复用 Search 浏览结果 |
| `js/plugin.js` | 入口与业务接线：搜索、范围选择器、存档、统计、索引迁移、设置页 |
| `tools/pack-backend.ps1` | 后端分发打包脚本 |

## 关键契约（改动需两侧同步）

- 索引命名升级为 `indexes/<模型>/eagle_v2_<库UUID>_<模型>.lance`；先由 `Bridge.resolveLibraryIdentity()` 调用后端注册表，再按 library_id 精确查询（API 的 name 包含 `.lance`）。提纯插件使用相同协议，提交 library_path 必须取当前 Eagle 路径，不能用登记 canonical 路径代替。旧索引保留只读；离线工具迁移或新身份重建，绝不按同名库自动认领。
- 相似度分数 = cosine × logit_scale(≈100)。文本阈值 fgclip2≈11 / clip≈21；视觉检索独立阈值(≈40)+相对落差截断
- 预览支持「以当前帧找相似」「当前帧转文字搜索」；卡片「选帧找相似」仅打开预览，不立即检索。逐帧按钮在普通结果同样可用，主题封面仍仅主题内显示。旧提纯交接不恢复；保留历史混合主题重放。
- 单帧来源经 Search.captureFrame()/CoverFrame.capture() 固定 JPEG，携带 image_base64/source_video_path/source_frame/source_fps/source_name。两种模式使用同一截图；单帧视觉 recipe.config.visualAgg 固定 max，不改全局设置。后端先排除包含源帧的自身镜头，再相对截断及 Top100。同视频其他镜头保留。
- Api.describeFrame() 调用本地 /describe 图片模式，keep_model=false；描述生成后选择或编辑一条短语，再执行普通文本搜索（runFrameText），不混合视觉分数。取消仅停止等待，代次及库检查丢弃迟到结果，失败保留旧搜索。需要 MiniCPM-V-4-6，图片描述以 SHA256 缓存且不重新抽帧。
- 单帧主题保存截图及文本最终查询；sourceVideoItemId 仅用于在素材移动时更新排除路径，来源缺失不阻止已存截图重放；历史 video_path/sourceItemId 查询仍须来源有效。
- 工具栏不提供以 Eagle 选中素材搜相似入口；保留剪贴板以图搜索及已有视觉主题重放。搜索缓存键必须包含 kind/query/payload/config/library/indexNames/allowedVideoPaths，null 整库与 [] 空范围不同，不能仅用显示名称或遗漏起止帧。
- 改后端 Python 后必须重启 5006 服务（POST /api/v1/shutdown 再拉起）才生效
- `text_search.py` 接受 `--port/--host`（默认 127.0.0.1:5006，安全起见不再绑 0.0.0.0）；两插件拉起时都传 `--port`
- 标签契约：`自动提纯`/`场景直切`（提纯插件写、库统计读）；结果预览显示素材已有标签。搜索结果勾选后支持添加自定义标签、加入 Eagle 根目录新文件夹；Bridge 按素材 ID 去重，读取最新 item 并通过 save() 追加 tags/folders，保留原归属。默认名称取当前主题名或已执行搜索名称，不取尚未执行的输入框内容；批次固定素材 ID 与库路径，逐项报告失败及失效计数。
- 迭代记录与后续方向见 ROADMAP.md
- 索引按 job_id 串行轮询，5 秒请求超时、2～30 秒退避；掉线是未知状态，禁止重复提交。提交超时保留原请求幂等键；重载后恢复本插件活动任务。设置页任务历史可定向取消/失败重试。5006 health protocol_version=2，safe_index_import/export=false，在线直接压缩/覆盖已移除；后端离线维护工具持有独占锁并保存回滚记录。
- 配置验证、临时文件替换完成后才更新内存；失败抛错并通知 UI。损坏原件只能在明确恢复操作下另存备份后替换，不记录密钥值。配置备份同样必须排除打包与 Git。
- 仓库 schema v3：路径哈希清单与 `<hash>-assets/` 不可变资源，旧 v1/v2 兼容，正常保存前备份；列表用 summary，打开主题异步 hydrate。修改展示 view 不调用搜索。回收站与备份默认 30 天/10 份，未知文件保留；写锁及 fingerprint/revision 防止覆盖并发修改。恢复、复制和导出必须保留资源引用完整性。
- 分类设置/删除/重命名统一递增关联主题 revision，搜索 updatedAt 保留原义。批量分类调用 `setCategories([{id,updatedAt,revision}], categoryId)` 一次写盘，返回逐项 results；冲突不自动刷新版本重试，写盘异常不返回成功。回收站主题同样按资源引用打包，到期清理前校验内容。
- 主题人工整理按 `sceneKey` 精确移除片段，不作用于整视频或 Eagle 原素材。`removedMatches` 保存 `{key,match,removedAt}` 完整快照，按 `removedMatchesRef` 拆分不可变资源并提供 `summary.removed`；旧主题缺省为空，随备份/回收站/包完整保留。`removeMatches/restoreMatches(id,keys,updatedAt,revision)` 原子提交并返回 `{entry,keys}`，人工修改仅递增 revision，不改变搜索 updatedAt；`updatedEntry` 应用排除后计算新增。恢复即时追加原快照并解除排除，继续使用当前视图与时间筛选。主题固定载入时的库路径，跨库旧会话不可写入；旧路径片段显示时不擅自补 ID，避免显示键与存储键不同。仓库主题右键打开移除菜单，普通搜索仍切换勾选；本地结果替换按片段键保留剩余选择且不覆盖独立搜索返回快照。
- 人工收录调用 `addMatches(id,[{match,score,scoreMode}],updatedAt,revision)` 一次原子写入，返回 `{entry,keys,added,rescored,restored}`；匹配按素材 ID 与原始帧边界，只有任一侧缺 ID 才允许同路径别名匹配。已存在片段更新评分，重新加入解除排除。`match.manualScore={value,mode:'custom'|'top',scoredAt}` 与 `similarity` 相等，分数必须为有限非负数；存于已有 matches/removedMatches 资源，不创建第二份收录列表。更新结果合并所有活动人工片段、保留分数和模式，已移除人工片段保持排除，人工片段不计入 newKeys；收录/重放清除不属于目标查询的 both_hit/matched_queries。置顶分为选择时目标最高分的完整数值，之后固定；仅相似度排序中同分优先，不能盖过更高分。人工编辑保持搜索 updatedAt 并递增 revision，备份/回收站/包完整保留及校验标记。
- 收录面板固定来源库及 search-context 版本，异步目标读取用代次丢弃迟到结果。切换目标清空评分；显式刷新参考保留已填分数，不能默默沿用最新版本重试。取消/写失败不改变来源；成功留在来源并清空勾选，同主题收录才刷新当前完整快照。参考抽帧复用 Search.loadThumbnail 并在首次加载失败时回退 Eagle 缩略图。单片段与统一输入支持 0.1/1 分键盘调整及左右切换；搜索主题输入和 select 保留原生方向键行为。
- 主题就地改分使用 `ManualAdd.editScores(current)`，固定载入的目标与版本，预填完整人工值/模式，不沿用机器分数。刷新参考及提交均校验选中片段仍在目标中；冲突需显式刷新，改分不能重新加入已移除片段。成功复用当前主题结果替换，不改搜索更新时间。
- 评分总览每批 60 条，可点击跳转；下一个未评分循环查找。默认只填未评分，0 是有效已填值；统一/置顶批量操作只有关闭该选项才覆盖全部。总览展示完整分数及固定置顶模式，切换目标清空、刷新参考保留现有分数。
- 连续收录按库记住最近成功目标（localStorage，失败降级会话），重新读取目标与版本，不自动提交。`keepExisting` 默认保护目标中已有片段，保留完整机器/人工分数、置顶模式及审阅状态；全部重复时不写盘。选择“重新评分”才覆盖，新增及重新加入仍需分数。面板按 `sceneLookup` 的 ID/旧路径契约显示新增、已收录、重新加入及目标原分。
- 快速审片仅用于主题的当前可见完整结果，以启动时的 sceneKey 顺序推进。保留通过 `setReviewed` 只写 `match.reviewedAt`；评分通过 `addMatches(...,{markReviewed:true})` 一次保存分数和审阅时间，可用已有整理撤销恢复；移除复用持续排除，跳过不写盘。`reviewedAt` 属于目标主题，普通收录剥离来源值并保留目标已有值；重搜同片段保留标记，不因此永久保留失去命中的自动片段。重置审阅、保留均递增版本并保持搜索 updatedAt，独立标记操作可能使更早的整理撤销发生版本冲突。备份、回收站与仓库包保留标记。
- 更新主题先计算 `updatedEntry` 候选，用 `entryChanges` 按统一身份规则对比新增、消失、未命中的人工保留；确认才 `replace`。取消不保存、不加载候选，条件编辑器保留输入；写失败只重试提交，保持原候选与预期 revision，不能自动吞掉冲突。确认前及提交后装载前均检查库/导航，落盘后界面刷新失败须明确告知已保存。
- 单主题历史使用 `entryHistory/readEntryBackup/restoreEntryBackup` 复用整库备份，不另建历史库。同 revision 去重，无 revision 以快照摘要去重；只校验目标，不因其他历史主题损坏阻断读取。预览与提交均完整校验目标资源，提交核对历史 fingerprint、当前 updatedAt/revision、库/导航及写锁内清单 fingerprint。只替换目标，缺失分类归未分类；`_restoringEntryId` 在锁内结合被替换 revision 与 revision-clock 分配新版本，其他主题 revision 不变。保留历史搜索 updatedAt，恢复前自动备份；保留范围仍为整库备份策略。
- `copyEntry(id,name,updatedAt,revision,shouldApply)` 复制已保存的完整主题，异步校验全部资源、库/导航及写锁内 fingerprint；分配新 ID、revision 0 和创建时间，保留原搜索 updatedAt、完整结果/人工/审阅/排除状态、recipe/view、封面、分类与星标。不可变资源按内容复用，原主题不写入且版本不变。入口在编辑器中，未保存输入不带入副本；取消保留父编辑器，成功打开副本，落盘后打开失败不得允许重复提交。
- 审片内部写入引起的结果重绘不退出，成功后按原队列找下一未审阅；失败保留当前片段和输入。外部筛选/排序/导航/关闭预览退出审片，跨库旧会话禁止写入。按键仅审片时生效，输入框、IME、弹窗及组合键保持原行为；评分框支持 0.1/1 调整。审片期间隐藏结果容器，仓库记位置必须复用审片进入时的锚点，不能重新读取隐藏容器。
- `addMatches` 成功返回 `{undoToken,undoBytes}`，令牌在模块 WeakMap 中保存片段差异，不写盘或进入仓库包。`undoMatches(id,token,updatedAt,revision)` 恢复原片段/人工值/排除记录/顺序/newKeys，保留 recipe/cover/favorite/category 和搜索更新时间，成功递增版本并消费令牌；失败可重试。令牌绑定库、清单文件及目标，伪造/复制/跨库使用拒绝。
- TopicUndo 会话栈每库最多 20 步、全会话估计载荷 64 MiB，仅对已记录且连续的同主题版本祖先重基；后来的更新/星标等版本间隙不可绕过。成功撤销留在来源页面，同主题刷新本地结果；输入框及打开面板内 Ctrl+Z 保留原生行为，繁忙时不撤销；不接管已有移除撤销或 Eagle 素材写入。
- 主题 `favorite` 持久化，旧数据缺省 false；`setFavorite` 检查版本、递增 revision、保持 updatedAt，仅轻量元数据返回。仓库常用优先后按 updatedAt 排序，常用过滤与名称/分类取交集，选择范围复用可见排序；收录目标星标优先并显示分类。筛选偏好仅会话按库保留。
- 主题片段查找通过 Search 的 `archiveFilter={query,source:'all'|'manual'|'auto'}` 与时间/时长取交集；manual 以 manualScore 存在判断，含人工收录与人工改分。只变换显示及可见勾选，不改 recipe/view 的持久化结构或发搜索。条件按库和主题在会话中保留，成功新搜索重置，独立搜索快照可恢复自己的条件。
- 浏览位置在会话内按库/主题保存，仓库恢复已加载批次与主题锚点，主题恢复 sceneKey 锚点、排序、分组折叠及各组加载数量。异步恢复须检查渲染代次及页面/库；条件或视图变化重置位置。原搜索位置在进入仓库前捕获，不能等结果容器隐藏后读取。恢复非顶部位置的独立提示显示 2000ms，再用 240ms 淡出，支持回到顶部及减少动画偏好。
- 仓库选择范围使用当前筛选排序后的 ID，筛选后清除隐藏选择；每批60个主题，选择只更新 DOM，视图偏好通过 localStorage 安全降级。右键菜单单例、限制视口并支持 Esc。仓库包 UI 使用 `exportBundleAsync/importBundleAsync` 和 `js/archiveWorker.js`；兼容 v1 包，导入前核对派发时 fingerprint，后台操作期间禁止重复提交。线程中断必须报告写入结果未知，不能假称回滚。
- 搜索取消仅取消等待，通过 AbortSignal 与代次丢弃迟到响应；不等同后端推理停止。分组每批60，最高分对整组计算。预览原生失败仅转码回退一次，重试重新初始化代次。
- 缩略图懒加载只控制入队时机，实际请求统一走 ThumbLoader 的 6 并发。失败先释放槽位再排队备用图；换页仅取消未开始请求，已开始请求仍占槽直到完成。时间/时长及错误消息不可直接插入 HTML。
- 索引列表提供 `revision: string|null`；搜索缓存键包含对应版本及服务地址，缺版本时禁缓存，缓存 5 分钟到期且读取不续期。历史失败项重试接入 Indexer 监视，全部终态、服务切换/重连清缓存；覆盖查询失败是未知状态，不能视为空库或触发自动索引。
- 仓库备份目录 `revision-clock` 保留每库已使用版本高水位，写锁内先更新再提交清单，恢复不能回退版本；失败可留下版本间隙。主题导航用代次丢弃迟到读取，loadResults 的 `options.shouldApply` 在映射读取前后检查。
- 关闭 5006 使用启动时生成的 `state/search-control-<port>.json` 凭据及 `X-Eagle-Control-Token`，不从 health 返回令牌；默认 loopback 的请求来源、Host、Origin 必须通过校验。凭据不可读时明确报错，不自动降级无授权关闭。发行包排除 state、个人根配置/备份/日志并使用无个人信息的默认配置模板。
- 搜索上下文：插件 `resolveSearchScope()` 返回 `{ paths, scope, time, library, config }`；`paths` 为规范化路径 Set 或 null。三个搜索入口保存本次参数，不从后续修改过的配置推测条件。仓库重放通过 Api 的可选 cfg 参数传值，不改写全局配置。
- 动作文本查询（眨眼、相机穿梭/运镜等）由 Api 识别并请求 `temporal_search:auto`；后端以多条动作描述联合召回，较低静态相似度只用于扩大候选，最终仅返回连续原帧核验通过的结果。眨眼按原帧率扫描最多 8 个连续窗口，镜头候选按素材分散（每视频最多 4 个，最多 256 个）；长镜头未覆盖区间必须在 `temporal_info` 中明确报告，不能把未核验说成未命中。动作查询不使用普通搜索缓存。
- 打开第一个仓库主题前保存当前搜索会话（完整结果、查询条件、输入框、视图与勾选）；主题切换和更新不覆盖该快照。「新搜索」恢复同库原会话，不请求搜索服务；成功执行新搜索后丢弃旧返回目标。没有原搜索或库已切换时恢复空页，预览关闭。全局 Esc 使用原生 dialog cancel 流程，不能绕过业务处理中禁止关闭的保护。
- 仓库：`warehouse/<库路径哈希>.json` 保存主题及分类，运行数据已 gitignore；旧 `saves/` 幂等导入且不删除。更新成功写盘后才载入新结果；`newKeys` 由 Eagle 素材 ID（旧数据回退路径）与原始帧边界构成。不要用偏移后的预览帧或排序下标识别新增。
- 时间筛选：读取 Eagle `item.importedAt`（毫秒）；不用 modifiedAt、文件时间代替。范围在检索前经 `allowed_video_paths` 限制；空 Set 表示零候选，绝不能退回整库。
- 主题栏保持紧凑：仅展示主题名、素材/片段数及更新时间，不展示分类名、新增计数和封面说明；不再提供只看新增筛选。封面操作仍在预览中，片段新增标记及存档差异数据保留。
- 仓库卡片不放时间控件；打开主题后的时间控件即时本地筛选已存 matches，按 Eagle importedAt 判断，缺日期时排除；不限时间恢复全部快照。筛选状态按库和主题保留于会话内存，不写 recipe.time/matches/updatedAt，旧存档同样可筛选。独立“更新结果”操作才按原 recipe 重新搜索；旧存档更新前须补齐条件。搜索页工具栏时间仍是搜索前范围条件。自选 `cover` 保存 JPEG data URL 和来源帧，不改变搜索 updatedAt；更新结果必须保留 cover。转码预览的 currentTime 从 0 开始，换算源帧要加 previewOffsetFrame。

## 已踩过的坑（改 UI 前必读）

1. **flex 子项设 overflow:hidden 后最小高度变 0**——限高容器里整行被压成 0 高（文件夹树曾全体隐身）。解法：`flex-shrink: 0`
2. **aspect-ratio 在 Eagle 环境曾失效**——缩略图用 padding-bottom:56.25% 占位盒，别改回去
3. **原生 datalist 在 Electron 定位/收起坏**——历史下拉是自绘的 `.history-panel`
4. 缩略图每张 = 服务端一次 ffmpeg 进程，**必须走 ThumbLoader 限流**，且入队发生在插入 DOM 前（不能用 isConnected 过滤）
5. Eagle 无"文件夹视图内滚动到素材"API；`item.open()` 永远跳"全部"视图。定位=预选中+folder.open+延迟重选，已是能力上限
6. **限高仓库网格的自动行会被压缩**：卡片有 overflow:hidden 时，三排以上会挤到约 140px 并裁掉文字和按钮。必须保留 `grid-auto-rows: max-content`；布局测试至少覆盖九张卡片。默认封面抽帧复用 Search 的缩略图队列，不能绕过 6 并发限制。

## 验证

- 语法：`node --check js/*.js`（无构建步骤）
- 后端接口：`python\python.exe -m unittest tests.test_api_v1`（在后端目录，29 测试）
- 端到端：重载插件 → 建索引 → 中文搜索 → 预览/定位/主题筛选
