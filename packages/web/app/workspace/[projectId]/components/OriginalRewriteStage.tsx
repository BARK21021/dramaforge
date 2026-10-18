"use client";

/**
 * @file OriginalRewriteStage.tsx
 * @description 剧本原创 · 整剧重写阶段（ORIGINAL 项目 3GB 长视频 → 全剧重写）
 *
 * 视觉与交互 1:1 镜像 app1 `F:\app1\src\app\workspace\[projectId]\components\OriginalRewriteStage.tsx`
 * （行数对齐：app1 207 行；本文件多出的部分是 dramaforge C/S 架构适配注释 + IPC bridge 桥接层）。
 *
 * dramaforge X3 链路对接（与 app1 的核心差异 — dramaforge-assets-client-local 铁律）：
 *
 *   app1：浏览器 <input type=file> → 8MB 分片 PUT 字节到服务器 tmpdir → 拼接 → createTask。
 *         字节进服务器，3GB 全程占用浏览器+服务器带宽与磁盘。
 *
 *   dramaforge：视频字节 **从不离开客户端本地硬盘**（userData/original-uploads/）。
 *         - Electron 桌面客户端：用户选择视频 → preload IPC（X3.7）将字节落到本地
 *           userData/original-uploads/，返回 videoUrl（sf-asset:// 或绝对路径）+
 *           totalBytes + totalDurationSec（main 进程本地 ffprobe）。
 *         - renderer 拿到这三个元数据后，POST 单次元数据到
 *           `/api/projects/[id]/original-video-upload`（**绝不上传字节**）。
 *         - 服务器只持 key + DB 元数据 + render_job 状态；client render-worker 后续
 *           按 videoUrl 从本地切片（ffmpeg.splitVideoEvenly）+ 逐段 POST 字节到
 *           cloud /api/generate/text（Kimi 视频理解 + DeepSeek 重写），orchestrator
 *           见 packages/client/src/orchestrators/long-video-rewrite.ts。
 *
 * 因此本组件的「上传」语义改写为：
 *   1. Electron：调 sfShell.stageOriginalVideo(file) → 拿到本地 videoUrl + 元数据
 *      → POST 元数据派发任务（无分片、无字节）。
 *   2. 浏览器/dev（sfShell 缺失）：toast 错误 "整剧重写需在桌面客户端中操作"，
 *      保留 <input type=file> 仅作视觉/UX 一致性（plan 卡片可显示），按钮不可真派发。
 *
 * 进度对接（X3.6a）：
 *   - client render-worker 按 stage 回写 project.longVideoProgress JSONB 经
 *     PUT /api/projects/[id]/long-video-rewrite/progress（splitting/transcribing/
 *     outlining/scripting/completed/failed，0-100）。
 *   - 本组件 3s 轮询 GET /api/projects/[id]/long-video-rewrite/progress 驱动
 *     GenerationProgress 视觉 + 完成/失败自动 onRefresh({force:true})。
 *   - GenerationProgress 组件（@/components/features/GenerationProgress）由并行
 *     工作流新建；此处按 app1 原始 prop 签名调用，import 暂缺属预期。
 *
 * GC 对齐：
 *   - GC-1（BYOK 禁）：派发端点内置默认 kimi/deepseek 模型，UI 不收 key ✓
 *   - GC-3（app1 只读）：未改 app1，仅迁移 ✓
 *   - dramaforge-frontend-align-app1：视觉 1:1 镜像 app1 ✓
 *   - dramaforge-assets-client-local：本组件零字节上传，只发元数据 + IPC 暂存 ✓
 */

import * as React from "react";
import { Button } from "../../../../components/ui/Button";
import { ProgressBar } from "../../../../components/ui/ProgressBar";
import { useToast } from "../../../../components/ui/Toast";
// 并行新建（X3 UI 工作流）；import 暂缺属预期，参见文件头注释。
import { GenerationProgress } from "../../../../components/features/GenerationProgress";
import {
  calculateKimiSegmentPlan,
  type ProjectRecord,
  type LongVideoProgress,
} from "@dramaforge/shared";

// ============================================================
// 常量（对齐 app1 + dramaforge original-video-upload route）
// ============================================================

