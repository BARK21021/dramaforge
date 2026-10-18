# Plan — dramaforge C/S 垂直薄片 P4：AI 视频生成（客户端本地落盘）

**日期**：2026-07-19　**分支**：`feat/cs-ui-slice`　**基线（本 plan 起点）**：`626299e`（P3 done + CP1 达成）
**前置**：CP1（=P0-P3）结构达成；用户桌面客户端实测登录+项目列表+中文 UTF-8 全链路通过。

## 1. 背景与动机

CP1 完成（登录 + 项目列表）。P4 = **CP2 第一块**：让用户能手动生成单个视频 clip 并看到。

### 两条新硬约束（用户 2026-07-19 下达，已写记忆）
- **资产客户端本地**（`dramaforge-assets-client-local`）：所有媒体资产只准存 Electron 客户端本地硬盘，**服务器不存任何媒体字节（含 MinIO）**。→ 推翻 brainstorm 第一版"落 MinIO"提议。
- **前端对齐 app1**（`dramaforge-frontend-align-app1`）：UI 视觉/交互照 app1（`D:\app1`），不自创。

### Recon 关键事实（agent ab1a4fc4，2026-07-19）
- **dramaforge `/api/generate/video` 路由已存在且可用**（`packages/web/app/api/generate/video/route.ts`）：POST + `requireUser` + `callAI(provider, model, {capability:'video_generation', input, userId})` → 返回 envelope `{success:true, data:{url, meta}}`，`url` = ARK TOS presigned **1h 过期**临时链接。路由**完全独立于 task/render_jobs/BullMQ**，**无持久化、无 shots 回写**。
- 路由要求 body 含 `model`（"provider/model-id"）；其余字段（prompt/imageUrl/...）透传不校验。错误信封：400 BAD_BODY/INVALID_JSON/MISSING_MODEL/BAD_MODEL，401 UNAUTHORIZED，502 AI_GATEWAY_ERROR(retryable)，500 INTERNAL_ERROR。
- **gateway `callAI`**（`packages/server/src/gateway/index.ts`）13 个 provider 全真实接通；ARK（豆包 Seedance）为视频主力；key 从 `gateway/credentials.ts`（`api_configs` 表优先，env 回退）。**本地 .env 所有 AI key 空串** → 端到端实测需用户填 `ARK_API_KEY`（GC-1：key 只在服务器，用户自有）。
- **chain-generate**（`packages/client/src/orchestrators/chain-generate.ts`，**客户端 Electron 模块**）已在消费 `/api/generate/video`（P0 完工，每组调一次 + 3 次重试）——那是 **P5 合片**的事，P4 不碰。
- **MinIO storage backend 就绪**（`packages/server/src/domain/storage/minio.ts`：upload/presignDownload 全有）——但按新约束**不用来存资产**。
- **app1 生成 UI** 在 `D:\app1\src\app\workspace\[projectId]\page.tsx`（项目内分镜级生成，带剧集/分镜体系，用 `DEFAULT_VIDEO_MODEL_ID = "ark/doubao-seedance-2-0-mini-260615"`）。app1 `/api/generate/video` 路由 UI 不直接调（走 group-service createTask）。**P4 不照搬 app1 的分镜/剧集体系**，只借它的**生成表单视觉**。

## 2. 范围与排除

**做**：
1. **Electron main 资产基础设施**：下载 URL→本地文件、本地 clip 目录管理、`<video>` 能播本地文件（custom protocol 或等价）、preload 暴露 IPC bridge。
2. **web `/generate` 页**：prompt 输入 + 生成按钮（视觉照 app1）→ `POST /api/generate/video` 拿 ARK 临时 URL → 调 Electron IPC 下载到本地 → `<video>` 播本地文件。loading/error 态。
3. app1 生成表单视觉对齐（输入框/按钮/视频框/文案风格）。

