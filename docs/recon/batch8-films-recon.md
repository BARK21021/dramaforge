# 批8 Films(成片库)Brief + Coordinator 决策

> 范围:app1 `FilmLibraryPanel` + films route + 下载/删除 IPC → dramaforge。成片字节**已在客户端本地**(批7 executor.ts CONCAT 写 filmsDir + `sf-asset://` URL),批8 只补**列表/查看/下载/删除 UI + API + IPC**。
>
> **赶工模式**:07-21 试生产日,砍优化,照搬 app1,只修真 bug(R1/R3/R4/R6/R7 必修)。
> recon agent: Explore(read-only)。本文件由 coordinator 基于 recon report 整理。

---

## Coordinator 决策(开放问题 + defer)

### Q1 films 数据 shape → **选 A:直接查 render_jobs JSONB**(零 schema 变更,赶工)
不新建 films 表(避免 migrate)。查 `render_jobs WHERE type IN ('CONCAT','CHAIN_COMPILE') AND status='COMPLETED'`。`render_jobs` 表无 project_id/episode_id 列 → **chain-generate route input JSONB 携带** projectId/episodeId/episodeNumber/shotCount/title(R6 必修)。性能:films 列表量小(每用户几十条),JSONB 提取可接受。

### Q2 下载成片 → **IPC showSaveDialog + fs.copyFile**(对齐 app1 体验)
sf-asset:// 是 Electron 自定义 scheme,Chromium `<a download>` 不触发 save-as(R3)。新建 IPC `dialog.showSaveDialog` + `fs.copyFile(clipsDir/<localKey>, chosenPath)`。

### Q3 maybeAutoCompileEpisode → **defer 批9/批9.5**
dramaforge 单镜视频生成链路(video.worker)未整体移植,自动合集触发点未到位。批8 只做手动导出(批7 export-film route)+ 一键串生成(批7 chain-generate)的成片入库。

### Q4 跨机器 sf-asset:// 失效 → **接受(C/S 固有代价)+ 缩略图占位 defer**
⚠️ **架构代价**:用户机器 A 生成成片 → 换机器 B 登录 → films 列表 sf-asset:// URL 在 B 机器 `protocol.handle` 找不到文件 → 404/黑屏。app1 MinIO 共享无此问题。**接受**(告知用户),缩略图占位 defer。不做 server lazy 拉取代理(违反 dramaforge-assets-client-local)。

### Q5 films 入口形态 → **workspace page.tsx 加 viewMode("stage"|"films")**(对齐 app1)
app1 是项目级 viewMode。dramaforge workspace page.tsx 当前 stage-based。批8 加最简 viewMode(conditional render),production 完成 → `onNavigateToFilms(taskId)` → `setViewMode("films") + setHighlightTaskId`。

### Q6 FILM_EXPORT 单镜导出 → **复用批7 export-film route**
批7 Step 4 已建 `/api/projects/[id]/export-film`。批8 films 列表同时覆盖 CONCAT(单镜导出)+ CHAIN_COMPILE(一键串生成)两种 type。

### Q7 任务复用 → **必修**(R7,简单防重复提交)
chain-generate route 加活跃 task 检查(同 episodeId 的 PENDING/QUEUED/RUNNING → 返回 reused:true, 202),防用户连点派发多个 job。

### 真 bug 必修项(R1/R3/R4/R6/R7)
- **R1**:onNavigateToFilms 死 prop(`_onNavigateToFilms`)→ workspace 加 viewMode 激活
- **R3**:下载 sf-asset:// 不工作 → IPC showSaveDialog
- **R4**:DELETE 双面清理(DB render_jobs 行 + 客户端本地 fs.rm)
- **R6**:chain-generate route input 加 projectId/episodeId/episodeNumber/shotCount/title(JSONB 透传)
- **R7**:任务复用检查

### defer 清单(赶工不做)
| 功能 | defer 到 |
|------|---------|
| maybeAutoCompileEpisode 自动合集 | 批9/批9.5 |
| 全局 /films 跨项目成片库(F10/F3) | 批9 |
| 智能合集增强(force/parallelMode/grid/pencil/transition) | 批9 |
| Admin 成片查看(/api/admin/users/[userId]/films) | 批9.5 |
| 缩略图 thumbnailUrl | 批9 |
| 成片预览编辑/裁剪/重命名 | 永久 defer |
| 批量下载/打包 | 永久 defer |
| 成片分类标签/搜索 | 批9 |
| 跨机器 sf-asset:// 失效修复 | 接受(C/S 代价) |

