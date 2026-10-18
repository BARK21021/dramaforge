# 分集生命周期 + 实时进度(inline-task 范式)设计

> **日期**:2026-08-07  **状态**:已与用户对齐设计,待 spec 复核 → 转实施计划
> **起源**:用户 4928「分镜设计分析不出来」排查(见对话)定位到 analyze/generate-storyboard 同步阻塞路由的系统性缺口;用户要求根治并改进前端。
> **约束**:AGENTS.md H3(前端流程级照搬 app1,视觉/交互可改——本次 UX 改动用户显式授权)、§3(别自作主张加严)、§5(真生成需云端 key,本地只验结构/契约,冒烟须桌面端)、§6(闭环:bug 变守卫)。

---

## 1. 问题陈述

`POST /analyze`(编剧分析)与 `POST /generate-storyboard`(分镜生成)当前是**同步阻塞 HTTP 路由**:`callAI` 在 web 进程内同步等待,前端 `await api()` 阻塞到返回。由此产生一组相互关联的症状:

| 症状 | 根因(已核实到行) |
|---|---|
| 无实时进度条 | 路由不建 task 行、不发 SSE 事件;前端只靠 `await` + `useInFlightGeneration` 8s 轮询。`StoryboardStage.tsx:972` 进度是二态 `progress={justCompleted?100:0}`,代码自承「当前接口无中间百分比」。 |
| 切集丢稿 | `InputStage.tsx:159` `scriptDraft` 是纯 `useState`;切集走 `router.push`(`EpisodeWorkspace.tsx:702-706`)全树卸载,无 autosave/draft 存储。 |
| 「进了分析界面实际还在输入」desync | `EpisodeWorkspace.tsx:665-667` `effectiveStage` 在 `episode.status==='ANALYZING'` 时把 analyzing 重映射回 input 渲染,但 URL/`EpisodeTabs:696-697` 仍显示 analyzing → URL/Tab/Body 三方打架。 |
| 卡死 `stageStatus='analyzing'` | analyze `:128-131` 置 ANALYZING 后同步等 callAI;调用挂死超 web ~5min requestTimeout → 请求被 reset → stageStatus 永留 analyzing(4928 魔校法则 1 集实证)。 |
| 失败也扣费 | `analyze:185-190` / `generate-storyboard:318-323` 在 `callAI` 返回后、**parse/校验之前**就 `billDirectGeneration`。LLM 吐空 → 用户被扣 credits 零产出。 |

代码自述缺口:`useInFlightGeneration.ts:9-13` 头注释——「P7.3/P7.4 rush 砍了这套,同步直连路由只在 HTTP handler 里 block,刷新页面=丢 in-flight 状态」。

## 2. 目标 / 非目标

**目标**
1. analyze 与 generate-storyboard 走 inline-task:建 task 行 + 后台执行 + SSE 发分阶段实时进度。
2. 三处(InputStage 侧栏 / AnalyzingStage / StoryboardStage)同源实时进度条,永远在动。
3. 切集/刷新/导航不丢 in-flight 状态与未保存草稿。
4. 真正进入 AnalyzingStage(消 desync),且分析界面进度条与输入界面同等效力。
5. 后端根治:校验后扣费、callAI 超时、stageStatus 必复位、孤儿任务 sweep。
6. 「保存并分析」按钮挪到右侧常驻侧栏。

**非目标**
- 不改 stage 流程本身(input→analyzing→assets→storyboard→production 一一对应 app1,H3 不变)。
- 不动 BullMQ 异步路径(EPISODE_SPLIT/video-async/chain),不改计费总账结构。
- 不解决根因上游(DeepSeek 偶发空输出)——本设计让失败可见、不误扣、可重试,模型侧另案。

## 3. 架构决策:inline-task + fire-and-forget

**选型**:保留路由在 web 进程,但 `startInlineAiTask` 建 task 行后**不 await 业务**,把 callAI 循环丢后台跑,路由立即 `return { taskId }`。

**为什么不阻塞**:阻塞 = 同步等 callAI = 踩 web ~5min requestTimeout reset = 卡死 analyzing 的直接成因。立即返回 = 请求秒级结束 = 绕开 reset。后台 promise 在 `next start` 长驻 Node 进程里继续(dramaforge 非 serverless)。

