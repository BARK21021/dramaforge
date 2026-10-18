# P5 recon:app1「合片/成片合成」(compile)→ dramaforge 批7 移植

> 来源:P5 recon agent (a674a7fe11cb56f77) 完成。app1 (`F:\app1`) 只读参考,dramaforge (`D:\dramaforge-cs`) 现状对照。
> 用途:批7(production/合片)移植输入。

## 1. 结论:app1 合片 = 两个任务类型 + 自动触发器

- **FILM_EXPORT**:对**已生成**镜头视频做纯 ffmpeg 拼接(零 AI 成本)
- **CHAIN_GENERATE**:**逐组调 AI 生成视频** + 全部完成后 ffmpeg 拼接成片
- **maybeAutoCompileEpisode**(`F:/app1/src/core/video/auto-compile.ts:92`):分集所有镜头生成完成 → 自动创建 FILM_EXPORT(零 AI 成本)

## 2. 状态机(app1 通用任务状态机,FILM_EXPORT/CHAIN_GENERATE 共用)

`F:/app1/src/core/types/task.ts:64-71` + `F:/app1/src/core/task/service.ts:182-190` VALID_TRANSITIONS:
```
PENDING → [QUEUED, RUNNING, CANCELLED, FAILED]
QUEUED  → [RUNNING, COMPLETED, CANCELLED, FAILED, TIMEOUT]  ← 允许 QUEUED→COMPLETED 兜底竞态
RUNNING → [COMPLETED, FAILED, CANCELLED, TIMEOUT]
FAILED/TIMEOUT → [QUEUED, RUNNING]  (retryTask, maxRetries=3)
COMPLETED/CANCELLED → []  (终态)
```
app1 没有为合片单独建状态机,复用通用 + 通过 progress 事件的 `stage`/`stageProgress` 呈现阶段化进度。

## 3. 数据结构

app1 **无合片独立表**,复用 `tasks` 表(type=FILM_EXPORT/CHAIN_GENERATE),**无 episodeId 列**,关联只存 input/output JSONB(影响所有查询)。
- FILM_EXPORT.input:`{projectId, episodeId?, transition, autoCompiled?, shotCount, totalDuration, shots:[{id,shotSeq,durationSeconds,currentMaterialUrl}]}`
- FILM_EXPORT.output:`{projectId, filmUrl, shotCount, totalDuration, episodeId?}`
- 存储路径:`exports/<projectId>/film-<uuid>.mp4`

dramaforge `render_jobs` 表独立(`0001-init.sql:526-541`),同样无 episode_id 列,关联塞 input JSONB。契约见 `packages/shared/src/render-job.ts`。

## 4. dramaforge 14 项 gap 对照表

| # | 维度 | app1 | dramaforge 现状 | gap |
|---|------|------|-----------|-----|
| 1 | 任务状态机 | PENDING/QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED/TIMEOUT + 重试 | PENDING/CLAIMED/RUNNING/COMPLETED/FAILED,无 CANCELLED/TIMEOUT,无重试 | 中 |
| 2 | 数据结构 | tasks 表通用 JSONB | render_jobs 已覆盖,ConcatInput 已定义 | 小 |
| 3 | FILM_EXPORT 流程 | API→BullMQ→worker→ffmpeg→storage→SSE | dispatch→render_jobs→client render-worker→ffmpeg 本地→sf-asset://→/result→SSE | **小(已通)** |
| 4 | CHAIN_GENERATE 流程 | API→BullMQ→worker AI+ffmpeg | dispatch→CHAIN_COMPILE→client orchestrator→云端AI+本地ffmpeg | 中(**仍 MinIO 违规**) |
| 5 | ffmpeg 命令 | `ffmpeg -f concat -safe 0 -i list -c copy -y out` | 同(`packages/client/src/ffmpeg/ffmpeg-pipeline.ts:205-244`),二进制改 @ffmpeg-installer/ffmpeg | 小 |
| 6 | 进度上报 | worker→Redis→/api/sse→EventSource,带 stage/stageProgress | render-worker **心跳只发 {progress:0,stage:'running'}**,无真实阶段进度 | **大** |
| 7 | 错误处理 | StructuredError 分类 + retryTask + cancelTask + 内容审核跳过 | /failed→markFailed,**无重试/取消/分类** | **大** |
| 8 | 前端 state/hooks | useSSE 单例 + trackTaskId + ProductionStage + FilmLibraryPanel | /compile 实验页 + /films 占位 + workspace 简单轮询 | **大** |
| 9 | 自动合集 | maybeAutoCompileEpisode(幂等+完整性检查) | 无 | **大** |
| 10 | 结果存储 | server storage(local/MinIO/COS) | CONCAT 本地 sf-asset:// ✅;**CHAIN_COMPILE 仍 uploadArtifact MinIO ❌** | 中 |
| 11 | 下载鉴权 | `<a href={filmUrl}>` storage URL | sf-asset:// 仅 Electron,浏览器提示开客户端 | 中 |
| 12 | 删除 | DELETE /api/projects/[id]/films/[taskId] + storage cleanup | 无 | **大** |
| 13 | 活跃任务去重 | chain-generate 查近20 task 复用 | 无 | 中 |
| 14 | 计费 precheck | precheckBalance 在 chain-generate API | 无 | 中 |

