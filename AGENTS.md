# AGENTS.md — Eagle 视频语义搜索插件

本文件是本仓库的 AI 协作入口。开始工作前必须同时阅读根目录的
`AGENT.md`；后者记录项目架构、文件职责、跨仓库契约和已知问题，本文件
记录任务协作方式与执行规则。两者冲突时，以更具体、更新且不违背用户要求
的规则为准。

## Agent skills

### Issue tracker

本仓库不使用外部 Issue 系统。任务直接记录在本文件的“任务记录”章节中。
`to-issues`、`to-prd`、`triage` 等技能应读写该章节，不要调用 GitHub Issues，
也不要擅自创建 `.scratch/` 或 `docs/agents/`。

### Triage labels

使用以下固定状态词，不创建同义状态：

- `needs-triage`：等待维护者评估。
- `needs-info`：缺少信息，等待提出者补充。
- `ready-for-agent`：信息完整，可由自动化代理独立处理。
- `ready-for-human`：需要人工判断或人工操作。
- `wontfix`：确认不处理。

### Domain docs

本仓库采用 single-context 布局：

- `AGENTS.md`：协作规则、近期任务记录和验证要求；历史任务见 `TASKS-ARCHIVE.md`。
- `AGENT.md`：项目领域、架构、关键契约及已知问题。
- `docs/adr/`：需要长期保留的重要架构决策；目录不存在时，仅在确有 ADR
  需要写入时创建。
- 不使用 `CONTEXT-MAP.md`，也不要为当前单一插件拆分多套上下文。

涉及后端修改时，还必须阅读后端仓库自己的 `AGENT.md`。不要把插件仓库的
规则直接覆盖到姊妹项目或后端仓库。

## 任务记录

较早的任务（TASK-20261031-001 及以前）已原样移至 `TASKS-ARCHIVE.md`，
需要追溯旧决策或验证边界时查阅；新任务继续记录在本章节顶部。

### TASK-20261104-007 — 拆分 search.js 预览播放器模块

- 状态：ready-for-human
- 目标：把悬停播放与预览面板的媒体状态机从 search.js 拆为独立模块，行为不变。
- 修改：新增 js/previewPlayer.js（`PreviewPlayer.create(el, { previewStartFrame })`），原样迁移悬停播放、同源接管、定位、停滞检测/单次重载、缓冲提示、代次保护、逐帧与截图代次检查；与 Search 共享同一 `el` 对象，接管后替换的 `el.previewVideo` 双方一致。Search 保留 openPreview/closePreview 的详情、高亮、滚动及事件派发，媒体部分改调 prepare/start/close/teardown，对外接口与 DOM id 不变；迁移代码与原文逐行比对一致。index.html 在 search.js 前加载新模块，search.js 约 72KB→62KB。同时修正 TASK-006 的 showPlugin 去重：原 1.5 秒时间窗会吞掉快速关闭重开的范围重置（SESSION_SCOPE 分段复现），改为只跳过初始化后紧随的一次宿主显示事件。
- 测试：经用户同意，searchReliability / searchIndexCache / thumbnailLoader / searchSecurity 在 search.js 前加载 previewPlayer.js，ui.test 合并两文件检查，注入的 hover 改为 player.hover。另修已有失败：两个测试桩补 `style`（TASK-004 缩略图隐藏引入），searchSecurity 预览文本断言改为现行的起止时间显示；均先在 HEAD 临时 worktree 中确认拆分前即以相同错误失败。
- 验证：全部 JS node --check 通过；单元测试 31/32 通过，api.test 因 library_prune 能力桩缺失在 HEAD 上同样失败，未处理。Edge headless 下 PREVIEW、DRAG、RELATIONS、SELECTION、LAYOUT、THEME、FILTER、SETTINGS、CATEGORY、SESSION_SCOPE、SCOPE 共 11 个分段通过，searchSecurity smoke 通过；默认整段 smoke 停在与拆分前相同的连续收录分段。
- 边界：Eagle 宿主内悬停播放、双击接管、停帧恢复与逐帧需重载插件验收；未操作宿主、真实库或后端，未提交或推送。

