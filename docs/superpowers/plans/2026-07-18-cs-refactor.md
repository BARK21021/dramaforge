# DramaForge C/S 重构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务逐个实现。步骤用 `- [ ]` 复选框跟踪。每个模块任务派一个子 agent；主 agent 负责串联（Task 0 + Task 9）与每批次 git 提交。

**Goal:** 把 D:\app1（B/S）重构成 D:\dramaforge-cs（C/S 分层 monorepo）：服务器只跑 AI+调度，ffmpeg 全挪到 Electron 桌面客户端，主流程（剧本→资产→分镜→生成→合片）跑通，3 运维骨架就位。

**Architecture:** 方案 A 薄壳——桌面 App(Electron) 加载云端界面 your-domain.example.com + 本机 ffmpeg；浏览器备用。服务器 web+ai-worker+pg+redis+minio，**不装 ffmpeg、不在服务器 build**。客户端 HTTP 拉 render-job（PG `render_jobs` 表，`FOR UPDATE SKIP LOCKED` 原子认领）→本机 ffmpeg→上传 MinIO→回传。

**Tech Stack:** TypeScript(strict)、Node.js、Next.js(web)、BullMQ(队列)、pg(手写封装，无 Prisma)、Redis、MinIO、Electron(客户端壳)、ffmpeg(客户端)、pnpm workspaces、vitest、bytenode(客户端保护)。

## Global Constraints（每个任务隐含遵守）

- **AI key 只在服务器**；客户端不持有任何 AI key。
- **服务器禁跑 ffmpeg、禁在服务器 build**（1.8GB OOM 根因）。服务器 worker **禁 import 任何 ffmpeg 模块**。
- **3 运维骨架必做**：心跳+版本上报+断代强制淘汰、静默下载器、本地日志+懒上报。
- 源项目 **D:\app1 保持不动**，仅作代码移植来源。
- **TS strict**，**无 Prisma**（手写 pg + 幂等 SQL 迁移），BullMQ，NextAuth(Credentials+JWT)。
- **每子 agent 批次完成后由主 agent git 提交**（保回滚）。用 git 前先 `$env:Path = "C:\Program Files\Git\cmd;" + $env:Path`（Machine PATH 里坏盘 F:\Git 会抢占，见 WORKLOG）。
- **npm 走 npmmirror**（`--registry=https://registry.npmmirror.com`）；GitHub 慢可设 `$env:HTTPS_PROXY="http://localhost:7890"`。
- 内部公司用，your-domain.example.com HTTPS；Windows x64 客户端优先。

---

## File Structure（monorepo，锁定分解）