**不做（defer）**：
- **服务器路由改动**：`/api/generate/video` 现状（返回临时 URL）正是所需，**零改**。服务器不下载/不转发/不存任何视频字节。
- **chain-generate / ffmpeg 合片**：P5。
- **项目内分镜级生成 / workspace/[projectId]**：app1 那套剧集+分镜体系，以后做。P4 是独立 `/generate` 实验页。
- **图片输入（图生视频）/ 时长/宽高比/模型选择 UI**：薄片只收 prompt，模型走默认。
- **MinIO 资产存储 / presign-GET 给 clips 用**：新约束下服务器不存资产，n/a。
- **生成历史/clip 库 UI**：clip 落本地硬盘即满足"资产本地"；跨会话列表 UI 留后续（Task 可含最小本地索引若顺手）。
- **像素级视觉验收**：build 绿 + 结构对 + 数据通为 gate，像素留用户手动（本会话无 browser-harness；但视觉**主动照 app1** 而非自创）。

## 3. Global Constraints

继承 GC-1..GC-8 + 两条新约束：
- **GC-1（AI key 隔离）**：ARK key 只在服务器 env，绝不出客户端、不进任何前端代码/记忆/文件。
- **GC-3（app1 只读）**：`D:\app1\` reference-only；移植=读后重写。
- **GC-5（服务器稳定是命门）**：P4 服务器**零资产字节**（只回临时 URL），零新增带宽/存储/OOM 风险。路由同步阻塞 callAI 30-60s 已存在（非 P4 引入），薄片不加并发门（defer 到真有负载）。
- **GC-6（边做边记）**：每 task 完追加 WORKLOG + ledger。
- **GC-7（不在 main 提交）**：`feat/cs-ui-slice` 分支，conventional commits。
- **NEW 资产客户端本地**：clip 只存 Electron `app.getPath('userData')/clips/`，服务器不碰。
- **NEW 前端对齐 app1**：`/generate` 视觉照 `D:\app1\src\app\workspace\[projectId]\page.tsx` 生成表单。

## 4. 关键决策（已定）

1. **独立 `/generate` 页**（非项目内），薄片最薄；视觉照 app1 生成表单，不照搬分镜体系。
2. **prompt-only 输入**；模型默认 `ark/doubao-seedance-2-0-mini-260615`（app1 `DEFAULT_VIDEO_MODEL_ID`）；body 透传 `{model, prompt}` 给现有路由。
3. **服务器路由零改**：`/api/generate/video` 现状即所需（返回 ARK 临时 URL envelope）。
4. **客户端本地落盘**：渲染进程拿临时 URL → 经 preload IPC 调 main 进程 → main 下载到 `userData/clips/<clipId>.mp4` → 返回本地标识 → 渲染进程用本地 protocol 播放。**渲染进程沙箱不直接写盘/不走 file://**（remote https 页面 file:// 被拦）。
5. **本地播放机制**：优先 Electron `protocol.handle` 注册自定义 scheme（如 `sf-asset://`）serve `userData/clips/` 下文件；implementer 读现有 client/main 是否已注册 protocol，有则复用，无则新建。备选：main 起本地 http server。**禁止** base64 视频过 IPC（体积）。
6. **clipId/文件名**：`genId()` (UUID, from @shared/utils) + `.mp4`；prompt 等元信息若要跨会话留，写本地最小索引 JSON（`userData/clips/index.json`）——Task 1 可含可不含，看顺手；薄片核心是"生成→落盘→播"。
7. **浏览器 fallback**：`/generate` 在非 Electron（纯浏览器/dev）无 IPC → 退化为直接 `<video src=临时URL>` 播放（仅当次会话，不落盘），并显式提示"桌面客户端才落本地"。不报错阻断 dev。
8. **超时**：main 下载用 `AbortSignal.timeout(180_000)`（照 app1 persistVideo VW283）；失败 toast，不崩。

## 5. P4 Task

### Task 1 — Electron main 资产基础设施（下载 + 本地 serve + IPC + preload）+ 单测
**文件**（implementer 先读 `packages/client/main/` 全貌 + `packages/client/preload*` 确认现有结构/命名，再定文件）：
- `packages/client/main/asset-store.ts`（新，或并入现有 main 模块）：`downloadAsset(url, opts): Promise<{key, localPath}>`（fetch 流式写 `userData/clips/<id>.mp4`，AbortSignal 180s）、`listLocalClips()?`、`resolveClipUrl(key)`（返自定义 protocol URL）。
- `packages/client/main/index.ts`（或现 main 入口）：注册 `protocol.handle('sf-asset', ...)` serve clips 目录（若已有 protocol 复用）；注册 IPC handler（ipcMain.handle）暴露 `asset:download`。
- `packages/client/preload.ts`（或现有 preload）：`contextBridge.exposeInMainWorld('sf', { downloadAsset(url): Promise<...>, isElectron: true })`（命名照现有 bridge 风格；若已有 `window.sf` 则扩展）。
- 对应单测（mock fetch/fs，照现有 client 测试风格）。