### TASK-20261104-006 — 复查 bug 修复、时间线导出、新素材检查与全库索引确认

- 状态：ready-for-human
- 目标：处理整体复查列出的 bug 与功能建议。
- 修改：全库索引提交前核对清单——只读预演主题清理，清单骤减（为 0 或少于上次 70%）、将清理主题片段或 Ctrl+I 触发时弹窗确认，自动索引骤减直接跳过，完成后清理再次校验清单。快捷键弹窗打开时只响应 Esc，仓库改为 Ctrl+B，Ctrl+K 在主题/仓库页先回新搜索。showPlugin 只跳过初始化后紧随的一次宿主显示事件（TASK-007 修正）；窗口尺寸记录最大化状态、最大化时保留普通尺寸，宿主接口 3 秒超时。新增 timelineExport.js 导出 FCP7 XML（所选/全部），仓库「检查新素材」只在主题更新后加入的视频内按原条件探测，结果仅展示并可进入原更新预览。新增 Dom.confirm。历史任务原样移至 TASKS-ARCHIVE.md。
- 未改：排除词已由后端 `-词` 语法支持（embedding_model `_split_negative_terms`），复查建议有误，不重复实现。search.js 预览播放器拆分需同步改写以源码注入方式加载的单元测试并做宿主验收，另行处理。
- 验证：全部 JS 与 smoke 脚本 node --check、diff、UTF-8 无 BOM 检查通过；XML 生成器独立运行核对盘符/中文路径编码、NTSC 帧率、包含帧换算与转义。默认整段 smoke（Edge headless，NODE_PATH 借用 @playwright/mcp）修正过期用例后依次通过搜索/整理/保存、主题移除、人工收录、仓库可用性及整理功能分段（含新增导出按钮的菜单断言），停在连续收录分段「添加到主题」提交按钮未启用，属同类历史漂移，未继续修。修正项：全库请求 73/本地显示 72、阈值为本地筛选、无选中时整理入口隐藏、打开主题直接恢复位置、空搜索页夹具补 recipe/重新搜索。按用户规则未运行单元测试套件。
- 边界：全库确认、检查新素材、时间线导入 PR/DaVinci、窗口最大化恢复及 Ctrl+B 均需在真实 Eagle 与剪辑软件中验收；未操作宿主、真实库、索引或后端，保留本地截图，未提交或推送。

### TASK-20261104-005 — 窗口尺寸记忆与 AI 安装指引

- 状态：ready-for-human
- 目标：下次打开插件时沿用上次窗口宽高，并向安装者说明原项目环境、配套后端和插件的关系，提供可复制给 AI 的安装指令。
- 修改：LayoutPanels 保存原生窗口 outerWidth/outerHeight，拖动调窗防抖保存，隐藏和卸载时补存；初始化通过 Eagle window.setSize 恢复，并按当前屏幕可用尺寸限界，兼容 manifest 的 800×560 最小尺寸。README 新增环境复用说明与 AI 辅助安装，列出两个配套仓库和原项目、依赖检查及 health 验收条件。
- 验证：layoutPanels.js 的 node --check、diff 与 UTF-8 无 BOM 检查通过；核对 Eagle 官方 setSize(width,height) 接口。按用户规则未新增、修改或运行测试用例/套件。用户停止电脑操作后，未继续窗口关闭重开的实机验证。
- 边界：尺寸记忆按整个插件窗口实现，安装指引随源码发布；本次不额外生成分发包，保留本地截图及个人运行数据。

### TASK-20261104-004 — 修复开窗缩略图失败及收细左栏滚动条

