# 批2 侦察 brief — EpisodeWorkspace 编排核心 + SSE QUEUED 补全

> read-only 侦察产出(2026-07-20)。所有断言标 文件:行号,基于代码事实。
> 业务源:`F:\app1`(只读参考) · `D:\dramaforge-cs`(活体)。本文件是 recon 产出,不是业务代码。

---

## 1. app1 EpisodeWorkspace 全景

### 1.1 文件结构

| 路径 | 行数 | 角色 |
|---|---|---|
| `F:\app1\src\app\workspace\[projectId]\page.tsx` | 781 | **多 Tab 编排器**(项目级):加载 project + 维护 openEpisodes[] + 渲染 EpisodeTabs + 多实例 EpisodeWorkspace(`key={epId}` + `hidden`) |
| `F:\app1\src\app\workspace\[projectId]\components\EpisodeWorkspace.tsx` | 921 | **单集工作流编排器**(每 Tab 一个实例):5 阶段切换 + 数据加载 + SSE 过滤 + busy 上报 |
| `F:\app1\src\app\workspace\[projectId]\components\EpisodeTabs.tsx` | 165 | 多 Tab UI 栏 + 关闭确认 ConfirmDialog(busy 时弹) |
| `F:\app1\src\app\workspace\[projectId]\components\stage-config.ts` | 75 | 共享 5 阶段定义 + `stageFromStatus` / `deriveStageFromEpisode` / `stageOrder` / `STATUS_LABELS`(避免 page ↔ workspace 循环依赖) |
| `F:\app1\src\app\workspace\[projectId]\components\generation-lock-store.ts` | 160 | localStorage 锁 store(`useSyncExternalStore`)— 3 天 stale,防重复生成 |

**关键发现:app1 没有 `episodes/[episodeId]/page.tsx` 子路由**。所有 stage 在 `components/` 下,通过内部 `viewStage` state 切换;多集通过 `openEpisodes[]` + `<div hidden>` 同时挂载多个 EpisodeWorkspace。这是 **SPA 多 Tab** 架构,与 dramaforge 当前 Next.js 多路由方案根本不同。

---

### 1.2 多 Tab 编排(page.tsx)

- **max 同时打开**:`MAX_OPEN_EPISODES = 5`(`page.tsx:49`)。超过则 `next.shift()` 淘汰最早(`page.tsx:350-356`),同步清理对应 ref/缓存。
- **state 结构**:
  - `openEpisodes: string[]`(`page.tsx:94`)— Tab 顺序
  - `activeEpisodeId: string | null`(`page.tsx:96`)— null 表示无激活
  - `episodeViewStageRef: Map<string, StageKey>`(`page.tsx:98`)— 各集当前 viewStage(URL 持久化用)
  - `episodeBusyRef: Map<string, boolean>`(`page.tsx:100`)— 各集 busy(Tab 关闭确认用)
  - `urlInitializedRef`(`page.tsx:88`)— 防止 URL 恢复多次执行
- **增**:`openEpisode(episodeId, initialStage?)`(`page.tsx:345-362`)— 已存在则仅激活,否则追加并激活;`initialStage` 由 `deriveStageFromEpisode(ep.stageStatus)` 推导(`page.tsx:387`)。
- **删**:`closeEpisode(episodeId)`(`page.tsx:365-381`)— 从数组过滤 + 调整激活(切到最后一个)+ 清三个 Map。
- **state 保持**:`<div key={epId} hidden={epId !== activeEpisodeId} className="flex-1 ...">`(`page.tsx:721`)— 每个 Tab 实例都挂载,仅 hidden 切显隐,React state 不丢。
- **stale 清理**:`project.episodes` 变化(删集/重生)时,过滤 `openEpisodes` 中已不存在的 id + 清 ref/缓存 + 调整激活(`page.tsx:449-468`)。

---

### 1.3 stage 推进机制(EpisodeWorkspace.tsx)

**双 state 设计**:
- `episode.stageStatus`(后端 PATCH 写,**单调只前进**):存 DB,反映"用户已到过的最远阶段"。
- `viewStage`(前端 React state,**自由前后切换**):当前 UI 显示哪个阶段。

**3 个 ref 协同**(`EpisodeWorkspace.tsx:338-341`):
```ts
const [viewStage, setViewStage] = React.useState<StageKey>(initialViewStage || "input");
const viewStageRef = React.useRef<StageKey>(initialViewStage || "input");           // 当前显示
const furthestStageRef = React.useRef<StageKey>(initialViewStage || "input");       // 已持久化最远
const stageSaveRequestRef = React.useRef(0);                                         // 防过期覆盖
```

**切换 handler**:`handleStageChange(stage)`(`EpisodeWorkspace.tsx:354-381`)
1. 记 `previousViewStage` / `previousPersistedStage` 快照
2. 立即 `syncStageView(stage)` 乐观更新 viewStage + ref + 通知 page.tsx(URL 持久化)
3. 若 `stageOrder(stage) <= stageOrder(previousPersistedStage)`:**不 PATCH**(回退无需写)
4. 否则 `requestId = ++stageSaveRequestRef.current`,await PATCH `/api/projects/.../episodes/...` body `{ stageStatus: stageToPersist }`
5. **成功**:`furthestStageRef.current = stageToPersist`
6. **失败/被新请求取代**(`requestId !== stageSaveRequestRef.current`):`syncStageView(previousViewStage)` 回滚