```
D:\dramaforge-cs\
├─ package.json                 # 根，pnpm workspace 入口，scripts: typecheck/build/test
├─ pnpm-workspace.yaml          # packages: ['packages/*']
├─ tsconfig.base.json           # strict，paths: @shared/* @server/* @client/*
├─ .gitignore                   # 已建
├─ ../../archive/WORKLOG.md                   # 已建，边做边写
├─ packages/
│  ├─ shared/                   ①
│  │  ├─ src/render-job.ts      # RenderJobType/Status/Input variants/Result/Progress 契约
│  │  ├─ src/client-api.ts      # Heartbeat/UpdateCheck/ClientLogBatch 请求响应
│  │  ├─ src/version.ts         # isVersionBelow() 断代比较
│  │  ├─ src/long-video-plan.ts # 从 app1 移植，client-safe（纯类型/计划，无 ffmpeg/DB）
│  │  ├─ src/utils.ts           # 纯工具（id 生成、重试退避、url 解析）
│  │  └─ src/index.ts           # 桶导出
│  ├─ server/                   服务器
│  │  ├─ db+config/             ⑦
│  │  │  ├─ src/pg.ts           # pg Pool 封装 + query/transaction
│  │  │  ├─ src/migrations/     # 0001-init.sql...（含 render_jobs 表）
│  │  │  ├─ src/env.ts          # Zod 校验 env
│  │  │  ├─ src/redis.ts        # ioredis 单例
│  │  │  ├─ src/auth.ts         # NextAuth config（Credentials+JWT）
│  │  │  └─ src/migrate.ts      # 幂等迁移执行器
│  │  ├─ gateway/               ② AI 网关（13 provider，从 app1 移植）
│  │  ├─ domain/                ③ 计费/并发/存储/工作流/提示词/分镜/资产
│  │  ├─ task/                  ④ BullMQ 队列 + render-job 派发（新）
│  │  │  ├─ src/queues.ts       # 4 队列定义
│  │  │  ├─ src/render-job-repo.ts  # render_jobs CRUD + claimNext()(FOR UPDATE SKIP LOCKED)
│  │  │  └─ src/dispatch.ts     # 任务→render_job 派发逻辑
│  │  ├─ web/                   ⑤ Next.js 界面 + API（去 ffmpeg + 加 render/client 接口）
│  │  │  ├─ app/api/render/jobs/next/route.ts        # GET 原子认领
│  │  │  ├─ app/api/render/jobs/[id]/progress/route.ts
│  │  │  ├─ app/api/render/jobs/[id]/result/route.ts
│  │  │  ├─ app/api/render/jobs/[id]/failed/route.ts
│  │  │  ├─ app/api/client/heartbeat/route.ts
│  │  │  ├─ app/api/client/logs/route.ts
│  │  │  ├─ app/api/client/update/route.ts
│  │  │  └─ app/...             # 界面（从 app1 移植，去 ffmpeg 依赖）
│  │  └─ ai-worker/             ⑥ BullMQ worker（纯 AI 任务，禁 ffmpeg）
│  └─ client/                   桌面 App
│     ├─ ops-heartbeat/         ⑬ 心跳+版本+断代锁死
│     ├─ ops-updater/           ⑭ 静默下载器
│     ├─ ops-logger/            ⑮ 本地滚动日志+懒上报
│     ├─ ffmpeg/                ⑧ ffmpeg 管线（从 app1 core/video/ffmpeg-pipeline.ts + grid-overlay.ts 移植）
│     ├─ render-worker/         ⑨ HTTP 拉 render-job→跑 ffmpeg→上传
│     ├─ orchestrators/         ⑩ CHAIN_GENERATE/LONG_VIDEO_REWRITE 编排
│     └─ shell/                 ⑪ Electron BrowserWindow + preload IPC
├─ docker-compose.yml           ⑫ web/ai-worker/postgres/redis/minio（无 ffmpeg）
├─ deploy.sh / rollback.sh      ⑫ 本地 build→save→ssh load→migrate→up
└─ electron-builder.yml         ⑫ 客户端打包（含 ffmpeg 二进制 + bytenode）
```

---

## 执行批次（依赖排序，比 spec 的"②-⑪全并行"更现实）

- **Batch 0**：Task 0 骨架（主 agent）
- **Batch 1**（① 完成后，依赖 ①）：Task 1 ①shared — **必须最先**
- **Batch 2**（依赖 ①，三者并行）：Task 2 ⑦db+config、Task 3 ⑧client/ffmpeg、Task 4 ⑬⑭⑱ops
- **Batch 3**（依赖 ⑦，三者并行）：Task 5 ②gateway、Task 6 ③domain、Task 7 ④task
- **Batch 4**（并行）：Task 8 ⑥ai-worker（依赖 ②③④）、Task 9 ⑨render-worker（依赖 ⑧）
- **Batch 5**（并行）：Task 10 ⑤web（依赖 ②③④⑥⑦，托管 ⑬⑭⑱端点）、Task 11 ⑩orchestrators（依赖 ⑧⑨）
- **Batch 6**：Task 12 ⑪shell（依赖 ⑨⑩⑬⑭⑮）
- **Batch 7**：Task 13 ⑫集成串联（主 agent）

> 每批完成后主 agent `git commit`，再开下一批。子 agent 拿到的是自己任务的 brief + spec 路径 + app1 源路径 + 它依赖模块的接口签名（见各任务 Produces/Consumes）。

---

## Task 0: Monorepo 骨架（主 agent）

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `packages/shared/package.json`, `packages/server/package.json`, `packages/client/package.json`, 各包 `tsconfig.json`、`src/index.ts` 占位
- Create: `.npmrc`（`registry=https://registry.npmmirror.com`）

**Interfaces:**
- Produces: pnpm workspace 可识别 3 个包；`@shared/*` `@server/*` `@client/*` path alias 可用；`pnpm install` 成功；`pnpm -r typecheck` 跑通（空包）。

- [ ] **Step 1: 写根 package.json**
```json
{ "name": "dramaforge-cs", "private": true, "packageManager": "pnpm@9",
  "scripts": { "typecheck": "pnpm -r typecheck", "build": "pnpm -r build", "test": "pnpm -r test" } }
```
- [ ] **Step 2: 写 pnpm-workspace.yaml**：`packages: ['packages/*']`
- [ ] **Step 3: 写 tsconfig.base.json**（strict, composite, paths 三个 alias）
- [ ] **Step 4: 写 .npmrc**（npmmirror）
- [ ] **Step 5: 各包 package.json + tsconfig + src/index.ts 占位**
- [ ] **Step 6: `pnpm install` 验证 workspace 可用**
- [ ] **Step 7: `git commit -m "chore: monorepo skeleton"`**