- 状态：ready-for-human
- 目标：修复用户截图中全部缩略图破图、服务停在加载状态的问题，并降低左侧滚动条的视觉存在感。
- 原因：真实宿主控制台确认 onPluginShow 早于 onPluginCreate，范围重置调用 Search.render 时结果 DOM 尚未绑定，异常中断后续服务连接；图片在服务离线时失败后也没有重连重试。普通重载还可能复用宿主旧脚本缓存。
- 修改：插件就绪前暂存显示事件，初始化完成后重放；可见窗口重载也主动进入连接流程。缩略图使用 WeakMap 保存失败请求，服务恢复后重新排队，保留懒加载与六并发，加载/失败时隐藏破图图标和溢出替代文字。左栏滚动条改为 6px、透明轨道、低对比圆角滑块，悬停增强并去掉箭头。
- 验证：两个修改脚本 node --check、diff 检查通过；真实 Eagle 窗口清除本次旧资源缓存后重载，确认服务 health.success=true、模型已加载、绑定当前 Eagle 主进程；重新打开原有主题，首屏缩略图正常显示，预览图请求返回 200，左栏显示细滚动条。开发工具临时停用缓存选项已恢复并关闭工具。按用户规则未新增、修改或运行测试用例/套件。
- 边界：仅浏览已有主题与重载插件，未搜索、建索引或改写真实主题/素材；搜索服务由插件正常拉起并随 Eagle 生命周期运行。本修复随当前发布一并提交。

### TASK-20261104-003 — 发布插件与配套后端，整理项目致谢及历史署名

- 状态：ready-for-human
- 目标：按用户要求发布当前插件和配套后端，项目介绍首句感谢原项目及作者；用户明确同意移除历史工具共同作者署名并更新远程默认分支。
- 范围：插件本轮源码、已有验证脚本、说明及 8 个新增前端模块；后端全库失效清理、Eagle 生命周期及配套说明和依赖。两侧 README 首句链接 TuanAMV/Auto-scenes-extraction 及作者 TuanAMV。排除本地 UUID 截图、个人配置、日志、真实库/主题/索引、模型及打包产物。
- 发布前核对：fetch 后插件 master 与 origin/master 均为 c529d7d，后端 main 与 origin/main 均为 e38e1ad，均无落后或待推送提交；候选文件凭据模式扫描、diff 检查通过。29 个修改/新增 JavaScript 文件 node --check、6 份 Python AST 语法检查通过；本次未新增、修改或运行测试用例/套件。
- 历史处理：仅移除工具共同作者提交尾注，保持全部提交的代码树、父子结构、作者、提交者、时间及其余说明；在本地 Git 元数据保留原分支备份，用精确旧远程提交的 force-with-lease 更新两个既有默认分支。提交哈希随父提交变化，GitHub 协作者权限保持当前用户。
- 边界：发布前的真实 Eagle 宿主及数据验收边界见对应任务记录。本次发布操作不启动服务或清理真实数据。

### TASK-20261104-002 — 界面改为 Eagle 浅色风格与线性图标

- 状态：ready-for-human
- 目标：用户认为界面不够精致，选定“Eagle 原生风、浅色为主”方向换皮，功能与布局不变。
- 修改：仅 style.css 与 warehouseNavigation.js 一行。
  - 浅色：内容区纯白，侧栏/详情浅灰（--bg-side），按钮、输入框、菜单改为无边框填充；结果栏操作改为悬停才显底色的幽灵按钮；菜单、弹窗、提示用柔和阴影外圈代替边框。
  - 卡片：结果与仓库卡片去掉边框、阴影和上浮，画面圆角，选中显示蓝色光环加浅蓝底；标签改为填充胶囊。
  - 图标：⚙ ☆ ★ ▦ ▫ ▾ ＋ ▧ 等字符改用 CSS 遮罩线性图标，搜索框内加放大镜、筛选按钮加图标；常用主题显示黄色实心星，导航主题行新增 data-favorite 供样式区分。
  - 去掉背景色过渡动画，避免切换主题时控件渐变。
  - 夜间配色保持 TASK-20261027-016 的参考图深灰，仅补新变量。