---

## app1 成片库功能清单(recon F1-F11,镜像源)

- **F1** FilmLibraryPanel.tsx:212-533 — 双模式(项目按 episodeNumber 分组可删 / 全局按 projectTitle 无删)。卡片:`<video>` 预览(点击播/停)+ 标题 + 时长(mm:ss)+ 创建时间 + 镜头数 + 下载/删除。highlightTaskId 滚动 + 琥珀边框 + "Nuevo" 徽标
- **F2** GET /api/projects/[projectId]/films — 查 tasks type IN (FILM_EXPORT,CHAIN_GENERATE),JOIN episodes,过滤整集完整
- **F4** DELETE /api/projects/[projectId]/films/[taskId] — 校验归属 + best-effort 删 storage + 删 DB
- **F5** POST export-film(批7 已建)
- **F6** POST chain-generate(批7 已建,缺 R6 透传)
- **F10** /films 全局页(defer 批9)
- **F11** AppSidebar /films 导航(dramaforge 已存在指向占位页)

---

## 实现步骤

### Step 1. chain-generate route input 透传(R6 必修)
`packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts`
- input JSONB 加 `projectId`/`episodeId`/`episodeNumber`/`episodeTitle`/`projectTitle`/`shotCount`/`totalDuration`
- groupResults.params 同 Step 2(批7 Q4 resolution/aspectRatio/seed/watermark)
- 注:此文件批7 在改,批8 实现前**确认批7 最终 shape**,避免冲突

### Step 2. 新建 GET /api/projects/[id]/films route(MUST)
`packages/web/app/api/projects/[id]/films/route.ts`(~80行)
- requireUser + ownership(project)
- 查 `render_jobs WHERE user_id=? AND type IN ('CONCAT','CHAIN_COMPILE') AND status='COMPLETED'`,从 input JSONB 提取 projectId 过滤
- 返回 `[{ id, type, outputUrl: result.outputUrl(sf-asset://), localKey: result.meta.localKey, episodeId, episodeNumber, episodeTitle, shotCount, totalDuration, createdAt }]`
- 按 createdAt desc

### Step 3. 新建 FilmLibraryPanel.tsx(MUST,~400行简化版)
`packages/web/app/workspace/[projectId]/components/FilmLibraryPanel.tsx`
镜像 app1 F1,适配:
- **删** 全局模式(projectId===null 分支,D1 defer)
- **删** 整集完整性过滤(dramaforge 无 getEpisodesCompletionMap,列出所有 COMPLETED)
- **改** `<video src={sf-asset://}>` 直接(协议 handler 读本地,OK)
- **改** handleDownload → 调 IPC `window.sfShell.saveFilm(localKey, suggestedName)`(Step 5 新建)
- **改** handleDelete → DELETE /api/projects/[id]/films/[jobId] + 客户端 IPC `window.sfShell.removeFilm(localKey)`(Step 6)
- **保留** 卡片布局 + `<video>` 预览 + 琥珀 highlight + "Nuevo" 徽标 + 双色铁律
- Props: projectId/highlightTaskId/onNavigateBack

### Step 4. workspace page.tsx 加 viewMode(R1 必修)
`packages/web/app/workspace/[projectId]/page.tsx`
- 加 `viewMode: "stage"|"films"` state(默认 "stage")
- viewMode==="films" → render `<FilmLibraryPanel projectId highlightTaskId onNavigateBack={()=>setViewMode("stage")} />`
- viewMode==="stage" → 现有 EpisodeWorkspace
- EpisodeWorkspace `onNavigateToFilms={(taskId)=>{setViewMode("films"); setHighlightTaskId(taskId)}}` 激活(删下划线前缀死 prop)

### Step 5. 下载 IPC showSaveDialog(R3 必修)
`packages/client/main/index.ts`
- 新建 IPC handler `sfShell.saveFilm(localKey, suggestedName)`:`dialog.showSaveDialog({defaultPath: suggestedName+'.mp4', filters:[{name:'MP4',extensions:['mp4']}]})` → `fs.copyFile(path.join(clipsDir, localKey), chosenPath)`
- preload 暴露 `window.sfShell.saveFilm`
- **dev/browser fallback**:无 sfShell 时 toast"请在客户端下载"(赶工,不阻塞)