**Acceptance:** `pnpm -r typecheck` 通过；3 个包互相 `import '@shared/...'` 不报错（占位导出）。

---

## Task 1: ① shared 层（契约+类型+纯工具）— 最先做

**Files:**
- Create: `packages/shared/src/render-job.ts`, `client-api.ts`, `version.ts`, `long-video-plan.ts`, `utils.ts`, `index.ts`
- Test: `packages/shared/test/*.test.ts`

**Interfaces:**
- Consumes: 无（最底层）
- Produces: 所有其他模块依赖的契约。**必须先定死，后续不得擅自改名。**

- [ ] **Step 1: 写 render-job.ts 契约（失败测试先行）**

```ts
// packages/shared/src/render-job.ts
export type RenderJobType =
  | 'CONCAT' | 'EXTRACT_FRAME' | 'SPLIT_BY_DURATION'
  | 'SPLIT_EVENLY' | 'CHAIN_COMPILE' | 'LONG_VIDEO_REWRITE';
export type RenderJobStatus = 'PENDING' | 'CLAIMED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface ConcatInput { clips: { url: string; durationSec?: number }[]; outputUploadUrl: string; }
export interface ExtractFrameInput { videoUrl: string; atSec: number; outputUploadUrl: string; }
export interface SplitByDurationInput { videoUrl: string; durationSec: number; outputPrefix: string; }
export interface SplitEvenlyInput { videoUrl: string; segments: number; outputPrefix: string; }
export interface ChainCompileInput { groupResults: { url: string }[]; outputUploadUrl: string; }
export interface LongVideoRewriteInput { videoUrl: string; segments: number; outputUploadUrl: string; }

export type RenderJobInput =
  | ConcatInput | ExtractFrameInput | SplitByDurationInput
  | SplitEvenlyInput | ChainCompileInput | LongVideoRewriteInput;

export interface RenderJobResult { outputUrl?: string; outputs?: string[]; durationSec?: number; meta?: Record<string, unknown>; }

export interface RenderJob {
  id: string; taskId: string; userId: string;
  type: RenderJobType; status: RenderJobStatus;
  input: RenderJobInput; result: RenderJobResult | null;
  claimedBy: string | null; error: string | null;
  createdAt: string; claimedAt: string | null; completedAt: string | null;
}

export interface RenderJobProgress { progress: number; stage: string; }
```

- [ ] **Step 2: 写 client-api.ts**

```ts
// packages/shared/src/client-api.ts
export interface HeartbeatRequest { version: string; os: 'win' | 'mac' | 'linux'; machineId: string; }
export interface HeartbeatResponse { status: 'ok' | 'force_upgrade'; minVersion: string; latestVersion: string; downloadUrl: string; }
export interface UpdateCheckRequest { version: string; os: 'win' | 'mac' | 'linux'; }
export interface UpdateCheckResponse { latestVersion: string; downloadUrl: string; force: boolean; }
export interface ClientLogEntry { ts: string; level: 'info' | 'warn' | 'error'; msg: string; }
export interface ClientLogBatch { machineId: string; taskId?: string; logs: ClientLogEntry[]; }
```

- [ ] **Step 3: 写 version.ts（断代比较，TDD）**

```ts
// packages/shared/src/version.ts
export function isVersionBelow(v: string, min: string): boolean {
  const a = v.split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x < y) return true; if (x > y) return false;
  }
  return false;
}
```
测试：`isVersionBelow('1.2.0','1.3.0')===true`、`('1.3.0','1.3.0')===false`、`('2.0.0','1.9.9')===false`。

- [ ] **Step 4: 移植 long-video-plan.ts**（从 `D:\app1\src\core\video\long-video-plan.ts`，仅 client-safe 部分：纯类型/计划，剔除任何 ffmpeg/DB/prisma import）
- [ ] **Step 5: 写 utils.ts**（`genId()`、`withRetry(fn, {tries,backoff})`、`parseUrl`）
- [ ] **Step 6: index.ts 桶导出全部**
- [ ] **Step 7: `pnpm --filter @dramaforge/shared test` 全绿**
- [ ] **Step 8: `git commit -m "feat(shared): render-job contract + client-api + version + utils"`**

