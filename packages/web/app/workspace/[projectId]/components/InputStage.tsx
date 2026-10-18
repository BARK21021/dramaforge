"use client";

/**
 * @file InputStage.tsx
 * @description 输入阶段组件（阶段 1，批3 Step 2）
 *
 * 镜像 app1 `F:\app1\src\app\workspace\[projectId]\components\InputStage.tsx`，
 * 视频转剧本已接入 C/S 上传与任务链；本组件同时支持文本和视频两种输入。
 *
 * 核心功能（保留）：
 *   1. 文本输入：直接粘贴/编辑剧本文本（novelText）
 *   2. Word 上传：上传 .docx → POST /api/projects/[id]/import-docx（mammoth 解析）
 *      → 文本填入 scriptDraft（可再编辑后保存）
 *   3. 文本转风格：POST /api/projects/[id]/text-to-style
 *      - 海外（OVERSEAS）：必选，LanguageMenu 选目标语言
 *      - 原创（ORIGINAL）：可选，自由 Textarea
 *      - 国内（DOMESTIC）：不显示风格区
 *      - 跨集资产传递：第二集及之后，前端传项目已确认资产 + episodeNumber
 *   4. 保存并分析：PATCH episode novelText (+scriptData.localizationProfile)
 *      → POST /analyze → 切到分析阶段。ProgressBar 多阶段 8%→35%→45%→72%→100%。
 *
 * X2 已实现（转绘）：
 *   - 视频转剧本（mode="video"）—— 单集 Kimi 视频理解（extractVideoContext +
 *     generateScriptFromVideo，Kimi-only），落 episode.videoScriptDraft。
 *   - raw File 请求预生成 taskId，服务端按真实 Kimi 边界写 tasks 并经 SSE 驱动 ProgressBar。
 *   - characterMapping 已在整剧/文本转风格链路持久化，保证跨集角色身份一致。
 *   - 视频理解采用 Kimi 原生多模态；不额外部署 Whisper/OCR 模型，降低客户端体积。
 *
 * GC 翻译：
 *   - GC-1（BYOK 禁）：无 key UI，只 scriptModel prop（ModelSelector 选模型）✓
 *   - GC-3（app1 只读）：仅镜像，未改 app1 ✓
 *   - dramaforge-frontend-align-app1：UI 1:1 镜像 app1（砍 video）✓
 *   - prefer-better-lib-not-selfbuilt：mammoth/Radix/现有 UI 组件直接用 ✓
 *
 * 双色方案铁律：
 *   - 「保存并分析」/「转换风格」按钮使用 --action 蓝（可点击行为）
 *   - 海外必选警告使用 --error 红
 *   - 阶段标题图标使用 --accent 琥珀（身份/品牌层）
 */

import * as React from "react";
import { Button } from "../../../../components/ui/Button";
import { Textarea } from "../../../../components/ui/Input";
import { ProgressBar } from "../../../../components/ui/ProgressBar";
import { EditorSurface, CodeTextarea } from "../../../../components/ui/EditorSurface";
import { runAnalysisWorkflow } from "../../../../lib/analysis-workflow";
import {
  getDraft,
  setDraft,
  clearDraft,
  setTaskId,
} from "../../../../lib/episode-task-store";
import { useEpisodeTask } from "../../../../hooks/useEpisodeTask";
import { GenerationProgress } from "../../../../components/features/GenerationProgress";
import {
  VIDEO_TO_SCRIPT_MODELS,
  DEFAULT_VIDEO_TO_SCRIPT_MODEL,
} from "../../../../lib/models";
import { useVideoUpload } from "../../../../hooks/useVideoUpload";
import { useInFlightGeneration } from "../../../../hooks/useInFlightGeneration";
import { LanguageMenu } from "./LanguageMenu";
// 客户端组件走 prompt 子路径（避免主 barrel 的 node:* 依赖污染 client bundle）。
// type-only import：编译期擦除，零运行时 server 引用。
import type {
  LocalizationProfile,
  TargetLanguage,
} from "@dramaforge/server/prompt";

// ============================================================
// 类型定义
// ============================================================

/** 分集数据（仅声明本组件使用的字段） */
interface EpisodeInfo {
  id: string;
  title?: string | null;
  episodeNumber?: number;
  novelText?: string | null;
  content?: string | null;
  videoScriptDraft?: string | null;
  stageStatus?: string;
  // scriptData 在 EpisodeRecord 是 unknown（DB JSONB 透传），InputStage 内部 narrow。
  scriptData?: unknown;
}

/** 已确认资产（跨集传递用，与后端 text-to-style 对齐） */
interface ExistingAsset {
  kind: string;
  name: string;
  description: string;
}

