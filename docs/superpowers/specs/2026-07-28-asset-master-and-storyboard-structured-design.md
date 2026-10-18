# 资产总表 + 分镜结构化提示词 — 全栈功能对齐设计

> 起草:2026-07-28 · 分支 `feat/cs-ui-slice`
> 诉求:按参考产品截图（资产总表 + 分镜制作两屏），全栈对齐 dramaforge 的**功能能力**（前端不要求像素一致，功能必须对齐）。
> 路径:**渐进式 C** —— Phase 1 资产总表（独立先交付）→ Phase 2 分镜结构化+约束 → Phase 3（可选）三栏。

---

## 0. 背景与目标

### 0.1 参考产品不是 app1
核验结论:参考截图来自一个**比 app1 更先进**的产品（用本项目示例剧数据渲染）。`grep app1` → `资产总表`/`按集查看`/`出场集` 在 app1 中**不存在**。因此本设计是**在 app1 复刻基线之上的净增功能**，不是 app1 复刻。

> 与 H3（前端照搬 app1）的关系:本设计照搬的是**用户提供的参考截图**（功能 spec），不是"自创"。参考即 spec，H3 的"不自创"精神成立。app1 仍是其他阶段的复刻基线。

### 0.2 参考产品两屏能力摘要

**资产总表（资产总表/按集查看 双视图）**
- 资产（角色/物品/环境）× 集（EP1..EP45+）矩阵;单元格显示命中变体。
- 每资产有**主形象 + 变体**（断剑态/修复态等状态变体）,每变体映射到具体集（出场集 `EP1-31,33-45`）。
- 图片状态追踪（图片 0/N）、计数、搜索。
- 筛选:类型 tab、集、图片状态、未分配出场集。
- 富文本:每资产/变体带剧情背景描述。

**分镜制作（三栏编辑器）**
- 左:集选择器 + 场景镜头列表（`S01-SEG01..SEG08` + 已完成状态）+ 一键生成。
- 中:镜头预览（12秒、播放器、状态）+ 资产约束（说话角色 0/3;出镜+物品+环境 3/9）。
- 右:角色/物品/环境 选择器（出镜/说话开关、导入）+ **结构化提示词**（场景/场景设计/画面信息/片段数/片段说明）+ 参考视频风格开关（镜运/对白/音效/光影/画风）+ 生成视频(720)。

### 0.3 目标 / 非目标
- **目标**:dramaforge 获得"项目级资产总览（含出场集聚合、状态筛选）"+"分镜结构化提示词与资产约束"两项能力,全栈贯通,数据/API/UI 可用。
- **非目标**:像素级复刻参考 UI;改造 input/analyzing/production/成片库（本轮不涉及）;三栏分镜重构（Phase 3 可选,本轮不做）。

---

## 1. 当前态与差距（核验后）

### 1.1 资产侧（`packages/server/src/domain/asset/` + `AssetDesignStage.tsx` 4197 行）
- ✅ 变体 `costumes`（key/label/coverageScenes/variant_type costume|period）、类型 4 类、图片状态（`isConfirmed`/`regenLocked`/`asset_image_revisions.status`）、富文本字段齐全。
- ✅ 类型 tab、变体管理 UI、图片历史、批量生成/确认/解锁。
- ❌ **无项目级资产总览**——资产只能在单集工作区按类型 tab 看。
- ❌ **无"按集查看"/出场集矩阵**——`coverageScenes` 存的是**集内本地场景号**（`S1,S2`，逐集分析产生，跨集合并后歧义），从未聚合成"每集出现"。
- ❌ **无图片状态筛选栏**（状态计数有展示,但无筛选控件）。

