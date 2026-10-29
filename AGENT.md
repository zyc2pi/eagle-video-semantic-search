# AGENT.md — Eagle 视频语义搜索插件

> 给接手本项目的 AI 助手 / 开发者的工程说明。用户文档见 README.md。

## 这是什么

Eagle（素材管理软件）的窗口插件，提供视频的语义检索：中文/英文文本搜索、剪贴板以图搜视频、
预览当前帧找相似，以及历史片段和文本×视觉混合主题重放。推理由本地 Python 服务提供
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
| `js/search.js` | 结果渲染核心：分批渲染+缩略图限流(6并发)、分组/排序/过滤视图、悬停自动播放、右侧预览及主题/标签/评分/基本信息详情、勾选 |
| `js/searchRecipe.js` | 搜索参数白名单快照、导入日期边界及文件夹交集、视觉查询来源持久化和重放 |
| `js/archiveStore.js` | 按库隔离的搜索仓库 JSON、原子替换、旧 saves 迁移、片段新增比较与分类持久化 |
| `js/coverFrame.js` | 原视频逐帧定位、源帧号换算、封面 JPEG 截图 |
| `js/frameSearch.js` | 固定当前画面进行视觉单帧查询、取消及查询画面展示；历史文字主题仍由 Search 重放 |
| `js/mediaDrag.js` | 缩略图原生拖出完整原视频、勾选去重、库与文件有效性校验 |
| `js/manualAdd.js` | 从搜索或主题收录选中片段；目标参考、逐片段/批量人工分数及键盘调整 |
| `js/topicUndo.js` | 按库保存本会话收录/评分撤销栈；容量限制、连续逆撤销与版本祖先校验 |
| `js/topicReview.js` | 历史快速审片实现，当前页面已停止加载及初始化，旧审阅字段仍兼容 |
| `js/topicRelations.js` | 按库读取主题片段归属、缓存版本快照、比较共有/独有片段及本地预览 |
| `js/searchCache.js` | 完整搜索参数 SHA256 键、最多50条LRU、按索引精确清除 |
| `js/warehouse.js` | 仓库卡片页、主题编辑、手动更新、分类管理及浏览位置恢复；复用 Search 浏览结果 |
| `js/warehouseNavigation.js` | 全高左侧分类/主题导航、拖拽栏宽及按库持久化最近浏览位置 |
| `js/plugin.js` | 入口与业务接线：搜索、范围选择器、存档、统计、索引迁移、设置页 |
| `tools/pack-backend.ps1` | 后端分发打包脚本 |

## 关键契约（改动需两侧同步）

- 外部拖拽使用 Eagle `drag.startDrag(string[])`，在 dragstart 内同步读取已映射真实文件并立即调用，不传缩略图/HTTP URL。缩略图拖完整原视频，已选卡片拖全部选中素材并按路径去重；跨库、映射失效或文件丢失拒绝拖出。只有完整原视频拖出，不提供整段/片段选择、片段目录或准备功能；插件已删除clipUrl/prepareEditClip与目录配置定义，全部预览也禁止视频切片转码。共享后端接口及已有文件保留，不由此插件调用。原生跨应用拖放仍需真实 Eagle / PR / AE 验收。