**Acceptance:** vitest 全绿；`@shared` 可被 server/client 包 import；契约类型冻结。

---

## Task 2: ⑦ server/db+config

**Files:** `packages/server/db+config/src/{pg.ts,env.ts,redis.ts,auth.ts,migrate.ts}` + `migrations/0001-init.sql`（含 render_jobs）

**Interfaces:**
- Consumes: `@shared`（无强依赖，可后置对接）
- Produces: `pg.query`、`pg.tx(fn)`、`redis` 单例、`env`（Zod 校验后）、`migrate()`、NextAuth `authOptions`、`render_jobs` 表。

- [ ] **Step 1: 写 0001-init.sql 的 render_jobs 段**

```sql
CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  input JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  claimed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  result JSONB
);
CREATE INDEX IF NOT EXISTS idx_render_jobs_status_created ON render_jobs(status, created_at) WHERE status = 'PENDING';
```
其余 14 张表从 app1 `migrations/` 整体移植（幂等 `CREATE TABLE IF NOT EXISTS`）。

- [ ] **Step 2: pg.ts**（Pool + `query(sql,args)` + `tx(fn)` 事务封装，从 app1 `db` 封装移植）
- [ ] **Step 3: env.ts**（Zod 校验 DATABASE_URL/REDIS_URL/MINIO_*/NEXTAUTH_SECRET/AI keys 等）
- [ ] **Step 4: redis.ts**（ioredis 单例）
- [ ] **Step 5: auth.ts**（NextAuth Credentials+JWT，单设备 activeSessionStamp，从 app1 移植）
- [ ] **Step 6: migrate.ts**（幂等执行器，记录已执行迁移到 `_migrations` 表）
- [ ] **Step 7: 测试** migrate 在测试 PG 上跑通（integration，需 PG）；env 校验单测
- [ ] **Step 8: `git commit -m "feat(server/db): pg + migrations(render_jobs) + env + redis + auth"`**

**Acceptance:** `migrate()` 幂等可重复执行；`render_jobs` 表存在；env 缺字段抛错。

---

## Task 3: ⑧ client/ffmpeg

**Files:** `packages/client/ffmpeg/src/{ffmpeg-pipeline.ts,grid-overlay.ts,index.ts}` + test（小样例视频）

**Interfaces:**
- Consumes: `@shared`（RenderJobInput 类型）
- Produces: `execFfmpegConcat(clips, outPath)`、`extractLastFrame(videoUrl, outPath)`、`getVideoDuration(url)`、`splitVideoByDuration(url, sec, prefix)`、`splitVideoEvenly(url, n, prefix)`、`downloadClips(urls, dir)`、`gridOverlay(frames, outPath)`。

- [ ] **Step 1: 从 `D:\app1\src\core\video\ffmpeg-pipeline.ts` 移植** 全部函数到 `client/ffmpeg/src/ffmpeg-pipeline.ts`，改 import 路径（用 `@shared`），剔除 `resolveStorageUrl`/`dedupClipsByUrl` 中任何服务器存储 factory 依赖（存储上传改由 render-worker 用 MinIO presigned URL 处理）。
- [ ] **Step 2: 从 `D:\app1\src\core\video\grid-overlay.ts` 移植**（sharp 依赖）
- [ ] **Step 3: ffmpeg 二进制定位**——优先 `@ffmpeg-installer/ffmpeg`（npm 装，跨机稳定），fallback `videostylization/whisper/ffmpeg.exe`。封装 `getFfmpegPath()`。
- [ ] **Step 4: index.ts 导出**
- [ ] **Step 5: 集成测试**——准备 1 个 3 秒小样例 mp4，跑 concat（2 段）/extractLastFrame/splitEvenly(2)，断言产物存在且 duration 正确。
- [ ] **Step 6: `git commit -m "feat(client/ffmpeg): migrate ffmpeg pipeline + grid-overlay from app1"`**

