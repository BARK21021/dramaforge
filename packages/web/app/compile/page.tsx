"use client";

/**
 * @file compile/page.tsx
 * @description P5 Task B — 视频合片实验页（独立路由 /compile，非项目内）
 *
 * 用户流程：
 *   clip URL 列表（一行一个，≥2 段）→ POST /api/render/dispatch(FILM_EXPORT)
 *   → SSE 与 render-job 状态轮询并行 → COMPLETED（result.outputUrl = sf-asset://）：
 *     - 桌面客户端（sfShell.isElectron===true）：<video src="sf-asset://..."> 播本地
 *       （资产客户端本地：成品存 userData/clips/<jobId>.mp4，服务器零媒体字节）
 *     - 浏览器/dev：成品仍在客户端本地完成，但浏览器无法解析 sf-asset:// →
 *       提示"打开桌面客户端查看"（合片本身不阻断，只是预览受限）
 *   FAILED → toast.error
 *
 * 数据流抽到 ./compile-flow.ts：dispatchCompile（派发）+ matchCompileEvent（事件
 * 归类）+ fetchCompileStatus（持久状态兜底）；page.tsx 负责订阅/轮询 + UI 胶水。单测打纯函数
 * （node-env 契约测试，对齐仓库所有 web 测试风格，无 jsdom/testing-library）。
 *
 * useSession 三态门（结构对齐 /generate + workspace/page.tsx）。
 * 视觉对齐 /generate（已对齐 app1）：max-w-4xl 容器 + h2 font-display + info
 * banner + Textarea + btn-primary + loading 卡 + 结果卡 + 视频框。
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
  dispatchCompile,
  fetchCompileStatus,
  matchCompileEvent,
  type CompileMatch,
  type CompileSseEvent,
  type DispatchOutcome,
} from "./compile-flow";

/** SSE 等待超时（ms）：render-worker 5s 轮询 + ffmpeg concat，给足余量。 */
const COMPILE_TIMEOUT_MS = 300_000;

/** 持久状态轮询间隔；与 SSE 并行，兜底 Redis pub/sub 丢事件。 */
const COMPILE_POLL_INTERVAL_MS = 2_000;

/** SSR 安全读桌面客户端标志（preload 注入 window.sfShell.isElectron）。 */
function readIsElectron(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (window as Window & { sfShell?: { isElectron?: true } }).sfShell?.isElectron ===
    true
  );
}

