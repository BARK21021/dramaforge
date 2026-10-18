# Plan — dramaforge C/S 垂直薄片 P2：登录

**日期**：2026-07-19　**分支**：`feat/cs-ui-slice`　**基线（本 plan 起点）**：`70a2f7b`（P1 UI 脚手架 done）
**前置**：P1 plan `2026-07-19-cs-ui-vertical-slice-p1.md`（whole-branch opus Approved）

## 1. 背景与动机

P1 UI 脚手架 done（Tailwind v4 设计系统 + 基础组件 + providers + 冒烟页）。P2 = 移植 app1 登录页，让用户能登进 dramaforge。

Recon（agent `a5ab949b`，51 tool calls）关键发现：**dramaforge 的 NextAuth 后端已经完整接线**——
- `packages/server/src/infra/auth.ts` 有完整 `CredentialsProvider`：`authorize()` 做 `login.trim()` → 内联 `normalizePhone` → 单条 SQL（`email=$1 OR phone=$1 OR phone=$2`）→ `bcryptjs.compare` → 成功返 `{id,email,name,role,stamp}` + 写 `activeSessionStamp`；JWT/session 回调已暴露 `userId`/`role`；`pages.signIn='/auth/signin'` 指向 P2 要建的页。
- users 表（`migrations/0001-init.sql`）有 `passwordHash`/`phone`/`activeSessionStamp`；`bcryptjs ^2.4.3` 已是 server dep。
- `scripts/app1-data.sql` 有 4 个迁移用户带 bcrypt `$2b$10$` hash（3 phone-only + 1 admin email）。
- `packages/web/lib/auth.ts` 的 `requireUser()`/`AuthError`、`/api/auth/[...nextauth]/route.ts` 挂载、`AuthProvider`(SessionProvider) 都就位（P1 + P0）。
- 后端登录链续6 本地 docker 实战已验证（seed 用户→NextAuth credentials→session 返回）。

**结论：P2 是纯前端移植，server 零改动。** 只需建登录页 + 让登录成功可观察。

## 2. 范围与排除

**做**：
1. 移植 app1 `auth/signin/login-identifier.ts`（逐字）+ `auth/signin/page.tsx`（移植 + 适配）。
2. 冒烟页加 `useSession` 显示 + 登出，让登录成功可观察（登录→看到 session→登出→回登录页）。
3. 移植 login-identifier 单测。

**不做（defer）**：
- **server 改动**：auth.ts 已完整，零改。
- **`/workspace` 页**：P3 建。P2 callbackUrl 默认落到 `/`（冒烟页）。
- **注册 / 找回密码**：app1 有 `/auth/signup` 等，非薄片核心，defer。
- **`lucide-react` dep**：app1 写 `^1.21.0` 但公开 npm 不存在（lucide 主线 0.x）。signin 只用 `Eye`/`EyeOff` 两图标 → **inline SVG 代替**，与 P1 零-lucide 一致，避免版本 pin 问题。需要多图标的后续 phase 再定 lucide 真版本。
- **视觉像素对齐**：build 绿 + 结构正确为 gate，像素级留用户手动（同 P1）。

## 3. Global Constraints（继承 GC-1..GC-8）

- **GC-3（app1 只读）**：`D:/app1/` reference-only，移植 = 读后重写。
- **GC-1（AI key 隔离）**：n/a 于登录，但登录页不得含任何敏感常量。
- **GC-6（边做边记）**：每 task 追加 WORKLOG + ledger。
- **GC-7（不在 main 提交）**：`feat/cs-ui-slice` 分支。

## 4. 关键决策（已定）

1. **server 零改**：auth.ts 已是 app1 完整移植（recon 确认非 stub）。
2. **lucide Eye/EyeOff → inline SVG**：page 内联等价眼睛图标（show/hide 由 state 驱动）。defer lucide-react dep。
3. **callbackUrl 默认 `/workspace` → `/`**：workspace 是 P3 还没有；登录后落到冒烟页，Task 2 让冒烟页显示 session 自证。
4. **冒烟页加 session 显示 + 登出**：用 `useSession()`（next-auth/react，SessionProvider 已在 root layout 挂）；已登录显「已登录：{email} ({role})」+ 登出按钮（`signOut()`）；未登录显「未登录」+ 跳登录页。
5. **login-identifier 测试 scoped 到 util**：dynamic import 避免 page 拉 `next-auth/react` 的 `signIn` 触发 mock 缺失（app1 的测试就这么写的）。
6. **导入用相对路径**（匹配 P1 layout.tsx 模式，dramaforge 无 `@/` alias）；`<Suspense>` 包 `useSearchParams`（Next 16 静态预渲染强制）。
7. **Electron SameSite cookie**：recon 确认第一方（Electron 直 `loadURL('https://your-domain.example.com')`，渲染页 origin = your-domain.example.com）→ NextAuth cookie 同源粘住，**无代码改**。cutover 时验 `NEXTAUTH_URL=https://...`（已知 runtime 要求，env.ts Zod 已强制）。