**Acceptance:** 小样例视频 concat/extract/split 集成测试通过；**本包零服务器依赖**（不 import @server/*）。

---

## Task 4: ⑬⑭⑮ client ops 三骨架（并行，可拆 3 子 agent）

### Task 4a: ⑬ ops-heartbeat
**Files:** `packages/client/ops-heartbeat/src/{heartbeat.ts,lockout.ts,index.ts}`
- Consumes: `@shared`（HeartbeatRequest/Response, isVersionBelow）
- Produces: `startHeartbeat({version,machineId,onForceUpgrade})`（每 30s POST /api/client/heartbeat；收 force_upgrade→触发 lockout+回调）。
- [ ] Step 1: TDD `startHeartbeat`（用 fake fetch，断言 30s 间隔、force_upgrade 触发 onForceUpgrade）
- [ ] Step 2: lockout.ts（锁死界面逻辑，仅留升级提示）
- [ ] Step 3: `git commit -m "feat(client/ops-heartbeat): 30s heartbeat + force_upgrade lockout"`

### Task 4b: ⑭ ops-updater
**Files:** `packages/client/ops-updater/src/{updater.ts,index.ts}`
- Consumes: `@shared`（UpdateCheckRequest/Response）
- Produces: `startUpdater({currentVersion,os,onDownloaded})`（轮询 /api/client/update；有新版静默下载到本地缓存；force 优先；下完回调提示重启）。
- [ ] Step 1: TDD 轮询 + 下载决策（fake fetch 返回新版→触发下载）
- [ ] Step 2: `git commit -m "feat(client/ops-updater): silent updater polling"`

### Task 4c: ⑮ ops-logger
**Files:** `packages/client/ops-logger/src/{logger.ts,uploader.ts,index.ts}`
- Consumes: `@shared`（ClientLogBatch）
- Produces: `createLogger(machineId)`（按天滚动本地日志，上限 N 天）、懒上报三触发（error 自动/点名/每日定时）→ POST /api/client/logs。
- [ ] Step 1: TDD 滚动写入 + 上限清理
- [ ] Step 2: uploader 三触发
- [ ] Step 3: `git commit -m "feat(client/ops-logger): rolling local log + lazy upload"`

**Acceptance（三骨架）:** 各自 vitest 通过；ops 包零 @server/* 依赖；心跳/更新/日志互不阻塞（独立模块）。

---

## Task 5: ② server/gateway（AI 网关 13 provider）

**Files:** `packages/server/gateway/src/{index.ts, providers/*.ts}`

**Interfaces:**
- Consumes: `@server/db+config`（读 api_configs 表的 key）、`@shared`
- Produces: `callAI(provider, model, payload)` 统一入口，返回 `{url, meta}` 或抛错。

- [ ] **Step 1: 从 `D:\app1\src\core\ai/` 整体移植 13 provider**（ark/fal/openai/google/deepseek/kimi/dashscope/minimax/vidu/siliconflow/grok/comfyui/ark_intl），key 全部从 env 或 api_configs 表读，**绝不出现在客户端可见处**。
- [ ] **Step 2: 统一 `callAI` 入口 + 错误归一化**
- [ ] **Step 3: 单测** 各 provider 请求体构造（mock fetch，不真实调用）
- [ ] **Step 4: `git commit -m "feat(server/gateway): migrate 13 AI providers + unified callAI"`**

**Acceptance:** 13 provider 请求构造单测通过；key 仅来自 env/api_configs；零 ffmpeg import。

---

## Task 6: ③ server/domain

**Files:** `packages/server/domain/src/{billing,concurrency,storage,workflow,prompt,storyboard,asset}/`

**Interfaces:**
- Consumes: `@server/db+config`、`@shared`
- Produces: 计费扣减、并发限额、存储 factory（local/minio/cos）、工作流定义、提示词模板、分镜/资产 CRUD。

- [ ] **Step 1: 从 `D:\app1\src\core/` 对应子域逐个移植**（billing/concurrency/storage/workflow/prompt/storyboard/asset），改 import 到 `@server/db+config`、`@shared`。
- [ ] **Step 2: 存储 factory 保留 local/minio/cos**（render-worker 上传用 minio presigned）
- [ ] **Step 3: 单测** 计费/并发/分镜核心逻辑（无 DB 的纯函数）
- [ ] **Step 4: `git commit -m "feat(server/domain): migrate billing/concurrency/storage/workflow/prompt/storyboard/asset"`**

**Acceptance:** 纯函数单测通过；零 ffmpeg import。

---

## Task 7: ④ server/task（调度 + render-job 派发，新件）

**Files:** `packages/server/task/src/{queues.ts,render-job-repo.ts,dispatch.ts,index.ts}`

**Interfaces:**
- Consumes: `@server/db+config`、`@shared`（RenderJob 全套）
- Produces: `queues`（4 队列 text/image/video/voice）、`renderJobRepo.{create,claimNext(machineId),markRunning,markResult,markFailed,reapStale}`、`dispatchFilmExport(task)` 等派发函数。

- [ ] **Step 1: queues.ts**（BullMQ 4 队列，从 app1 workers/ 移植队列定义）
- [ ] **Step 2: render-job-repo.ts（核心新件，TDD）**

```ts
// claimNext: 原子认领
export async function claimNext(machineId: string): Promise<RenderJob | null> {
  return pg.tx(async q => {
    const r = await q.query(
      `UPDATE render_jobs SET status='CLAIMED', claimed_by=$1, claimed_at=now()
       WHERE id = (SELECT id FROM render_jobs WHERE status='PENDING' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`, [machineId]);
    return r.rows[0] ? mapRow(r.rows[0]) : null;
  });
}
```
+ `markRunning`/`markResult(id,result)`/`markFailed(id,error)`/`reapStale(timeoutMs)`（CLAIMED 超时回 PENDING）。

- [ ] **Step 3: 测试** claimNext 原子性（并发 2 个 claim 只 1 个拿到，需 PG integration）；reapStale 回收。
- [ ] **Step 4: dispatch.ts**（FILM_EXPORT→建 CONCAT render_job；CHAIN_GENERATE→建 CHAIN_COMPILE；video-split→SPLIT_*）
- [ ] **Step 5: `git commit -m "feat(server/task): BullMQ queues + render-job repo(FOR UPDATE SKIP LOCKED) + dispatch"`**

**Acceptance:** 并发 claimNext 不重复认领（integration 测试）；reapStale 回收超时；零 ffmpeg import。

---

## Task 8: ⑥ server/ai-worker（纯 AI 任务）

**Files:** `packages/server/ai-worker/src/{index.ts, handlers/*.ts}`

**Interfaces:**
- Consumes: `@server/gateway`、`@server/domain`、`@server/task`、`@server/db+config`
- Produces: BullMQ worker，处理 VIDEO_GENERATE(单镜)/IMAGE_*/VOICE_*/TEXT_*(除长视频)。