## 5. 批7 移植要点(C/S 分工翻译)

### 5.1 直接照搬(逻辑无差异)
- ffmpeg concat 命令本身(已迁移)
- concat-list.txt 格式 + dedupClipsByUrl
- maybeAutoCompileEpisode 幂等检查思路
- FilmLibraryPanel 分组/卡片 UI(按 dramaforge-frontend-align-app1 照搬视觉)
- 错误事件结构 + 进度阶段中文命名("下载视频片段"/"执行ffmpeg拼接"/"上传成片")

### 5.2 server 逻辑挪到 client render-worker
- downloadClips / execFfmpegConcat:已迁移
- getVideoDuration:dramaforge 用 `ffmpeg -i` stderr 解析(@ffmpeg-installer/ffmpeg 不含 ffprobe,**勿照搬 ffprobe 命令**)
- storage.upload → dramaforge 写 `userData/clips/<jobId>.mp4` + sf-asset://(CONCAT 已合规)
- handleFilmExport 5 阶段 reportProgress → **批7 重点**:在 ffmpeg 函数加 onProgress 回调,经 render-worker loop /progress 透传
- handleChainGenerate 逐组生成+末帧衔接:dramaforge chain-generate.ts 已有 strict 模式,需补 fast 并行
- persistVideoUrl:**删掉这层**(AI 在云端,客户端收 URL 直接 fetch 下载,字节落本地)

### 5.3 sf-asset:// 本地落地必须改
| 问题 | 批7 要做 |
|------|---------|
| **CHAIN_COMPILE 仍 MinIO** ❌ | 镜像 CONCAT:注入 filmsDir + toAssetUrl,chain-out.mp4 写 `userData/clips/<jobId>.mp4`,返 `{outputUrl: toAssetUrl(...), meta:{localKey}}` |
| 删除成片 | 加 DELETE 端点:server 删 render_jobs 行 + client IPC 删本地文件(或 server 删行 + client GC 孤儿) |
| 浏览器无法预览 sf-asset:// | 保留"打开桌面客户端"退化提示(硬约束后果,可接受) |
| 下载 | Electron 内 IPC 触发 dialog.showSaveDialog + fs.copyFile |
| maybeAutoCompile 触发点 | 单镜 AI 完成(/api/generate/video 写 currentMaterialUrl 后)检查 episode 完整性 → 自动派发 CONCAT |

### 5.4 dramaforge 缺失 UI 模块(批7 + 批8)
- **useSSE 全局单例 hook**(app1 `useTaskStatus.ts:187-505` 指数退避+trackTaskId 兜底整套照搬)—— **注意:批0 已移植 useSSE 到 `packages/web/hooks/useTaskStatus.ts`,批7 复用**
- **FilmLibraryPanel**:照搬视觉,数据源 `/api/render/jobs?type=CONCAT&status=COMPLETED` 或新 `/api/films`
- **ProductionStage 的 export/chain 区域**:进度条 + 结果卡 + ZoomViewer 预览
- active-task-bar 任务标签映射(FILM_EXPORT/CHAIN_GENERATE 中文)
- FilmsPage 占位 → 真实列表

### 5.5 状态机扩展建议(可选)
- 取消:client ffmpeg 子进程可中断(AbortController + child_process.kill),server cancelTask = UPDATE render_jobs SET status='CANCELLED' WHERE claim_token=? AND status IN ('CLAIMED','RUNNING')
- 超时:已有 reapStale(120s)把行重置回 PENDING 重派,等价"自动重试一次"
- 手动重试:FAILED 行 UPDATE 回 PENDING(claim_token=NULL),client 下轮 /next 重新认领(比 app1 简单,无需 enqueue)

## 6. 风险/坑

- **ffmpeg 跨平台**:@ffmpeg-installer/ffmpeg 随 pnpm install 下载;**Electron 打包须 asarUnpack** 排除 ffmpeg 二进制,否则 spawn 失败;无 ffprobe 已规避;-c copy 不同容器(webm/mkv)concat 可能失败无 fallback;executeJob 未区分类型超时,大集 chain 可能误杀
- **进度采集**:concat -c copy 无 frame 进度,只能按业务阶段切;chain 每组 AI 30-60s,app1 fast 用单协调者 setInterval(2s) 上报避免 race,dramaforge chainCompile **当前无任何进度回调**(只 logger.info);render-worker 心跳 `{progress:0}` 会覆盖业务真进度,**批7 须分离心跳(续租)与进度(带值)两通道**
- **取消语义**:引入取消需 executeJob 加 cancellation token,重构签名;reapStale 重置后原 client 若还在跑 ffmpeg 产"孤儿"结果,/result 会因 claim_token CAS 不匹配被拒(client 须优雅丢弃)
- **sf-asset:// 多端**:同一 jobId 在两台 Electron 登录,一台认领→另一台 UI 显示完成但本机无文件点击失败,需 UI 比对 result.meta.localKey 是否存在本机;本地无 GC,删成片留孤儿 mp4,建议批9 启动扫描清理
- **CHAIN 参考图云端接缝(最大质量风险)**:dramaforge chainCompile entry.params 只携带 model/prompt/duration/aspectRatio 4 字段,**无参考图**,视频质量远不及 app1。批7 主链完成后,批7.5/8 专解"客户端本地角色图 → 云端 AI 可访问 URL"(方案:client 临时上传 server 5min TTL,或 server pre-signed GET URL)
- **数据一致性**:render_jobs 无 episode_id 列,按分集聚合须 episodeId 塞 input JSONB;dramaforge ChainCompileInput.groupResults 当前**无 episodeId 字段**,需扩展契约或 dispatchChainGenerate 时写入 wrapper

