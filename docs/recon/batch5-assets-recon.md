# 批5 AssetsStage Recon Brief + Coordinator 决策

> 范围:app1 `AssetDesignStage.tsx`(2653行,单文件含 5 组件:AssetDesignStage + CharacterSidebar + AssetCard + CharacterEditorPanel + VoiceSelector + VoiceBrowserModal)复刻到 dramaforge,替换 EpisodeWorkspace assets 阶段简陋 `AssetStage`(340行)。
>
> **赶工模式**:明天试生产,砍优化,照搬 app1,只修真 bug(OP3 必修)。
> recon agent: Explore(read-only)。本文件由 coordinator 基于 recon report 整理。

---

## Coordinator 决策(开放问题 + defer)

### Q1 同步直连 vs SSE → **路径 A 同步直连**(赶工)
同步直连 POST generate-image → landAssetImage → PATCH imageUrl → ProgressBar pulse。删 SSE/pendingTasks/trackTaskId/生成锁恢复。批量 Promise.all(分批 5 个一批防 Next route 超时)。

### Q2 造型变体 costumes → **defer 批5.5**(赶工)
A11d 造型变体区暂不渲染,CHARACTER 只显示单张默认图。OP1(asset.variants→asset.costumes)随 defer 不修(无影响)。批5.5 补。

### Q3 上传图片 → **defer 批5.5**(赶工,方案 B)
用户只用 AI 生成。上传是便利功能。批5.5 补 IPC saveLocalAsset。

### Q4 ENTITY Tab → **纳入**(轻量)
GET route ALLOWED_KINDS 加 ENTITY(1行)。Tab 渲染(数据空时空状态,ENTITY 只手动添加,asset-extraction 不提取)。对齐 app1 视觉。

### Q5 imageStyle → **验证后定**
实现 agent 验证 `@dramaforge/server` 是否导出 ASSET_IMAGE_STYLES。导出则用;未导出则固定默认值("写实真人风格")+ defer style 下拉 UI。