- 验证：ui.test 通过；以 Edge 运行 12 项分段 smoke 全部通过（含并行会话的测试修复）；临时页面查看 1100px 浅色结果页、仓库页及夜间截图。
- 边界：并行会话同时在本目录修改 HTML/JS，本任务刻意只改样式以避免冲突。需重载 Eagle 插件验收；未提交或推送。

### TASK-20261104-001 — 全库索引同步清理失效素材

- 状态：ready-for-human
- 目标：执行全库索引后清理当前库各模型索引、缓存和有效主题中的已删除素材；用户明确保留回收站和历史备份，并允许重置其他库共用的可重建预览缓存。
- 修改：后端在同一串行索引任务内清理当前库各模型/维度的 v2 Lance 场景及跳过、失败清单，索引读取异常显式失败；重置哈希命名的预览图与临时预览片段，v2 任务不再清空整个 temp，帧提取失败也释放本次临时目录。任务记录保留全库清理及失败重试语义，新增 library_prune 能力校验。插件成功终态按新鲜 Eagle 素材清单清理有效主题的 matches、removedMatches、refinement 候选、newKeys 和来源引用，移动素材优先按 ID 更新路径，保留人工评分、审阅及独立封面图片；同步当前搜索、返回会话、缩略图、归属和撤销状态。主题统一指纹锁/原子提交、递增版本，切库时拒绝提交，本次写入跳过历史淘汰；跨库导入快照及只读旧索引保留。
- 验证：修改的 9 个 JavaScript 脚本 node --check、4 份 Python AST 语法检查及两仓库 diff 检查通过；临时启动 5006 后 health 返回 success=true、library_prune=true、模型已加载，因 Eagle 未运行，检查后通过认证 shutdown 关闭本次进程。按用户协作规则未新增、修改或运行测试用例/套件。
- 边界：需重载/重新打开 Eagle 插件后执行全库索引，尚未操作真实素材、索引或主题进行清理验收。完整库模式（含已有自动全库入口及重建）沿用清理语义，局部索引及局部失败重试不把子集用于删除判断。Lance 历史版本和仓库不可变资源继续供历史恢复使用，本次清理不执行物理压缩。保留既有工作区修改，未提交或推送。

### TASK-20261103-002 — 修复既有失败测试与组合筛选防抖失效

- 状态：ready-for-human
- 目标：逐项核对并修复所列 6 个单元失败、SESSION_SCOPE / SCOPE / RELATIONS 及 LAYOUT 后半段，保留原已通过的 8 个分段。
- 过期测试：api 仍要求已移除的 use_dedup，改查两个去重字段均省略；indexRetry 配置桩补 scopeExcludeFolderIds；manualAdd 补真实 categoryTree；searchIndexCache 补真实 SearchRecipe.options；searchReliability 补持久的阈值 DOM、真实 options 和 writeTime 桩；warehouseNavigation 补导航协作桩。SESSION_SCOPE / SCOPE 改查全库请求不携带路径、当前范围本地筛选正确，保留搜索配方的额外排除断言。
- 产品缺陷：rememberTopicPosition 在失焦或滚动保存浏览位置时清除 sceneQueryTimer，可能取消尚未应用的输入。取消筛选计时器改放实际导航入口，保存浏览位置只读状态；已有组合筛选 smoke 补显式失焦复现，RELATIONS / LAYOUT 恢复通过。
- 验证：拆分前后均以 Edge headless 跑通 THEME、FILTER、PREVIEW、DRAG、SETTINGS、SELECTION、CATEGORY、RESULT_SELECTION、SESSION_SCOPE、SCOPE、RELATIONS、LAYOUT 共 12 个分段；最终 32 个单元测试文件、66 个 JS 的 node --check、diff 与 UTF-8 无 BOM 检查通过。使用指定 NODE_PATH，无新增测试文件。
- 边界：额外尝试默认整段 smoke，仍停在原始候选数的旧断言（预期 72、全库实际 73），未扩修整个默认长流程；本记录的通过结论限定上述单元和分段。真实 Eagle 宿主尚待重载验收；本任务未操作后端、个人配置或真实素材库，保留既有及同期工作区修改，未提交或推送。