const MAX_BYTES = 3 * 1024 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".mp4", ".webm", ".mov", ".mkv"];

/** 进度轮询间隔（ms）；与 render-worker 写入节奏匹配，留足 Redis pub/sub 抖动余量。 */
const PROGRESS_POLL_INTERVAL_MS = 3_000;
/** 连续轮询失败上限（×3s ≈ 30s 无进度回执）：超过则判定任务异常/会话失效，停止轮询并提示（R4）。 */
const PROGRESS_POLL_MAX_FAILURES = 10;

/** 完成阶段（停止轮询 + 触发 onRefresh 刷新产物区）。 */
const TERMINAL_STAGES = new Set(["completed", "failed"]);

// ============================================================
// sfShell IPC bridge —— X3.7 preload（client/main/preload.ts 并行新建）
// ============================================================

/**
 * sfShell.stageOriginalVideo 的返回结果（最小子集）。
 *
 * 与 client/main/asset-store.ts 的 DownloadAssetResult 同构（discriminated union，
 * 绝不 reject）。结构在 client 侧定义；此处复制而非 import 以避免把 electron
 * 拖进 web bundle（对齐 generate-flow.ts:SfShellBridgeLike 模式）。
 */
export interface OriginalVideoStageResult {
  outcome: "staged" | "cancelled";
  /** 本地路径（userData/original-uploads/<id>.<ext>）或 sf-asset:// 协议 URL。 */
  videoUrl?: string;
  totalBytes?: number;
  totalDurationSec?: number;
  filename?: string;
  error?: { code: string; message: string };
}

/**
 * 渲染进程从 window.sfShell 读到的 IPC bridge 子集（仅本组件用到的字段）。
 *
 * 完整 sfShell 形状见 packages/client/main/preload.ts；浏览器/dev 下 window.sfShell
 * 为 undefined，readSfShell() 返回 null。
 */
export interface SfShellOriginalVideoBridge {
  isElectron?: true;
  /** X3.7 preload IPC — 选择并将 3GB 原视频落到客户端本地 userData/original-uploads/。 */
  stageOriginalVideo?: (input: {
    file: File;
    filename: string;
  }) => Promise<OriginalVideoStageResult>;
}

/** SSR 安全读 window.sfShell。 */
function readSfShell(): SfShellOriginalVideoBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { sfShell?: SfShellOriginalVideoBridge };
  return w.sfShell ?? null;
}

// ============================================================
// 类型与 narrow helpers（scriptData/longVideoProgress 在 ProjectRecord 是 unknown）
// ============================================================

interface Props {
  project: ProjectRecord;
  onRefresh?: (options?: { force?: boolean }) => void;
}

/** 读 scriptData.sourceMode；dramaforge ORIGINAL 默认 VIDEO_REWRITE（无 LOCAL_SCRIPT）。 */
function readSourceMode(
  scriptData: unknown,
): "VIDEO_REWRITE" | "LOCAL_SCRIPT" | "OUTLINE_TO_SCRIPT" {
  if (scriptData && typeof scriptData === "object" && "sourceMode" in scriptData) {
    const v = (scriptData as { sourceMode?: unknown }).sourceMode;
    if (v === "LOCAL_SCRIPT") return "LOCAL_SCRIPT";
    if (v === "OUTLINE_TO_SCRIPT") return "OUTLINE_TO_SCRIPT";
  }
  return "VIDEO_REWRITE";
}

/** 读 project.longVideoProgress（LongVideoProgress | null）。 */
function readLongVideoProgress(raw: unknown): LongVideoProgress | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.stage !== "string") return null;
  return obj as unknown as LongVideoProgress;
}

/** 读 scriptData.longVideoRewrite.{sourceScript,outline,rewrittenScript}（产物区）。 */
function readLongVideoRewrite(scriptData: unknown): {
  sourceScript?: string;
  outline?: string;
  rewrittenScript?: string;
  targetEpisodeCount?: number;
  sourceVideoUrl?: string;
  sourceFilename?: string;
  sourceFileSizeBytes?: number;
  segmentPlan?: { totalDurationSec?: number };
} | null {
  if (!scriptData || typeof scriptData !== "object" || Array.isArray(scriptData)) return null;
  const obj = scriptData as Record<string, unknown>;
  const rewrite = obj.longVideoRewrite;
  if (!rewrite || typeof rewrite !== "object" || Array.isArray(rewrite)) return null;
  return rewrite as {
    sourceScript?: string;
    outline?: string;
    rewrittenScript?: string;
    targetEpisodeCount?: number;
    sourceVideoUrl?: string;
    sourceFilename?: string;
    sourceFileSizeBytes?: number;
    segmentPlan?: { totalDurationSec?: number };
  };
}

