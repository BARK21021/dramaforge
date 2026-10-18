# Plan — dramaforge C/S 垂直薄片 P1：UI 脚手架

**日期**：2026-07-19　**分支**：`feat/cs-ui-slice`　**基线（本 plan 起点）**：`67fd08b`（P0 whole-branch review Approved 结束）
**前置**：P0 plan `2026-07-19-cs-ui-vertical-slice.md`（P0 基建 6 task 全 review-clean + whole-branch opus Approved "Safe to build P1 on top of"）

## 1. 背景与动机

P0 基建 done（响应信封 / 中间件 dev 放开 / MinIO 公网 URL / outputKey 契约 + dispatch 自动签 / presign-GET 路由 / nginx provision 留档）。P1 搭 UI 脚手架：把 app1 的设计系统（Tailwind v4 暗色主题 + 基础组件）移植进 dramaforge `packages/web`，让后续 P2-P5 有 UI 可写。

Recon（agent `a9b5d772`，2026-07-19，34 次工具调用）摸清了 app1 UI 资产与 dramaforge web gap。关键事实：
- **app1 在 `D:/app1/`**（机器无 F: 盘，用户口误说 F:）。
- app1 `globals.css` = 482 行 Tailwind v4 CSS-first 设计系统（`@import "tailwindcss"` + `@theme` 动画 token + `:root` 暗色变量 + `.light` 覆盖 + `@layer base/components/utilities` + `.biz-ui-scale`）。**无 `tailwind.config.*`**。
- `cn.ts` = 标准 `twMerge(clsx(...))`，21 行。
- `Button.tsx`（大写 B）依赖 `@radix-ui/react-slot`（`asChild`）+ `./Spinner` + `./cn`；variant/size 是 `Record<>` map，**非 CVA**。
- `Input.tsx` 一个文件含 `Input` + `Textarea` + `Label`（原生 `<label>`，**非 Radix**）+ `FormField`。
- `Spinner.tsx` 纯 CSS，依赖 `./cn`。
- `Toast.tsx` = ToastProvider + useToast + UI，**纯 React Context，零 Radix**；用 ✓✕i! 字符当图标。
- `AuthProvider.tsx` 包 next-auth `SessionProvider`（`refetchOnWindowFocus={false}`）。
- app1 `layout.tsx` 嵌套：`AuthProvider > ToastProvider > RechargeProvider > AppShell > children`。
- dramaforge web 现状：最小 layout.tsx（无 globals.css、无 providers）、`page.tsx` 健康桩、`download/page.tsx`（内联样式，独立）、**无 `components/` 目录**、`lib/` 仅服务端助手。
- ⚠️ **`lucide-react: ^1.21.0`** 写在 app1 package.json 但该版本公开 npm 不存在（lucide 公开主线是 0.x，如 0.460.0）。需对照 `D:/app1/node_modules/lucide-react/package.json` 核实才能 pin。
- ⚠️ `@radix-ui/react-label` app1 声明了但源码零引用；`@radix-ui/react-dialog` 仅 Modal/ZoomViewer 用——P1 都不移植，故这两个 dep **defer**。

## 2. 范围与排除

**做**：
1. PostCSS + Tailwind v4 配置（`postcss.config.mjs`，不加 config 文件）
2. 移植 app1 `globals.css`（482 行逐字）+ `cn.ts`
3. 移植 `Spinner` + `Button` + `Input`（含 Textarea/Label/FormField）
4. 移植 `Toast` + `AuthProvider`；root layout 挂 `AuthProvider > ToastProvider`
5. 最小冒烟页（Button + Input + Toast 交互，证明组件 + 主题 + context 通）

**不做（defer，不在 P1）**：
- `lucide-react`：P1 基础组件均不用图标（Toast 用字符、Spinner 纯 CSS）。defer 到移植真正用图标的组件时，先核实真实版本再 pin。
- `@radix-ui/react-dialog`（Modal/ZoomViewer 用）、`@radix-ui/react-label`（源码零引用）、`qrcode.react`（RechargeModal 用）。
- `AppShell`（布局 chrome）、`RechargeProvider`/`RechargeModal`、`components/ui/index.ts` barrel（re-export 了 P1 不移植的 Modal/ZoomViewer/ProgressBar 等多个组件，照抄会断引）——layout 不挂。
- 视觉像素对齐（与 app1 逐像素一致）：P1 只验「暗色主题渲染 + 交互通」，像素精度留 P2+ 用 browser-harness + vision 验。