### 1.2 分镜侧（`StoryboardStage.tsx` 1316 行 + `group-prompt-snapshot.ts`）
- ✅ 每集镜头列表（按 group 分组表格）、行内编辑器（visualPrompt/描述/台词/景别/运镜/时长）、资产引用选择器、生成控制。
- ❌ **无结构化提示词**——单一 `visualPrompt`;缺 场景/场景设计/画面信息/片段数/片段说明。
- ❌ **无资产用量约束展示**——`shot-asset-reference.ts` 能解析引用,但 UI 不展示 `说话/出镜 计数 vs 上限`。
- ❌ **无机位（cameraAngle）输入框**——现从 prompt 只读解析（`StoryboardStage.tsx:148-167`）。
- ❌ **无参考视频风格开关**（镜运/对白/音效/光影/画风）。
- ❌ **分镜阶段内无预览**（预览在生产阶段 VideoEditor）。
- ⚠️ 关键建模对齐:**参考的 SEG+片段 ≈ dramaforge 的 group+shots**。参考 `S01-SEG01`（12秒、5个片段）≈ dramaforge 一个 group（≤15s、含若干 shots）;参考"片段说明 1.全景 2.特写…"≈ dramaforge group 内各 shot 的 description。

---

## 2. 关键设计决策（已确认）

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 资产总表路由位置 | **新项目级路由** `/workspace/[projectId]/assets` | 贴合参考"首页>资产总表"层级;与单集工作区解耦 |
| D2 | 出场集数据来源 | **从 shots 派生**（`listShots(projectId)` 全量扫 + `referencedAssets` 名称解析） | `coverageScenes` 集内本地歧义不可用;shots 有确定 `episodeId`;**0 schema 改动** |
| D3 | 变体级出场集 | v1 先集级;变体级用 `referencedAssets.characterCostumes` override + `selectCharacterCostume` 兜底（增强） | 集级覆盖 80% 价值;变体级复杂,后置 |
| D4 | 片段说明来源 | **从 group 镜头派生**（片段数=group 镜头数,片段说明=各镜头 description） | 0 新数据;契合 SEG≈group 建模 |
| D5 | generate-storyboard 改造 | **AI 产出结构化字段**（场景/场景设计/画面信息/片段数/片段说明）,**保留 `visualPrompt` 兜底** | 对齐参考;向后兼容 |
| D6 | 结构化提示词存储 | `shot.metadata.structuredPrompt` 子对象 + `shot.metadata.referenceStyle` | 沿用 metadata JSONB 模式;**0 schema 改动** |
| D7 | 聚合位置 | **服务端新端点** `/assets/master` 一次性返回矩阵 | 跨集 shot 扫描放服务端;单往返;前端轻 |

---

## 3. Phase 1 · 资产总表 + 按集查看

### 3.1 数据层（0 schema 改动）
- 出场集聚合算法（服务端,新 `domain/asset/appearance.ts`）:
  1. `listShots(projectId)` 取项目全部 shots。
  2. 按 `episodeId` 分组;每集内,对每个 shot 解析 `referencedAssets.{characters,items,environments}`。
  3. 名称→资产解析:复用 `shot-asset-reference.ts` 的 `normalizeName` 索引逻辑（同 kind 精确匹配）。
  4. 输出 `Map<assetId, Set<episodeNumber>>`;再聚合成 `Map<assetId, Map<episodeNumber, {variant?, hasImage}>>`（变体来自 characterCostumes override / scene 兜底）。
- 图片状态:直接读 `isConfirmed`/`regenLocked`/最新 `asset_image_revisions.status`（已有查询）。
- 集（EP）列表:`listEpisodes(projectId)` 取 `episodeNumber` + `title`。

### 3.2 API 层
- **新增** `GET /api/projects/[id]/assets/master`:
  - 响应 `{ assets: AssetRecord[], episodes: {episodeNumber,title}[], appearance: Record<assetId, Record<episodeNumber, {variant?,hasImage}>>, statusCounts: {...} }`。
  - 鉴权/ownership 同现有 assets 路由（`requireUser` + project 归属）。
  - 文件:`packages/web/app/api/projects/[id]/assets/master/route.ts`（web 层调 `@dramaforge/server` 新导出的 `computeAssetMaster(projectId)`）。
- **扩展** `GET /api/projects/[id]/assets` query:`?status=`（confirmed|locked|generating|missing）、`?episodeId=`、`?q=`、`?unassigned=1`（`?kind=` 已有）。
  - 注意:`?episodeId=`/`?unassigned=` 依赖 appearance 派生——实现时这两个筛选用 master 端点返回的 appearance 在前端过滤,或服务端联合计算。**实现期定:简单筛选前端做,避免服务端双扫。**

