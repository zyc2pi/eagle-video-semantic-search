# 索引与搜索服务契约：命名、任务、清理、生命周期、配置

> 从 AGENT.md「关键契约」拆出。后端修改须同时阅读后端仓库 AGENT.md，改后端 Python 后需重启 5006。

## 索引身份与任务

- 插件用 `GET /api/v1/index/jobs?summary=1&library_id=…` 读取任务摘要，恢复与提交前检查保留状态及清理所需字段。列表请求留 30 秒供服务冷读磁盘历史，单任务轮询仍为 5 秒。展开历史任务时用单任务接口读取逐文件结果；不传 `summary=1` 的列表保留完整格式。后台任务恢复错误记录到控制台，侧栏索引提示由覆盖查询更新。

- 设置页「索引覆盖清单」按当前库、所选模型读取索引，关联 Eagle 当前视频显示未处理、跳过、失败、已索引及已处理但状态未知；优先级沿用 indexed → skipped → failed → processed。列表每批100条，可在 Eagle 全部中定位；具体原因沿用原任务记录，旧服务缺失分类时显示可取得的信息。

- 索引命名升级为 `indexes/<模型>/eagle_v2_<库UUID>_<模型>.lance`；先由 `Bridge.resolveLibraryIdentity()` 调用后端注册表，再按 library_id 精确查询（API 的 name 包含 `.lance`）。提纯插件使用相同协议，提交 library_path 必须取当前 Eagle 路径，不能用登记 canonical 路径代替。旧索引保留只读；离线工具迁移或新身份重建，绝不按同名库自动认领。
- 索引按 job_id 串行轮询，5 秒请求超时、2～30 秒退避；掉线是未知状态，禁止重复提交。提交超时保留原请求幂等键；重载后恢复本插件活动任务。设置页任务历史可定向取消/失败重试。5006 health protocol_version=2，safe_index_import/export=false，在线直接压缩/覆盖已移除；后端离线维护工具持有独占锁并保存回滚记录。
- 索引列表提供 `revision: string|null`；搜索缓存键包含对应版本及服务地址，缺版本时禁缓存，缓存 5 分钟到期且读取不续期。历史失败项重试接入 Indexer 监视，全部终态、服务切换/重连清缓存；覆盖查询失败是未知状态，不能视为空库或触发自动索引。
- 索引代表帧：插件 `indexFrameSelection` 默认 `content_adaptive`，可选 `triplet` / `dinov3_cses`，经 `/index.options.frame_selection` 传给后端。内容模式复用现有FG-CLIP2/CLIP特征，按代表性、最远点覆盖及时间平局规则选实际帧，余弦距离≤0.02时提前停止；`indexContentMaxFrames`→`content_max_frames` 默认12、范围1～32，无新增解码或推理。提交前分别检查health的 `capabilities.content_adaptive_frames` / `smart_frame_selection`，旧服务不静默忽略。DINOv3仅选帧，最终仍存当前检索模型向量；三种模式保持原镜头边界，按feature_count兼容旧schema，不自动重建已有素材。更多向量可能增加索引/搜索成本、改变max/mean和去重结果，真实质量未测评。`dinov3-cses`工具模型不出现在检索模型下拉。
- 镜头切分（2026-11-05）：插件 `indexShotDetection` 默认 `cosine`（原余弦极小值）；`transnetv2` 时 `/index.options.shot_detection='transnetv2'`，提交前检查 health `capabilities.transnetv2_shots`（只看权重文件），默认值不发送该字段以保持旧请求一致。后端 `transnet_shots` 以 ffmpeg 逐帧 48×27 流式解码，按官方 100 帧窗口/步长 50 推理，阈值 0.5 得到镜头，再映射到已采样帧（单采样帧短镜头并入前一场景，被过滤黑场的镜头丢弃），之后的短镜头合并、代表帧选择与向量编码不变；切分失败回退余弦，不中断索引；取消仍为“当前视频完成后停止”。权重 `models/transnetv2/transnetv2-pytorch-weights.pth` 固定 SHA256（首次加载校验、`torch.load(weights_only=True)`），由后端 `tools/prepare_transnetv2.py` 显式下载；模型代码原样引入 `A_coreUtils/video_processing/transnetv2_model.py`（MIT，许可证见 `licenses/TransNetV2-MIT.txt`）。只影响之后新索引的视频；真实素材上的切分质量与耗时未测评。

## 全库清理与确认

