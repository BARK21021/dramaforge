# Plan — dramaforge C/S 垂直薄片（login → 项目 → AI 单镜 → render-job 合片）

**日期**：2026-07-19　**分支**：`feat/cs-ui-slice`　**前置**：续9（已 rollback 回 app1）、续10（dramaforge UI/API 缺口确认）

## 1. 背景与动机

生产已 rollback 回 app1（完整 B/S UI 在跑，HTTPS 200）。dramaforge 全容器 stop 但数据卷 + 镜像保留。续10 查实：dramaforge web 仅 13 API 路由 / 0 UI 组件，远未到可上线程度。全量移植估算 10–15 人周。

**本 plan 的目标**：不做全量，先做一个**垂直薄片**端到端打通 C/S 核心闭环，证明「dramaforge C/S 架构对产品成立」后再决定是否全量建。薄片通 = 可作为下一阶段全量移植的脚手架与信心基线。

## 2. 薄片端到端流程（验收锚点）

> 登录 → 项目列表 → 选/建项目 → 文生视频（1 个 AI 镜头，prompt-only）→ 触发合片（render-job CONCAT）→ 客户端 ffmpeg 合片 → SSE 回传 → UI 显示成品 mp4

本地起 dramaforge 全栈（docker: pg/redis/minio/web/ai-worker）+ Electron 客户端 dev，**浏览器**（dev 放开 UA）跑通上述一条链 = 薄片 GREEN。

## 3. Global Constraints（所有 task 必须遵守，reviewer 的硬约束透镜）

- **GC-1（AI key 隔离）**：AI 提供商 key 只在服务器（ai-worker / server domain），**绝不**进 web 前端 bundle、绝不下发客户端。
- **GC-2（ffmpeg 隔离）**：ffmpeg 绝不在服务器跑。`packages/server`（含 ai-worker）**禁止 import 任何 ffmpeg 模块**（@ffmpeg-installer/fluent-ffmpeg/ffmpeg-static）。
- **GC-3（app1 只读）**：`F:\app1` 与 `D:\app1` 是 reference-only，**禁止修改**其任何文件。移植 = 读其源码后在 dramaforge 重写。
- **GC-4（响应信封）**：UI-facing 路由统一 app1 信封：成功 `{success:true,data}`，失败 `{success:false,error,code?,category?,retryable?,suggestion?}`。机器对机器路由（render-worker 拉 job、client heartbeat）保持现状裸 data。
- **GC-5（服务器稳定是命门）**：任何改动不得引入服务器 OOM/崩溃风险；不动 ai-worker 的内存敏感路径。
- **GC-6（边做边记）**：每完成一个 task 追加 WORKLOG + 更新 `.superpowers/sdd/progress.md` ledger。
- **GC-7（不在 main 提交）**：所有工作在 `feat/cs-ui-slice` 分支；commit message 用 conventional commits（中文描述可）。
- **GC-8（迁移数据敏感）**：`scripts/app1-data.sql` 含真实密码 hash + API key，gitignored，**绝不提交、绝不粘进任何文件**。

## 4. 关键技术决策（已定，不再开）

1. **AI 生成走 dramaforge 现成同步 `/api/generate/video`**（已存在），不为薄片造异步 task+SSE 流程。SSE 由「合片」步（客户端 ffmpeg 耗时）充分验证。AI 步同步即证明「AI 在服务器、key 不下发」。
2. **存储用 MinIO（真存储）并修 URL bug**，不用 local 绕开。原因：客户端靠 presigned PUT 上传合片成品，local 的 presign 是假 URL、PUT 进不了 Next public 目录。MinIO 修复本就是 prod 必做项，薄片提前。
3. **dispatch 内部自动签 `outputUploadUrl`**（调用方不自己造），并生成稳定 `outputKey` 写入 input。executor 回传 `meta:{outputKey}`，UI 用稳定 key 换 presigned GET，不依赖会过期的 PUT URL。

## 5. P0 — 基建（硬依赖，先行；本 plan 详写）

