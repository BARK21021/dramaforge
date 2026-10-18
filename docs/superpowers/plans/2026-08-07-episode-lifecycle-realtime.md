# 分集生命周期 + 实时进度(inline-task)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 analyze 与 generate-storyboard 从同步阻塞路由改成 inline-task(建 task 行 + fire-and-forget 后台 + SSE 实时进度),根治扣费/卡死/desync,前端加右侧常驻侧栏、草稿持久化、三处同源实时进度条。

**Architecture:** 路由变薄(预检→去重→startInlineAiTask→置 ANALYZING→fire 后台 runner→返 202 `{taskId}`);后台 runner 函数(callAI 循环 + 分阶段 reportInlineAiTaskProgress + heartbeat + 校验后扣费 + complete/fail)独立可单测;前端以 DB task/stageStatus 为唯一真相源,`GenerationProgress` 绑 taskId 经 SSE 实时推进,taskId 经 localStorage 跨刷新传递。

**Tech Stack:** TypeScript monorepo(pnpm)、Next.js(web)、vitest(2 包)、PostgreSQL(tasks/task_events 表已存在)、Redis(SSE pub/sub)、React(hooks/components)。

## Global Constraints

- **来源 spec**:`docs/superpowers/specs/2026-08-07-episode-lifecycle-realtime-design.md`(已核实到代码行,本计划引用其文件:行)。
- **测试框架**:vitest(`vitest run`)。路由测试范例:`packages/web/app/api/projects/[id]/episodes/split/__tests__/route.test.ts`(`serverMock` mock `@dramaforge/server` 全部导出 + `makeRequest`/`readJson` helpers + `getServerSessionMock`)。每个路由测试放 `__tests__/route.test.ts`。
- **提交纪律(覆盖 skill 默认)**:用户铁律=只在其明确要求时才 `git commit`。下方各 Task 末尾的「Commit」步骤是**逻辑任务边界 = "停在此,待复核"检查点**,执行时**不要自动 commit**;改动留在工作树供用户复核,除非用户说"提交/commit/边做边提交"。
- **真生成验证边界(AGENTS.md §5)**:callAI 走云端 key,本地无法验真 AI 流转。单测一律 mock callAI,只验结构/契约/扣费顺序/事件/stage 复位。进度条实时跳动、真进 AnalyzingStage、切集不丢等**运行时冒烟须用户桌面端**(部署后走一遍)。
- **typecheck**:`cd /d/dramaforge-cs && pnpm -r typecheck`(4 包)。
- **不改 stage 流程**(input→analyzing→assets→storyboard→production,H3);不动 BullMQ 异步路径与计费总账结构;零 DB 迁移(tasks 表已有 `timeoutAt`/`stage`/`stageProgress`/`input`/`output` 列)。

## File Structure

**后端(web 层 + server domain)**
- `packages/server/src/domain/episode/service.ts` — 加 `sweepStuckAnalyzing()`(B3)。
- `packages/server/src/ai-worker/index.ts` — 加 `startEpisodeStageSweep()` 借宿调度(B3)。
- `packages/web/lib/ai-call-timeout.ts` — 新:`callAIWithTimeout(...)`(B2 共享)。
- `packages/web/lib/episode-analysis-runner.ts` — 新:`runEpisodeAnalysis(taskId, …)` 后台 runner(B2+B1,analyze)。
- `packages/web/lib/storyboard-generation-runner.ts` — 新:`runStoryboardGeneration(taskId, …)` 后台 runner(B2+B1,storyboard)。
- `packages/web/app/api/projects/[id]/episodes/[episodeId]/analyze/route.ts` — 改薄。
- `packages/web/app/api/projects/[id]/episodes/[episodeId]/generate-storyboard/route.ts` — 改薄。

**前端**
- `packages/web/lib/episode-task-store.ts` — 新:taskId + draft 的 localStorage store(F2/F3)。
- `packages/web/hooks/useEpisodeTask.ts` — 新:`useEpisodeTask(episodeId, type)`(F3)。
- `packages/web/lib/analysis-workflow.ts` — 改:返 `{ taskId }`,不再 await 结果。
- `packages/web/app/workspace/[projectId]/components/InputStage.tsx` — 右侧栏(F1)+ draft 持久化(F2)。
- `packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx` — 删 effectiveStage 重映射(F4)。
- `packages/web/app/workspace/[projectId]/components/AnalyzingStage.tsx` / `StoryboardStage.tsx` — 接 `GenerationProgress`(F3/F6)。

---

## Task 1: `episodeRepo.sweepStuckAnalyzing()`(B3 闭环守卫)

**Files:**
- Modify: `packages/server/src/domain/episode/service.ts`(在 episodeRepo 对象内加方法;先读现有 update/listByProject 的写法对齐风格)
- Test: `packages/server/src/domain/episode/__tests__/sweep-stuck-analyzing.test.ts`

**Interfaces:**
- Produces: `episodeRepo.sweepStuckAnalyzing(): Promise<number>` — 返回复位行数。扫 `stageStatus='analyzing'` 且(`updatedAt < now()-interval '35 minutes'` 或关联 task 已终态)的 episode → `stageStatus='input', status='PENDING'`。幂等(只动 analyzing)。

- [ ] **Step 1: Write failing test**