// ============================================================
// 工具函数（视觉 1:1 对齐 app1）
// ============================================================

/** 浏览器侧读取视频时长（用于 plan 卡片预览；Electron 真链路走 IPC ffprobe）。 */
function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = video.duration;
      URL.revokeObjectURL(url);
      Number.isFinite(duration) && duration > 0
        ? resolve(duration)
        : reject(new Error("无法读取视频时长"));
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("视频文件无效或浏览器不支持该格式"));
    };
    video.src = url;
  });
}

/** 统一 apiSuccess/apiFail envelope 读取；对齐 app1。 */
async function readJson(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.success)
    throw new Error(payload?.error || `请求失败 (${response.status})`);
  return payload.data;
}

// ============================================================
// OriginalRewriteStage 组件
// ============================================================

export function OriginalRewriteStage({ project, onRefresh }: Props) {
  const toast = useToast();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [duration, setDuration] = React.useState(0);
  const [dispatching, setDispatching] = React.useState(false);
  const [dispatchProgress, setDispatchProgress] = React.useState(0);
  const [taskId, setTaskId] = React.useState<string | null>(() => {
    const p = readLongVideoProgress(project.longVideoProgress);
    if (!p || TERMINAL_STAGES.has(String(p.stage))) return null;
    return p.taskId ?? null;
  });
  const rewrite = readLongVideoRewrite(project.scriptData);
  const sourceMode = readSourceMode(project.scriptData);
  const [scriptDraft, setScriptDraft] = React.useState(String(project.novelText || ""));
  const [savingScript, setSavingScript] = React.useState(false);
  const [regenerateFromEpisode, setRegenerateFromEpisode] = React.useState(0);
  const [reuseTargetStageDraft, setReuseTargetStageDraft] = React.useState(false);
  // OUTLINE_TO_SCRIPT 分支：大纲输入 + 集数 + 生成状态。
  const [outlineDraft, setOutlineDraft] = React.useState(String(project.novelText || ""));
  const [generatingOutline, setGeneratingOutline] = React.useState(false);
  const [targetEpisodeCount, setTargetEpisodeCount] = React.useState(10);
  const outlineDocxInputRef = React.useRef<HTMLInputElement>(null);
  const [importingOutlineDocx, setImportingOutlineDocx] = React.useState(false);
  const plan = duration > 0 && file ? calculateKimiSegmentPlan(duration, file.size) : null;
  const canReusePreviousSource = Boolean(
    rewrite?.sourceVideoUrl
    && rewrite.sourceFileSizeBytes
    && rewrite.segmentPlan?.totalDurationSec,
  );

  // 任务 ID 恢复：project 刷新后若 longVideoProgress 仍在进行中，回填 taskId。
  React.useEffect(() => {
    const progress = readLongVideoProgress(project.longVideoProgress);
    if (progress?.taskId && !TERMINAL_STAGES.has(String(progress.stage))) {
      setTaskId(String(progress.taskId));
    }
  }, [project.longVideoProgress]);

  // 进度轮询（X3.6a）：taskId 存在时每 3s GET progress route，命中终态自动刷新父级。
  React.useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    let consecutiveFailures = 0;
    const tick = async () => {
      try {
        const data = await readJson(
          await fetch(`/api/projects/${project.id}/long-video-rewrite/progress`, {
            credentials: "include",
          }),
        );
        if (cancelled) return;
        consecutiveFailures = 0;
        const progress = data?.progress as LongVideoProgress | null | undefined;
        if (progress && TERMINAL_STAGES.has(String(progress.stage))) {
          setTaskId(null);
          onRefresh?.({ force: true });
        }
      } catch {
        // 单次失败容忍；但连续 N 次（≈30s 无进度回执）仍失败 → 多半任务异常或会话
        // 失效，停止轮询并提示，避免进度条永久卡死（R4）。
        consecutiveFailures += 1;
        if (cancelled) return;
        if (consecutiveFailures >= PROGRESS_POLL_MAX_FAILURES) {
          toast.error("整剧重写进度持续更新失败，已停止轮询。请刷新页面查看最新状态。");
          setTaskId(null);
        }
      }
    };
    void tick();
    const timer = window.setInterval(tick, PROGRESS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [taskId, project.id, onRefresh, toast]);

  const chooseFile = async (next: File | null) => {
    if (!next) return;
    const ext = next.name.slice(next.name.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) return toast.error("仅支持 MP4/WebM/MOV/MKV 视频");
    if (next.size > MAX_BYTES) return toast.error("视频不能超过 3GB");
    // 先落文件，时长尽力而为：浏览器 <video> 解不了的封装（MKV/HEVC 等）读不到时长，
    // 但 main 进程 ffmpeg 在暂存阶段能探到真实时长（ffmpeg 解码范围远大于浏览器）。
    // 故不再因"浏览器读不到时长"就拒绝选文件——否则 MKV 源视频根本进不了流程。
    setFile(next);
    try {
      setDuration(await readVideoDuration(next));
    } catch {
      setDuration(0);
    }
  };

  /**
   * 派发整剧重写任务（dramaforge 适配核心 — 字节不上服务器）。
   *
   * Electron：sfShell.stageOriginalVideo(file) 将字节落到客户端本地，返回本地 videoUrl
   *   + totalBytes + totalDurationSec → POST 元数据派发。
   * 浏览器/dev：sfShell 缺失 → toast 错误并中止（无字节上传 fallback）。
   */
  const start = async () => {
    // plan 仅为预览（片段/积分卡片），不再是派发硬前提——MKV/HEVC 浏览器读不到时长时
    // plan=null，但 main 进程 ffmpeg 暂存时能探到真实时长，故放行（R2 修静默 return）。
    if (!file && !canReusePreviousSource) return;
    const sf = readSfShell();
    if (!sf?.isElectron || typeof sf.stageOriginalVideo !== "function") {
      toast.error("整剧重写需在桌面客户端中操作（视频字节不上服务器）");
      return;
    }
    setDispatching(true);
    setDispatchProgress(10);
    try {
      // 1. 客户端本地暂存字节（X3.7 preload IPC，流式 copy 不进内存），拿到 render-worker
      //    可解析的 videoUrl + main 进程 ffmpeg 探测的真实时长。
      const staged = file
        ? await sf.stageOriginalVideo({ file, filename: file.name })
        : {
            outcome: "staged" as const,
            videoUrl: rewrite?.sourceVideoUrl,
            filename: rewrite?.sourceFilename,
            totalBytes: rewrite?.sourceFileSizeBytes,
            totalDurationSec: rewrite?.segmentPlan?.totalDurationSec,
          };
      if (staged.outcome !== "staged" || !staged.videoUrl) {
        // 暴露 IPC 真实错误（READ_ERROR / SIZE_LIMIT_EXCEEDED / INVALID_INPUT 等），
        // 不再吞成通用"本地暂存视频失败"（R2）。
        throw new Error(staged.error?.message ?? "本地暂存视频失败");
      }
      // 服务器 original-video-upload route 要求 totalDurationSec > 0（Zod positive）。
      // 浏览器读不到时长时依赖 main 进程 ffmpeg 暂存探测；两者都失败则给用户明确错误，
      // 不发 0 让服务端拒（旧路径会发 0 → 400，错误不直观）。
      const effectiveDuration = staged.totalDurationSec ?? duration;
      if (!effectiveDuration || effectiveDuration <= 0) {
        throw new Error(
          "无法读取视频时长（浏览器与本地 ffmpeg 均失败），请确认视频可正常播放后重试，或转成 mp4/h264",
        );
      }
      setDispatchProgress(60);

      // 2. POST 纯元数据派发 LONG_VIDEO_REWRITE render_job（字节零上传）。
      const endpoint = `/api/projects/${project.id}/original-video-upload`;
      const data = await readJson(
        await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoUrl: staged.videoUrl,
            filename: staged.filename ?? file?.name ?? "source.mp4",
            totalBytes: staged.totalBytes ?? file?.size,
            totalDurationSec: effectiveDuration,
            ...(regenerateFromEpisode >= 2
              ? { regenerateFromEpisode, reuseTargetStageDraft }
              : {}),
          }),
        }),
      );
      setDispatchProgress(100);

      if (data?.reused && data?.taskId) {
        setTaskId(String(data.taskId));
        toast.warning("该项目已有整剧重写任务，已恢复原任务进度");
        return;
      }
      setTaskId(String(data?.taskId));
      toast.success("已开始并行分析与重写");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "派发失败");
    } finally {
      setDispatching(false);
    }
  };

  /** LOCAL_SCRIPT 分支：保存完整剧本（PATCH novelText，0 积分）。 */
  const saveLocalScript = async () => {
    if (scriptDraft.trim().length < 10) return toast.error("请输入完整剧本内容");
    setSavingScript(true);
    try {
      await readJson(
        await fetch(`/api/projects/${project.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ novelText: scriptDraft }),
        }),
      );
      toast.success("完整剧本已保存");
      onRefresh?.({ force: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSavingScript(false);
    }
  };

  const handleOutlineDocxUpload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".docx")) {
      toast.error("仅支持 .docx 格式");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），最大 20MB`);
      return;
    }
    setImportingOutlineDocx(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await readJson(
        await fetch(`/api/projects/${project.id}/import-docx`, {
          method: "POST",
          credentials: "include",
          body: formData,
        }),
      );
      if (typeof result?.text === "string" && result.text.trim()) {
        setOutlineDraft(result.text);
        toast.success(`已导入 ${result.text.length.toLocaleString()} 字`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImportingOutlineDocx(false);
    }
  };

  /** OUTLINE_TO_SCRIPT 分支：提交大纲 → POST outline-to-script → 服务端 DeepSeek 扩写。 */
  const generateFromOutline = async () => {
    if (outlineDraft.trim().length < 50) return toast.error("大纲至少 50 字");
    setGeneratingOutline(true);
    try {
      await readJson(
        await fetch(`/api/projects/${project.id}/outline-to-script`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            outline: outlineDraft,
            targetEpisodeCount: targetEpisodeCount > 0 ? targetEpisodeCount : undefined,
          }),
        }),
      );
      toast.success("剧本已生成");
      onRefresh?.({ force: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "生成失败");
    } finally {
      setGeneratingOutline(false);
    }
  };

  // ============================================================
  // 渲染：LOCAL_SCRIPT 分支（视觉 1:1 对齐 app1 行 137-149）
  // ============================================================
  // OUTLINE_TO_SCRIPT 分支先于 LOCAL_SCRIPT 判定（二者互斥）。
  if (sourceMode === "LOCAL_SCRIPT") {
    return (
      <div className="flex-1 overflow-auto section-y">
        <div className="container-app max-w-5xl space-y-5">
          <div>
            <h1 className="text-xl font-bold text-[var(--text)]">剧本原创 · 原创整剧</h1>
            <p className="mt-1 text-sm text-[var(--text-3)]">
              按整剧维度保存，不创建分集或单集配置；国内直出和海外转绘项目可直接调用此完整剧本。
            </p>
          </div>
          <div className="card card-pad space-y-3">
            <textarea
              value={scriptDraft}
              onChange={(e) => setScriptDraft(e.target.value)}
              rows={24}
              className="input-base w-full rounded-lg p-4 text-sm leading-7"
              placeholder="粘贴完整剧本……"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-[var(--text-3)]">
                {scriptDraft.length.toLocaleString()} 字符 · 保存不消耗积分
              </span>
              <Button
                variant="primary"
                onClick={saveLocalScript}
                loading={savingScript}
                disabled={scriptDraft.trim().length < 10}
              >
                保存完整剧本 · 0 积分
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ============================================================
  // 渲染：OUTLINE_TO_SCRIPT 分支（根据大纲写剧本）
  // ============================================================

  if (sourceMode === "OUTLINE_TO_SCRIPT") {
    return (
      <div className="flex-1 overflow-auto section-y">
        <div className="container-app max-w-5xl space-y-5">
          <div>
            <h1 className="text-xl font-bold text-[var(--text)]">剧本原创 · 根据大纲写剧本</h1>
            <p className="mt-1 text-sm text-[var(--text-3)]">
              输入故事大纲，AI 按竖屏短剧标准扩写成完整剧本（含分集、场头、画面与台词）。生成后可进入分镜与生产流程。
            </p>
          </div>
          <div className="card card-pad space-y-3">
            <input
              ref={outlineDocxInputRef}
              type="file"
              accept=".docx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleOutlineDocxUpload(f);
                e.target.value = "";
              }}
            />
            <textarea
              value={outlineDraft}
              onChange={(e) => setOutlineDraft(e.target.value)}
              rows={18}
              className="input-base w-full rounded-lg p-4 text-sm leading-7"
              placeholder="粘贴大纲，或点上方按钮导入 .docx 文件。建议包含：梗概、人设、核心冲突、关键转折、反派与结局走向。"
            />
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-xs text-[var(--text-3)]">
                <Button
                  variant="outline"
                  onClick={() => outlineDocxInputRef.current?.click()}
                  loading={importingOutlineDocx}
                >
                  导入 docx
                </Button>
                <span>{outlineDraft.length.toLocaleString()} 字符</span>
                <span>·</span>
                <label className="flex items-center gap-1.5">
                  目标集数
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={targetEpisodeCount}
                    onChange={(e) =>
                      setTargetEpisodeCount(
                        Math.max(1, Math.min(120, Number(e.target.value) || 0)),
                      )
                    }
                    className="input-base w-20 rounded-md px-2 py-1"
                  />
                </label>
              </div>
              <Button
                variant="primary"
                onClick={generateFromOutline}
                loading={generatingOutline}
                disabled={outlineDraft.trim().length < 50}
              >
                生成剧本
              </Button>
            </div>
          </div>
          {project.videoScriptDraft ? (
            <div className="card card-pad space-y-3">
              <details>
                <summary className="cursor-pointer text-sm font-medium text-[var(--text-2)]">
                  已生成剧本（点击展开 · {project.videoScriptDraft.length.toLocaleString()} 字符）
                </summary>
                <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 text-[var(--text-2)] max-h-[480px] overflow-auto">
                  {project.videoScriptDraft}
                </pre>
              </details>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // ============================================================
  // 渲染：VIDEO_REWRITE 分支（视觉 1:1 对齐 app1 行 151-206）
  // ============================================================

  return (
    <div className="flex-1 overflow-auto section-y">
      <div className="container-app max-w-5xl space-y-5">
        <div>
          <h1 className="text-xl font-bold text-[var(--text)]">剧本原创 · 整剧重写</h1>
          <p className="mt-1 text-sm text-[var(--text-3)]">
            视频按时长与文件大小自适应无损拆分 → Kimi 并行完整还原 → DeepSeek 全剧大纲 → DeepSeek 完整剧本重写。最终剧本不设字数上限，触顶自动续写。
          </p>
        </div>

        <div className="card card-pad space-y-4">
          <input
            ref={inputRef}
            className="hidden"
            type="file"
            accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mkv"
            onChange={(e) => chooseFile(e.target.files?.[0] || null)}
          />
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-sm font-semibold text-[var(--text)]">
                {file?.name || "选择一部完整短剧视频"}
              </div>
              <div className="mt-1 text-xs text-[var(--text-3)]">
                支持 MP4/WebM/MOV/MKV，最大 3GB；视频字节保留在桌面客户端本地硬盘，服务器只接收派发元数据。
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => inputRef.current?.click()}
              disabled={dispatching || !!taskId}
            >
              选择视频
            </Button>
          </div>

          {plan && file && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div className="rounded-lg bg-[var(--bg-elevated)] p-3">
                <div className="text-[var(--text-3)]">文件大小</div>
                <div className="mt-1 font-semibold">
                  {(file.size / 1024 / 1024 / 1024).toFixed(2)} GB
                </div>
              </div>
              <div className="rounded-lg bg-[var(--bg-elevated)] p-3">
                <div className="text-[var(--text-3)]">总时长</div>
                <div className="mt-1 font-semibold">{(duration / 60).toFixed(1)} 分钟</div>
              </div>
              <div className="rounded-lg bg-[var(--bg-elevated)] p-3">
                <div className="text-[var(--text-3)]">自适应片段</div>
                <div className="mt-1 font-semibold">
                  {plan.segmentCount} 段 × 约 {(plan.segmentDurationSec / 60).toFixed(1)} 分钟
                </div>
              </div>
              <div className="rounded-lg bg-[var(--bg-elevated)] p-3">
                <div className="text-[var(--text-3)]">积分消耗</div>
                <div className="mt-1 font-semibold text-[var(--accent)]">按实际 Token 结算</div>
              </div>
            </div>
          )}

          {rewrite?.targetEpisodeCount && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-3">
              <div className="text-sm font-semibold text-[var(--text)]">局部恢复重写</div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-2)]">
                <label htmlFor="regenerate-from-episode">从第几集所在阶段重新生成</label>
                <input
                  id="regenerate-from-episode"
                  type="number"
                  min={0}
                  max={rewrite.targetEpisodeCount}
                  value={regenerateFromEpisode}
                  onChange={(event) => setRegenerateFromEpisode(Math.max(0, Number(event.target.value) || 0))}
                  className="input-base w-24 rounded px-2 py-1"
                />
                <span>填 0 表示完整重写；范围 2–{rewrite.targetEpisodeCount}</span>
              </div>
              <label className="flex items-center gap-2 text-xs text-[var(--text-2)]">
                <input
                  type="checkbox"
                  checked={reuseTargetStageDraft}
                  onChange={(event) => setReuseTargetStageDraft(event.target.checked)}
                  disabled={regenerateFromEpisode < 2}
                />
                将旧目标阶段稿作为返修参考（默认关闭，避免旧问题污染新稿）
              </label>
              <p className="text-xs text-[var(--text-3)]">
                生产链按三段式运行：会保留起点之前已完成的整段，起点所在段整体重写。源视频指纹不一致时系统会拒绝恢复。
              </p>
              {!file && canReusePreviousSource && (
                <p className="text-xs text-[var(--accent)]">
                  可复用本机上次源视频：{rewrite.sourceFilename || "原整剧视频"}，无需再次复制 3GB 文件。
                </p>
              )}
            </div>
          )}

          {dispatching && (
            <ProgressBar
              progress={dispatchProgress}
              label="本地暂存与任务派发中"
              stage={`${dispatchProgress}%`}
              pulse={dispatchProgress < 100}
            />
          )}
          {!taskId && (
            <div className="flex justify-end">
              <Button
                variant="primary"
                onClick={start}
                disabled={(!file && !canReusePreviousSource) || dispatching}
                loading={dispatching}
                progress={dispatching ? dispatchProgress : undefined}
              >
                {regenerateFromEpisode >= 2
                  ? `从第 ${regenerateFromEpisode} 集所在阶段重写`
                  : "开始完整重写 · 按实际 Token 结算"}
              </Button>
            </div>
          )}
        </div>

        {taskId && (
          <div className="card card-pad">
            <GenerationProgress
              taskId={taskId}
              label="整剧重写中（目标 20 分钟内）"
              estimatedDuration={1200}
              onComplete={() => {
                setTaskId(null);
                onRefresh?.({ force: true });
              }}
              onFailure={() => setTaskId(null)}
            />
          </div>
        )}

        {rewrite && (
          <div className="grid gap-4">
            {(
              [
                ["Kimi 拼接原剧本", rewrite.sourceScript],
                ["DeepSeek 详细大纲", rewrite.outline],
                ["DeepSeek 完整重写剧本", rewrite.rewrittenScript],
              ] as Array<[string, string | undefined]>
            ).map(([title, content]) =>
              content ? (
                <details
                  key={title}
                  className="card card-pad"
                  open={title === "DeepSeek 完整重写剧本"}
                >
                  <summary className="cursor-pointer text-sm font-semibold text-[var(--text)]">
                    {title}
                  </summary>
                  <pre className="mt-4 whitespace-pre-wrap text-sm leading-7 text-[var(--text-2)] font-sans">
                    {content}
                  </pre>
                </details>
              ) : null,
            )}
          </div>
        )}
      </div>
    </div>
  );
}
