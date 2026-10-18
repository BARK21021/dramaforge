# dramaforge 前端完全复刻 app1 — 计划文档

> 起草:2026-07-20 · 分支 `feat/cs-ui-slice`
> 诉求:用户判定 dramaforge 前端"还是不够完整,不能随便砍",要求**完全复刻 F:\app1 的整体业务流程与所有前端界面**。
> 本文是 4 个只读调研 agent 深读 app1 全貌 + 盘点 dramaforge 现状后的**差距清单 + 分批复刻路线图**。

---

## 0. 一句话现状

app1(B/S 单体)核心业务前端约 **12000+ 行**;dramaforge 现有约 **2000 行**;**缺口约 10000 行 / 30-40 个文件**。dramaforge 目前只完成了"骨架 + 主链最小可跑",app1 的**富交互、批量、实时进度、资产深度编辑、生产/成片库**几乎全缺。

落地页 `/` 已是电影级 ✓(Canvas 粒子 + 双层光环 + 视差 + 声波 + 逐字标题),这块**不大改**。

---

## 1. 硬约束与"翻译规则"(先读这段)

app1 是 B/S 单体(全部跑在服务器),dramaforge 是 C/S(web + server + client render-worker)。**"完全复刻"不是照抄代码,是功能/视觉/交互对齐 + 架构翻译**。每条 app1 功能按下表分类:

| app1 功能 | dramaforge 处理 | 依据 |
|---|---|---|
| BYOK:api-configs / ProviderCard / 管理员模型配置卡 / useApiConfigs / isProviderReady | **删除**(保留 ModelSelector 选模型,服务器用云端 key 调) | GC-1 / dramaforge-keys-cloud-server-only |
| 媒体存储:provider/cloud URL 直接显示 | **翻译**:provider URL → 客户端下载落地 `sf-asset://` → server 只存 key + 元数据 | dramaforge-assets-client-local |
| ffmpeg 合片 / export-film(server) | **翻译**:挪到 client render-worker | dramaforge-cs-refactor |
| 模型 catalog(30 模型) | **直接复刻** catalog 结构,dramaforge 已有 lib/models.ts 简化版需扩到完整白名单 | 对齐 app1 |
| 5 阶段工作流编排 / stageStatus 单调持久化 / 多 Tab | **直接复刻**(纯前端逻辑) | 对齐 app1 |
| SSE 实时进度 | **半复刻**:dramaforge 已有 /api/sse + sse-events lib(转发基础),缺 publisher + 前端订阅 | 对齐 app1 |
| 落地页 / 布局 / UI 组件库 / 路由结构 | **直接复刻** | 对齐 app1 |
| signup 手机短信注册 | **待定**(见 §8 决策点) | GC 未禁,dramaforge 现只有 signin |
| admin 用户管理后台 | **待定**(见 §8 决策点) | dramaforge GC-1 平台内部,可能不需要 |

> **媒体客户端落地是全局依赖**:所有"图片/视频显示"在 dramaforge 都要走 `sf-asset://`,否则像现在一样"生成成功但前端显示不了"。这条影响 assets / storyboard / production / 成片库每一批,是最高优先级的横切问题。

---

## 2. app1 全貌(调研摘要)

### 2.1 路由(11 个)

`/`(电影级落地) · `/auth/signin`(账号密码) · `/auth/signup`(手机+短信验证码) · `/workspace`(项目列表,3 分类 Tab) · `/workspace/[projectId]`(项目详情,**3 视图模式:episodes/stage/films**) · `/films`(全局成片库) · `/groups`(全局镜头组库) · `/settings`(AI 模型配置 + 个人设置) · `/admin/users` · `/admin/users/[userId]` · `/payment/return`

### 2.2 全局布局

- **4 层 Provider 嵌套**:AuthProvider → ToastProvider → RechargeProvider → AppShell
- **AppShell** 双分支:auth 页全屏沉浸 vs 工作区侧栏模式
- **AppSidebar**(w-60 + 移动 drawer):5 导航项(工作区 / 成片库 / 镜头组 / 设置 / 用户管理 adminOnly),底部退出 + CreditsBadge sm
- **AppHeader**(h-12 slot 模式):left / right / logoHref / bordered
- **设计令牌双色铁律**:`--accent` 琥珀 `#f59e0b`(品牌/Logo/徽章/进度) vs `--action` 蓝 `#3b82f6`(所有可点击)——**绝不混用**