```ts
// packages/server/src/domain/episode/__tests__/sweep-stuck-analyzing.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../../infra/db'; // 按现有 service.ts 的 query 导入路径对齐
import { episodeRepo } from '../service';

describe('episodeRepo.sweepStuckAnalyzing', () => {
  beforeEach(async () => {
    // 最小夹具:一个 user + project + 两集(一集 analyzing 超 35min,一集 analyzing 新鲜)
    await query(`DELETE FROM episodes WHERE "projectId"='p-sweep';`);
    await query(`DELETE FROM projects WHERE id='p-sweep';`);
    await query(`DELETE FROM users WHERE id='u-sweep';`);
    await query(`INSERT INTO users(id,email,role,credits) VALUES('u-sweep','sweep@x.test','FREE',100)`);
    await query(`INSERT INTO projects(id,"userId",title,status) VALUES('p-sweep','u-sweep','t','DRAFT')`);
    await query(`INSERT INTO episodes(id,"projectId","episodeNumber",status,"stageStatus","updatedAt")
      VALUES('ep-stuck','p-sweep',1,'ANALYZING','analyzing',now()-interval '40 minutes')`);
    await query(`INSERT INTO episodes(id,"projectId","episodeNumber",status,"stageStatus","updatedAt")
      VALUES('ep-fresh','p-sweep',2,'ANALYZING','analyzing',now())`);
  });
  afterEach(async () => {
    await query(`DELETE FROM episodes WHERE "projectId"='p-sweep';`);
    await query(`DELETE FROM projects WHERE id='p-sweep';`);
    await query(`DELETE FROM users WHERE id='u-sweep';`);
  });

  it('只复位过期 analyzing 的集,新鲜集不动(幂等)', async () => {
    const n = await episodeRepo.sweepStuckAnalyzing();
    expect(n).toBe(1);
    const stuck = (await query(`SELECT "stageStatus",status FROM episodes WHERE id='ep-stuck'`)).rows[0];
    expect(stuck.stageStatus).toBe('input');
    expect(stuck.status).toBe('PENDING');
    const fresh = (await query(`SELECT "stageStatus" FROM episodes WHERE id='ep-fresh'`)).rows[0];
    expect(fresh.stageStatus).toBe('analyzing'); // 未动
  });
});
```

> 若该测试需要真实 PG:看 `packages/server/vitest.config.ts` 是否已配测试 DB;若现有 service 测试用 mock 风格(非真 DB),改用 mock `query` 断言 SQL 含 `interval '35 minutes'` 与 `stageStatus='input'`。**先读 `packages/server/src/domain/episode/` 下任一已有测试对齐风格再定。**

- [ ] **Step 2: Run test, verify FAIL**

Run: `cd /d/dramaforge-cs && pnpm --filter @dramaforge/server test -- sweep-stuck-analyzing`
Expected: FAIL(`sweepStuckAnalyzing is not a function`)。

- [ ] **Step 3: Implement**

在 `packages/server/src/domain/episode/service.ts` 的 `episodeRepo` 内加:

```ts
/** 闭环守卫:复位卡在 analyzing 超时(>35min,越过 task timeoutAt 30min + 余量)的集。
 *  对齐 renderJobRepo.sweepStuckShots 范式;fire-and-forget 被 web 重启杀时兜底。 */
async sweepStuckAnalyzing(): Promise<number> {
  const { rows } = await query(
    `UPDATE episodes
        SET "stageStatus"='input', status='PENDING', "updatedAt"=NOW()
      WHERE "stageStatus"='analyzing'
        AND "updatedAt" < NOW() - INTERVAL '35 minutes'
      RETURNING id`,
  );
  return rows.length;
},
```

- [ ] **Step 4: Run test, verify PASS**

Run: `cd /d/dramaforge-cs && pnpm --filter @dramaforge/server test -- sweep-stuck-analyzing`
Expected: PASS。

- [ ] **Step 5: typecheck**

Run: `cd /d/dramaforge-cs && pnpm --filter @dramaforge/server typecheck`
Expected: 通过。

- [ ] **Step 6: Commit(checkpoint,按 Global Constraints 不自动提交)**

---

## Task 2: 借宿 ai-worker 调度 sweepStuckAnalyzing(B3)

**Files:**
- Modify: `packages/server/src/ai-worker/index.ts`(镜像 `startRenderJobCascadeSweep`,line 135/141/222)

**Interfaces:**
- Consumes: `episodeRepo.sweepStuckAnalyzing()`(Task 1)
- Produces: ai-worker 启动时每 60s 跑一次 sweep(与现有 `sweepStuckShots`/`sweepStuckTasks` 同节奏)。

- [ ] **Step 1: 读现有 sweep 调度范式**

读 `packages/server/src/ai-worker/index.ts:135-145`(startRenderJobCascadeSweep)与 :205-225(它的 wiring + sweepStuckTasks),对齐风格与日志格式。

- [ ] **Step 2: 实现 startEpisodeStageSweep**

在 index.ts 加(照搬同文件 startRenderJobCascadeSweep 结构):