## 3. Global Constraints（继承 P0 全部 GC-1..GC-8，本 P1 重申最相关）

- **GC-3（app1 只读）**：`D:/app1/` reference-only，**禁改其任何文件**。移植 = 读其源码后在 dramaforge 重写/复制。
- **GC-5（服务器稳定是命门）**：P1 全在 `packages/web` 前端层，不动 server/ai-worker，无 OOM 风险。
- **GC-6（边做边记）**：每 task 完追加 WORKLOG + 更新 `.superpowers/sdd/progress.md` ledger。
- **GC-7（不在 main 提交）**：`feat/cs-ui-slice` 分支，conventional commits（中文描述可）。

## 4. 关键决策（已定，不再开）

1. **Tailwind v4 CSS-first**：不加 `tailwind.config.*`，配置全在 globals.css 的 `@theme` + `@layer`。`postcss.config.mjs` 仅注册 `@tailwindcss/postcss`。
2. **依赖最小集**：仅加 `clsx` `tailwind-merge` `@radix-ui/react-slot`（dependencies）+ `tailwindcss` `@tailwindcss/postcss`（devDependencies）。其余 radix/lucide/qrcode 全 defer。
3. **组件间导入用相对路径**：app1 组件内部互引已全是相对（`./cn`、`./Spinner`），照抄即可。dramaforge 现有 tsconfig 有 `@web/*` alias；layout 引组件用相对或 `@web/`。**不新增 `@/*` alias**（YAGNI，P1 不需要；P2 移植 signin 页若需要再加）。
4. **Next 版本不动**：dramaforge web `next ^16.2.10` 保持，不降到 app1 的 15。Tailwind v4 + Radix Slot 版本无关；若 Next 16 下 Tailwind v4 有问题，dev/build 冒烟会暴露，到时再定。
5. **layout 嵌套**：`AuthProvider > ToastProvider > {children}`（砍掉 RechargeProvider + AppShell）。`<html lang="zh-CN">` **不加 class**（暗色由 `:root` 默认生效）。
6. **冒烟页**：改 `app/page.tsx` 为最小 `"use client"` 交互页（Button 点→toast.success + 受控 Input + Textarea + Label + FormField），证明组件挂载 + 暗色主题生效 + Toast context 通。

## 5. P1 Task

### Task 1 — 依赖 + PostCSS/Tailwind 配置
**文件**：`packages/web/package.json`（改）；`packages/web/postcss.config.mjs`（新增）
**改动**：
- `package.json` `dependencies` 加：`clsx ^2.1.1`、`tailwind-merge ^3.6.0`、`@radix-ui/react-slot ^1.3.0`
- `package.json` `devDependencies` 加：`tailwindcss ^4.3.1`、`@tailwindcss/postcss ^4.3.1`
- 新建 `postcss.config.mjs`，内容照 app1 `D:/app1/postcss.config.mjs`（仅 `{"@tailwindcss/postcss":{}}`）
- workspace root 跑 `pnpm install` 更新 lockfile
**验收**：`pnpm --filter @dramaforge/web typecheck` 绿；`postcss.config.mjs` 存在且内容正确；`pnpm install` 无报错（lockfile 更新）。

### Task 2 — globals.css + cn.ts
**文件**：`packages/web/app/globals.css`（新增）；`packages/web/components/ui/cn.ts`（新增）
**改动**：
- 把 app1 `D:/app1/src/app/globals.css`（482 行）**逐字**复制到 dramaforge（含 `@import "tailwindcss"`、`@theme` 动画 token、`:root` 暗色变量、`.light` 覆盖、全部 `@layer base/components/utilities` 类、`.biz-ui-scale`）
- 把 app1 `D:/app1/src/components/ui/cn.ts`（21 行）逐字复制
**验收**：typecheck 绿；两文件行数与 app1 一致（globals 482、cn 21）。

