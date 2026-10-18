# Plan — dramaforge C/S 垂直薄片 P5：合片成品落客户端本地（MinIO→local 重铺 + UI）

**日期**：2026-07-19　**分支**：`feat/cs-ui-slice`　**基线（本 plan 起点）**：`10f1a26`（P4 FIX-1 done）
**前置**：P4（单 clip 生成 + 客户端本地落盘 + `sf-asset://` 协议）done。

## 1. 背景与动机

P5 = **CP2 第二块**：合片（多个 clip → 一个成品视频）。 Recon 结论：**合片 pipeline 整条早就建好了**（task #10/#37 真做了），P5 不是从零搭，而是**修一个约束冲突 + 补 UI**。

### Recon 关键事实（2026-07-19 自读，子 agent 挂了改自读）

**端到端已存在**：
- UI 派发：`POST /api/render/dispatch`（`web/app/api/render/dispatch/route.ts`）— FILM_EXPORT/CHAIN_GENERATE/VIDEO_SPLIT → 写 `render_jobs` 表。
- 客户端取活：`packages/client/src/render-worker/{index,loop,executor,uploader}.ts` 已接进 Electron `main/index.ts`，HTTP 拉 `/api/render/jobs/next` 原子认领 → executor 跑 ffmpeg → 报 `/api/render/jobs/[id]/{result,progress,failed}`。
- 编排器：`orchestrators/chain-generate.ts`（CHAIN_COMPILE：逐组调 `/api/generate/video` 带末帧参考 → 本地 ffmpeg concat → 上传）+ `ffmpeg/ffmpeg-pipeline.ts`（`execFfmpegConcat` concat demuxer `-c copy` / `downloadClips` / `extractLastFrame` / split）。
- 进度：`/api/sse`（Redis `task:events` pub/sub → 浏览器，心跳保活）+ `/api/client/heartbeat`。

**P5 唯一真正的冲突**：这套成品**全程落 MinIO**——
- `server/task/dispatch.ts::dispatchFilmExport` 签 MinIO presigned PUT `outputUploadUrl` + `outputKey=renders/<userId>/<jobId>.mp4`。
- `executor.ts` CONCAT 分支 `uploadArtifact(localOut, input.outputUploadUrl)` PUT 上传 MinIO，返回 `{outputUrl: PUT_URL, meta:{outputKey}}`。
- result 路由存 result → SSE COMPLETED 带 `meta.outputKey` → UI 走 P0.5 presign-GET 路由换 MinIO GET URL 播。

**违 `dramaforge-assets-client-local`**（服务器含 MinIO 不存任何媒体字节）。+ **没有合片 UI 页**（有 dispatch 路由，无页面调它）。

## 2. 范围与排除

**做**：
1. **Task A — 成品输出 MinIO → 客户端本地**（核心约束修复）：CONCAT（+CHAIN_COMPILE 共用同模式）成品改写 `userData/` 本地，复用 P4 `sf-asset://` 协议播放；服务器只存 job 状态 + 本地 key 元数据，**零媒体字节**。
2. **Task B — 合片 UI 页** `/compile`：输入 clip URL 列表 → POST `/api/render/dispatch`(FILM_EXPORT) → SSE 显进度 → `sf-asset://` 放成品（Electron）/ 浏览器 fallback 提示。视觉照 app1 export-film 表单。

**不做（defer）**：
- **CHAIN_COMPILE 的 UI**：要 AI 逐组生成（ARK key 只在云端），E2E 只能云端跑；Task A 顺手把它的输出也改本地（约束一致性），但不做 UI。
- **EXTRACT_FRAME / SPLIT 输出路径**：非合片核心，沿用现状（defer）。
- **clip 来源管理 UI**（从项目分镜选拼哪些）：薄切片只收 URL 列表；分镜体系对齐是 CP2 之后。
- **MinIO 去留**：另题（资产不再用 MinIO，但可能留作客户端日志等；本 plan 不动）。
- **像素级视觉验收**：build 绿 + 结构对 + 数据通为 gate，视觉主动照 app1。

## 3. Global Constraints