### 3.3 UI 层
- **新路由** `packages/web/app/workspace/[projectId]/assets/page.tsx`:
  - 入口:项目页 + 工作区侧栏新增"资产总表"导航项。
  - 布局:顶栏（搜索 + 类型 tab 角/物品/环境 带计数 + 图片状态筛选 + 集筛选 + 只看未分配）+ 状态条（"当前显示 N 资产 / M 主形象与变体 · 图片 x/M · 未分配 y"）。
  - **双视图切换**:
    - **资产总表**:资产为行、集为列的矩阵;单元格显示命中变体缩略/缺图占位（`缺图` 斜纹）。类型分组（物品/环境 section,参考 §0.2）。
    - **按集查看**:按集分组,每集下列出出现的资产 + 变体 + 出场说明。
  - 复用 `ShotAssetReferenceBadges` 风格的缩略 + `sf-asset://` 显示（媒体客户端落地,H1）。
- 状态筛选/搜索/集筛选:前端在 master 端点数据上做（单次拉取 + 客户端过滤）。

### 3.4 Phase 1 验收
- 进 `/workspace/[projectId]/assets` 能看到全部资产 × 全部集的矩阵。
- 出场集正确反映 storyboard 实际引用（增删 shot 引用后刷新可见）。
- 类型/状态/集/未分配筛选生效;状态条计数正确。
- 缺图资产有占位;有图资产显示缩略。

---

## 4. Phase 2 · 分镜结构化提示词 + 资产约束

### 4.1 数据层（0 schema 改动）
- `shot.metadata.structuredPrompt = { scene, sceneDesign, visualInfo, segmentCount, segmentBreakdown: string[] }`
  - `scene`/`sceneDesign`/`visualInfo`:对应参考 场景/场景设计/画面信息。
  - `segmentCount`/`segmentBreakdown`:**派生展示用**（来自 group 内 shots 的 description）;AI 生成时也产出,但 UI 展示以实际 group 镜头为准（D4）。
- `shot.metadata.referenceStyle = { cameraMovement, dialogue, sfx, lighting, artStyle }`（参考视频风格开关,布尔）。
- `cameraAngle`（机位）:已在 `metadata.storyboardTable.cameraAngle`,补输入框。
- 出镜/说话:`characters[]`（出镜）/`speakingCharacters[]`（说话）已有,不新增。

### 4.2 API 层
- **扩展** `PATCH /api/projects/[id]/episodes/[episodeId]/shots/[shotId]`:
  - 白名单加 `metadata.structuredPrompt`、`metadata.referenceStyle`、`metadata.storyboardTable.cameraAngle`。
  - 复用现有 metadata read-merge-write（`shots/[shotId]/route.ts:105-363`）。
- **改造** `generate-storyboard`（`domain/storyboard/prompt.ts` + `parse.ts`）:
  - `buildStoryboardPrompt`:prompt schema 增加 structuredPrompt 字段要求;保留 visualPrompt 字段（D5 兜底）。
  - `parseStoryboardShots`:解析 structuredPrompt 子对象;容错（缺失回落空对象）。
  - `postprocess.ts`:`segmentBreakdown` 与实际 group shots 对齐校验（派生优先）。
- **集成点** `group-prompt-snapshot.ts`（chain-generate 消费）—— ⚠ **本轮延后**：
  - 原计划让生成提示词消费 structuredPrompt。实现期发现 `combineGroupPrompts`（group-preview.ts，1500+ 行）被 3 路由共用、且做指纹/复用门控；visualPrompt 已承载生成关键信息，scene 上下文已有 spatial/time/blocking 注入，structuredPrompt 大量重叠；注入会改指纹影响复用门控。
  - **决策**：v1 只做"存储+编辑+展示"（功能对齐核心）；生成消费作为后续按需注入。条件性注入（仅 structuredPrompt 非空时加前缀）对存量数据安全，属优化非核心，待需要时再做。

