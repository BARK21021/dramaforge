# 分镜时长选择 + 镜头编号体系 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让分镜生成支持「有参考视频则跟随参考视频时长，否则弹窗让用户选总时长」；并让每个镜头在分镜表/镜头组库/成片库有清晰、详细、唯一的结构化编号。

**Architecture:** Part A 在服务端新增「明确目标时长」预算构造器 + 优先级解析（参考视频 > 用户选择 > 90–150 兜底），路由读取 body 的 `totalDurationSeconds` 并据此选预算；前端 `StoryboardStage` 点生成时按是否有参考视频决定「直接生成」或「弹窗选择」。Part B 新增纯函数 `formatShotLabel`/`formatShotRange`，在分镜表 `#` 列、`/api/groups` 返回的组范围、成片库卡片三处统一渲染 `第N集·组名·镜头NN`。两块互相独立，可分别实现/提交。

**Tech Stack:** Next.js 16 (app router) · React 19 · Tailwind v4 · pnpm workspace · vitest · TypeScript strict。包名：`@dramaforge/server`、`@dramaforge/web`、`@dramaforge/shared`。Radix **未**安装（`Modal` 为手写组件）。

## Global Constraints

- **媒体资产仅本地 / AI key 仅云端**（`dramaforge-assets-client-local` / `dramaforge-keys-cloud-server-only`）：本计划不碰媒体字节、不引入本地 key；本地无 key 无法真生成，只做结构与单元测试。
- **前端对齐 app1**（`dramaforge-frontend-align-app1`）：Modal/按钮沿用 dramaforge 既有 `components/ui/Modal.tsx` 与 `Button` 模式，双色铁律（身份/分组用 `--accent` 琥珀，可点击行为用 `--action` 蓝）。
- **ORIGINAL 路径不动**：`packages/shared/src/long-video-prompt.ts` 仍 90s/集，本轮只改标准分镜路径。
- **Seedance 硬约束保留**：单镜头 2–15s、单组 ≤15s 不变（`prompt.ts:89`、`postprocess.ts:215-225`）。
- **`EpisodeRecord.scriptData` 类型为 `unknown`**（`packages/shared/src/episode.ts:151`）：消费必须 `typeof` narrow + cast。
- **提交规则**：按用户全局规则，**未经用户明确要求不要 `git commit`**。下方各 Task 的「Commit」步骤默认跳过；仅当用户明确要求提交时才执行，且若在默认分支上需先开分支。
- **路径约定**：Windows 仓库，文件路径用反斜杠；shell 用 bash（POSIX 语法）。

---

## File Structure

**Part A — 时长选择**
- Modify `packages\server\src\domain\prompt\target-languages.ts` — 新增 `buildExplicitDurationBudget` + `resolveExplicitStoryboardTarget` 纯函数。
- Modify `packages\server\src\domain\prompt\index.ts` — 导出新函数（domain barrel）。
- Modify `packages\server\src\index.ts` — 导出新函数（package barrel，显式列表 ~line 252）。
- Modify `packages\web\app\api\projects\[id]\episodes\[episodeId]\generate-storyboard\route.ts` — body 增读 `totalDurationSeconds`，按优先级选预算。
- Modify `packages\web\app\workspace\[projectId]\components\StoryboardStage.tsx` — 生成前 Modal + 参考视频自动跟随 + 顶部状态条 + 新增 prop。
- Modify `packages\web\app\workspace\[projectId]\components\EpisodeWorkspace.tsx` — 传 `sourceVideoDurationSeconds` prop。
- Test `packages\server\src\domain\prompt\__tests__\target-languages.test.ts` — 两个新函数单元测试。

**Part B — 镜头编号**
- Create `packages\web\lib\shot-label.ts` — `pad2`/`formatShotLabel`/`formatShotRange` 纯函数。
- Test `packages\web\lib\__tests__\shot-label.test.ts`。
- Modify `packages\web\app\workspace\[projectId]\components\StoryboardStage.tsx` — `#` 列渲染编号 + `getShotGroupName` helper。
- Modify `packages\web\app\api\groups\route.ts` — `GroupItem` 增 `shotStart`/`shotEnd`/`groupName`（SELECT 加 `shotIndex` + `metadata`）。
- Modify `packages\web\app\workspace\[projectId]\components\GroupLibraryPanel.tsx` — 组卡渲染 `formatShotRange`。
- Modify `packages\web\app\workspace\[projectId]\components\FilmLibraryPanel.tsx` — 成片卡渲染 `formatShotRange`。

---

# Part A — 分镜时长选择

## Task A1: 服务端「明确目标时长」预算 + 优先级解析

**Files:**
- Modify: `packages\server\src\domain\prompt\target-languages.ts`（在 `buildLocalizedDurationBudget` 之后，约 line 109 后插入）
- Modify: `packages\server\src\domain\prompt\index.ts:135`（export 列表）
- Modify: `packages\server\src\index.ts:252`（export 列表）
- Test: `packages\server\src\domain\prompt\__tests__\target-languages.test.ts`

