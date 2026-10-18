# Plan — dramaforge C/S 垂直薄片 P3：项目列表

**日期**：2026-07-19　**分支**：`feat/cs-ui-slice`　**基线（本 plan 起点）**：`4c5ca13`（P2 登录 done + 本地端到端验证通过）
**前置**：P2 plan `2026-07-19-cs-ui-vertical-slice-p2.md`（whole-branch opus Approved "Yes-with-followups"，I-1 open-redirect 已修；用户已本地桌面客户端实测登录通过）

## 1. 背景与动机

P2 登录完成（NextAuth credentials 链路 + sanitizeCallbackUrl open-redirect 修复；本地桌面客户端 + curl 双向验证通过）。P3 = **CP1（=P0-P3）最后一块**：让用户登录后能看到、创建自己的项目列表。

Recon（agent `general-purpose`，sonnet，2026-07-19）关键事实：
- **`projects` 表已存在**（`packages/server/src/infra/migrations/0001-init.sql` 第 115-128 行 + ALTER 266/408/413/418-420/515-519），字段齐全（id/"userId"/title/description/"novelText"/"scriptData"/"artStyle"/status DEFAULT 'DRAFT'/version/"createdAt"/"updatedAt"/category DEFAULT 'DOMESTIC'/"sourceProjectId"/"scriptOverride" 等 + 索引 idx_projects_userId/status/category/sourceProjectId）。**P3 不需新建 migration。**
- ⚠️ **projects 列名是 camelCase 加双引号**（Prisma 遗留）：`"userId"` `"createdAt"` `"updatedAt"` `"sourceProjectId"` 等。对照 render_jobs 用 snake_case。project-repo 的 SQL 必须双引号驼峰列。
- **render-job-repo 模板**在 `packages/server/src/task/render-job-repo.ts`：函数式 + 末尾聚合 `export const renderJobRepo = { create, claimNext, ... }`；SQL client 从 `@server/infra` 的 `query`/`tx`（**无直接 pg import**）；`$1,$2` 参数化；**不 try/catch**，异常 bubble 给 route 的 `handleApiError`；JSONB `JSON.stringify`，TIMESTAMPTZ 靠 PG `now()/DEFAULT`；`genId()` 纯 UUID v4（from `@shared/utils`）；`mapRow` 下划线→驼峰。
- **domain 子域三文件 split**（参考 `domain/asset/{index,service,validation}.ts`）：`service.ts`=CRUD 裸 SQL 函数（camelCase 列加双引号），`validation.ts`=校验+常量，`index.ts`=barrel。`domain/index.ts` 双层 export（`export * as X from './X'` + `export * from './X'`）。
- **根 barrel `packages/server/src/index.ts` 仅 named re-export**（注释说明避免跨模块同名冲突）；web 不直接 import `@server/infra`，全走 `@dramaforge/server`。
- **envelope**（`packages/web/lib/response.ts`）：`apiSuccess(data, status=200)` → `{success:true,data}`；`apiFail({error,code?,category?,retryable?,suggestion?}, status=400)` → `{success:false,...}`；`handleApiError(err, context?)` 自动处理 AuthError/ZodError/fallback 500。⚠️ **失败 helper 叫 `apiFail` 不是 `apiError`**——`apiError`/`apiOk`/`unauthorized` 是 M2M bare 路径（被 render-job-guard/api/client/*/api/sse 引用），**P3 UI route 禁用**。
- **认证**（`packages/web/lib/auth.ts`）：`requireUser()` **无参数**，返 `{userId, role} | null`（不抛）；`AuthError` 类（message, statusCode, code）。route 标准用法（`api/render/dispatch/route.ts`）：`const auth = await requireUser(); if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');` 后续用 `auth.userId`。
- **app1 workspace** `D:\app1\src\app\workspace\page.tsx`（535 行 client component）：项目列表卡片网格在第 309-377 行，新建弹窗第 382-519 行。用 `useAuthFetch`（Bearer token）+ Prisma。app1 `ProjectItem` 字段：id/title/description?/status/category?/artStyle?/createdAt/updatedAt。app1 POST 有复杂 sourceMode/category/artStyle 组合约束——**P3 不实现这些**。
- **app1 projects API** `D:\app1\src\app\api\projects\route.ts`：GET `prisma.project.findMany({where:{userId,status?},orderBy:{updatedAt:'desc'}})`；POST `prisma.project.create`。
- **dramaforge `@dramaforge/shared`** 现有 `render-job.ts`/`client-api.ts`/`long-video-plan.ts`/`version.ts`/`utils.ts`，**无 project.ts**。
- **dramaforge web `app/`** 无 `workspace/`（P3 新建）；无 `useAuthFetch`/`AppHeader`/`CreditsBadge`/`EmptyState`/`ConfirmDialog`。P1 组件已有：Button/Input(含Textarea/Label/FormField)/Toast(含useToast)/Spinner/cn。

## 2. 范围与排除

**做**：
1. `@dramaforge/shared` 加 `project.ts` 契约类型（前后端共享）
2. `packages/server/src/domain/project/{service,validation,index}.ts` + 接入 `domain/index.ts` + 根 `index.ts` barrel
3. `packages/web/app/api/projects/route.ts`（GET list by userId + POST create，用 envelope + requireUser）
4. `packages/web/app/workspace/page.tsx`（精简卡片网格 + 新建 title 弹窗）
5. callbackUrl fallback 回 `/workspace`

**不做（defer，不在 P3）**：
- **migration**：projects 表已存在
- **`workspace/[projectId]/` 子路由**：P4+ 项目详情
- **删除/编辑项目**：ConfirmDialog 等组件未移植；本期不做
- **Tab 分类切换**（ORIGINAL/DOMESTIC/OVERSEAS）：首版展示全部项目
- **CreditsBadge / AppHeader / 充值**：task #36 支付宝 slice
- **app1 POST 的 sourceMode/sourceProjectId/artStyle 组合约束**：那是 P4+ 视频生成的业务规则，P3 create 只收 title/description/category
- **视觉像素对齐 app1**：build 绿 + 结构正确 + 数据通为 gate，像素留用户手动（同 P1/P2，本会话无 browser-harness）

## 3. Global Constraints（继承 GC-1..GC-8）

- **GC-3（app1 只读）**：`D:/app1/` reference-only，移植 = 读后重写。
- **GC-5（服务器稳定是命门）**：P3 只加 `SELECT ... WHERE "userId"=$1`（已索引）+ 单行 `INSERT`，无 ffmpeg/无大内存/无 OOM 风险。
- **GC-6（边做边记）**：每 task 完追加 WORKLOG + ledger。
- **GC-7（不在 main 提交）**：`feat/cs-ui-slice` 分支，conventional commits。
- **GC-8（scripts/app1-data.sql 密钥）**：n/a 于 P3，但不得引入任何敏感常量。

## 4. 关键决策（已定，不再开）

1. **project-repo 放 `domain/project/` 三件套**（非 `task/`）：project 是核心业务实体，P4/P5 会大量扩展（episode/script/scene...），`domain/` 是业务实体的家（asset/storyboard/workflow/billing 均在此）；render-job 在 `task/` 是因为它本质是调度队列实体，语义不同。三文件 split（service/validation/index）与 asset 子域一致，validation 独立可被 route 复用。
2. **`@dramaforge/shared` 加 `project.ts`**：定义 `ProjectStatus`/`ProjectCategory`/`ProjectRecord`/`CreateProjectInput`（= `z.infer<typeof createProjectSchema>`）。前后端共享，与 `render-job.ts` 模式一致。`shared/src/index.ts` 加 `export * from './project';`。
3. **id 用纯 UUID**（`genId()`，dramaforge 风格），**不保留 app1 的 `proj-` 前缀**（那是 Prisma 历史习惯；dramaforge render_jobs 已用纯 uuid）。
4. **validation 用 Zod**（`createProjectSchema`），route 里 `createProjectSchema.parse(raw)` + `handleApiError(ZodError)` 自动转 `VALIDATION_ERROR` 400（与 `api/render/dispatch` 一致，比手写校验更省且 envelope 天然处理 ZodError）。POST 校验范围（精简）：`title` 必填 max 100；`description` 可选 max 2000；`category` 可选枚举 `ORIGINAL|DOMESTIC|OVERSEAS` 默认 `DOMESTIC`。**不实现** app1 的 sourceMode/artStyle 组合约束。
5. **service.ts 函数式 + 聚合对象** `export const projectRepo = { listByUser, create }`，照 render-job-repo 风格：`query` from `@server/infra`，`$1` 参数化，不 try/catch（bubble 给 route handleApiError），`mapRow` 驼峰（projects 列已驼峰，mapRow 较 render-job-repo 简单——主要是 TIMESTAMPTZ Date→ISO + JSONB 兼容）。
6. **GET 不过滤 status**（返回全部含 DRAFT），`ORDER BY "updatedAt" DESC`；只按 `"userId"=$1` 隔离。
7. **workspace 页精简**：直接 `fetch('/api/projects')`（cookie 自动带，**不用 useAuthFetch**）；裸 `<header>`（标题 + 新建按钮，无 CreditsBadge）；新建弹窗只要 `title`（category 默认 DOMESTIC）；**无 Tab/删除/编辑**；EmptyState 内联。卡片保留：状态徽章 + 标题 + 描述（截断）+ 更新时间。用 P1 组件（Button/Input/Toast/Spinner）。
8. **新建成功不跳转** `[projectId]`（P3 不建子路由）→ toast 成功 + 重新 fetch 列表（新卡出现在顶部）。
9. **callbackUrl 回 `/workspace`**：改 `app/auth/signin/callback-url.ts` 的 3 处 fallback `return "/"` → `return "/workspace"`（不是改 signin/page.tsx）。⚠️ 显式 `?callbackUrl=/` 仍回 `/`（同源允许，有意保留——sanitizeCallbackUrl 只拦截非同源，`/` 是合法同源路径）。同步更新 `callback-url.test.ts` + signin/page.tsx 注释。**I-1 open-redirect 防护不变**（`//`、完整 URL、非字符串仍 → `/workspace`，仍是同源绝对路径）。
10. **SQL 列名 camelCase 加双引号**：`"userId"` `"createdAt"` `"updatedAt"` `"artStyle"` `"sourceProjectId"` `"novelText"` `"scriptData"` `"videoScriptDraft"` 等（projects 表 Prisma 遗留）。`status`/`title`/`description`/`category`/`version`/`id` 是小写无引号。

## 5. P3 Task

### Task 1 — shared 契约 + domain/project repo + barrel + 单测
**文件**：
- `packages/shared/src/project.ts`（新）
- `packages/shared/src/index.ts`（改，+ `export * from './project';`）
- `packages/server/src/domain/project/service.ts`（新）
- `packages/server/src/domain/project/validation.ts`（新）
- `packages/server/src/domain/project/index.ts`（新）
- `packages/server/src/domain/index.ts`（改，+ project 双层 export）
- `packages/server/src/index.ts`（改，+ project named re-export，保持 named-only 风格）
- `packages/server/src/domain/project/service.test.ts`（新）

**改动**：
- `project.ts`：`ProjectStatus`（查 0001-init.sql 的 status 语义 + app1 type 补全，至少含 `'DRAFT'`；列出 implementer 核对到的全部值）、`ProjectCategory = 'ORIGINAL' | 'DOMESTIC' | 'OVERSEAS'`、`ProjectRecord`（id/userId/title/description/category/status/createdAt/updatedAt/artStyle?/... 对齐表字段，TIMESTAMPTZ→ISO string）、`CreateProjectInput = z.infer<typeof createProjectSchema>`。Zod schema 定义在 validation.ts 还是 shared？**为前后端共享，Zod schema 放 shared/project.ts**（`createProjectSchema`），server validation.ts re-export 或直接从 shared 引。
- `service.ts`：`listByUser(userId: string): Promise<ProjectRecord[]>`（`SELECT * FROM projects WHERE "userId"=$1 ORDER BY "updatedAt" DESC`）；`create(userId: string, input: CreateProjectInput): Promise<ProjectRecord>`（`INSERT INTO projects (id,"userId",title,description,category,status,...) VALUES ($1,$2,$3,$4,$5,'DRAFT',...) RETURNING *`，id=`genId()`，category 取 input.category ?? 'DOMESTIC'，status 让表 DEFAULT 'DRAFT'）。`mapRow(row): ProjectRecord`（驼峰字段直接取 + `createdAt`/`updatedAt` Date→ISO + JSONB 字段兼容）。`export const projectRepo = { listByUser, create };`。照 render-job-repo 风格。
- `validation.ts`：re-export `createProjectSchema` from shared（或在此定义，shared 引类型——选前者，schema 单一来源在 shared）。
- `index.ts`：`export * from './service'; export * from './validation'; export { projectRepo } from './service';`
- `domain/index.ts`：加 `export * as project from './project';` + `export * from './project';`（双层，与 asset 一致）。
- 根 `index.ts`：named re-export project（如 `export { projectRepo, type ProjectRecord, type CreateProjectInput } from './domain/project';`，保持 named-only）。
- `service.test.ts`：参照 `task/render-job-repo.test.ts` 的测试风格（implementer 先读它确认 mock 还是真实 query 模式）。case：listByUser 空数组/多条/userId 隔离（只返回自己的）；create 成功字段回填（id 非空/userId 正确/category 默认 DOMESTIC/status DRAFT/createdAt-updatedAt 非空）。
**验收**：`pnpm --filter @dramaforge/shared typecheck` + `pnpm --filter @dramaforge/server typecheck` 绿；service.test 过；barrel 正确（`@dramaforge/server` 能 import projectRepo + ProjectRecord；`@dramaforge/shared` 能 import ProjectRecord/CreateProjectInput/createProjectSchema）。

### Task 2 — web /api/projects route + 单测
**文件**：
- `packages/web/app/api/projects/route.ts`（新）
- `packages/web/app/api/projects/route.test.ts`（新）

**改动**：
- `GET`：`requireUser()` → null 抛 `AuthError(...,401,'UNAUTHORIZED')` → `projectRepo.listByUser(auth.userId)` → `apiSuccess(projects)`。
- `POST`：`requireUser()` → 401 → `createProjectSchema.parse(await req.json())`（ZodError 由 handleApiError 转 VALIDATION_ERROR 400）→ `projectRepo.create(auth.userId, parsed)` → `apiSuccess(project, 201)`。
- 照 `api/render/dispatch/route.ts` 模式：`import { requireUser, AuthError } from '@web/lib/auth';` `import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';` `import { projectRepo } from '@dramaforge/server';` `import { createProjectSchema } from '@dramaforge/shared';`。整个 handler 包 try/catch，catch `handleApiError(err, 'GET/POST /api/projects')`。
- `route.test.ts`：参照 `api/render/dispatch/route.test.ts` 测试风格（implementer 先读它确认 mock requireUser/projectRepo 的方式）。case：GET 未登录 401；GET 已登录 200 + body.success + data 是数组；POST 未登录 401；POST body 校验失败（空 title / title>100）400 VALIDATION_ERROR；POST 成功 201 + data.title 回填 + 调了 projectRepo.create。**注意用 apiFail 信封**（断言 `body.success === false`）。
**验收**：`pnpm --filter @dramaforge/web typecheck` 绿；route.test 过；route 用 `apiFail`（非 `apiError`）。

### Task 3 — workspace 页 + callbackUrl 回 /workspace
**文件**：
- `packages/web/app/workspace/page.tsx`（新）
- `packages/web/app/auth/signin/callback-url.ts`（改，3 处 fallback `/`→`/workspace`）
- `packages/web/app/auth/signin/callback-url.test.ts`（改，更新期望）
- `packages/web/app/auth/signin/page.tsx`（改，注释更新）

**改动**：
- `workspace/page.tsx`（`"use client"`）：`useSession()` 三态——`loading` 显 Spinner；`unauthenticated` 显「未登录」+ `Link/Button → /auth/signin`；`authenticated` 显项目列表。`useState<ProjectRecord[]>`、`useEffect` → `fetch('/api/projects')`（**直接 fetch，cookie 自动带，无 useAuthFetch**）→ `res.json()` → `data.success ? setProjects(data.data) : toast.error`。卡片网格 `projects.map(p => 卡片)`：状态徽章（p.status）+ 标题（p.title）+ 描述（p.description ?? ''，截断）+ 更新时间（p.updatedAt 格式化）。空状态内联（projects.length===0 → 「还没有项目，点击新建」）。裸 `<header>`：标题「我的项目」+ 新建 Button。新建弹窗（受控 open state + title Input + 提交 Button）：提交 → `fetch('/api/projects',{method:'POST',body:JSON.stringify({title})})` → 成功 toast + 关弹窗 + 重新 fetch 列表；失败 toast。用 P1 组件 Button/Input/Toast/Spinner。
- `callback-url.ts`：`sanitizeCallbackUrl` 3 处 `return "/"` → `return "/workspace"`（非字符串/不以 / 开头/以 // 开头 三处 fallback）。**注释也要更新**（说明默认登录后落 /workspace）。
- `callback-url.test.ts`：更新期望——无参/非字符串/`//`/完整 URL → `/workspace`；显式 `?callbackUrl=/` → `/`（同源仍允许）；显式 `?callbackUrl=/foo` → `/foo`。**I-1 open-redirect 回归**：`https://evil.com` / `//evil.com` / `/\evil.com` → `/workspace`（同源绝对路径，安全）。
- `signin/page.tsx`：注释更新（callbackUrl 默认 /workspace）。
**验收**：`pnpm --filter @dramaforge/web typecheck` + `pnpm --filter @dramaforge/web build` 绿；callback-url.test 全过；workspace 页登录态 fetch 列表+新建；未登录跳登录（reviewer 验结构；真数据交互 = 用户手动，本会话无 browser-harness）。

**P3 整体验收**：3 task 全 review-clean；typecheck（shared+server+web）+ web build + 全测试绿；登录后 `/workspace` 能看到/新建项目；callbackUrl 回 `/workspace`。真用户交互 + 视觉 = 用户手动（同 P2，本地桌面客户端 `SF_DEV_URL=http://localhost:3001` 或 curl）。whole-branch review（opus）过；ledger + WORKLOG 更新。CP1（=P0-P3）达成。

## 6. P4–P5（承自 P1/P2 plan，CP2）

- **P4 AI 视频生成**：薄片 UI 触发器 → `/api/generate/video` → clip URL。
- **P5 render-job 合片**：dispatch CONCAT → Electron render-worker → SSE → presign-GET → 显示成品。

**交付节奏**：CP1 = P0–P3（登录 + 项目列表可见），CP2 = P4–P5。

## 7. P3 DONE 定义

3 task 全 review-clean（implementer + task-reviewer 双 verdict）+ whole-branch review（opus）过；typecheck（shared/server/web）+ web build + 全测试绿；登录后 `/workspace` 能看到/新建项目；callbackUrl 回 `/workspace`（I-1 open-redirect 防护不退化）。真用户交互 + 视觉 = 用户手动验证项。ledger + WORKLOG 更新。**CP1 达成。**