### 4.3 UI 层（表格增强,不重写三栏）
- `StoryboardStage.tsx` 行内编辑器扩展:
  - 结构化提示词区:场景/场景设计/画面信息 textarea + 片段说明（只读派生:列 group 内各 shot description）。
  - 机位输入框（cameraAngle,新）。
  - 参考视频风格开关（5 个 toggle）。
- **资产用量约束展示**（新组件或行内栏）:
  - 实时算 `说话角色 = speakingCharacters.length`、`出镜+物品+环境 = (characters+items+environments).length`。
  - 对照上限（实现期核验 `MAX_CHARACTER_REFERENCES`/`MAX_TOTAL_REFERENCES` 真实常量,参考截图示 0/3 与 3/9）,超限飘红提示。
- 可选:行内小预览（复用生产阶段播放器逻辑播放 `currentMaterialUrl`）。**实现期定优先级。**

### 4.4 Phase 2 验收
- 生成分镜后,每镜头有结构化提示词（场景/场景设计/画面信息）。
- 手动编辑结构化字段能保存;刷新仍在。
- 资产约束计数实时反映引用;超限可见。
- 机位/风格开关可编辑保存。
- chain-generate 产出的视频提示词正确消费 structuredPrompt（结构化字段优先,visualPrompt 兜底）。

---

## 5. Phase 3（可选,本轮不做）

若 Phase 2 表格增强后交互仍不足,把 `StoryboardStage.tsx` 重写成左镜头列表/中预览/右资产+提示词的三栏编辑器（基于现有 `VideoEditor.tsx` 三栏骨架）。本轮仅留接口空间（metadata 字段、约束展示组件可复用）。

---

## 6. 测试策略
- **shared/server**:appearance 聚合算法单测（构造 shots + referencedAssets → 断言 assetId→episode 映射）;structuredPrompt 解析/容错单测;group-prompt-snapshot 回落单测。
- **契约**:tsc 4 包通过。
- **不能本地验**:真生成（需云端 key,H2）。本地只验结构/契约/派生逻辑。
- **运行时冒烟**:Phase 1 矩阵渲染 + 筛选;Phase 2 结构化字段编辑 + chain 提示词。须用户桌面端（H1 媒体落地）。

---

## 7. 文件级影响清单（预估）

**Phase 1**
- 新 `packages/server/src/domain/asset/appearance.ts`（聚合算法）
- 新 `packages/server/src/index.ts` 导出 `computeAssetMaster`
- 新 `packages/web/app/api/projects/[id]/assets/master/route.ts`
- 改 `packages/web/app/api/projects/[id]/assets/route.ts`（query 扩展,部分前端做）
- 新 `packages/web/app/workspace/[projectId]/assets/page.tsx` + 组件（矩阵/按集视图、筛选栏）
- 改工作区侧栏/项目页（入口导航）

**Phase 2**
- 改 `packages/server/src/domain/storyboard/{prompt,parse,postprocess}.ts`（结构化产出）
- 改 `packages/web/app/api/projects/[id]/episodes/[episodeId]/shots/[shotId]/route.ts`（白名单）
- 改 `packages/web/app/workspace/[projectId]/components/StoryboardStage.tsx`（结构化编辑 + 约束 + 机位 + 风格）
- 改 `packages/web/lib/group-prompt-snapshot.ts`（消费 structuredPrompt）
- 新约束展示小组件

---

## 8. 风险与回滚
- **出场集准确性**:shots 派生反映 storyboard 引用,与参考"分析期出场"语义略异。可接受（更贴近实际生产）。若用户要分析期语义,后置加 `metadata.analysisEpisodeIds`。
- **generate-storyboard 改动**:改 AI 输出 schema 有解析风险。缓解:保留 visualPrompt 兜底 + `parse.ts` 容错 + 老数据回落。
- **大组件**:StoryboardStage 1316 行、AssetDesignStage 4197 行。改动遵循现有模式,不重构无关部分。
- 回滚:按 phase 独立提交;Phase 1 是纯新增路由/端点,可单独回滚。
