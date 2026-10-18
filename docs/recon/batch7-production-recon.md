# 批7 ProductionStage Recon Brief + Coordinator 决策

> 范围:app1 `ProductionStage.tsx`(2386行)+ **修 CHAIN_COMPILE MinIO 违规债(第1优先)**。
>
> **认知校正**:ffmpeg 客户端化**已就绪**(P4/P5 已完成 client ffmpeg-pipeline + chain-generate orchestrator),批7 **不新建 ffmpeg**,只补 MinIO 债 + ProductionStage UI。
>
> **赶工模式**:今天 07-21 试生产日,砍优化,照搬 app1,只修真 bug(OP1 MinIO 债必修)。
> recon agent: Explore(read-only)。

---

## Coordinator 决策

- **Q1 autoGroup → defer 批7.5**(每镜一组,功能正确仅视觉无成组卡)
- **Q2 export-film MUST / films GET defer 批8**(成片库是批8)
- **Q3 CHAIN 参考图接缝 → defer 批7.5/批8**(⚠️最大质量风险,见下)
- **Q4 chain-generate web route MUST 补 4 字段**(resolution/aspectRatio/seed/watermark)
- **OP1 MinIO 债必修(第1优先)** / OP2 自动消除(OP1 修后) / OP3 useSSE import 核对

## ⚠️ 最大质量风险:CHAIN 参考图接缝(defer 批7.5/批8)

dramaforge chain-generate params **无参考图**(角色图在客户端本地 `sf-asset://`,云端 AI 访问不到)。app1 有 `referenceImageUrls`(reference i2i 视频生成),dramaforge 退化成 t2i(纯文本生视频)。**试生产视频质量远不及 app1**(角色一致性差/风格漂移)。

这是 **C/S 架构核心难点**:server 不能存媒体(dramaforge-assets-client-local)→ 云端 AI 无法访问客户端角色图。defer 批7.5/批8 解决(方案:client 临时上传 server 5min TTL 用完即删 / server pre-signed GET URL)。**用户需知:首日试生产视频质量可能差**(链路打通,质量待接缝)。

---

## Step 1. 修 MinIO 债(第1优先,OP1 必修)

文件:`packages/client/src/orchestrators/chain-generate.ts:235`

**当前违规代码**(行 224-238):
```ts
await uploadArtifact(localOut, input.outputUploadUrl);  // PUT 到 MinIO,违反 dramaforge-assets-client-local
return { outputUrl: input.outputUploadUrl };            // outputUploadUrl 是空串 → 必崩
```

**修复**(镜像 executor.ts CONCAT case 行 137-157):
```ts
// chain-generate.ts 末尾改本地写
const filmKey = `${ctx.jobId}.mp4`;
const finalPath = path.join(ctx.filmsDir, filmKey);
await fs.mkdir(ctx.filmsDir, { recursive: true });
await fs.copyFile(localOut, finalPath);  // tmpDir 可能跨设备,copyFile + rm 更稳
ctx.logger.info('chainCompile written locally', { filmKey });
return { outputUrl: ctx.toAssetUrl(filmKey), meta: { localKey: filmKey } };
```

**配套改动**:
1. **executor.ts OrchestratorContext 扩展**(行 62-68):加 `filmsDir: string` / `toAssetUrl: (key)=>string` / `jobId: string`
2. **executeJob 透传**(行 196-203 CHAIN_COMPILE + 行 205-212 LONG_VIDEO_REWRITE):`{..., filmsDir: deps.filmsDir, toAssetUrl: deps.toAssetUrl, jobId: job.id}`
3. **render-job.ts ChainCompileInput**:`outputUploadUrl?: string`(optional + LEGACY 注释)
4. **dispatch/route.ts Zod**:`outputUploadUrl: z.string().optional()`
5. **chain-generate web route**(行 95-98):删 `outputUploadUrl: ''`
6. **chain-generate.ts**:删顶部 `import { uploadArtifact }`