**为什么不全异步(BullMQ)**:用户选轻量改。全异步要把 analyze 的 `buildScriptAnalysisPrompt/parseScriptResult/validateAnalysisConsistency` 与 storyboard 的 `postprocessStoryboardShots/replaceEpisodeShots` 事务都搬进 ai-worker handler,跨进程拆分 storyboard 后处理复杂度高、回归面大。inline-task 复用现成 `GenerationProgress` 组件 + `useTaskStatus`,范围最小。

**妥协与兜底**:web 重启会杀掉 in-flight 后台 promise → 孤儿 task。靠 §4-B2 `reapStuckEpisodes` sweep(60s)把超 `timeoutAt` 的 inline task 标 FAILED + 复位 stageStatus,用户重试。task 行内置 30min `timeoutAt`(startInlineAiTask:254),sweep 有据可依。

**现成可复用基础设施(均已核实存在)**:
- `startInlineAiTask` / `reportInlineAiTaskProgress` / `completeInlineAiTask` / `failInlineAiTask`(`packages/server/src/task/ai-task-repo.ts:239/283/312/339`)。
- `startProgressHeartbeat`(`packages/server/src/ai-worker/handlers.ts:130`,长 LLM 调用保活进度,EPISODE_SPLIT 在用)。
- SSE 全链路:`publishTaskEvent`→Redis `task:events`→`/api/sse`→`useSSE()`/`useTaskStatus(taskId)`,带 Last-Event-ID 重放 + 活跃任务快照。
- 前端:`GenerationProgress`(`packages/web/components/features/GenerationProgress.tsx:144`,已接 SSE+ETA+取消/重试)、`ProgressBar`、`ActiveTaskStatusBar`。

## 4. 后端改动

### B1. 扣费移到校验之后(资损止血)
- `analyze/route.ts`:把 `billDirectGeneration`(`:185`)从循环内 callAI 之后移到**parse+`validateAnalysisConsistency` 通过、即将持久化之前**(成功路径)。空内容/拆不出场景/不一致重试耗尽 → 不扣费。
- `generate-storyboard/route.ts`:把 `billDirectGeneration`(`:318`)移到 `parseStoryboardShots` 非空、`replaceEpisodeShots` 之前。`AI_EMPTY`/`AI_NO_SHOTS` → 不扣费。
- 语义:用户零产出零付费。空响应平台 cost 通常 ≈0;非零也由 dramaforge 吃(可接受,优先正确性)。

### B2. inline-task 化 + 卡死防治
**analyze 改造**(generate-storyboard 同形):
1. 预检(ownership/余额/文本长度)不变。
2. **去重**:若该 episode 已有 active STORY_ANALYZE task(RUNNING)→ 直接返回其 `{ taskId }`(幂等,防双击双扣)。
3. `const taskId = crypto.randomUUID();` → `await startInlineAiTask({ id:taskId, userId, projectId, type:'STORY_ANALYZE', progress:5, stage:'编剧分析', storedInput:{ episodeId, projectId } })`。
4. 置 `episode.status=ANALYZING, stageStatus='analyzing'`。
5. **fire-and-forget**:`void runAnalysis(taskId, …)`(不 await)。
6. `return apiSuccess({ taskId }, 202)`。

**响应契约变更**:analyze 从 `200 { episode, scriptData }` → `202 { taskId }`;generate-storyboard 从 `200 { shots, … }` → `202 { taskId }`。前端不再从响应拿结果,改由 SSE COMPLETED 事件触发 `onRefresh({force:true})` 重拉落库后的 episode/shots(F5/F6)。`lib/analysis-workflow.ts` 的 `runAnalysisWorkflow` 同步改造:不再 `await` 拿结果,只发起 + 返回 taskId 交由 SSE 驱动后续。

`runAnalysis`(后台):
- 各阶段 `reportInlineAiTaskProgress`:5 准备→15 构造提示词→30「AI 生成中」→70「校验一致性」→90「落库中」→(complete)100。
- callAI 外包 `AbortController`(timeout,文本类建议 6min,>单次 DeepSeek 典型时长 +余量;挂死即 abort → 走失败路径)。
- `startProgressHeartbeat` 在 callAI 期间持续推进(照搬 handlers.ts 模式),进度条永不静止。
- 成功:`completeInlineAiTask(taskId, userId, { episodeId, sceneCount })` + 持久化 scriptData/scenes + `status=COMPLETED, stageStatus=assets` + B1 扣费。
- 失败(空/解析失败/不一致/超时/gateway):`failInlineAiTask(taskId, userId, 安全文案)` + `stageStatus='input'`(复位,不锁死)+ **不扣费**。
- `finally`:确保 stageStatus 终态化(成功→assets / 失败→input),绝不留 analyzing。