**Interfaces:**
- Produces: `buildExplicitDurationBudget(targetSeconds: number, profile?: LocalizationProfile, fallbackLanguageCode?: string): LocalizedDurationBudget`；`resolveExplicitStoryboardTarget(sourceDurationSeconds?: number | null, bodyTotalDuration?: number | null): number | undefined`。

- [ ] **Step 1: 写失败测试**

创建 `packages\server\src\domain\prompt\__tests__\target-languages.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import {
  buildExplicitDurationBudget,
  resolveExplicitStoryboardTarget,
} from '../target-languages';

describe('buildExplicitDurationBudget', () => {
  it('以目标为权威，±5% 带，不夹 90–150，languageFactor=1', () => {
    const b = buildExplicitDurationBudget(300);
    expect(b.languageFactor).toBe(1);
    expect(b.targetSeconds).toBe(300);
    expect(b.minSeconds).toBe(285);
    expect(b.maxSeconds).toBe(315);
  });

  it('短目标不被夹到 90', () => {
    const b = buildExplicitDurationBudget(15);
    expect(b.targetSeconds).toBe(15);
    expect(b.minSeconds).toBe(14);
    expect(b.maxSeconds).toBe(16);
  });

  it('非正输入退化为 90', () => {
    expect(buildExplicitDurationBudget(0).targetSeconds).toBe(90);
    expect(buildExplicitDurationBudget(NaN).targetSeconds).toBe(90);
  });

  it('languageCode 取自 profile，系数仍为 1', () => {
    const b = buildExplicitDurationBudget(120, {
      stylePrompt: 'x',
      targetLanguage: { code: 'de' } as never,
    });
    expect(b.languageCode).toBe('de');
    expect(b.languageFactor).toBe(1);
  });
});

describe('resolveExplicitStoryboardTarget', () => {
  it('参考视频优先于 body', () => {
    expect(resolveExplicitStoryboardTarget(200, 300)).toBe(200);
  });
  it('无参考视频时取 body', () => {
    expect(resolveExplicitStoryboardTarget(undefined, 300)).toBe(300);
  });
  it('参考视频非正时回退 body', () => {
    expect(resolveExplicitStoryboardTarget(0, 120)).toBe(120);
  });
  it('两者都无 → undefined', () => {
    expect(resolveExplicitStoryboardTarget(undefined, undefined)).toBeUndefined();
    expect(resolveExplicitStoryboardTarget(null, null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @dramaforge/server exec vitest run src/domain/prompt/__tests__/target-languages.test.ts`
Expected: FAIL — `buildExplicitDurationBudget is not a function`（未导出）。

- [ ] **Step 3: 实现两个纯函数**

在 `packages\server\src\domain\prompt\target-languages.ts` 的 `buildLocalizedDurationBudget` 函数之后（line 109 `}` 之后）插入：

```ts
/**
 * 用户明确指定目标时长（参考视频时长或弹窗选择）时构造预算。
 * 不套语言系数、不夹 90–150 锚点：目标即权威，仅给 ±5% 弹性让 LLM 自然落点。
 * languageCode 仍取自本地化档案，供 prompt 标注目标语种。
 */
export function buildExplicitDurationBudget(
  targetSeconds: number,
  profile?: LocalizationProfile | undefined,
  fallbackLanguageCode = 'en',
): LocalizedDurationBudget {
  const target = Number.isFinite(targetSeconds) && targetSeconds > 0 ? targetSeconds : 90;
  const languageCode =
    profile?.targetLanguage?.code?.toLowerCase() || fallbackLanguageCode.toLowerCase();
  const minSeconds = Math.max(1, Math.round(target * 0.95));
  const maxSeconds = Math.round(target * 1.05);
  return {
    languageCode,
    languageFactor: 1,
    minSeconds,
    targetSeconds: Math.round(target),
    maxSeconds: Math.max(minSeconds, maxSeconds),
  };
}

/**
 * 分镜时长优先级解析：参考视频时长（完全跟随，忽略 body）> 用户弹窗选择 > 无（兜底 90–150）。
 * 返回 undefined 表示走老 buildLocalizedDurationBudget 兜底。
 */
export function resolveExplicitStoryboardTarget(
  sourceDurationSeconds?: number | null,
  bodyTotalDuration?: number | null,
): number | undefined {
  if (
    typeof sourceDurationSeconds === 'number' &&
    Number.isFinite(sourceDurationSeconds) &&
    sourceDurationSeconds > 0
  ) {
    return sourceDurationSeconds;
  }
  if (
    typeof bodyTotalDuration === 'number' &&
    Number.isFinite(bodyTotalDuration) &&
    bodyTotalDuration > 0
  ) {
    return bodyTotalDuration;
  }
  return undefined;
}
```

- [ ] **Step 4: 在两个 barrel 导出**

`packages\server\src\domain\prompt\index.ts` —— 在 target-languages 的 export 块里，`buildLocalizedDurationBudget,`（line 135）之后加一行：

```ts
  buildExplicitDurationBudget,
  resolveExplicitStoryboardTarget,
```