继承 GC-1..GC-8 + 三条新约束：
- **GC-1（AI key 隔离）**：ARK key 只在云端服务器 env，绝不出客户端。
- **GC-3（app1 只读）**：`D:\app1\` reference-only。
- **GC-5（服务器稳定是命门）**：P5 服务器**零媒体字节**（成品只落客户端本地），零新增带宽/存储/OOM。render-worker 仍 HTTP 拉 job（既有机制，非 P5 引入）。
- **GC-6（边做边记）**：每 task 完追加 WORKLOG + ledger。
- **GC-7（不在 main 提交）**：`feat/cs-ui-slice`，conventional commits。
- **NEW 资产客户端本地**：成品只存 Electron `app.getPath('userData')/`（复用 P4 clips 目录 + `sf-asset://`），服务器/MinIO 不碰。
- **NEW 前端对齐 app1**：`/compile` 视觉照 app1 export-film。
- **NEW key 只在云端**：合片本身（CONCAT）不调 AI、不需 key；CHAIN_COMPILE 调 AI 但其 UI defer。

## 4. 关键决策（已定）

1. **成品落客户端本地，不走 MinIO**：CONCAT 成品写 `userData/clips/<jobId>.mp4`（复用 P4 目录 + `sf-asset://` 协议，零新协议），executor 返回 `outputUrl = sf-asset://<key>` + `meta.localKey`。服务器 result 行只存 key 元数据。
2. **dispatch 停签 MinIO URL**：`dispatchFilmExport` 不再 `presignUpload`/mint `outputKey`；ConcatInput 不再要求 `outputUploadUrl`（film 走本地）。`outputUploadUrl`/`outputKey` 字段保留可选（向后兼容测试/e2e 直传场景），但 film 派发不设。
3. **filmsDir 注入 executor**：CONCAT 不再写 tmp 再上传，直接写到注入的 filmsDir（= P4 clips 目录，main 进程 `app.getPath('userData')/clips/`）。
4. **UI 取成品**：SSE COMPLETED 事件带 `result.outputUrl = sf-asset://...`；Electron `<video>` 直播。浏览器 fallback：提示"需桌面客户端"（同 P4）。
5. **clip 输入**：薄切片收 http(s) URL 列表（ARK 临时 URL 或任意视频 URL）；executor `downloadClips` 拉取（既有）。sf-asset:// 作为输入的解析 defer（非本切片）。
6. **超时**：既有 ffmpeg `FFMPEG_TIMEOUT_MS=300_000`；render-worker loop 既有认领/重试机制，P5 不改。

## 5. P5 Task

### Task A — 成品输出 MinIO → 客户端本地（CONCAT + CHAIN_COMPILE）+ 单测
**文件**：
- `packages/server/src/task/dispatch.ts`：`dispatchFilmExport` 删 `presignUpload` + `outputKey` mint；film input 不设 `outputUploadUrl`/`outputKey`。保留函数签名兼容（input 仍 `ConcatInput`）。
- `packages/client/src/render-worker/executor.ts`：`ExecuteJobDeps` 增 `filmsDir: string` + `toAssetUrl(key): string`（或复用 P4 asset-store 的 protocol URL 构造）。CONCAT 分支：写 `path.join(filmsDir, jobId+'.mp4')`（非 tmp）→ 返回 `{outputUrl: toAssetUrl(key), meta:{localKey:key}}`；**删 `uploadArtifact` 调用**。`outputUploadUrl` 不再 required（去抛错）。
- `packages/client/src/render-worker/{loop,index}.ts`：构造 `ExecuteJobDeps` 处注入 `filmsDir`（main 进程 `app.getPath('userData')/clips/`）+ `toAssetUrl`（P4 `sf-asset://` 构造，读 asset-store 复用）。**implementer 先读 loop/index 确认 deps 构造点 + client/src↔client/main 导入可行性**（若跨包导入受阻，filmsDir/toAssetUrl 通过 deps 注入，executor 不直接 import asset-store）。
- `packages/client/src/orchestrators/chain-generate.ts`：末尾 `uploadArtifact(localOut, outputUploadUrl)` → 改本地写（同 CONCAT 模式，用注入 ctx 的 filmsDir/toAssetUrl）+ 返回 `{outputUrl: sf-asset://, meta:{localKey}}`。`ChainCompileInput.outputUploadUrl` 改可选。
- `packages/shared/src/render-job.ts`：`ConcatInput.outputUploadUrl`/`outputKey` 注释更新为"film 走客户端本地，此字段仅兼容遗留/测试"；`ChainCompileInput.outputUploadUrl` 改可选。`RenderJobResult` 无需改（`meta` 已灵活）。
- 单测更新：`server/test/task/dispatch.test.ts`（film 不再签 MinIO URL）、`client/test/render-worker/executor.test.ts`（CONCAT 写本地、不调 uploadArtifact、返 sf-asset URL）、`client/test/orchestrators/chain-generate.test.ts`（本地写、不 upload）。