### B3. 孤儿任务 sweep(闭环守卫,§6)
- 新增 `episodeRepo.sweepStuckAnalyzing()`(借宿 ai-worker 已有的 sweep 调度点,60s):扫 `stageStatus='analyzing'` 且关联 task 已终态(FAILED/COMPLETED)或过 `timeoutAt`(30min)的 episode → 复位 `stageStatus='input', status='PENDING'`。幂等(只动 analyzing)。对齐 `renderJobRepo.sweepStuckShots()` 范式。
- 保留 `split/route.ts:45` 的 `EPISODE_BUSY` 409(防拆集与分析并发);B3 sweep 保证它不会被卡死集误触发。
- 已知坑对照:`docs/known-issues/chain-fakedeath.md`「运维裸 SQL 绕 G3-1 级联」同款铁律——任何让 stage 停在 analyzing 的路径(含 fire-and-forget 被 web 重启杀)都由 sweep 兜底,最多滞后 60s。

## 5. 前端改动

### F1. 右侧常驻侧栏(InputStage 重排)
- `InputStage.tsx`:由 `max-w-4xl mx-auto` 单栏 → 双栏(grid/flex)。左=剧本编辑器(可滚),右=`sticky top-…` 操作面板:模型选择 ▾ / 扣费提示 / 实时进度(`GenerationProgress`)/ 「保存并分析」按钮。
- 响应式(默认决策,用户未否决):窄视口(<lg)降级为视口底部 sticky 横栏(进度条 + 按钮),避免挤压编辑器。
- 按钮从 `:770-805`(编辑器下方)移入侧栏;原位置移除。

### F2. 草稿持久化(切集不丢)
- `scriptDraft` 从 `useState("")`(`InputStage.tsx:159`)→ 按 episodeId 的 draft store:module-level `Map<episodeId,string>` + localStorage 镜像 key `draft:${projectId}:${episodeId}`(照搬 `InputStage.tsx:217-242` video-upload-store 保活模式)。
- mount:有 draft 取 draft,否则取 `episode.novelText||content||videoScriptDraft`(`:259-263` 逻辑保留)。
- 编辑:debounce 写 localStorage + 更新 Map。
- 保存并分析成功 → 清该 episodeId draft(已落库,防 stale 覆盖)。

### F3. 三处同源实时进度
- **taskId 传递(两路)**:
  - 触发点击:POST 响应(202 `{ taskId }`,见 B2)直接给 taskId → 立即写 localStorage key `task:${type}:${episodeId}`(与 F2 draft store 同生命周期)→ `GenerationProgress taskId={taskId}` 绑定。
  - 刷新/直接进 ANALYZING(内存 taskId 丢失):从 localStorage 读 `task:${type}:${episodeId}` → `useTaskStatus(taskId)` 校验:仍 RUNNING → `GenerationProgress` 接管;已 COMPLETED/FAILED/404 → 丢弃 key,按服务端 stageStatus 正常渲染。
  - 不依赖 SSE 快照的 `task.input` 字段(`/api/tasks/[taskId]` 剥 input 防流量,快照是否含 input 未证实);如后续确认快照含 input,可加 episodeId 交叉校验作增强,非必需。
- 新 hook `useEpisodeTask(episodeId, type)`:封装上述「localStorage 取 taskId + useTaskStatus 校验」逻辑,返回 `{ taskId|null, status, progress, stage }`。
- `GenerationProgress`:`onComplete`→`onRefresh({force:true})` + 清 localStorage task key;`onFailure`→提示可重试(保留 key 供重试时复用 taskId?否——重试发新请求得新 taskId,失败即清 key)。
- `AnalyzingStage.tsx:722-736` 的 pulse-only `ProgressBar` 换成 `GenerationProgress`;`StoryboardStage.tsx:972-992` 二态进度同换。

### F4. 真正进入 AnalyzingStage(消 desync)
- 删除 `EpisodeWorkspace.tsx:665-667` 的 `effectiveStage` 重映射:`status=ANALYZING && viewStage==='analyzing'` → 真渲染 `AnalyzingStage`(带 F3 进度条),不再强制回 input。
- `EpisodeTabs`(`:696-697`)当前集徽标改用服务端 `episode.stageStatus`(真相源)而非本地 `viewStage`,消除 URL/Tab/Body 三方不一致。
- StageNav 高亮随之对齐。