**furthestStageRef 自动推进**:`episode.stageStatus` 变化时(`EpisodeWorkspace.tsx:400-405`),若后端值更靠后则同步 ref。允许其他端(成片导出等)推进 stage 不被前端覆盖。

**initialViewStage 同步**:URL 恢复 / popstate 时,父组件改 `initialViewStage` props,本组件 useEffect 推到 viewStage(`EpisodeWorkspace.tsx:384-390`,带 eslint-disable 跳 exhaustive-deps)。

---

### 1.4 URL + sessionStorage 持久化(page.tsx)

**3 处 useEffect 协同**:

1. **从 URL + sessionStorage 恢复 Tab 状态**(`page.tsx:402-445`,只跑一次):
   - `sessionStorage["openEpisodes_<projectId>"]` → JSON.parse → 过滤已不存在的集
   - URL `?episode=...` 若不在 restored 中则追加
   - 为每个恢复的集设初始 viewStage:URL `?stage=` 优先(若合法),否则 `deriveStageFromEpisode(stageStatus)`
   - 激活 Tab:URL 优先,否则 restored 末尾
   - 切 viewMode 到 "stage"

2. **active tab + viewStage → URL**(`page.tsx:471-484`):
   - 监听 `[viewMode, activeEpisodeId]` 变化
   - 拼 `?episode=<id>&stage=<viewStage>`(stage 从 `episodeViewStageRef.current.get(activeEpisodeId)`)
   - `window.history.replaceState(null, "", newUrl)`(不触发 popstate)

3. **popstate → 状态**(`page.tsx:487-512`):
   - 浏览器前进/后退时读 `?episode=&stage=`
   - 该集未打开则打开 + 设 initialStage
   - 激活该 Tab + 设 viewStage + viewMode="stage"

**sessionStorage key 命名**:`openEpisodes_${projectId}`(`page.tsx:338-342`)。**完全在浏览器**(无 SSR 问题)。

---

### 1.5 SSE 集成(EpisodeWorkspace.tsx)

**全局单例 + 按集过滤**:
- `page.tsx:206`:`const { events, connected: sseConnected } = useSSE();` — **单一全局 SSE 连接**
- events 通过 props 透传给每个 EpisodeWorkspace(`page.tsx:727`)
- EpisodeWorkspace 内**只看最近 10 条**(`EpisodeWorkspace.tsx:557`:`events.slice(0, 10)`),检查 `evt.type === "status_change"` + `evt.status` 进入 `COMPLETED/FAILED/CANCELLED/TIMEOUT`(`EpisodeWorkspace.tsx:562-573`)。

**恢复 activeTaskIds**(两套):
1. **项目级**(`EpisodeWorkspace.tsx:463-482`):挂载时 `GET /api/tasks?projectId=...&pageSize=100` → 过滤 `["PENDING","QUEUED","RUNNING"]` → `trackTaskId` + 加入 `activeTaskIds`。
2. **shot 锁级**(`EpisodeWorkspace.tsx:494-532`):从 `useGenerationLocks(prefix)` 拿到本集持久锁 → 对每个 `taskId` 调 `GET /api/tasks/<id>` 检查状态 → 终态清锁 / 活态加入 `activeTaskIds`。

**busy 上报**:`isBusy = activeTaskIds.size > 0`(`EpisodeWorkspace.tsx:595`)→ `useEffect` 调 `onBusyChange?.(episodeId, isBusy)`(`EpisodeWorkspace.tsx:596-598`)→ page.tsx 写入 `episodeBusyRef.current.set(epId, busy)` + 触发 `setEpisodeBusyVersion(v => v + 1)` 重渲染 Tab 栏(`page.tsx:529-532`)。

**shots 防抖刷新**:`scheduleShotRefresh()`(`EpisodeWorkspace.tsx:545-551`)— SSE 收到本集 COMPLETED/FAILED 后 setTimeout 300ms 合并刷新 `loadData()`,避免成组生成连发 N 条事件触发 N 次请求。

**哪些事件触发 stageStatus 变更**:**没有**。stageStatus 仅由用户主动切 stage 时 PATCH(`EpisodeWorkspace.tsx:366-369`)。SSE 事件只影响 `activeTaskIds` 和触发 refetch。

---

### 1.6 API 编排(EpisodeWorkspace.tsx)

**入口**:`api = getEpApi(epId)`(`page.tsx:280-287`)— 用 `epApiCacheRef` 缓存每集绑定的 api 函数,保持引用稳定。

**队列机制**:`useEpisodeApiQueue(api)`(`page.tsx:277`)→ `queuedApi(episodeId, url, opts)` — 同集 Promise 链串行,跨集并行(详见 `useEpisodeApiQueue.ts:34-51`)。