### 真 bug
- **OP3 必修**(致命):删 proxyImageUrl 代理逻辑(`/api/.../image?v=` dramaforge 无此 route → 404)。直接用 `asset.imageUrl`(sf-asset://)。CharacterSidebar proxyUrlFn 同理直接返回 originalUrl。
- OP1 defer(随 costumes)
- OP2 defer(随 pencil,见下)

### defer 清单(赶工不做,批5.5/批7/批9 补)
| 功能 | defer 到 |
|------|---------|
| 造型变体 costumes(OP1) | 批5.5 |
| pencil/grid 开关(OP2) | 批7 production |
| 音色 VoiceSelector/VoiceBrowserModal/reference-audio | 批7 production(TTS) |
| 改名 rename + 同步 | 批5.5 |
| 上传图片 /api/upload + IPC saveLocalAsset | 批5.5 |
| 积分预估 estimateImageGenerationCredits 徽章 | 批9 |
| isReview 只读模式 | 批9 |
| SSE 实时进度 + 生成锁恢复 | 永久 defer(路径 A) |
| confirm-assets route | 永久 defer(per-asset PATCH 循环替代) |

### MUST 字段集(server domain 扩展,Step 1)
- **MUST 补**(CHARACTER 富字段,A11c 核心):background/voiceTrait/identityLock/significance/intExt/mood
- **defer**(随 costumes/pencil/grid):costumes/pencilPaintEnabled/gridOverlayEnabled/pencilImageUrl/gridImageUrl/designImage
- **可选**(若 app1 A11c 渲染则补):baseAmbience/coverageScenes/relationships
- 已有 12 字段(name/description/imageUrl/metadata/tags/assetType/basePrompt/isConfirmed/regenLocked/voiceId/voiceSource/auditionStatus)保留。

---

## 实现步骤

### Step 1. server domain asset 字段扩展(MUST)
`packages/server/src/domain/asset/`:
- `service.ts` AssetRecord + toAssetRecord:补 MUST 字段(background/voiceTrait/identityLock/significance/intExt/mood)
- `validation.ts` AssetUpdatePatch + validateAssetUpdate:补 MUST 字段校验(字符串/数组类型守卫)
- `service.ts` updateAsset:补 MUST 字段 addField
- `index.ts` barrel:导出新类型(若 web route 需 import type)
- DB schema(0001-init.sql:155-263)**不改**(富列已存在,GC-5 无冲突)

### Step 2. 后端 route(MUST)
- **新建** `POST /api/projects/[id]/assets`(创建资产):镜像 app1 `assets/route.ts`,dramaforge createAsset service + apiSuccess/apiFail + session auth。kind 白名单 CHARACTER/PROP/LOCATION/ENTITY。
- **扩展** `PATCH /api/projects/[id]/assets/[assetId]`:pickPatch 补 MUST 字段透传 + **新增 DELETE handler**(调 deleteAsset service)。
- **扩展** `GET /api/projects/[id]/assets`:ALLOWED_KINDS 加 ENTITY。
- generate-image route:**不改**(同步直连已就绪,costumes defer 不需补 costumeKey)。

### Step 3. 新建 AssetDesignStage.tsx(MUST,~1500-1800行简化版)
`packages/web/app/workspace/[projectId]/components/AssetDesignStage.tsx`
镜像 app1 A1-A18,但:
- **删** GenerationProgress/useSSE/trackTaskId/pendingTasks/生成锁恢复(路径 A 同步直连)
- **删** isProviderReady/BYOK 逻辑(GC-1:key 云端始终就绪,替换为 true 或删)
- **删** proxyImageUrl 代理(OP3 必修,直接用 asset.imageUrl sf-asset://)
- **删** estimateImageGenerationCredits/formatCredits(积分徽章 defer,占位 "—" 或隐藏)
- **删** A11d 造型变体区(defer 批5.5,CHARACTER 单张默认图)
- **删** A11e 音色 VoiceSelector(defer 批7)
- **删** A11f pencil/grid 开关(defer 批7)
- **删** A12 VoiceBrowserModal(defer 批7)
- **改** IMAGE_MODELS/LANGUAGE_MODELS 从 dramaforge `@/lib/models` import
- **改** ASSET_RESOLUTIONS 从 `@dramaforge/server` import(确认导出)
- **改** handleGenerateImage:同步直连 POST generate-image → landAssetImage(provider URL → sfShell.downloadAsset → sf-asset:// → PATCH imageUrl)→ 更新 state。复用 dramaforge AssetStage.tsx:124-173 landAssetImage 逻辑。
- **改** handleReextract:调 POST `/asset-extraction` body `{}`(dramaforge 已有 247 行最小集)
- **保留** A1-A8/A10/A11(a,b,c,g)/A13/A14 + CharacterSidebar + CharacterEditorPanel + AssetCard(简化)
- **保留** 全部 CSS 变量 + Tailwind 类名(对齐 app1 视觉)

### Step 4. EpisodeWorkspace 接入(MUST)
行 659-660 替换 `<AssetStage>` 为 `<AssetDesignStage>`:
- props: projectId/episodeId/assets(完整 AssetRecord[])/api/onComplete/onRefresh/loading/toast/isReview={false}/imageModel/setImageModel/imageResolution/setImageResolution/imageStyle/setImageStyle/scriptModel/setScriptModel/enhancementPrompt/setEnhancementPrompt/scriptTextLength
- 补 imageResolution/imageStyle/assetEnhancementPrompt state + localStorage(`assetEnhance_${projectId}` 等,对齐 app1 page.tsx:109-157)
- 补完整 assets 拉取(当前 loadProjectAssets 只拉 isConfirmed 简化版,需补完整 AssetRecord[])

### Step 5. 媒体落地(MUST,核心翻译)
landAssetImage 复用到所有图片流(单生成/批量):
```ts
const sf = window.sfShell;
if (!sf?.downloadAsset) return providerUrl;  // dev/browser fallback
const r = await sf.downloadAsset(providerUrl, { ext: "png" });
if (!r?.ok) { setImgErrors(...); return providerUrl; }
await PATCH /assets/[assetId] body { imageUrl: r.protocolUrl };
return r.protocolUrl;
```
批量生图:Promise.all 分批 5 个一批(防 Next route 超时),每批完成 landAssetImage + PATCH,ProgressBar pulse 兜底。

### Step 6. 视觉检查(CLAUDE.md 铁律,简化赶工)
1-2 张关键截图(全页 + AssetCard 编辑面板)+ 快速 vision 1 次。严重崩(404/溢出/错位)才修,小问题 defer。

---

## 翻译规则(核心:媒体存储)

app1 媒体流转:`AI 生成 → server storage(MinIO/local/COS)→ DB 存 storage key → /image proxy route 鉴权读 → <img src="/api/.../image?v=">`

dramaforge 媒体流转:`AI 生成(provider 临时 URL)→ 客户端 sfShell.downloadAsset 下载到 userData/clips/ → DB 存 sf-asset:// URL → <img src="sf-asset://..."> 直接显示(protocol.handle 从本地盘读)`

**server 全程不碰媒体字节**(dramaforge-assets-client-local 满足)。landAssetImage 模式 dramaforge AssetStage.tsx:124-173 已验证,Step 3 复用。

其他翻译:
- BYOK isProviderReady → 删(key 云端)
- 异步 taskId SSE → 同步直连(路径 A)
- proxyImageUrl 代理 → 删(直接 asset.imageUrl,OP3)
- confirm-assets route → per-asset PATCH 循环(行为等价)
- asset/extraction → 复用 dramaforge /asset-extraction(247行最小集)

---

## 参考文件

### app1(只读,GC-3)
- `F:\app1\src\app\workspace\[projectId]\components\AssetDesignStage.tsx`(2653行)— 镜像源(5组件)
- `F:\app1\src\app\workspace\[projectId]\page.tsx`(行107-201)— state 模式
- `F:\app1\src\app\api\projects\[projectId]\assets\route.ts`(94行)— POST 创建参考
- `F:\app1\src\app\api\projects\[projectId]\assets\[assetId]\route.ts`(208行)— PATCH+DELETE 参考
- `F:\app1\src\app\api\projects\[projectId]\assets\[assetId]\generate-image\route.ts`(330行)— 生图 prompt 参考

### dramaforge(可改)
- `packages/web/app/workspace/[projectId]/components/AssetDesignStage.tsx` — 新建
- `packages/web/app/workspace/[projectId]/components/AssetStage.tsx`(340行)— landAssetImage 模式参考(行124-173),可保留 fallback 或删
- `packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx` — 改(行659-660 接入 + 补 state)
- `packages/web/app/api/projects/[id]/assets/route.ts`(48行)— 改(GET 加 ENTITY + 新建 POST)
- `packages/web/app/api/projects/[id]/assets/[assetId]/route.ts`(180行)— 改(PATCH 扩展 + DELETE)
- `packages/server/src/domain/asset/service.ts` — 改(AssetRecord+toAssetRecord+updateAsset 补 MUST 字段)
- `packages/server/src/domain/asset/validation.ts` — 改(AssetUpdatePatch+validateAssetUpdate 补 MUST 字段)
- `packages/client/main/asset-store.ts` — 不改(downloadAsset 已就绪)
- `packages/web/components/ui/*`(批0)— ConfirmDialog/ProgressBar/StageProgress/ZoomViewer/Button/Input/Toast/Spinner/ModelSelector import

---

## 验收
- [ ] server domain 扩展 MUST 字段(background/voiceTrait/identityLock/significance/intExt/mood)
- [ ] POST /assets 新建 + PATCH 扩展 + DELETE + GET 加 ENTITY
- [ ] AssetDesignStage.tsx 新建(简化版,删 SSE/BYOK/proxyImageUrl/costumes/音色/pencil/grid)
- [ ] EpisodeWorkspace 接入 + state 补全
- [ ] OP3 必修(删 proxyImageUrl,直接 sf-asset://)
- [ ] 媒体落地:Electron 生图 → sf-asset:// 本地显示
- [ ] typecheck + build 通过(绝不 pipe | head/tail)
- [ ] 视觉检查 1-2 张 + vision
- [ ] GC 自检:GC-1(删 isProviderReady)/GC-3(app1 只读)/GC-5(无新 .sql)/GC-6(行为等价)/GC-7(媒体客户端落地)/GC-8(视觉对齐 app1)/dramaforge-assets-client-local(server 不存媒体字节)

---

**Brief 结束**。批4 实现 agent 完成后,fire 批5 实现 agent(带本 brief + 决策)。
