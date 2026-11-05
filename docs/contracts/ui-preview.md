# 界面、预览、拖出与缩略图契约

> 从 AGENT.md「关键契约」拆出。改 UI 前同时阅读 AGENT.md「已踩过的坑」。

## 布局与页面状态

- 界面分三块（TASK-20261103-001）：左侧仓库栏常驻「新搜索」(#topic-search)、分类/主题树（「全部主题」行 id 为 btn-archives，由 WarehouseNavigation 生成）、底部服务状态与索引分段按钮（菜单向上展开）、管理分类 / 备份回收站 / 设置。右侧顶栏 `.search-row` 在新搜索显示搜索框，在主题内隐藏搜索框改显 #warehouse-topic（返回、标题、星标、更新、主题管理），筛选菜单两者共用；仓库列表页隐藏顶栏。旧 `.toolbar`、顶部「全部主题/新搜索」、仓库页内重复的管理分类/备份按钮已移除。服务加载时显示临时文字，连接成功隐藏文字，仅保留绿灯与tooltip/aria状态，离线仍显示错误。「撤销整理」按钮只在具体主题的view-bar内显示，快捷键沿用原契约。搜索框旁「时序」按钮（#btn-sequence-search）与搜索框同显隐。
- 页面显隐只由 body[data-page] / body[data-topic] 驱动，集中在 style.css「视图状态」一节；右侧素材详情在侧栏模式下未打开预览时（#inspector-empty 可见）整栏收起，单击只选中不展开，双击打开预览后才占宽。view-bar 的「整理所选」入口在 #selection-count 为空时隐藏，右键菜单仍复用其内容。所有弹窗末尾的 .dialog-actions 吸底（依赖父容器内边距等于 --dialog-pad）。
- 左侧仓库导航与右侧 `.main-workspace` 是 body 的同级全高区域，初始化即读取已有分类和主题；分类按可选 parentId 多层嵌套，旧分类缺省为根目录，各层可折叠，主题可直接打开，不改 Eagle 文件夹。父分类的计数和列表筛选包含全部子分类；ArchiveStore.categoryTree 统一生成路径、层级和后代集合，异常父引用在展示时回到根部。接缝通过 Pointer Events/pointer capture 调宽，支持方向键/Home/End，宽度偏好以 eagle-semantic-library-width 保存。右侧至少保留320px内容宽度（左栏最窄120px时480px窗口仍不溢出），更窄时仅右侧横向滚动。页面显隐优先于预览布局：body[data-page="warehouse"] 下顶栏与 .result-workspace 使用 display:none !important，仓库列表和结果在右侧切换，左栏一直可用；返回后保留原预览模式。
- 主工作区窄窗布局由 ResizeObserver 按实际宽度切换 narrow-workspace（≤640px），不使用 container-type 尺寸容器；Eagle Chromium 108 中尺寸容器会改变后代 fixed 菜单的定位参照，叠加左栏偏移并裁切菜单。筛选菜单保持窗口坐标，在窗口/工作区调宽及工作区横向滚动后重新定位。
- 主题栏保持紧凑：仅展示主题名、素材/片段数及更新时间，不展示分类名、新增计数和封面说明；不再提供只看新增筛选。封面操作仍在预览中，片段新增标记及存档差异数据保留。
- 外观设置 `theme` 为 `auto`（默认跟随 Eagle）/`dark`（夜间）/`light`（浅色），配置成功保存后立即应用；宿主主题事件仅在 auto 模式决定配色。统一通过根元素 data-theme 与 CSS 变量切换，并同步原生控件 color-scheme；不重建结果或播放器。
- 快捷键在弹窗打开时只响应 Esc；仓库为 Ctrl+B（Ctrl+W 可能被宿主当作关闭窗口）。初始化时窗口可见会主动 showPlugin({fromInit:true})；仅在尚未收到宿主显示事件时跳过随后的一次重复事件，窗口隐藏即取消跳过，关闭重开照常重置范围。窗口尺寸记录 `{width,height,maximized}`，最大化时保留此前普通尺寸，宿主窗口接口 3 秒无响应即放弃恢复。
- 设置页由 `SettingsPanel.FIELDS` 声明控件 id、配置键与类型，打开/保存自动同步；新增设置需同时加 index.html 控件、Config.DEFAULTS（及校验规则）和 FIELDS 一行。

## 右侧详情与预览

- 右侧详情栏统一显示预览、所属主题、全部标签、Eagle星级（只读）和人工分数/相似度、基本信息。双击片段更新，Esc清空预览，列表与详情独立滚动；归属复用TopicRelations快照，主题按钮固定来源库。卡片不再铺开归属文字。接缝通过Pointer Events及pointer capture调宽，保留至少200px结果区，宽度偏好以eagle-semantic-inspector-width保存在localStorage，失败降级为会话内；ResizeObserver限宽但不覆盖偏好，恢复窗口宽度后还原。接缝支持方向键/Home/End，阻止预览切换。筛选、显示、整理所选、主题管理使用互斥菜单，点击外部或Esc关闭。预览仍支持以当前帧找相似及逐帧定位；已移除转文字搜索、画幅控件与快速审片入口，保留历史文字/混合主题和旧审阅字段。
- 「显示 → 预览方式」在右侧素材详情与顶部双击展开预览之间切换，默认右侧，偏好以eagle-semantic-preview-layout保存在localStorage。顶部模式用CSS Grid和display:contents复用同一preview-panel/video，隐藏右栏与接缝，关闭预览后释放高度；不重建结果、不改变选择或播放器状态、不重发搜索。顶部模式暂停计算侧栏宽度，切回时恢复原宽度偏好。
- 顶部预览横向接缝用Pointer Events调整高度并同步缩放画面，偏好eagle-semantic-preview-height保存到localStorage，缩窗限高但不覆盖偏好，至少给结果保留200px；关闭预览或切回右栏时隐藏横线。支持上下键/Home/End，观察工作区与面板尺寸更新限高与aria值。结果栏菜单和普通按钮统一28px，箭头使用5px CSS描边，避免字体符号撑高。
- 预览启动：悬停立即加载，元数据就绪后设置currentTime并立即play，不等seeked或80ms意图等待。双击接管当前同源悬停video，包括在途加载，保留解码器及主播放器音量/静音/速度；从片段开头播放，保留两帧起播偏移，同源不重复赋src。当前大预览卡片不新建悬停解码器。preload=auto，不额外预缓冲；封面复用已加载卡片/Eagle缩略图，已解码同源video移除poster。所有格式双击时都只尝试原文件；连续1.5秒无真实播放推进才load原文件一次，再停滞1.5秒直接报错，不生成替代视频。定位前同步标记seekPending，seeked后重建时间基线；seek跳转、playing/play Promise不能续期或解除检测，真实正向推进才续期，正常播放后仍监测停帧。超时复核实际时间及暂停/结束状态，防止主线程繁忙时媒体事件迟到导致误重载。waiting延迟200ms提示；暂停、结束、关闭、切换、逐帧与错误清理旧等待，加载/重载代次和尝试编号保护迟到回调。失败停止播放器，重试重新初始化。原视频定位/解码仍由浏览器完成，Eagle宿主停帧的具体根因尚未确认，独立窗口结果不能替代宿主验收；保留buffered、seeking、采样时长与媒体推进诊断，采样从首次playing开始计时。
- Chromium 108 的video poster图加载失败也会在video上派发error，此时video.error为空，源视频仍可正常播放。主预览和主题比较onerror必须先检查MediaError，不能把封面失败当作媒体失败；已解码同源播放器展开时移除poster，不再发封面抽帧请求。兼容性验证须覆盖Eagle同版本运行环境及封面失败。

## 拖出与时间线导出

- 外部拖拽使用 Eagle `drag.startDrag(string[])`，在 dragstart 内同步读取已映射真实文件并立即调用，不传缩略图/HTTP URL。缩略图拖完整原视频，已选卡片拖全部选中素材并按路径去重；跨库、映射失效或文件丢失拒绝拖出。只有完整原视频拖出，不提供整段/片段选择、片段目录或准备功能；插件已删除clipUrl/prepareEditClip与目录配置定义，全部预览也禁止视频切片转码。共享后端接口及已有文件保留，不由此插件调用。原生跨应用拖放仍需真实 Eagle / PR / AE 验收。
- 时间线导出只写 FCP7 XML：`end_frame` 为包含帧，xmeml `out` 为不包含帧（end+1）；入出点优先 original_* 原始帧，片段帧率取 match.fps（缺省 25），序列帧率取第一个片段，NTSC 以整数 timebase+ntsc 表示。路径按段 encodeURIComponent，盘符保留。

## 缩略图

- 缩略图统一走 ThumbLoader：HTTP 图片成功解码后保留原始压缩字节的 data URL；完整 URL（服务地址/视频路径/帧号）作键，同 URL 在途共享。主题/搜索重绘不清缓存，命中立即赋 src，未命中懒加载并保持 6 并发。默认 5000 张与 128 MiB 双上限，按 URL/data URL 双字节字符串保守计费，LRU 淘汰；不持有离屏 DOM/解码位图，预算不代表整个进程内存。Config 的 thumbnailCacheMaxEntries（0～50000）/thumbnailCacheMaxMB（0～1024）经设置保存后立即应用、缩小时淘汰，任一为0关闭；重载清空内存缓存；成功解码的图片同时交给 ThumbDiskCache 持久保存（同上限、按文件字节），内存未命中时先读磁盘再请求服务，素材指纹变化即失效；Search.pruneMissingVideos 只删除已不在库中的视频的磁盘预览图。后端磁盘缓存沿用。fetch失败走原生加载及已有备用图，失败不缓存；换页仅取消未开始请求，已开始请求仍占槽直到完成，旧失败不回退。时间/时长及错误消息不可直接插入 HTML。