export interface InputStageProps {
  /** 项目 ID */
  projectId: string;
  /** 分集 ID */
  episodeId?: string | null;
  /** 分集数据 */
  episode?: EpisodeInfo | null;
  /** 项目分类（OVERSEAS / DOMESTIC / ORIGINAL） */
  category?: string;
  /** 内容来源；ORIGINAL_PROJECT 已在项目级完成整剧转风格。 */
  sourceMode?: string;
  /** 项目全部已确认资产（跨集 text-to-style 传递用） */
  existingAssets?: ExistingAsset[];
  /** API 调用封装（带鉴权） */
  api: (url: string, options?: RequestInit) => Promise<any>;
  /** 文本模型 ID */
  scriptModel?: string;
  /** 刷新数据回调 */
  onRefresh?: (opts?: { force?: boolean }) => void;
  /** 跳转下一阶段（编剧分析）回调 */
  onNavigateNext?: () => void;
  /** 容器额外类名 */
  className?: string;
}

/** 输入模式：text 文本 / video 视频转剧本（X2） */
type InputMode = "text" | "video";

/**
 * 从 episode.scriptData（unknown，DB JSONB 透传）安全读出 localizationProfile。
 * 任何 shape 不匹配（null / 非 object / 缺字段）→ 返回 undefined。
 */
function readLocalizationProfile(
  scriptData: unknown,
): LocalizationProfile | undefined {
  if (
    !scriptData ||
    typeof scriptData !== "object" ||
    Array.isArray(scriptData)
  ) {
    return undefined;
  }
  const profile = (scriptData as { localizationProfile?: unknown }).localizationProfile;
  if (
    profile &&
    typeof profile === "object" &&
    !Array.isArray(profile) &&
    typeof (profile as { stylePrompt?: unknown }).stylePrompt === "string"
  ) {
    return profile as LocalizationProfile;
  }
  return undefined;
}