### TASK-20261103-003 — 按职责拆分 warehouse.js

- 状态：ready-for-human
- 目标：沿用全局 IIFE 与 index.html 加载方式，拆分仓库界面职责并保持既有 Warehouse 接口、DOM id 和操作语义。
- 修改：新增 warehouseCards（卡片/列表、分页缩略图、框选与右键批量管理）、warehouseCategories（分类选择与最近使用）、warehouseEditor（表单草稿、条件回填与提交）、warehouseUpdates（变化预览、历史恢复与副本）、warehouseRecovery（备份/回收站与仓库包操作）。warehouse.js 从约 2090 行降至约 930 行，保留主题加载、浏览恢复、片段整理、分类管理和库/导航代次协调，并保留同期新增的素材清理入口。列表和编辑状态分别由对应模块持有，写入后的数据刷新通过回调同步。
- 接线：5 个新文件先于 warehouse.js 加入 index.html；直接 vm 加载的导航单元同步加载子模块。smoke 主入口继续读取 index.html 清单，两个独立偏好窗口同步加载仓库依赖，并只为导航协作提供隔离桩。AGENT.md 文件地图同步更新。
- 验证：最终 66 个 JS 语法检查、32 个单元测试文件及上述全部 12 个 smoke 分段通过。回归中补回片段移除列表共用的分页常量；通过现有 helper 在内存中独立运行更新/历史恢复、副本、偏好初始化、备份导入导出，覆盖取消、写失败重试、版本冲突及切库保护。备份操作按当前折叠区入口展开后验证。代码审查及 diff 检查完成。
- 边界：默认整段 smoke 的旧计数断言和真实 Eagle 宿主验收范围见上一任务；未新增测试文件或构建步骤。本任务未操作后端、个人配置或真实素材库，保留既有及同期工作区修改，未提交或推送。

### TASK-20261103-001 — 前端整体重构：清理、样式规范、布局与模块拆分

- 状态：ready-for-human
- 目标：保持现有风格，整体整理前端：清理遗留代码，统一样式变量，收敛布局与入口，拆分 plugin.js。
- 修改：删除未加载的 topicReview.js、search.js 临时播放诊断（不再写 %TEMP% 日志）及无调用的 debounce/throttle；新增 dom.js（esc/toast/h 构建与 LazyLoad）、layoutPanels.js、libraryTools.js，plugin.js 由约 1590 行降至约 1280 行。style.css 按变量/组件/框架/模块/响应式重写，统一字号、间距、圆角、控件 32/28px、阴影与层级，补上未定义的 --bg-alt，浅色下未索引提示改用可读的 --warn-text，断点收敛为 900/640/480，弹窗统一内边距并吸底操作栏。旧工具栏拆除：服务状态、索引、管理分类、备份、设置移入左栏底部，顶栏合并搜索框/主题标题与筛选，删除顶部及仓库页重复入口；未打开预览时收起素材详情，结果卡片最小宽 180px；无选中时隐藏「整理所选」。保留全部业务 ID 与事件语义。
- 测试：经用户同意同步更新测试。ui/indexRetry/thumbnailLoader 跟随新文件与布局；smoke 脚本清单改为读取 index.html（原清单漏 warehouseNavigation），初始化后回到新搜索，更新旧布局相邻与宽度断言，修正 Esc 右键菜单的时序竞争。
- 验证：全部 JS node --check 通过；单元测试与改前基线一致（api、indexRetry、manualAdd、searchIndexCache、searchReliability、warehouseNavigation 6 个改前即失败，报错相同，未处理）。借用 @playwright/mcp 内置 playwright 以 Edge 运行分段 smoke：主题、筛选、预览、拖拽、设置、仓库框选、分类、结果选择 8 项通过（改前 7 项）；布局项的紧凑布局部分通过，随后与 RELATIONS、SESSION_SCOPE、SCOPE 一样停在改前已有的失败点。另以示例数据查看 1100px 深浅色、主题页与仓库页截图。
- 边界：需重载 Eagle 插件验收真实宿主；完整 smoke 与上述 3 项分段失败为原有问题，未修复。未改后端、个人配置、真实库或主题，保留既有工作区修改，未提交或推送。