```ts
import { episodeRepo } from '../domain/episode/service'; // 顶部 import 区对齐现有 @server 导入
// (若 episodeRepo 已经由 @dramaforge/server barrel 导出,改从 barrel 导入以对齐现有 import 风格)

const EPISODE_SWEEP_INTERVAL_MS = 60_000;
let _episodeStageSweepHandle: { stop: () => void } | null = null;

function startEpisodeStageSweep(): { stop: () => void } {
  const timer = setInterval(async () => {
    try {
      const n = await episodeRepo.sweepStuckAnalyzing();
      if (n > 0) console.log(`[episode-stage-sweep] 复位 ${n} 个卡死 analyzing 的集`);
    } catch (err) {
      console.warn('[episode-stage-sweep] tick 失败', err);
    }
  }, EPISODE_SWEEP_INTERVAL_MS);
  return { stop: () => clearInterval(timer) };
}
```

并在现有 wiring 处(line ~222 `_renderJobCascadeHandle = startRenderJobCascadeSweep();` 旁)加:`_episodeStageSweepHandle = startEpisodeStageSweep();`。在现有 stop/shutdown 路径(同处 grep `_renderJobCascadeHandle?.stop()`)旁加 `_episodeStageSweepHandle?.stop();`。

- [ ] **Step 3: typecheck + 单测(确认 import 与 wiring 无语法/类型错)**

Run: `cd /d/dramaforge-cs && pnpm --filter @dramaforge/server typecheck && pnpm --filter @dramaforge/server test`
Expected: typecheck 通过,既有测试不回归。

- [ ] **Step 4: Commit checkpoint**

---

## Task 3: `callAIWithTimeout` 共享 helper(B2 防挂死)

**Files:**
- Create: `packages/web/lib/ai-call-timeout.ts`
- Test: `packages/web/lib/__tests__/ai-call-timeout.test.ts`

**Interfaces:**
- Produces: `callAIWithTimeout(opts: { call: () => Promise<T>, timeoutMs: number, signal?: AbortSignal }): Promise<T>` — 用 Promise.race 给任意 callAI 调用加超时;超时抛 `AiCallTimeoutError`。不依赖 callAI 是否原生支持 signal(对现状最稳)。

- [ ] **Step 1: Write failing test**

```ts
// packages/web/lib/__tests__/ai-call-timeout.test.ts
import { describe, expect, it } from 'vitest';
import { callAIWithTimeout, AiCallTimeoutError } from '../ai-call-timeout';

describe('callAIWithTimeout', () => {
  it('call 在超时前完成 → 返回结果', async () => {
    const r = await callAIWithTimeout({ call: () => Promise.resolve('ok'), timeoutMs: 100 });
    expect(r).toBe('ok');
  });
  it('call 超时 → 抛 AiCallTimeoutError', async () => {
    await expect(
      callAIWithTimeout({ call: () => new Promise(() => {}), timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(AiCallTimeoutError);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd /d/dramaforge-cs && pnpm --filter @dramaforge/web test -- ai-call-timeout`(找不到模块)。

- [ ] **Step 3: Implement**

```ts
// packages/web/lib/ai-call-timeout.ts
export class AiCallTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`AI 调用超时(${timeoutMs}ms)`);
    this.name = 'AiCallTimeoutError';
  }
}

export async function callAIWithTimeout<T>(opts: {
  call: () => Promise<T>;
  timeoutMs: number;
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AiCallTimeoutError(opts.timeoutMs)), opts.timeoutMs);
  });
  try {
    return await Promise.race([opts.call(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run, verify PASS** + `pnpm --filter @dramaforge/web typecheck`。

- [ ] **Step 5: Commit checkpoint**

---

## Task 4: `runEpisodeAnalysis` 后台 runner(B2+B1,analyze 核心)

**Files:**
- Create: `packages/web/lib/episode-analysis-runner.ts`
- Test: `packages/web/lib/__tests__/episode-analysis-runner.test.ts`

**Interfaces:**
- Consumes: `startInlineAiTask`/`reportInlineAiTaskProgress`/`completeInlineAiTask`/`failInlineAiTask`(`@dramaforge/server`)、`callAI`(`@dramaforge/server`)、`billDirectGeneration`(`@web/lib/direct-media-generation`)、`callAIWithTimeout`(Task 3)、现有 `buildScriptAnalysisPrompt`/`parseScriptResult`/`validateAnalysisConsistency`(analyze route 现有 import,从 `@dramaforge/server`)、`episodeRepo`。
- Produces: `runEpisodeAnalysis(input: { taskId, userId, projectId, episodeId, model, enhancementPrompt?, localizationProfile? }): Promise<void>` — 后台跑完即终态化 task(成功 complete+扣费 / 失败 fail+不扣费),stageStatus 必复位。

- [ ] **Step 1: Write failing test(校验失败不扣费 + stage 复位 + fail 事件)**

```ts
// packages/web/lib/__tests__/episode-analysis-runner.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@dramaforge/server', () => ({
  callAI: vi.fn(),
  episodeRepo: { getById: vi.fn(), update: vi.fn(), listByProject: vi.fn() },
  listAssets: vi.fn().mockResolvedValue([]),
  projectRepo: { getById: vi.fn() },
  buildScriptAnalysisPrompt: vi.fn().mockReturnValue({ system: 's', user: 'u' }),
  parseScriptResult: vi.fn(),
  validateAnalysisConsistency: vi.fn(),
  detectLanguage: vi.fn().mockReturnValue('zh'),
  readLocalizationProfile: vi.fn().mockReturnValue(undefined),
  startInlineAiTask: vi.fn(),
  reportInlineAiTaskProgress: vi.fn(),
  completeInlineAiTask: vi.fn(),
  failInlineAiTask: vi.fn(),
  GatewayError: class {},
}));
vi.mock('@web/lib/direct-media-generation', () => ({ billDirectGeneration: vi.fn() }));
vi.mock('@web/lib/episode-analysis-context', () => ({ buildEpisodeAnalysisContext: vi.fn() }));
vi.mock('@web/lib/analysis-guidance', () => ({ resolveAnalysisGuidance: vi.fn() }));