## 5. P2 Task

### Task 1 — signin 页 + login-identifier + 单测
**文件**：`packages/web/app/auth/signin/page.tsx`（新增）；`packages/web/app/auth/signin/login-identifier.ts`（新增）；`packages/web/app/auth/signin/login-identifier.test.ts`（新增）
**改动**：
- `login-identifier.ts`：**逐字**复制 app1 `D:/app1/src/app/auth/signin/login-identifier.ts`（7 行：PHONE/EMAIL regex + `isValidLoginIdentifier`）。
- `page.tsx`：移植 app1 `D:/app1/src/app/auth/signin/page.tsx`（224 行），做以下适配（**这些是有意偏离 app1，须在 report 注明**）：
  - 导入 `@/components/ui/Button`/`Input`/`Toast` → 相对 `../../../components/ui/Button` 等（dramaforge 无 `@/` alias）
  - `lucide-react` 的 `Eye`/`EyeOff` → **page 内联等价 SVG**（写一个 `EyeIcon`/`EyeOffOff` 小组件或内联 jsx，show/hide 由 password 可见 state 驱动；视觉等价 lucide eye）
  - `callbackUrl = searchParams?.get("callbackUrl") || "/workspace"` → 默认改 `"/"`
  - 其余**逐字保留**：`signIn("credentials",{login:login.trim(),password,redirect:false})` 调用、`result.error/ok` 处理 + toast、`searchParams.get("error")` mount 检测、`React.Suspense` 包裹、`canSubmit` 校验、`password.length>=6`、phone/email 输入提示
- `login-identifier.test.ts`：移植 app1 测试（测 `isValidLoginIdentifier` 接受合法 email/phone、拒绝非法），用 dynamic import scoped 到 util（避免 page 拉 `next-auth/react`）。
**验收**：typecheck 绿；`login-identifier.test.ts` 过；`pnpm --filter @dramaforge/web build` 绿（page 编译，含 Suspense + useSearchParams）；3 个有意偏离（导入路径 / inline SVG / callbackUrl）在 report 列清。

### Task 2 — 冒烟页 session 显示 + 登出（让登录可证）
**文件**：`packages/web/app/page.tsx`（改）
**改动**：
- 加 `useSession()`（`next-auth/react`）+ `signOut`。SessionProvider 已在 root layout（P1）。
- **已登录态**：显「已登录：{session.user.email || session.user.name} ({session.user.role})」+ 登出 Button（`signOut({callbackUrl:'/auth/signin'})`）。
- **未登录态**：显「未登录」+ 跳登录页（`Link href="/auth/signin"` 或 `Button` onClick `router.push`）。
- 保留 P1 冒烟内容（Button→toast / 受控 Input / Textarea / FormField）。
**验收**：typecheck + build 绿；两态（已登录/未登录）渲染结构正确（reviewer 验；真登录 = 用户手动，backend 续6 已证）。

**P2 整体验收**：2 task 全 review-clean；typecheck + build + login-identifier 测试全绿；登录链路结构正确（signin 页 → signIn → callbackUrl `/` → 冒烟页 session 显示）。真用户登录 = 用户手动验证项（醒后用迁移账号密码试）。

## 6. P3–P5（承自 P1 plan）

- **P3 项目列表**：建 `project-repo.ts`（server）+ `/api/projects`（新信封）+ 精简 `workspace/page.tsx`（卡片网格）；callbackUrl 回 `/workspace`。
- **P4 AI 视频生成**：薄片 UI 触发器 → `/api/generate/video` → clip URL。
- **P5 render-job 合片**：dispatch CONCAT → 客户端 ffmpeg → SSE → presign-GET → 显示成品。

**交付节奏**：CP1 = P0–P3（登录 + 项目列表可见），CP2 = P4–P5。

## 7. P2 DONE 定义

2 task 全 review-clean + whole-branch review（opus）过；typecheck + build + login-identifier 测试全绿；登录链路结构可证（page→signIn→session 显示）。真用户登录 + 视觉像素 = 用户手动验证项。ledger + WORKLOG 更新。