**改动要点**：
- executor 是纯模块（ffmpeg/orchestrators/filmsDir 全注入），不 import electron/app（main 注入路径）。
- 服务器绝不出现在成品字节链路：dispatch 不签 URL、result 路由只存 key、UI 走 sf-asset://（不经 presign-GET）。
- 失败（ffmpeg 错/写盘错）→ executor 抛 → loop 报 `/failed`（既有机制）。
**验收**：`pnpm --filter @dramaforge/server typecheck+test`、`pnpm --filter @dramaforge/client typecheck+test` 绿；CONCAT 链路单测覆盖"写本地+sf-asset URL+零 uploadArtifact"；服务器代码零 MinIO presign（film）。

### Task B — web `/compile` 合片页 + app1 视觉对齐 + 单测
**文件**：
- `packages/web/app/compile/page.tsx`（新）：useSession 3-state gate（照 P4 /generate）。clip URL 列表输入（Textarea 一行一个 / 添加按钮，视觉照 app1 export-film）→ submit `runCompile` → SSE 订阅 `/api/render/jobs/<id>` 进度 → COMPLETED 取 `result.outputUrl`(sf-asset://) → Electron `<video>` 播 / 浏览器提示"需桌面客户端"。loading/error/进度态、Toast。
- `packages/web/app/compile/compile-flow.ts`（新，纯函数）：`runCompile(clips, {sfShell?, subscribeSse?})` → POST `/api/render/dispatch`(FILM_EXPORT) → 拿 renderJobId → 订阅 SSE → 解 COMPLETED → 返 `{kind:'done', filmUrl}` / `{kind:'error',...}`。never-rejects（照 P4 generate-flow FIX-1 模式）。类型 `SfShellBridgeLike`/SSE 形状本地复制（不 import client）。
- `packages/web/app/compile/page.test.ts`（新）：mock fetch(dispatch) + mock SSE + mock sfShell；测：submit 成功派发 + 收 COMPLETED + 渲染 `<video src=sf-asset://>`；dispatch 失败 → toast；非 Electron fallback。

**改动要点**：
- 视觉**主动照 app1** `D:\app1\src\app\api\projects\[projectId]\export-film\route.ts` 对应的 app1 export-film 表单段（implementer 读 app1 workspace 导出 UI 段，照搬视觉到 dramaforge：P1 组件 + 相对路径 + 内联 SVG）。
- envelope 解析照 P0/P4 契约：`data.success` 取 `data.data`；dispatch 返 `{renderJobId}`。
- SSE 订阅用 `EventSource('/api/sse?...')`（既有路由），按 taskId 过滤事件。
**验收**：`pnpm --filter @dramaforge/web typecheck` + `pnpm --filter @dramaforge/web build` 绿；page.test 过；登录态能 submit→dispatch→（Electron）落盘播放 /（browser）fallback。

**P5 整体验收**：2 task 全 review-clean；typecheck（client+web+server）+ web build + 全测试绿；whole-branch review（opus）过；ledger + WORKLOG 更新。**真用户端到端**= cutover 上云后（平台 key + 桌面客户端）手动：/compile 输入 clip URL → 合片 → 看到成品 + 确认文件落 `userData/clips/`、**服务器/MinIO 零成品字节**。

## 6. 实现方式（子 agent 余额待定）
CP1/CP2 全用 subagent-driven（implementer+reviewer+opus 全分支审查）。本会话子 agent 报过 429 余额不足。**Task A build 时先试一次子 agent**：通了走 subagent-driven（带审查）；不通**我自写**（无 review gate，质量保障弱一档，靠 typecheck+test+自检兜底）。无论哪种，whole-branch opus 审查力争做（若 opus 也 429 则降级为自检+ledger 显式记录"未经独立审查"）。

## 7. P5 DONE 定义
2 task 全 review-clean + whole-branch review 过（或降级自检显式记录）；typecheck（client+web+server）+ web build + 全测试绿；`/compile` 页能合片并桌面客户端本地落盘播放（真用户交互=cutover 后手动）。三条约束（资产本地 / 前端对齐 app1 / key 只在云端）全程遵守，whole-branch review 显式核。ledger + WORKLOG 更新。