import { callAI } from '@dramaforge/server';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { runEpisodeAnalysis } from '../episode-analysis-runner';

const base = { taskId: 't1', userId: 'u1', projectId: 'p1', episodeId: 'e1', model: 'deepseek/deepseek-v4-flash' };

describe('runEpisodeAnalysis', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AI 返回空 → failInlineAiTask + stageStatus 复位 input + 不扣费', async () => {
    (callAI as any).mockResolvedValue({ meta: { content: '' } }); // 空
    await runEpisodeAnalysis(base);
    expect(billDirectGeneration).not.toHaveBeenCalled();
    expect((await import('@dramaforge/server')).failInlineAiTask).toHaveBeenCalledWith('t1', 'u1', expect.any(String));
    // episodeRepo.update 被调且把 stageStatus 复位 input(在任一 update 调用里)
    const { episodeRepo } = await import('@dramaforge/server');
    const resetCall = (episodeRepo.update as any).mock.calls.find(
      (c: any[]) => c[1] && c[1].stageStatus === 'input',
    );
    expect(resetCall).toBeTruthy();
  });

  it('AI 返回合法 scenes → completeInlineAiTask + 扣费(在校验通过后)', async () => {
    (callAI as any).mockResolvedValue({ meta: { content: '{"scenes":[...]}' }, cost: 0.01 });
    const { parseScriptResult, validateAnalysisConsistency } = await import('@dramaforge/server');
    (parseScriptResult as any).mockReturnValue({ scenes: [{ id: 'S1', content: 'x' }], characters: [], infoPoints: [], sceneMeta: [], costumeMap: {} });
    (validateAnalysisConsistency as any).mockReturnValue({ ok: true });
    await runEpisodeAnalysis(base);
    expect(billDirectGeneration).toHaveBeenCalledTimes(1); // 成功才扣
    expect((await import('@dramaforge/server')).completeInlineAiTask).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @dramaforge/web test -- episode-analysis-runner`(模块不存在)。

- [ ] **Step 3: Implement** — 把现 `analyze/route.ts:127-278` 的业务逻辑(置 ANALYZING → callAI 重试循环 → parse → validate → 持久化 / 失败复位)抽进 `runEpisodeAnalysis`,改造点:
  - 入口先 `await reportInlineAiTaskProgress(taskId, userId, 5, '编剧分析', 0)`。
  - 各阶段调 `reportInlineAiTaskProgress`(15 构造提示词 / 30「AI 生成中」/ 70「校验一致性」/ 90「落库中」)。
  - callAI 用 `callAIWithTimeout({ call: () => callAI(...), timeoutMs: 6*60*1000 })`;超时/AiCallTimeoutError 走失败路径。
  - **B1**:`billDirectGeneration` 只在 `validateAnalysisConsistency().ok` 且即将持久化前调一次;重试循环内不再每次扣。
  - 成功:`completeInlineAiTask(taskId, userId, { episodeId, sceneCount })` + `episodeRepo.update(episodeId, { scriptData, scenes, status:'COMPLETED', stageStatus:'assets', ... })`。
  - 失败(空/parse 空/不一致/超时/gateway):`failInlineAiTask(taskId, userId, 安全文案)` + `episodeRepo.update(episodeId, { status:'PENDING', stageStatus:'input' })` + **不调 billDirectGeneration**。
  - `try/finally`:finally 保证若异常未走成功/失败显式分支,也 `failInlineAiTask` + 复位(双保险,绝不留 analyzing)。
  - 心跳:可选——callAI 期间起一个 8s `setInterval` 推 `reportInlineAiTaskProgress`(同进度值,保 SSE 活);callAI 返回后 clear。若 `startProgressHeartbeat` 可从 server 直接 import 复用则优先复用(读 `packages/server/src/ai-worker/handlers.ts:130` 确认其是否纯函数可跨包用;若耦合 worker 上下文则自写 8s interval)。

```ts
// packages/web/lib/episode-analysis-runner.ts(骨架,实现按上述改造点填)
import {
  callAI, episodeRepo, listAssets, projectRepo, buildScriptAnalysisPrompt,
  parseScriptResult, validateAnalysisConsistency, detectLanguage, readLocalizationProfile,
  reportInlineAiTaskProgress, completeInlineAiTask, failInlineAiTask, GatewayError,
} from '@dramaforge/server';
import { billDirectGeneration } from '@web/lib/direct-media-generation';
import { callAIWithTimeout, AiCallTimeoutError } from './ai-call-timeout';
import { buildEpisodeAnalysisContext } from './episode-analysis-context';
import { resolveAnalysisGuidance } from './analysis-guidance';
import { createHash } from 'crypto';

export interface RunEpisodeAnalysisInput {
  taskId: string; userId: string; projectId: string; episodeId: string;
  model: string; enhancementPrompt?: string; localizationProfile?: unknown;
}
export async function runEpisodeAnalysis(input: RunEpisodeAnalysisInput): Promise<void> {
  // …抽自 analyze/route.ts:127-278,按上面改造点重排扣费顺序 + 进度上报 + 超时 + finally 兜底
}
```

- [ ] **Step 4: Run, verify PASS** — `pnpm --filter @dramaforge/web test -- episode-analysis-runner`。补成功路径用例(已含)+ 补「超时 → fail + 不扣费」用例(`callAI` hang → callAIWithTimeout 抛)。

- [ ] **Step 5: typecheck** — `pnpm --filter @dramaforge/web typecheck`。

- [ ] **Step 6: Commit checkpoint**

---

## Task 5: analyze route 改薄(B2 路由层)

**Files:**
- Modify: `packages/web/app/api/projects/[id]/episodes/[episodeId]/analyze/route.ts`(现 282 行 → 削到 ~80 行)
- Test: `packages/web/app/api/projects/[id]/episodes/[episodeId]/analyze/__tests__/route.test.ts`(新建,仿 split/route.test.ts)

**Interfaces:**
- Consumes: `runEpisodeAnalysis`(Task 4)、`startInlineAiTask`。
- Produces: `POST` → `202 { taskId }`(契约变更,见 spec §B2)。去重:同 episode 已有 active STORY_ANALYZE task → 返回其 taskId。

- [ ] **Step 1: Write failing test(契约 + 去重)**

```ts
// .../analyze/__tests__/route.test.ts(头部仿 split/route.test.ts 的 import + serverMock + makeRequest/readJson)
describe('POST /analyze', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.episodeRepo.getById.mockReset();
    serverMock.startInlineAiTask.mockReset();
    serverMock.projectRepo.getById.mockImplementation(async (id) =>
      id === 'p1' ? { id: 'p1', userId: 'user-1', category: 'DOMESTIC' } : null);
    serverMock.episodeRepo.getById.mockImplementation(async (id) =>
      id === 'e1' ? { id: 'e1', projectId: 'p1', episodeNumber: 1, novelText: 'x'.repeat(50) } : null);
    serverMock.startInlineAiTask.mockResolvedValue({ id: 'task-new' });
  });

  it('返 202 + { taskId },并 fire-and-forget runner', async () => {
    const res = await POST(await makeRequest('POST', '/api/projects/p1/episodes/e1/analyze', { model: 'deepseek/x' }),
      { params: Promise.resolve({ id: 'p1', episodeId: 'e1' }) });
    expect(res.status).toBe(202);
    const json = await readJson(res);
    expect(json.taskId).toBe('task-new');
    expect(serverMock.startInlineAiTask).toHaveBeenCalledTimes(1);
  });

  it('同 episode 已有 active STORY_ANALYZE task → 返回既有 taskId,不新建', async () => {
    serverMock.episodeRepo.getById.mockImplementation(async (id) =>
      id === 'e1' ? { id: 'e1', projectId: 'p1', episodeNumber: 1, novelText: 'x'.repeat(50),
                      scriptData: { activeAnalysisTaskId: 'task-exist' } } : null);
    // 去重探针:先 listByProject / 查 tasks —— 按实现里去重探测方式 mock
    const res = await POST(await makeRequest('POST', '/api/projects/p1/episodes/e1/analyze', {}),
      { params: Promise.resolve({ id: 'p1', episodeId: 'e1' }) });
    const json = await readJson(res);
    expect(json.taskId).toBe('task-exist');
    expect(serverMock.startInlineAiTask).not.toHaveBeenCalled();
  });
});
```

> 去重实现取其一(Step 3 二选一,按简单优先):① 路由查 `tasks WHERE "userId" AND "projectId" AND type='STORY_ANALYZE' AND status='RUNNING'` 取一条返其 id(serverMock 需 mock 该查询);② episode.scriptData.activeAnalysisTaskId 钩子。**实现时选 ①(不污染 scriptData),测试相应 mock 查询函数。**

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @dramaforge/web test -- analyze`(POST 仍返 200 旧契约)。