### 2.3 UI 组件库(18 个)

Toast(4 类型) · Modal(Radix Dialog) · ConfirmDialog(3 变体) · CreditsBadge(30s 轮询 + focus 刷新) · PlatformRechargeModal(4 挡位支付宝) · RechargeProvider(traceId 幂等防重复弹) · Button(5 variant) · Input(Label/Textarea/FormField/prefix/suffix) · Spinner · EmptyState · ProgressBar · StageProgress · ErrorDisplay · ChangePasswordModal · ZoomViewer(全屏 image/video/text) · EditorSurface + CodeTextarea · ProviderBalancePanel(admin) · RedisStatus

### 2.4 分集 5 阶段工作流(EpisodeWorkspace 编排)

- **stageStatus**(后端单调进度,只前进)+ **viewStage**(前端视图,可任意前进后退)+ `furthestStageRef` 跟踪已持久化最远值
- **多 Tab SPA 内部 state**:`openEpisodes[]`(最多 5,超限淘汰)+ `activeEpisodeId` + 各 Tab 独立 viewStage/busy;**所有 Tab 挂载靠 `hidden` 切显隐,状态不丢**;sessionStorage 持久 + URL `?episode=&stage=` 恢复;busy Tab 关闭弹确认
- **阶段切换乐观更新** + 只前进持久化 + 失败回滚(requestId 防过期覆盖)

### 2.5 各阶段功能量

| 阶段 | app1 行数 | 核心能力 |
|---|---|---|
| input | 713 | 文本/视频转剧本双 Tab · Word 上传(import-docx) · 文本转风格 LanguageMenu(海外必选 + 跨集 existingAssets 传递) · 保存并分析进度条(8%→100%) · video-to-script 100MB |
| analyzing | 556 | 重新分析 · 分析增强提示词 · 场景列表(scene) · 信息点(infoPoints) · 造型表(costumeMap) · 原始分析折叠 · EmptyState |
| assets | **2654** | 4 Tab(角色/物品/环境/实体)左右分栏 · AssetCard 单卡(改名/描述/富字段/造型变体 costumes 图生图/音色 VoiceSelector + VoiceBrowserModal) · 批量 7 种(生成当页/全部/重生/彩铅/网格/确认/解锁) · per-asset 配置 · 确认即锁定 · 生成锁持久化 · ZoomViewer |
| storyboard | 688 | 分组算法(>15s 自动拆 / 未编组单成组,与后端 computeGroupsForChain 对齐) · 镜头表格(描述/景别/运镜/时长) · 行内编辑 · 生成/重生 |
| production | **2386** + VideoEditor 491 | 列表/编辑器双视图 · 一键出片(chain-generate) · 智能成组(组提示词编辑器/preview/恢复默认) · 多镜选择(Shift 范围)+ 浮动栏 · 参数弹窗(模板存/导/导、视频参数、串行/并行 fast 并发、强制重生) · ETA 算法 · 串联结果卡 · 批量下载 · 导出成片 |
| 成片库 | 533 | 项目/全局模式分组 · 视频首帧预览(点击播放) · Nuevo 新成片高亮 · 下载/删除 |

### 2.6 模型 catalog(30 模型,6 类)

`F:\app1\src\core\gateway\catalog.ts`(646 行)。文本 8 / 图像 9 / 视频 12 / TTS 2 / Lipsync 2。每条含 pricing + rateLimit + capabilities。**ModelSelector 的 LANGUAGE_MODELS/IMAGE_MODELS/VIDEO_MODELS 是 catalog 的前端白名单子集**(受政策:语言只用 deepseek、生图只 ark/dashscope、生视频只 ark/dashscope)。定价 → 积分换算 `perImage × 1.2 / 0.1`(20% 毛利)。

### 2.7 实时进度(SSE 三件套 + 分层轮询)