**改动要点**：
- 渲染进程**不直接** Node fs / 不 file://。所有落盘走 main IPC。
- 自定义 protocol 必须在 `app.whenReady()` 前/合适时机 `protocol.registerSchemesAsPrivileged`（若需）+ `protocol.handle`。读 Electron 版本（package.json）确认 API（`protocol.handle` 是 Electron 25+；旧版用 `registerFileProtocol`）。
- 失败（下载超时/HTTP 非 2xx/写盘错）→ 抛结构化错误给渲染进程 toast，不崩 main。
**验收**：`pnpm --filter @dramaforge/client typecheck` + client test 绿；下载→落盘→protocol URL 解析本地文件链路单测覆盖；main 不引入服务器媒体存储。

### Task 2 — web `/generate` 页 + app1 视觉对齐 + 单测
**文件**：
- `packages/web/app/generate/page.tsx`（新）：prompt Textarea + 生成 Button（**视觉照 app1 `workspace/[projectId]` 生成表单**）→ submit：`fetch('/api/generate/video',{method:'POST',headers,body:JSON.stringify({model:DEFAULT_MODEL,prompt})})` → 解 envelope → `data.success ? data.data.url : throw` → 若 `window.sf?.downloadAsset` 存在（Electron）则下载落盘 + `<video src=sf-asset://...>`；否则 fallback `<video src=url>` + 提示。loading/error 态、Toast。
- `packages/web/app/generate/page.test.ts`（新）：mock fetch + mock `window.sf`，测：submit 成功调路由 + 调 downloadAsset + 渲染 `<video>`；路由失败（success:false / 502）→ toast；非 Electron fallback 分支。
- 常量：`DEFAULT_MODEL = 'ark/doubao-seedance-2-0-mini-260615'`（与 app1 一致；可放 page 内或 shared）。

**改动要点**：
- 视觉**主动照 app1**：implementer 先读 `D:\app1\src\app\workspace\[projectId]\page.tsx` 生成表单段（输入框/按钮/视频框/文案/配色/间距），照搬视觉到 dramaforge（dramaforge 用 P1 组件 Button/Input/Textarea/Toast + 相对路径，无 `@/`，lucide 用内联 SVG）。
- envelope 解析照 P0 契约：`data.success===true` 取 `data.data.url`；`success===false` 取 `data.error/code`。
- 直接 `fetch('/api/projects')` 同款 cookie 自动带（P3 先例），无 useAuthFetch。
**验收**：`pnpm --filter @dramaforge/web typecheck` + `pnpm --filter @dramaforge/web build` 绿；page.test 过；登录态能 submit→fetch 路由→（Electron）落盘播放 /（browser）fallback 播放。

**P4 整体验收**：2 task 全 review-clean；typecheck（client+web）+ web build + 全测试绿；whole-branch review（opus）过；ledger + WORKLOG 更新。**真用户端到端**= 用户手动（填 `ARK_API_KEY` 到服务器 .env → 桌面客户端 `/generate` → 输入 prompt → 生成 → 看到视频 + 确认文件落在 `userData/clips/`）。

## 6. P5（承自 P3 plan，CP2 后半）
- **P5 render-job 合片**：dispatch CONCAT → Electron render-worker（ffmpeg 在客户端）→ SSE → 本地成品 → 显示。chain-generate 编排器（P0 完工）届时接入。

## 7. P4 DONE 定义
2 task 全 review-clean（implementer + task-reviewer 双 verdict）+ whole-branch review（opus）过；typecheck（client+web）+ web build + 全测试绿；`/generate` 页能生成 clip 并在桌面客户端本地落盘播放（真用户交互=手动）。两条新约束（资产本地 / 前端对齐 app1）全程遵守，whole-branch review 显式核。ledger + WORKLOG 更新。
