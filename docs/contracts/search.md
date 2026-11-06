# 搜索契约：请求、筛选、范围、缓存与组合检索

> 从 AGENT.md「关键契约」拆出。改动这些行为需同步插件与后端，并更新本文件。

## 请求与分数

- 相似度分数 = cosine × logit_scale(≈100)。文本阈值 fgclip2≈11 / clip≈21；视觉检索独立阈值(≈40)+相对落差截断
- 单帧来源经 Search.captureFrame()/CoverFrame.capture() 固定 JPEG，携带 image_base64/source_video_path/source_frame/source_fps/source_name。单帧视觉 recipe.config.visualAgg 固定 max，不改全局设置。后端先排除包含源帧的自身镜头，再相对截断及 Top100。同视频其他镜头保留。
- 找接续画面（2026-11-05）：FrameSearch.continuation 发 kind=`visual`、`payload={video_path,start_frame,end_frame,source_name,source_fps,continuation}`（原始帧，含两端），不截图；后端按 visualSceneFrames 均匀采样、均值池化，只排除与该区间重叠的自身镜头，同视频后续镜头保留。`Config.continuationMode` 为 `end`（片段 original_end_frame 往前 N 秒，不早于片段起点）或 `playhead`（播放头源帧往前 N 秒，不早于 0），`continuationSeconds` 0.2～10，由预览区下拉直接保存。recipe.config.visualAgg 固定 max，不改全局设置；保存为主题后按 sourceItemId 跟随素材移动重放。查询参考区以区间末帧预览图（经 ThumbLoader）显示。只按画面内容匹配，不含运动方向/速度。
- 历史单帧文字主题仍保留 runFrameText 及最终 query/payload 的重放兼容，不重新生成描述。当前页面不再提供描述生成弹窗或触发 /describe。
- 单帧主题保存截图及文本最终查询；sourceVideoItemId 仅用于在素材移动时更新排除路径，来源缺失不阻止已存截图重放；历史 video_path/sourceItemId 查询仍须来源有效。
- 工具栏不提供以 Eagle 选中素材搜相似入口；保留剪贴板以图搜索及已有视觉主题重放。搜索缓存键必须包含 kind/query/payload/config/library/indexNames/allowedVideoPaths，null 整库与 [] 空范围不同，不能仅用显示名称或遗漏起止帧。
- 搜索取消仅取消等待，通过 AbortSignal 与代次丢弃迟到响应；不等同后端推理停止。分组每批60，最高分对整组计算。原视频预览失败可重试，重试重新初始化代次，不再请求转码。
- 文本搜索已移除跨视频去重：设置及主题编辑不再提供该选项，Api.search 不传 use_dedup/dedup_threshold，使用后端默认关闭行为；旧配置字段读取时丢弃，旧主题更新按当前参数白名单忽略。已有主题结果不自动重搜或改写。手动「查重扫描」与拖出文件按路径合并仍独立保留。
- 2026-10-21 按用户要求移除眨眼/运镜专项连续帧核验。所有动作词使用普通文本搜索，不自动改写候选、降低阈值、切换重排或绕过缓存；不展示动作核验报告或证据帧。已有主题完整保留，旧核验元数据不再参与预览定位与展示；后续通用视频动作检索方案须单独确认后接入。

## 本地筛选与范围