- **服务端**:`/api/sse` route(connected + 活跃任务快照 + Last-Event-ID replay + 30s 心跳 + userId 过滤)+ `core/task/publisher.ts`(Redis Pub/Sub `task:events` + task_events 表持久化 + taskId→userId LRU)
- **客户端**:`useSSE`(模块级单例 EventSource + refCount + 指数退避重连 + 200 条缓冲)+ `useTaskStatus`/`useTaskList`(5s 轮询兜底)+ `trackTaskId`/`untrackTaskId`
- **进度组件**:GenerationProgress(单任务,ETA + 取消/重试) · GlobalGenerationStatus(顶部全局条) · ActiveTaskStatusBar(分集级聚合)
- **任务状态机**:PENDING / QUEUED / RUNNING / COMPLETED / FAILED / CANCELLED / TIMEOUT

### 2.8 hooks(13 个,无 SWR/react-query)

全部 `authFetch + useState + useEffect` 手写。关键:useSSE / useTaskStatus / useTaskList / useConcurrencyStatus / useGlobalErrorHandler / useApiConfigs(**dramaforge 删,GC-1**) / useEpisodeApiQueue(按集串行跨集并行) / useGenerationLock(防重,localStorage 3 天) / useStoryboardGenerating / useRecharge / useToast。**无独立 useProject/useEpisode/useAssets**——数据在 page.tsx 内联拉取 + props 下传。

---

## 3. dramaforge 现状(盘点)

**已有页面**:`/`(电影级✓) · signin · workspace 列表 · 项目页(分集列表 + 重命名) · 分集页(5 阶段切换 + model bar + EpisodeTabs) · settings(极简) · `/generate` · `/compile` · `/download` · payment/return

**已有组件**:AppShell/AppSidebar(2 导航)/AppHeader · EpisodeListStage · StageNav · EpisodeTabs · AssetStage(274 行极简) · ModelSelector · Toast/Modal/Button/Input/CreditsBadge/Spinner/cn

**已有 API**:projects + episodes + shots + assets + analyze/generate-storyboard/chain-generate + asset-extraction + generate-image · render-jobs 全套(dispatch/next/progress/result/failed) · **sse + sse-events lib(转发基础在)** · storage/presign · payment · user/balance

**已有 lib**:auth · models(简化) · publish · render-job-guard · response · sse-events · versions

---

## 4. 差距矩阵(按模块)

| 模块 | app1 | dramaforge | 差距 | 复刻动作 | 复杂度 |
|---|---|---|---|---|---|
| 落地页 | 电影级 | ✓ 电影级 | 微调 | CTA/登录态细节对齐 | 低 |
| 设计令牌双色 | accent/action 铁律 | 部分 | 补齐 | globals.css 补 --accent + 全局 audit | 中 |
| AppSidebar | 5 导航 + 移动 drawer | 2 导航无 drawer | 大改 | 补 成片库/镜头组/(用户管理) + drawer | 中 |
| UI 组件库 | 18 个 | 8 个 | 缺 10 个 | 补 ConfirmDialog/EmptyState/ProgressBar/StageProgress/ErrorDisplay/ZoomViewer/RechargeProvider/ChangePasswordModal/RedisStatus/GenerationProgress | 中 |
| workspace 列表 | 分类 Tab + 删除 + artStyle + skeleton + 分集数 | 卡片 + 新建 | 大改 | 补 Tab/ConfirmDialog 删除/artStyle 徽章/EmptyState/skeleton | 中 |
| settings | 富(密码/ProviderCard/GridCard) | 极简 | 中改 | 补修改密码/客户端状态(**GC-1 删 ProviderCard**) | 中 |
| EpisodeWorkspace 编排 | 完整(单调持久/多Tab/busy) | 部分(5阶段切换) | 大改 | 移植 orchestrator + 多 Tab SPA + 持久化 | 高 |
| input | 713 行 | ≈0 | 全缺 | 全新建(双 Tab/Word/转风格/进度条) | 高 |
| analyzing | 556 行 | ≈0 | 全缺 | 全新建 | 高 |
| assets | 2654 行 | 274 行 | 差 10 倍 | 大量移植 | **极高** |
| storyboard | 688 行 | 0 | 全缺 | 全新建 | 高 |
| production | 2386 + 491 | 0 | 全缺 | 大量移植(**ffmpeg 翻译到 client**) | **极高** |
| 成片库 | 533 行 | 0 | 全缺 | 全新建(**媒体落地**) | 高 |
| 模型 catalog | 646 行 30 模型 | 简化几模型 | 扩 | 补完整白名单 + 定价 | 中 |
| SSE | 三件套 + 分层轮询 | 转发基础 | 缺 publisher + 前端订阅 | 补 publisher + useSSE + useTaskStatus + GenerationProgress | 高 |
| hooks | 13 个 | ≈0(内联) | 大缺 | 补 useAuthFetch/useSSE/useTaskStatus/useGenerationLock/useEpisodeApiQueue | 高 |
| /films //groups | 全局库 | 无 | 全缺 | 新建 | 中 |
| Recharge 幂等 | traceId 去重 | 无 | 缺 | RechargeProvider | 中 |