export function InputStage({
  projectId,
  episodeId,
  episode,
  category,
  sourceMode,
  existingAssets,
  api,
  scriptModel = "deepseek/deepseek-v4-flash",
  onRefresh,
  onNavigateNext,
  className,
}: InputStageProps) {
  /** 当前输入模式（text 文本 / video 视频转剧本，X2 已通） */
  const [mode, setMode] = React.useState<InputMode>("text");
  // 视频转剧本选用的 Kimi 模型（带前缀 id，透传到 route ?model=）。默认 K2.6（稳、当前线上）。
  const [videoModel, setVideoModel] = React.useState<string>(DEFAULT_VIDEO_TO_SCRIPT_MODEL);
  // 客户端上传前正降到 480p（ffmpeg 在 main 进程跑；浏览器/旧客户端无此步）。
  const [videoPreprocessing, setVideoPreprocessing] = React.useState(false);
  /** 剧本文本草稿 */
  const [scriptDraft, setScriptDraft] = React.useState("");
  /** 风格提示词（text-to-style 用） */
  const [stylePrompt, setStylePrompt] = React.useState("");
  /** 选中的目标语言（海外菜单；ORIGINAL 不用） */
  const [targetLang, setTargetLang] = React.useState<TargetLanguage | null>(null);
  /** 保存中 */
  const [saving, setSaving] = React.useState(false);
  /** 风格转换中 */
  const [styling, setStyling] = React.useState(false);
  /** 输入阶段当前进度文案 */
  const [stageProgressLabel, setStageProgressLabel] = React.useState<string | null>(null);
  /** 输入阶段当前进度阶段 */
  const [stageProgressStage, setStageProgressStage] = React.useState<string | null>(null);
  /** 输入阶段当前进度值 */
  const [stageProgressValue, setStageProgressValue] = React.useState<number>(0);
  /**
   * 保存/转风格/分析已用秒数：同步 AI 调用只在 55/80/100 三个粗粒度点上报进度，
   * 期间进度条会长时间不动（深色底上像冻住的细条）。加一个每秒 tick 的已用计时，
   * 让进度区始终"活着"，符合用户"实时进度条"诉求。
   */
  const [elapsedSec, setElapsedSec] = React.useState(0);
  const savingStartRef = React.useRef<number | null>(null);
  /**
   * 保存并分析的 in-flight 锁（对齐 AnalyzingStage）：localStorage 持久化，
   * 切走/刷新后挂载 reconcile 查 episode.status 恢复"分析中/done/failed"，
   * 不再因本地 state 重置丢任务态（#38 持久化）。
   */
  const inflight = useInFlightGeneration({
    key: `analyze:${episodeId ?? ""}`,
    scope: "analyze",
    projectId,
    episodeId: episodeId ?? null,
    reconcile: async () => {
      if (!episodeId) return null;
      const ep = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}`,
      )) as { status?: string } | null;
      if (ep?.status === "ANALYZING") return "running";
      if (ep?.status === "COMPLETED") return "done";
      return "failed";
    },
    onCompleted: () => {
      onRefresh?.({ force: true });
    },
    pollMs: 8000,
    maxPolls: 30,
  });
  /** 最近一次成功转风格的快照（避免保存时重复转换） */
  const lastStyledSnapshotRef = React.useRef<{
    prompt: string;
    result: string;
    localizationProfile?: LocalizationProfile;
  } | null>(null);
  /** docx 上传解析中 */
  const [docxUploading, setDocxUploading] = React.useState(false);
  const docxInputRef = React.useRef<HTMLInputElement>(null);
  /** docx 上传错误 */
  const [docxError, setDocxError] = React.useState<string | null>(null);
  /**
   * 视频转剧本（导航无关）：上传 fetch + uploading/taskId/error/script/终态去重
   * 全部归模块级 video-upload-store，切集/卸载不丢，组件只订阅。
   *   - onCompleted：任务完成（锁已清）；script 非空时即时回填，省一次 episode 重载。
   *   - onFailed：终态失败（error 已落 store，videoError 即时反映）。
   * 进度由 store 内 useTaskStatus（模块级 SSE 单例）驱动，跨导航存活。
   */
  const {
    progress: videoTaskProgress,
    busy: videoBusy,
    taskId: videoTaskId,
    error: videoError,
    transportNotice: videoTransportNotice,
    start: startVideoUploadTask,
    reportError: setVideoError,
  } = useVideoUpload(projectId, episodeId ?? null, {
    api,
    onCompleted: async ({ script }) => {
      if (script) setScriptDraft(script);
      setMode("text");
      onRefresh?.({ force: true });
    },
    onFailed: () => {
      // error 已落 store，videoError 即时反映；无需额外动作。
    },
  });

  /**
   * 返回本集且有在途任务（启动 / sessionStorage 恢复）时，自动切到视频 Tab 显示
   * 进度——照搬原 recovery 的 setMode("video")。仅在 taskId 从无→有且 busy 时触发，
   * 不与用户中途手动切文本 Tab 冲突。
   */
  const prevVideoTaskIdRef = React.useRef<string | null>(null);
  const lastVideoFileRef = React.useRef<File | null>(null);
  React.useEffect(() => {
    if (videoTaskId && prevVideoTaskIdRef.current !== videoTaskId && videoBusy) {
      setMode("video");
    }
    prevVideoTaskIdRef.current = videoTaskId;
  }, [videoTaskId, videoBusy]);

  /**
   * 编剧分析的 inline-task 跟踪（F3）：
   * 从 localStorage 读 STORY_ANALYZE taskId → 喂 useTaskStatus → 右栏 GenerationProgress 绑定。
   * handleSaveAndAnalyze 成功后 setTaskId 写入 → 本 hook 下一次渲染读到 → 进度条接管。
   */
  const analyzeTask = useEpisodeTask(episodeId, "STORY_ANALYZE");

  /** 初始化剧本文本：优先从 localStorage 草稿恢复（切集不丢），否则取 episode 落库值。 */
  React.useEffect(() => {
    const persisted = projectId && episodeId ? getDraft(projectId, episodeId) : null;
    const fromEpisode =
      episode?.novelText || episode?.content || episode?.videoScriptDraft || "";
    setScriptDraft(persisted ?? fromEpisode);
    lastStyledSnapshotRef.current = null;
  }, [episode?.id, episode?.novelText, episode?.content, episode?.videoScriptDraft, projectId, episodeId]);

  /** 草稿持久化：编辑时 debounce 300ms 写 localStorage（切集/刷新不丢）。 */
  const draftWriteTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (!projectId || !episodeId) return;
    // 只在有实际内容时写（空串也写，便于切回时恢复「清空」操作）。
    if (draftWriteTimerRef.current) clearTimeout(draftWriteTimerRef.current);
    draftWriteTimerRef.current = setTimeout(() => {
      setDraft(projectId, episodeId, scriptDraft);
    }, 300);
    return () => {
      if (draftWriteTimerRef.current) clearTimeout(draftWriteTimerRef.current);
    };
  }, [scriptDraft, projectId, episodeId]);

  /** 重载项目时恢复已持久化的目标语言/文化选择（从 episode.scriptData）。 */
  React.useEffect(() => {
    const profile = readLocalizationProfile(episode?.scriptData);
    if (!profile) return;
    setStylePrompt(profile.stylePrompt || "");
    setTargetLang(profile.targetLanguage || null);
  }, [episode?.id]);

  /** 进度态实时计时：saving/styling/inflight 期间每秒 tick 已用秒数；结束归零。 */
  React.useEffect(() => {
    const active = saving || styling || inflight.isGenerating;
    if (!active) {
      savingStartRef.current = null;
      setElapsedSec(0);
      return;
    }
    if (savingStartRef.current === null) savingStartRef.current = Date.now();
    setElapsedSec(Math.floor((Date.now() - savingStartRef.current) / 1000));
    const id = window.setInterval(() => {
      if (savingStartRef.current !== null) {
        setElapsedSec(Math.floor((Date.now() - savingStartRef.current) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [saving, styling, inflight.isGenerating]);

  /** 当前集号 */
  const episodeNumber = episode?.episodeNumber ?? 1;
  const isOverseas = category === "OVERSEAS";
  const isDomestic = category === "DOMESTIC";
  const usesOriginalProject = sourceMode === "ORIGINAL_PROJECT";
  const showTextToStyle = !isDomestic && !usesOriginalProject;
  /** 文本是否可保存（≥10 字符） */
  const canSave =
    scriptDraft.trim().length >= 10 &&
    !saving &&
    !styling &&
    !inflight.isGenerating &&
    (!isOverseas || usesOriginalProject || !!stylePrompt.trim());

  /**
   * 执行文本转风格
   *
   * 海外转绘项目在"保存并分析"前会自动执行一次，确保文本转风格成为必选步骤。
   */
  const performTextToStyle = async (sourceText: string, preserveWorkflowProgress = false) => {
    if (sourceText.trim().length < 10) return null;
    if (!stylePrompt.trim()) return null;
    setStyling(true);
    setStageProgressLabel("文本转风格中");
    setStageProgressStage("正在改写目标风格");
    setStageProgressValue(20);
    try {
      const result = await api(
        `/api/projects/${encodeURIComponent(projectId)}/text-to-style`,
        {
          method: "POST",
          body: JSON.stringify({
            text: sourceText,
            stylePrompt: stylePrompt.trim(),
            model: scriptModel,
            // 跨集已确认资产 + 集号（让后端复用首集角色名）
            existingAssets: existingAssets ?? [],
            episodeNumber,
          }),
        },
      );
      const styledScript = typeof result?.script === "string" ? result.script : "";
      const localizationProfile = result?.localizationProfile as LocalizationProfile | undefined;
      if (styledScript.trim()) {
        setStageProgressValue(100);
        setStageProgressStage("风格转换完成");
        setScriptDraft(styledScript);
        lastStyledSnapshotRef.current = {
          prompt: stylePrompt.trim(),
          result: styledScript,
          localizationProfile,
        };
        return styledScript;
      }
      return null;
    } catch {
      // api 已处理错误提示
      return null;
    } finally {
      setStyling(false);
      if (!preserveWorkflowProgress) setTimeout(() => {
        setStageProgressLabel((current) => (current === "文本转风格中" ? null : current));
        setStageProgressStage((current) =>
          current === "风格转换完成" || current === "正在改写目标风格" ? null : current,
        );
        setStageProgressValue((current) => (current === 100 || current === 20 ? 0 : current));
      }, 300);
    }
  };

  /**
   * 保存剧本并进入分析阶段
   *
   * PATCH 分集 novelText + scriptData.localizationProfile（与 novelText 同路径写入
   * episode.scriptData，Q1 修订：localizationProfile 存 episode 不存 project），
   * 然后触发分析。
   */
  const handleSaveAndAnalyze = async () => {
    if (!canSave || !episodeId) return;
    setSaving(true);
    inflight.start();
    try {
      let nextScriptDraft = scriptDraft;
      setStageProgressLabel("保存并分析中");
      const requiresEpisodeStyle = isOverseas && !usesOriginalProject;
      setStageProgressStage(requiresEpisodeStyle ? "准备文本转风格" : "保存剧本内容");
      setStageProgressValue(requiresEpisodeStyle ? 8 : 12);
      if (requiresEpisodeStyle) {
        const latestStyledSnapshot = lastStyledSnapshotRef.current;
        if (
          latestStyledSnapshot &&
          latestStyledSnapshot.prompt === stylePrompt.trim() &&
          latestStyledSnapshot.result === scriptDraft
        ) {
          nextScriptDraft = scriptDraft;
        } else {
          // 保存工作流会继续推进到分析/资产提取，不能让单独转风格的清理定时器抹掉进度。
          const styledScript = await performTextToStyle(scriptDraft, true);
          if (!styledScript?.trim()) return;
          nextScriptDraft = styledScript;
          setStageProgressLabel("保存并分析中");
          setStageProgressStage("已完成风格转换，准备保存剧本");
          setStageProgressValue(35);
        }
      }

      const localizationProfile =
        lastStyledSnapshotRef.current?.localizationProfile ||
        readLocalizationProfile(episode?.scriptData);

      // 1. 保存剧本文本 + localizationProfile 到分集 scriptData
      setStageProgressStage("保存剧本内容");
      setStageProgressValue(45);
      const existingScriptData =
        (episode?.scriptData &&
          typeof episode.scriptData === "object" &&
          !Array.isArray(episode.scriptData) &&
          (episode.scriptData as Record<string, unknown>)) ||
        {};
      const saved = await api(
        `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            novelText: nextScriptDraft,
            ...(localizationProfile
              ? {
                  scriptData: {
                    ...existingScriptData,
                    localizationProfile,
                  },
                }
              : {}),
          }),
        },
      );
      if (!saved) return;

      // 2. 编剧分析（inline-task 202）：POST /analyze 拿 { taskId } 即返回。
      // 不再 await AI 完成（后台 fire-and-forget）；进度由 SSE 驱动 GenerationProgress。
      const workflow = await runAnalysisWorkflow({
        api,
        projectId,
        episodeId,
        model: scriptModel,
        localizationProfile,
        onProgress: ({ value, label, stage }) => {
          setStageProgressValue(value);
          setStageProgressLabel(label);
          setStageProgressStage(stage);
        },
      });
      if (!workflow) return;

      // taskId 落 localStorage → AnalyzingStage 的 useEpisodeTask 读出绑 GenerationProgress。
      setTaskId("STORY_ANALYZE", episodeId, workflow.taskId);
      // 草稿已落库（PATCH 成功），清掉防 stale 覆盖。
      clearDraft(projectId, episodeId);

      onNavigateNext?.();
    } catch {
      // api 已处理错误提示
    } finally {
      setSaving(false);
      inflight.end();
      setTimeout(() => {
        setStageProgressLabel(null);
        setStageProgressStage(null);
        setStageProgressValue(0);
      }, 300);
    }
  };

  /**
   * 文本转风格（手动触发）
   *
   * 跨集资产传递：第二集及之后，传入项目全部已确认资产 + episodeNumber，
   * 让模型复用首集锁定的角色名，保证跨集命名一致性。
   */
  const handleTextToStyle = async () => {
    await performTextToStyle(scriptDraft);
  };

  /**
   * 上传 .docx → 后端解析为纯文本 → 填入编辑框（可再编辑后保存）
   *
   * 走 /api/projects/[id]/import-docx（mammoth 提取纯文本），
   * 不落盘文件，仅返回文本填入 scriptDraft。
   */
  const handleDocxUpload = async (file: File) => {
    setDocxError(null);
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith(".docx")) {
      setDocxError("仅支持 .docx 格式（.doc 旧格式请先另存为 .docx）");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setDocxError(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），最大 20MB`);
      return;
    }
    setDocxUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await api(
        `/api/projects/${encodeURIComponent(projectId)}/import-docx`,
        {
          method: "POST",
          body: formData,
        },
      );
      if (typeof result?.text === "string" && result.text.trim()) {
        setScriptDraft(result.text);
      }
    } catch {
      // api 已通过 toast 提示错误
    } finally {
      setDocxUploading(false);
    }
  };

  /**
   * 视频转剧本（X2：单集 Kimi 视频理解）。
   * 上传 ≤100MB 视频 → 云端 Kimi extractVideoContext + generateScriptFromVideo
   * → 落 episode.videoScriptDraft → 切回文本 Tab 展示/编辑。Kimi-only（砍 Whisper/OCR）。
   */
  
  


const handleVideoUpload = async (file: File) => {
    lastVideoFileRef.current = file;
    setVideoError(null);
    if (!episodeId) {
      setVideoError("请先选择分集");
      return;
    }
    const lowerName = file.name.toLowerCase();
    const okExt = [".mp4", ".webm", ".mov", ".mkv"].some((ext) => lowerName.endsWith(ext));
    const okMime = file.type.startsWith("video/");
    if (!okExt && !okMime) {
      setVideoError("仅支持 MP4 / WebM / MOV / MKV 视频");
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      setVideoError(`视频过大（${(file.size / 1024 / 1024).toFixed(1)}MB），最大支持 100MB`);
      return;
    }
    // 客户端（Electron）上传前强制降到 480p：Kimi「>1080p 不提升理解，只多耗 token 和时间」，
    // 480p 省 token + 提速。浏览器/旧客户端无此 IPC → 回退原样上传（不阻断）。
    const sf = typeof window !== "undefined" ? window.sfShell : undefined;
    let uploadFile: File = file;
    let sourceDurationSeconds: number | null = await readVideoDurationSeconds(file);
    if (sf?.isElectron && typeof sf.preprocessVideoForUpload === "function") {
      try {
        setVideoPreprocessing(true);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const res = await sf.preprocessVideoForUpload({
          file: bytes,
          filename: file.name,
          mimeType: file.type || "video/mp4",
        });
        if (res.ok) {
          // 降采样后字节包成新 File 上传；duration 用 IPC probe 的值（更准，省一次 renderer probe）。
          // 拷贝到新 ArrayBuffer 以满足 BlobPart 类型（Uint8Array<ArrayBufferLike> 不能直接当 BlobPart）。
          const ab = new ArrayBuffer(res.file.byteLength);
          new Uint8Array(ab).set(res.file);
          uploadFile = new File([ab], res.filename, { type: res.mimeType });
          if (typeof res.durationSeconds === "number" && res.durationSeconds > 0) {
            sourceDurationSeconds = res.durationSeconds;
          }
        }
        // res.ok=false 或异常：回退原 file（uploadFile 未被覆盖）。
      } finally {
        setVideoPreprocessing(false);
      }
    }
    // 上传 fetch + uploading/taskId/终态去重全部归模块级 store（切集不丢）。
    // taskId/notice/error 由 store 自行重置；连接中断的兜底判终态由 useTaskStatus 给出。
    startVideoUploadTask(uploadFile, sourceDurationSeconds, videoModel);
  };

  return (
    <div className={`flex flex-col h-full ${className ?? ""}`}>
      {/* 输入模式切换：文本与视频均为可用入口。 */}
      <div className="flex items-center gap-2 px-4 sm:px-6 py-3 border-b border-[var(--border-light)] flex-shrink-0">
        <button
          type="button"
          onClick={() => setMode("text")}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            mode === "text"
              ? "bg-[var(--action-dim)] text-[var(--action)]"
              : "text-[var(--text-3)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]"
          }`}
        >
          文本输入
        </button>
        <button
          type="button"
          onClick={() => setMode("video")}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            mode === "video"
              ? "bg-[var(--action-dim)] text-[var(--action)]"
              : "text-[var(--text-3)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]"
          }`}
        >
          视频转剧本
        </button>
        <div className="flex-1" />
        {episodeNumber > 1 && (
          <span
            className="text-xs text-[var(--text-3)]"
            title="跨集资产将自动复用首集角色名"
          >
            第 {episodeNumber} 集 · 跨集资产已传递
          </span>
        )}
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {mode === "text" ? (
          /* 文本输入模式：双栏 grid（左=编辑器，右=常驻操作侧栏），窄屏降级底部粘性栏 */
          <div className="mx-auto grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-6 max-w-6xl">
            {/* 左栏：风格转换区 + 剧本编辑器 */}
            <div className="space-y-4 min-w-0">
            {/* 风格转换区（按项目分类展示） */}
            {showTextToStyle && (
              <details className="card p-4 group" open={isOverseas}>
                <summary className="cursor-pointer text-sm font-medium flex items-center gap-2 list-none">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    className={`${isOverseas ? "text-[var(--error)]" : "text-[var(--accent)]"} transition-transform group-open:rotate-90`}
                  >
                    <path
                      d="M6 3l5 5-5 5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className={isOverseas ? "text-[var(--error)]" : "text-[var(--text-2)]"}>
                    文本转风格{isOverseas ? "（必选）" : "（可选）"}
                  </span>
                  <span
                    className={`text-xs font-normal ml-1 ${
                      isOverseas ? "text-[var(--error)]" : "text-[var(--text-3)]"
                    }`}
                  >
                    {isOverseas
                      ? "海外转绘项目必须先完成文本转风格，保存分析时会自动执行"
                      : "将剧本按目标风格改写，保持剧情骨架不变"}
                  </span>
                </summary>
                <div className="mt-3 space-y-2">
                  {isOverseas ? (
                    <LanguageMenu
                      value={targetLang}
                      onChange={(l) => {
                        setTargetLang(l);
                        // 结构化串：首 token 为语言中文名，供后端 parseTargetLanguage 解析
                        setStylePrompt(`${l.zh} / ${l.cultureHint} / ${l.region}`);
                      }}
                      disabled={styling || saving}
                    />
                  ) : (
                    <Textarea
                      rows={2}
                      placeholder="目标风格提示词，如：欧美风、港风、日漫风..."
                      value={stylePrompt}
                      onChange={(e) => setStylePrompt(e.target.value)}
                      disabled={styling || saving}
                    />
                  )}
                  {isOverseas && !stylePrompt.trim() && (
                    <div className="text-xs text-[var(--error)]">
                      海外转绘项目必须填写文本转风格提示词后，才能保存并分析。
                    </div>
                  )}
                  <div className="flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleTextToStyle()}
                      loading={styling}
                      progress={styling ? stageProgressValue : undefined}
                      disabled={scriptDraft.trim().length < 10 || !stylePrompt.trim() || saving}
                      className={
                        isOverseas
                          ? "border-[var(--error)]/40 text-[var(--error)] hover:bg-[var(--error)]/8 hover:border-[var(--error)]"
                          : undefined
                      }
                    >
                      {styling ? "转换中..." : "转换风格 · 按实际 Token 结算"}
                    </Button>
                  </div>
                </div>
              </details>
            )}

            {/* 剧本编辑区 */}
            <div>
              <EditorSurface
                title="Script Editor"
                summary="面向长文本录入的剧本编辑器，固定行号栏与正文区对齐，便于逐段校对和定位。"
                meta={
                  <>
                    <input
                      ref={docxInputRef}
                      type="file"
                      accept=".docx"
                      className="hidden"
                      disabled={docxUploading || saving}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleDocxUpload(f);
                        e.target.value = "";
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => docxInputRef.current?.click()}
                      loading={docxUploading}
                      disabled={saving}
                      className="h-auto px-2 py-1 text-[11px] font-medium"
                      title="上传 .docx 文档，解析为纯文本填入编辑框（可再编辑）"
                    >
                      {docxUploading ? "解析中…" : "📄 上传 Word"}
                    </Button>
                    <span className="rounded-lg border border-[var(--border-light)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text-3)]">
                      {scriptDraft.replace(/\r\n/g, "\n").split("\n").length} 行
                    </span>
                    <span className="rounded-lg border border-[var(--border-light)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-[var(--text-3)]">
                      {scriptDraft.length} 字符
                    </span>
                  </>
                }
                footer={
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-[var(--text-3)]">
                      建议按场景、对白、动作分段输入，便于后续分析和镜头提取。
                    </span>
                    <span
                      className={
                        canSave
                          ? "text-[var(--success)]"
                          : isOverseas && !stylePrompt.trim()
                            ? "text-[var(--error)]"
                            : "text-[var(--text-3)]"
                      }
                    >
                      {canSave
                        ? "可以保存"
                        : isOverseas && !stylePrompt.trim()
                          ? "海外转绘项目必须先填写文本转风格"
                          : "至少需要 10 个字符"}
                    </span>
                  </div>
                }
                className="bg-[#0f131b] border-[var(--border-light)]"
                contentClassName="bg-[#0f131b]"
                dark
              >
                <CodeTextarea
                  rows={16}
                  placeholder="粘贴或输入剧本文本（至少 10 个字符）..."
                  value={scriptDraft}
                  onChange={(e) => setScriptDraft(e.target.value)}
                  disabled={saving}
                  className="min-h-[420px] text-white"
                />
              </EditorSurface>
              {docxError && (
                <div className="mt-2 p-2 rounded-lg bg-[var(--error)]/10 text-[var(--error)] text-xs">
                  {docxError}
                </div>
              )}
            </div>
            </div>

            {/* 右栏：常驻操作侧栏（lg+ 可见，sticky） */}
            <aside className="hidden lg:flex flex-col gap-3 sticky top-4 self-start">
              {isOverseas && !usesOriginalProject && (
                <div className="text-xs text-[var(--error)]">
                  海外转绘项目中，"文本转风格"为必选项，保存分析前会自动执行一次。
                </div>
              )}
              <div
                className={`text-xs ${
                  isOverseas && !usesOriginalProject ? "text-[var(--text-2)]" : "text-[var(--text-3)]"
                }`}
              >
                剧本分析{isOverseas && !usesOriginalProject ? "与风格转换" : ""}按实际 Token 结算
              </div>

              {/* 分析任务实时进度（taskId 存在时显示，SSE 驱动） */}
              {analyzeTask.taskId && (
                <GenerationProgress
                  taskId={analyzeTask.taskId}
                  label="AI 编剧分析中"
                  estimatedDuration={90}
                  onComplete={() => {
                    if (episodeId) {
                      // store key 由 useEpisodeTask 终态时自动清，这里不重复清
                    }
                    onRefresh?.({ force: true });
                  }}
                  onFailure={() => onRefresh?.({ force: true })}
                />
              )}

              {/* 风格转换 / 保存进度（瞬时态，非 taskId 驱动） */}
              {(styling || saving || !!stageProgressLabel) && !analyzeTask.taskId && (
                <div className="rounded-lg border border-[var(--action)]/25 bg-[var(--action-dim)]/15 px-3 py-2">
                  <ProgressBar
                    progress={stageProgressValue}
                    label={
                      stageProgressStage ||
                      (styling
                        ? "正在改写目标风格"
                        : "正在提交分析任务")
                    }
                    pulse={stageProgressValue < 100}
                    completed={stageProgressValue >= 100}
                    showPercent
                    size="sm"
                  >
                    <span className="text-[10px] font-mono tabular-nums text-[var(--text-3)]">
                      {stageProgressValue >= 100 ? "完成" : `已用 ${formatElapsed(elapsedSec)}`}
                    </span>
                  </ProgressBar>
                </div>
              )}

              <Button
                variant="primary"
                size="md"
                onClick={() => void handleSaveAndAnalyze()}
                loading={saving}
                progress={saving ? stageProgressValue : undefined}
                disabled={!canSave || !episodeId}
                className="flex items-center gap-1.5 w-full justify-center"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5 13l4 4L19 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                保存并分析
              </Button>

              {inflight.isGenerating && !saving && (
                <p className="text-[10px] text-[var(--text-3)]">
                  上次保存并分析仍在进行（刷新恢复），完成后自动刷新。
                </p>
              )}
            </aside>

            {/* 窄屏降级：底部粘性操作栏（<lg 可见） */}
            <div className="lg:hidden sticky bottom-0 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 bg-[var(--bg)] border-t border-[var(--border-light)] flex items-center gap-3">
              <div className="flex-1 min-w-0">
                {(styling || saving || !!stageProgressLabel) && (
                  <ProgressBar
                    progress={stageProgressValue}
                    label={stageProgressStage ?? (styling ? "正在改写目标风格" : "正在提交分析任务")}
                    pulse={stageProgressValue < 100}
                    completed={stageProgressValue >= 100}
                    showPercent
                    size="sm"
                  />
                )}
                {analyzeTask.taskId && (
                  <GenerationProgress
                    taskId={analyzeTask.taskId}
                    label="AI 编剧分析中"
                    estimatedDuration={90}
                    compact
                    onComplete={() => onRefresh?.({ force: true })}
                    onFailure={() => onRefresh?.({ force: true })}
                  />
                )}
              </div>
              <Button
                variant="primary"
                size="md"
                onClick={() => void handleSaveAndAnalyze()}
                loading={saving}
                progress={saving ? stageProgressValue : undefined}
                disabled={!canSave || !episodeId}
                className="flex items-center gap-1.5 flex-shrink-0"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5 13l4 4L19 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                保存并分析
              </Button>
            </div>
          </div>
        ) : (
          /* 视频转剧本模式（X2：单集 Kimi 视频理解，Kimi-only 砍 Whisper/OCR） */
          <div className="max-w-2xl mx-auto">
            <div className="card p-6">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[var(--bg-hover)] flex items-center justify-center">
                  <svg
                    width="28"
                    height="28"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="text-[var(--accent)]"
                  >
                    <path
                      d="M7 16a4 4 0 01-.88-7.9 5 5 0 019.9-1A4.5 4.5 0 1117 16M9 13l3-3 3 3M12 10v7"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <div>
                  <div className="text-sm font-medium text-[var(--text-2)]">视频转剧本</div>
                  <p className="text-xs text-[var(--text-3)] mt-2 leading-relaxed max-w-sm mx-auto">
                    上传单集视频（≤100MB，MP4/WebM/MOV/MKV），云端 Kimi 视频理解自动生成结构化剧本，
                    写入本集草稿后可在「文本输入」里编辑再保存分析。
                  </p>
                </div>
                {videoError && (
                  <div className="w-full text-xs text-[var(--error)] bg-[var(--error)]/8 rounded px-3 py-2">
                    {videoError}
                  </div>
                )}
                {videoTransportNotice && videoTaskProgress.busy && (
                  <div className="w-full text-xs text-[var(--text-3)] bg-[var(--bg-hover)] rounded px-3 py-2">
                    {videoTransportNotice}
                  </div>
                )}
                {videoTaskProgress.busy ? (
                  <div className="w-full">
                    <ProgressBar
                      progress={videoTaskProgress.progress}
                      label="视频转剧本中"
                      stage={videoTaskProgress.stage}
                      pulse={!videoTaskProgress.completed}
                      completed={videoTaskProgress.completed}
                      showPercent
                    />
                    <p className="mt-2 text-[10px] text-[var(--text-3)]">
                      进度来自服务端真实阶段；上传阶段不虚构字节百分比，完成以剧本成功落库为准。
                    </p>
                  </div>
                ) : videoPreprocessing ? (
                  <div className="w-full text-xs text-[var(--text-3)] bg-[var(--bg-hover)] rounded px-3 py-2 text-center">
                    正在转码到 480p（强制降分辨率，省 token 提速）…
                  </div>
                ) : (
                  <>
                    {/* AI 模型选择：Kimi K2.6（默认）/ K2.7 Code（快）/ K3（旗舰），透传到 route ?model= */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[var(--text-3)] whitespace-nowrap">AI 模型</span>
                      <select
                        value={videoModel}
                        onChange={(e) => setVideoModel(e.target.value)}
                        disabled={!episodeId}
                        className="input-base px-3 py-1.5 rounded-lg text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="视频转剧本 AI 模型"
                      >
                        {VIDEO_TO_SCRIPT_MODELS.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}（{m.hint}）
                          </option>
                        ))}
                      </select>
                    </div>
                    <label
                    className={`mt-1 inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-colors bg-[var(--action)] text-white hover:opacity-90 ${
                      !episodeId ? "opacity-50 cursor-not-allowed pointer-events-none" : "cursor-pointer"
                    }`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M12 16V4M12 4l-4 4M12 4l4 4M4 20h16"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    选择视频文件
                    <input
                      type="file"
                      accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.webm,.mov,.mkv"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleVideoUpload(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  </>
                )}
                {!episodeId && (
                  <div className="text-xs text-[var(--text-3)]">请先选择分集</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
/** 格式化已用秒数为 m:ss（进度态实时计时用）。 */
function formatElapsed(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function readVideoDurationSeconds(file: File): Promise<number | null> {
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const video = document.createElement("video");
      let settled = false;
      const finish = (value: number | null) => {
        if (settled) return;
        settled = true;
        video.removeAttribute("src");
        video.load();
        resolve(value);
      };
      const timer = window.setTimeout(() => finish(null), 10_000);
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        finish(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        finish(null);
      };
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