- 普通搜索及主题共用结果内组合筛选，Search 的 `archiveFilter={query,source,tags,orientation,maxDur,minScore}` 与全局 sessionScope、时间和 `view.minDur` 取交集。标签按中英文逗号拆分、完整名称忽略大小写且全部满足；画幅读 Eagle width/height，缺失或无效尺寸归 unknown；时长针对片段，边界包含，maxDur=null 不限。manual 以 manualScore 存在判断。筛选只变换显示、清除隐藏勾选，不发搜索或改写 recipe/matches，新增条件不写入持久化 view；组合条件按库和主题在会话保留，独立搜索快照可恢复，新搜索保留当前组合条件、最短时长偏好与本次打开的全局文件夹范围。
- 原“搜索选项”并入顶栏单一“筛选”菜单，新搜索无结果时也可访问；仓库主题使用同一入口，仓库主题列表隐藏素材筛选。新搜索按全库请求，文本请求 threshold 固定为 0，显示阈值、时间及文件夹仅在本地筛选完整返回结果，放宽条件无需重搜；视觉检索仍保留其阈值、相对截断及 Top100 规则。保存新主题时按当前阈值、时间及文件夹补齐 recipe，主题更新仍按已存条件重放。文件夹范围在本次打开内全局共用，Config.setScope 只改内存，保存其他配置时剔除 scope 字段，读取旧配置也重置整库。Search 的 sessionScope 独立于主题筛选和独立搜索返回快照，范围变更即时筛选已有结果、后续搜索前重新解析；null 不限，空 Set 为零显示候选，不改主题 recipe/matches。onPluginShow 显式清除范围，兼容 serviceMode 后台仍存活的关闭重开；换库同样重置。解析校验库/主题/导航代次、范围操作编号及弹窗取消，清除筛选也清除全局范围、时间及本地阈值。菜单固定定位并在打开和缩窗时限于视口，原主题栏时间入口已移入菜单。
- 运镜/景别快捷筛选（2026-11-05）：`#result-tag-chips` 只列当前完整结果中素材已有的 `运镜:*`/`景别:*` 标签（按视频去重计数），点击在 `#result-tags` 中切换该完整标签并沿用原组合筛选，不新增筛选字段。
- 搜索上下文：插件 `resolveSearchScope()` 返回 `{ paths, scope, time, library, config }`；`paths` 为规范化路径 Set 或 null。三个搜索入口保存本次参数，不从后续修改过的配置推测条件。仓库重放通过 Api 的可选 cfg 参数传值，不改写全局配置。
- 文件夹排除：Config.scopeMode 与 recipe.scope.mode 支持 `exclude`，复用 folderIds；指定/跟随范围内追加的右键排除以 Config.scopeExcludeFolderIds / recipe.scope.excludeFolderIds 与基础范围取差集。递归展开所选文件夹，按任一归属取排除并集，再与导入日期求交集。新搜索在全库返回结果上本地取交集；主题更新通过 allowed_video_paths 限制，全部排除保留空 Set，不回退整库。单素材右键排除读取最新 item 与真实文件夹树，父子同时归属只取最深归属，各独立分支由用户选择一个，不按 folders 数组顺序猜测。未分类/失效素材拒绝操作，多素材禁用；只改范围，不改 Eagle 文件夹/原素材/主题。主题已保存的 recipe 仍独立支持范围回填与重放，包含额外排除；既有人工收录片段遵循主题更新的人工保留契约。
- 时间筛选：读取 Eagle `item.importedAt`（毫秒）；不用 modifiedAt、文件时间代替。新搜索在全库返回结果上本地筛选，近 1 年改近 2 年立即展示；主题更新的范围在检索前经 `allowed_video_paths` 限制，空 Set 表示零候选，绝不能退回整库。

## 会话与继续搜索

- 打开第一个仓库主题前保存当前搜索会话（完整结果、查询条件、输入框、视图与勾选）；主题切换和更新不覆盖该快照。「新搜索」恢复同库原会话，不请求搜索服务；成功执行新搜索后丢弃旧返回目标。没有原搜索或库已切换时恢复空页，预览关闭。全局 Esc 使用原生 dialog cancel 流程，不能绕过业务处理中禁止关闭的保护。
- 普通搜索和主题可通过「在结果中搜索」对当前筛选后的全部镜头继续文本语义搜索（含未滚动加载项）。`recipe.refinement={label,scenes,weight}` 固定候选素材 ID/路径、原始帧边界及上一轮分数，不依赖来源主题仍存在；按来源模型查询候选视频，再以 `sceneLookup` 精确取镜头交集。新词请求阈值为 0，缓存原始新词分数，缓存命中后仍重新取交集并加权；更新主题的阈值在加权后执行。weight 为 0～10，0 只用上一轮、10 只用新词，合成分数 `(previous*(10-weight)+current*weight)/10`；每个机器结果的 `refinementScore` 保留两份原分，滑条即时重算显示/排序，人工评分保持原值。成功后成为独立搜索，原主题不写入，失败/取消保留来源；可继续搜索、筛选、整理、保存，保存/复制/备份随 recipe 和 matches 保留候选与权重。连续搜索以上一轮当时的合成分数为旧分；主题更新仅在固定候选内重搜，已失效素材排除，素材移动先按 ID 更新候选路径。主题内拖动权重只改当前浏览副本，保存为新主题保留该权重；编辑原主题条件可修改已存权重。

## AI 改写预览、反馈检索与时序检索（2026-11-05）