**数据加载序列**(`EpisodeWorkspace.tsx:417-443`):
1. `Promise.allSettled([GET /asset/list?episodeId=, GET /episodes/<id>])`(并行)
2. assets 用 `normalizeWorkspaceAssetsPayload` 归一(支持 7 种字段名:`characters/items/props/environments/locations/voices/entities`,`EpisodeWorkspace.tsx:192-218`)
3. shots 从 `episodeRes.value.shots` 取
4. `loadRequestSeqRef` 防过期响应(`EpisodeWorkspace.tsx:414, 426, 439-442`)

**shot 单镜生成**(`EpisodeWorkspace.tsx:635-667`):
- 检查 `getGenerationLock(lockKey)` → 有锁则 toast.warning 退出
- POST `/api/projects/.../shots/<shotId>` body `{ model, resolution, aspectRatio }`
- 拿 `d.taskId` → `trackTaskId` + 加入 `activeTaskIds` + `setGenerationLock(...)`
- `handleRefresh()` 立即刷一次

**组任务**(`handleGroupTaskCreated`,`EpisodeWorkspace.tsx:670-683`):ProductionStage 批量生成的回调,把同一 taskId 关联多个 shotId 锁。

**错误/重试**:api 封装在 `page.tsx:227-272` 内统一处理 toast + 401 跳 signin + quota 弹 RechargeModal。无自动重试。

---

## 2. dramaforge 现状对照表

| 维度 | app1 | dramaforge | gap | 备注 |
|---|---|---|---|---|
| **入口架构** | SPA 单路由 + 内部 viewMode 切换(`page.tsx:84`) | 多路由:`/workspace/[projectId]`(列表) + `/episodes/[episodeId]`(单集) | **架构不同** | dramaforge 已选 B 方案(多路由,`EpisodeTabs.tsx:14` 注释明示)。保留 |
| **多 Tab SPA** | `openEpisodes[]` + `<div hidden>` 同时挂载 | `<Link>` 跳路由,无内部 Tab state | **架构不同** | dramaforge B 方案:URL 即持久,无 SPA state |
| **EpisodeWorkspace orchestrator** | 921 行单体(`EpisodeWorkspace.tsx`) | **无**(分集页 631 行内联,无封装) | **全缺** | 需要新建 orchestrator 抽象 |
| **stage-config.ts 共享** | ✓ 75 行(STAGES + 4 helper + STATUS_LABELS) | △ StageNav.tsx 内联 `EPISODE_STAGES`(`StageNav.tsx:19-25`,只 key+label,无 helper) | **小** | 抽出共享即可 |
| **viewStage 单 state** | ✓ + ref + furthestRef + saveRequestRef | △ `viewStage` state + `viewStageInitRef`(`episodes/[episodeId]/page.tsx:93-94`) | **中** | 缺 furthest + 乐观/回滚 + ref 守卫 |
| **stage 单调持久(PATCH stageStatus)** | ✓ 前端 `handleStageChange` PATCH | **后端已就绪,前端未调**(`server/.../episode/service.ts:268-275` 实现 `stageOrder >=` 才应用;`web/.../[episodeId]/route.ts:88` 直透 `episodeRepo.update`) | **前端 0 工作量,补调用点** | 单调逻辑在 service 层,前端只需 PATCH 时带 `stageStatus` |
| **URL ?stage= 持久化** | ✓ | ❌(Next.js 路由即 URL,但 stage 不写 query) | **小** | 加 `?stage=` read/write,影响 viewStage 初值 |
| **sessionStorage 持久** | ✓ `openEpisodes_<projectId>` | ❌(B 方案不需要) | **跳过** | URL 即持久 |
| **busy Tab 关闭确认** | ✓ ConfirmDialog | ❌(无 SPA Tab 关闭) | **跳过** | B 方案不需要 |
| **useSSE** | ✓(模块级单例) | ✓ 完整移植(`hooks/useTaskStatus.ts:178-288`,含 refCount + 指数退避 + 200 缓冲) | **就绪** | |
| **useTaskStatus** | ✓ | ✓(`hooks/useTaskStatus.ts:387-468`,含 SSE 触发 refetch + 5s 兜底轮询 + AbortController 防竞态) | **就绪** | |
| **useTaskList** | ✓ | △ **短路** setTasks([])(`useTaskStatus.ts:499-519`,因 dramaforge 无 `/api/render/jobs` 列表端点) | **中** | 批2 要么补列表端点,要么保持短路由 `trackTaskId` 兜底 |
| **useGenerationLock** | ✓ `generation-lock-store.ts` | ✓ 完整移植 `hooks/useGenerationLock.ts`(195 行) | **就绪** | |
| **useEpisodeApiQueue** | ✓ | ✓ 完整移植 `hooks/useEpisodeApiQueue.ts`(70 行) | **就绪** | |
| **trackTaskId/untrackTaskId** | ✓ | ✓(`useTaskStatus.ts:117-137`) | **就绪** | |
| **SSE publisher** | ✓ 三态(RUNNING/COMPLETED/FAILED) | ✓ 双 publisher(web `lib/publish.ts` + server `ai-worker/event-publisher.ts`),**无 QUEUED** | **小** | types.ts 扩字段 + dispatch 调用点 |
| **SSE QUEUED 事件** | ✓ | ❌ | **全缺** | 本 brief 重点 |
| **ActiveTaskStatusBar** | ✓ | ❌ | **跳过(批9)** | REPLICATE-APP1-PLAN.md 列批9 |
| **GlobalGenerationStatus** | ✓ | ❌ | **跳过(批9)** | 同上 |
| **RedisStatusIndicator** | ✓ | ❌ | **跳过(批9)** | 同上 |
| **/api/tasks 列表端点** | ✓ | ❌(只有 `/api/render/jobs/[id]` 单查 + `/next` 认领) | **大** | 影响 activeTaskIds 恢复路径,可由 trackTaskId 兜底 |
| **api 封装(authFetch + quota)** | ✓(page.tsx `api()`) | ❌ 各页内联 fetch(分集页 `fetch()` 无统一封装) | **中** | 批2 抽 `lib/api.ts` 共享 |