### Task 3 — Spinner + Button + Input 组件
**文件**：`packages/web/components/ui/Spinner.tsx`、`Button.tsx`、`Input.tsx`（均新增）
**改动**：
- 逐字复制 app1 `D:/app1/src/components/ui/Spinner.tsx`、`Button.tsx`（注意大写）、`Input.tsx`
- app1 组件内部互引为相对（`./cn`、`./Spinner`），照抄。**若发现任何 `@/...` 导入**（非预期），改成相对路径后在 report 里说明
- Button 依赖 `@radix-ui/react-slot`（Task 1 已装）+ `./Spinner` + `./cn`；Input 含 `Input` + `Textarea` + `Label` + `FormField` 四导出
**验收**：typecheck 绿；三文件逐字一致（diff 应只有路径差异，零逻辑改动）。

### Task 4 — Toast + AuthProvider + root layout + 冒烟页
**文件**：`packages/web/components/ui/Toast.tsx`（新增）；`packages/web/components/providers/AuthProvider.tsx`（新增）；`packages/web/app/layout.tsx`（改）；`packages/web/app/page.tsx`（改）
**改动**：
- `Toast.tsx`：逐字复制 app1（ToastProvider + useToast + UI，纯 React Context 无 Radix）
- `AuthProvider.tsx`：逐字复制 app1 `D:/app1/src/components/providers/AuthProvider.tsx`（包 next-auth `SessionProvider`，`refetchOnWindowFocus={false}`，`"use client"`）
- `layout.tsx`：加 `import "./globals.css"`；body 内嵌套 `AuthProvider > ToastProvider > {children}`；metadata 用 app1 的（title `"DramaForge AI 视频创作平台"`，description `"面向出海场景的 AI 视频创作与风格化生产平台"`）；`<html lang="zh-CN">` 不加 class
- `page.tsx`：改 `"use client"` 最小冒烟页——一个 `Button`（variant primary，点 → `toast.success("脚手架就绪")`）+ 一个受控 `Input`（placeholder）+ 一个 `Textarea` + 一个 `FormField`（含 `Label`）。用 `useState` 控 Input。目的：证组件挂载 + 暗色主题渲染 + Toast context 通
**验收**：typecheck 绿；`pnpm --filter @dramaforge/web build` 通过（globals.css 编译、组件解析、providers 挂载无报错）。

**P1 整体验收**：4 task 全 review-clean；typecheck + `next build` 全绿；冒烟页暗色主题渲染 + 点 Button 弹 Toast。视觉像素精度非 P1 gate。

## 6. P2–P5（后续 plan 详写，承自 P0 plan）

- **P2 登录**：移植 app1 `auth/signin/page.tsx`（凭证登录 password-only，`signIn("credentials",{login,password,redirect:false})`）+ login-identifier.ts；迁移用户实测登进。
- **P3 项目列表**：新写 `packages/server/src/domain/project/project-repo.ts`（照 render-job-repo 模板）+ barrel；新增 `web/app/api/projects/route.ts`（GET list by userId + POST create，新信封）；移植精简版 `workspace/page.tsx`。
- **P4 AI 视频生成**：薄片 UI 触发器，prompt → POST /api/generate/video → 拿 clip URL（同步）。
- **P5 render-job 合片**：UI 喂 `/api/render/dispatch {type:FILM_EXPORT, input:{clips:[{url}], outputKey}}` → Electron render-worker 拉 CONCAT job → ffmpeg 合片 → presigned PUT → SSE COMPLETED → UI 订阅 /api/sse → meta.outputKey → /api/storage/presign → 显示成品。

**交付节奏**：CP1 = P0–P3（登录 + 项目列表可见），CP2 = P4–P5（AI + 合片闭环）。

## 7. P1 DONE 定义

4 task 全 review-clean（implementer + task-reviewer 双 verdict）；typecheck + `next build` 全绿；冒烟页暗色主题渲染 + Toast 交互通；whole-branch review（opus）过；ledger + WORKLOG 更新。