`packages\server\src\index.ts` —— 在显式 re-export 列表里，`buildLocalizedDurationBudget,`（line 252）之后加：

```ts
  buildExplicitDurationBudget,
  resolveExplicitStoryboardTarget,
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @dramaforge/server exec vitest run src/domain/prompt/__tests__/target-languages.test.ts`
Expected: PASS（8 个测试全绿）。

- [ ] **Step 6: typecheck**

Run: `pnpm --filter @dramaforge/server typecheck`
Expected: 0 error。

- [ ] **Step 7: Commit（默认跳过，仅用户要求时执行）**

```bash
git add packages/server/src/domain/prompt/target-languages.ts packages/server/src/domain/prompt/index.ts packages/server/src/index.ts packages/server/src/domain/prompt/__tests__/target-languages.test.ts
git commit -m "feat(storyboard): explicit duration budget + priority resolver"
```

---

## Task A2: generate-storyboard 路由接入明确目标时长

**Files:**
- Modify: `packages\web\app\api\projects\[id]\episodes\[episodeId]\generate-storyboard\route.ts`（body 解析 ~line 152-160；预算构造 ~line 174-186；import ~line 27-44）

**Interfaces:**
- Consumes: `buildExplicitDurationBudget`、`resolveExplicitStoryboardTarget`（来自 A1，经 `@dramaforge/server`）。

- [ ] **Step 1: 扩 import**

在 `route.ts` 顶部 `@dramaforge/server` 的 import 列表里（line 27-44），把 `buildLocalizedDurationBudget,` 那一行下方加：

```ts
  buildExplicitDurationBudget,
  resolveExplicitStoryboardTarget,
```

- [ ] **Step 2: 扩 body 解析类型**

把 line 152-160 的 body 解析改为同时读 `totalDurationSeconds`：

```ts
    let body: { model?: unknown; totalDurationSeconds?: unknown };
    try {
      const raw = (await req.json()) as unknown;
      body = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { model?: unknown; totalDurationSeconds?: unknown })
        : {};
    } catch {
      body = {};
    }
```

- [ ] **Step 3: 按优先级选预算**

把 line 174-186（`const episodeScriptData = ...` 到 `});`）替换为：

```ts
    const episodeScriptData = episode.scriptData && typeof episode.scriptData === 'object'
      ? (episode.scriptData as Record<string, unknown>)
      : {};
    const sourceDurationSeconds =
      typeof episodeScriptData.sourceVideoDurationSeconds === 'number'
        ? episodeScriptData.sourceVideoDurationSeconds
        : undefined;
    // 时长优先级：参考视频时长（完全跟随，忽略 body）> 用户弹窗选择 > 兜底 90–150。
    const bodyTotalDuration =
      typeof body.totalDurationSeconds === 'number' &&
      Number.isFinite(body.totalDurationSeconds) &&
      body.totalDurationSeconds > 0
        ? body.totalDurationSeconds
        : undefined;
    const explicitTarget = resolveExplicitStoryboardTarget(sourceDurationSeconds, bodyTotalDuration);
    const durationBudget = explicitTarget
      ? buildExplicitDurationBudget(explicitTarget, localizationProfile)
      : buildLocalizedDurationBudget(localizationProfile, sourceDurationSeconds);
    const { system, user } = buildStoryboardPrompt(scenes, assets, {
      episodeNumber: episode.episodeNumber,
      localizationProfile,
      visualStylePrompt: getProjectArtStylePreset(project.artStyle)?.promptZh,
      durationBudget,
    });
```

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @dramaforge/web typecheck`
Expected: 0 error。

- [ ] **Step 5: 手工核对（无 key 不能真生成）**

确认：`prompt.ts` 无需改动——它已正确消费 `opts.durationBudget`（line 98-100、178-182），新预算只是 min/target/max 来源不同。读一遍 `buildStoryboardPrompt` 输出确认 `durationBudget.targetSeconds=300` 时 user prompt 含「目标总时长 285-315 秒（推荐 300 秒）」。

- [ ] **Step 6: Commit（默认跳过）**

```bash
git add packages/web/app/api/projects/[id]/episodes/[episodeId]/generate-storyboard/route.ts
git commit -m "feat(storyboard): route accepts totalDurationSeconds; reference-video priority"
```

---

## Task A3: StoryboardStage 生成前弹窗 + 参考视频自动跟随

**Files:**
- Modify: `packages\web\app\workspace\[projectId]\components\StoryboardStage.tsx`（import ~line 46-63；Props ~line 251；组件参数 ~line 380；handleGenerate ~line 555-590；顶部栏 ~line 660-675；末尾闭合 `</div>` 前加 Modal）

**Interfaces:**
- Consumes: `Modal`（`../../../../components/ui/Modal`）；新 prop `sourceVideoDurationSeconds?: number | null`（由 A4 传入）。
- Produces: POST body 由 `{ rewrite }` 变为 `{ rewrite, totalDurationSeconds? }`。

- [ ] **Step 1: 加 import 与 prop**

在 import 区（line 53 `ShotAssetReferenceBadges` 附近）加：

```ts
import { Modal } from '../../../../components/ui/Modal';
```

在 `StoryboardStageProps`（line 251）里，`episode?: {...} | null;` 之后加一个字段：

```ts
  /** 参考视频时长（秒）；>0 表示有参考视频，生成时完全跟随、不弹窗。来自 episode.scriptData.sourceVideoDurationSeconds。 */
  sourceVideoDurationSeconds?: number | null;