---

## 3. 批2 实现要点

### 3.1 EpisodeWorkspace 编排器移植

#### 3.1.1 照搬 app1(视觉/交互)

按 `dramaforge-frontend-align-app1` 硬约束,以下**照搬**:

| 项 | app1 源 | dramaforge 落地 |
|---|---|---|
| 5 阶段进度条样式(蓝激活/绿勾过/灰未来 + 序号圆 + 连接线)| `EpisodeWorkspace.tsx:717-771` | dramaforge `StageNav.tsx:34-91` 已对齐,**已就绪** |
| 底部上一阶段/下一阶段导航条 | `EpisodeWorkspace.tsx:888-917` | dramaforge `episodes/[episodeId]/page.tsx:610-627` 已对齐(简化版) |
| 阶段图标 SVG | `stage-config.ts:20-24` | dramaforge `StageNav.tsx` 暂无 SVG(用 idx+1 数字);可暂保留数字 |
| 阶段 5 个 key+label 枚举 | `stage-config.ts:19-25` | dramaforge `StageNav.tsx:19-25` `EPISODE_STAGES` 已对齐 |

#### 3.1.2 dramaforge 已有,只需接线

- **多 Tab 快捷条**:`EpisodeTabs.tsx` 已实现(`Link` 跳路由版,B 方案),不需要重写
- **5 阶段切换**:`episodes/[episodeId]/page.tsx:783-606` 已实现 5 阶段条件渲染
- **stage PATCH 单调持久(后端)**:`server/.../episode/service.ts:268-275` 已实现;`web/.../[episodeId]/route.ts:61-93` PATCH 直透
- **useSSE + useTaskStatus + useGenerationLock + useEpisodeApiQueue**:**全部就绪**,只是没接到分集页
- **API 队列(同集串行)**:就绪,只是分集页未用

#### 3.1.3 全新建

按 app1 EpisodeWorkspace 移植,**新建以下抽象**:

1. **`stage-config.ts`**(共享,与 app1 同位置):
   - 路径:`packages/web/app/workspace/[projectId]/components/stage-config.ts`(或 `packages/web/lib/stage-config.ts`,与 StageNav 同位)
   - 抽 `STAGES`(带 icon SVG)+ `StageKey` + `stageFromStatus` + `stageOrder` + `deriveStageFromEpisode` + `STATUS_LABELS`
   - 替换 `StageNav.tsx` 内联 `EPISODE_STAGES`,从 stage-config 引入
   - 来源:照搬 `F:\app1\src\app\workspace\[projectId]\components\stage-config.ts` 1:1

2. **`EpisodeWorkspace.tsx`**(orchestrator):
   - 路径:`packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx`
   - props:对齐 app1 `EpisodeWorkspaceProps`(`EpisodeWorkspace.tsx:228-285`),精简掉 dramaforge 不用的(`setPencilPaintingMode` / `gridCells` 等)
   - state:`viewStage` + `viewStageRef` + `furthestStageRef` + `stageSaveRequestRef`(防过期覆盖)
   - 关键 handler:`handleStageChange(stage)` 乐观+回滚+只前进 PATCH
   - **不抽 episodes/[episodeId]/page.tsx 成 app1 那种全嵌套** — dramaforge 保留 page.tsx 作"页外壳",把 stage 编排逻辑封装到 EpisodeWorkspace

3. **`episodes/[episodeId]/page.tsx`** 改造为外壳:
   - 保留:useSession 三态门、URL `?stage=` read/write、useEpisodeApiQueue 装配
   - 删除:内联的 5 阶段条件渲染、`viewStage` 内部 state、StageNav/EpisodeTabs 直接调用
   - 新增:`<EpisodeWorkspace episodeId={} projectId={} api={} events={} ... />` 单实例渲染
   - props 从外壳传入

4. **`lib/api.ts`**(API 封装):
   - 抽 app1 `page.tsx:227-272` 的 `api()` 函数(authFetch + quota + 401 跳 + toast)
   - 路径:`packages/web/lib/api.ts`
   - 复用 `useToast` + `useRecharge`(若 dramaforge 已有 RechargeProvider 则用,否则 quota 部分暂 defer)