---

## 5. 复刻路线图(10 批,按依赖排序)

> 原则:**基础设施先行(SSE + 媒体落地 + UI 库),再骨架,再各阶段**。assets/production 是两大巨型批次,放最后。
> 每批独立可部署(镜像 tag `rep-N`),用户可中途验证。

### 批次 0 — 基础设施(地基,所有批次依赖)

**目标**:补齐 UI 组件库 + 设计令牌 + catalog + 基础 hooks + SSE 前端订阅。

- 新建:`components/ui/ConfirmDialog.tsx` · `EmptyState.tsx` · `ProgressBar.tsx` · `StageProgress.tsx` · `ErrorDisplay.tsx` · `ZoomViewer.tsx`(全屏 image/video/text) · `EditorSurface.tsx` + `CodeTextarea`
- 扩 `lib/models.ts`:对齐 app1 catalog 白名单(LANGUAGE 2 deepseek / IMAGE 8 / VIDEO 9),补 pricing + capabilities + 积分换算函数 `estimateImageGenerationCredits`
- 新建 hooks:`hooks/useAuthFetch.ts`(401→signin) · `hooks/useTaskStatus.ts`(useSSE 单例 + useTaskStatus + useTaskList + trackTaskId) · `hooks/useGenerationLock.ts`(localStorage 防重) · `hooks/useEpisodeApiQueue.ts`
- 设计令牌:`globals.css` 补 `--accent` 琥珀 + audit 现有组件确保 accent/action 不混用
- 复杂度:**高** · 新增约 12 文件 · 依赖:无

### 批次 1 — 全局骨架 + 列表 + 设置

**目标**:对齐 app1 全局导航 + 项目列表 + 设置。

- AppSidebar 补导航(成片库 / 镜头组 / 设置 / 可选用户管理) + 移动 drawer
- AppShell 补 auth 页全屏分支
- workspace 列表补:分类 Tab + 计数 · ConfirmDialog 删除项目 · artStyle 风格锁徽章 · sourceMode · EmptyState · skeleton · 分集数
- settings 补:修改密码卡 · 客户端连接状态卡(**GC-1: 不做 ProviderCard/api-configs**)
- 落地页 CTA/登录态细节对齐
- RechargeProvider + traceId 幂等 + PlatformRechargeModal 4 挡位
- 复杂度:**中** · 依赖:批 0

### 批次 2 — EpisodeWorkspace 编排核心 + SSE publisher

**目标**:移植 app1 的分集 orchestrator(最关键的编排逻辑)+ 接通 SSE 数据源。