### Task 1 — 响应信封统一
**文件**：`packages/web/lib/response.ts`（新增 apiSuccess/apiError/handleApiError）；`packages/web/app/api/generate/video/route.ts`、`packages/web/app/api/render/dispatch/route.ts`（改用新信封）
**改动**：
- 在 response.ts 加 `apiSuccess(data, status=200)` → `NextResponse.json({success:true,data}, {status})`
- 加 `apiError({error, code?, category?, retryable?, suggestion?}, status=400)` → `{success:false, ...}`
- 加 `handleApiError(e)`：识别 AuthError（401）/ ZodError（400 校验信息）/ 兜底 500，返回对应 apiError
- generate/video、render/dispatch 两个 UI-facing 路由从裸 data 改为新信封（client/render-jobs/*、client/heartbeat 等 M2M 路由不动）
**验收**：`pnpm --filter @dramaforge/web typecheck` 绿；新增 response.ts 单测覆盖 apiSuccess/apiError/handleApiError 三种路径；两个路由手测 curl 返回 `{success:true,data}`。

### Task 2 — 中间件 dev 放开浏览器
**文件**：`packages/web/middleware.ts`
**改动**：`NODE_ENV === 'development'` 时直接 `NextResponse.next()`（跳过 UA 302→/download）。prod 保持 Electron-only gate。保留对 `/api/*` 和 `/download` 的既有豁免。
**验收**：dev 模式浏览器 GET `/` 不再 302 到 /download；prod 行为不变（typecheck + 逻辑 review）。

### Task 3 — MinIO URL 修复（env + storage）
**文件**：`packages/server/src/infra/env.ts`（EnvSchema 加 `MINIO_PUBLIC_BASE_URL`）；`packages/server/src/domain/storage/minio.ts`（publicBaseUrl 用它；presign 用绑定公网域名的第二个 minio Client）
**改动**：
- env.ts EnvSchema 加 `MINIO_PUBLIC_BASE_URL: z.string().url().optional()`（默认回退 MINIO_ENDPOINT，兼容现状）
- minio.ts：`publicBaseUrl` 取 `MINIO_PUBLIC_BASE_URL ?? MINIO_ENDPOINT`；presignUpload/presignDownload 用一个 endpoint=publicBaseUrl 的第二个 `Client` 实例签名（签名只需 key/secret/bucket，endpoint 不参与签名计算，但生成的 URL host 必须是公网域名）
- upload() 写入 DB / 返回的 url 用 `${publicBaseUrl}/${bucket}/${key}`
**验收**：typecheck 绿；新增单测：presign 出来的 URL host = publicBaseUrl 而非内网 `minio`；upload 返回的 url 浏览器可解析。本地 docker minio 起来时手测 presign GET 能取到对象。

### Task 4 — 契约 outputKey + dispatch 自动签 outputUploadUrl
**文件**：`packages/shared/src/render-job.ts`（ConcatInput 加 outputKey?）；`packages/web/app/api/render/dispatch/route.ts`（内部签 outputUploadUrl + 生成 outputKey）；`packages/client/src/render-worker/executor.ts`（CONCAT 返回 meta:{outputKey}）
**改动**：
- shared：`ConcatInput` 加 `outputKey?: string`（服务器签发，客户端回传用）
- dispatch route：接到 FILM_EXPORT 请求后，若 input 无 outputUploadUrl，调 `storage.presignUpload(key)` 生成；outputKey = `renders/${userId}/${jobId}.mp4`（确定性、稳定）；把 outputKey 塞进 input 一起存 render_jobs.input
- executor CONCAT 分支：上传后返回 `{outputUrl: <presigned PUT url>, meta: {outputKey: input.outputKey}}`（修当前「返回会过期 PUT URL 当成品 URL」的 bug）
**验收**：typecheck 绿（shared+web+client 三包）；dispatch 单测：无 outputUploadUrl 入参时自动签发并写入 outputKey；executor 单测：CONCAT 结果 meta.outputKey === input.outputKey。

### Task 5 — presign-GET 路由（UI 显示成品）
**文件**：`packages/web/app/api/storage/presign/route.ts`（新增）
**改动**：`GET ?key=<objectKey>` → requireUser() → `storage.presignDownload(key)` → `apiSuccess({url})`。key 白名单校验：必须以 `renders/${userId}/` 或 `uploads/${userId}/` 开头（防越权取他人对象）。
**验收**：typecheck 绿；单测：合法 key 返回 presigned GET url；他人前缀 key 返回 403 apiError；未登录 401。

### Task 6 — nginx /minio/ 反代（prod 浏览器取图）
**文件**：服务器 `/etc/nginx/conf.d/your-domain.conf`（或同等）；`scripts/` 下加一个 `provision-nginx-minio.sh` 留档
**改动**：加 `location /minio/ { proxy_pass http://127.0.0.1:9000/; ... }` 让 prod 浏览器可经 `https://your-domain.example.com/minio/<bucket>/<key>` 取对象（与 MINIO_PUBLIC_BASE_URL=`https://your-domain.example.com/minio` 配合）。**注意**：此 task 动服务器配置，需 SSH 执行 + reload + curl 验证；执行前在 WORKLOG 记录变更。
**验收**：SSH 上 `curl -I https://your-domain.example.com/minio/<bucket>/<公开对象>` 200；nginx -t 通过；reload 无报错。

**P0 整体验收**：6 task 全 review clean；本地 docker stack 起 web，typecheck + 相关单测全绿。P0 不要求端到端跑通（UI 还没建），只要求基建就位。

## 6. P1–P5（后续 plan 详写，本 plan 仅锚定范围）

- **P1 UI 脚手架**：web 加 tailwind4/@tailwindcss/postcss/radix(dialog/label/slot)/lucide/clsx/tailwind-merge/qrcode.react；移植 app1 globals.css（暗色 :root + --accent amber/--action blue token + 组件类）、cn.ts、Button/Input；root layout 挂 SessionProvider + ToastProvider。
- **P2 登录**：移植 app1 `auth/signin/page.tsx`（凭证登录 password-only，`signIn("credentials",{login,password,redirect:false})`）+ login-identifier.ts；迁移用户实测登进。
- **P3 项目列表**：新写 `packages/server/src/domain/project/project-repo.ts`（照 render-job-repo.ts 模板，查 projects 表）+ barrel 导出；新增 `web/app/api/projects/route.ts`（GET list by userId + POST create，新信封）；移植精简版 `workspace/page.tsx`（卡片网格）。
- **P4 AI 视频生成**：薄片 UI 触发器，prompt → POST /api/generate/video → 拿 clip URL（同步）。
- **P5 render-job 合片**：UI 把 clip 喂 `/api/render/dispatch {type:FILM_EXPORT, input:{clips:[{url}], outputKey}}` → Electron render-worker 拉 CONCAT job → ffmpeg 合片 → presigned PUT → SSE COMPLETED → UI 订阅 /api/sse → meta.outputKey → /api/storage/presign → 显示成品。

**交付节奏**：CP1 = P0–P3（登录 + 项目列表可见，证明脚手架 + auth + CRUD + 存储修复）；CP2 = P4–P5（AI + 合片闭环，证明 C/S 核心）。

## 7. 薄片整体 DONE 定义

本地 dramaforge 全栈 + Electron dev，浏览器跑通第 2 节端到端流程；续10 的三处 hazard（信封分叉 / MinIO URL / 中间件 UA gate）在薄片范围内全修；WORKLOG + ledger 完整；feature 分支可 merge。