- AI 改写预览：设置 `aiPlanPreview` 且 AI 增强开启时，文本搜索先调 `POST /ai_search_plan`（只改写，不扫索引），用户可编辑/删除/补充最多 8 条查询；确认后计划存入 text recipe 的 `payload.aiPlan`，请求以 `precomputed_plan` 发送（后端 `_sanitize_precomputed_plan` 校验后复用，不再调用 AI）。payload 进入搜索缓存键；主题更新按同一计划重放。编辑主题时改了搜索词或 aiEnhance/aiExpand/aiMode，`payload` 置空交回后端重新生成。预览失败按常规流程搜索，取消则不搜索。时序查询不走预览。
- 正负样本反馈：recipe.kind=`feedback`，`payload.feedback={positives,negatives,negativeWeight}`，样例为 `{video_path,itemId,start_frame,end_frame}`（原始帧边界）。`POST /api/v1/search_feedback` 按 (规范化路径, 原始起始帧) 取索引中已存场景向量，Rocchio 合成 `norm(mean(正例) - w*mean(负例))` 后走 `search_by_vector`，排除样例自身、相对落差截断、默认 Top200；正负例各最多 50。入口在「整理所选」：找更像所选的（新反馈）、加入正例并重搜、不要这类重搜（后两者仅当前结果为反馈搜索时显示）。主题更新时 `SearchRecipe.resolve` 按 itemId 更新样例路径，已删除样例丢弃，正例全部失效则报错。
- 时序组合查询：recipe.kind=`sequence`，`payload.sequence={steps:[2～4], maxGap}`，query 为 `steps.join(' → ')`。搜索框输入含 `→` 或 `>>` 即走时序搜索（不弹 AI 预览），「时序」按钮打开步骤对话框，间隔偏好存 `Config.sequenceMaxGap`。`POST /api/v1/search_sequence` 对每步执行普通文本搜索（每步按请求阈值在服务端过滤，前 3000 个候选），同一视频内下一步镜头须在上一步镜头开始之后开始且与上一步结尾间隔 ≤ maxGap 秒；每个第一步镜头贪心选后续每步最高分，结果为第一步开始到最后一步结束的跨镜头片段，分数为各步平均，`sequence` 字段列出各步镜头。新搜索不把时序阈值置 0，本地 minScore 不启用。编辑主题时搜索词按 `→`/`->` 重新拆步骤。

## 检索与整理扩展（2026-11-06）

- 本地筛选新增 `membership=all/uncollected/collected`、`videoLimit=0/1/3/5`、`queryHits=0～8`，随搜索会话与主题浏览位置保存，不加入请求配方。归属按素材身份及原始帧边界精确匹配；未知归属显示等待/错误及重试，不能视作未收录。筛选后每素材按原相似度选前 N 个，再按当前视图排序；缺少 matched_queries 的结果按 0 条命中。隐藏勾选由 render 清理，保存/导出沿用可见列表。
- 「管理检索样例」仅反馈检索显示，可移除正负例、调整 0～1 的负例强度并重新搜索；至少一个正例。提交前检查库与配方，复用原检索配置并按素材 ID 解析样例移动及删除。
- 接续取帧新增 `continuationMode=start`，从原始起帧取设定秒数并截于原始末帧。单独「复核候选开头」用原配方配置及解析后的查询源重新初筛，payload.continuation_review=true，后端能力标记同名。最多复核前 20 个候选开头，每项最多采 3 帧；与源区间均值向量比较，独立 continuation_similarity（余弦×100）与 continuation_rank，不覆盖原 similarity。失败保留候选与原因，未复核项保留初筛顺序。前端提供独立 continuation 排序，主题编辑支持该排序；显式复核跳过普通 SearchCache，服务端分数缓存上限256，包含双方文件指纹、帧范围及帧率、模型和实际维度。抽帧与帧率探测有超时，候选阶段120秒预算；取消仅停止客户端等待。当前仍只比较视觉内容。

## 评测记录（2026-11-05）

- `Search.runCaptured` 成功后派发 `search-complete`（recipe、往返 latencyMs、fromCache、服务端 timings）。`EvalRecorder` 在设置 `evalMode` 开启时写入插件 `evaluation/<日期>.json`（已 gitignore），schemaVersion 1，与 `tools/evaluate-search.js` 兼容：results 为当前显示顺序前 100 个去重片段 ID `素材ID:原始起帧:原始止帧`，judgments 由「整理所选」的「评测：标为相关/不相关」写入当前 case。只记录，不改变搜索或主题。「评测汇总」用同一评估器汇总全部日期文件；「性能自检」只读测量素材清单、路径映射、仓库清单、索引列表和固定词搜索两次（不经插件结果缓存）。