#### 3.1.4 B 方案与多 Tab SPA 的取舍

**决策建议(给实现 agent)**:
- **保留 B 方案**(URL = 每集独立路由,刷新页面 URL 持久)。理由:
  1. 用户已明确选过 B(`EpisodeTabs.tsx:14` 注释)
  2. 多 Tab SPA 改造需重写 `page.tsx` + 抽 episodes 子路由到组件,工作量大
  3. dramaforge 多路由优势:URL 可分享/书签
- **放弃的 app1 能力**:多 Tab 同时挂载状态保持、Tab 关闭确认、`openEpisodes[]` sessionStorage 持久
- **替代**:
  - URL `?stage=` query(每集 viewStage 持久):刷新页面 / 分享 URL 时 stage 不丢
  - 各集内 stage 推进 + busy 状态仍然内联

---

### 3.2 SSE QUEUED 补全方案

#### 3.2.1 现状

| 项 | 位置 | 当前 |
|---|---|---|
| Redis 频道 | `task:events`(frozen) | web/server 双端硬编码 |
| web publisher | `packages/web/lib/publish.ts:28` | `publishTaskEvent(payload: unknown)` |
| server publisher | `packages/server/src/ai-worker/event-publisher.ts:33` | `publishTaskEvent(payload: TaskEventPayload)`,payload 严格类型 |
| 调用方(server) | `ai-worker/processor.ts:61, 83, 100` | 3 处:RUNNING / COMPLETED / FAILED |
| 调用方(web) | `app/api/render/jobs/[id]/{progress,result,failed}/route.ts` | 3 处:RUNNING / COMPLETED / FAILED |
| **status 类型** | `ai-worker/types.ts:128` | `'RUNNING' \| 'COMPLETED' \| 'FAILED'`(**无 QUEUED**) |
| dispatch.ts | `server/src/task/dispatch.ts:50/64/79/91` | 4 函数仅 `renderJobRepo.create(...)`,**零 SSE** |
| dispatchAiTask | `dispatch.ts:109` | 仅 `addJob(...)`,**零 SSE** |
| 调用方 dispatch | web `/api/render/dispatch/route.ts:120/125/130` + `/api/projects/.../chain-generate/route.ts:95` | 不发 SSE,客户端拿 `renderJobId` 后只能等 result/failed 路由上报 |

#### 3.2.2 方案选型

**方案 A(server 端,推荐)**:在 `server/src/task/dispatch.ts` 4 函数里发 QUEUED
- 改 `ai-worker/types.ts:125-133`:`status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'`
- 改 `dispatch.ts`:每函数 `renderJobRepo.create` 成功后 `await publishTaskEvent({ taskId, userId, status: 'QUEUED', type })`
- import 路径:`from '../ai-worker/event-publisher'`(**相对路径**,绕过 `ai-worker/index.ts:51` 的 worker-bootstrap 副作用)
- 同时给 `dispatchAiTask`(`dispatch.ts:109-117`)补一个 QUEUED(addJob 成功后)
- 优点:**单一变更点**;所有调用方(web `/api/render/dispatch` + chain-generate route + 未来直接调 dispatch 的)自动覆盖;类型安全
- 缺点:server/task 新增对 server/ai-worker/event-publisher 的依赖(无环,event-publisher 只依赖 infra.getRedis)

**方案 B(web 端)**:每个 route handler 自己发
- 改 web `/api/render/dispatch/route.ts:120/125/130` 三分支 + `chain-generate/route.ts:95` 各加一行 `publishTaskEvent(...)`
- 缺点:分散,易漏;web 这边 publish 是 unknown payload,无类型保护

**结论:方案 A**。一处改,所有入口受益,类型安全。

#### 3.2.3 QUEUED 事件载荷

```ts
// 推荐形状(扩 TaskEventPayload)
{
  taskId: string,         // render_jobs.task_id(也是 dispatch 入参 taskId)
  userId: string,
  status: 'QUEUED',
  type: RenderJobType | AiTaskType,  // 'CONCAT'|'CHAIN_COMPILE'|'SPLIT_BY_DURATION'|'SPLIT_EVENLY'|'LONG_VIDEO_REWRITE' | 13 种 AiTaskType
  // 可选,后续补
  projectId?: string,
  episodeId?: string,
}
```

- 类型扩展建议:`TaskEventPayload.status` 改联合加 `'QUEUED'`;新增可选 `type?: string` 字段(避免硬绑 RenderJobType,保持兼容)。
- payload JSON 序列化后走 `redis.publish('task:events', ...)`,SSE route 透传给前端。

#### 3.2.4 前端能否消费

**可以,但需要 minor 调整 useSSE 优先级**:

- `useTaskStatus.ts:212-215` 把 `event.type === "status_change" || "error" || "output"` 列为高优先级,其他走 progress 分支(满 120 时淘汰)
- QUEUED 事件如果走 `publishTaskEvent({ ..., status: 'QUEUED' })` 而**没有 `type` 字段**,useSSE 会当 progress 处理,缓冲满时可能被淘汰
- **两个改进选项**:
  1. dispatch 发 QUEUED 时同时带 `type: 'status_change'`(语义上 QUEUED 也是状态变更)— 推荐,零前端改动
  2. 改 useSSE 优先级判断:`event.type === "status_change" || event.status === "QUEUED" || ...`

- useTaskStatus(`useTaskStatus.ts:459-465`)收事件后 `events[0].taskId === taskId` 即 refetch。**QUEUED 会触发 refetch `/api/render/jobs/[id]`**,届时 job 已是 PENDING 状态,前端能拿到。

#### 3.2.5 落地清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/server/src/ai-worker/types.ts:125-133` | `status` 联合加 `'QUEUED'`,新增 `type?: string` 可选字段 |
| 2 | `packages/server/src/task/dispatch.ts:24` | 加 `import { publishTaskEvent } from '../ai-worker/event-publisher';` |
| 3 | `packages/server/src/task/dispatch.ts:50-57`(dispatchFilmExport) | create 成功后 `await publishTaskEvent({ taskId, userId, status: 'QUEUED', type: 'CONCAT' }); return job;` |
| 4 | `packages/server/src/task/dispatch.ts:64-73`(dispatchVideoSplit) | 同上,type 动态计算(`'SPLIT_BY_DURATION'` / `'SPLIT_EVENLY'`) |
| 5 | `packages/server/src/task/dispatch.ts:79-85`(dispatchChainGenerate) | 同上,type: `'CHAIN_COMPILE'` |
| 6 | `packages/server/src/task/dispatch.ts:91-97`(dispatchLongVideoRewrite) | 同上,type: `'LONG_VIDEO_REWRITE'` |
| 7 | `packages/server/src/task/dispatch.ts:109-117`(dispatchAiTask) | addJob 成功后 `await publishTaskEvent({ taskId, userId, status: 'QUEUED', type: jobName })` |
| 8 | `packages/server/test/task/dispatch.test.ts` | 4 个 test 加断言:`expect(publishTaskEventMock).toHaveBeenCalledWith({ taskId, userId, status: 'QUEUED', type })` |
| 9 | (可选)`packages/web/hooks/useTaskStatus.ts:212-215` | 优先级判断加 `|| event.status === 'QUEUED'` |

#### 3.2.6 风险点

- **dispatchAiTask 当前 return `Promise<string>`**(`addJob` 返回 BullMQ Job ID),不是 RenderJob。QUEUED 事件的 taskId 来自入参(不是 jobId),要小心区分。前端 trackTaskId 应跟踪 taskId(dispatch 入参),不是 BullMQ jobId。
- **循环依赖**:server/task → server/ai-worker/event-publisher → server/infra(getRedis),无环。
- **测试隔离**:`test/task/dispatch.test.ts` 当前 mock 了 `renderJobRepo`,需要新增 mock `publishTaskEvent`(同 `processor.test.ts:30` 的 `publishTaskEventMock` 模式)。
- **production render-worker 行为**:QUEUED 发出后,客户端 render-worker 还没认领(job 还在 PENDING)。前端 useTaskStatus refetch 拿到 PENDING 状态是正常的。接下来 progress route 上报 RUNNING → COMPLETED/FAILED。**完整事件序列**:`QUEUED(dispatch) → RUNNING(progress route 首次) → COMPLETED(result route)/FAILED(failed route)`。
- **ai 任务也走 QUEUED**:`dispatchAiTask` 入队后 ai-worker 消费时再发 RUNNING(`processor.ts:61`)。链路:`QUEUED(dispatchAiTask) → RUNNING(processor.ts:61) → COMPLETED(processor.ts:83) / FAILED(processor.ts:100)`。

---

## 4. 批2 实现步骤建议(可派给单 agent 的粒度)

### 步骤 A — stage-config 共享抽离(小,2-3h)
1. 新建 `packages/web/lib/stage-config.ts`(照搬 app1 `stage-config.ts:1-75`)
2. 改 `StageNav.tsx` 引入 `STAGES` / `StageKey`,删内联 `EPISODE_STAGES`
3. 改 `episodes/[episodeId]/page.tsx` `deriveViewStage` 改引 `deriveStageFromEpisode`
4. 跑 `pnpm -w build` + `pnpm -w test` 确保绿

### 步骤 B — SSE QUEUED 补全(中,4-6h)
1. 改 `packages/server/src/ai-worker/types.ts:125-133` 扩字段
2. 改 `packages/server/src/task/dispatch.ts` 5 函数(详见 §3.2.5 清单)
3. 改 `packages/server/test/task/dispatch.test.ts` 加 mock + 断言
4. (可选)改 `packages/web/hooks/useTaskStatus.ts:212-215` 优先级
5. 跑 `pnpm --filter @dramaforge/server test`