- [ ] **Step 3: Implement route 改薄**

```ts
// analyze/route.ts 主体替换为(保留 ownership/余额/novelText 预检):
import { randomUUID } from 'crypto';
import { episodeRepo, projectRepo, startInlineAiTask, listActiveInlineTasks } from '@dramaforge/server';
import { runEpisodeAnalysis } from '@web/lib/episode-analysis-runner';
// ... 预检后:
// 去重:同 project 的 active STORY_ANALYZE task
const active = await listActiveInlineTasks(userId, projectId, 'STORY_ANALYZE'); // 新增 server 导出(见下)
const mine = active.find(t => (t.input as any)?.episodeId === episodeId);
if (mine) return apiSuccess({ taskId: mine.id }, 202);

const taskId = randomUUID();
await startInlineAiTask({ id: taskId, userId, projectId, type: 'STORY_ANALYZE', progress: 5, stage: '编剧分析', storedInput: { episodeId, projectId } });
await episodeRepo.update(episodeId, { status: 'ANALYZING', stageStatus: 'analyzing' });
void runEpisodeAnalysis({ taskId, userId, projectId, episodeId, model: modelId, enhancementPrompt, localizationProfile })
  .catch(async (err) => { // fire-and-forget 兜底:runner 内自有 try/finally,此 catch 仅防 promise rejection 泄漏
    await failInlineAiTask(taskId, userId, '分析异常,请重试');
    await episodeRepo.update(episodeId, { status: 'PENDING', stageStatus: 'input' }).catch(() => {});
    console.error('[analyze] runner 异常', err);
  });
return apiSuccess({ taskId }, 202);
```