- 新建 `stage-config.ts`(STAGES + stageFromStatus + deriveStageFromEpisode + STATUS_LABELS)
- 重写分集页为 EpisodeWorkspace orchestrator:`viewStage` + `furthestStageRef`(只前进持久化) + 乐观切换 + 失败回滚
- 多 Tab SPA:`openEpisodes[]`(≤5 淘汰) + `hidden` 切显隐(状态不丢) + sessionStorage + URL `?episode=&stage=` 恢复 + busy 关闭确认
- `generation-lock-store.ts` 移植(asset/shot/chain 三类锁,localStorage 3 天 stale,刷新恢复)
- **SSE publisher 接通**:确认 client render-worker 上报 progress → server `publishTaskEvent` 写 Redis `task:events`(dramaforge 已有 sse-events lib,补 publisher 调用点)
- `useEpisodeApiQueue`(同集串行 / 跨集并行)
- 复杂度:**高** · 依赖:批 0

### 批次 3 — input 阶段

- 文本 / 视频转剧本双 Tab(顶部 pill)
- Word 上传:`POST /api/projects/[id]/import-docx`(FormData,.docx ≤20MB,返回纯文本)
- 文本转风格:`POST /api/projects/[id]/text-to-style` + `LanguageMenu`(TARGET_LANGUAGES 区域分组网格,海外 OVERSEAS 必选) + **跨集 existingAssets 传递**(第 N 集传项目已确认资产让模型复用角色名)
- 保存并分析:ProgressBar 8%→100% + `PATCH novelText/scriptData` + `POST analyze`
- 视频转剧本:`POST /api/projects/[id]/video-to-script`(≤100MB) + GenerationProgress taskId
- 复杂度:**高** · 依赖:批 0/2

### 批次 4 — analyzing 阶段

- AnalyzingStage:重新分析(enhancementPrompt) · 分析增强提示词折叠卡 · 场景列表(scene 序号/location/time/角色 chip) · 信息点(infoPoints) · 造型表(costumeMap 表格 rowSpan) · 原始分析折叠(`<details>`) · EmptyState · 只读提示条
- 进度:GenerationProgress(taskId) + 兜底 ProgressBar
- 复杂度:**高** · 依赖:批 0/2

### 批次 5 — assets 阶段(最大批次)

**目标**:把 dramaforge 274 行 AssetStage 扩到对齐 app1 2654 行。

- 4 Tab(角色/物品/环境/实体) + 左右分栏(CharacterSidebar 260px + CharacterEditorPanel,窄屏上下)
- AssetCard 单卡完整:图片区(16:9 + 放大 + 上传) · 改名内联 · 描述编辑 + 富字段(background/voiceTrait/identityLock) · **造型变体 costumes**(非 default 用 default 图作 referenceImageUrl 图生图) · **音色 VoiceSelector + VoiceBrowserModal**(suggested/selected/confirmed_voice 三字段 + 播放) · 操作组(彩铅/网格/锁定开关 + 分辨率 + 生图模型 + 生成/确认/删除)
- 工具栏批量 7 种:生成当页 / 全部生成 / 重新生成 / 一键彩铅 / 一键网格 / 一键确认 / 一键解锁(跳过 regenLocked + 积分预估徽章)
- per-asset 配置(assetImageModels/assetResolutions/assetStyles)
- 确认即锁定(handleConfirmAsset 同时 regenLocked=true)
- ZoomViewer 放大(滚轮/拖拽/左右切换)
- **媒体落地适配**(见 §6):generate-image 返回 provider URL → 客户端下载 `sf-asset://` → PATCH imageUrl
- 复杂度:**极高** · 依赖:批 0/2 + 媒体落地方案

### 批次 6 — storyboard 阶段

- StoryboardStage:`computeGroups` 分组算法(>15s 自动拆 / 未编组单成组,对齐后端 computeGroupsForChain)
- 镜头表格(描述/景别/运镜/时长) + 资产引用徽标(ShotAssetReferenceBadges)
- 行内编辑(Textarea/Input/number) + PATCH shot
- 生成/重新生成分镜按钮 + 三道防线防重(组件 ref + 模块 Set + 后端锁)
- 复杂度:**高** · 依赖:批 0/2

### 批次 7 — production 阶段(第二大批次)

**目标**:对齐 app1 production + VideoEditor,ffmpeg 翻译到 client render-worker。