### 步骤 C — lib/api.ts API 封装抽取(中,3-4h)
1. 抽 app1 `page.tsx:227-272` 的 `api()` 函数到 `packages/web/lib/api.ts`
2. 改 `episodes/[episodeId]/page.tsx` 用 `api()` 替换内联 `fetch`(8 处)
3. 接 `useEpisodeApiQueue` 装配 `getEpApi`
4. 改 EpisodeListStage、AssetStage 等其他组件也走 `api()`
5. 跑 build + 手测分集页 5 阶段

### 步骤 D — EpisodeWorkspace orchestrator 新建(大,1-2 天)
1. 新建 `packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx`
2. 照搬 app1 的:`viewStage` state + 3 ref + `handleStageChange` 乐观/回滚 + `syncStageView` + initialViewStage 同步 useEffect
3. props 接口对齐(精简 dramaforge 不用的)
4. 把 `episodes/[episodeId]/page.tsx` 内联的 5 阶段条件渲染移入 EpisodeWorkspace
5. page.tsx 改为外壳:加载 episode → 渲染 `<EpisodeWorkspace ... />`
6. 接 useSSE 把 events 透传
7. 接 useGenerationLocks(prefix) 恢复 shot 锁(若 shot 生成用,批6 才有;此处只接通接口,先空跑)

### 步骤 E — URL ?stage= 持久化(小,2-3h)
1. `episodes/[episodeId]/page.tsx` 加 useEffect:`viewStage` 变化 → `window.history.replaceState` 写 `?stage=`
2. 加 useEffect:挂载时从 `useSearchParams()` 读 `?stage=`,作 `initialViewStage` 透传给 EpisodeWorkspace
3. popstate 处理(可选,Next.js useSearchParams 通常自动)
4. 手测:刷新页面后 stage 保持

### 步骤 F — 阶段切换 PATCH stageStatus(小,2-3h)
1. EpisodeWorkspace `handleStageChange` 调 `PATCH /api/projects/.../episodes/...` body `{ stageStatus: stageToPersist }`
2. 单调推进由后端 `episode/service.ts:268-275` 保证(已就绪)
3. `loadEpisode` 重拉后 `furthestStageRef` 推进(详见 app1 `EpisodeWorkspace.tsx:400-405`)

### 步骤 G — 验证(1-2h)
1. `pnpm -w build` + `pnpm -w test`
2. `pnpm --filter @dramaforge/server test`
3. 手测:dev server → 进分集 → 切 stage → 刷新 → stage 保持
4. 手测:创建 chain-generate job → 看 SSE 事件流(浏览器 devtools Network → EventStream)应看到 `QUEUED → RUNNING → COMPLETED`

**建议派工**:
- 步骤 A+B+C 可并行(独立)
- 步骤 D 依赖 A+C
- 步骤 E+F 依赖 D

---

## 5. 风险/坑

### 5.1 stage 切换 PATCH 竞态
- **场景**:用户快速切 input→assets→storyboard,3 个 PATCH 同时飞
- **app1 防护**:`stageSaveRequestRef.current = ++requestId`,旧请求 resolved 时检查是否最新,不是则忽略(`EpisodeWorkspace.tsx:363, 373, 377`)
- **dramaforge 注意**:必须照搬此机制,不能简化为 `await PATCH then setViewStage`(否则旧请求 resolved 时会覆盖新 viewStage)

### 5.2 多 Tab 状态丢失(dramaforge B 方案特有)
- **场景**:用户在集 A 的 analyzing 阶段,点 EpisodeTabs 切到集 B,再切回 A — Next.js 路由切换会重挂载,A 的内部 state(viewStage / activeTaskIds)全丢
- **缓解 1**:URL `?stage=` 让 viewStage 至少能从 URL 恢复
- **缓解 2**:useTaskStatus 的 `trackTaskId` 是模块级 Set,跨路由切换不丢,SSE 重连后能补 activeTaskIds
- **缓解 3**:Next.js 16 App Router 默认有 client-nav 缓存(Back/Forward 时保留 state)— 但点 Link 跳新路由不保留
- **不可恢复**:本地 `viewStage` 自由切换(用户从 analyzing 退到 input 看剧本)— URL 不写则丢
- **决策**:URL `?stage=` 始终写(用户切换即更新 URL),刷新/分享都能恢复

### 5.3 SSE 事件与轮询重复
- **现状防护**:useTaskStatus 在 `connected === true` 时不启 setInterval(`useTaskStatus.ts:453`)
- **新风险**:dispatch.ts 发 QUEUED 后,若 useTaskStatus 立即 refetch 拿到 PENDING → 又因 SSE 在线不启轮询 → 等 progress route 上报 RUNNING 才再 refetch。中间窗口(QUEUED → RUNNING)前端 UI 显示的是 PENDING,正常。
- **不一致风险**:web lib/publish.ts 和 server event-publisher.ts **载荷形状不一致**(web unknown,server 严格 TaskEventPayload)。SSE route 透传时按 userId 过滤(`sse/route.ts:79-82`),如果 server publisher 忘记带 userId,前端就收不到。**dispatch.ts 改时务必带 userId**。