> `listActiveInlineTasks(userId, projectId, type)` 需在 `packages/server/src/task/ai-task-repo.ts` 新增(查 `tasks WHERE status='RUNNING' AND ...`),加单测。若不想新增导出,退化为内联 SQL via 现有 query——但优先加到 repo(对齐 enqueueAiTask 的 dedupe 风格)。

- [ ] **Step 4: Run, verify PASS** + 删除旧 route 内的 callAI/parse/validate/bill 逻辑(已迁 Task 4)。

- [ ] **Step 5: typecheck** — `pnpm -r typecheck`。

- [ ] **Step 6: Commit checkpoint**

---

## Task 6: storyboard runner + route(B2+B1,镜像 Task 4/5)

**Files:**
- Create: `packages/web/lib/storyboard-generation-runner.ts` + `__tests__/storyboard-generation-runner.test.ts`
- Modify: `packages/web/app/api/projects/[id]/episodes/[episodeId]/generate-storyboard/route.ts` + 新 `__tests__/route.test.ts`

**Interfaces:** 同 Task 4/5 形状,`runStoryboardGeneration(input)`;route 返 `202 { taskId }`,type `SHOT_AI`(或 `STORYBOARD_GENERATE`——对齐 `types.ts:34-50` 现有枚举,优先复用 `SHOT_AI`)。

- [ ] **Step 1: failing test(storyboard runner)** — 断言:`AI_EMPTY`(content 空)→ fail + 不扣费;`AI_NO_SHOTS`(parse 空)→ fail + 不扣费;合法 shots → complete + `replaceEpisodeShots` 被调 + 扣费 1 次。mock 仿 Task 4。
- [ ] **Step 2: verify FAIL**
- [ ] **Step 3: Implement runner** — 抽自 `generate-storyboard/route.ts:277-444`(callAI → bill→**后移** → parseStoryboardShots → postprocessStoryboardShots → replaceEpisodeShots → episodeRepo.update(storyboardWarnings) → projectRepo.update(STORYBOARD));进度 5/30/70/90/100;callAIWithTimeout(6min);finally 兜底复位。注意:**storyboard 失败的 stageStatus 复位目标**——分镜失败应回 `storyboard`(可重试),不是 input(分析成果要保留)。参照现 route 无显式 stage 推进(它只推 project.status='STORYBOARD'),runner 失败时不改 episode.stageStatus(保持原状),只 failInlineAiTask。
- [ ] **Step 4: route 改薄** — 仿 Task 5:startInlineAiTask(SHOT_AI)→ fire runStoryboardGeneration → 202 { taskId }。去重 type=SHOT_AI。
- [ ] **Step 5: route failing→passing test** — 202 契约 + 去重。
- [ ] **Step 6: typecheck** — `pnpm -r typecheck`。
- [ ] **Step 7: Commit checkpoint**

---

## Task 7: 前端 taskId/draft store + `useEpisodeTask` hook(F3/F2 基础)

**Files:**
- Create: `packages/web/lib/episode-task-store.ts`(纯 localStorage,无 React 依赖,易测)
- Create: `packages/web/hooks/useEpisodeTask.ts`
- Test: `packages/web/lib/__tests__/episode-task-store.test.ts`

**Interfaces:**
- Produces(store):
  - `getDraft(projectId, episodeId): string | null` / `setDraft(projectId, episodeId, text)` / `clearDraft(projectId, episodeId)`
  - `getTaskId(type, episodeId): string | null` / `setTaskId(type, episodeId, taskId)` / `clearTaskId(type, episodeId)`
- Produces(hook): `useEpisodeTask(episodeId: string, type: 'STORY_ANALYZE'|'SHOT_AI'): { taskId: string|null; status; progress; stage }` — 内部读 localStorage taskId + `useTaskStatus(taskId)`;taskId 失效(COMPLETED/FAILED/404)→ clearTaskId。

- [ ] **Step 1: failing test(store)**

```ts
// packages/web/lib/__tests__/episode-task-store.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDraft, setDraft, clearDraft, getTaskId, setTaskId, clearTaskId } from '../episode-task-store';

beforeEach(() => localStorage.clear());

describe('episode-task-store', () => {
  it('draft 按 projectId+episodeId 隔离读写清', () => {
    setDraft('p1', 'e1', 'hello');
    expect(getDraft('p1', 'e1')).toBe('hello');
    expect(getDraft('p1', 'e2')).toBeNull();
    clearDraft('p1', 'e1');
    expect(getDraft('p1', 'e1')).toBeNull();
  });
  it('taskId 按 type+episodeId 隔离', () => {
    setTaskId('STORY_ANALYZE', 'e1', 't1');
    expect(getTaskId('STORY_ANALYZE', 'e1')).toBe('t1');
    expect(getTaskId('SHOT_AI', 'e1')).toBeNull();
  });
});
```

> vitest 默认无 `localStorage`——在 `packages/web/vitest.config.ts` 的 `environment: 'jsdom'` 确认;若非 jsdom,测试顶部加 `globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{}, clear:()=>{} }` 的最小 stub,或 store 内做 `typeof localStorage` 守卫(SSR 安全)。**先读 vitest.config.ts 确认 environment 再定。**