- 索引命名升级为 `indexes/<模型>/eagle_v2_<库UUID>_<模型>.lance`；先由 `Bridge.resolveLibraryIdentity()` 调用后端注册表，再按 library_id 精确查询（API 的 name 包含 `.lance`）。提纯插件使用相同协议，提交 library_path 必须取当前 Eagle 路径，不能用登记 canonical 路径代替。旧索引保留只读；离线工具迁移或新身份重建，绝不按同名库自动认领。
- 相似度分数 = cosine × logit_scale(≈100)。文本阈值 fgclip2≈11 / clip≈21；视觉检索独立阈值(≈40)+相对落差截断
- 右侧详情栏统一显示预览、所属主题、全部标签、Eagle星级（只读）和人工分数/相似度、基本信息。双击片段更新，Esc清空预览，列表与详情独立滚动；归属复用TopicRelations快照，主题按钮固定来源库。卡片不再铺开归属文字。接缝通过Pointer Events及pointer capture调宽，保留至少200px结果区，宽度偏好以eagle-semantic-inspector-width保存在localStorage，失败降级为会话内；ResizeObserver限宽但不覆盖偏好，恢复窗口宽度后还原。接缝支持方向键/Home/End，阻止预览切换。筛选、显示、整理所选、主题管理使用互斥菜单，点击外部或Esc关闭。预览仍支持以当前帧找相似及逐帧定位；已移除转文字搜索、画幅控件与快速审片入口，保留历史文字/混合主题和旧审阅字段。
- 单帧来源经 Search.captureFrame()/CoverFrame.capture() 固定 JPEG，携带 image_base64/source_video_path/source_frame/source_fps/source_name。单帧视觉 recipe.config.visualAgg 固定 max，不改全局设置。后端先排除包含源帧的自身镜头，再相对截断及 Top100。同视频其他镜头保留。
- 历史单帧文字主题仍保留 runFrameText 及最终 query/payload 的重放兼容，不重新生成描述。当前页面不再提供描述生成弹窗或触发 /describe。
- 单帧主题保存截图及文本最终查询；sourceVideoItemId 仅用于在素材移动时更新排除路径，来源缺失不阻止已存截图重放；历史 video_path/sourceItemId 查询仍须来源有效。
- 工具栏不提供以 Eagle 选中素材搜相似入口；保留剪贴板以图搜索及已有视觉主题重放。搜索缓存键必须包含 kind/query/payload/config/library/indexNames/allowedVideoPaths，null 整库与 [] 空范围不同，不能仅用显示名称或遗漏起止帧。
- 页面不再显示顶部标题/服务文字栏；服务加载时显示临时文字，连接成功隐藏文字，仅在索引按钮左侧亮绿灯并保留tooltip/aria状态，离线仍显示错误。设置与「新搜索」位于「搜索仓库」右侧，工具栏在仓库列表也可访问；「撤销整理」按钮只在具体主题的view-bar内显示，快捷键沿用原契约。
- 「显示 → 预览方式」在右侧素材详情与顶部双击展开预览之间切换，默认右侧，偏好以eagle-semantic-preview-layout保存在localStorage。顶部模式用CSS Grid和display:contents复用同一preview-panel/video，隐藏右栏与接缝，关闭预览后释放高度；不重建结果、不改变选择或播放器状态、不重发搜索。顶部模式暂停计算侧栏宽度，切回时恢复原宽度偏好。
- 左侧仓库导航与右侧 `.main-workspace` 是 body 的同级全高区域，初始化即读取已有分类和主题；分类按可选 parentId 多层嵌套，旧分类缺省为根目录，各层可折叠，主题可直接打开，不改 Eagle 文件夹。父分类的计数和列表筛选包含全部子分类；ArchiveStore.categoryTree 统一生成路径、层级和后代集合，异常父引用在展示时回到根部。接缝通过 Pointer Events/pointer capture 调宽，支持方向键/Home/End，宽度偏好以 eagle-semantic-library-width 保存。右侧至少保留360px内容宽度，极窄窗口仅右侧横向滚动。页面显隐优先于预览布局：body[data-page="warehouse"] .main-workspace > .result-workspace 使用 display:none !important，仓库列表和结果在右侧切换，左栏一直可用；返回后保留原预览模式。
- 主工作区窄窗布局由 ResizeObserver 按实际宽度切换 narrow-workspace（≤640px），不使用 container-type 尺寸容器；Eagle Chromium 108 中尺寸容器会改变后代 fixed 菜单的定位参照，叠加左栏偏移并裁切菜单。筛选菜单保持窗口坐标，在窗口/工作区调宽及工作区横向滚动后重新定位。
- 顶部预览横向接缝用Pointer Events调整高度并同步缩放画面，偏好eagle-semantic-preview-height保存到localStorage，缩窗限高但不覆盖偏好，至少给结果保留200px；关闭预览或切回右栏时隐藏横线。支持上下键/Home/End，观察工作区与面板尺寸更新限高与aria值。结果栏菜单和普通按钮统一28px，箭头使用5px CSS描边，避免字体符号撑高。
- 预览启动：悬停立即加载，元数据就绪后设置currentTime并立即play，不等seeked或80ms意图等待。双击接管当前同源悬停video，包括在途加载，保留解码器及主播放器音量/静音/速度；从片段开头播放，保留两帧起播偏移，同源不重复赋src。当前大预览卡片不新建悬停解码器。preload=auto，不额外预缓冲；封面复用已加载卡片/Eagle缩略图，已解码同源video移除poster。所有格式双击时都只尝试原文件；连续1.5秒无真实播放推进才load原文件一次，再停滞1.5秒直接报错，不生成替代视频。定位前同步标记seekPending，seeked后重建时间基线；seek跳转、playing/play Promise不能续期或解除检测，真实正向推进才续期，正常播放后仍监测停帧。超时复核实际时间及暂停/结束状态，防止主线程繁忙时媒体事件迟到导致误重载。waiting延迟200ms提示；暂停、结束、关闭、切换、逐帧与错误清理旧等待，加载/重载代次和尝试编号保护迟到回调。失败停止播放器，重试重新初始化。原视频定位/解码仍由浏览器完成，Eagle宿主停帧的具体根因尚未确认，独立窗口结果不能替代宿主验收；保留buffered、seeking、采样时长与媒体推进诊断，采样从首次playing开始计时。
- Chromium 108 的video poster图加载失败也会在video上派发error，此时video.error为空，源视频仍可正常播放。主预览和主题比较onerror必须先检查MediaError，不能把封面失败当作媒体失败；已解码同源播放器展开时移除poster，不再发封面抽帧请求。兼容性验证须覆盖Eagle同版本运行环境及封面失败。
- 改后端 Python 后必须重启 5006 服务（POST /api/v1/shutdown 再拉起）才生效
- 主题打开性能：Search.restoreBrowsePosition先让首批绘制，再逐批恢复历史卡片/分组加载量；每批检查渲染代次、库和页面。scroll:false只在开始置顶，不覆盖用户在恢复期间的新滚动。片段归属仅更新当前详情，不遍历或重建全量结果；TopicRelations同库同签名共用在途读取，归属索引每256条设检查点、累计约8ms让出事件循环，完成后重新验证主题版本。被新快照取代使用AbortError，旧后台任务不能清空新缓存；不返回部分归属。真实大主题仍需读取/校验/解析资源，未承诺全库扫描总耗时下降。
- 索引代表帧：插件 `indexFrameSelection` 默认 `content_adaptive`，可选 `triplet` / `dinov3_cses`，经 `/index.options.frame_selection` 传给后端。内容模式复用现有FG-CLIP2/CLIP特征，按代表性、最远点覆盖及时间平局规则选实际帧，余弦距离≤0.02时提前停止；`indexContentMaxFrames`→`content_max_frames` 默认12、范围1～32，无新增解码或推理。提交前分别检查health的 `capabilities.content_adaptive_frames` / `smart_frame_selection`，旧服务不静默忽略。DINOv3仅选帧，最终仍存当前检索模型向量；三种模式保持原镜头边界，按feature_count兼容旧schema，不自动重建已有素材。更多向量可能增加索引/搜索成本、改变max/mean和去重结果，真实质量未测评。`dinov3-cses`工具模型不出现在检索模型下拉。
- `text_search.py` 接受 `--port/--host`（默认 127.0.0.1:5006，安全起见不再绑 0.0.0.0）；两插件拉起时都传 `--port`
- 标签契约：`自动提纯`/`场景直切`（提纯插件写、库统计读）；结果预览显示素材已有标签。搜索结果勾选后支持添加自定义标签、加入 Eagle 根目录新文件夹；Bridge 按素材 ID 去重，读取最新 item 并通过 save() 追加 tags/folders，保留原归属。默认名称取当前主题名或已执行搜索名称，不取尚未执行的输入框内容；批次固定素材 ID 与库路径，逐项报告失败及失效计数。
- 迭代记录与后续方向见 ROADMAP.md
- 索引按 job_id 串行轮询，5 秒请求超时、2～30 秒退避；掉线是未知状态，禁止重复提交。提交超时保留原请求幂等键；重载后恢复本插件活动任务。设置页任务历史可定向取消/失败重试。5006 health protocol_version=2，safe_index_import/export=false，在线直接压缩/覆盖已移除；后端离线维护工具持有独占锁并保存回滚记录。
- 配置验证、临时文件替换完成后才更新内存；失败抛错并通知 UI。损坏原件只能在明确恢复操作下另存备份后替换，不记录密钥值。配置备份同样必须排除打包与 Git。
- 外观设置 `theme` 为 `auto`（默认跟随 Eagle）/`dark`（夜间）/`light`（浅色），配置成功保存后立即应用；宿主主题事件仅在 auto 模式决定配色。统一通过根元素 data-theme 与 CSS 变量切换，并同步原生控件 color-scheme；不重建结果或播放器。
- 仓库 schema v3：路径哈希清单与 `<hash>-assets/` 不可变资源，旧 v1/v2 兼容，正常保存前备份；列表用 summary，打开主题异步 hydrate。修改展示 view 不调用搜索。回收站与备份默认 30 天/10 份，未知文件保留；写锁及 fingerprint/revision 防止覆盖并发修改。恢复、复制和导出必须保留资源引用完整性。
- 分类设置/删除/重命名统一递增关联主题 revision，搜索 updatedAt 保留原义。管理分类可选择上级创建或移动，禁止移到自身/后代，同级名称唯一，跨级同名用完整路径区分；修改上级或名称递增整个子树关联主题的 revision。删除分类时仅直属主题归未分类，子分类提升一级；提升发生同名冲突时拒绝写入。批量分类调用 `setCategories([{id,updatedAt,revision}], categoryId)` 一次写盘，返回逐项 results；冲突不自动刷新版本重试，写盘异常不返回成功。回收站主题同样按资源引用打包，到期清理前校验内容。
- 分类选择器用于批量分类及保存/编辑主题，支持输入筛选、现场新建、方向键与 Enter。新分类暂存为 `{name}`，由 `add/replace/setCategories` 在同次提交中解析为分类 ID，精确同名复用；取消、全冲突或写失败不留下新分类，落盘仍是原有字符串 ID。成功应用后按库在 localStorage 记录最近使用 ID 顺序（最多100项，失败降级会话），按当前分类名称展示，删除分类不再出现；从新版首次使用开始累计，不伪造历史顺序。
- 主题人工整理按 `sceneKey` 精确移除片段，不作用于整视频或 Eagle 原素材。`removedMatches` 保存 `{key,match,removedAt}` 完整快照，按 `removedMatchesRef` 拆分不可变资源并提供 `summary.removed`；旧主题缺省为空，随备份/回收站/包完整保留。`removeMatches/restoreMatches(id,keys,updatedAt,revision)` 原子提交并返回 `{entry,keys}`，人工修改仅递增 revision，不改变搜索 updatedAt；`updatedEntry` 应用排除后计算新增。恢复即时追加原快照并解除排除，继续使用当前视图与时间筛选。主题固定载入时的库路径，跨库旧会话不可写入；旧路径片段显示时不擅自补 ID，避免显示键与存储键不同。普通搜索及主题结果左键单选、Ctrl+左键切换单项、Shift+左键按当前筛选、排序与分组后的displayList追加连续范围；单选或单项勾选设定起点，清空选择或重绘视图重置起点。选择不切换预览，双击卡片打开预览。右键已选片段或结果空白处保留多选，未选片段先单选；菜单复用顶部「整理所选」的同一内容和事件，保留主题操作显隐、忙碌及库校验，限位到视口内，外部点击/Esc/滚动/重绘时关闭。移除从顶部或右键菜单的「从主题移除」执行；本地结果替换按片段键保留剩余选择且不覆盖独立搜索返回快照。
- 人工收录调用 `addMatches(id,[{match,score,scoreMode}],updatedAt,revision)` 一次原子写入，返回 `{entry,keys,added,rescored,restored}`；匹配按素材 ID 与原始帧边界，只有任一侧缺 ID 才允许同路径别名匹配。已存在片段更新评分，重新加入解除排除。`match.manualScore={value,mode:'custom'|'top',scoredAt}` 与 `similarity` 相等，分数必须为有限非负数；存于已有 matches/removedMatches 资源，不创建第二份收录列表。更新结果合并所有活动人工片段、保留分数和模式，已移除人工片段保持排除，人工片段不计入 newKeys；收录/重放清除不属于目标查询的 both_hit/matched_queries。置顶分为选择时目标最高分的完整数值，之后固定；仅相似度排序中同分优先，不能盖过更高分。人工编辑保持搜索 updatedAt 并递增 revision，备份/回收站/包完整保留及校验标记。
- 收录面板固定来源库及 search-context 版本，异步目标读取用代次丢弃迟到结果。切换目标清空评分；显式刷新参考保留已填分数，不能默默沿用最新版本重试。取消/写失败不改变来源；成功留在来源并清空勾选，同主题收录才刷新当前完整快照。参考抽帧复用 Search.loadThumbnail 并在首次加载失败时回退 Eagle 缩略图。单片段与统一输入支持 0.1/1 分键盘调整及左右切换；搜索主题输入和 select 保留原生方向键行为。
- 主题就地改分使用 `ManualAdd.editScores(current)`，固定载入的目标与版本，预填完整人工值/模式，不沿用机器分数。刷新参考及提交均校验选中片段仍在目标中；冲突需显式刷新，改分不能重新加入已移除片段。成功复用当前主题结果替换，不改搜索更新时间。
- 评分总览每批 60 条，可点击跳转；下一个未评分循环查找。默认只填未评分，0 是有效已填值；统一/置顶批量操作只有关闭该选项才覆盖全部。总览展示完整分数及固定置顶模式，切换目标清空、刷新参考保留现有分数。
- 连续收录按库记住最近成功目标（localStorage，失败降级会话），重新读取目标与版本，不自动提交。`keepExisting` 默认保护目标中已有片段，保留完整机器/人工分数、置顶模式及审阅状态；全部重复时不写盘。选择“重新评分”才覆盖，新增及重新加入仍需分数。面板按 `sceneLookup` 的 ID/旧路径契约显示新增、已收录、重新加入及目标原分。
- 更新主题先计算 `updatedEntry` 候选，用 `entryChanges` 按统一身份规则对比新增、消失、未命中的人工保留；确认才 `replace`。取消不保存、不加载候选，条件编辑器保留输入；写失败只重试提交，保持原候选与预期 revision，不能自动吞掉冲突。确认前及提交后装载前均检查库/导航，落盘后界面刷新失败须明确告知已保存。
- 单主题历史使用 `entryHistory/readEntryBackup/restoreEntryBackup` 复用整库备份，不另建历史库。同 revision 去重，无 revision 以快照摘要去重；只校验目标，不因其他历史主题损坏阻断读取。预览与提交均完整校验目标资源，提交核对历史 fingerprint、当前 updatedAt/revision、库/导航及写锁内清单 fingerprint。只替换目标，缺失分类归未分类；`_restoringEntryId` 在锁内结合被替换 revision 与 revision-clock 分配新版本，其他主题 revision 不变。保留历史搜索 updatedAt，恢复前自动备份；保留范围仍为整库备份策略。
- `copyEntry(id,name,updatedAt,revision,shouldApply)` 复制已保存的完整主题，异步校验全部资源、库/导航及写锁内 fingerprint；分配新 ID、revision 0 和创建时间，保留原搜索 updatedAt、完整结果/人工/审阅/排除状态、recipe/view、封面、分类与星标。不可变资源按内容复用，原主题不写入且版本不变。入口在编辑器中，未保存输入不带入副本；取消保留父编辑器，成功打开副本，落盘后打开失败不得允许重复提交。
- `addMatches` 成功返回 `{undoToken,undoBytes}`，令牌在模块 WeakMap 中保存片段差异，不写盘或进入仓库包。`undoMatches(id,token,updatedAt,revision)` 恢复原片段/人工值/排除记录/顺序/newKeys，保留 recipe/cover/favorite/category 和搜索更新时间，成功递增版本并消费令牌；失败可重试。令牌绑定库、清单文件及目标，伪造/复制/跨库使用拒绝。
- TopicUndo 会话栈每库最多 20 步、全会话估计载荷 64 MiB，仅对已记录且连续的同主题版本祖先重基；后来的更新/星标等版本间隙不可绕过。成功撤销留在来源页面，同主题刷新本地结果；输入框及打开面板内 Ctrl+Z 保留原生行为，繁忙时不撤销；不接管已有移除撤销或 Eagle 素材写入。
- 主题 `favorite` 持久化，旧数据缺省 false；`setFavorite` 检查版本、递增 revision、保持 updatedAt，仅轻量元数据返回。仓库常用优先后按 updatedAt 排序，常用过滤与名称/分类取交集，选择范围复用可见排序；收录目标星标优先并显示分类。筛选偏好仅会话按库保留。
- 普通搜索及主题共用结果内组合筛选，Search 的 `archiveFilter={query,source,tags,orientation,maxDur,minScore}` 与全局 sessionScope、时间和 `view.minDur` 取交集。标签按中英文逗号拆分、完整名称忽略大小写且全部满足；画幅读 Eagle width/height，缺失或无效尺寸归 unknown；时长针对片段，边界包含，maxDur=null 不限。manual 以 manualScore 存在判断。筛选只变换显示、清除隐藏勾选，不发搜索或改写 recipe/matches，新增条件不写入持久化 view；组合条件按库和主题在会话保留，独立搜索快照可恢复，成功新搜索清空组合条件，原有最短时长偏好与本次打开的全局文件夹范围保留。
- 原“搜索选项”并入工具栏单一“筛选”菜单，新搜索无结果时也可访问；仓库主题使用同一入口，仓库主题列表隐藏素材筛选。阈值/时间保留新搜索前条件与主题本地筛选语义；文件夹范围在本次打开内全局共用，Config.setScope 只改内存，保存其他配置时剔除 scope 字段，读取旧配置也重置整库。Search 的 sessionScope 独立于主题筛选和独立搜索返回快照，范围变更即时筛选已有结果、后续搜索前重新解析；null 不限，空 Set 为零候选，不改主题 recipe/matches。onPluginShow 显式清除范围，兼容 serviceMode 后台仍存活的关闭重开；换库同样重置。解析校验库/主题/导航代次、范围操作编号及弹窗取消，清除筛选也清除全局范围。菜单固定定位并在打开和缩窗时限于视口，原主题栏时间入口已移入菜单。
- 跨主题归属和比较只读当前库的活动 matches，不计 removedMatches 或回收站。使用与 sceneLookup 一致的素材 ID/原始帧边界及旧路径别名规则；已知不同 ID 不混同。主题清单版本签名缓存，按主题顺序异步校验 matches 资源；读取期间版本改变或资源损坏明确失败，不返回伪空归属。收录/撤销、导航及结果重绘刷新归属。比较完整已存快照，提供共有/A 独有/B 独有，分批 60 个显示，不受本地筛选影响；刷新重新取快照，跨库拒绝旧面板操作。预览只播放原文件，失败直接提示，不调用切片转码、模型或改写主题。
- 浏览位置在会话内按库/主题保存，打开主题直接按 sceneKey 恢复排序、分组折叠、加载数量与滚动位置。最近页面、最近主题位置及本地筛选、仓库列表条件/位置、分类折叠及左栏位置按库保存到 localStorage（eagle-semantic-navigation），首次打开自动恢复，主题被删除则返回仓库；文件夹范围不持久化。onPluginShow 在重置全局范围前捕获位置，重绘后恢复，兼容 serviceMode 关闭重开。未保存搜索结果仅在后台驻留会话内保留，重载后只返回新搜索入口。恢复过程中禁止保存中间位置，异步恢复仍校验渲染/导航代次和库。原搜索位置在隐藏前捕获；非顶部恢复提示显示2000ms，支持回到顶部。
- 仓库选择范围使用当前筛选排序后的 ID，筛选后清除隐藏选择；每批60个主题，选择只更新 DOM，视图偏好通过 localStorage 安全降级。卡片/列表均可从网格空白处用 Pointer Events 框选，按内容坐标命中已加载卡片，边缘自动滚动；Ctrl/Shift追加、Esc/失焦/导航取消并清理，空白点击清空。右键卡片或空白处保留选中集合并提供批量分类/删除；删除经确认调用 `removeEntries([{id,updatedAt,revision}])`，一次写盘移入回收站，逐项报告冲突，写失败不返回成功，不删除 Eagle 素材。菜单单例、限制视口并支持 Esc。仓库包 UI 使用 `exportBundleAsync/importBundleAsync` 和 `js/archiveWorker.js`；兼容 v1 包，导入前核对派发时 fingerprint，后台操作期间禁止重复提交。线程中断必须报告写入结果未知，不能假称回滚。
- 仓库工具栏已移除批量分类按钮，批量操作统一从右键进入；仓库和具体主题均移除比较入口，TopicRelations 的片段归属查询继续使用。
- 搜索取消仅取消等待，通过 AbortSignal 与代次丢弃迟到响应；不等同后端推理停止。分组每批60，最高分对整组计算。原视频预览失败可重试，重试重新初始化代次，不再请求转码。
- 缩略图统一走 ThumbLoader：HTTP 图片成功解码后保留原始压缩字节的 data URL；完整 URL（服务地址/视频路径/帧号）作键，同 URL 在途共享。主题/搜索重绘不清缓存，命中立即赋 src，未命中懒加载并保持 6 并发。默认 5000 张与 128 MiB 双上限，按 URL/data URL 双字节字符串保守计费，LRU 淘汰；不持有离屏 DOM/解码位图，预算不代表整个进程内存。Config 的 thumbnailCacheMaxEntries（0～50000）/thumbnailCacheMaxMB（0～1024）经设置保存后立即应用、缩小时淘汰，任一为0关闭；重载保留设置但清空会话缓存，后端磁盘缓存沿用。fetch失败走原生加载及已有备用图，失败不缓存；换页仅取消未开始请求，已开始请求仍占槽直到完成，旧失败不回退。时间/时长及错误消息不可直接插入 HTML。
- 索引列表提供 `revision: string|null`；搜索缓存键包含对应版本及服务地址，缺版本时禁缓存，缓存 5 分钟到期且读取不续期。历史失败项重试接入 Indexer 监视，全部终态、服务切换/重连清缓存；覆盖查询失败是未知状态，不能视为空库或触发自动索引。
- 仓库备份目录 `revision-clock` 保留每库已使用版本高水位，写锁内先更新再提交清单，恢复不能回退版本；失败可留下版本间隙。主题导航用代次丢弃迟到读取，loadResults 的 `options.shouldApply` 在映射读取前后检查。
- 关闭 5006 使用启动时生成的 `state/search-control-<port>.json` 凭据及 `X-Eagle-Control-Token`，不从 health 返回令牌；默认 loopback 的请求来源、Host、Origin 必须通过校验。凭据不可读时明确报错，不自动降级无授权关闭。发行包排除 state、个人根配置/备份/日志并使用无个人信息的默认配置模板。
- 搜索上下文：插件 `resolveSearchScope()` 返回 `{ paths, scope, time, library, config }`；`paths` 为规范化路径 Set 或 null。三个搜索入口保存本次参数，不从后续修改过的配置推测条件。仓库重放通过 Api 的可选 cfg 参数传值，不改写全局配置。
- 文件夹排除：Config.scopeMode 与 recipe.scope.mode 支持 `exclude`，复用 folderIds；指定/跟随范围内追加的右键排除以 Config.scopeExcludeFolderIds / recipe.scope.excludeFolderIds 与基础范围取差集。递归展开所选文件夹，按任一归属取排除并集，再与导入日期求交集。搜索前通过 allowed_video_paths 限制，全部排除保留空 Set，不回退整库。单素材右键排除读取最新 item 与真实文件夹树，父子同时归属只取最深归属，各独立分支由用户选择一个，不按 folders 数组顺序猜测。未分类/失效素材拒绝操作，多素材禁用；只改范围，不改 Eagle 文件夹/原素材/主题。主题已保存的 recipe 仍独立支持范围回填与重放，包含额外排除；既有人工收录片段遵循主题更新的人工保留契约。
- 2026-10-21 按用户要求移除眨眼/运镜专项连续帧核验。所有动作词使用普通文本搜索，不自动改写候选、降低阈值、切换重排或绕过缓存；不展示动作核验报告或证据帧。已有主题完整保留，旧核验元数据不再参与预览定位与展示；后续通用视频动作检索方案须单独确认后接入。
- 打开第一个仓库主题前保存当前搜索会话（完整结果、查询条件、输入框、视图与勾选）；主题切换和更新不覆盖该快照。「新搜索」恢复同库原会话，不请求搜索服务；成功执行新搜索后丢弃旧返回目标。没有原搜索或库已切换时恢复空页，预览关闭。全局 Esc 使用原生 dialog cancel 流程，不能绕过业务处理中禁止关闭的保护。
- 仓库：`warehouse/<库路径哈希>.json` 保存主题及分类，运行数据已 gitignore；旧 `saves/` 幂等导入且不删除。更新成功写盘后才载入新结果；`newKeys` 由 Eagle 素材 ID（旧数据回退路径）与原始帧边界构成。不要用偏移后的预览帧或排序下标识别新增。
- 时间筛选：读取 Eagle `item.importedAt`（毫秒）；不用 modifiedAt、文件时间代替。范围在检索前经 `allowed_video_paths` 限制；空 Set 表示零候选，绝不能退回整库。
- 主题栏保持紧凑：仅展示主题名、素材/片段数及更新时间，不展示分类名、新增计数和封面说明；不再提供只看新增筛选。封面操作仍在预览中，片段新增标记及存档差异数据保留。
- 仓库卡片不放时间控件；打开主题后的时间控件即时本地筛选已存 matches，按 Eagle importedAt 判断，缺日期时排除；不限时间恢复全部快照。筛选状态按库和主题保留于会话内存，不写 recipe.time/matches/updatedAt，旧存档同样可筛选。独立“更新结果”操作才按原 recipe 重新搜索；旧存档更新前须补齐条件。搜索页工具栏时间仍是搜索前范围条件。自选 `cover` 保存 JPEG data URL 和来源帧，不改变搜索 updatedAt；更新结果必须保留 cover。预览currentTime始终属于原视频，截图与逐帧不再使用转码偏移。