### 5.4 URL ?stage= 的 SSR / hydration 问题
- **dramaforge page 是 `"use client"`**(无 SSR 渲染),理论上无 hydration mismatch
- **但**:`useParams()` 在 hydration 前后可能不一致 → `viewStage` 初值需要 ref 守卫(类似现有 `viewStageInitRef`,见 `episodes/[episodeId]/page.tsx:94, 124-127`)
- **建议**:URL 读 → state 的 useEffect 加 `viewStageInitRef` ref 守卫,只在首次执行;后续 URL 变化由 popstate 处理

### 5.5 ai-worker import 副作用
- `ai-worker/index.ts:51` 顶层 `import { createAllWorkers, shutdownWorkers } from './worker-bootstrap';` — 若被 web bundle 拖入,会创建 BullMQ Worker
- **dispatch.ts 改造必须用相对路径** `from '../ai-worker/event-publisher'`,**不能** `from '../ai-worker'`(走 barrel)
- **验证**:`pnpm --filter @dramaforge/web build` 后 grep bundle 不应含 `createAllWorkers`

### 5.6 TaskEventPayload 类型扩字段不向后兼容
- 加 `'QUEUED'` 到 status 联合,**向后兼容**(联合扩展)
- 加 `type?: string` 可选字段,**向后兼容**
- 前端 `TaskEvent` interface(`useTaskStatus.ts:43-76`)已支持任意 status 字符串,无需改

### 5.7 dispatchAiTask taskId 来源
- `dispatchAiTask` 入参 taskId 是调用方传入(web route genId 生成),不是 BullMQ jobId
- QUEUED 事件必须用入参 taskId,**不要**用 `addJob` 返回值(BullMQ Job ID)
- 否则前端 `trackTaskId(knownTaskId)` 监听不到

### 5.8 stage-config 共享位置循环依赖
- 若放 `components/stage-config.ts`,可能被 hooks/ 引入 → `hooks/ → app/workspace/.../components/` 不正常
- **建议放** `packages/web/lib/stage-config.ts`(纯 lib,任何位置都能引)

### 5.9 useTaskList 短路 vs 真实端点
- 当前 dramaforge `useTaskList` 短路返空(`useTaskStatus.ts:499-519`),不发包
- app1 EpisodeWorkspace 用 `GET /api/tasks?projectId=...&pageSize=100` 恢复 activeTaskIds(`EpisodeWorkspace.tsx:467`)
- **批2 决策**:
  - 选 1:补 `/api/render/jobs` 列表端点(中等工作量,需 server 加 query + web 加 route)
  - 选 2:**跳过项目级恢复**,只靠 `trackTaskId`(模块级 Set 跨页面持久)+ `useGenerationLocks(prefix)` 恢复 shot 锁
  - **推荐选 2**:批2 范围太大,列表端点可推到批3。靠 trackTaskId + URL `?stage=` + 用户手动重切 stage 兜底

### 5.10 dispatch.ts 异步签名变更
- `dispatchVideoSplit` / `dispatchChainGenerate` / `dispatchLongVideoRewrite` 当前是同步函数声明返回 Promise(`dispatch.ts:64, 79, 91`,无 `async`)
- 加 `await publishTaskEvent(...)` 需要改成 `async function`
- **影响**:函数签名 `(... ) => Promise<RenderJob>` 不变(本来就是 Promise),调用方无需改
- **测试**:`test/task/dispatch.test.ts` 已 `await dispatchXxx(...)`,兼容

---

## 6. 总结

### 批2 实现核心
1. **新建 EpisodeWorkspace orchestrator**(~400 行精简版,app1 921 行砍掉 pencil/grid 等不相关 props)
2. **stage-config.ts 共享**(照搬 app1 75 行)
3. **lib/api.ts 封装**(抽 app1 page.tsx 的 api 函数)
4. **URL `?stage=` 持久化**(每集 viewStage 持久)
5. **stage PATCH 单调持久**(后端就绪,前端补调用点)
6. **SSE QUEUED 补全**(types.ts 扩字段 + dispatch.ts 5 函数调 publishTaskEvent)

### 已就绪(批0 移植,直接用)
- useSSE / useTaskStatus / useTaskList(短路)/ trackTaskId
- useGenerationLock / generation-lock-store
- useEpisodeApiQueue
- StageNav.tsx / EpisodeTabs.tsx
- PATCH `/api/projects/.../episodes/...` stageStatus 单调持久
- Redis `task:events` 双 publisher(web lib/publish + server event-publisher)
- SSE route(`/api/sse` 订阅 + userId 过滤 + 30s 心跳)

### 跳过(批9 范围)
- ActiveTaskStatusBar / GlobalGenerationStatus / RedisStatusIndicator(顶栏组件)
- `/api/tasks` 列表端点(批3 或更后)
- 多 Tab SPA 状态保持(B 方案保留,不做)

### 关键架构决策
- **B 方案**(Next.js 多路由)而非 SPA 多 Tab — 用户已选,保留
- **server-side SSE publisher**(dispatch.ts 内调)而非 web-side — 单一变更点
- **dispatch.ts 用相对路径** import event-publisher — 绕 ai-worker barrel 副作用