- [ ] **Step 2: verify FAIL**
- [ ] **Step 3: Implement store**(`localStorage` 守卫 + try/catch 防隐私模式抛错,key 前缀 `dramaforge:`)。
- [ ] **Step 4: Implement hook** — 读 `packages/web/hooks/useTaskStatus.ts` 的 `useTaskStatus(taskId)` 签名与返回;hook 内 `const taskId = getTaskId(type, episodeId)`;`const t = useTaskStatus(taskId ?? '')`;若 `t.status` ∈ {COMPLETED,FAILED} 或 taskId null → `clearTaskId` + 返 null;`onComplete`/`onFailure` 由调用方 `GenerationProgress` 处理。
- [ ] **Step 5: verify PASS** + typecheck。
- [ ] **Step 6: Commit checkpoint**

---

## Task 8: InputStage 草稿持久化(F2)

**Files:**
- Modify: `packages/web/app/workspace/[projectId]/components/InputStage.tsx`(`:159` scriptDraft、`:259-263` 初始化 effect)

**Interfaces:** Consumes `getDraft/setDraft/clearDraft`(Task 7)。

- [ ] **Step 1: 改 scriptDraft 初始化与同步**
  - `:159` 仍保留 `useState`,但初始值与 effect(`:259-263`)改为:`const persisted = getDraft(projectId, episodeId); setScriptDraft(persisted ?? episode?.novelText ?? episode?.content ?? episode?.videoScriptDraft ?? '')`。
  - 编辑时 debounce 写 store:`React.useEffect(() => { if (scriptDraft && projectId && episodeId) setDraft(projectId, episodeId, scriptDraft); }, [scriptDraft, projectId, episodeId])`(或 onBlur 写,避免每键写——debounce 300ms)。
  - `handleSaveAndAnalyze` 成功后(Task 11 改契约后)与现有保存后:`clearDraft(projectId, episodeId)`。

- [ ] **Step 2: typecheck + 手动冒烟(§5)** — 桌面端:编辑 A 集不保存 → 切到 B 集 → 切回 A → 草稿在;刷新页面 → 草稿在;保存并分析成功 → 草稿清。
- [ ] **Step 3: Commit checkpoint**

---

## Task 9: InputStage 右侧常驻侧栏(F1)

**Files:**
- Modify: `packages/web/app/workspace/[projectId]/components/InputStage.tsx`(`:609` 单栏容器、`:770-805` 按钮行、`:807-834` 进度条)

- [ ] **Step 1: 重排为双栏**
  - 外层 `:609` `<div className="max-w-4xl mx-auto space-y-4">` → 改 `<div className="mx-auto grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-6 max-w-6xl">`。
  - 左栏 = 现有编辑器 + docx 区(`:611-767`)。
  - 右栏 = 新 `<aside className="hidden lg:flex flex-col gap-3 sticky top-4 self-start">`,内含:模型选择(`:611-686` 里的 text-to-style/模型 UI 抽出)、扣费提示(`:798-800`)、`GenerationProgress`(Task 11 接入)、保存并分析按钮(`:787-802`)。
  - 删除 `:770-805` 旧按钮行 + `:807-834` 旧进度条(已并入右栏)。
  - 窄屏降级:`<lg` 右栏 `hidden`,改在左栏底部加 `<div className="lg:hidden sticky bottom-0 …">` 含按钮 + 进度(底部粘性栏)。

- [ ] **Step 2: typecheck + 手动冒烟** — 桌面端:宽屏右栏常驻不随编辑器滚动,按钮始终可见;窄屏降级底部粘性栏。
- [ ] **Step 3: Commit checkpoint**

> 视觉对照 spec §F1 mockup。前端视觉检查走 CLAUDE.md 视觉流程(Playwright 截图 + vision)在 dev server 上验。

---

## Task 10: 消 desync —— 删 effectiveStage 重映射 + 修 EpisodeTabs 徽标(F4)

**Files:**
- Modify: `packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx`(`:665-667` effectiveStage、`:696-697` EpisodeTabs stageStatus)

- [ ] **Step 1: 删重映射** — `:665-667` 改为 `const effectiveStage: StageKey = viewStage;`(删 `analyzingActive` 重映射分支 + 其注释)。确认 `effectiveStage` 仍用于 `:761/815/838/871/889` 的条件渲染与 `:722` StageNav。
- [ ] **Step 2: EpisodeTabs 徽标用服务端真相** — `:696-697` `stageStatus: e.id === episodeId ? viewStage : deriveStageFromEpisode(e.stageStatus)` → 改 `stageStatus: deriveStageFromEpisode(e.stageStatus)`(所有 tab 一致用服务端 stageStatus;当前集不再特殊化用 viewStage)。
- [ ] **Step 3: typecheck + 手动冒烟** — 桌面端:点保存并分析 → 真进 AnalyzingStage(URL/Tab/Body 三方一致显示 analyzing),不再"看起来进了实际在 input"。
- [ ] **Step 4: Commit checkpoint**

---

## Task 11: 接入 GenerationProgress + 自动跳转 + 契约适配(F3/F5/F6)

