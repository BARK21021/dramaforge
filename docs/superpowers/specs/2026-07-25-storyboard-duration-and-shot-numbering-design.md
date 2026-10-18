# 分镜时长选择 + 镜头编号体系 — 设计文档

- **日期**: 2026-07-25
- **项目**: `D:\dramaforge-cs` (dramaforge)
- **状态**: 草案，待用户审阅
- **范围**:
  - ① 分镜时长选择（生成前弹窗 + 有参考视频则跟随参考视频）
  - ② 镜头编号体系（镜头组视图 + 镜头组库 + 成片库 每镜头清晰详细唯一编号）
  - ③ 一键出集 / 一键成片 暂缓（仅备案，见文末）

## 背景

dramaforge 是 app1 的 C/S 迁移。①② 均为 app1 也没有的新能力（已探明：app1 同样写死 90s、无时长选择器、无分集列表级一键出集），需新建，非移植。

### 现状（探索结论）

**时长**
- `packages/server/src/domain/prompt/target-languages.ts:94-95` 写死每集 90–150s 锚点（中文 target 120s，按 `LOCALIZED_DURATION_FACTORS` 语言系数缩放）。
- `sourceVideoDurationSeconds`（OVERSEAS 视频转剧本路径，存于 `episodes.scriptData`，由 `video-to-script` 路由 `:254-264` 写入）已喂给预算，但被夹到 90–150s。
- `packages/server/src/domain/storyboard/prompt.ts:56` `buildStoryboardPrompt` 接受 `opts.totalDurationSeconds`（**死参数**，路由从不传）与 `opts.durationBudget`。
- 路由 `packages/web/app/api/projects/[id]/episodes/[episodeId]/generate-storyboard/route.ts:161-186` 只读 `{model}`；前端 `StoryboardStage.tsx:555-590` `handleGenerate` 只 POST `{rewrite}`。无任何时长选择 UI。

**编号**
- `shots` 表有 `shotSeq`(如 "S01-SEG01")、`shotIndex`。
- 组运行时派生：`packages/server/src/domain/storyboard/postprocess.ts:21` `GROUP_LABELS` = 建场组/推进组/高潮组/收束组/尾声组/过渡组；`metadata.groupIndex`；`StoryboardStage.tsx:285-367` `computeGroups`。
- 镜头组视图、镜头组库（GroupLibraryPanel）、成片库（FilmLibraryPanel）当前未展示结构化人可读编号。

## 目标 / 非目标

**目标**
- ① 分镜生成时：有参考视频 → 目标时长 = 参考视频时长（不夹 90–150s）；无参考视频 → 弹窗让用户选（自定义 / 5min / 3min / 2min / 1min30s 默认 / 1min / 30s / 15s）。
- ② 每个镜头在 镜头组视图 + 镜头组库 + 成片库 有清晰、详细、唯一编号。

**非目标（本轮不做）**
- ③ 一键出集 / 一键成片 自动驾驶（暂缓，文末备案）。
- ORIGINAL 整剧重写路径的时长（`packages/shared/src/long-video-prompt.ts` 仍 90s/集）。
- 单镜头 2–15s、单组 ≤15s 的 Seedance 硬约束（保留不变）。

---

## Part A — 分镜时长选择

### A.1 交互（前端 `StoryboardStage.tsx`）

点「生成分镜 / 重新生成分镜」按钮（`StoryboardStage.tsx:668-675`）触发 `handleGenerate`，改为：

1. 读该集参考视频时长 `sourceVideoDurationSeconds`（来自 `episode.scriptData`）。**实现前确认**：StoryboardStage 当前能否直接读到 `episode.scriptData.sourceVideoDurationSeconds`；若否则从分集详情接口取一次。
2. **有参考视频（>0）**：不弹窗。顶部状态条显示「目标时长：跟随参考视频 {X}s」，直接以该时长生成。
3. **无参考视频**：弹 `Modal`（复用 `packages/web/components/ui/Modal.tsx`），标题「分镜总时长」：
   - 8 个单选项：自定义 / 5min(300s) / 3min(180s) / 2min(120s) / **1min30s(90s，默认选中)** / 1min(60s) / 30s / 15s。
   - 选「自定义」→ 展开数字输入（单位秒，范围 10–600，step 5）。
   - 「确认」→ 以所选秒数生成；「取消」→ 不生成。