```

- [ ] **Step 2: 组件参数解构新 prop**

在组件参数列表（line 380 起）加入 `sourceVideoDurationSeconds`：

```ts
export function StoryboardStage({
  projectId,
  episodeId,
  shots,
  episode,
  assets = [],
  sourceVideoDurationSeconds = null,
  // category 透传给 generate-storyboard route（DOMESTIC/OVERSEAS 影响语言分支）。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  category: _category,
  api,
```

- [ ] **Step 3: 加时长选项常量与状态**

在组件内（`handleGenerate` 之前，约 line 549 附近）加：

```ts
  /** 弹窗时长选项（秒）。1min30s 为默认。 */
  const DURATION_OPTIONS: Array<{ value: string; label: string }> = [
    { value: '15', label: '15 秒' },
    { value: '30', label: '30 秒' },
    { value: '60', label: '1 分钟' },
    { value: '90', label: '1 分 30 秒（默认）' },
    { value: '120', label: '2 分钟' },
    { value: '180', label: '3 分钟' },
    { value: '300', label: '5 分钟' },
    { value: 'custom', label: '自定义' },
  ];
  const [durationModalOpen, setDurationModalOpen] = React.useState(false);
  const [durationChoice, setDurationChoice] = React.useState<string>('90');
  const [customDuration, setCustomDuration] = React.useState<string>('90');
```

- [ ] **Step 4: 拆 handleGenerate 为「入口」+「执行」**

把 line 555-590 的 `handleGenerate` 整体替换为：

```ts
  const runGenerate = async (totalDurationSeconds?: number) => {
    if (!episodeId) {
      toast.error('缺少分集 ID');
      return;
    }
    if (showGenerating) {
      toast.warning('分镜生成中，请勿重复触发');
      return;
    }
    const beforeCount = shots.length;
    inflight.start({ beforeCount });
    setGenerating(true);
    setDurationModalOpen(false);
    toast.info('分镜生成任务已提交，预计 1-3 分钟完成');
    try {
      const rewrite = shots.length > 0;
      const body: { rewrite: boolean; totalDurationSeconds?: number } = { rewrite };
      if (typeof totalDurationSeconds === 'number') body.totalDurationSeconds = totalDurationSeconds;
      const d = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/generate-storyboard`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      )) as { shots?: ShotRecord[] } | null;
      if (d) {
        toast.success(`分镜生成完成，已回填 ${d.shots?.length ?? 0} 个镜头`);
        onRefresh?.();
      } else {
        toast.error('分镜生成失败');
      }
    } catch (e: unknown) {
      toast.error(`分镜生成失败: ${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setGenerating(false);
      inflight.end();
    }
  };

  /**
   * 触发分镜生成入口：有参考视频→完全跟随、直接生成；否则弹窗让用户选总时长。
   */
  const handleGenerate = () => {
    if (!episodeId) {
      toast.error('缺少分集 ID');
      return;
    }
    if (showGenerating) {
      toast.warning('分镜生成中，请勿重复触发');
      return;
    }
    if (sourceVideoDurationSeconds && sourceVideoDurationSeconds > 0) {
      void runGenerate(undefined);
      return;
    }
    setDurationModalOpen(true);
  };

  /** 弹窗确认：把选择折算成秒后执行生成。 */
  const confirmDuration = () => {
    const secs =
      durationChoice === 'custom'
        ? Math.max(10, Math.min(600, Number(customDuration) || 90))
        : Number(durationChoice);
    void runGenerate(secs);
  };
```

- [ ] **Step 5: 顶部生成按钮 onClick 适配（保留 void）**

顶部按钮（line 668-675）的 `onClick={() => void handleGenerate()}` 改为 `onClick={() => handleGenerate()}`（handleGenerate 现已无返回值）：

```tsx
          <Button
            variant="primary"
            onClick={() => handleGenerate()}
            loading={showGenerating}
            disabled={!episodeId || showGenerating}
          >
            {shots.length > 0 ? '重新生成分镜' : '生成分镜'}
          </Button>
```

- [ ] **Step 6: 顶部状态条显示参考视频跟随**

在顶部统计区（line 660-664 的 `{shots.length > 0 && (...)}` 之后）加参考视频提示：

```tsx
          {sourceVideoDurationSeconds && sourceVideoDurationSeconds > 0 ? (
            <span className="text-xs text-[var(--accent)] tabular-nums">
              目标时长：跟随参考视频 {sourceVideoDurationSeconds.toFixed(1)}s
            </span>
          ) : null}
```

- [ ] **Step 7: 末尾加时长选择 Modal**

在组件最外层 `</div>`（line 650 起的那个 `return (` 包裹的根 div）闭合之前插入 Modal。定位：紧贴 `return ( <div className={cn('flex flex-col h-full', className)}>` 内、所有现有内容之后、`</div>` 之前：

```tsx
        <Modal
          open={durationModalOpen}
          onClose={(o) => {
            if (!showGenerating) setDurationModalOpen(o);
          }}
          title="分镜总时长"
          description="选择本集分镜的目标总时长。有参考视频时自动跟随参考视频，无需选择。"
          maxWidthClassName="max-w-md"
        >
          <div className="space-y-2">
            {DURATION_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2 text-sm text-[var(--text-2)] cursor-pointer"
              >
                <input
                  type="radio"
                  name="duration-choice"
                  value={opt.value}
                  checked={durationChoice === opt.value}
                  onChange={() => setDurationChoice(opt.value)}
                />
                {opt.label}
              </label>
            ))}
            {durationChoice === 'custom' && (
              <div className="flex items-center gap-2 pl-6">
                <Input
                  type="number"
                  min={10}
                  max={600}
                  step={5}
                  value={customDuration}
                  onChange={(e) => setCustomDuration(e.target.value)}
                  className="w-28"
                />
                <span className="text-xs text-[var(--text-3)]">秒（10–600）</span>
              </div>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setDurationModalOpen(false)}
              disabled={showGenerating}
            >
              取消
            </Button>
            <Button variant="primary" onClick={() => confirmDuration()} loading={showGenerating}>
              确认生成
            </Button>
          </div>
        </Modal>
```

- [ ] **Step 8: typecheck**

Run: `pnpm --filter @dramaforge/web typecheck`
Expected: 0 error（注：此时 `sourceVideoDurationSeconds` prop 暂未被传入，TS 不报错——可选 prop 缺省为 `null`）。

- [ ] **Step 9: Commit（默认跳过）**

```bash
git add packages/web/app/workspace/[projectId]/components/StoryboardStage.tsx
git commit -m "feat(storyboard): duration modal + reference-video auto-follow"
```

---

## Task A4: EpisodeWorkspace 传入参考视频时长

**Files:**
- Modify: `packages\web\app\workspace\[projectId]\components\EpisodeWorkspace.tsx`（顶部 helper 区；render `<StoryboardStage>` ~line 795-803）

**Interfaces:**
- Consumes: `EpisodeRecord`（已 import，line 40），其 `scriptData: unknown`。

- [ ] **Step 1: 加读取 helper**

在文件顶层（组件函数外，其他 helper 附近）加：

```ts
/** 从 episode.scriptData（unknown）安全读取参考视频时长（秒）；非正或缺失返回 null。 */
function readSourceVideoDurationSeconds(ep: EpisodeRecord | null): number | null {
  if (!ep) return null;
  const sd = ep.scriptData;
  if (!sd || typeof sd !== 'object') return null;
  const v = (sd as Record<string, unknown>).sourceVideoDurationSeconds;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}
```

- [ ] **Step 2: 给 `<StoryboardStage>` 传 prop**

在 `<StoryboardStage>`（line 795 起）的 props 里，`episode={episode}` 之后加一行：

```tsx
            sourceVideoDurationSeconds={readSourceVideoDurationSeconds(episode)}
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @dramaforge/web typecheck`
Expected: 0 error。

- [ ] **Step 4: Commit（默认跳过）**

```bash
git add packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx
git commit -m "feat(storyboard): pass sourceVideoDurationSeconds to StoryboardStage"
```

---

# Part B — 镜头编号体系

## Task B1: 编号格式纯函数

**Files:**
- Create: `packages\web\lib\shot-label.ts`
- Test: `packages\web\lib\__tests__\shot-label.test.ts`

**Interfaces:**
- Produces: `formatShotLabel(episodeNumber, groupName, shotIndex): string`；`formatShotRange(episodeNumber, groupName, startShotIndex, endShotIndex): string`。

- [ ] **Step 1: 写失败测试**

创建 `packages\web\lib\__tests__\shot-label.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { formatShotLabel, formatShotRange } from '../shot-label';

describe('formatShotLabel', () => {
  it('全集号+组名+镜头序', () => {
    expect(formatShotLabel(3, '高潮组', 4)).toBe('第3集·高潮组·镜头04');
  });
  it('集号缺失省略前缀', () => {
    expect(formatShotLabel(null, '高潮组', 4)).toBe('高潮组·镜头04');
  });
  it('组名缺失省略组段', () => {
    expect(formatShotLabel(3, null, 1)).toBe('第3集·镜头01');
  });
  it('单位数补零', () => {
    expect(formatShotLabel(1, '建场组', 7)).toBe('第1集·建场组·镜头07');
  });
});

describe('formatShotRange', () => {
  it('范围', () => {
    expect(formatShotRange(3, '高潮组', 1, 6)).toBe('第3集·高潮组·镜头01–06');
  });
  it('start===end 退化为单镜头', () => {
    expect(formatShotRange(3, '高潮组', 4, 4)).toBe('第3集·高潮组·镜头04');
  });
  it('无组名', () => {
    expect(formatShotRange(3, null, 1, 12)).toBe('第3集·镜头01–12');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @dramaforge/web exec vitest run lib/__tests__/shot-label.test.ts`
Expected: FAIL — 无法 resolve `../shot-label`。

- [ ] **Step 3: 实现**

创建 `packages\web\lib\shot-label.ts`：

```ts
/**
 * @file shot-label.ts — 镜头详细编号统一格式。
 *
 * 跨「分镜表 / 镜头组库 / 成片库」三处共用，避免格式漂移。
 * 格式：第{集号}集·{组名}·镜头{NN}（范围用 镜头{NN}–{MM}）。
 * 集号/组名缺省时省略对应段，保证退化仍可读。
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 单镜头详细编号，如「第3集·高潮组·镜头04」。
 */
export function formatShotLabel(
  episodeNumber: number | null | undefined,
  groupName: string | null | undefined,
  shotIndex: number,
): string {
  const parts: string[] = [];
  if (typeof episodeNumber === 'number' && episodeNumber > 0) parts.push(`第${episodeNumber}集`);
  if (groupName) parts.push(groupName);
  parts.push(`镜头${pad2(shotIndex)}`);
  return parts.join('·');
}

/**
 * 镜头范围编号，如「第3集·高潮组·镜头01–06」；start===end 退化为单镜头编号。
 */
export function formatShotRange(
  episodeNumber: number | null | undefined,
  groupName: string | null | undefined,
  startShotIndex: number,
  endShotIndex: number,
): string {
  if (startShotIndex === endShotIndex) {
    return formatShotLabel(episodeNumber, groupName, startShotIndex);
  }
  const parts: string[] = [];
  if (typeof episodeNumber === 'number' && episodeNumber > 0) parts.push(`第${episodeNumber}集`);
  if (groupName) parts.push(groupName);
  parts.push(`镜头${pad2(startShotIndex)}–${pad2(endShotIndex)}`);
  return parts.join('·');
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @dramaforge/web exec vitest run lib/__tests__/shot-label.test.ts`
Expected: PASS（7 个测试全绿）。

- [ ] **Step 5: typecheck + Commit（默认跳过）**

Run: `pnpm --filter @dramaforge/web typecheck`
Expected: 0 error。

```bash
git add packages/web/lib/shot-label.ts packages/web/lib/__tests__/shot-label.test.ts
git commit -m "feat(shot-label): structured shot numbering helpers"
```

---

## Task B2: StoryboardStage `#` 列显示详细编号

**Files:**
- Modify: `packages\web\app\workspace\[projectId]\components\StoryboardStage.tsx`（import；helper 区；`#` 表头 line 767；`#` 单元格 line 789-791）

**Interfaces:**
- Consumes: `formatShotLabel`（来自 B1）。

- [ ] **Step 1: import + 组名 helper**

import 区加（A3 已 import Modal，紧随其后）：

```ts
import { formatShotLabel } from '../../../../lib/shot-label';
```

在 `getStoryboardTable` 等 helper 区（line 118 附近）加：

```ts
/** 取镜头语义组名（建场组/推进组/高潮组…），缺省 null。 */
function getShotGroupName(shot: ShotRecord): string | null {
  const meta = (shot.metadata || {}) as Record<string, unknown>;
  const sbTable = (meta.storyboardTable || {}) as Record<string, unknown>;
  const label =
    (typeof meta.groupLabel === 'string' && meta.groupLabel) ||
    (typeof sbTable.groupLabel === 'string' && sbTable.groupLabel) ||
    null;
  return label || null;
}
```

- [ ] **Step 2: 加宽 `#` 表头**

`#` 表头（line 767）`w-12` 改为 `w-44`：

```tsx
                          <th className="px-3 py-2 text-left font-medium w-44">#</th>
```

- [ ] **Step 3: `#` 单元格渲染编号**

`#` 单元格（line 789-791）替换为：

```tsx
                              <td className="px-3 py-2 text-[var(--text-3)] tabular-nums whitespace-nowrap">
                                {formatShotLabel(
                                  episode?.episodeNumber,
                                  getShotGroupName(shot),
                                  shot.shotIndex ?? idx + 1,
                                )}
                              </td>
```

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @dramaforge/web typecheck`
Expected: 0 error。

- [ ] **Step 5: Commit（默认跳过）**

```bash
git add packages/web/app/workspace/[projectId]/components/StoryboardStage.tsx
git commit -m "feat(storyboard): show structured shot label in # column"
```

---

## Task B3: 镜头组库显示镜头范围编号

**Files:**
- Modify: `packages\web\app\api\groups\route.ts`（GroupItem 接口 line 16-31；CompletedShotRow line 33-43；SELECT line 77-98；聚合循环 line 106-142）
- Modify: `packages\web\app\workspace\[projectId]\components\GroupLibraryPanel.tsx`（GroupItem 接口 line 44-63；组徽标 line 354-357；import）

**Interfaces:**
- Produces（route→panel）：`GroupItem` 增 `shotStart: number`、`shotEnd: number`、`groupName: string`。
- Consumes: `formatShotRange`（来自 B1）。

- [ ] **Step 1: route — 扩 SELECT**

`route.ts` 的 SELECT（line 78-98）在 `s."updatedAt" AS "updatedAt"` 之后加两列：

```sql
              s."shotIndex" AS "shotIndex",
              s.metadata AS "metadata"
```

- [ ] **Step 2: route — 扩 CompletedShotRow**

`CompletedShotRow`（line 33-43）加两字段：

```ts
interface CompletedShotRow {
  shotId: string;
  projectId: string;
  projectTitle: string;
  episodeId: string;
  episodeNumber: number | null;
  episodeTitle: string | null;
  durationSeconds: number | null;
  videoUrl: string;
  updatedAt: unknown;
  shotIndex: number | null;
  metadata: unknown;
}
```

- [ ] **Step 3: route — 加 groupName 读取 helper**

在 `buildGroupLabel`（line 63）之后加：

```ts
/** 从 shot.metadata 读取语义组名（建场组/高潮组…），缺失回退「组{groupIndex}」。 */
function readGroupName(metadata: unknown, groupIndex: number): string {
  if (!metadata || typeof metadata !== 'object') return `组${groupIndex}`;
  const meta = metadata as Record<string, unknown>;
  const sbTable = (meta.storyboardTable || {}) as Record<string, unknown>;
  const label =
    (typeof meta.groupLabel === 'string' && meta.groupLabel) ||
    (typeof sbTable.groupLabel === 'string' && sbTable.groupLabel) ||
    '';
  return label || `组${groupIndex}`;
}
```

- [ ] **Step 4: route — GroupItem 加三字段**

`GroupItem`（line 16-31）加：

```ts
  shotCount: number;
  duration: number;
  updatedAt: string;
  /** 该组覆盖的全局镜头起止序号（episode 内）。 */
  shotStart: number;
  shotEnd: number;
  /** 语义组名（建场组/高潮组…），缺失为「组N」。 */
  groupName: string;
}
```

- [ ] **Step 5: route — 聚合循环维护范围与组名**

把聚合循环（line 106-142）替换为：

```ts
    for (const row of result.rows as CompletedShotRow[]) {
      const episodeKey = `${row.projectId}:${row.episodeId}`;
      const groupKey = `${episodeKey}:${row.videoUrl}`;
      const existing = byEpisodeAndUrl.get(groupKey);
      const updatedAt = toIso(row.updatedAt);
      const shotIdx = typeof row.shotIndex === 'number' ? row.shotIndex : 0;
      if (existing) {
        existing.shotCount += 1;
        existing.duration += Number(row.durationSeconds ?? 0);
        existing.shotStart = Math.min(existing.shotStart, shotIdx);
        existing.shotEnd = Math.max(existing.shotEnd, shotIdx);
        // 一组多镜写回在同一事务；仍取最大时间以兼容历史分批修复记录。
        if (updatedAt > existing.updatedAt) existing.updatedAt = updatedAt;
        continue;
      }

      const groupIndex = (nextIndexByEpisode.get(episodeKey) ?? 0) + 1;
      nextIndexByEpisode.set(episodeKey, groupIndex);
      const item: GroupItem = {
        id: row.shotId,
        type: 'CHAIN_COMPILE',
        projectId: row.projectId,
        projectTitle: row.projectTitle || '未知项目',
        episodeId: row.episodeId,
        episodeNumber: typeof row.episodeNumber === 'number' ? row.episodeNumber : null,
        episodeTitle: typeof row.episodeTitle === 'string' ? row.episodeTitle : null,
        groupIndex,
        groupLabel: buildGroupLabel(
          typeof row.episodeNumber === 'number' ? row.episodeNumber : null,
          typeof row.episodeTitle === 'string' ? row.episodeTitle : null,
        ),
        videoUrl: row.videoUrl,
        localKey: readLocalKey(row.videoUrl),
        shotCount: 1,
        duration: Number(row.durationSeconds ?? 0),
        updatedAt,
        shotStart: shotIdx,
        shotEnd: shotIdx,
        groupName: readGroupName(row.metadata, groupIndex),
      };
      byEpisodeAndUrl.set(groupKey, item);
      groups.push(item);
    }
```

- [ ] **Step 6: route — typecheck**

Run: `pnpm --filter @dramaforge/web typecheck`
Expected: 0 error。

- [ ] **Step 7: panel — 扩 GroupItem 接口**

`GroupLibraryPanel.tsx` 的 `GroupItem`（line 44-63）在 `shotCount` 之前加：

```ts
  /** 该组覆盖的全局镜头起止序号。 */
  shotStart: number;
  shotEnd: number;
  /** 语义组名（建场组/高潮组…）。 */
  groupName: string;
  shotCount: number;
```

- [ ] **Step 8: panel — import + 渲染编号**

import 区（line 37 附近）加：

```ts
import { formatShotRange } from "../../../../lib/shot-label";
```

组徽标（line 354-357）替换为编号：

```tsx
                          {/* 组编号徽标（琥珀色身份层，GC-8）：第N集·组名·镜头起–止 */}
                          <span className="absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-semibold bg-[var(--accent)] text-[#1a1a1a]">
                            {formatShotRange(g.episodeNumber, g.groupName, g.shotStart, g.shotEnd)}
                          </span>
```

- [ ] **Step 9: panel — typecheck**

Run: `pnpm --filter @dramaforge/web typecheck`
Expected: 0 error。

- [ ] **Step 10: Commit（默认跳过）**

```bash
git add packages/web/app/api/groups/route.ts packages/web/app/workspace/[projectId]/components/GroupLibraryPanel.tsx
git commit -m "feat(groups): show shot range label in group library"
```

---

## Task B4: 成片库显示镜头范围编号

**Files:**
- Modify: `packages\web\app\workspace\[projectId]\components\FilmLibraryPanel.tsx`（import；信息区 line 499-507）

**Interfaces:**
- Consumes: `formatShotRange`（来自 B1）；现有 `film.episodeNumber`、`film.shotCount`、`film.type`。

- [ ] **Step 1: import**

import 区（line 30 附近）加：

```ts
import { formatShotRange } from "../../../../lib/shot-label";
```

- [ ] **Step 2: 信息区加编号行**

信息区标题行（line 500-507）之后、`<div className="flex items-center justify-between gap-2">`（line 508）之前，插入整集成片的镜头范围（CHAIN_COMPILE 覆盖全集 → 镜头01–shotCount）：

```tsx
                          {film.type === "CHAIN_COMPILE" && film.shotCount && film.shotCount > 0 ? (
                            <div className="text-xs text-[var(--accent)] mb-2">
                              {formatShotRange(film.episodeNumber, null, 1, film.shotCount)}
                            </div>
                          ) : null}
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @dramaforge/web typecheck`
Expected: 0 error。

- [ ] **Step 4: Commit（默认跳过）**

```bash
git add packages/web/app/workspace/[projectId]/components/FilmLibraryPanel.tsx
git commit -m "feat(films): show shot range label on chain-compile film cards"
```

---

## Task C1: 全量校验

- [ ] **Step 1: 全量 typecheck**

Run: `pnpm typecheck`
Expected: 0 error（web + server + shared + client）。

- [ ] **Step 2: 跑本轮新测试**

Run:
```bash
pnpm --filter @dramaforge/server exec vitest run src/domain/prompt/__tests__/target-languages.test.ts
pnpm --filter @dramaforge/web exec vitest run lib/__tests__/shot-label.test.ts
```
Expected: 两个文件全绿。

- [ ] **Step 3: 视觉核对（前端改动需截图 + 视觉模型，遵循 CLAUDE.md 强制流程）**

仅当 dev server 可起且本地有数据时：起 web dev server，进一个有分镜的分集，截图分镜表（确认 `#` 列编号）；进镜头组库/成片库截图（确认组卡/成片卡编号）。每张截图用 vision skill 分析布局（对齐/溢出/截断/留白）。本地无数据时跳过，标注「待真数据冒烟」。

- [ ] **Step 4: 汇总与提交（默认跳过；用户要求时执行）**

向用户汇报：A/B 各 Task 完成情况、typecheck/测试结果、视觉核对结果。仅在用户明确要求时执行 `git commit`（默认分支先开分支）。

---

## Self-Review

**Spec coverage:**
- A.1 交互（Modal 8 选项 / 参考视频自动跟随 / 顶部状态条）→ A3 Step 3-7。✓
- A.2 路由读 `totalDurationSeconds` + 优先级 → A2。✓
- A.3 prompt 绕过 90–150 + 不套语言系数 → A1 `buildExplicitDurationBudget`（factor=1、不夹）+ A2 选它。✓（`prompt.ts` 本身无需改，已正确消费 budget。）
- A.4 持久化 `scriptData.targetDurationSeconds` 回填 → **未实现**（spec 标为「轻量、可选」；本轮 Modal 默认选中 1min30s，未做回填。如需，后续单加一个 Task）。注：spec A.1 step5 的回填为「nice to have」，不阻塞核心。
- B.1 格式 `第3集·高潮组·镜头04` → B1。✓
- B.2 运行时派生、helper 放 `packages/web/lib/shot-label.ts` → B1。✓
- B.3 三处展示 → B2/B3/B4。✓
- B.4 成片库 live 派生 → B4（用现有 `episodeNumber`+`shotCount`，无 API 改动，符合「先 live 派生」）。✓
- ③ 一键出集：本轮不做（spec 已暂缓）。✓

**Placeholder scan:** 无 TBD/TODO；每步含完整代码与命令。`A.4 回填`为有意省略的非核心项，已在上方说明。

**Type consistency:** `buildExplicitDurationBudget`/`resolveExplicitStoryboardTarget` 在 A1 定义、A2 消费，签名一致；`formatShotLabel`/`formatShotRange` 在 B1 定义、B2/B3/B4 消费，签名一致；`GroupItem` 新增 `shotStart`/`shotEnd`/`groupName` 在 route 定义、panel 消费，字段名一致。

**Scope:** 单计划可覆盖，A/B 独立可分别实现/提交。