**Files:**
- Modify: `packages/web/lib/analysis-workflow.ts`(`runAnalysisWorkflow`)
- Modify: `InputStage.tsx`(`handleSaveAndAnalyze` `:368-457`)、`AnalyzingStage.tsx`(`:722-736`)、`StoryboardStage.tsx`(`:699/749/972-992`)
- Consumes: `useEpisodeTask`(Task 7)、`GenerationProgress`、`setTaskId/clearTaskId`(Task 7)

- [ ] **Step 1: `runAnalysisWorkflow` 契约改 202** — 不再 await /analyze 拿结果;只 POST 拿 `{ taskId }` 返回;删除 55/80/100 假进度(进度由 SSE 驱动)。资产提取从"自动顺序调"改为"返回标记,由 onComplete 触发"(见 Step 3)。签名改返 `{ taskId, needAssetExtraction: boolean } | null`。
- [ ] **Step 2: InputStage `handleSaveAndAnalyze`** — PATCH 存稿 → `const r = await runAnalysisWorkflow(...)` → 若 r:`setTaskId('STORY_ANALYZE', episodeId, r.taskId)` → `clearDraft` → `onNavigateNext('analyzing')`(已有 `:810`)。不再 await AI 完成(后台跑);不再 `onRefresh({force:true})` 在此处(改 onComplete)。
- [ ] **Step 3: AnalyzingStage 接 GenerationProgress** — `:722-736` pulse-only `ProgressBar` 换 `<GenerationProgress taskId={taskId} label="AI 编剧分析中" estimatedDuration={90} onComplete={() => { clearTaskId('STORY_ANALYZE', episodeId); if (needAssetExtraction) void triggerAssetExtraction(); onRefresh?.({force:true}); }} onFailure={() => onRefresh?.({force:true})} />`,`taskId` 来自 `useEpisodeTask(episodeId,'STORY_ANALYZE')`。`triggerAssetExtraction` = 现有 `/asset-extraction` POST(仅项目无资产时,逻辑搬自旧 runAnalysisWorkflow `:70-81`)。
- [ ] **Step 4: StoryboardStage 接 GenerationProgress** — `runGenerate`(`:699`)POST 拿 `{ taskId }` → `setTaskId('SHOT_AI', episodeId, taskId)`;`:972-992` 二态 `ProgressBar` 换 `<GenerationProgress taskId={useEpisodeTask(episodeId,'SHOT_AI').taskId} label="分镜生成中" estimatedDuration={60} onComplete={() => { clearTaskId('SHOT_AI', episodeId); onRefresh?.({force:true}); }} />`。删 `justCompleted` 二态逻辑。
- [ ] **Step 5: typecheck** — `pnpm -r typecheck`。
- [ ] **Step 6: 全链手动冒烟(§5,部署后桌面端)** — 见下「端到端冒烟」。
- [ ] **Step 7: Commit checkpoint**

---

## 端到端冒烟(部署后,用户桌面端,§5)

部署 server(`bash /d/dramaforge-cs/scripts/deploy.sh <tag>`,本批零迁移)。桌面端走一遍:
1. 新建项目→拆集→进某集;编辑文本**不保存**→切到别集→切回→**草稿在**(F2)。
2. 点右侧栏「保存并分析」→**真进 AnalyzingStage**,进度条分阶段实时跳动不静止(F3/F4/F5);后台完成→AnalyzingStage 展示场景/角色;扣费 1 次(成功)。
3. 故意触发失败(断网/换无效 model)→进度条转失败可重试,**不扣费**(B1),stageStatus 复位可重试。
4. 分析中刷新页面→进度条从 SSE 接管继续显示真实进度(F3 localStorage taskId)。
5. 分镜生成→进度条实时跳动(F6);成功落 shots。
6. 卡死场景(可选):杀 web 容器模拟重启→60s 内 sweep 复位 analyzing(B3)。

## 部署 / 回滚

- server:`bash /d/dramaforge-cs/scripts/deploy.sh <tag>`(web + ai-worker,含 B3 sweep)。零迁移。
- 不需 client 发版(纯 web,Electron 壳加载 web)。
- 回滚:`bash scripts/rollback.sh`(镜像回滚,无迁移风险)。
- 失败不扣费(B1)对存量无影响(只改新调用)。卡死 analyzing 的存量集(如 4928 魔校法则那 1 集)会在 sweep 上线后 60s 自动复位。

## Self-Review(已自查)

- **Spec 覆盖**:B1(Task 4/6)、B2(Task 3/4/5/6)、B3(Task 1/2)、F1(Task 9)、F2(Task 7/8)、F3(Task 7/11)、F4(Task 10)、F5(Task 11)、F6(Task 11)、契约变更(Task 5/6/11)、响应契约(Task 5 Step3 已注)——全覆盖。
- **类型一致**:`runEpisodeAnalysis`/`runStoryboardGeneration`(Task 4/6 产出)↔ Task 5/6 route 消费一致;`useEpisodeTask`/store(Task 7)↔ Task 8/11 消费一致;`listActiveInlineTasks` 在 Task 5 引入并注明需在 ai-task-repo 新增+测。
- **无占位**:UI Task(8/9/10/11)按 AGENTS.md §5 用 typecheck + 桌面端冒烟(代码库无组件测试,不为视觉硬造单测);后端/hook 全有真实 vitest 代码。去重探测、心跳复用、vitest environment 三处给了"先读 X 再定"的明确核验锚点(非 TODO,是 AGENTS.md §1 核验纪律)。