## 已踩过的坑（改 UI 前必读）

- 仓库列表使用可收缩内容列与独立操作列；操作按钮禁止换行，640px以下移到第二行。分类位于标题旁，不覆盖封面；选择边框不能改变卡片尺寸。备份/回收站位于页头最右侧，返回搜索统一使用顶部「新搜索」，筛选面板不放常驻操作说明；选中计数随筛选行显示，空选择时隐藏。卡片/列表共用数据及入口，缩略图沿用原限流队列。

1. **flex 子项设 overflow:hidden 后最小高度变 0**——限高容器里整行被压成 0 高（文件夹树曾全体隐身）。解法：`flex-shrink: 0`
2. **aspect-ratio 在 Eagle 环境曾失效**——缩略图用 padding-bottom:56.25% 占位盒，别改回去
3. **原生 datalist 在 Electron 定位/收起坏**——历史下拉是自绘的 `.history-panel`
4. 缩略图在服务端磁盘缓存未命中时需要 ffmpeg 抽帧，**未缓存请求必须走 ThumbLoader 限流**，且入队发生在插入 DOM 前（不能用 isConnected 过滤）
5. Eagle 无"文件夹视图内滚动到素材"API；`item.open()` 永远跳"全部"视图。定位=预选中+folder.open+延迟重选，已是能力上限
6. **限高仓库网格的自动行会被压缩**：卡片有 overflow:hidden 时，三排以上会挤到约 140px 并裁掉文字和按钮。必须保留 `grid-auto-rows: max-content`；布局测试至少覆盖九张卡片。默认封面抽帧复用 Search 的缩略图队列，不能绕过 6 并发限制。

## 验证

- 语法：`node --check js/*.js`（无构建步骤）
- 后端接口：`python\python.exe -m unittest tests.test_api_v1`（在后端目录，29 测试）
- 端到端：重载插件 → 建索引 → 中文搜索 → 预览/定位/主题筛选