- 全库索引要求 health.capabilities.library_prune：后端按完整 Eagle 路径清单清理当前库所有模型/维度的 v2 索引与处理结果清单，重置共用可重建预览图/临时预览片段，保留其他 temp 工作产物。成功终态由插件重新读取完整素材清单，按 ID（旧数据回退路径）清理有效主题、人工排除、继续搜索候选及内存会话，更新素材移动路径与主题 revision。保留人工评分/审阅、独立截图、回收站、所有历史备份、跨库导入快照和只读旧索引；清理写入专门跳过历史淘汰。视频查询来源缺失保存 sourceMissing，重新选择来源时解除。主题写入失败单独提示，不能用局部失败项重试的路径子集执行 prune；已完成全库清理的失败任务重试成功后继续清理主题。Lance 为逻辑删除，历史物理数据由离线维护处理。
- 全库索引（all/rebuild）提交前经 `Indexer.start(mode, handlers, { beforeSubmit })` 交由 plugin.js 核对：`Warehouse.previewPrune` → `ArchiveStore.previewMissingVideos` 只读统计将被清理的活动片段；每库上次确认的视频数存于 localStorage `eagle-semantic-library-video-counts`。清单为 0 或（上次≥20 且）少于上次 70% 视为骤减；按钮触发在骤减、有主题片段将被清理时确认，Ctrl+I 一律确认，自动索引骤减直接放弃。完成后 `pruneMissingVideos(library, { expectedCount })` 再次读到骤减清单时跳过主题清理并报错，后端索引清理以提交时确认的清单为准。

## 索引管理（2026-11-05）

- `GET /api/v1/index/stats?library_id=` 只读统计当前库各模型 v2 索引（含 `_d<N>` 维度变体）：场景/视频/向量数（只读 video_path/feature_count 列）、磁盘占用、skipped/failed 数、最近版本时间、revision；单个索引读取失败返回 error 字段不影响其他。`POST /api/v1/index/trash {library_id,name,confirm:true}` 把该索引目录及 skipped/failed 清单移到 `indexes/.trash/<时间戳>_<模型>_<名称>`，不物理删除；索引任务排队或运行中返回 409，非当前库或旧索引返回 404；成功后清空进程特征缓存。`.` 开头的目录不视为模型目录（/indexes 列表与预热跳过）。插件设置页「索引管理」展示统计并经确认删除，成功后清空插件搜索缓存。health `capabilities.index_admin`。

## 服务生命周期与安全

- 插件以普通窗口模式按需加载，`keepAlive` 缓存已经打开过的窗口。Eagle 的 `onPluginShow` 或可见窗口收到的 `onPluginRun` 触发连接或启动 Python。首次开窗错过显示事件时，页面加载后的运行事件仍能启动服务。隐藏页面收到的运行事件跳过启动。
- 模型冷启动期间隐藏再打开，同一端口继续等待本插件已启动的进程。若改端口后启动了多个实例，退出时关闭所有本插件持有的输入管道。宿主 BeforeExit 与页面卸载都立即发起释放。

- 改后端 Python 后必须重启 5006 服务（POST /api/v1/shutdown 再拉起）才生效
- `text_search.py` 接受 `--port/--host`（默认 127.0.0.1:5006，安全起见不再绑 0.0.0.0）；两插件拉起时都传 `--port`
- 搜索插件拉起服务时传 `--plugin-stdin` 并保留专用输入管道：关窗/隐藏时暂停自动索引和健康轮询，保留模型30秒；期间重开取消释放，不重复加载模型；超时仍未重开则关闭管道。重复隐藏事件不延长原倒计时。插件真正退出/重载时立即关闭管道，renderer 崩溃也会产生 EOF；后端在重型导入前监听，取消排队和活动索引，最多15秒收尾后结束本服务及其子进程。释放已开始时重开等待旧进程退出后按需加载，避免两个实例重叠。只控制本插件启动的实例，连接其他消费者已启动的共享服务时不强杀。Windows 另以 `--eagle-host-pid` 绑定主进程兜底；未传管道选项的其他启动方式仍按 Eagle 生命周期运行，手动独立启动且无 Eagle 祖先时不受影响；health.eagle_host_pid 可核对绑定。
- 关闭 5006 使用启动时生成的 `state/search-control-<port>.json` 凭据及 `X-Eagle-Control-Token`，不从 health 返回令牌；默认 loopback 的请求来源、Host、Origin 必须通过校验。凭据不可读时明确报错，不自动降级无授权关闭。发行包排除 state、个人根配置/备份/日志并使用无个人信息的默认配置模板。
- 配置验证、临时文件替换完成后才更新内存；失败抛错并通知 UI。损坏原件只能在明确恢复操作下另存备份后替换，不记录密钥值。配置备份同样必须排除打包与 Git。
- 迭代记录与后续方向见 ROADMAP.md
