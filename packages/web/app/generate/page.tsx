"use client";

/**
 * @file generate/page.tsx
 * @description P4 Task 2 — AI 视频生成实验页（独立路由 /generate，非项目内）
 *
 * 用户流程：
 *   prompt Textarea → 生成 Button → POST /api/generate/video 拿 ARK 临时 URL →
 *   - 桌面客户端（window.sfShell.isElectron===true）：经 preload IPC 调 main
 *     下载到 userData/clips/<clipId>.mp4 → <video src="sf-asset://..."> 播本地
 *     （资产客户端本地约束：服务器不存任何视频字节，渲染进程绝不 file://）
 *   - 浏览器/dev：退化为 <video src=临时URL> 直接播 + 显式提示"仅当次播放，
 *     不保存到本地"（plan §4 决策 7，不阻断 dev）
 *
 * useSession 三态门（结构对齐 packages/web/app/workspace/page.tsx）：
 *   - loading         → 居中 Spinner
 *   - unauthenticated → 居中"未登录"+ Button asChild Link → /auth/signin
 *   - authenticated   → 表单
 *
 * 视觉对齐 app1 ProductionStage 生成表单段
 * （D:\app1\src\app\workspace\[projectId]\components\ProductionStage.tsx 的
 * list 视图头部 + 增强提示词 textarea + 一键出片 CTA + 成片结果卡 + 视频框）：
 *   - 容器 max-w-4xl mx-auto p-8
 *   - h2 text-xl font-bold font-display + text-sm text-3 副标题
 *   - info banner：bg-hover 圆角小条 + text-xs text-3
 *   - 主 CTA：闪电图标（lucide 内联 SVG）+ btn-primary + ⌘/Ctrl+Enter 提示
 *   - 视频框：mt-4 w-full aspect-video bg-black rounded-lg overflow-hidden +
 *     <video object-contain controls preload="metadata">
 *   - 成功结果卡：rounded-[var(--radius)] bg-card border-border-light +
 *     success-dim 圆图标 + 文案
 *   - loading 卡：action-dim 圆图标 + spinner + 文案
 *   不照搬 app1 的分镜/剧集/链式生成体系（defer 到 P5+）。
 *
 * 提交逻辑抽到 ./generate-flow.ts 的 runGenerate 纯函数；单测在
 * ./page.test.ts（node-env 契约测试，不渲染 React——仓库无 jsdom/
 * testing-library，所有 web 测试都是 node-env 风格）。
 *
 * @example 路由：/generate
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Button } from "../../components/ui/Button";
import { Textarea } from "../../components/ui/Input";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import {
  runGenerate,
  type GenerateOutcome,
  type SfShellBridgeLike,
} from "./generate-flow";

/**
 * 默认视频模型（与 app1 DEFAULT_VIDEO_MODEL_ID 一致：ark 豆包 Seedance 2.0 mini）。
 * 薄片只收 prompt，模型走默认；模型选择 UI defer（plan §2 排除项）。
 */
const DEFAULT_MODEL = "ark/doubao-seedance-2-0-mini-260615";

/**
 * 从 window 读 sfShell bridge。
 *
 * Electron 桌面客户端：preload 通过 contextBridge 注入 window.sfShell
 * （isElectron===true + downloadAsset 等）。浏览器/dev：window.sfShell 为
 * undefined，readSfShell() 返回 null，runGenerate 走 fallback 分支。
 *
 * SSR 安全：typeof window==='undefined' 时返回 null（next-auth session
 * 'loading' 态兜底，本函数在事件处理器里调用，理论不会 SSR 触发，但兜底无害）。
 */
function readSfShell(): SfShellBridgeLike | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { sfShell?: SfShellBridgeLike };
  return w.sfShell ?? null;
}

/** 错误 outcome → toast 文案（带 [code] 前缀，对齐 app1 api() 错误格式化）。 */
function formatError(o: Extract<GenerateOutcome, { kind: "error" }>): string {
  return o.code ? `[${o.code}] ${o.message}` : o.message;
}

/**
 * AI 视频生成实验页。
 *
 * 状态机：
 *   - prompt:     Textarea 受控值
 *   - loading:    生成中（Button 禁用 + 显示 Spinner + loading 卡）
 *   - outcome:    上次生成的结果（local / fallback / error）；下次 submit 前清空
 *
 * 提交后据 outcome.kind 做 UI 决策：
 *   - local    → toast.success + 渲染本地视频框
 *   - fallback → toast.info + 渲染临时 URL 视频框 + 浏览器提示
 *   - error    → toast.error；若 code==='UNAUTHORIZED' 跳 /auth/signin
 *               （session 中途过期；首次未登录由 useSession 渲染门拦在前面）
 */