## 7. 关键文件路径速查

**app1 合片核心**:
- `F:/app1/src/core/video/auto-compile.ts`(自动合集 167 行)
- `F:/app1/src/core/video/ffmpeg-pipeline.ts`(ffmpeg 封装 597 行)
- `F:/app1/src/workers/video.worker.ts`(FILM_EXPORT:1769-1826 / CHAIN_GENERATE:781-1220 / assembleFilm:1234-1281)
- `F:/app1/src/workers/base.ts:454-492`(runWithProgress)
- `F:/app1/src/core/task/service.ts`(createTask/transitionTaskStatus/retryTask/cancelTask + VALID_TRANSITIONS)
- `F:/app1/src/core/types/task.ts`(TaskType/Status/Event/Input)
- `F:/app1/src/core/task/publisher.ts`(publishStatusChange/Progress/Output + listActiveTasksSnapshot/listEventsAfter)
- `F:/app1/src/app/api/sse/route.ts`(SSE + filterEventForUser)
- `F:/app1/src/app/api/projects/[projectId]/export-film/route.ts`
- `F:/app1/src/app/api/projects/[projectId]/chain-generate/route.ts`(含活跃任务去重 + precheckBalance)
- `F:/app1/src/app/api/projects/[projectId]/films/route.ts` + `F:/app1/src/app/api/films/route.ts`(成片列表)
- `F:/app1/src/app/api/projects/[projectId]/films/[taskId]/route.ts`(DELETE + storage cleanup)
- `F:/app1/src/hooks/useTaskStatus.ts`(useSSE 单例 + trackTaskId 兜底)
- `F:/app1/src/app/workspace/[projectId]/components/ProductionStage.tsx`(合片 UI)
- `F:/app1/src/app/workspace/[projectId]/components/FilmLibraryPanel.tsx`(成片库 533 行)
- `F:/app1/src/app/workspace/[projectId]/page.tsx:688-695`(viewMode='films')
- `F:/app1/src/components/features/active-task-bar.ts:35-36`(中文标签)

**dramaforge 现状**:
- `packages/shared/src/render-job.ts`(RenderJobType/Status/Input/Result 契约 frozen)
- `packages/server/src/infra/migrations/0001-init.sql:520-542`(render_jobs DDL)+ `0003-render-job-leases.sql`(租约)
- `packages/server/src/task/render-job-repo.ts`(CRUD + claimNext FOR UPDATE SKIP LOCKED + reapStale:104,306-318)
- `packages/server/src/task/dispatch.ts:50-97`(dispatchFilmExport/dispatchChainGenerate)
- `packages/client/src/ffmpeg/ffmpeg-pipeline.ts:205-244`(execFfmpegConcat 已迁移)
- `packages/client/src/render-worker/executor.ts:130-221`(executeJob CONCAT 写本地)
- `packages/client/src/render-worker/loop.ts:266-280`(心跳,只发 progress:0)
- `packages/client/src/orchestrators/chain-generate.ts:154-243`(chainCompile,**仍 uploadArtifact:235 违规**)
- `packages/web/app/api/render/dispatch/route.ts` + `jobs/[id]/{result,failed,progress}/route.ts`
- `packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts`(MVP,参考图 defer)
- `packages/web/app/compile/page.tsx` + `compile/compile-flow.ts`(实验页)
- `packages/web/app/films/page.tsx`(占位,批8/9.5 填)
- `packages/web/app/workspace/[projectId]/episodes/[episodeId]/page.tsx:255-299`(production chainJob 轮询 75×4s=5min)
- `packages/web/lib/publish.ts`(publishTaskEvent)
- `packages/web/hooks/useTaskStatus.ts`(批0 已移植 useSSE,批7 复用)

## 8. 批7 优先级建议

1. **修违规债**:CHAIN_COMPILE 改本地落地(5.3 第1行)——硬约束,最高优先
2. **进度上报**:render-worker 分离心跳/进度 + ffmpeg onProgress 回调 + chain 协调者上报(gap #6)
3. **错误处理**:加重试(FAILED→PENDING)+ 错误分类(gap #7)
4. **成片库 UI**:FilmLibraryPanel + FilmsPage + 删除(gap #8/#12)
5. **自动合集**:maybeAutoCompile 触发点(gap #9)
6. **CHAIN 参考图接缝**:批7.5/8 专解(最大质量风险)