- [ ] **Step 1: 从 `D:\app1\src\workers/` 移植 worker 主体**，但**只保留纯 AI 任务 handler**。
- [ ] **Step 2: 删除/拒绝任何 ffmpeg import**——FILM_EXPORT/CHAIN_GENERATE/LONG_VIDEO_REWRITE/video-split 不在本 worker 注册，改由 dispatch 派发 render_job 给客户端。
- [ ] **Step 3: 边界测试**（扩展 app1 `long-video-client-boundary.test.ts` 思路）：`ai-worker` 包禁止 import `@client/ffmpeg`。
- [ ] **Step 4: `git commit -m "feat(server/ai-worker): pure-AI BullMQ worker, ffmpeg stripped"`**

**Acceptance:** 边界测试通过（ai-worker 不 import ffmpeg）；纯 AI handler 单测通过。

---

## Task 9: ⑨ client/render-worker（HTTP 拉→ffmpeg→上传）

**Files:** `packages/client/render-worker/src/{loop.ts,executor.ts,uploader.ts,index.ts}`

**Interfaces:**
- Consumes: `@client/ffmpeg`、`@shared`、`@client/ops-logger`
- Produces: `startRenderWorker({apiBase,authCookie,machineId})`（轮询 GET /api/render/jobs/next→按 type 跑 ffmpeg→上传→POST result/failed）。

- [ ] **Step 1: loop.ts**（轮询 + 退避；拉到 job→executor；空则 sleep 5s）
- [ ] **Step 2: executor.ts**（按 RenderJobType 分派到 @client/ffmpeg 函数；CONCAT→execFfmpegConcat；EXTRACT_FRAME→extractLastFrame；SPLIT_*→split*；CHAIN_COMPILE/LONG_VIDEO_REWRITE 委托给 @client/orchestrators）
- [ ] **Step 3: uploader.ts**（产物上传到 input.outputUploadUrl，MinIO presigned PUT）
- [ ] **Step 4: 进度上报** POST /progress；失败 POST /failed + 日志片段
- [ ] **Step 5: TDD** executor 分派（fake ffmpeg）；uploader（fake fetch）
- [ ] **Step 6: `git commit -m "feat(client/render-worker): poll loop + executor + uploader"`**