- 列表 / 编辑器双视图切换
- 一键出片:`POST chain-generate`(已存在 route) + 参数弹窗(模板存/导 JSON + 视频参数 model/resolution/aspectRatio/seed/水印/末帧 + 生成模式串行/并行 fast 并发 1-12 + 强制重生)
- 智能成组卡:组提示词编辑器(EditorSurface + preview API + 恢复默认)
- 多镜选择(Set + Shift 范围) + 浮动操作栏(连续性校验 + 时长档位 + 积分预估)
- ETA 算法(首次检测起始时间 + setInterval + 270s/镜初始估算)
- 串联生成进度卡(SSE stage + 总进度 + stageProgress) + 结果卡(预览 ZoomViewer + 下载 MP4 + 统计)
- 批量下载(循环 fetch currentMaterialUrl)
- VideoEditor 三栏(Shot Explorer / Preview / Inspector) + 脚本面板 + **导出成片**(`POST export-film` → client render-worker ffmpeg 合片)
- GenerationProgress 单镜 + 生成锁(chain/shot key)
- **媒体落地 + ffmpeg 适配**(见 §6)
- 复杂度:**极高** · 依赖:批 0/2 + 媒体落地 + client render-worker

### 批次 8 — 成片库 + 全局路由

- FilmLibraryPanel:项目/全局模式分组(按集/按项目) · 视频首帧预览(preload metadata + 点击 autoPlay) · Nuevo 新成片高亮(scrollIntoView + 5s 清) · 下载(`<a download>`) · 删除(项目模式)
- `/films` 全局成片库路由 · `/groups` 全局镜头组库路由(GroupLibraryPanel)
- 项目详情补 films 视图模式(episodes/stage/films 三视图切换)
- 复杂度:**高** · 依赖:批 7

### 批次 9 — 收尾 + 验证

- GlobalGenerationStatus 顶部全局条(10s 轮询 + SSE)
- ActiveTaskStatusBar 分集级聚合条
- RedisStatusIndicator 顶栏小灯
- biz-ui-scale 业务区文字档位提一级
- 全链路视觉验证(每批已验证,这批总验)
- signup / admin(若用户决定做,见 §8)
- 复杂度:**中** · 依赖:全部

---

## 6. C/S 翻译关键决策(横切,影响 5/7/8 批)

### 6.1 媒体客户端落地(最高优先横切问题)

**现状**:dramaforge generate-image 不落库(只 React state,ARK TOS URL 1h 过期,客户端显示不了——用户已遇到的"图片生成成功但前端不显示")。

**app1 做法**:provider URL 或 cloud storage URL 直接 `<img src>` 显示。

**dramaforge 必须做**(dramaforge-assets-client-local):provider URL → 客户端下载 → `sf-asset://` 本地落地 → PATCH imageUrl/key 到 DB → 前端显示本地。