### Step 6. DELETE route + 客户端 IPC(R4 必修)
- `packages/web/app/api/projects/[id]/films/[jobId]/route.ts`(~40行):requireUser + ownership + 删 render_jobs 行 → apiSuccess
- 客户端 IPC `sfShell.removeFilm(localKey)`:`fs.rm(path.join(clipsDir, localKey))`(best-effort,文件不存在不报错)
- FilmLibraryPanel handleDelete:先 DELETE route(删 DB)→ 再 IPC removeFilm(删本地)

### Step 7. chain-generate route 任务复用(R7 必修)
`packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts`
- 派发前查同 episodeId 的活跃 render_job(PENDING/QUEUED/RUNNING)→ 有则返回 `{reused:true, renderJobId}` + 202

### Step 8. 视觉检查(简化赶工)
1-2 张关键截图(films 列表 + video 预览)+ page text dump。严重崩(404/溢出/双色错)才修。

---

## ⚠️ 跨机器失效告知(必须告诉用户)

sf-asset:// URL 只在生成该片的客户端有效。同账号换机器登录 → films 列表 sf-asset:// 在新机器 404。**C/S 本地存储固有代价**,app1 MinIO 共享无此问题。批8 接受(defer 缩略图占位到批9)。

---

## 参考文件

### app1(只读,GC-3)
- `F:\app1\src\app\workspace\[projectId]\components\FilmLibraryPanel.tsx`(533行)— 镜像源
- `F:\app1\src\app\api\projects\[projectId]\films\route.ts`(156行)+ `films/[taskId]/route.ts`(83行)
- `F:\app1\src\app\workspace\[projectId]\page.tsx`(viewMode 接入)

### dramaforge(可改)
- `packages/web/app/api/projects/[id]/episodes/[episodeId]/chain-generate/route.ts`(批7)— Step 1 R6 + Step 7 R7
- `packages/web/app/api/projects/[id]/films/route.ts` — 新建(Step 2)
- `packages/web/app/api/projects/[id]/films/[jobId]/route.ts` — 新建(Step 6)
- `packages/web/app/workspace/[projectId]/components/FilmLibraryPanel.tsx` — 新建(Step 3)
- `packages/web/app/workspace/[projectId]/page.tsx` — 改 viewMode(Step 4)
- `packages/web/app/workspace/[projectId]/components/EpisodeWorkspace.tsx`(批7)— onNavigateToFilms 激活
- `packages/client/main/index.ts` — IPC saveFilm/removeFilm(Step 5/6)
- `packages/client/main/asset-store.ts` — 不改(sf-asset:// handler 已就绪)
- `packages/client/preload.ts` — 暴露 saveFilm/removeFilm
- `packages/server/src/task/render-job-repo.ts` — 不改(查 COMPLETED render_jobs 已就绪)
- `packages/web/components/ui/*`(批0)— 复用

---

## 验收

- [ ] R6:chain-generate route input 透传 projectId/episodeId/episodeNumber/title/shotCount
- [ ] GET /api/projects/[id]/films 新建(查 render_jobs JSONB)
- [ ] FilmLibraryPanel.tsx 新建(~400行,镜像 F1 项目模式)
- [ ] R1:workspace viewMode("stage"|"films")+ onNavigateToFilms 激活
- [ ] R3:下载 IPC showSaveDialog + fs.copyFile
- [ ] R4:DELETE route + 客户端 IPC fs.rm(双面清理)
- [ ] R7:chain-generate 任务复用检查
- [ ] typecheck(web/client)+ build(web/client)+ client test(IPC)
- [ ] 视觉检查 1-2 张
- [ ] GC 自检:GC-1/GC-3/GC-5(零 schema,Q1 选 A)/GC-6/GC-7(sf-asset:// + 本地 IPC)/GC-8(对齐 app1 双色)/dramaforge-assets-client-local(server 零媒体字节,films 字节客户端本地)/dramaforge-keys-cloud-server-only/dramaforge-frontend-align-app1/prefer-better-lib

---

**Brief 结束**。**批7 实现 agent 完成后(确认 ProductionStage/export-film 最终 shape)fire 批8 实现**。批8 依赖批7 chain-generate route(Step 1 同文件,必须串行)。