**Acceptance:** executor 按 type 正确分派；失败上报含日志片段；零 @server/* 依赖（只走 HTTP）。

---

## Task 10: ⑤ server/web（Next.js 界面 + API）

**Files:** `packages/server/web/app/api/render/jobs/{next,[id]/{progress,result,failed}}/route.ts`、`app/api/client/{heartbeat,logs,update}/route.ts`、界面从 app1 移植

**Interfaces:**
- Consumes: 全部 server 包 + `@shared`
- Produces: 7 个新 API 端点 + 精简后的 78 API（去 ffmpeg 路由）+ 界面。

- [ ] **Step 1: 7 个新端点（契约见 spec §4.2）**
  - `GET /api/render/jobs/next` → `renderJobRepo.claimNext(machineId)`，无则 204
  - `POST /api/render/jobs/:id/progress` → 校验 claimed_by==machineId，写进度（可仅内存/SSE 推前端）
  - `POST /api/render/jobs/:id/result` → `markResult`，触发任务完成 SSE
  - `POST /api/render/jobs/:id/failed` → `markFailed`
  - `POST /api/client/heartbeat` → 读 `system_configs.MIN_CLIENT_VERSION`，`isVersionBelow`→返 ok/force_upgrade
  - `POST /api/client/logs` → 存 MinIO 或 /var/log/sf-clients/
  - `GET /api/client/update` → 返 latestVersion/downloadUrl/force
- [ ] **Step 2: 界面从 app1 `app/`+`components/` 移植**，剔除 ffmpeg 直接调用，改"建 render_job + 等 SSE"
- [ ] **Step 3: video-split 路由改造**——`D:\app1\src\app\api\projects\[projectId]\video-split\route.ts` 不再调 ffmpeg，改 dispatch SPLIT_* render_job
- [ ] **Step 4: 鉴权** 所有 /api/render/* /api/client/* 用 NextAuth session（cookie）
- [ ] **Step 5: 边界测试** web 包禁止 import @client/ffmpeg
- [ ] **Step 6: `git commit -m "feat(server/web): 7 render/client endpoints + UI migration, ffmpeg removed"`**

**Acceptance:** 7 端点契约测试（next 原子认领、heartbeat force_upgrade、update）；界面无 ffmpeg 调用；边界测试通过。

---

## Task 11: ⑩ client/orchestrators（CHAIN/LONG_VIDEO 编排）

**Files:** `packages/client/orchestrators/src/{chain-generate.ts,long-video-rewrite.ts,index.ts}`

**Interfaces:**
- Consumes: `@client/ffmpeg`、`@shared`、`@client/render-worker`（调云端 AI API via HTTP）
- Produces: `runChainCompile(input, ctx)`、`runLongVideoRewrite(input, ctx)`。

- [ ] **Step 1: 从 `D:\app1\src\workers\video.worker.ts` + `text.worker.ts` 移植 CHAIN/LONG_VIDEO 编排逻辑**，但 AI 调用改走云端 `POST /api/generate/video`（key 不出服务器），ffmpeg 用 @client/ffmpeg。
- [ ] **Step 2: chain-generate.ts**：逐组调云端 AI 生成→本地 extractLastFrame+gridOverlay 生成下组参考→全部完成 execFfmpegConcat。逐组错误恢复（失败组重试 N 次，超限整体失败上报）。
- [ ] **Step 3: long-video-rewrite.ts**：本地 splitVideoEvenly→逐段调云端 Kimi/DeepSeek→合片。
- [ ] **Step 4: TDD** 编排步骤（mock 云端 AI + fake ffmpeg）
- [ ] **Step 5: `git commit -m "feat(client/orchestrators): CHAIN_GENERATE + LONG_VIDEO_REWRITE, AI via cloud API"`**

**Acceptance:** 编排单测通过；AI 调用全走 HTTP（key 不入客户端）；零 @server/* 依赖。

---

## Task 12: ⑪ client/shell（Electron 壳）

**Files:** `packages/client/shell/src/{main.ts,preload.ts,index.html}` + `electron-builder.yml`

**Interfaces:**
- Consumes: `@client/render-worker`、`@client/ops-*`、`@shared`
- Produces: Electron app（BrowserWindow 加载 https://your-domain.example.com）+ preload IPC + 启动 render-worker/ops。

- [ ] **Step 1: main.ts** 创建 BrowserWindow `loadURL('https://your-domain.example.com')`；app ready 时启动 render-worker + heartbeat + updater + logger。
- [ ] **Step 2: 登录态传递**（开放问题 5）——shell 与 render-worker 共享同源 cookie（BrowserWindow session 与 Node fetch 共享 cookie jar，方案见下"开放问题裁决"）。
- [ ] **Step 3: preload.ts** 最小 IPC（phase1 不暴露 ffmpeg 给网页，开放问题 6 裁决为暂不做）。
- [ ] **Step 4: electron-builder.yml** 打包 win x64，含 ffmpeg 二进制（@ffmpeg-installer）+ bytenode 保护（沿用 app1 `D:\app1\scripts\protect.mjs`）。
- [ ] **Step 5: 冒烟** 本地 `pnpm --filter @dramaforge/shell dev` 起壳，加载页面，render-worker 轮询不报错。
- [ ] **Step 6: `git commit -m "feat(client/shell): Electron thin shell loading cloud UI + bootstrap render-worker/ops"`**

**Acceptance:** 壳能加载云端界面；render-worker/ops 后台启动；打包脚本跑通。

---

## Task 13: ⑫ 集成串联（主 agent）

**Files:** `docker-compose.yml`、`deploy.sh`、`rollback.sh`、根 `package.json` scripts

- [ ] **Step 1: docker-compose.yml** = web/ai-worker/postgres/redis/minio（**无 ffmpeg**），`restart: unless-stopped`，沿用 app1 内存约束。
- [ ] **Step 2: deploy.sh** 本地 `pnpm -r build` → docker save|gzip → ssh load → `migrate()` → `docker compose up -d --no-build` → 健康检查（沿用 app1 思路，**绝不在服务器 build**）。
- [ ] **Step 3: rollback.sh** 退回上一镜像 tag（DB 迁移不回退）。
- [ ] **Step 4: 端到端联调**（主流程 FILM_EXPORT）：web 建任务+render_job → 客户端 render-worker 拉到 → ffmpeg concat → 上传 → result → SSE 推前端。**全程服务器没碰 ffmpeg**。
- [ ] **Step 5: 端到端 CHAIN_GENERATE** 联调。
- [ ] **Step 6: 心跳 force_upgrade 演练**（改 MIN_CLIENT_VERSION→客户端锁死→静默升级）。
- [ ] **Step 7: `git commit -m "feat: integration - docker-compose + deploy + e2e FILM_EXPORT/CHAIN"`**

**Acceptance:** FILM_EXPORT 端到端跑通且服务器无 ffmpeg；CHAIN_GENERATE 跑通；force_upgrade 演练成功；`docker compose ps` 全 Up。

---

## 开放问题裁决（plan 阶段定）

1. **render_jobs 存 PG**（非 Redis）——审计+持久，已定。✅
2. **CHAIN_GENERATE 逐组错误恢复**：失败组重试 3 次（指数退避），超限整 job FAILED 上报日志。✅
3. **客户端 ffmpeg 二进制**：`@ffmpeg-installer/ffmpeg`（npm 管理、跨机稳定），fallback 本地 exe。✅
4. **更新分发通道**：MinIO 静态托管安装包 + `versions.json` 清单（latestVersion/downloadUrl/force/minVersion）。✅
5. **登录态 shell→render-worker**：同源 cookie 共享——Electron BrowserWindow 与 Node 侧 fetch 共用 session 的 cookie jar（`session.defaultSession.cookies`），render-worker 请求带该 cookie。✅
6. **preload IPC 暴露 ffmpeg 给网页**：phase1 **不做**（网页不直接调 ffmpeg，全走 render-worker）。✅
7. **并行批次**：见上"执行批次"7 批，比 spec 全并行更稳。✅

---

## Self-Review

**Spec coverage:** spec §0-14 全覆盖——背景/决策(计划 Global Constraints)、架构(File Structure)、15 模块(Task 1-13)、render-job 契约(Task 1+2+7+10)、任务归属(Task 8/9/11)、3 运维骨架(Task 4)、主流程(Task 13 e2e)、错误降级(reapStale/失败上报/force_upgrade)、测试(每任务 TDD+边界)、部署(Task 13)、稳定性(Global Constraints)、开放问题(裁决段)。

**Placeholder scan:** 无 TBD/TODO；迁移任务给的是 app1 确切源路径+改动点+验收，非占位。

**Type consistency:** `RenderJob`/`RenderJobInput` 变体/`claimNext`/`markResult` 在 Task 1 定义，Task 7/9/10/11 消费，命名一致。`isVersionBelow` Task 1 定义、Task 4a/Task 10 用。`callAI` Task 5 定义、Task 8 用。

**缺口补遗:** 无。

---

## Execution Handoff

计划已存 `docs/superpowers/plans/2026-07-18-cs-refactor.md`。两种执行方式：

1. **Subagent-Driven（推荐）**——每任务派新子 agent，主 agent 任务间审查 + 每批 git 提交。与 spec"每模块一子 agent"一致。
2. **Inline Execution**——本会话内按 executing-plans 批量执行。

本计划按 Batch 0→7 依赖排序派子 agent（① 必须最先），主 agent 负责串联（Task 0/13）与回滚提交。
