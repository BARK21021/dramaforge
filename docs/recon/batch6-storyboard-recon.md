# 批6 StoryboardStage Recon Brief + Coordinator 决策

> 范围:app1 `StoryboardStage.tsx`(688行,单文件)复刻到 dramaforge,替换 EpisodeWorkspace storyboard 阶段内联块(行664-744,~80行简陋列表)。
>
> **关键认知校正**:app1 StoryboardStage **无分镜图图片**(REPLICATE-APP1-PLAN.md §6.1 自注"storyboard(分镜图,app1 实际无)")。此阶段纯文本/表格编辑,**唯一图片**是 S10 `ShotAssetReferenceBadges` hover 缩略图(显示的是**资产图**,非分镜图)。dramaforge 翻译:直接用 `asset.imageUrl`(批5 已落地 sf-asset://),删 proxy URL,**无 landAssetImage,server 全程不碰字节**。
>
> **赶工模式**:今天 07-21 试生产日,砍优化,照搬 app1,只修真 bug(OP1-OP7 必修)。
> recon agent: Explore(read-only)。本文件由 coordinator 基于 recon report 整理。

---

## Coordinator 决策(开放问题 + defer)

### Q1 autoGroup + groupIndex 后端增强 → **defer 批6.5**(赶工)
dramaforge generate-storyboard MVP route 不写 groupIndex → S8 computeGroups 全部"未编组"(每镜单独成组,组标题栏重复 N 次,视觉冗余)。**功能正确**(每镜独立可编辑),仅视觉不美观。defer 到批6.5 补后端 autoGroupShots + metadata 写入。

### Q2 ShotAssetReferenceBadges → **纳入简化版**(对齐 app1 视觉,成本低)
S10 徽标 + hover 缩略图是 app1 StoryboardStage 唯一图片元素,视觉对齐关键。简化版新建 2 文件(~120 行,Step 2)。OP3/OP6 随纳入必修。

### Q3 完整 assets state → **实现 agent 检查批5 后定**
Step 4 需完整 AssetRecord[](with imageUrl)传 StoryboardStage。**实现 agent 检查批5 EpisodeWorkspace 是否已落地完整 assets state**:有则复用;无则自建 `loadStoryboardAssets` 调 `GET /assets`(返回完整 AssetRecord[],route 已就绪)。降低与批5 耦合。

### Q4 PATCH metadata → **route read-merge-write**(OP1 方案,更可靠)
PATCH `/shots/[shotId]` route 把 description/shotSize/cameraMovement/dialogue 映射到 metadata read-merge-write(getShot 读现有 → 合并 → patch.metadata)。防静默丢字段(OP1)。

### 真 bug(OP1-OP7 全修,必修)
- **OP1**:PATCH route 必须映射 description/shotSize/cameraMovement/dialogue → metadata read-merge-write(否则静默丢字段,用户编辑刷新后丢失)
- **OP2**:ShotAssetReferenceBadges 用 `<img>` 不能用 `<Image>`(sf-asset:// 非 https,next/image 拒绝)
- **OP3**:`resolveShotAssetReferenceBindings` 必须新建 dramaforge 简化版(否则 build 失败,@core 路径不存在)
- **OP4**:`useStoryboardGenerating`/`setStoryboardGenerating` 替换本地 `useState(false)`(否则 build 失败,store 文件不存在)
- **OP5**:handleGenerate/handleSave URL 改 episode 级 `/api/projects/${projectId}/episodes/${episodeId}/generate-storyboard` + `/shots/${id}`(否则 404)
- **OP6**:`assets` prop 必须完整 AssetRecord[](否则 badges 无缩略图/退化)
- **OP7**:handleGenerate toast 用 `d.shots?.length`(dramaforge route 返回 {shots} 非 {shotCount},否则显示"0 个镜头")

### defer 清单(赶工不做)
| 功能 | defer 到 |
|------|---------|
| autoGroup 15s 编组 + groupIndex 写入 metadata | 批6.5 |
| shotSize/cameraMovement LLM 解析 + 写 metadata.storyboardTable | 批6.5 |
| splitMultiTimecodeShots(多时间码拆分) | 批6.5 |
| resolveShotAssetReferenceBindings 造型变体 + bilingual + Levenshtein | 批7 |
| storyboard-generating-store 模块级跨 Tab 防重 | 批9 |
| findMissingVariantImages + coverageScenes | 批7 |
| 计费 precheck/debit | 批9 |
| verifyDialogueCoverage(丢台词告警) | 批6.5 |

---

## app1 StoryboardStage 功能清单(12 条,S1-S12)

来源:`F:\app1\src\app\workspace\[projectId]\components\StoryboardStage.tsx`(688行)+ `ShotAssetReferenceBadges.tsx`(79行)+ `storyboard-generating-store.ts`(72行)+ `@core/shot/asset-reference.ts`(280行)。

- **S1** 顶部操作栏:h2"分镜设计" + episode title + N镜·N组·Ns 统计 + "按实际 Token 结算" + 生成/重新生成(primary)+ 进入生产(outline)
- **S2** 生成中进度:ProgressBar pulse + 蓝框(--action/20)
- **S3** 空状态:EmptyState lg + 分镜格子 svg + 双态文案
- **S4** 镜头分组:组标题栏 琥珀色(--accent)+ N镜·Ns→validDuration + OK/超时 badge(>15s 红)
- **S5** 表格表头:# / 描述 / 景别 / 运镜 / 时长 / 操作(6 列)
- **S6** 行展示:shotSeq + line-clamp-2 描述 + ShotAssetReferenceBadges + visualPrompt 灰底块 + 景别/运镜/时长 + 编辑按钮
- **S7** 行内编辑:Textarea(描述 rows2/画面提示词 rows4)+ Input(景别/运镜)+ number(时长 0.5-4.0 step0.5)+ 保存/取消
- **S8** computeGroups 分组算法:>15s 贪心拆 / 未编组单成组(Q1 defer 后全"未编组"但算法照搬)
- **S9** 字段 helpers 多源兜底:getShotSizeValue/getCameraAngleValue/getCameraMovementValue/parsePromptCameraFields
- **S10** ShotAssetReferenceBadges:hover 缩略图(资产图,**dramaforge 用 sf-asset:// 直接,img 非 Image**)
- **S11** handleGenerate:本地 generating state + episode 级 URL + toast `d.shots?.length`
- **S12** handleSave:PATCH episode 级 URL + metadata read-merge-write(OP1)

每条 UI 标 [VIS-CK] 视觉检查点(详见 recon report,实现时对照 app1 源)。

---

## 实现步骤

### Step 1. 新建 StoryboardStage.tsx(MUST,~620行)
`packages/web/app/workspace/[projectId]/components/StoryboardStage.tsx`
镜像 app1 S1-S12,适配:
- **删** `useStoryboardGenerating`/`setStoryboardGenerating` import → 本地 `useState(false)`(OP4)
- **删** `ShotAssetReferenceBadges` import → Step 2 新建同目录 import
- **删** `resolveShotAssetReferenceBindings` from `@core/shot/asset-reference` → Step 2 新建 `./shot-asset-reference`(OP3)
- **删** `@core/types/entities` type import → `import type { AssetRecord } from "@dramaforge/server"` + 本地简化类型
- **改** S8 computeGroups 照搬(数据缺 groupIndex 时全"未编组",Q1 defer 不修)
- **改** S11 URL episode 级 + toast `d.shots?.length`(OP5/OP7)+ 本地 generating state
- **改** S12 URL episode 级 + body 映射(OP1,route 做 metadata read-merge)
- **保留** S1-S7 全部 UI + CSS 变量 + Tailwind 类名(对齐 app1 视觉,双色铁律:琥珀组标签 vs 蓝色按钮)
- **保留** Props 类型 + 常量(VALID_DURATIONS/MAX_GROUP_DURATION=15/MIN/MAX_SHOT_DURATION)+ roundUpToValidDuration + computeGroups + getGroupKey + S9 helpers
- Props: projectId/episodeId/shots/episode/assets(完整 AssetRecord[])/category/api/onRefresh/onNavigateNext/className

### Step 2. 新建 ShotAssetReferenceBadges.tsx + shot-asset-reference.ts(MUST,简化版)
- `shot-asset-reference.ts`(~50行):`resolveShotAssetReferenceBindings(shot, allAssets, projectId?)` 简化版 — 遍历 referencedAssets.characters/environments/items,按 name 查 allAssets(精确 + lowercase normalize,无 bilingual/Levenshtein),返回 `{assetId, kind, name, promptRef:"图片N", imageUrl: asset.imageUrl||null, thumbnailUrl: asset.imageUrl||null, description, assetType}`。**无造型变体/无 proxy URL**(thumbnailUrl = asset.imageUrl sf-asset:// 直接)
- `ShotAssetReferenceBadges.tsx`(~70行):照搬 app1(79行),**改** `<Image src={previewUrl} unoptimized/>` → `<img src={previewUrl} alt={name} className="object-cover"/>`(OP2,sf-asset:// 非 https)。previewUrl = reference.thumbnailUrl || reference.imageUrl
- 类型 ShotAssetReferenceBinding/ShotReferencedAssets 在 shot-asset-reference.ts 导出

### Step 3. 新建 PATCH /shots/[shotId] route(MUST,OP1)
`packages/web/app/api/projects/[id]/episodes/[episodeId]/shots/[shotId]/route.ts`(~80行)
- requireUser + ownership(project + shot 属于 project)
- 读 body:`{description?, visualPrompt?, shotSize?, durationSeconds?, cameraMovement?, dialogue?}`
- 映射 ShotUpdatePatch:visualPrompt/durationSeconds 透传顶层;description/shotSize/cameraMovement/dialogue → **metadata read-merge-write**(OP1):getShot 读现有 metadata → `{...existing, description, storyboardTable: {...existing.storyboardTable, shotSize, cameraMovement}, dialogue}` → patch.metadata
- updateShot(shotId, patch) → apiSuccess({shot})
- 404/403 校验

### Step 4. 改 EpisodeWorkspace.tsx(MUST)
- **删** 行664-744 storyboard 内联块,替为 `<StoryboardStage projectId/episodeId/shots/episode/assets={完整AssetRecord[]}/category/api/onRefresh={()=>void loadShots()}/onNavigateNext={() => navigateToStage(nextStage?.key ?? "production")}/>`
- **删** 行402-421 handleGenerateStoryboard + 行258 generatingStoryboard state(逻辑移入 StoryboardStage S11)
- **加** 完整 assets loader(Q3):检查批5 是否已落地完整 assets state,有则复用;无则自建 `storyboardAssets` state + `loadStoryboardAssets` 调 `GET /api/projects/${projectId}/assets`(返回完整 AssetRecord[])
- **加** `import { StoryboardStage } from "./StoryboardStage"`
- 保留 shots/loadShots state(production 阶段也读)

### Step 5. 后端 generate-storyboard 增强(defer,赶工不做)
autoGroup + groupIndex + shotSize/cameraMovement 写入 defer 到批6.5(Q1)。无 GC-5 冲突(纯 JSONB)。

### Step 6. 视觉检查(CLAUDE.md 铁律,简化赶工)
1-2 张关键截图(全页 + 镜头表格/行内编辑)+ 快速 vision(skill 不可用用 page text dump + 像素分析,批4 已验证)。严重崩(404/溢出/错位/双色错)才修。测试数据:已生成分镜的 episode(若无 POST generate-storyboard 一次)。

---

## 翻译规则(核心:媒体存储校正)

**app1 StoryboardStage 无分镜图图片**(REPLICATE §6.1 确认)。唯一图片 S10 资产缩略图。dramaforge 媒体翻译**仅一点**:ShotAssetReferenceBadges previewUrl 从 app1 server 代理 route 改为直接 `asset.imageUrl`(sf-asset://,批5 已落地)。**无 landAssetImage 调用,server 全程不碰媒体字节**(dramaforge-assets-client-local 满足)。批6 无新媒体字节流经。

其他翻译:
- S11 useStoryboardGenerating 模块 store → 本地 useState(无多 Tab,赶工)
- S11/S12 URL 项目级 → episode 级
- S11 toast d.shotCount → d.shots?.length
- S12 draft body 直传 → route metadata read-merge-write(OP1)
- S10 `<Image>` → `<img>`(sf-asset:// 不兼容 next/image,OP2)
- generate-storyboard autoGroup/coverageScenes/计费 → defer

---

## 参考文件

### app1(只读,GC-3)
- `F:\app1\src\app\workspace\[projectId]\components\StoryboardStage.tsx`(688行)— 镜像源
- `F:\app1\src\app\workspace\[projectId]\components\ShotAssetReferenceBadges.tsx`(79行)— S10 镜像
- `F:\app1\src\app\workspace\[projectId]\components\storyboard-generating-store.ts`(72行)— S11 参考(简化本地 state)
- `F:\app1\src\core\shot\asset-reference.ts`(280行)— resolveShotAssetReferenceBindings 参考(简化版)
- `F:\app1\src\app\api\projects\[projectId]\shots\[shotId]\route.ts`(PATCH 行46-71)— PATCH 参考

### dramaforge(可改)
- `packages/web/app/workspace/[projectId]/components/StoryboardStage.tsx` — 新建
- `packages/web/app/workspace/[projectId]/components/ShotAssetReferenceBadges.tsx` — 新建(简化版)
- `packages/web/app/workspace/[projectId]/components/shot-asset-reference.ts` — 新建(简化版)
- `packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx` — 改(行664-744 替内联 + 行402-421/258 删 + 完整 assets loader)
- `packages/web/app/api/projects/[id]/episodes/[episodeId]/shots/[shotId]/route.ts` — 新建 PATCH(OP1)
- `packages/web/app/api/projects/[id]/episodes/[episodeId]/shots/route.ts`(43行)— 不改(GET 就绪)
- `packages/web/app/api/projects/[id]/episodes/[episodeId]/generate-storyboard/route.ts`(220行)— 不改(Step5 defer)
- `packages/web/app/api/projects/[id]/assets/route.ts` — 不改(GET 完整 AssetRecord[])
- `packages/server/src/domain/storyboard/` — 不改(updateShot/getShot/ShotUpdatePatch/ShotRecord barrel 已导出)
- `packages/web/components/ui/*`(批0)— EmptyState/ProgressBar/Input/Textarea/Button/Toast(warning 已就绪)/cn import

---

## 验收
- [ ] StoryboardStage.tsx 新建(~620行,镜像 S1-S12)
- [ ] ShotAssetReferenceBadges.tsx + shot-asset-reference.ts 新建(简化版)
- [ ] PATCH /shots/[shotId] route 新建(OP1 metadata read-merge-write)
- [ ] EpisodeWorkspace 接入(替内联 + 删 handler/state + 完整 assets loader)
- [ ] OP1-OP7 全修(无静默丢字段/无 build 失败/无 404/无 UX 误导)
- [ ] typecheck + build 通过(绝不 pipe | head/tail)
- [ ] 视觉检查 1-2 张 + vision/page text dump
- [ ] GC 自检:GC-1(无 key)/GC-3(app1 只读)/GC-5(无新 .sql,PATCH 纯 metadata JSONB)/GC-6(OP1/OP5/OP7 行为等价)/GC-7(URL shape + 模块store→本地state)/GC-8(视觉对齐 app1 双色铁律)/dramaforge-assets-client-local(S10 用 sf-asset://,server 不碰字节,无 landAssetImage)

---

**Brief 结束**。批5 实现 agent 完成后,fire 批6 实现 agent(带本 brief + 决策)。