**影响**:assets(生图)/ storyboard(分镜图,app1 实际无)/ production(视频)/ 成片库(成片)全部依赖。**建议在批次 5 之前先做一个"媒体落地基础设施"小批**(client 侧 download→sf-asset:// + server PATCH route),否则后续批次图片/视频照样显示不了。

### 6.2 ffmpeg 合片挪客户端

app1 `export-film` 在 server 合成;dramaforge 挪到 client render-worker(dramaforge-cs-refactor 已规划)。production 批次 7 的"导出成片"按钮要调 client render-worker,不是 server。

### 6.3 BYOK 全删(GC-1)

api-configs 表 / ProviderCard / useApiConfigs / isProviderReady / 管理员模型配置卡 / api-config test route —— **全部不做**。ModelSelector 保留(用户选模型),服务器用云端 key 调。settings 页不做 ProviderCard 区块。

### 6.4 积分预估

对齐 app1 `estimateImageGenerationCredits`(perImage × 1.2 / 0.1)。批量按钮显示 `{N}积分` 徽章。

---

## 7. 部署节奏

- 每批独立 build → `dramaforge-cs-web:rep-N` → 传服务器 → 留 `prev-rep-N` 回滚锚 → compose up web(绝不 pipe head)→ curl health
- **不在服务器 build**(GC-5,服务器 1.8GB),本地 docker build 后 save|gzip|ssh load
- 分支 `feat/cs-ui-slice`,不碰 main(GC-7)
- 每批 WORKLOG 续 N(GC-6)

---

## 8. 决策结果(2026-07-20 已定)

1. **媒体落地**:✅ **先插批次 0.5**(provider URL → 客户端 `sf-asset://` 本地落地 + server PATCH route),在批次 5 assets 前完成,解决图片/视频显示根因。
2. **signup + admin**:✅ **都补,完全对齐 app1**。signup 接短信网关(阿里云/腾讯云,需用户提供 key 或先用 mock);admin 用户管理后台 + 流水 + 手动充值。各成独立批(批 1.5 signup / 批 9.5 admin)。
3. **批次顺序**:✅ **按 0→9 顺序**(基础设施先行)。
4. **/generate /compile /download 三页**:✅ **删除,全集成进 workspace**(generate→input/production,compile→production,download→成片库)。
5. **模型 catalog 范围**:对齐 app1 白名单(LANGUAGE 2 deepseek / IMAGE 8 / VIDEO 9),只补 dramaforge 云端实际能调的 provider(ark/dashscope/deepseek),catalog 结构对齐 app1 含 pricing + capabilities + 积分换算。
6. **短信网关 key**:signup 批执行前需用户提供阿里云/腾讯云短信 key,或先 mock 验证码(开发期)。

### 调整后的批次序列

`批 0 基础设施`(UI库+catalog+hooks+SSE前端+设计令量)→ **`批 0.5 媒体落地`**(client download→sf-asset:// + server PATCH)→ `批 1 全局骨架+列表+设置` → **`批 1.5 signup`**(手机+短信验证码注册)→ `批 2 编排核心+SSE publisher` → `批 3 input` → `批 4 analyzing` → `批 5 assets` → `批 6 storyboard` → `批 7 production` → `批 8 成片库+全局路由` → `批 9 收尾` → **`批 9.5 admin`**(用户管理+流水+手动充值)

> /generate /compile /download 删除动作并入对应业务批次(批 3/7/8),删前先确认无外部依赖。

---

## 9. 风险

- **工作量巨大**:约 10000 行 / 30-40 文件,assets + production 两批各数千行。需多轮迭代,不能一次成型。
- **C/S 翻译不确定性**:媒体落地 + ffmpeg 客户端化涉及 packages/client 改动 + Electron 重打包,比纯 web 工作量大。
- **SSE publisher 数据源**:依赖 client render-worker 真在跑 + 上报 progress。若 render-worker 未就绪,SSE 接了也没数据(批 2 风险)。
- **视觉验证成本**:CLAUDE.md 强制截图 + 视觉模型。每批都要走 browser-harness 截图验,批次多则验证轮次多。
- **app1 持续演进**:F:\app1 是活的开发副本(非过时 D:\app1),复刻期间 app1 可能再变,需定期 re-diff。

---

## 附:app1 关键文件绝对路径(移植参考)

- 编排:`F:\app1\src\app\workspace\[projectId]\components\EpisodeWorkspace.tsx` + `stage-config.ts` + `page.tsx`
- 阶段:`InputStage.tsx`(713) · `AnalyzingStage.tsx`(556) · `AssetDesignStage.tsx`(2654) · `StoryboardStage.tsx`(688) · `ProductionStage.tsx`(2386) · `VideoEditor.tsx`(491) · `FilmLibraryPanel.tsx`(533)
- 基础设施:`F:\app1\src\core\gateway\catalog.ts`(646) · `F:\app1\src\components\features\ModelSelector.tsx` · `GenerationProgress.tsx` · `F:\app1\src\hooks\useTaskStatus.ts`(SSE) · `useEpisodeApiQueue.ts` · `F:\app1\src\app\api\sse\route.ts` · `F:\app1\src\core\task\publisher.ts`
- 锁:`generation-lock-store.ts` · `storyboard-generating-store.ts`
- 布局:`F:\app1\src\components\layout\{AppShell,AppSidebar,AppHeader}.tsx`
- UI 库:`F:\app1\src\components\ui\*.tsx`(18 个)

> GC-3:app1 只读参考,移植到 dramaforge,**绝不改 F:\app1**。