export default function GeneratePage() {
  const toast = useToast();
  const router = useRouter();
  const { status } = useSession();

  const [prompt, setPrompt] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [outcome, setOutcome] = React.useState<GenerateOutcome | null>(null);

  async function handleSubmit() {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setOutcome(null);
    const result = await runGenerate({
      prompt: trimmed,
      model: DEFAULT_MODEL,
      sfShell: readSfShell(),
    });
    setOutcome(result);
    setLoading(false);

    if (result.kind === "error") {
      toast.error(formatError(result));
      // session 中途过期 → 跳登录（useSession 三态门拦的是首次进入未登录）
      if (result.code === "UNAUTHORIZED") router.push("/auth/signin");
    } else if (result.kind === "local") {
      toast.success("视频已生成并保存到本地");
    } else {
      toast.info("视频已生成（浏览器仅当次播放，桌面客户端才会保存到本地）");
    }
  }

  // -------- useSession 三态渲染（结构对齐 workspace/page.tsx） --------

  if (status === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <Spinner size={28} />
      </main>
    );
  }

  if (status === "unauthenticated") {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-sm text-[var(--text-3)]">未登录，请先登录后生成视频</p>
        <Button asChild variant="primary">
          <Link href="/auth/signin">去登录</Link>
        </Button>
      </main>
    );
  }

  // status === "authenticated"
  // 桌面客户端标志：用于在 info banner 里给用户正确的预期（落本地 vs 仅当次播放）
  const isElectron = readSfShell()?.isElectron === true;

  return (
    <main className="min-h-screen max-w-4xl mx-auto p-8 flex flex-col">
      {/* 头部（app1 风格：h2 text-xl font-display + text-3 副标题） */}
      <header className="flex items-center justify-between mb-6">
        <div>
          <h2
            className="text-xl font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            AI 视频生成
          </h2>
          <p className="text-sm text-[var(--text-3)] mt-1">
            输入提示词，生成一段短视频
          </p>
        </div>
      </header>

      {/* info banner（app1 风格：bg-hover 圆角小条 + text-xs text-3） */}
      <div className="mb-4 px-4 py-2 rounded-lg bg-[var(--bg-hover)] text-xs text-[var(--text-3)] flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>模型：{DEFAULT_MODEL}</span>
        <span>
          {isElectron
            ? "桌面客户端：生成后自动保存到本地硬盘"
            : "浏览器：仅当次播放，不会保存到本地"}
        </span>
      </div>

      {/* prompt Textarea（P1 组件，app1 增强 textarea 视觉：bg-2 + leading-6） */}
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={5}
        placeholder="例如：航拍城市夜景，灯光流动，暖色调，镜头平稳推进..."
        disabled={loading}
        onKeyDown={(e) => {
          // ⌘/Ctrl + Enter 快捷提交（app1 同款快捷键约定）
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !loading) {
            void handleSubmit();
          }
        }}
        className="leading-6"
      />

      {/* CTA 行（app1 风格：闪电图标 + btn-primary + 快捷键提示） */}
      <div className="flex items-center gap-3 mt-3">
        <Button
          variant="primary"
          size="md"
          loading={loading}
          disabled={!prompt.trim()}
          onClick={() => void handleSubmit()}
        >
          {!loading && (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          {loading ? "生成中..." : "生成视频"}
        </Button>
        <span className="text-[10px] text-[var(--text-3)]">
          ⌘/Ctrl + Enter 快捷生成
        </span>
      </div>

      {/* loading 卡（app1 一键出片进度卡同款：action-dim 圆图标 + spinner） */}
      {loading && (
        <div className="mt-6 p-4 rounded-[var(--radius)] bg-[var(--bg-card)] border border-[var(--border-light)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--action-dim)] flex items-center justify-center flex-shrink-0">
              <Spinner size={20} label="正在生成视频" className="text-[var(--action)]" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-bold text-[var(--text)]">
                正在生成视频...
              </div>
              <div className="text-xs text-[var(--text-3)] mt-0.5">
                视频生成通常需要 30-90 秒，请耐心等待
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 成功结果：Electron 路径（sf-asset:// 本地播放） */}
      {outcome?.kind === "local" && (
        <div className="mt-6 p-4 rounded-[var(--radius)] bg-[var(--bg-card)] border border-[var(--border-light)]">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-[var(--success-dim)] flex items-center justify-center flex-shrink-0">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  stroke="var(--success)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-base font-bold text-[var(--success)]">
                视频已生成并保存到本地
              </div>
              <div className="text-xs text-[var(--text-3)] mt-1 break-all">
                本地 clip：{outcome.key}
              </div>
            </div>
          </div>
          {/* app1 视频框：mt-4 w-full aspect-video bg-black rounded-lg overflow-hidden */}
          <div className="mt-4 w-full aspect-video bg-black rounded-lg overflow-hidden">
            <video
              src={outcome.protocolUrl}
              className="w-full h-full object-contain"
              controls
              preload="metadata"
            />
          </div>
        </div>
      )}

      {/* 成功结果：浏览器 fallback（直接播 ARK 临时 URL + 不落盘提示） */}
      {outcome?.kind === "fallback" && (
        <>
          <div className="mt-6 mb-4 px-4 py-2 rounded-lg bg-[var(--warning-dim)] text-[var(--warning)] text-xs flex items-start gap-2">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              className="flex-shrink-0 mt-0.5"
            >
              <path
                d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>
              浏览器环境仅当次播放，不会保存到本地；URL 约 1 小时内有效。下载桌面客户端后生成可自动保存到本地硬盘。
            </span>
          </div>
          <div className="w-full aspect-video bg-black rounded-lg overflow-hidden">
            <video
              src={outcome.url}
              className="w-full h-full object-contain"
              controls
              preload="metadata"
            />
          </div>
        </>
      )}
    </main>
  );
}