/** 解析 Textarea（一行一个 URL）→ clip URL 数组（去空行/首尾空白）。 */
function parseClipUrls(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 校验 clip URL 是 http(s)（客户端 fetch 才能下载；防 typo 把垃圾 URL 送进 ffmpeg）。 */
function isValidClipUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function formatDispatchError(o: Extract<DispatchOutcome, { ok: false }>): string {
  return o.code ? `[${o.code}] ${o.message}` : o.message;
}

export default function CompilePage() {
  const toast = useToast();
  const router = useRouter();
  const { status } = useSession();

  const [clipText, setClipText] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [filmUrl, setFilmUrl] = React.useState<string | null>(null);

  // 持有当前 SSE 订阅 + 超时/轮询定时器，便于清理（终态/重新提交/卸载）。
  const esRef = React.useRef<EventSource | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const runRef = React.useRef(0);

  function cleanup(): void {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }

  React.useEffect(() => {
    // 卸载时让在途 fetch 结果失效，并关闭 SSE / 清理全部定时器。
    return () => {
      runRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (esRef.current) esRef.current.close();
    };
  }, []);

  async function handleSubmit(): Promise<void> {
    const clips = parseClipUrls(clipText);
    if (clips.length < 2 || loading) return;
    if (!clips.every(isValidClipUrl)) {
      toast.error("每个视频 URL 必须是 http(s) 链接");
      return;
    }

    cleanup();
    const runId = ++runRef.current;
    let settled = false;
    setLoading(true);
    setFilmUrl(null);

    // SSE 与 polling 共用唯一终态出口，避免二者同时看到终态时重复 toast/state。
    const finish = (result: CompileMatch): void => {
      if (settled || runRef.current !== runId) return;
      settled = true;
      cleanup();
      setLoading(false);
      if (result.kind === "done") {
        setFilmUrl(result.filmUrl);
        toast.success("合片完成");
      } else {
        toast.error(result.message);
      }
    };

    // 先订阅 SSE 再派发：避免 render-worker 在"派发返回 ↔ EventSource 连上"窗口
    // 内跑完工并发出 COMPLETED 被丢（P5 whole-branch review I2）。taskId 在派发
    // 返回前未知，期间到达的帧（connected 握手）用 null 检查忽略。
    let taskId: string | null = null;
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/sse");
    } catch {
      // EventSource 不可用时仍继续派发；持久状态 polling 会接管。
    }
    if (es) {
      esRef.current = es;
      es.onmessage = (msg: MessageEvent) => {
        if (taskId === null) return; // 派发前的帧（connected 等）忽略
        let event: CompileSseEvent;
        try {
          event = JSON.parse(msg.data) as CompileSseEvent;
        } catch {
          return; // 非 JSON 帧忽略（心跳注释帧 EventSource 不投递到 onmessage）
        }
        const result = matchCompileEvent(event, taskId);
        if (result !== null) finish(result);
      };
      es.onerror = () => {
        // SSE 只是低延迟通道；断开时静默降级到持久状态 polling。
        es?.close();
        if (esRef.current === es) esRef.current = null;
      };
    }
    timerRef.current = setTimeout(() => {
      if (settled || runRef.current !== runId) return;
      settled = true;
      cleanup();
      setLoading(false);
      toast.error("合片超时，请稍后重试");
    }, COMPILE_TIMEOUT_MS);

    // SSE 已就绪，现在派发。
    const dispatch = await dispatchCompile({ clips });
    if (settled || runRef.current !== runId) return;
    if (!dispatch.ok) {
      settled = true;
      cleanup();
      setLoading(false);
      toast.error(formatDispatchError(dispatch));
      // session 中途过期 → 跳登录（useSession 门拦的是首次未登录）。
      if (dispatch.code === "UNAUTHORIZED") router.push("/auth/signin");
      return;
    }
    taskId = dispatch.taskId;

    // 立即查一次，随后使用 await 后再 setTimeout 的递归轮询。任何时刻最多只有
    // 一个状态请求在途；SSE/超时/卸载终结后，在途结果也会被 runId/settled 丢弃。
    let pollInFlight = false;
    const pollStatus = async (): Promise<void> => {
      if (settled || runRef.current !== runId || pollInFlight) return;
      pollInFlight = true;
      const result = await fetchCompileStatus({ renderJobId: dispatch.renderJobId });
      pollInFlight = false;
      if (settled || runRef.current !== runId) return;
      if (result !== null) {
        finish(result);
        return;
      }
      pollTimerRef.current = setTimeout(() => {
        pollTimerRef.current = null;
        void pollStatus();
      }, COMPILE_POLL_INTERVAL_MS);
    };
    void pollStatus();
  }

  // -------- useSession 三态渲染（对齐 /generate + workspace） --------

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
        <p className="text-sm text-[var(--text-3)]">未登录，请先登录后合片</p>
        <Button asChild variant="primary">
          <Link href="/auth/signin">去登录</Link>
        </Button>
      </main>
    );
  }

  const isElectron = readIsElectron();
  const clipCount = parseClipUrls(clipText).length;

  return (
    <main className="min-h-screen max-w-4xl mx-auto p-8 flex flex-col">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h2
            className="text-xl font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            视频合片
          </h2>
          <p className="text-sm text-[var(--text-3)] mt-1">
            把多段视频拼接成一个成片
          </p>
        </div>
      </header>

      <div className="mb-4 px-4 py-2 rounded-lg bg-[var(--bg-hover)] text-xs text-[var(--text-3)] flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>
          {isElectron
            ? "桌面客户端：合片后成品自动保存到本地硬盘"
            : "浏览器：合片在桌面客户端完成并保存本地"}
        </span>
        <span>至少 2 段视频</span>
      </div>

      <Textarea
        value={clipText}
        onChange={(e) => setClipText(e.target.value)}
        rows={6}
        placeholder={
          "每行一个视频 URL，例如：\nhttps://example.com/clip-1.mp4\nhttps://example.com/clip-2.mp4"
        }
        disabled={loading}
        className="leading-6"
      />

      <div className="flex items-center gap-3 mt-3">
        <Button
          variant="primary"
          size="md"
          loading={loading}
          disabled={clipCount < 2}
          onClick={() => void handleSubmit()}
        >
          {loading ? "合片中..." : "开始合片"}
        </Button>
        <span className="text-[10px] text-[var(--text-3)]">
          {clipCount > 0 ? `${clipCount} 段` : ""}
        </span>
      </div>

      {loading && (
        <div className="mt-6 p-4 rounded-[var(--radius)] bg-[var(--bg-card)] border border-[var(--border-light)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--action-dim)] flex items-center justify-center flex-shrink-0">
              <Spinner size={20} label="正在合片" className="text-[var(--action)]" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-bold text-[var(--text)]">
                正在合片...
              </div>
              <div className="text-xs text-[var(--text-3)] mt-0.5">
                客户端本地 ffmpeg 拼接中，通常几十秒
              </div>
            </div>
          </div>
        </div>
      )}

      {filmUrl && isElectron && (
        <div className="mt-6 p-4 rounded-[var(--radius)] bg-[var(--bg-card)] border border-[var(--border-light)]">
          <div className="text-base font-bold text-[var(--success)] mb-3">
            合片完成，已保存到本地
          </div>
          <div className="w-full aspect-video bg-black rounded-lg overflow-hidden">
            <video
              src={filmUrl}
              className="w-full h-full object-contain"
              controls
              preload="metadata"
            />
          </div>
        </div>
      )}

      {filmUrl && !isElectron && (
        <div className="mt-6 p-4 rounded-[var(--radius)] bg-[var(--bg-card)] border border-[var(--border-light)]">
          <div className="text-sm text-[var(--text-3)]">
            合片完成（成品已存于本地）。当前是浏览器环境，无法直接预览本地成品——请打开桌面客户端查看。
          </div>
        </div>
      )}
    </main>
  );
}