### F5. 保存并分析自动跳转
- `handleSaveAndAnalyze`(`InputStage.tsx:368-457`):PATCH 存稿 → POST /analyze 拿 `{ taskId }` → `onNavigateNext('analyzing')`(已有,`:810`)→ AnalyzingStage 挂载 + `GenerationProgress` 绑 taskId 走实时进度。因 taskId 真实、AnalyzingStage 真渲染,无 desync。

### F6. 分镜进度同源
- generate-storyboard 同 B2 inline-task 化;`StoryboardStage` 的 `runGenerate`(`:699`)/`handleGenerate`(`:749`)取 `{ taskId }`,绑 `GenerationProgress`。删二态进度。

## 6. 数据流(成功路径)

1. 用户编辑文本(F2 持久化 draft),点侧栏「保存并分析」(F1)。
2. InputStage PATCH 文本 → POST /analyze。
3. 路由:预检 → 去重 → `startInlineAiTask` → 置 ANALYZING → `void runAnalysis()` → `return { taskId }`(202)。
4. InputStage 拿 taskId → `onNavigateNext('analyzing')` → AnalyzingStage 挂载,`GenerationProgress taskId` 绑定(F3/F5)。
5. 后台 runAnalysis:`reportInlineAiTaskProgress` 分阶段 + heartbeat → SSE → 进度条实时走(F3 永远在动)。
6. 成功:`completeInlineAiTask` + 持久化 scenes + stageStatus→assets + B1 扣费(校验后)。SSE COMPLETED → `onComplete`→`onRefresh`→ AnalyzingStage 展示结果。
7. 失败:`failInlineAiTask` + stageStatus→input + 不扣费。SSE FAILED → 进度条转可重试。
8. web 重启杀后台 → B3 sweep 60s 内复位 stageStatus + 标 task FAILED → 用户重试。

## 7. 诚实的限制

单次 LLM 调用内部无法给 0–100% 平滑百分比(模型不报进度)。「实时进度」= **分阶段实时**(准备→AI生成中→校验中→落库中)+ 阶段间 heartbeat 驱动的平滑过渡。与 chain/EPISODE_SPLIT 同上限。进度条永远在动(heartbeat),不再出现「转圈无进度」。

## 8. 测试 / 验证

- **结构/契约(本地可验)**:4 包 `pnpm -r typecheck`;路由单测:
  - analyze:校验失败(空/解析失败/不一致)→ 不调 billDirectGeneration、stageStatus 复位 input、failInlineAiTask 发 FAILED 事件。
  - analyze:成功 → billDirectGeneration 在持久化前、completeInlineAiTask、stageStatus→assets。
  - 去重:active task 存在 → 返回同 taskId 不新建。
  - B3 sweep:analyzing + task FAILED/超时 → 复位 input(幂等)。
  - generate-storyboard:AI_EMPTY/AI_NO_SHOTS → 不扣费、fail、复位。
- **真生成(须云端 key,本地不可验,§5)**:进度条实时跳动、切集不丢稿、真进 AnalyzingStage、分镜实时进度——由用户桌面端冒烟。
- **回归守卫**:B3 sweep 加单测;路由扣费顺序加断言单测(防 B1 倒退)。

## 9. 上线

- server:`bash /d/dramaforge-cs/scripts/deploy.sh <tag>`(web + ai-worker;含 B3 sweep 借宿 ai-worker)。本批零迁移(无 schema 变更,inline-task 用现有 tasks 表 + 已有 timeoutAt 列)。
- 不需要 client 发版(纯 web 改动;Electron 壳加载 web)。若侧栏/进度 UI 需客户端视觉确认,走桌面端刷新 web 即可。
- 回滚:`bash scripts/rollback.sh`(镜像回滚,无迁移风险)。

## 10. 待复核默认决策(用户未明确否决即按此落地)

1. **fire-and-forget**(立即返回 taskId、后台跑、web 重启靠 B3 sweep 兜底)——inline-task 给实时进度的唯一实现方式。
2. **失败不扣费**(B1)——用户零产出零付费。
3. **窄屏降级**(<lg 视口侧栏塌缩为底部 sticky 横栏)。