新增任务时使用下面的格式，编号采用 `TASK-YYYYMMDD-NNN`；同一天从 `001`
递增。只修改本章节中的任务条目，不要把临时进度写入其他规则章节。

```markdown
### TASK-YYYYMMDD-NNN — 简短标题

- 状态：needs-triage
- 目标：一句话描述要实现的结果。
- 背景：说明问题、用户场景和必要上下文。
- 验收条件：列出可以验证完成与否的条件。
- 涉及文件：列出已知文件；未知时写“待定位”。
- 依赖/阻塞：没有则写“无”。
- 备注：记录重要判断，不写流水账。
```

完成任务后保留记录，并在备注中写明验证结果和相关 Git 提交；不要直接删除
历史任务。需要取消时将状态改为 `wontfix` 并说明原因。

## 工作规则

- 用户使用中文时默认使用中文，结论优先，表达简洁。
- 本机是 Windows，默认使用 PowerShell；搜索文件和文本优先使用 `rg`。
- 手工编辑源码、配置和文档必须使用 `apply_patch`，保持 UTF-8 无 BOM。
- 修改前先查看 `git status`。仓库可能存在用户尚未提交的修改，必须保留并
  避免覆盖；提交前只暂存本次任务明确涉及的文件。
- 禁止擅自执行 `git reset --hard`、`git checkout --`、递归删除等破坏性操作。
- 不要读取、输出或提交 `config.json` 中的密钥，也不要在回复或日志中泄露
  `service.log` 里的敏感内容。
- 改动保持聚焦。插件和 Python 后端是两个独立 Git 仓库；只有功能契约确实
  需要双侧同步时才同时修改，并分别检查状态和验证。
- 诊断问题时遵循“复现 → 缩小范围 → 提出假设 → 验证 → 修复 → 回归测试”，
  不凭猜测直接改代码。
- 修改后必须运行与风险相称的语法检查或测试；无法运行时明确说明原因。

## 验证

按本次改动选择相关文件的语法检查与已有测试；纯文档修改检查差异即可。
以下为全量检查参考，常规局部修改不默认全跑，也不为凑覆盖新增测试文件。

交付时区分实现检查、5006 服务已加载修改，以及真实素材检索效果。后端修改
属于已授权修复且需要启动或重启时，核对实际服务实例再完成加载与健康检查；
用户要求暂停、禁止宿主操作或已取消真实搜索测评时继续遵守，不能用本条扩权。
动作查询当前使用普通文本搜索，专项连续帧核验已按用户要求移除（TASK-20261021-002）。
以后接入通用视频模型时，须另行授权真实素材效果验收，区分动作过程与静态姿态。
离线搜索质量工具及真实测评边界见 `EVALUATION.md`，合成测试不能替代命中率。

插件仓库没有构建步骤，全量 JavaScript 语法检查和现有测试参考：

```powershell
$files = Get-ChildItem -LiteralPath js -Filter *.js
foreach ($file in $files) {
  node --check $file.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$tests = Get-ChildItem -LiteralPath tests -Filter *.test.js
foreach ($test in $tests) {
  node $test.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

涉及后端 Python 时，在后端仓库使用其便携 Python 运行相关测试；范围较大时
运行完整测试：

```powershell
$exe = Resolve-Path -LiteralPath '.\python\python.exe'
$args = @('-m', 'unittest', 'discover', 'tests')
& $exe @args
exit $LASTEXITCODE
```

后端代码修改后需要重启 5006 搜索服务才会生效；是否操作依当前任务授权和
已有停止要求决定。涉及 UI 交互且获准操作宿主时，按改动范围在 Eagle 中
重载并检查对应入口；未获准或无法检查时记录尚未验证的范围。