**影响**:零(OP1 修后 chain_compile E2E 真正工作,OP2 自动消除)。GC:dramaforge-assets-client-local(server 零媒体字节)/ GC-7(sf-asset:// 替 MinIO)。

---

## Step 2. chain-generate web route 扩展 4 字段(Q4 MUST)

文件:`packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts`

body 解析扩展 + groupResults.params 注入:`resolution` / `aspectRatio` / `seed`(number trunc) / `watermark`(bool) / `returnLastFrame`(bool) / `generateAudio: true` 固定。params 由 chain-generate.ts body 透传给云端 `/api/generate/video`(向后兼容,云端不识别则忽略)。

---

## Step 3. 新建 ProductionStage.tsx(~700行简化版)

文件:`packages/web/app/workspace/[projectId]/components/ProductionStage.tsx`

镜像 app1 MUST 项:**P1**(大数字,无 pill)/ **P2**(一键出片+批量下载)/ **P6**(ProgressBar+ETA)/ **P7**(增强提示词卡,删 pencilPaintingMode)/ **P8**(一键出片进度卡)/ **P9**(结果卡含 `<video>`)/ **P10**(简化提示)/ **P12**(镜头卡:状态图标+badge+缩略图+visualPrompt+ShotAssetReferenceBadges,删选择框)/ **P14**(简化参数弹窗)/ **P19/P20**(ZoomViewer)/ **P21**(ETA 算法)/ **P25**(SSE 处理)/ **P26**(export-film)/ **P27**(chain-generate)。

删:defer 项(viewMode/VideoEditor P33/智能成组 P11/浮动选择栏 P13/成组生成 P28-P32/单镜生成 P24/模板 P16-P31/组提示词/选择算法 P22/积分预估 P4/isProviderReady P3/isReview P5/参考图接缝)。删 app1 `@core/*` import(dramaforge 不存在)。保留 CSS 变量(双色铁律:琥珀组成/进度 vs 蓝色按钮)。

适配:
- P14 参数弹窗:ModelSelector(@/lib/models VIDEO_MODELS)+ 分辨率 select(`480p/720p/1080p/4k`)+ 画面比例 select(`16:9/9:16/1:1/4:3/3:4/21:9`)+ 固定种子 checkbox + 水印 checkbox + 末帧 checkbox。删模板/fast/force/积分
- P25 SSE:`useSSE`(@/hooks,OP3 核对签名)/ pollChainJob 兜底
- P26 export-film:调新建 `/api/projects/[id]/export-film`(Step 4)+ SSE 跟踪
- P27 chain-generate:调 episode 级 `/api/projects/[id]/episodes/[episodeId]/chain-generate`(body model/resolution/aspectRatio/seed/watermark)
- P19/P20 ZoomViewer:批0 import,videoSrc=sf-asset://
- ShotAssetReferenceBadges:复用批6 简化版
- Props:projectId/episodeId/shots/episode/assets(完整 AssetRecord[])/api/onRefresh/onNavigateToFilms/videoModel/setVideoModel/isReview={false}

---

## Step 4. 新建 export-film route(MUST,~60行)

文件:`packages/web/app/api/projects/[id]/export-film/route.ts`

镜像 app1 export-film/route.ts:46-128 简化版:
- requireUser + ownership(project)
- 查 shots(episodeId 可选,完成 + currentMaterialUrl 非空);0 → 400
- ConcatInput `{ clips: completedShots.map(s => ({url: s.currentMaterialUrl, durationSec: s.durationSeconds})) }`(**不加** outputUploadUrl)
- `dispatchFilmExport(taskId, userId, input)` → apiSuccess({renderJobId, taskId, shotCount})

注:批7 单镜生成 defer → export-film 首日可能无 shots 可导出(功能就绪即可)。

---

## Step 5. 改 EpisodeWorkspace 接入

文件:`packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx`

- 删 行857-900 production 内联块,替 `<ProductionStage projectId/episodeId/shots={shots}/episode/assets={assets}/api/onRefresh/onNavigateToFilms/videoModel/setVideoModel/isReview={false} />`
- 删 行343-344 chainJob/chainSubmitting state + 行505-522 pollChainJob + 行525-547 handleChainGenerate(移入 ProductionStage P25/P27)
- 加 `import { ProductionStage } from "./ProductionStage"`
- 保留 loadShots/assets/videoModel state

---

## Step 6. 视觉检查(简化赶工)

1-2 张关键截图(production list 视图 + 一键出片参数弹窗)+ page text dump/像素分析(vision skill 不可用,批4/5/6 已验证)。严重崩(404/溢出/双色错)才修。

---

## defer 清单(18项,赶工不做)

autoGroup + computeGroupsForChain(批7.5)/ 智能成组卡 P11(批7.5)/ 单镜生成 VIDEO_GENERATE + reset-status(批7.5)/ 成组生成 generate-group + batch-update-params(批7.5)/ 组提示词编辑器 EditorSurface(批7.5)/ VideoEditor P33(批9)/ 模板 seedance-presets(批9)/ 参考图接缝(批7.5/批8)/ pencilPaintingMode + grid 参数(批7.5)/ fast 并行模式 + force 重生(批7.5)/ seedance 分辨率档(批7.5/批8)/ snapToValidDuration 时长档位(批7.5)/ 成片库 films GET/DELETE + FilmLibraryPanel(批8)/ maybeAutoCompileEpisode 自动合集(批8/批9)/ 下载成片 IPC(批8)/ 链式 SSE 细粒度进度(批7.5)/ 计费(批9)/ isReview(批9)

---

## 参考文件

### app1(只读,GC-3)
- `F:\app1\src\app\workspace\[projectId]\components\ProductionStage.tsx`(2386行)— 镜像源
- `F:\app1\src\app\api\projects\[projectId]\export-film\route.ts`(128行)
- `F:\app1\src\app\api\projects\[projectId]\chain-generate\route.ts`(162行)

### dramaforge(可改)
- `packages/client/src/orchestrators/chain-generate.ts`(243行)— **Step 1 MinIO 债**
- `packages/client/src/render-worker/executor.ts`(221行)— OrchestratorContext 扩展 + 透传
- `packages/shared/src/render-job.ts`(105行)— outputUploadUrl optional
- `packages/web/app/api/render/dispatch/route.ts`(153行)— Zod schema
- `packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts`(108行)— Q4 扩展 4 字段
- `packages/web/app/api/projects/[id]/export-film/route.ts` — 新建(Step 4)
- `packages/web/app/workspace/[projectId]/components/ProductionStage.tsx` — 新建(Step 3)
- `packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx` — 改接入(Step 5)
- `packages/client/main/index.ts` — 不改(filmsDir/toAssetUrl 已注入 renderWorkerOpts)
- `packages/web/hooks/useTaskStatus.ts`(批0)— 复用(OP3 核对 useSSE 签名)
- `packages/web/components/ui/ZoomViewer.tsx`(批0)— import
- `packages/web/app/workspace/[projectId]/components/ShotAssetReferenceBadges.tsx`(批6)— 复用

---

## 验收

- [ ] **OP1 必修**:chain-generate.ts:235 删 uploadArtifact,改本地写 filmsDir + sf-asset:// URL
- [ ] OP2 自动消除(web route outputUploadUrl: '' 删)
- [ ] OrchestratorContext 扩展 filmsDir/toAssetUrl/jobId + executor 透传
- [ ] ChainCompileInput.outputUploadUrl optional + dispatch Zod optional
- [ ] chain-generate web route 扩展 4 字段(Q4)
- [ ] ProductionStage.tsx 新建(~700行,镜像 MUST 项)
- [ ] export-film route 新建(~60行)
- [ ] EpisodeWorkspace 接入
- [ ] typecheck(web/client/shared)+ build(web/client)+ client test(chain-generate ctx 更新)
- [ ] chain_compile E2E 通(MinIO 债修后)
- [ ] 视觉检查 1-2 张
- [ ] GC 自检:dramaforge-assets-client-local(server 零媒体字节)/GC-1/GC-3/GC-5/GC-6/GC-7(sf-asset:// 替 MinIO)/GC-8/dramaforge-keys-cloud-server-only(callCloudVideoAI 走云端)/prefer-better-lib(ffmpeg 用 @ffmpeg-installer)

---

**Brief 结束**。**Step 1(OP1 MinIO 债)第1优先,独立可部署,建议先于 Step 2-5 完成 + 单独验证 chain_compile E2E 通**。批6 实现 agent 完成后 fire 批7 实现。