4. POST `/api/projects/{id}/episodes/{episodeId}/generate-storyboard`，body 由 `{ rewrite }` 改为 `{ rewrite, totalDurationSeconds }`。有参考视频时可不传（路由以参考值为准）。
5. 记住选择：写入 `episode.scriptData.targetDurationSeconds`，下次打开 Modal 回填默认。

### A.2 路由（`generate-storyboard/route.ts`）

- body schema 增 `totalDurationSeconds?: number`（与现有 `model` 并列）。
- 计算最终目标 `targetSeconds`，优先级：
  1. `sourceVideoDurationSeconds > 0` → 用它（**忽略 body 的 totalDurationSeconds**，因「有参考视频就跟随」）。
  2. 否则 body `totalDurationSeconds > 0` → 用它。
  3. 否则兜底 90s（防御，正常不应触发）。
- 把 `targetSeconds` 传给 prompt（见 A.3），不再无条件走 `buildLocalizedDurationBudget` 的 90–150 逻辑。

### A.3 Prompt（`prompt.ts` + `target-languages.ts`）

- 新增分支：当有明确 `targetSeconds`（参考视频或用户选择）→ 构造
  `durationBudget = { languageCode, languageFactor: 1, minSeconds: round(target*0.95), targetSeconds: target, maxSeconds: round(target*1.05) }`，**不套语言系数、不夹 90–150**。
- `prompt.ts` 现有 `opts.durationBudget` 注入逻辑（行 98-100、178-182）复用，只是 budget 来源改为上面的明确目标。
- 仅当无明确目标（兜底 90s）才走老 `buildLocalizedDurationBudget`（90–150 + 语言系数）。
- 单镜头 2–15s、单组 ≤15s 硬约束（`prompt.ts:89`、`postprocess.ts:215-225`）保留不变。

### A.4 边界

- 用户选 5min(300s)：按单镜头 2–8s 典型 → 约 38–150 镜、≥20 组，生成耗时较长。尊重用户显式选择；UI 上对 ≥3min 选项可加一句提示「镜头数较多，生成耗时较长」。（实现时定是否加，不阻塞。）
- 参考视频极短（<15s）：target 取参考值，单镜头下限 2s、单组 ≤15s 仍生效；可能只 1 组。
- 重新生成：Modal 同样弹出（可改时长），回填上次选择。
- 多语种：明确目标时不套语言系数（用户选/参考视频已是墙上时钟时长）。

### A.5 涉及文件

- `packages/web/app/workspace/[projectId]/components/StoryboardStage.tsx`（handleGenerate + Modal + 顶部状态条）
- `packages/web/components/ui/Modal.tsx`（复用；可能加 radio-group 子模式）
- `packages/web/app/api/projects/[id]/episodes/[episodeId]/generate-storyboard/route.ts`（读 totalDurationSeconds、算 targetSeconds）
- `packages/server/src/domain/storyboard/prompt.ts`（budget 来源分支）
- `packages/server/src/domain/prompt/target-languages.ts`（新增「明确目标」budget 构造函数）

### A.6 待定项决议（按推荐采用，审阅可改）

- **①-a ORIGINAL 路径**：不改，仅标准分镜路径。
- **①-b 单镜头/单组硬约束**：保留；长时长 → 多镜头，尊重用户选择。

---

## Part B — 镜头编号体系

### B.1 编号格式

- 核心编号 = `第{集号}集·{组名}·镜头{组内两位序号}`，如 `第3集·高潮组·镜头04`。
  - 集号 = `episode.episodeNumber`
  - 组名 = `GROUP_LABELS[groupIndex]`（建场组/推进组/高潮组/收束组/尾声组/过渡组）
  - 组内两位序号 = 该镜头在其组内的序号（01、02…），零填充。
- 全局视图（成片库 `/films` 跨项目）：编号前再显示项目名（如「{项目名} · 第3集·高潮组·镜头04」），因集号跨项目不唯一。
- 内部唯一键仍用现有 `shotSeq` / `id`；编号仅作展示标签。

### B.2 计算方式

- **运行时派生**，不建列、不迁移。由 `episodeNumber` + `metadata.groupIndex`（或运行时 `computeGroups` 结果）+ 组内序号算出。
- 理由：组在每次重新生成时由 `postprocessStoryboardShots` 重新派生，持久化标签会过期；派生保证始终与当前分组一致。
- 新增共享 helper `formatShotLabel(episodeNumber, groupIndex, indexInGroup): string`，置于 `packages/web/lib/shot-label.ts`（三处展示均为 web 侧，client-side 可算）。三处共用，避免格式漂移。

### B.3 展示位置

1. **StoryboardStage 镜头组视图**（`StoryboardStage.tsx`，`computeGroups` 285-367 + 镜头卡渲染）：每张镜头卡标题处显示编号。
2. **GroupLibraryPanel（镜头组库，`/groups`）**：每组及组内每个镜头显示编号。
3. **FilmLibraryPanel（成片库，`/films`）**：每个成片卡显示覆盖范围，如「第3集·高潮组·镜头01–06」；跨项目时前缀项目名。

### B.4 成片库的镜头来源（实现时确认）

- 成片记录若只存 `shotIds` → 编号 live 派生（从 live shot 记录算）。
- 若成片是独立快照（镜头删除后仍要保留编号）→ 生成成片时把编号快照进 film 元数据。
- **决议：先按 live 派生实现**；实现第一步先读 `films` 路由 / `render_jobs.filmMeta` 确认存储方式，若是快照再补快照逻辑。

### B.5 涉及文件

- 新增 `packages/web/lib/shot-label.ts`（`formatShotLabel` + 可能 `formatShotRange`）。
- `packages/web/app/workspace/[projectId]/components/StoryboardStage.tsx`（镜头卡）
- GroupLibraryPanel 组件（镜头组库，实现时定位确切路径）
- `packages/web/app/workspace/[projectId]/components/FilmLibraryPanel.tsx`（成片库）
- 可能：`packages/server/src/domain/storyboard/postprocess.ts`（若需在组派生时附带 indexInGroup 到 metadata）

### B.6 待定项决议

- **②-a 格式**：采用 (a) 中文 `第3集·高潮组·镜头04`。
- **②-b 成片库存储**：先 live 派生，确认存储后定。

---

## 测试方法

- **A**：单元 — `buildStoryboardPrompt` 在「明确目标」budget 下输出含目标秒数、不含 90–150 锚点；`target-languages` 新函数对 300s 输入返回 target=300（不夹）。集成 — Mock DeepSeek，对「有参考视频」「无参考视频 + 各选项」两路径验证 body 与 prompt。前端 — Modal 8 选项、自定义输入边界、回填。
- **B**：单元 — `formatShotLabel` 各输入、组内序号正确；`formatShotRange` 覆盖范围。组件 — 三处展示渲染编号。
- **约束**：dramaforge 本地无 AI key（`dramaforge-keys-cloud-server-only`），无法真生成，仅结构/单元测试。

## 约束对齐

- 媒体资产仅本地、AI key 仅云端（`dramaforge-assets-client-local` / `dramaforge-keys-cloud-server-only`）：本设计不动资产存储、不引入本地 key。
- 前端对齐 app1（`dramaforge-frontend-align-app1`）：Modal/按钮样式沿用 dramaforge 既有 `Modal.tsx` 与按钮模式（视觉与 app1 一致）。

---

## 暂缓：③ 一键出集（仅备案，本轮不实现）

可行性已探明：
- 5 阶段 = input → analyzing → assets → storyboard → production（`packages/web/lib/stage-config.ts:24-30`）。
- 阶段 1–4 可无界面串行：analyze / asset-extraction / generate-storyboard 为同步路由；asset 图片生成走 BullMQ 异步、轮询 `/api/tasks/[taskId]`。
- 阶段 5（chain-generate）**必须靠运行中的 Electron 客户端 render-worker 执行**（服务器禁跑 ffmpeg，`packages/server/src/task/dispatch.ts:21`）。用户本就用客户端点按钮，render-worker 在跑，故可行。
- 当前**无编排器串 5 阶段**；`episode.stageStatus` 不可靠（analyze 后卡 'assets'，storyboard/production 不更新它）。
- 设计方向：仿 `LONG_VIDEO_REWRITE` 客户端编排器（`packages/client/src/orchestrators/`）新增「剧集自动驾驶」编排器，1–4 依次调、5 触发 chain-generate，选择项（出片串/并等）弹给用户。①② 定稿后单独出 spec。

一键成片（项目级、每集各一部成片）随 ③ 一并暂缓。
