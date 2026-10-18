"use client";

/**
 * @file ProductionStage.tsx — 生产阶段（批7.5 完整镜像 app1）
 *
 * 镜像源：F:\app1\src\app\workspace\[projectId]\components\ProductionStage.tsx
 * （2385 行）。本文件是 app1 完整功能的 dramaforge 移植版，覆盖以下能力：
 *
 * ============================================================
 * 已实现项（对照 brief Step 3 清单）
 * ============================================================
 *   P1   顶部大数字进度（无 pill）
 *   P2   一键出片按钮 + 批量下载按钮
 *   P6   ProgressBar 总进度 + ETA 文字
 *   P7   增强提示词卡
 *   P8   一键出片进度卡（ProgressBar + stage + stageProgress）
 *   P9   结果卡（含 <video> 内联预览 + 下载/关闭按钮 + 统计）
 *   P10  提示行（Shift 范围选择说明）
 *   P11  智能成组卡（autoGroup + 组提示词编辑器 EditorSurface + preview +
 *        恢复默认 + 状态徽章 + 组进度 + groupCredits 预估）
 *   P12  单镜头卡（选择框 + 状态图标 + badge + 缩略图 + visualPrompt +
 *        ShotAssetReferenceBadges + 错误信息 + GenerationProgress）
 *   P13  浮动选择操作栏（连续性校验 + 时长档位 + 积分预估 + 清空 + 生成）
 *   P14  一键出片参数弹窗（ModelSelector + 分辨率/比例 select + 固定种子
 *        + 水印 + 末帧 + 模板存/导 JSON；并行/force 暂禁用并明确提示）
 *   P19  ZoomViewer 放大单镜头视频（videoSrc=sf-asset://）
 *   P20  ZoomViewer 放大成片（disableNavigation）
 *   P21  ETA 算法（首次启动 ~4.5min/镜，按实际速度更新）
 *   P25  SSE 处理（useSSE + 事件过滤 → 更新 chainJob / exportJob 状态 +
 *        chainStage / chainStageProgress 细粒度进度）
 *   P26  成片导出（POST /api/projects/[id]/export-film + render_job 跟踪）
 *   P27  一键串生成（POST episode 级 chain-generate route）
 *   P31  参数模板 CRUD（POST/DELETE /api/user/seedance-presets）+
 *        v2 单组 / v1 多组 JSON 导入导出
 *   P33  VideoEditor 编辑器视图（剪映风格三栏）
 *
 * ============================================================
 * dramaforge 架构适配点（GC-7 / dramaforge-is-app1-cs-migration）
 * ============================================================
 *   - **ffmpeg 合片挪 client**：app1 export-film 在 server 合成，dramaforge 挪到
 *     client render-worker（chainCompile orchestrator + executor CONCAT
 *     case）。UI 调 POST /api/.../export-film 只派发 CONCAT render_job；
 *     客户端 render-worker 拉取该 job → ffmpeg.execFfmpegConcat 本机跑 →
 *     写入 filmsDir/<jobId>.mp4 → result.outputUrl = sf-asset://<jobId>.mp4。
 *     服务器零媒体字节（dramaforge-assets-client-local）。
 *   - **媒体落地 sf-asset://**：视频/图片显示走 sf-asset://（Electron 协议）。
 *     "下载 MP4" 走 window.sfShell.saveFilm IPC（sf-asset:// 不能 <a download>）；
 *     dev/browser fallback 用 fetch+blob。
 *   - **组/单镜复用 scoped chain-generate**：app1 成组生成打
 *     /shots/generate-group；dramaforge 统一走 episode 级 chain-generate，但 body.shotIds
 *     精确限定目标范围。整集入口不传 shotIds，组与单镜入口分别传组 ID/单个 ID。
 *   - **组提示词预览改为纯文本服务**：generate-group-preview 只组合镜头、角色、道具
 *     与声音上下文，不调用 AI 或媒体服务；预览失败时仍允许用户手动编辑 prompt。
 *   - **dramaforge 无 reset-status 路由**：SingleShotResetBtn 改用 PATCH /shots/[id]
 *     把 videoStatus 写回 PENDING + 清 currentMaterialUrl。
 *   - **dramaforge 无 batch-update-params 路由**：handleChainGenerateConfirm 跳过
 *     "清空旧 seedanceGroupParams" 步骤（chain-generate route 自身不读旧组
 *     参数，params 透传到每组的 cloud AI body）。
 *   - **force/parallel**：严格模式保留跨组末帧；并行模式固定并发并保持合片顺序；
 *     force=false 复用已完成素材，force=true 才重新生成。
 *   - **dramaforge 云端 key（GC-1）**：删 isProviderReady（永远 ready）。
 *   - **dramaforge 批7 不进 review 流**：保留 isReview prop 形状，行为按 false 走。
 *   - **app1 `@core/*` import（dramaforge 不存在）**：computeGroupsForChain /
 *     splitShotsByAssetLimit / snapToValidDuration / estimateVideoCredits 等
 *     纯函数 inline 实现（从 app1 抽取）。
 *   - **参考图接缝**：路由传本地协议 URL，客户端转 data URL；角色、场景和道具
 *     均可进入视频模型，gridOverlayEnabled 在客户端 ffmpeg 预处理。
 *   - **pencilPaintingMode**：优先复用资产彩铅缓存，并向视频提示词注入彩铅约束。
 *
 * ============================================================
 * 双色铁律（GC-8 dramaforge-frontend-align-app1）
 * ============================================================
 *   - 琥珀色（--accent / --action）用于：组成/进度数字、一键出片按钮、
 *     生成中状态、当前选中。
 *   - 蓝色（app1 是 --action）用于：操作按钮主色。dramaforge 沿用 app1 同款
 *     CSS 变量名 --action（蓝色主操作）+ --accent（琥珀强调）。所有 class
 *     直接复制 app1，变量已在 globals.css 定义。
 */

import * as React from "react";
import { useSSE, trackTaskId, cancelTask } from "../../../../hooks/useTaskStatus";
import {
  setGenerationLock,
  clearGenerationLock,
  useGenerationLockEntry,
} from "../../../../hooks/useGenerationLock";
import { Button } from "../../../../components/ui/Button";
import { ProgressBar } from "../../../../components/ui/ProgressBar";
import { ModelSelector } from "../../../../components/ui/ModelSelector";
import { ZoomViewer, type ZoomItem } from "../../../../components/ui/ZoomViewer";
import { ConfirmDialog } from "../../../../components/ui/ConfirmDialog";
import {
  EditorSurface,
  CodeTextarea,
} from "../../../../components/ui/EditorSurface";
import { useToast } from "../../../../components/ui/Toast";
import { GenerationProgress } from "../../../../components/features/GenerationProgress";
import { VIDEO_MODELS, DEFAULT_VIDEO_MODEL } from "../../../../lib/models";
import { VideoEditor } from "./VideoEditor";
import {
  deriveGeneratingShotIds,
  getEffectiveVideoStatus,
  isActiveChainGeneration,
} from "./production-generation-state";
import { ShotAssetReferenceBadges } from "./ShotAssetReferenceBadges";
import { resolveShotAssetReferenceBindings } from "./shot-asset-reference";
import type { ShotAssetReferenceBinding } from "./shot-asset-reference";
import { estimateSeedanceBilling, type EpisodeRecord } from "@dramaforge/shared";
import { maxDurationForVideoModel } from "@server/domain/prompt/seedance-helpers";
import type { ProjectRecord, ShotRecord, AssetRecord } from "@dramaforge/server";

// ============================================================
// 常量（P14 弹窗 select 选项；云端按 provider 校验/忽略）
// ============================================================

const RESOLUTION_OPTIONS = ["480p", "720p", "1080p", "4k"] as const;
const PRODUCTION_VIDEO_MODELS = VIDEO_MODELS;
const ASPECT_RATIO_OPTIONS = [
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "21:9",
] as const;

/** Seedance 2.0 支持的有效时长档位（秒）— 对齐 app1 @core/ai/group-prompt.ts */
const VALID_DURATIONS = [4, 5, 6, 8, 10, 15] as const;
/** 单组时长上限（秒），Seedance 2.0 单视频上限 */
const MAX_GROUP_DURATION = 15;
/** 视频模型参考图上限（Seedance 等 R2V 模型对参考图数量的硬性限制） */
const MAX_REFERENCE_IMAGES = 9;
/** ETA 默认每镜耗时（秒）— app1 同款估算 */
const ETA_PER_SHOT_SECONDS = 270;
/** 组级 ETA 默认每组耗时（秒）— 实测 ark 组渲染 ~3-8min，取 5min；parallel 按并发分摊。
 *  4945 ep1 12 组 62min、4928 8 组 ~35min 印证；fast 并发4 时 12×300/4=15min 对齐 app1 toast「预计 15-20min」。 */
const AVG_GROUP_SECONDS = 300;

/**
 * 构造 chain-generate 请求体：删除 JSON 中无意义的 undefined，并在子集模式下
 * 原样复制 shotIds。即使误传空数组也保留给 route 明确
 * 拒绝，绝不能退化成整集。
 */
export function buildChainGenerateRequestBody(
  parameters: Readonly<Record<string, unknown>>,
  shotIds?: readonly string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) body[key] = value;
  }
  if (shotIds !== undefined) body.shotIds = [...shotIds];
  return body;
}

/** ProductionStage 参数弹窗的完整可持久化草稿。数值字段保留字符串以允许直接编辑。 */
export interface ProductionParamsDraft {
  useFixedSeed: boolean;
  seed: string;
  resolution: string;
  aspectRatio: string;
  watermark: boolean;
  returnLastFrame: boolean;
  enhancementPrompt: string;
  gridEnabled: boolean;
  gridCells: string;
  gridOpacity: string;
  gridStrokeWidth: string;
  transition: string;
  pencilPaintingMode: boolean;
}

/**
 * 把参数草稿转换为 prepare/chain 共用的请求参数。
 * 超出服务端合同范围的手工输入不写入请求，交给服务端默认值，避免弹窗输入导致 400。
 */
export function buildProductionGenerationParameters(
  draft: Readonly<ProductionParamsDraft>,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (draft.useFixedSeed) {
    const seed = Number(draft.seed);
    if (Number.isFinite(seed)) params.seed = Math.trunc(seed);
  }
  if (draft.resolution) params.resolution = draft.resolution;
  if (draft.aspectRatio) params.aspectRatio = draft.aspectRatio;
  params.watermark = draft.watermark;
  params.returnLastFrame = draft.returnLastFrame;

  const enhancementPrompt = draft.enhancementPrompt.trim();
  if (enhancementPrompt) params.enhancementPrompt = enhancementPrompt;
  params.gridEnabled = draft.gridEnabled;

  // 网格密度：优先取设置页全局滑块（localStorage，app1 式全局控制），缺省回退弹窗 draft。
  // route 仍校验 4-400 / 0-1 / 0.1-10；设置页滑块上限对齐 400，避免越界被 route 400 拒。
  const lsNumber = (key: string): number | undefined => {
    if (typeof window === 'undefined') return undefined;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null || raw === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  };
  const gridCells = lsNumber("gridCells") ?? Number(draft.gridCells);
  if (Number.isInteger(gridCells) && gridCells >= 4 && gridCells <= 400) {
    params.gridCells = gridCells;
  }
  const gridOpacity = lsNumber("gridOpacity") ?? Number(draft.gridOpacity);
  if (Number.isFinite(gridOpacity) && gridOpacity >= 0 && gridOpacity <= 1) {
    params.gridOpacity = gridOpacity;
  }
  const gridStrokeWidth =
    lsNumber("gridStrokeWidth") ?? Number(draft.gridStrokeWidth);
  if (
    Number.isFinite(gridStrokeWidth) &&
    gridStrokeWidth >= 0.1 &&
    gridStrokeWidth <= 10
  ) {
    params.gridStrokeWidth = gridStrokeWidth;
  }
  const transition = draft.transition.trim();
  if (transition) params.transition = transition;
  // C/S 客户端尚未具备 app1 的“参考图先彩铅 I2I 并持久化缓存”协议。
  // 在协议补齐前绝不把这个开关伪装成可用参数；旧客户端显式提交 true 时
  // 服务端也会拒绝，避免把最终视频误生成成彩铅动画。
  return params;
}

const GROUP_PROMPT_SNAPSHOT_VERSION = 2;

export type GroupPromptUiStatus = "MISSING" | "STALE" | "READY";

/** 客户端只做快照结构检查；最终新鲜度仍由 prepare 路由按真实资产上下文判定。 */
export function getGroupPromptUiStatus(
  metadata: unknown,
  shotIds: readonly string[],
): GroupPromptUiStatus {
  const value =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const prompt =
    typeof value.seedanceGroupPrompt === "string"
      ? value.seedanceGroupPrompt.trim()
      : "";
  if (!prompt) return "MISSING";
  const snapshotShotIds = Array.isArray(value.seedanceGroupPromptShotIds)
    ? value.seedanceGroupPromptShotIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  const structurallyReady =
    value.seedanceGroupPromptVersion === GROUP_PROMPT_SNAPSHOT_VERSION &&
    typeof value.seedanceGroupPromptContextHash === "string" &&
    value.seedanceGroupPromptContextHash.length > 0 &&
    snapshotShotIds.length === shotIds.length &&
    snapshotShotIds.every((id, index) => id === shotIds[index]);
  return structurallyReady ? "READY" : "STALE";
}

export function buildUserGroupPromptMetadata(
  prompt: string,
): Record<string, unknown> {
  return {
    seedanceGroupPrompt: prompt,
    seedanceGroupPromptSource: "user",
  };
}

/** 用户认可锁定 / 解锁：只翻 approved 标志，不动 prompt 正文与 hash。 */
export function buildApproveGroupPromptMetadata(
  approve: boolean,
): Record<string, unknown> {
  return {
    seedanceGroupPromptApproved: approve,
    seedanceGroupPromptApprovedAt: approve ? new Date().toISOString() : null,
  };
}

export function buildResetGroupPromptMetadata(): Record<string, unknown> {
  return {
    seedanceGroupPrompt: "",
    seedanceGroupPromptVersion: null,
    seedanceGroupPromptShotIds: [],
    seedanceGroupPromptContextHash: "",
    seedanceGroupPromptSource: null,
    seedanceGroupPromptRewritten: null,
    seedanceGroupPromptApproved: false,
    seedanceGroupPromptApprovedAt: null,
    seedanceGroupPromptUpdatedAt: null,
  };
}

/**
 * 组卡片内联的组提示词编辑器（可编辑 textarea + 保存键）。
 *
 * 替换原只读 <pre>：用户在生产制作的组卡片上直接改提示词、点「保存」即落库
 * source='user'（不调 AI、不 LLM 重写）。生成时 chain-generate 的 source='user'
 * 短路（resolveGroupExecutablePrompt）会原样用此版本。
 *
 * 组卡片是 .map 多组渲染，每组需独立 draft/dirty/saving 状态 → 提取为子组件，
 * 避免在父组件维护 Record<firstShotId, string>。
 *
 * onSave 由父组件实现（构造 PATCH url + buildUserGroupPromptMetadata + onRefresh），
 * 返回是否成功；成功则清 dirty。
 */
function GroupPromptEditor({
  savedPrompt,
  disabled,
  onSave,
}: {
  savedPrompt: string;
  disabled?: boolean;
  onSave: (prompt: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = React.useState(savedPrompt);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // savedPrompt 外部变更（如点「重新生成」AI 重写后、或他人改动）且用户未在编辑 → 同步；
  // 用户正在编辑（dirty）时不覆盖，防冲掉未保存输入。
  const lastSavedRef = React.useRef(savedPrompt);
  React.useEffect(() => {
    if (!dirty && savedPrompt !== lastSavedRef.current) {
      setDraft(savedPrompt);
    }
    lastSavedRef.current = savedPrompt;
  }, [savedPrompt, dirty]);

  const handleSave = async (): Promise<void> => {
    const trimmed = draft.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const ok = await onSave(trimmed);
      if (ok) setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const blocked = disabled || saving;
  return (
    <div className="space-y-1.5">
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
        disabled={blocked}
        rows={5}
        placeholder="提示词将在此显示，可直接编辑后点「保存」。"
        className="w-full resize-y rounded-md border border-[var(--border-light)] bg-[var(--bg-1)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--text-2)] placeholder:text-[var(--text-3)] focus:border-[var(--accent)] focus:outline-none max-h-60 overflow-y-auto"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-[var(--text-3)]">
          {dirty ? "未保存" : "已保存为你的版本，生成时优先使用"}
        </span>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || saving || !draft.trim() || disabled}
          className="btn-primary px-2.5 py-1 rounded-md text-xs whitespace-nowrap disabled:opacity-50"
        >
          {saving ? "保存中…" : "💾 保存"}
        </button>
      </div>
    </div>
  );
}

/**
 * 单张引用资产图缩略图（独立组件承载 img 错误态，保证 Hook 调用位置合法）。
 */
function ReferenceAssetThumb({
  url,
  name,
  index,
}: {
  url: string;
  name: string;
  index: number;
}) {
  const [imgFailed, setImgFailed] = React.useState(false);
  React.useEffect(() => {
    setImgFailed(false);
  }, [url]);
  return (
    <div className="relative h-14 w-14 overflow-hidden rounded border border-[var(--border-light)] bg-[var(--bg-hover)]">
      {url && !imgFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={`${name}-${index + 1}`}
          className="h-full w-full object-contain"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[9px] text-[var(--error)]">
          图缺失
        </div>
      )}
    </div>
  );
}

/**
 * 组提示词上方的「真实引用资产图」条：展示快照里与提交时参考图数组严格同序的
 * 资产图（图片N = refs[N-1]），带变体编号 code 与名称。目的：生产制作时一眼核对
 * "实际运用的目标资产图"是否正确，不用等生成后靠查库发现（24 集 Leo 变体误用教训）。
 * sf-asset:// 在 Electron 内可显示；data:/http 直接显示；加载失败显示「图缺失」占位。
 */
function ReferenceAssetStrip({
  refs,
}: {
  refs: Array<{
    url?: unknown;
    name?: unknown;
    kind?: unknown;
    variantLabel?: unknown;
    variantCode?: unknown;
  }>;
}) {
  if (refs.length === 0) return null;
  return (
    <div className="rounded-md border border-[var(--border-light)] bg-[var(--bg-1)] p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-medium text-[var(--text-3)]">
          真实引用资产图（图片N = 提交顺序，含变体编号）
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {refs.map((ref, index) => {
          const url = typeof ref.url === "string" ? ref.url : "";
          const name = typeof ref.name === "string" ? ref.name : "";
          const code = typeof ref.variantCode === "string" ? ref.variantCode : null;
          const label = typeof ref.variantLabel === "string" ? ref.variantLabel : null;
          return (
            <div
              key={`${index}-${code ?? name ?? url}`}
              className="flex flex-col items-center gap-1"
              title={`${url}\n${name}${label ? `（${label}）` : ""}${code ? ` · ${code}` : ""}`}
            >
              <ReferenceAssetThumb url={url} name={name} index={index} />
              <span className="text-[9px] leading-tight text-[var(--text-3)]">
                图片{index + 1}
                {code ? (
                  <span className="ml-0.5 font-mono text-[var(--accent)]">{code}</span>
                ) : null}
              </span>
              <span className="max-w-14 truncate text-[9px] leading-tight text-[var(--text-2)]">
                {name}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * render_job 成功终态后重新读取服务端 shots。
 *
 * C/S 客户端先上报本地组片，服务器在同一事务内写入镜头状态；前端不能继续只依赖
 * 组件内的旧 props。失败状态不刷新为“已生成”，避免掩盖真实错误。
 */
export function refreshShotsAfterSuccessfulRender(
  status: string,
  onRefresh: () => void,
): boolean {
  if (status !== "COMPLETED") return false;
  onRefresh();
  return true;
}

/** ProductionStage 注入的最小请求签名；只允许读取 UI-facing envelope 路由。 */
type UiApiRequest = (
  url: string,
  options?: RequestInit,
) => Promise<unknown>;

// prepareAndSubmitChainGenerate 已移除（对齐 app1）：app1 是一次提交 chain-generate，
// 组提示词由 worker/route 边生成边自动算存；dramaforge 的 group-prompts/prepare 预跳是自创冗余
// （chain-generate/route.ts:524-538 已在 route 内确定性计算并落库）。前端现在直接 POST
// chain-generate，不再两段式。

/** C/S render_job 经 `/api/tasks/[taskId]` 转换后的 UI 状态视图。 */
export interface RenderTaskStatusSnapshot {
  renderJobId?: string;
  status?: string;
  progress?: number;
  stage?: string;
  /** chain 作业总组数（恢复端点返回）；刷新恢复时用于显示"已完成 X/N 组"。 */
  groupCount?: number;
  result?: unknown;
  error?: string | null;
  /** chain 作业已渐进回传的组片段（来自 task_events）；SSE 断/刷新时轮询据此恢复已完成组视频。 */
  progressClips?: { shotIds: string[]; videoUrl: string }[];
}

/**
 * 读取渲染任务的 UI 状态端点。
 *
 * `/api/render/jobs/*` 是旧客户端 1.1.6 依赖的 M2M 裸 JSON 契约，不能交给
 * useApi 解析；UI 必须改走 envelope 形式的 `/api/tasks/*`，否则 HTTP 200 也会被
 * 当成 `success=false` 并弹出“请求失败”。
 */
export function fetchRenderTaskStatus(
  request: UiApiRequest,
  taskId: string,
): Promise<RenderTaskStatusSnapshot | null> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}`).then((value) =>
    value && typeof value === "object"
      ? (value as RenderTaskStatusSnapshot)
      : null,
  );
}

/** 轮询参数可注入，以便回归测试无需真实等待四秒。 */
interface PollRenderTaskOptions {
  maxAttempts?: number;
  intervalMs?: number;
}

/**
 * 轮询 C/S 渲染任务；SSE 丢事件时以数据库中的 render_job 终态兜底。
 * 已完成或失败后立即停止，避免终态后继续发请求和重复提示。
 */
export async function pollRenderTask(
  taskId: string,
  request: UiApiRequest,
  onUpdate: (
    status: string,
    progress: number,
    stage: string,
    result?: unknown,
    error?: string | null,
    progressClips?: { shotIds: string[]; videoUrl: string }[],
  ) => void,
  options: PollRenderTaskOptions = {},
): Promise<void> {
  // Seedance 排队和生成可能超过五分钟；一小时硬上限覆盖高峰期与模型重试。
  const maxAttempts = options.maxAttempts ?? 900;
  const intervalMs = options.intervalMs ?? 4000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const task = await fetchRenderTaskStatus(request, taskId);
      const status = task?.status;
      if (status) {
        onUpdate(
          status,
          typeof task.progress === "number" ? task.progress : 0,
          task.stage ?? "",
          task.result,
          task.error,
          task.progressClips,
        );
        if (status === "COMPLETED" || status === "FAILED") return;
      }
    } catch {
      // 单次网络失败不中断；下一轮继续从持久状态恢复。
    }
    if (attempt + 1 < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

/**
 * 把渐进回传的组片段应用到 shots（幂等）：SSE progress 事件、4s 轮询、刷新恢复三处共用，
 * 避免三处各自调 onPatchShots 产生漂移。每个 clip 把其 shotIds 的 currentMaterialUrl 翻成
 * videoUrl + videoStatus=COMPLETED；重复 patch 同一 URL 无害。
 */
function applyProgressClips(
  clips: { shotIds: string[]; videoUrl: string }[] | undefined,
  onPatchShots: ((shotIds: string[], patch: Partial<ShotRecord>) => void) | undefined,
): void {
  if (!onPatchShots || !clips || clips.length === 0) return;
  for (const clip of clips) {
    if (!clip || !Array.isArray(clip.shotIds) || clip.shotIds.length === 0) continue;
    if (typeof clip.videoUrl !== "string" || clip.videoUrl.length === 0) continue;
    onPatchShots(clip.shotIds, {
      currentMaterialUrl: clip.videoUrl,
      videoStatus: "COMPLETED",
    });
  }
}

/** 将底层错误翻成用户可行动的原因；原始错误仍在失败卡“技术详情”中保留。 */
export function formatGenerationFailure(error: string | null | undefined): string {
  const value = String(error || '').trim();
  if (!value) return '未收到客户端错误详情';
  if (
    /<(?:!doctype|html|head|body|title|h1)\b/i.test(value) ||
    /\b(?:502 Bad Gateway|nginx\/\d)/i.test(value)
  ) {
    return '云端服务暂时不可用，请稍后重试。';
  }
  if (
    value.includes('InputImageSensitiveContentDetected') ||
    value.toLowerCase().includes('input image may contain real person')
  ) {
    return 'Ark 拒绝了参考图：检测到疑似真人或隐私信息。请更换不含真实人物/隐私信息的角色参考图，或改用允许此类参考图的模型。';
  }
  if (value.toLowerCase().includes('fetch failed')) {
    return 'AI 服务网络请求失败（fetch failed）。请稍后重试；若持续出现，请检查 Ark 接口连通性。';
  }
  return value.replace(/^chainCompile:\s*/i, '').slice(0, 600);
}

// ============================================================
// 纯函数（inline 自 app1，因 dramaforge server 未导出 web 用版本）
// ============================================================

/**
 * 将时长映射到最接近的 Seedance 有效档位。
 * 镜像 app1 snapToValidDuration（server/src/domain/prompt/seedance-helpers.ts:46）。
 */
function snapToValidDuration(totalSec: number): number {
  let best: number = VALID_DURATIONS[0];
  let bestDiff = Math.abs(totalSec - best);
  for (const d of VALID_DURATIONS) {
    const diff = Math.abs(totalSec - d);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = d;
    }
  }
  return best;
}

/** 单镜时长归一化（默认 5s；非档位时取最近档） */
function normalizeSingleShotDuration(
  seconds: number | null | undefined,
): number {
  const rounded = Math.round(Number(seconds || 0));
  return (VALID_DURATIONS as readonly number[]).includes(rounded) ? rounded : 5;
}

/** 组时长归一化（超 15s 截到 15，否则 snap 到最近档） */
function normalizeGroupDuration(seconds: number): number {
  return seconds > MAX_GROUP_DURATION + 0.05
    ? MAX_GROUP_DURATION
    : snapToValidDuration(seconds);
}

/**
 * 提取镜头的分组键（"sceneId#groupIndex"）。
 * 镜像 app1 grouping.ts:51 — 读 metadata.storyboardTable.groupIndex / groupIndex
 * + metadata.sceneId / storyboardTable.sceneId，未分组返 null。
 */
function getGroupKey(shot: ShotRecord): string | null {
  const meta = (shot.metadata ?? {}) as Record<string, unknown>;
  const storyboardTable = (meta.storyboardTable ?? {}) as Record<
    string,
    unknown
  >;
  const gIdxRaw = storyboardTable.groupIndex ?? meta.groupIndex;
  const gIdx = typeof gIdxRaw === "number" ? gIdxRaw : -1;
  if (gIdx < 0) return null;
  const sceneId =
    (typeof meta.sceneId === "string" && meta.sceneId) ||
    (typeof storyboardTable.sceneId === "string" &&
      storyboardTable.sceneId) ||
    "unknown";
  return `${sceneId}#${gIdx}`;
}

/** 镜头时长（秒），缺失默认 2 秒（与 app1 grouping.ts:67 一致） */
function getShotDuration(shot: ShotRecord): number {
  return shot.durationSeconds || 2;
}

/** 镜头分组信息（与 app1 GroupInfo 对齐） */
interface GroupInfo {
  shotIds: string[];
  totalDuration: number;
  validDuration: number;
  groupLabel: string;
}

/**
 * 串联一键生成的镜头分组算法（三阶段：贪心填充 → 超长拆分 → 合并）。
 * 镜像 app1 @core/ai/grouping.ts:111 computeGroupsForChain —— dramaforge server
 * 未导出 web 用版本，inline 移植。
 *
 * 约束：单组 ≤ 15s（Seedance 硬上限）；相邻组合计 ≤15s 即贪婪合并（压满 15s，无最低镜数）。
 */
function computeGroupsForChain(shotList: ShotRecord[], maxGroupDuration: number = MAX_GROUP_DURATION): GroupInfo[] {
  // 阶段 1：按 groupIndex 预分组 + 未分组镜头贪心装箱
  const groupMap = new Map<string, ShotRecord[]>();
  const ungrouped: ShotRecord[] = [];

  for (const shot of shotList) {
    const key = getGroupKey(shot);
    if (key !== null) {
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(shot);
    } else {
      ungrouped.push(shot);
    }
  }

  if (ungrouped.length > 0) {
    ungrouped.sort((a, b) => a.sortOrder - b.sortOrder);
    let autoIdx = 0;
    let autoDur = 0;
    let autoShots = 0;
    let autoKey = `auto#${autoIdx}`;
    for (const shot of ungrouped) {
      const dur = getShotDuration(shot);
      if (autoShots > 0 && autoDur + dur > maxGroupDuration + 0.05) {
        autoIdx++;
        autoKey = `auto#${autoIdx}`;
        autoDur = 0;
        autoShots = 0;
      }
      if (!groupMap.has(autoKey)) groupMap.set(autoKey, []);
      groupMap.get(autoKey)!.push(shot);
      autoDur += dur;
      autoShots++;
    }
  }

  // 阶段 2：超长拆分
  const splitMap = new Map<string, ShotRecord[]>();
  let splitIdx = 0;
  for (const [gKey, shots] of groupMap) {
    const sorted = [...shots].sort((a, b) => a.sortOrder - b.sortOrder);
    const totalDur = sorted.reduce((acc, s) => acc + getShotDuration(s), 0);
    if (totalDur <= maxGroupDuration + 0.05) {
      splitMap.set(gKey, sorted);
    } else {
      let subDur = 0;
      let subCount = 0;
      let subGroup: ShotRecord[] = [];
      for (const shot of sorted) {
        const dur = getShotDuration(shot);
        if (subCount > 0 && subDur + dur > maxGroupDuration + 0.05) {
          splitMap.set(`${gKey}-split${splitIdx++}`, subGroup);
          subGroup = [];
          subDur = 0;
          subCount = 0;
        }
        subGroup.push(shot);
        subDur += dur;
        subCount++;
      }
      if (subGroup.length > 0) {
        splitMap.set(`${gKey}-split${splitIdx++}`, subGroup);
      }
    }
  }

  // 阶段 3：合并 — 相邻组只要合计 ≤15s 即贪婪合并（无最低镜数门槛，压满 15s）
  interface MergeEntry {
    key: string;
    shots: ShotRecord[];
    duration: number;
    firstOrder: number;
  }
  let mergeEntries: MergeEntry[] = [...splitMap.entries()]
    .map(([key, shots]) => {
      const sorted = [...shots].sort((a, b) => a.sortOrder - b.sortOrder);
      return {
        key,
        shots: sorted,
        duration: sorted.reduce((acc, s) => acc + getShotDuration(s), 0),
        firstOrder:
          sorted.length > 0
            ? Math.min(...sorted.map((s) => s.sortOrder))
            : 0,
      };
    })
    .sort((a, b) => a.firstOrder - b.firstOrder);

  let merged = true;
  let safety = 0;
  while (merged && mergeEntries.length > 1 && safety < 50) {
    merged = false;
    safety++;
    for (let i = 0; i < mergeEntries.length; i++) {
      const canMergeNext =
        i + 1 < mergeEntries.length &&
        mergeEntries[i].duration + mergeEntries[i + 1].duration <=
          maxGroupDuration + 0.05;
      const canMergePrev =
        i - 1 >= 0 &&
        mergeEntries[i - 1].duration + mergeEntries[i].duration <=
          maxGroupDuration + 0.05;
      if (canMergeNext) {
        mergeEntries[i + 1].shots = [
          ...mergeEntries[i].shots,
          ...mergeEntries[i + 1].shots,
        ];
        mergeEntries[i + 1].duration += mergeEntries[i].duration;
        mergeEntries[i + 1].firstOrder = Math.min(
          mergeEntries[i].firstOrder,
          mergeEntries[i + 1].firstOrder,
        );
        mergeEntries.splice(i, 1);
        merged = true;
        break;
      }
      if (canMergePrev) {
        mergeEntries[i - 1].shots = [
          ...mergeEntries[i - 1].shots,
          ...mergeEntries[i].shots,
        ];
        mergeEntries[i - 1].duration += mergeEntries[i].duration;
        mergeEntries.splice(i, 1);
        merged = true;
        break;
      }
    }
  }

  // 输出阶段
  const groups: GroupInfo[] = [];
  const seenShotIds = new Set<string>();
  mergeEntries.forEach((entry, globalIdx) => {
    const sorted = entry.shots;
    const sum = entry.duration;
    const valid = snapToValidDuration(sum);
    // 组标签用纯序号（镜头组1/2/3…），不再用"高潮组/推进组"这类语义名——
    // 一个分镜组拆成多个渲染组时语义名会重复、且和具体镜头对不上，徒增困惑。
    const label = `镜头组${globalIdx + 1}`;
    const dedupShotIds: string[] = [];
    const groupShotIndices: number[] = [];
    for (const s of sorted) {
      if (seenShotIds.has(s.id)) continue;
      seenShotIds.add(s.id);
      dedupShotIds.push(s.id);
      if (typeof s.shotIndex === "number") groupShotIndices.push(s.shotIndex);
    }
    // 组标签带具体镜头号（镜头 40-42 / 镜头 43），避免一个分镜组拆成多个渲染组时
    // 只凭"高潮组 · 3镜"分不清哪个组覆盖哪些镜头、看不到自己编辑的台词。
    const sortedIdx = [...groupShotIndices].sort((a, b) => a - b);
    const rangeLabel =
      sortedIdx.length === 0
        ? `${dedupShotIds.length}镜`
        : sortedIdx.length === 1
          ? `镜头 ${sortedIdx[0]}`
          : sortedIdx[sortedIdx.length - 1] - sortedIdx[0] + 1 === sortedIdx.length
            ? `镜头 ${sortedIdx[0]}-${sortedIdx[sortedIdx.length - 1]}`
            : `镜头 ${sortedIdx.join("、")}`;
    groups.push({
      shotIds: dedupShotIds,
      totalDuration: Math.round(sum * 10) / 10,
      validDuration: valid,
      groupLabel: `${label} · ${rangeLabel}（${dedupShotIds.length}镜）`,
    });
  });
  return groups;
}

/**
 * 按 Seedance 参考图上限顺序拆分镜头组（一组可能拆成多个独立视频任务）。
 *
 * 计数使用镜头真正绑定的角色/场景/道具资产，而不是按镜头数猜测。这样前端
 * 积分预估和服务端自动拆组的语义一致，也不会因为同一资产被多镜复用而多算。
 * 单镜若自身超过上限仍保留为一组，交给服务端返回可定位的资产校验错误。
 */
function splitShotsByAssetLimit(
  shots: ShotRecord[],
  assets: AssetRecord[],
): ShotRecord[][] {
  if (shots.length === 0) return [];
  const groups: ShotRecord[][] = [];
  let current: ShotRecord[] = [];
  let currentReferences = new Set<string>();

  for (const shot of shots) {
    const shotReferences = new Set(
      getShotAssetReferenceBindings(shot, assets, shot.projectId).map(
        (binding) => `${binding.kind}:${binding.assetId ?? binding.name}`,
      ),
    );
    const mergedReferences = new Set([
      ...currentReferences,
      ...shotReferences,
    ]);
    if (
      current.length > 0 &&
      mergedReferences.size > MAX_REFERENCE_IMAGES
    ) {
      groups.push(current);
      current = [];
      currentReferences = new Set<string>();
    }
    current.push(shot);
    for (const reference of shotReferences) currentReferences.add(reference);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// ============================================================
// 积分预估（Seedance 精确公式共享自 shared，避免 UI 与服务器账单漂移）
// ============================================================

/**
 * 把平台成本元换算为积分（1 积分 = 0.1 元，并按 app1 乘 1.2 加价系数）。
 * 镜像 app1 @core/billing/estimate.ts yuanToCredits + formatCredits。
 */
function formatCredits(credits: number): string {
  if (!Number.isFinite(credits) || credits <= 0) return "0";
  return String(Math.ceil(credits));
}

/**
 * 视频生成积分预估：Seedance 按 app1 的像素 token 公式和分档费率；其他模型退回目录秒价。
 */
function estimateVideoGenerationCredits(
  modelId: string,
  durationSeconds: number,
  count: number,
  _opts?: { resolution?: string; hasVideoInput?: boolean },
): number {
  const cost = estimateVideoGenerationCostYuan(modelId, durationSeconds, _opts);
  // app1 对同一请求的总原始成本乘数量后只向上取整一次。
  return Math.ceil(cost * Math.max(1, count) * 12);
}

/** 返回单个视频请求的平台原始成本，供组合任务统一汇总后结算。 */
function estimateVideoGenerationCostYuan(
  modelId: string,
  durationSeconds: number,
  opts?: { resolution?: string; hasVideoInput?: boolean },
): number {
  const seedance = estimateSeedanceBilling(modelId, {
    duration: Math.max(1, durationSeconds),
    resolution: opts?.resolution,
    ...(opts?.hasVideoInput ? { referenceVideoUrls: ['estimate-only'] } : {}),
  });
  if (seedance) return seedance.cost;
  const model = VIDEO_MODELS.find((m) => m.id === modelId);
  const perSecond = model?.pricing?.perSecondVideo;
  if (!perSecond || perSecond <= 0) return 0;
  return perSecond * Math.max(1, durationSeconds);
}

/**
 * Chain 生成积分预估：所有子任务 raw cost 汇总后向上取整一次。
 * 镜像 app1 estimateCombinedVideoTaskCredits。
 */
function estimateCombinedVideoTaskCredits(
  requests: Array<{
    modelId: string;
    durationSeconds: number;
    resolution?: string;
    hasVideoInput?: boolean;
  }>,
): number {
  const totalYuan = requests.reduce(
    (sum, r) =>
      sum +
      estimateVideoGenerationCostYuan(
        r.modelId,
        r.durationSeconds,
        { resolution: r.resolution, hasVideoInput: r.hasVideoInput },
      ),
    0,
  );
  // 组合任务与 app1 一致：先汇总原始人民币成本，再做一次 20% 成本加价和积分取整。
  return Math.ceil(totalYuan * 12);
}

// ============================================================
// 工具
// ============================================================

function getChainGenerationLockKey(
  projectId: string,
  episodeId?: string,
): string {
  return `chain:${projectId}:${episodeId || "project"}`;
}

/**
 * 解析单镜头引用的标准资产（包装 resolveShotAssetReferenceBindings）。
 * 与 app1 getShotAssetReferenceBindings 等价。
 */
function getShotAssetReferenceBindings(
  shot: ShotRecord,
  assets: AssetRecord[],
  projectId: string,
): ShotAssetReferenceBinding[] {
  const metadata =
    shot.metadata && typeof shot.metadata === "object"
      ? (shot.metadata as Record<string, unknown>)
      : {};
  const savedBindings = Array.isArray(metadata.assetReferenceBindings)
    ? (metadata.assetReferenceBindings as ShotAssetReferenceBinding[])
    : [];
  if (savedBindings.length > 0) return savedBindings;
  return resolveShotAssetReferenceBindings(
    {
      referencedAssets: shot.referencedAssets,
      metadata,
    },
    assets,
    projectId,
  );
}

// ============================================================
// SingleShotResetBtn — 单镜状态重置（dramaforge 用 PATCH /shots/[id]）
// ============================================================

/**
 * 单镜头状态重置按钮
 *
 * dramaforge 适配：app1 打 POST /shots/reset-status，dramaforge 无该路由，改用 PATCH
 * /episodes/[episodeId]/shots/[shotId] 把 videoStatus 写回 PENDING +
 * 清 currentMaterialUrl + errorMessage。视觉/UI 与 app1 一致。
 */
export function SingleShotResetBtn({
  shotId,
  api,
  projectId,
  episodeId,
  onRefresh,
  shotLabel,
}: {
  shotId: string;
  api: (url: string, options?: RequestInit) => Promise<unknown>;
  projectId: string;
  episodeId?: string;
  onRefresh: () => void;
  shotLabel: string;
}) {
  const [resetting, setResetting] = React.useState(false);
  const toast = useToast();

  const handleReset = async () => {
    setResetting(true);
    try {
      // dramaforge 适配：用 PATCH /shots/[shotId] 把状态写回 PENDING（无 reset-status 路由）
      const url = episodeId
        ? `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/shots/${encodeURIComponent(shotId)}`
        : `/api/projects/${encodeURIComponent(projectId)}/episodes/_/shots/${encodeURIComponent(shotId)}`;
      await api(url, {
        method: "PATCH",
        body: JSON.stringify({
          videoStatus: "PENDING",
          currentMaterialUrl: null,
          errorMessage: null,
        }),
      });
      toast.success(`已重置 ${shotLabel}`);
      onRefresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "未知错误";
      toast.error(`重置失败: ${msg}`);
    }
    setResetting(false);
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleReset}
      loading={resetting}
      className="w-full text-[var(--warning)] hover:bg-[var(--warning-dim)]"
      title={`重置 ${shotLabel} 状态为待生成`}
    >
      {resetting ? "重置中" : (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="M1 4v6h6M23 20v-6h-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          重置
        </>
      )}
    </Button>
  );
}

// ============================================================
// Props
// ============================================================

export interface ProductionStageProps {
  projectId: string;
  episodeId?: string;
  shots: ShotRecord[];
  episode: EpisodeRecord;
  assets: AssetRecord[];
  project?: ProjectRecord | null;
  api: (url: string, options?: RequestInit) => Promise<unknown>;
  onRefresh: () => void;
  /** 渐进回传:按 shotIds 乐观打 patch 到父组件 shots(某组视频刚完成即显示,不等整链)。 */
  onPatchShots?: (shotIds: string[], patch: Partial<ShotRecord>) => void;
  /** 成片导出/串生成完成时回调，父组件可跳转成片库（批8 接通，批7 保留） */
  onNavigateToFilms?: (taskId: string) => void;
  /** 视频模型 + setter（与 EpisodeWorkspace ModelSelector bar 双向） */
  videoModel: string;
  setVideoModel: (id: string) => void;
  /** dramaforge 批7 不进 review 流（保留 prop 对齐 app1 形状） */
  isReview?: boolean;
}

// ============================================================
// 组件
// ============================================================

export function ProductionStage({
  projectId,
  episodeId,
  shots,
  episode,
  project,
  assets,
  api,
  onRefresh,
  onPatchShots,
  onNavigateToFilms,
  videoModel,
  setVideoModel,
  isReview = false,
}: ProductionStageProps) {
  const toast = useToast();
  const { events } = useSSE();
  // ============================================================
  // 派生：completedShots / progress
  // ============================================================
  const completedShots = shots.filter(
    (s) => s.videoStatus === "COMPLETED" && !!s.currentMaterialUrl,
  ).length;
  const progress =
    shots.length > 0
      ? Math.round((completedShots / shots.length) * 100)
      : 0;
  // ============================================================
  // 视图模式（list / editor — P33 VideoEditor）
  // ============================================================
  const [viewMode, setViewMode] = React.useState<"list" | "editor">("list");

  // ============================================================
  // 增强提示词（P7；localStorage 持久化，对齐 app1 page.tsx:148-157）
  // ============================================================
  const [enhancementCollapsed, setEnhancementCollapsed] =
    React.useState(false);
  const [enhancementEditing, setEnhancementEditing] = React.useState(false);
  const [enhancementDraft, setEnhancementDraft] = React.useState("");
  const [enhancementPrompt, setEnhancementPrompt] = React.useState(() => {
    if (typeof window === "undefined") return "";
    try {
      // 对齐 app1 page.tsx productionEnhancementPrompt 默认值（保脸/抗审核）：
      // 平滑皮肤、无覆盖性线条——既对抗网格叠加在脸上画的覆盖性线条，也降低 ark
      // 真人审核把角色参考图判成“real person”的概率。用户改过后以 localStorage 为准。
      return (
        localStorage.getItem(`productionEnhance_${projectId}`) ||
        "人物完整平滑的皮肤与面料纹理，无覆盖性线条。"
      );
    } catch {
      return "";
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(
        `productionEnhance_${projectId}`,
        enhancementPrompt,
      );
    } catch {
      // 静默
    }
  }, [projectId, enhancementPrompt]);

  // ============================================================
  // 串生成 state（P8/P9/P25/P27）
  // ============================================================
  const [chainJob, setChainJob] = React.useState<{
    renderJobId: string;
    taskId: string;
    status: string;
    progress: number;
    stage: string;
    stageProgress: number;
    /** 本次链需生成的组数（dispatch 返回 groupCount；含被复用的瞬时组）。用于 P8 组级 ETA。 */
    groupCount?: number;
    error?: string | null;
    /** undefined 表示整集任务；数组表示组/单镜子集。 */
    targetShotIds?: string[];
  } | null>(null);
  /**
   * render_job 会先进入运行态，镜头行稍后才持久化 GENERATING。
   * 这段间隙以 chainJob 的目标范围为准，避免卡片仍显示“待生成”。
   */
  const generatingShots = React.useMemo(
    () => deriveGeneratingShotIds(shots, chainJob),
    [shots, chainJob],
  );
  const [chainSubmitting, setChainSubmitting] = React.useState(false);
  const [chainSubmissionProgress, setChainSubmissionProgress] =
    React.useState(0);
  /** 串生成结果卡（P9）：filmUrl 来自 render_job.result.outputUrl(sf-asset://) */
  const [chainResult, setChainResult] = React.useState<{
    filmUrl: string;
    localKey?: string;
    totalGroups?: number;
    totalShots?: number;
    totalDuration?: number;
    reusedGroups?: number;
    generatedGroups?: number;
    failedGroups?: number;
    partialCompleted?: boolean;
    /** @deprecated 语义 = reusedGroups，保留兼容旧客户端上报 */
    skippedGroups?: number;
  } | null>(null);
  const chainLockKey = React.useMemo(
    () => getChainGenerationLockKey(projectId, episodeId || undefined),
    [episodeId, projectId],
  );
  const persistedChainLock = useGenerationLockEntry(chainLockKey);
  const chainHandledEventsRef = React.useRef<Set<string>>(new Set());
  const chainFailureNotifiedTaskRef = React.useRef<string | null>(null);

  // ============================================================
  // 成片导出 state（P26 export-film）
  // ============================================================
  const [exportJob, setExportJob] = React.useState<{
    renderJobId: string;
    taskId: string;
    status: string;
    progress: number;
    stage: string;
  } | null>(null);
  const [exportSubmitting, setExportSubmitting] = React.useState(false);
  const [batchDownloadProgress, setBatchDownloadProgress] = React.useState<{
    done: number;
    total: number;
  } | null>(null);
  const exportHandledEventsRef = React.useRef<Set<string>>(new Set());

  // ============================================================
  // ZoomViewer state（P19/P20）
  // ============================================================
  const [videoZoomIndex, setVideoZoomIndex] = React.useState(-1);
  // 组提示词审核：正在跑 finalize（生成最终提示词）的组首镜 id，用于按钮 loading 态。
  const [finalizingFirstShotId, setFinalizingFirstShotId] = React.useState<string | null>(null);
  const [filmZoomOpen, setFilmZoomOpen] = React.useState(false);

  // ============================================================
  // 多镜头选择（P13）
  // ============================================================
  const [selectedShotIds, setSelectedShotIds] = React.useState<Set<string>>(
    new Set(),
  );
  const [lastClickedShotId, setLastClickedShotId] = React.useState<
    string | null
  >(null);
  const toggleShotSelection = (shotId: string, shiftKey: boolean = false) => {
    if (shiftKey && lastClickedShotId) {
      const sortedShots = [...shots].sort((a, b) => a.sortOrder - b.sortOrder);
      const startIdx = sortedShots.findIndex((s) => s.id === lastClickedShotId);
      const endIdx = sortedShots.findIndex((s) => s.id === shotId);
      if (startIdx >= 0 && endIdx >= 0) {
        const from = Math.min(startIdx, endIdx);
        const to = Math.max(startIdx, endIdx);
        const rangeIds = sortedShots.slice(from, to + 1).map((s) => s.id);
        setSelectedShotIds((prev) => {
          const next = new Set(prev);
          const allSelected = rangeIds.every((id) => next.has(id));
          if (allSelected) {
            rangeIds.forEach((id) => next.delete(id));
          } else {
            rangeIds.forEach((id) => next.add(id));
          }
          return next;
        });
        return;
      }
    }
    setSelectedShotIds((prev) => {
      const next = new Set(prev);
      if (next.has(shotId)) {
        next.delete(shotId);
      } else {
        next.add(shotId);
      }
      return next;
    });
    setLastClickedShotId(shotId);
  };

  /** 选中镜头是否连续（sortOrder 顺序无间隙） */
  const isSelectionConsecutive = (): boolean => {
    if (selectedShotIds.size <= 1) return true;
    const sortedShots = [...shots].sort((a, b) => a.sortOrder - b.sortOrder);
    const selectedIndices = sortedShots
      .map((s, i) => (selectedShotIds.has(s.id) ? i : -1))
      .filter((i) => i >= 0);
    if (selectedIndices.length <= 1) return true;
    for (let i = 1; i < selectedIndices.length; i++) {
      if (selectedIndices[i] !== selectedIndices[i - 1] + 1) return false;
    }
    return true;
  };

  /** 选中镜头总时长 + 档位对齐 + 是否超限 */
  const getSelectionDuration = (): {
    total: number;
    valid: number;
    overLimit: boolean;
  } => {
    const selectedShots = shots.filter((s) => selectedShotIds.has(s.id));
    const total = selectedShots.reduce(
      (acc, s) => acc + (s.durationSeconds || 2),
      0,
    );
    const roundedTotal = Math.round(total * 10) / 10;
    const overLimit = total > maxGroupDuration + 0.05;
    return {
      total: roundedTotal,
      valid: overLimit ? maxGroupDuration : snapToValidDuration(total),
      overLimit,
    };
  };

  const clearSelection = () => {
    setSelectedShotIds(new Set());
    setLastClickedShotId(null);
  };

  // ============================================================
  // 智能成组（P11）+ 组提示词编辑器 state
  // ============================================================
  // 组划分上限跟随所选模型条目（2026-08-12：Seedance 2.5 双条目——
  // 「30秒·合并组」按 30s 合并镜头组，「仅换模型」保持 15s 不合并）。
  const selectedVideoModel = VIDEO_MODELS.find((m) => m.id === videoModel);
  const maxGroupDuration = Math.min(
    selectedVideoModel?.maxDuration ?? MAX_GROUP_DURATION,
    maxDurationForVideoModel(videoModel.split(":")[0]),
  );
  const productionGroups = React.useMemo(
    () => computeGroupsForChain(shots, maxGroupDuration),
    [shots, maxGroupDuration],
  );
  // 组提示词预览/编辑已合并入"成组生成参数"弹窗（A 方案：消除卡片"生成提示词"与
  // 弹窗"整合并生成"双入口冲突）。原 inline EditorSurface + 三个 handler 已移除。
  const [dialogPromptDraft, setDialogPromptDraft] = React.useState("");
  const [dialogPromptDirty, setDialogPromptDirty] = React.useState(false);
  const [dialogPromptLoading, setDialogPromptLoading] = React.useState(false);
  const [groupPromptCollapsed, setGroupPromptCollapsed] = React.useState(true);

  // ============================================================
  // 参数弹窗 state（P14 — chain + group 共用 draft）
  // ============================================================
  const [chainParamsDialogOpen, setChainParamsDialogOpen] =
    React.useState(false);
  const [groupParamsDialogOpen, setGroupParamsDialogOpen] =
    React.useState(false);
  /** 成组生成弹窗的目标 shotIds（仅 group 模式使用） */
  const [groupParamsTargetShotIds, setGroupParamsTargetShotIds] =
    React.useState<string[]>([]);
  const [paramsDraft, setParamsDraft] = React.useState<ProductionParamsDraft>({
    useFixedSeed: false,
    seed: "42",
    resolution: "480p",
    aspectRatio: "9:16",
    watermark: false,
    returnLastFrame: false,
    enhancementPrompt: "",
    gridEnabled: false,
    gridCells: "100",
    gridOpacity: "0.6",
    gridStrokeWidth: "1",
    transition: "",
    pencilPaintingMode: false,
  });

  // 严格与并行是两种真实执行策略；并行数受客户端和服务端共同限制为 1-12。
  const [chainForce, setChainForce] = React.useState(false);
  const [chainMode, setChainMode] = React.useState<"strict" | "fast">("strict");
  const [chainConcurrency, setChainConcurrency] = React.useState(3);

  // ============================================================
  // 参数模板 state（P31）
  // ============================================================
  const [presets, setPresets] = React.useState<
    Array<{
      id: string;
      name: string;
      params: Record<string, unknown>;
      isDefault: boolean;
      updatedAt: string;
    }>
  >([]);
  const [savePresetDialog, setSavePresetDialog] = React.useState<{
    open: boolean;
    name: string;
    params: Record<string, unknown> | null;
  }>({ open: false, name: "", params: null });
  const importFileRef = React.useRef<HTMLInputElement | null>(null);
  const [selectedPresetId, setSelectedPresetId] = React.useState<string>("");

  /** 从已保存参数（模板或 metadata）初始化弹窗 draft */
  const initParamsDraft = (saved: unknown) => {
    const s = (saved ?? {}) as Record<string, unknown>;
    setParamsDraft({
      useFixedSeed: s.seed !== undefined && s.seed !== null,
      seed:
        s.seed !== undefined && s.seed !== null ? String(s.seed) : "42",
      resolution:
        typeof s.resolution === "string" && s.resolution
          ? s.resolution
          : "480p",
      aspectRatio:
        typeof s.aspectRatio === "string" && s.aspectRatio
          ? (s.aspectRatio as string)
          : "9:16",
      watermark: s.watermark === true,
      returnLastFrame: s.returnLastFrame === true,
      enhancementPrompt:
        typeof s.enhancementPrompt === "string"
          ? s.enhancementPrompt
          : enhancementPrompt,
      gridEnabled: s.gridEnabled === true,
      gridCells:
        typeof s.gridCells === "number" || typeof s.gridCells === "string"
          ? String(s.gridCells)
          : "100",
      gridOpacity:
        typeof s.gridOpacity === "number" || typeof s.gridOpacity === "string"
          ? String(s.gridOpacity)
          : "0.6",
      gridStrokeWidth:
        typeof s.gridStrokeWidth === "number" ||
        typeof s.gridStrokeWidth === "string"
          ? String(s.gridStrokeWidth)
          : "1",
      transition:
        typeof s.transition === "string" ? s.transition : "",
      pencilPaintingMode: false,
    });
  };

  /** 构造提交参数对象（仅含用户显式设置的项；返回 null 表示全用默认值） */
  const buildParamsToSave = (): Record<string, unknown> | null => {
    const params = buildProductionGenerationParameters(paramsDraft);
    return Object.keys(params).length > 0 ? params : null;
  };

  // ============================================================
  // 单镜重制确认（P12 — regenerateConfirmShotId）
  // ============================================================
  const [regenerateConfirmShotId, setRegenerateConfirmShotId] = React.useState<
    string | null
  >(null);

  // ============================================================
  // ETA 算法（P21，照搬 app1:378-436）
  // ============================================================
  const chainStartRef = React.useRef<number | null>(null);
  const prevCompletedRef = React.useRef(completedShots);
  const [etaSec, setEtaSec] = React.useState<number | null>(null);

  React.useEffect(() => {
    const isRunning = isActiveChainGeneration(chainJob);

    if (isRunning && chainStartRef.current === null) {
      chainStartRef.current = Date.now();
      prevCompletedRef.current = completedShots;
    }
    if (!isRunning && chainStartRef.current !== null) {
      chainStartRef.current = null;
      setEtaSec(null);
      return;
    }
    if (!chainStartRef.current || shots.length === 0) return;

    const interval = setInterval(() => {
      const elapsed = Date.now() - chainStartRef.current!;
      const doneCount = completedShots;
      const totalShots = shots.length;
      if (doneCount <= 0 || elapsed < 2000) {
        const remaining = totalShots - doneCount;
        setEtaSec(remaining * ETA_PER_SHOT_SECONDS);
        return;
      }
      const doneSinceStart = doneCount - prevCompletedRef.current;
      if (doneSinceStart <= 0) return;
      const msPerShot = elapsed / doneSinceStart;
      const remaining = totalShots - doneCount;
      setEtaSec(Math.max(1, Math.round((msPerShot * remaining) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [chainJob, completedShots, shots.length]);

  const formatEta = (sec: number | null): string | null => {
    if (sec === null || sec <= 0) return null;
    if (chainJob === null) return null;
    if (sec < 60) return `约 ${sec} 秒`;
    return `约 ${Math.ceil(sec / 60)} 分钟`;
  };

  // ============================================================
  // 组级 ETA（P8 转圈卡）— chainMode 逐镜不回写 shot 状态（G3 链完成才批量回写），
  // 故上面 shot-based 的 etaSec 在生成期间冻结。改用 live 的组级 chainJob.progress
  // （5-85%，SSE 实时）+ 已用时算剩余。复用 chainStartRef，镜像 shot-ETA 的 1s ticker。
  // 冷启动：total×AVG_GROUP_SECONDS/并发（参数感知）；有进度后：elapsed×(1-effProg)/effProg 自校正。
  // ============================================================
  const [chainEtaSec, setChainEtaSec] = React.useState<number | null>(null);
  const chainGroupProgress = React.useMemo<{ total: number | null; done: number | null }>(() => {
    const total = chainJob?.groupCount;
    if (!total) return { total: null, done: null };
    const effProg = Math.min(1, Math.max(0, ((chainJob?.progress ?? 0) - 5) / 80));
    return { total, done: Math.round(effProg * total) };
  }, [chainJob?.groupCount, chainJob?.progress]);

  React.useEffect(() => {
    const isRunning = isActiveChainGeneration(chainJob);
    if (!isRunning || !chainStartRef.current) {
      setChainEtaSec(null);
      return;
    }
    const total = chainJob?.groupCount;
    const effProg = Math.min(1, Math.max(0, ((chainJob?.progress ?? 0) - 5) / 80));
    const tick = () => {
      const elapsed = (Date.now() - chainStartRef.current!) / 1000;
      let eta: number | null;
      if (effProg > 0.03 && elapsed > 2) {
        eta = Math.round((elapsed * (1 - effProg)) / effProg);
      } else if (total) {
        eta = Math.round((total * AVG_GROUP_SECONDS) / Math.max(1, chainConcurrency));
      } else {
        eta = null;
      }
      setChainEtaSec(eta !== null && eta >= 1 ? eta : null);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [chainJob, chainConcurrency]);

  // ============================================================
  // pollRenderTaskStatus：4s 轮询 UI task 视图兜底（SSE 断线时仍能更新）
  // ============================================================
  const pollRenderTaskStatus = React.useCallback(
    async (
      taskId: string,
      onUpdate: (
        status: string,
        progress: number,
        stage: string,
        result?: unknown,
        error?: string | null,
        progressClips?: { shotIds: string[]; videoUrl: string }[],
      ) => void,
    ) => {
      await pollRenderTask(taskId, api, onUpdate);
    },
    [api],
  );

  // ============================================================
  // 积分预估（chainEstimateCredits / selectedEstimateCredits / 单组）
  // ============================================================

  /** 与 app1 group-service "完成前缀 + 待生成后缀" 过滤规则一致 */
  const resolveStandaloneShotsToProcess = React.useCallback(
    (targetShots: ShotRecord[]) => {
      const sorted = [...targetShots].sort((a, b) => a.sortOrder - b.sortOrder);
      const pending = sorted.filter(
        (shot) =>
          shot.videoStatus === "PENDING" || shot.videoStatus === "FAILED",
      );
      if (pending.length === 0 || pending.length === sorted.length)
        return sorted;
      const pendingIds = new Set(pending.map((shot) => shot.id));
      const lastCompletedIndex = sorted.reduce(
        (lastIndex, shot, index) =>
          shot.videoStatus === "COMPLETED" ? index : lastIndex,
        -1,
      );
      const isPendingSuffix =
        lastCompletedIndex >= 0 &&
        sorted
          .slice(lastCompletedIndex + 1)
          .every((shot) => pendingIds.has(shot.id));
      return isPendingSuffix ? pending : sorted;
    },
    [],
  );

  /** 与 group-service 的 previousGroupVideoUrl 判定一致 */
  const hasCompletedVideoBefore = React.useCallback(
    (targetShots: ShotRecord[]) => {
      if (targetShots.length === 0) return false;
      const minOrder = Math.min(...targetShots.map((s) => s.sortOrder));
      return shots.some(
        (shot) =>
          shot.sortOrder < minOrder &&
          shot.videoStatus === "COMPLETED" &&
          !!shot.currentMaterialUrl,
      );
    },
    [shots],
  );

  /** 诉求8：解耦估算与草稿——估算用 deferred resolution，避免 initParamsDraft 打开
   *  弹窗时整对象替换触发全量估算重算（阻塞点 E）。 */
  const deferredResolution = React.useDeferredValue(paramsDraft.resolution);

  const estimateCreditsForShotIds = React.useCallback(
    (shotIds: string[], resolution = deferredResolution) => {
      if (!shotIds.length) return 0;
      const matchedShots = shots
        .filter((shot) => shotIds.includes(shot.id))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      if (!matchedShots.length) return 0;
      const shotsToProcess = resolveStandaloneShotsToProcess(matchedShots);
      const subGroups = splitShotsByAssetLimit(shotsToProcess, assets);
      const hasVideoInput = hasCompletedVideoBefore(shotsToProcess);
      return subGroups.reduce((sum, subGroup) => {
        const totalDuration = subGroup.reduce(
          (duration, shot) => duration + (shot.durationSeconds || 2),
          0,
        );
        return (
          sum +
          estimateVideoGenerationCredits(
            videoModel,
            normalizeGroupDuration(totalDuration),
            1,
            { resolution, hasVideoInput },
          )
        );
      }, 0);
    },
    [
      assets,
      hasCompletedVideoBefore,
      resolveStandaloneShotsToProcess,
      shots,
      videoModel,
      deferredResolution,
    ],
  );

  const nextPendingShot = React.useMemo(
    () =>
      shots.find((shot) => shot.videoStatus !== "COMPLETED") ||
      shots[0] ||
      null,
    [shots],
  );

  const estimateSingleShotCredits = React.useCallback(
    (shot: ShotRecord | null) => {
      if (!shot) return 0;
      return estimateVideoGenerationCredits(
        videoModel,
        normalizeSingleShotDuration(shot.durationSeconds),
        1,
        { resolution: paramsDraft.resolution, hasVideoInput: false },
      );
    },
    [videoModel, paramsDraft.resolution],
  );

  const singleShotEstimateCredits = React.useMemo(
    () => estimateSingleShotCredits(nextPendingShot),
    [estimateSingleShotCredits, nextPendingShot],
  );

  const regenerateConfirmEstimateCredits = React.useMemo(() => {
    const target = shots.find((shot) => shot.id === regenerateConfirmShotId);
    return target ? estimateSingleShotCredits(target) : 0;
  }, [estimateSingleShotCredits, regenerateConfirmShotId, shots]);

  const selectedEstimateCredits = React.useMemo(() => {
    if (selectedShotIds.size === 0) return 0;
    const sortedShots = shots
      .filter((shot) => selectedShotIds.has(shot.id))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    if (!sortedShots.length) return 0;
    return estimateCreditsForShotIds(sortedShots.map((shot) => shot.id));
  }, [estimateCreditsForShotIds, selectedShotIds, shots]);

  /** 诉求8：预计算每镜资产引用绑定 Map，避免 shots.map 每镜重算 getShotAssetReferenceBindings
   *  （O(N×A) → 一次 useMemo，仅 shots/assets 变时重算，消除阻塞点 A）。 */
  const shotAssetBindingsMap = React.useMemo(() => {
    const m = new Map<string, ShotAssetReferenceBinding[]>();
    for (const s of shots) {
      m.set(s.id, getShotAssetReferenceBindings(s, assets, projectId));
    }
    return m;
  }, [shots, assets, projectId]);

  const chainEstimateCredits = React.useMemo(() => {
    const requests = productionGroups.flatMap((group) => {
      const groupShots = shots
        .filter((shot) => group.shotIds.includes(shot.id))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      return splitShotsByAssetLimit(groupShots, assets)
        .map((subGroup) => ({
          modelId: videoModel,
          durationSeconds: normalizeGroupDuration(
            subGroup.reduce(
              (duration, shot) => duration + (shot.durationSeconds || 2),
              0,
            ),
          ),
          resolution: deferredResolution,
          hasVideoInput: false,
        }));
    });
    return estimateCombinedVideoTaskCredits(requests);
  }, [
    assets,
    productionGroups,
    shots,
    videoModel,
    deferredResolution,
  ]);

  const groupDialogEstimateCredits = React.useMemo(
    () => estimateCreditsForShotIds(groupParamsTargetShotIds),
    [estimateCreditsForShotIds, groupParamsTargetShotIds],
  );

  // ============================================================
  // 一键串生成（P27）
  // ============================================================

  /** 打开参数弹窗（不直接提交） */
  const handleChainGenerateClick = () => {
    if (shots.length === 0) {
      toast.error("该集尚无分镜，请先生成分镜");
      return;
    }
    if (chainSubmitting || chainJob || persistedChainLock) {
      toast.warning("已有一键出片任务进行中，请等待完成");
      return;
    }
    if (generatingShots.size > 0) {
      toast.warning("存在正在生成中的镜头，请等待完成");
      return;
    }
    initParamsDraft(
      (presets.find((p) => p.isDefault) || presets[0])?.params || null,
    );
    setChainParamsDialogOpen(true);
  };

  /**
   * 统一派发入口：targetShotIds 缺省时生成整集；提供时只生成该镜头子集。
   * 单镜、组选中与整集共用同一实现，避免某个 UI 分支漏传 shotIds 后扩大计费范围。
   */
  const submitChainGenerate = async (targetShotIds?: readonly string[]) => {
    if (targetShotIds !== undefined && targetShotIds.length === 0) {
      toast.error("未选择镜头，已取消生成");
      return;
    }
    const scopedShotIds = targetShotIds ? [...targetShotIds] : undefined;
    const targetShotCount = scopedShotIds?.length ?? shots.length;
    setChainSubmitting(true);
    setChainSubmissionProgress(10);
    try {
      const built = buildParamsToSave() || {};
      setEnhancementPrompt(paramsDraft.enhancementPrompt);
      // 严格模式保留末帧连续性；快速模式由客户端并发请求并保持最终合片顺序。
      const cleanBody = buildChainGenerateRequestBody(
        {
          // 去 UI 区分后缀（:15）还原真实模型 id 提交
          model: videoModel.split(":")[0],
          // 分组时长语义随所选模型条目透传（2.5 双条目：30s 合并组 / 15s 仅换模型）。
          maxDuration:
            VIDEO_MODELS.find((m) => m.id === videoModel)?.maxDuration ?? 15,
          ...built,
          // scoped（单镜/组「重新生成」）强制 force=true：chain-generate route 在
          // force=false 且整组 COMPLETED 共用同一 currentMaterialUrl 时会直接复用
          // 旧素材（route ~518-525），导致“重新生成”原样返回老视频而不真生成。
          // 整集一键出片（scopedShotIds===undefined）仍尊重用户弹窗勾选的 chainForce
          // （可复用已完成素材、只补未完成镜头）。
          force: scopedShotIds ? true : chainForce,
          parallelMode: chainMode,
          parallelConcurrency: chainConcurrency,
        },
        scopedShotIds,
      );

      const episodeBaseUrl = `/api/projects/${encodeURIComponent(
        projectId,
      )}/episodes/${encodeURIComponent(episodeId ?? "")}`;
      // 对齐 app1：一次提交 chain-generate。组提示词由 route 内确定性计算并落库
      // （chain-generate/route.ts:524-538 storedPrompt 非 READY 时 prepareGroupPromptSnapshot
      // + updateShot），不再走 group-prompts/prepare 预跳（app1 无此步骤）。
      setChainSubmissionProgress(65);
      const data = (await api(`${episodeBaseUrl}/chain-generate`, {
        method: "POST",
        body: JSON.stringify(cleanBody),
      })) as {
        renderJobId?: string;
        taskId?: string;
        groupCount?: number;
        reused?: boolean;
      } | null;

      if (data?.reused && data.renderJobId) {
        toast.info(
          scopedShotIds
            ? `这 ${targetShotCount} 个镜头已有生成任务，已自动接管`
            : "已有进行中的一键出片任务，已自动接管",
        );
        setChainParamsDialogOpen(false);
        setGroupParamsDialogOpen(false);
      }

      if (data?.renderJobId && data?.taskId) {
        toast.success(
          scopedShotIds
            ? `已提交 ${targetShotCount} 个目标镜头，客户端 render-worker 将处理`
            : `已提交整集串生成（${data.groupCount ?? 0} 组），客户端 render-worker 将处理`,
        );
        setChainJob({
          renderJobId: data.renderJobId,
          taskId: data.taskId,
          status: "PENDING",
          progress: 0,
          stage: "任务已派发",
          stageProgress: 0,
          groupCount: data.groupCount,
          targetShotIds: scopedShotIds,
        });
        trackTaskId(data.taskId);
        setGenerationLock({
          key: chainLockKey,
          scope: "chain_generate",
          projectId,
          episodeId,
          taskId: data.taskId,
          metadata: scopedShotIds ? { targetShotIds: scopedShotIds } : {},
        });
        setChainParamsDialogOpen(false);
        setGroupParamsDialogOpen(false);
        chainHandledEventsRef.current.clear();
        chainFailureNotifiedTaskRef.current = null;
        void pollRenderTaskStatus(
          data.taskId,
          (status, prog, stage, result, error, progressClips) => {
            // 抗 SSE 断：SSE 断线时 4s 轮询仍能把已完成组翻成视频（progressClips 来自 task_events）。
            applyProgressClips(progressClips, onPatchShots);
            setChainJob((prev) =>
              prev
                ? {
                    ...prev,
                    status,
                    progress: status === "COMPLETED" ? 100 : prog || prev.progress,
                    stage: stage || prev.stage,
                    error: error ?? prev.error,
                  }
                : prev,
            );
            if (status === "COMPLETED") {
              // markResult 已原子写回组内镜头；立即拉取，当前页面无需手动刷新才能看到视频。
              refreshShotsAfterSuccessfulRender(status, onRefresh);
              const r = result as
                | {
                    outputUrl?: string;
                    meta?: {
                      localKey?: string;
                      totalGroups?: number;
                      reusedGroups?: number;
                      generatedGroups?: number;
                      skippedGroups?: number;
                      failedGroups?: number;
                      totalDuration?: number;
                      partialCompleted?: boolean;
                    };
                  }
                | undefined;
              // 部分完成（≥1 组成功 + 其余失败）：outputUrl 为空，但仍要展示"部分完成 + 重试失败组"。
              const isPartial = r?.meta?.partialCompleted === true || (r?.meta?.failedGroups ?? 0) > 0;
              if (r && (r.outputUrl || isPartial)) {
                setChainResult({
                  filmUrl: r.outputUrl ?? "",
                  localKey: r.meta?.localKey,
                  // 统计字段优先读 result.meta（客户端 orchestrator 回传），meta 缺失时回退 data.groupCount
                  totalGroups: r.meta?.totalGroups ?? data.groupCount,
                  totalShots: targetShotCount,
                  totalDuration: r.meta?.totalDuration,
                  reusedGroups: r.meta?.reusedGroups ?? r.meta?.skippedGroups,
                  generatedGroups: r.meta?.generatedGroups,
                  failedGroups: r.meta?.failedGroups,
                  partialCompleted: isPartial,
                });
                toast.success(
                  isPartial
                    ? `一键出片部分完成：${r.meta?.failedGroups ?? ""} 组失败，请在下方镜头组重试失败组`
                    : scopedShotIds
                      ? "目标镜头生成完成"
                      : "一键出片完成，成品已生成",
                );
                // 仅「整集一键出片（集成片）」且全部成功才跳成片库；部分完成（无整片）留在当前页重试。
                if (!scopedShotIds && !isPartial && data.taskId) onNavigateToFilms?.(data.taskId);
              }
            }
            if (status === "FAILED") {
              // 失败也要清锁 + 刷新 shots：后端 G3-1 已把镜头标 FAILED，刷新让前端
              // 拿到真实 FAILED 状态、停止镜头级转圈（否则 shots state 永远停在 GENERATING）。
              clearGenerationLock(chainLockKey);
              onRefresh();
              if (chainFailureNotifiedTaskRef.current !== data.taskId) {
                chainFailureNotifiedTaskRef.current = data.taskId!;
                toast.error(
                  `一键出片失败：${formatGenerationFailure(error)}（任务 ${data.taskId?.slice(0, 8)}）`,
                );
              }
            }
          },
        );
      }
    } catch {
      toast.error(scopedShotIds ? "提交目标镜头生成失败" : "提交串生成失败");
    } finally {
      setChainSubmitting(false);
      setChainSubmissionProgress(0);
    }
  };

  /** 整集参数弹窗确认：不传 shotIds，保持原有整集行为。 */
  const handleChainConfirm = async () => {
    await submitChainGenerate();
  };

  // ============================================================
  // 成片导出（P26 export-film）
  // ============================================================
  const handleExportFilm = async () => {
    if (completedShots === 0) {
      toast.error("没有已完成的镜头可导出");
      return;
    }
    if (exportSubmitting || exportJob) {
      toast.warning("已有导出任务进行中，请等待完成");
      return;
    }
    setExportSubmitting(true);
    try {
      const data = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/export-film`,
        {
          method: "POST",
          body: JSON.stringify({ episodeId: episodeId || undefined }),
        },
      )) as {
        renderJobId?: string;
        taskId?: string;
        shotCount?: number;
      } | null;
      if (data?.renderJobId && data?.taskId) {
        const { renderJobId, taskId, shotCount } = data;
        toast.success(`成片导出任务已提交（${shotCount ?? 0} 镜）`);
        setExportJob({
          renderJobId,
          taskId,
          status: "PENDING",
          progress: 0,
          stage: "任务已派发",
        });
        trackTaskId(taskId);
        exportHandledEventsRef.current.clear();
        void pollRenderTaskStatus(
          taskId,
          (status, prog, stage, result) => {
            setExportJob((prev) =>
              prev
                ? {
                    ...prev,
                    status,
                    progress: status === "COMPLETED" ? 100 : prog || prev.progress,
                    stage: stage || prev.stage,
                  }
                : prev,
            );
            if (status === "COMPLETED") {
              const r = result as
                | {
                    outputUrl?: string;
                    meta?: { localKey?: string };
                  }
                | undefined;
              if (r?.outputUrl) {
                setChainResult({
                  filmUrl: r.outputUrl,
                  localKey: r.meta?.localKey,
                  totalShots: shotCount,
                });
                toast.success("成片已生成");
                onNavigateToFilms?.(taskId);
              }
            }
            if (status === "FAILED") {
              toast.error("成片导出失败");
            }
          },
        );
      }
    } catch {
      toast.error("提交成片导出失败");
    } finally {
      setExportSubmitting(false);
    }
  };

  // ============================================================
  // 成组生成（P11 — 复用 episode chain route，但用 shotIds 精确限定范围）
  // ============================================================

  /**
   * 成组生成入口：保存目标 shotIds 并打开组参数弹窗。确认后这些 ID 会原样进入
   * 请求体，由 route 再做 ownership/episode 范围校验；不再退化成整集任务。
   */
  const handleGenerateGroup = (shotIds: string[]) => {
    if (shotIds.length === 0) {
      toast.error("未选择镜头");
      return;
    }
    initParamsDraft(
      (presets.find((p) => p.isDefault) || presets[0])?.params || null,
    );
    setGroupParamsTargetShotIds(shotIds);
    setGroupParamsDialogOpen(true);
    // 弹窗打开即拉取该镜头组的提示词（已保存用已保存，否则服务端整合），供用户查看/修改
    setDialogPromptDraft("");
    setDialogPromptDirty(false);
    void loadDialogPrompt(shotIds);
  };

  /** 成组生成弹窗确认：用户改过提示词则先写回首镜，再派发当前组/选中镜头。 */
  const handleGenerateGroupConfirm = async () => {
    // 用户在弹窗改过提示词 → 先持久化到首镜 metadata.seedanceGroupPrompt，
    // route 的 prepareGroupPromptSnapshot 会优先用已保存版本；未改则 route 自动整合。
    if (dialogPromptDirty) {
      const firstShotId = groupParamsTargetShotIds[0];
      const trimmed = dialogPromptDraft.trim();
      if (firstShotId && trimmed) {
        try {
          const url = episodeId
            ? `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/shots/${encodeURIComponent(firstShotId)}`
            : `/api/projects/${encodeURIComponent(projectId)}/episodes/_/shots/${encodeURIComponent(firstShotId)}`;
          await api(url, {
            method: "PATCH",
            body: JSON.stringify({
              metadata: buildUserGroupPromptMetadata(dialogPromptDraft),
            }),
          });
        } catch {
          // 保存失败不阻断生成：route 仍会自动整合提示词
        }
      }
    }
    await submitChainGenerate(groupParamsTargetShotIds);
  };

  /**
   * 组卡片「保存」键：把用户编辑的提示词写回首镜 metadata（source='user'），
   * 不调 AI、不 LLM 重写。生成时 chain-generate 的 source='user' 短路会原样用此版本。
   * 返回是否保存成功（供 GroupPromptEditor 清 dirty）。
   */
  const saveGroupPrompt = async (
    firstShotId: string,
    prompt: string,
  ): Promise<boolean> => {
    if (!firstShotId || !prompt.trim()) return false;
    try {
      const url = episodeId
        ? `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/shots/${encodeURIComponent(firstShotId)}`
        : `/api/projects/${encodeURIComponent(projectId)}/episodes/_/shots/${encodeURIComponent(firstShotId)}`;
      await api(url, {
        method: "PATCH",
        body: JSON.stringify({
          metadata: buildUserGroupPromptMetadata(prompt),
        }),
      });
      toast.success("已保存为你的版本，生成时优先使用");
      onRefresh();
      return true;
    } catch {
      toast.error("保存提示词失败，请重试");
      return false;
    }
  };

  /**
   * 2026-08-03：「新」徽标读计数——用户点击查看镜头视频时 +1，满 3 次徽标消失。
   * 本地乐观更新（onPatchShots）+ 服务端 PATCH 持久化（route 做 metadata read-merge）。
   * 计数失败静默：徽标下次进入仍在，不影响使用。
   */
  const markShotRead = async (shotId: string): Promise<void> => {
    const shot = shots.find((s) => s.id === shotId);
    if (!shot) return;
    const metadata = (shot.metadata ?? {}) as Record<string, unknown>;
    const seen = Number(metadata.newSeenCount ?? 0);
    if (seen >= 3) return;
    onPatchShots?.([shotId], {
      metadata: { ...metadata, newSeenCount: seen + 1 },
    });
    try {
      const url = episodeId
        ? `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/shots/${encodeURIComponent(shotId)}`
        : `/api/projects/${encodeURIComponent(projectId)}/episodes/_/shots/${encodeURIComponent(shotId)}`;
      await api(url, {
        method: "PATCH",
        body: JSON.stringify({ metadata: { newSeenCount: seen + 1 } }),
      });
    } catch {
      // 静默：乐观更新已生效，刷新后服务端兜底
    }
  };

  /** 成组生成弹窗「保存提示词」键：只保存不生成，复用 saveGroupPrompt。 */
  const handleSaveDialogPrompt = async (): Promise<void> => {
    if (!dialogPromptDirty) return;
    const firstShotId = groupParamsTargetShotIds[0];
    const trimmed = dialogPromptDraft.trim();
    if (!firstShotId || !trimmed) return;
    const ok = await saveGroupPrompt(firstShotId, trimmed);
    if (ok) setDialogPromptDirty(false);
  };

  /** 批量生成选中镜头（浮动操作栏"生成视频"按钮） */
  const handleGenerateSelected = async () => {
    if (selectedShotIds.size === 0) return;
    if (!isSelectionConsecutive()) {
      toast.error("请选择连续的镜头");
      return;
    }
    const { total, overLimit } = getSelectionDuration();
    if (overLimit) {
      toast.error(
      `所选镜头总时长 ${total}s 超过 ${maxGroupDuration}s 上限，请缩小选择范围`,
      );
      return;
    }
    const sortedIds = shots
      .filter((s) => selectedShotIds.has(s.id))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => s.id);
    clearSelection();
    await Promise.resolve(handleGenerateGroup(sortedIds));
  };

  // ============================================================
  // 组提示词（已合并入"成组生成参数"弹窗，A 方案）
  // ============================================================
  /**
   * 拉取目标镜头组的提示词到弹窗（已保存用已保存，否则服务端确定性整合）。
   * 纯文本组合 + 持久化快照，不产生积分或远程媒体任务。用户可在弹窗内查看/修改，
   * 改动会在确认生成时写回首镜 metadata.seedanceGroupPrompt（route 优先用已保存）。
   */
  const loadDialogPrompt = async (shotIds: string[], force = false) => {
    if (!shotIds.length) return;
    setDialogPromptLoading(true);
    try {
      const data = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/shots/generate-group-preview`,
        {
          method: "POST",
          body: JSON.stringify({ shotIds, force }),
        },
      )) as { combinedPrompt?: string } | null;
      const combined = data?.combinedPrompt ?? "";
      setDialogPromptDraft(combined);
      // 生成/重新生成后自动保存：服务端 generate-group-preview 已把结果落库到首镜
      // metadata（source='auto'）；「重新整合」（force）再把新版本提升为用户的版本
      // （source='user'，生成时原样使用、不再 LLM 重写——所见即所得），并刷新组卡片
      // 让保存立即生效可见。非 force（打开弹窗）只查看预览，不提升版本。
      if (combined) {
        if (force && shotIds.length > 0) {
          const firstShotId = shotIds[0];
          const url = episodeId
            ? `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/shots/${encodeURIComponent(firstShotId)}`
            : `/api/projects/${encodeURIComponent(projectId)}/episodes/_/shots/${encodeURIComponent(firstShotId)}`;
          try {
            await api(url, {
              method: "PATCH",
              body: JSON.stringify({
                metadata: buildUserGroupPromptMetadata(combined),
              }),
            });
            toast.success("已自动保存为你的版本，生成时优先使用");
          } catch {
            // 自动保存失败静默：服务端已存 auto 版本，生成时仍可正常整合使用
          }
        }
        onRefresh();
      }
    } catch {
      // 拉取失败留空，生成时 route 会自动整合提示词
      setDialogPromptDraft("");
    } finally {
      setDialogPromptLoading(false);
    }
  };

  // ============================================================
  // 组提示词审核锁定（C 方案：组卡片内联）
  // ============================================================
  /**
   * 生成"最终提示词"（确定性拼装 + LLM 审核友好重写），落库后展示给用户审核。
   * 已认可且非 force → 服务端直接返回锁定提示词、不花钱；force → 强制重跑并解除锁定。
   */
  const finalizeGroupPrompt = async (
    shotIds: string[],
    firstShotId: string,
    force: boolean,
  ) => {
    if (!shotIds.length || !firstShotId) return;
    setFinalizingFirstShotId(firstShotId);
    try {
      const data = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/shots/group-prompt-finalize`,
        {
          method: "POST",
          body: JSON.stringify({ shotIds, force }),
        },
      )) as { approved?: boolean } | null;
      if (data?.approved) {
        toast.info("该组提示词已认可锁定，未重跑");
      } else {
        toast.success(
          force ? "已重新生成最终提示词" : "已生成最终提示词，请审核后认可锁定",
        );
      }
      onRefresh();
    } catch {
      toast.error("生成最终提示词失败，请稍后重试");
    } finally {
      setFinalizingFirstShotId(null);
    }
  };

  /** 认可锁定 / 解锁：只翻首镜 metadata.seedanceGroupPromptApproved。 */
  const approveGroupPrompt = async (firstShotId: string, approve: boolean) => {
    if (!firstShotId) return;
    try {
      const url = episodeId
        ? `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/shots/${encodeURIComponent(firstShotId)}`
        : `/api/projects/${encodeURIComponent(projectId)}/episodes/_/shots/${encodeURIComponent(firstShotId)}`;
      await api(url, {
        method: "PATCH",
        body: JSON.stringify({
          metadata: buildApproveGroupPromptMetadata(approve),
        }),
      });
      toast.success(
        approve ? "已认可锁定，之后生成只用此提示词、不再调 AI 重写" : "已解锁",
      );
      onRefresh();
    } catch {
      toast.error("操作失败，请稍后重试");
    }
  };

  // ============================================================
  // 参数模板（P31）— CRUD + 导入/导出 JSON
  // ============================================================

  /** 加载用户保存的参数模板列表 */
  const loadPresets = React.useCallback(async () => {
    try {
      const d = (await api(`/api/user/seedance-presets`, {
        method: "GET",
      })) as
        | Array<{
            id: string;
            name: string;
            params?: Record<string, unknown>;
            isDefault?: boolean;
            updatedAt: string;
          }>
        | null;
      if (Array.isArray(d)) {
        setPresets(
          d.map((p) => ({
            id: p.id,
            name: p.name,
            params: p.params || {},
            isDefault: p.isDefault === true,
            updatedAt: p.updatedAt,
          })),
        );
      }
    } catch {
      // 静默失败（不打扰用户）
    }
  }, [api]);

  React.useEffect(() => {
    if (!isReview) void loadPresets();
  }, [isReview, loadPresets]);

  const handleSavePreset = async () => {
    const { name, params } = savePresetDialog;
    if (!name.trim()) {
      toast.error("模板名称不能为空");
      return;
    }
    if (!params || Object.keys(params).length === 0) {
      toast.error("参数为空，无法保存");
      return;
    }
    try {
      const d = (await api(`/api/user/seedance-presets`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), params }),
      })) as unknown;
      if (d) {
        toast.success(`模板"${name.trim()}"已保存`);
        setSavePresetDialog({ open: false, name: "", params: null });
        await loadPresets();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "未知错误";
      toast.error(`保存模板失败: ${msg}`);
    }
  };

  const handleDeletePreset = async (
    presetId: string,
    presetName: string,
  ) => {
    if (!confirm(`确认删除模板"${presetName}"？此操作不可撤销。`)) return;
    try {
      const d = (await api(
        `/api/user/seedance-presets/${encodeURIComponent(presetId)}`,
        { method: "DELETE" },
      )) as unknown;
      if (d) {
        toast.success(`模板"${presetName}"已删除`);
        setPresets((prev) => prev.filter((p) => p.id !== presetId));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "未知错误";
      toast.error(`删除模板失败: ${msg}`);
    }
  };

  const handleApplyPresetToDraft = (params: Record<string, unknown>) => {
    initParamsDraft(params);
    toast.success("模板参数已载入弹窗，确认后生效");
  };

  /** 导出当前弹窗参数为 JSON 文件（v2 单组格式） */
  const handleExportParams = () => {
    const params = buildParamsToSave();
    if (!params) {
      toast.error("当前弹窗无可导出的参数");
      return;
    }
    const exportData = {
      version: 2,
      exportedAt: new Date().toISOString(),
      params,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chain-params-${projectId}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("已导出当前弹窗参数");
  };

  /** 导入参数 JSON 文件载入弹窗 draft（兼容 v1 多组 / v2 单组） */
  const handleImportParams = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      const text = await file.text();
      const data = JSON.parse(text) as Record<string, unknown>;
      if (!data || typeof data !== "object") {
        toast.error("JSON 格式错误：不是有效对象");
        return;
      }
      let params: Record<string, unknown> | null = null;
      if (data.params && typeof data.params === "object") {
        params = data.params as Record<string, unknown>;
      } else if (Array.isArray(data.groups)) {
        const validParams = (data.groups as Array<Record<string, unknown>>)
          .map((g) => g?.params)
          .filter(
            (p) =>
              p && typeof p === "object" && Object.keys(p).length > 0,
          ) as Array<Record<string, unknown>>;
        params =
          validParams.length > 0 ? validParams[validParams.length - 1] : null;
      }
      if (!params || Object.keys(params).length === 0) {
        toast.error("JSON 中未找到有效参数");
        return;
      }
      initParamsDraft(params);
      toast.success("参数已导入弹窗，确认后生效");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "JSON 解析错误";
      toast.error(`导入失败: ${msg}`);
    }
  };

  // ============================================================
  // 批量下载 + 单成片下载（dramaforge 适配：sf-asset:// → window.sfShell.saveFilm）
  // ============================================================

  const handleBatchDownload = async () => {
    const targets = shots.filter(
      (s) => s.videoStatus === "COMPLETED" && s.currentMaterialUrl,
    );
    if (targets.length === 0 || batchDownloadProgress) return;

    setBatchDownloadProgress({ done: 0, total: targets.length });
    try {
      let done = 0;
      for (const shot of targets) {
        try {
          // sf-asset:// 在 Electron 内可 fetch（protocol handler 已挂载）
          const response = await fetch(shot.currentMaterialUrl!);
          const blob = await response.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `shot-${shot.shotSeq || shot.id}.mp4`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          window.URL.revokeObjectURL(url);
        } catch {
          // 单镜失败不中断
        } finally {
          done += 1;
          setBatchDownloadProgress({ done, total: targets.length });
        }
      }
    } finally {
      setBatchDownloadProgress(null);
    }
  };

  /**
   * 单成片下载（P9 下载 MP4 按钮）。
   *
   * dramaforge 适配（dramaforge-assets-client-local）：sf-asset:// 是 Electron 自定义 scheme，
   * Chromium `<a download>` 不触发 save-as；走 window.sfShell.saveFilm IPC →
   * main 进程 showSaveDialog + fs.copyFile 把本地 clips/<localKey>.mp4 复制到
   * 用户选定位。dev/browser fallback：直接 fetch+blob+<a>（无 persist）。
   */
  const handleDownloadFilm = async (
    filmUrl: string,
    localKey?: string,
  ) => {
    // Electron 桌面客户端路径：走 IPC saveFilm
    if (
      typeof window !== "undefined" &&
      window.sfShell?.isElectron &&
      localKey
    ) {
      try {
        const result = await window.sfShell.saveFilm(
          localKey,
          `film-${projectId}`,
        );
        if (!result.ok) {
          toast.error(`下载失败：${result.error.message}`);
        }
        return;
      } catch {
        // IPC 异常 → 回退到 fetch+blob
      }
    }
    // dev / browser fallback
    try {
      const response = await fetch(filmUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `film-${projectId}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error("下载失败");
    }
  };

  // ============================================================
  // P25 SSE 事件处理：监听本任务的 status_change / progress / output 事件
  // ============================================================
  React.useEffect(() => {
    if (!events || events.length === 0) return;

    // chain 任务事件
    if (chainJob) {
      for (const event of events) {
        if (event.taskId !== chainJob.taskId) continue;
        const eventKey = `${event.taskId}-${event.type}-${event.timestamp}`;
        if (chainHandledEventsRef.current.has(eventKey)) continue;
        chainHandledEventsRef.current.add(eventKey);

        if (event.type === "status_change") {
          const st = String(event.status ?? "");
          setChainJob((prev) =>
            prev
              ? {
                  ...prev,
                  status: st,
                  progress: st === "COMPLETED" ? 100 : prev.progress,
                }
              : prev,
          );
          if (
            st === "COMPLETED" ||
            st === "FAILED" ||
            st === "CANCELLED" ||
            st === "TIMEOUT"
          ) {
            clearGenerationLock(chainLockKey);
            // SSE 到达时数据库事务已经提交，刷新即可恢复每镜 videoStatus/materialUrl。
            // COMPLETED 走 refreshShotsAfterSuccessfulRender；FAILED 直接刷新——后端 G3-1
            // 已把镜头标 FAILED，需拉真实状态停止镜头级转圈。refreshShotsAfterSuccessfulRender
            // 对 FAILED 故意返 false（保留"失败不伪装成功"语义），故 FAILED 另走 onRefresh。
            if (st === "COMPLETED") {
              refreshShotsAfterSuccessfulRender(st, onRefresh);
            } else {
              onRefresh();
            }
            // 终态事件可能先于 output 事件到达，立即从 UI task 视图补取本地成片。
            void fetchRenderTaskStatus(api, chainJob.taskId)
              .then((task) => {
                if (st === "FAILED") {
                  setChainJob((prev) => prev ? { ...prev, error: task?.error ?? prev.error } : prev);
                  if (chainFailureNotifiedTaskRef.current !== chainJob.taskId) {
                    chainFailureNotifiedTaskRef.current = chainJob.taskId;
                    toast.error(
                      `一键出片失败：${formatGenerationFailure(task?.error)}（任务 ${chainJob.taskId.slice(0, 8)}）`,
                    );
                  }
                }
                const r = task?.result as
                  | {
                      outputUrl?: string;
                      meta?: {
                        localKey?: string;
                        totalGroups?: number;
                        reusedGroups?: number;
                        generatedGroups?: number;
                        skippedGroups?: number;
                        failedGroups?: number;
                        totalDuration?: number;
                        partialCompleted?: boolean;
                      };
                    }
                  | undefined;
                // 部分完成（≥1 组成功 + 其余失败）：outputUrl 为空，但仍要展示"部分完成 + 重试失败组"。
                const isPartial =
                  st === "COMPLETED" &&
                  !!r?.meta &&
                  (r.meta.partialCompleted === true || (r.meta.failedGroups ?? 0) > 0);
                if (st === "COMPLETED" && r && (r.outputUrl || isPartial)) {
                  setChainResult({
                    filmUrl: r.outputUrl ?? "",
                    localKey: r.meta?.localKey,
                    totalGroups: r.meta?.totalGroups,
                    totalShots: shots.length,
                    totalDuration: r.meta?.totalDuration,
                    reusedGroups: r.meta?.reusedGroups ?? r.meta?.skippedGroups,
                    generatedGroups: r.meta?.generatedGroups,
                    failedGroups: r.meta?.failedGroups,
                    partialCompleted: isPartial,
                  });
                  // 同 pollRenderTaskStatus 分支：目标镜头子集（targetShotIds）/部分完成不跳成片库，
                  // 只有整集一键出片（集成片）且全部成功才跳。
                  if (!chainJob.targetShotIds?.length && !isPartial) onNavigateToFilms?.(chainJob.taskId);
                }
              })
              .catch(() => undefined);
          }
        }
        if (event.type === "progress") {
          setChainJob((prev) =>
            prev
              ? {
                  ...prev,
                  progress:
                    typeof event.progress === "number"
                      ? Math.min(event.progress, 99)
                      : prev.progress,
                  stage: event.stage ?? prev.stage,
                  stageProgress:
                    typeof event.stageProgress === "number"
                      ? event.stageProgress
                      : prev.stageProgress,
                }
              : prev,
          );
          // 渐进回传:本组视频已落客户端本地 → 乐观更新这些镜头卡片即时显示
          // (卡片渲染卡 isCompleted && currentMaterialUrl,故两者都得翻)。
          // 链 COMPLETED 时 onRefresh 拉服务端真值兜底。与轮询/刷新恢复共用 applyProgressClips。
          applyProgressClips(
            event.groupClip ? [event.groupClip] : undefined,
            onPatchShots,
          );
        }
        if (event.type === "output") {
          const output = event.output as
            | {
                filmUrl?: string;
                localKey?: string;
                totalGroups?: number;
                totalShots?: number;
                totalDuration?: number;
                reusedGroups?: number;
                generatedGroups?: number;
                skippedGroups?: number;
                failedGroups?: number;
              }
            | undefined;
          if (output?.filmUrl) {
            setChainResult({
              filmUrl: output.filmUrl,
              localKey: output.localKey,
              totalGroups: output.totalGroups,
              totalShots: output.totalShots,
              totalDuration: output.totalDuration,
              reusedGroups: output.reusedGroups ?? output.skippedGroups,
              generatedGroups: output.generatedGroups,
              failedGroups: output.failedGroups,
            });
          }
        }
      }
    }

    // export 任务事件
    if (exportJob) {
      for (const event of events) {
        if (event.taskId !== exportJob.taskId) continue;
        const eventKey = `${event.taskId}-${event.type}-${event.timestamp}`;
        if (exportHandledEventsRef.current.has(eventKey)) continue;
        exportHandledEventsRef.current.add(eventKey);

        if (event.type === "status_change") {
          const st = String(event.status ?? "");
          setExportJob((prev) => (prev ? { ...prev, status: st } : prev));
          if (
            st === "COMPLETED" ||
            st === "FAILED" ||
            st === "CANCELLED" ||
            st === "TIMEOUT"
          ) {
            // 导出与串生成统一读取 envelope 任务视图，避免 M2M 裸响应触发假错误。
            void fetchRenderTaskStatus(api, exportJob.taskId)
              .then((task) => {
                const r = task?.result as
                  | {
                      outputUrl?: string;
                      meta?: { localKey?: string };
                    }
                  | undefined;
                if (r?.outputUrl && st === "COMPLETED") {
                  setChainResult({
                    filmUrl: r.outputUrl,
                    localKey: r.meta?.localKey,
                  });
                  onNavigateToFilms?.(exportJob.taskId);
                }
              })
              .catch(() => undefined);
          }
        }
        if (event.type === "progress") {
          setExportJob((prev) =>
            prev
              ? {
                  ...prev,
                  progress:
                    typeof event.progress === "number"
                      ? Math.min(event.progress, 99)
                      : prev.progress,
                  stage: event.stage ?? prev.stage,
                }
              : prev,
          );
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, chainJob, exportJob]);

  // ============================================================
  // 兜底：persistedChainLock 恢复（页面刷新后接管未完成 chain）
  // ============================================================
  React.useEffect(() => {
    const taskId = persistedChainLock?.taskId;
    if (!taskId) return;
    // 仅在 chainJob 为空时接管（避免覆盖正在跟踪的任务）
    if (chainJob) return;
    void (async () => {
      try {
        // generation lock 保存的是 taskId；通过 UI task 视图恢复对应 renderJobId。
        const task = await fetchRenderTaskStatus(api, taskId);
        // 抗刷新：刷新前已渐进回传的组片段（task_events），恢复显示其本地视频。
        applyProgressClips(task?.progressClips, onPatchShots);
        const st = task?.status;
        if (
          st &&
          st !== "COMPLETED" &&
          st !== "FAILED" &&
          st !== "CANCELLED" &&
          st !== "TIMEOUT" &&
          task?.renderJobId
        ) {
          const lockedTargetShotIds =
            persistedChainLock?.metadata?.targetShotIds;
          setChainJob({
            renderJobId: task.renderJobId,
            taskId,
            status: st,
            progress: task.progress ?? 0,
            stage: task.stage ?? "",
            stageProgress: 0,
            groupCount: task.groupCount,
            targetShotIds: Array.isArray(lockedTargetShotIds)
              ? lockedTargetShotIds.filter(
                  (shotId): shotId is string => typeof shotId === "string",
                )
              : undefined,
          });
          trackTaskId(taskId);
        } else {
          // 页面刷新与任务完成竞态时，终态查询负责补一次 shots，避免保留挂载时旧快照。
          refreshShotsAfterSuccessfulRender(st ?? "", onRefresh);
          clearGenerationLock(chainLockKey);
        }
      } catch {
        // 查询失败保留锁，等待 SSE / 下一次恢复
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedChainLock?.taskId]);

  // ============================================================
  // 渲染：派生
  // ============================================================

  const chainRunning = isActiveChainGeneration(chainJob);
  const exportRunning =
    exportJob !== null &&
    exportJob.status !== "COMPLETED" &&
    exportJob.status !== "FAILED" &&
    exportJob.status !== "CANCELLED" &&
    exportJob.status !== "TIMEOUT";

  /** 取消 P8 卡当前生成（chain 或 export，均为 render_jobs，走 DELETE /api/render/jobs/[id]）。 */
  const handleCancelP8 = async () => {
    const job = chainRunning ? chainJob : exportRunning ? exportJob : null;
    if (!job?.taskId) return;
    if (!window.confirm("确认取消该生成任务？此操作不可撤销。")) return;
    try {
      await cancelTask(job.taskId, "render");
      toast.success("已取消");
      // SSE CANCELLED 到达后由终态分支清 generation lock + onRefresh。
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "未知错误";
      toast.error(`取消失败：${msg}`);
    }
  };

  // ============================================================
  // 弹窗共用渲染函数（一键出片 / 成组生成）
  // ============================================================

  /** 渲染参数模板区（弹窗共用） */
  const renderPresetSection = () => (
    <div className="mb-5">
      <div className="text-xs font-bold text-[var(--text-2)] mb-2 flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        参数模板
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selectedPresetId}
          onChange={(e) => setSelectedPresetId(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg bg-[var(--bg)] border border-[var(--border-light)] text-xs text-[var(--text)] focus:outline-none focus:border-[var(--action)]/50 flex-1 min-w-[140px]"
        >
          <option value="">选择模板...</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.isDefault ? "（默认）" : ""}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            const p = presets.find((x) => x.id === selectedPresetId);
            if (p) handleApplyPresetToDraft(p.params);
            else toast.error("请先选择模板");
          }}
          className="btn-ghost px-2.5 py-1.5 rounded-lg text-xs"
        >
          应用
        </button>
        <button
          onClick={() => {
            const params = buildParamsToSave();
            if (!params) {
              toast.error("当前无可保存的参数");
              return;
            }
            setSavePresetDialog({ open: true, name: "", params });
          }}
          className="btn-ghost px-2.5 py-1.5 rounded-lg text-xs"
        >
          存为模板
        </button>
        <button
          onClick={handleExportParams}
          className="btn-ghost px-2.5 py-1.5 rounded-lg text-xs"
        >
          导出JSON
        </button>
        <button
          onClick={() => importFileRef.current?.click()}
          className="btn-ghost px-2.5 py-1.5 rounded-lg text-xs"
        >
          导入JSON
        </button>
      </div>
      {presets.length > 0 && (
        <div className="mt-2 p-2 rounded-lg bg-[var(--bg-hover)] flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--bg)] border border-[var(--border-light)] text-[10px]"
            >
              <span className="text-[var(--text-2)]">
                {p.name}
                {p.isDefault ? " ·默认" : ""}
              </span>
              <button
                onClick={() => handleDeletePreset(p.id, p.name)}
                className="text-[var(--text-3)] hover:text-[var(--danger)]"
                title="删除模板"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M18 6L6 18M6 6l12 12"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  /** 渲染视频参数编辑器（弹窗共用） */
  const renderVideoParamsSection = () => {
    const ratio = paramsDraft.aspectRatio || "9:16";
    const ratioStyle = ratio.includes(":")
      ? { aspectRatio: ratio.replace(":", " / ") }
      : { aspectRatio: "9 / 16" };
    return (
      <div className="mb-5">
        <div className="text-xs font-bold text-[var(--text-2)] mb-2 flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          视频参数
        </div>
        {/* 视频模型 */}
        <div className="mb-3">
          <ModelSelector
            models={PRODUCTION_VIDEO_MODELS}
            value={videoModel}
            onChange={setVideoModel}
            label="视频模型"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-[var(--text-3)] mb-1 block">
              分辨率
            </label>
            <select
              value={paramsDraft.resolution}
              onChange={(e) =>
                setParamsDraft((prev) => ({
                  ...prev,
                  resolution: e.target.value,
                }))
              }
              className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg)] border border-[var(--border-light)] text-xs text-[var(--text)] focus:outline-none focus:border-[var(--action)]/50"
            >
              {RESOLUTION_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-[var(--text-3)] mb-1 block">
              画面比例
            </label>
            <select
              value={paramsDraft.aspectRatio}
              onChange={(e) =>
                setParamsDraft((prev) => ({
                  ...prev,
                  aspectRatio: e.target.value,
                }))
              }
              className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg)] border border-[var(--border-light)] text-xs text-[var(--text)] focus:outline-none focus:border-[var(--action)]/50"
            >
              {ASPECT_RATIO_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </div>
        {/* 画面比例实时预览 */}
        <div className="mt-2 flex items-center gap-3 p-2 rounded-lg bg-[var(--bg-hover)]">
          <div
            style={ratioStyle}
            className="w-16 max-h-20 bg-[var(--accent-dim)] border border-[var(--accent)]/30 rounded flex items-center justify-center"
          >
            <span className="text-[9px] text-[var(--accent)] font-bold">
              {ratio}
            </span>
          </div>
          <span className="text-[10px] text-[var(--text-3)]">
            {paramsDraft.aspectRatio
              ? `已设置：${ratio}`
              : "未设置，将跟随镜头默认比例（9:16）"}
          </span>
        </div>
        {/* 固定种子 */}
        <div className="mt-3 flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={paramsDraft.useFixedSeed}
              onChange={(e) =>
                setParamsDraft((prev) => ({
                  ...prev,
                  useFixedSeed: e.target.checked,
                }))
              }
              className="w-3.5 h-3.5 rounded border-[var(--border-light)] accent-[var(--action)]"
            />
            <span className="text-xs text-[var(--text-2)]">固定种子</span>
          </label>
          <input
            type="number"
            value={paramsDraft.seed}
            onChange={(e) =>
              setParamsDraft((prev) => ({ ...prev, seed: e.target.value }))
            }
            disabled={!paramsDraft.useFixedSeed}
            className="w-24 px-2 py-1 rounded-lg bg-[var(--bg)] border border-[var(--border-light)] text-xs text-[var(--text)] focus:outline-none focus:border-[var(--action)]/50 disabled:opacity-40"
            placeholder="42"
          />
          <span className="text-[10px] text-[var(--text-3)]">
            相同种子+提示词→相似结果（便于复现）
          </span>
        </div>
        {/* 水印 / 末帧 */}
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={paramsDraft.watermark}
              onChange={(e) =>
                setParamsDraft((prev) => ({
                  ...prev,
                  watermark: e.target.checked,
                }))
              }
              className="w-3.5 h-3.5 rounded border-[var(--border-light)] accent-[var(--action)]"
            />
            <span className="text-xs text-[var(--text-2)]">AI水印</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={paramsDraft.returnLastFrame}
              onChange={(e) =>
                setParamsDraft((prev) => ({
                  ...prev,
                  returnLastFrame: e.target.checked,
                }))
              }
              className="w-3.5 h-3.5 rounded border-[var(--border-light)] accent-[var(--action)]"
            />
            <span className="text-xs text-[var(--text-2)]">返回末帧</span>
          </label>
          <label
            className="flex items-center gap-1.5 cursor-not-allowed opacity-60"
            title="客户端彩铅参考图转换与缓存协议尚未部署，当前安全停用"
          >
            <input
              type="checkbox"
              checked={false}
              disabled
              onChange={() => undefined}
              className="w-3.5 h-3.5 rounded border-[var(--border-light)] accent-[var(--action)]"
            />
            <span className="text-xs text-[var(--text-2)]">彩铅参考还原（待客户端支持）</span>
          </label>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3">
          <div>
            <label className="text-[10px] text-[var(--text-3)] mb-1 block">
              增强提示词（写入每个镜头组）
            </label>
            <textarea
              value={paramsDraft.enhancementPrompt}
              onChange={(e) =>
                setParamsDraft((prev) => ({
                  ...prev,
                  enhancementPrompt: e.target.value,
                }))
              }
              maxLength={4000}
              rows={3}
              placeholder="例如：节奏紧凑、保持角色脸型与服装连续、镜头运动克制"
              className="w-full resize-y px-2.5 py-2 rounded-lg bg-[var(--bg)] border border-[var(--border-light)] text-xs text-[var(--text)] focus:outline-none focus:border-[var(--action)]/50"
            />
          </div>
          <div>
            <label className="text-[10px] text-[var(--text-3)] mb-1 block">
              镜头组转场要求
            </label>
            <input
              type="text"
              value={paramsDraft.transition}
              onChange={(e) =>
                setParamsDraft((prev) => ({
                  ...prev,
                  transition: e.target.value,
                }))
              }
              maxLength={500}
              placeholder="例如：动作匹配剪辑，避免突兀闪白"
              className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg)] border border-[var(--border-light)] text-xs text-[var(--text)] focus:outline-none focus:border-[var(--action)]/50"
            />
          </div>
        </div>
        <div className="mt-4 rounded-lg border border-[var(--border-light)] bg-[var(--bg-hover)]/40 p-3">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={paramsDraft.gridEnabled}
              onChange={(e) =>
                setParamsDraft((prev) => ({
                  ...prev,
                  gridEnabled: e.target.checked,
                }))
              }
              className="w-3.5 h-3.5 rounded border-[var(--border-light)] accent-[var(--action)]"
            />
            <span className="text-xs text-[var(--text-2)]">
              强制启用角色参考网格
            </span>
          </label>
          <p className="mt-1 text-[10px] text-[var(--text-3)]">
            含角色参考图的镜头会自动启用；这里可强制打开并调整网格参数。
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] text-[var(--text-3)] mb-1 block">
                网格数（4-400）
              </label>
              <input
                type="number"
                min={4}
                max={400}
                step={1}
                value={paramsDraft.gridCells}
                onChange={(e) =>
                  setParamsDraft((prev) => ({
                    ...prev,
                    gridCells: e.target.value,
                  }))
                }
                className="w-full px-2 py-1.5 rounded-lg bg-[var(--bg)] border border-[var(--border-light)] text-xs text-[var(--text)] focus:outline-none focus:border-[var(--action)]/50"
              />
            </div>
            <div>
              <label className="text-[10px] text-[var(--text-3)] mb-1 block">
                透明度（0-1）
              </label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={paramsDraft.gridOpacity}
                onChange={(e) =>
                  setParamsDraft((prev) => ({
                    ...prev,
                    gridOpacity: e.target.value,
                  }))
                }
                className="w-full px-2 py-1.5 rounded-lg bg-[var(--bg)] border border-[var(--border-light)] text-xs text-[var(--text)] focus:outline-none focus:border-[var(--action)]/50"
              />
            </div>
            <div>
              <label className="text-[10px] text-[var(--text-3)] mb-1 block">
                线宽（0.1-10）
              </label>
              <input
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                value={paramsDraft.gridStrokeWidth}
                onChange={(e) =>
                  setParamsDraft((prev) => ({
                    ...prev,
                    gridStrokeWidth: e.target.value,
                  }))
                }
                className="w-full px-2 py-1.5 rounded-lg bg-[var(--bg)] border border-[var(--border-light)] text-xs text-[var(--text)] focus:outline-none focus:border-[var(--action)]/50"
              />
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ============================================================
  // 渲染
  // ============================================================

  return (
    <div className="flex flex-col h-full">
      {/* REFERENCE_VIDEO：项目级参考视频切片提示横幅（切片已在 Input 阶段直传
          对象存储，chain-generate 按场景对齐注入 reference_video） */}
      {(() => {
        const sd = project?.scriptData;
        const refVideo = sd && typeof sd === "object" && !Array.isArray(sd)
          ? (sd as Record<string, unknown>).referenceVideo
          : undefined;
        const clipCount =
          refVideo && typeof refVideo === "object" && !Array.isArray(refVideo)
            ? (refVideo as { clips?: unknown[] }).clips?.length ?? 0
            : 0;
        if (clipCount <= 0) return null;
        return (
          <div className="flex-shrink-0 border-b border-[var(--border-light)] bg-[var(--bg-elevated)] px-6 py-2 text-xs text-[var(--text-2)]">
            🎬 参考视频转绘：本集生成将按场景参考原片切片（{clipCount} 片，≤15s / 720p），
            海外角色/环境由资产层替换，成片为目标语种 + 海外人种。
          </div>
        );
      })()}
      {/* 视图切换控制（P33 VideoEditor） */}
      <div className="h-12 border-b border-[var(--border-light)] bg-[var(--bg-elevated)] px-6 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode("list")}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
              viewMode === "list"
                ? "bg-[var(--action-dim)] text-[var(--action)]"
                : "text-[var(--text-3)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            列表视图
          </button>
          <button
            onClick={() => setViewMode("editor")}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
              viewMode === "editor"
                ? "bg-[var(--action-dim)] text-[var(--action)]"
                : "text-[var(--text-3)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            编辑器视图
          </button>
        </div>
        <div className="flex items-center gap-3">
          <div
            className="text-2xl font-black text-[var(--accent)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {Math.floor(progress)}%
          </div>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden">
        {viewMode === "list" ? (
          <div className="p-8 flex flex-col h-full overflow-y-auto">
            {/* 头部：标题 + 一键出片 / 批量下载 / 成片导出 */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2
                  className="text-xl font-bold text-[var(--text)] mb-1"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  生产制作
                </h2>
                <p className="text-sm text-[var(--text-3)]">
                  {completedShots}/{shots.length} 个镜头已完成
                </p>
              </div>
              <div className="flex items-center gap-3">
                {/* P26 成片导出 */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleExportFilm()}
                  loading={exportSubmitting || exportRunning}
                  progress={exportRunning ? exportJob?.progress : undefined}
                  disabled={
                    exportSubmitting ||
                    !!exportJob ||
                    completedShots === 0 ||
                    isReview
                  }
                  title="将已完成镜头拼接为成片（CONCAT render_job，客户端 ffmpeg 合片）"
                >
                  {exportRunning
                    ? `导出中 ${Math.floor(exportJob?.progress ?? 0)}%`
                    : `成片导出 (${completedShots})`}
                </Button>
                {/* P2 批量下载 */}
                {completedShots > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleBatchDownload()}
                    loading={batchDownloadProgress !== null}
                    progress={
                      batchDownloadProgress
                        ? (batchDownloadProgress.done / Math.max(1, batchDownloadProgress.total)) * 100
                        : undefined
                    }
                    disabled={isReview}
                  >
                    批量下载 ({completedShots})
                  </Button>
                )}
                {/* P27 一键出片 */}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleChainGenerateClick}
                  loading={chainSubmitting || chainRunning}
                  progress={
                    chainSubmitting
                      ? chainSubmissionProgress
                      : chainRunning
                        ? chainJob?.progress
                        : undefined
                  }
                  disabled={
                    chainSubmitting ||
                    chainRunning ||
                    !!persistedChainLock ||
                    shots.length === 0 ||
                    isReview
                  }
                  title="先整合并持久化全部镜头组提示词，再按序生成，全部完成后自动拼接"
                >
                  {chainSubmitting ? (
                    <>整合提示词并派发 {chainSubmissionProgress}%</>
                  ) : chainRunning || persistedChainLock ? (
                    <>生成中 {Math.floor(chainJob?.progress ?? 0)}%</>
                  ) : (
                    <>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <path
                          d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      一键出片
                      <span className="rounded-md bg-white/20 px-1.5 py-0.5 text-[11px] tabular-nums">
                        {formatCredits(chainEstimateCredits)} 积分
                      </span>
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* P10 提示行 + 积分预估 */}
            {shots.length > 0 && !isReview && (
              <div className="mb-4 px-4 py-2 rounded-lg bg-[var(--bg-hover)] text-xs text-[var(--text-3)] flex flex-wrap items-center gap-x-4 gap-y-1">
                <span>
                  点击选择镜头，Shift+点击范围选择，选中任意连续镜头即可生成视频（时长自动映射到 4/5/6/8/10/15s 档位）
                </span>
                <span>单镜头 {formatCredits(singleShotEstimateCredits)} 积分</span>
                {selectedShotIds.size > 0 && (
                  <span>
                    当前选中 {formatCredits(selectedEstimateCredits)} 积分
                  </span>
                )}
                <span>一键出片 {formatCredits(chainEstimateCredits)} 积分</span>
              </div>
            )}

            {/* P6 总进度条 */}
            <div className="mb-6">
              <ProgressBar
                progress={progress}
                label={`总进度：${completedShots}/${shots.length} 镜头完成`}
                size="md"
                variant={progress === 100 ? "success" : "accent"}
                pulse={progress < 100 && progress > 0}
                completed={progress === 100}
              >
                {formatEta(etaSec) && (
                  <span className="text-xs text-[var(--text-3)] tabular-nums whitespace-nowrap">
                    · {formatEta(etaSec)}
                  </span>
                )}
              </ProgressBar>
            </div>

            {/* P7 增强提示词卡 */}
            <div className="card mb-4 overflow-hidden">
              <button
                onClick={() => setEnhancementCollapsed((v) => !v)}
                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-[var(--bg-hover)]/40 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="text-[var(--accent)]"
                  >
                    <path
                      d="M12 2l2.4 7.4H22l-6 4.4 2.3 7.2-6.3-4.6L5.7 21l2.3-7.2-6-4.4h7.6L12 2z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="text-xs font-semibold text-[var(--text-2)]">
                    增强提示词
                  </span>
                  <span className="text-[10px] text-[var(--text-3)]/70">
                    用于指导视频生成风格/节奏（成组生成、一键出片时生效）
                  </span>
                </div>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  className={`text-[var(--text-3)] transition-transform ${
                    enhancementCollapsed ? "" : "rotate-180"
                  }`}
                >
                  <path
                    d="M3 6l5 5 5-5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {!enhancementCollapsed && (
                <div className="px-4 pb-3">
                  {enhancementEditing ? (
                    <>
                      <textarea
                        value={enhancementDraft}
                        onChange={(e) => setEnhancementDraft(e.target.value)}
                        rows={6}
                        autoFocus
                        placeholder="可选。例如：镜头运动平稳、色调偏暖；远景多用航拍；对白镜头保留反应特写..."
                        className="w-full px-3 py-2 rounded-lg bg-[var(--bg-2)] border border-[var(--action)]/40 text-xs text-[var(--text)] placeholder:text-[var(--text-3)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--action)]/20 resize-y leading-5"
                      />
                      <div className="flex items-center gap-2 mt-2">
                        <button
                          onClick={() => {
                            setEnhancementPrompt(enhancementDraft);
                            setEnhancementEditing(false);
                            toast.success("增强提示词已保存");
                          }}
                          className="px-3 py-1 rounded-md bg-[var(--action)] text-white text-xs font-medium hover:opacity-90 transition-opacity"
                        >
                          保存
                        </button>
                        <button
                          onClick={() => {
                            setEnhancementEditing(false);
                            setEnhancementDraft("");
                          }}
                          className="px-3 py-1 rounded-md bg-[var(--bg-hover)] text-[var(--text-2)] text-xs font-medium hover:opacity-80 transition-opacity"
                        >
                          取消
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div
                        onClick={() => {
                          setEnhancementDraft(enhancementPrompt || "");
                          setEnhancementEditing(true);
                        }}
                        className={`px-3 py-2 rounded-lg bg-[var(--bg-2)] border border-[var(--border-light)] text-xs leading-5 cursor-text min-h-[36px] ${
                          (enhancementPrompt || "").trim()
                            ? "text-[var(--text)]"
                            : "text-[var(--text-3)]/50"
                        }`}
                      >
                        {(enhancementPrompt || "").trim() ||
                          "点击「修改」添加增强提示词（可选）"}
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <button
                          onClick={() => {
                            setEnhancementDraft(enhancementPrompt || "");
                            setEnhancementEditing(true);
                          }}
                          className="px-3 py-1 rounded-md bg-[var(--bg-hover)] text-[var(--text-2)] text-xs font-medium hover:opacity-80 transition-opacity flex items-center gap-1"
                        >
                          <svg
                            width="11"
                            height="11"
                            viewBox="0 0 16 16"
                            fill="none"
                          >
                            <path
                              d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinejoin="round"
                            />
                          </svg>
                          修改
                        </button>
                        {(enhancementPrompt || "").trim() && (
                          <button
                            onClick={() => {
                              setEnhancementPrompt("");
                              toast.info("已清空增强提示词");
                            }}
                            className="px-3 py-1 rounded-md text-[var(--text-3)] text-xs hover:text-[var(--danger)] transition-colors"
                          >
                            清空
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* P8 一键出片 / 导出进度卡 */}
            {(chainRunning || exportRunning) && (
              <div className="mb-6 p-4 rounded-[var(--radius)] bg-[var(--bg-card)] border border-[var(--border-light)]">
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className="w-9 h-9 rounded-full border-2 border-[var(--action)]/20 border-t-[var(--action)] animate-spin flex-shrink-0"
                    aria-hidden="true"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-[var(--text)]">
                      {exportRunning
                        ? "🎬 成片导出中"
                        : "🎬 一键出片 · 串联生成中"}
                    </div>
                    <div className="text-xs text-[var(--text-3)] mt-0.5 truncate">
                      {(exportRunning ? exportJob?.stage : chainJob?.stage) ||
                        "处理中..."}{" "}
                      · job{" "}
                      {(exportRunning
                        ? exportJob?.renderJobId
                        : chainJob?.renderJobId
                      )?.slice(0, 8)}
                    </div>
                    {chainRunning && formatEta(chainEtaSec) && (
                      <div className="text-xs text-[var(--text-3)] mt-0.5 tabular-nums">
                        预计剩余 {formatEta(chainEtaSec)}
                        {chainGroupProgress.total
                          ? ` · 已完成 ${chainGroupProgress.done}/${chainGroupProgress.total} 组`
                          : ""}
                      </div>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-xl font-black text-[var(--action)] tabular-nums">
                      {Math.floor(
                        (exportRunning
                          ? exportJob?.progress
                          : chainJob?.progress) ?? 0,
                      )}
                      %
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleCancelP8}
                    className="px-2 py-1 rounded-md text-xs text-[var(--text-3)] hover:text-[var(--error)] transition-colors flex-shrink-0"
                    title="取消生成"
                  >
                    取消
                  </button>
                </div>
                <ProgressBar
                  progress={
                    (exportRunning
                      ? exportJob?.progress
                      : chainJob?.progress) ?? 0
                  }
                  label={
                    (exportRunning
                      ? exportJob?.stage
                      : chainJob?.stage) || "处理中"
                  }
                  size="sm"
                  variant="action"
                  pulse={
                    ((exportRunning ? exportJob?.progress : chainJob?.progress) ?? 0) < 100
                  }
                  completed={
                    ((exportRunning ? exportJob?.progress : chainJob?.progress) ?? 0) >= 100
                  }
                >
                  {chainJob && chainJob.stageProgress > 0 && (
                    <span className="text-xs text-[var(--text-3)] tabular-nums whitespace-nowrap ml-2">
                      · {Math.floor(chainJob.stageProgress)}%
                    </span>
                  )}
                </ProgressBar>
              </div>
            )}

            {chainJob?.status === "FAILED" && (
              <div className="mb-6 rounded-[var(--radius)] border border-[var(--error)]/40 bg-[var(--error)]/8 p-4">
                <div className="text-sm font-bold text-[var(--error)]">一键出片失败</div>
                <p className="mt-2 text-xs leading-5 text-[var(--text-2)]">
                  {formatGenerationFailure(chainJob.error)}
                </p>
                <div className="mt-2 text-[11px] text-[var(--text-3)] font-mono break-all">
                  task {chainJob.taskId} · job {chainJob.renderJobId}
                </div>
                {chainJob.error && (
                  <details className="mt-2 text-[11px] text-[var(--text-3)]">
                    <summary className="cursor-pointer text-[var(--action)]">技术详情</summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-[var(--bg-2)] p-2 font-mono">
                      {chainJob.error}
                    </pre>
                  </details>
                )}
              </div>
            )}

            {/* P9 结果卡 */}
            {chainResult && (
              <div className="mb-6 p-4 rounded-[var(--radius)] bg-[var(--bg-card)] border border-[var(--border-light)]">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-[var(--success)]/20 flex items-center justify-center flex-shrink-0">
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
                    <div
                      className={`text-base font-bold ${
                        chainResult.partialCompleted ? "text-amber-500" : "text-[var(--success)]"
                      }`}
                    >
                      {chainResult.partialCompleted
                        ? `⚠ 成片部分完成（${(chainResult.reusedGroups ?? 0) + (chainResult.generatedGroups ?? 0)} 组完成 · ${chainResult.failedGroups ?? 0} 组失败）`
                        : "🎉 成片已生成完成！"}
                    </div>
                    <div className="text-sm text-[var(--text-2)] mt-1">
                      {chainResult.totalGroups !== undefined &&
                        `${chainResult.totalGroups} 组 · `}
                      {chainResult.totalShots !== undefined &&
                        `${chainResult.totalShots} 个镜头 · `}
                      {chainResult.totalDuration !== undefined &&
                        `总时长 ${chainResult.totalDuration.toFixed(1)} 秒`}
                      {(chainResult.totalGroups === undefined &&
                        chainResult.totalShots === undefined &&
                        chainResult.totalDuration === undefined) &&
                        "成品存客户端本地（sf-asset://）"}
                      {chainResult.reusedGroups &&
                        chainResult.reusedGroups > 0 && (
                          <span className="ml-2 text-[var(--accent)]">
                            · 复用 {chainResult.reusedGroups} 组
                          </span>
                        )}
                      {chainResult.failedGroups &&
                        chainResult.failedGroups > 0 && (
                          <span className="ml-2 text-red-500">
                            · {chainResult.failedGroups} 组失败（成片可能不完整，建议在下方镜头组重试失败组）
                          </span>
                        )}
                    </div>
                    <div className="flex items-center gap-3 mt-3">
                      {!chainResult.partialCompleted && (
                      <>
                      <button
                        onClick={() => setFilmZoomOpen(true)}
                        className="px-4 py-2 rounded-[var(--radius-sm)] text-sm inline-flex items-center gap-2 bg-[var(--success)] hover:bg-[var(--success)]/90 text-white"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                        >
                          <path
                            d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <circle
                            cx="12"
                            cy="12"
                            r="3"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                        </svg>
                        预览成片
                      </button>
                      <button
                        onClick={() =>
                          void handleDownloadFilm(
                            chainResult.filmUrl,
                            chainResult.localKey,
                          )
                        }
                        className="px-4 py-2 rounded-lg text-sm inline-flex items-center gap-2 border border-[var(--success)]/30 text-[var(--success)] hover:bg-[var(--success)]/10"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                        >
                          <path
                            d="M12 3v13m0 0l-4-4m4 4l4-4M5 19h14"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        下载 MP4
                      </button>
                      </>
                      )}
                      <button
                        onClick={() => setChainResult(null)}
                        className="px-3 py-2 rounded-lg text-sm text-[var(--text-3)] hover:text-[var(--text)]"
                      >
                        关闭
                      </button>
                    </div>
                  </div>
                </div>
                {!chainResult.partialCompleted && (
                <div className="mt-4 w-full aspect-video bg-black rounded-lg overflow-hidden">
                  <video
                    src={chainResult.filmUrl}
                    className="w-full h-full object-contain"
                    controls
                    preload="metadata"
                  />
                </div>
                )}
              </div>
            )}

            {/* P11 智能成组卡 */}
            {!isReview &&
              productionGroups.length > 0 &&
              (() => {
                const groups = productionGroups;
                return (
                  <div className="space-y-2 mb-4">
                    <div className="text-xs font-semibold text-[var(--text-3)] uppercase tracking-wider">
                      智能成组 · 凑时长档位
                    </div>
                    {groups.map((g, gi) => {
                      const anyGenerating = g.shotIds.some((id) =>
                        generatingShots.has(id),
                      );
                      const groupShots = g.shotIds
                        .map((id) => shots.find((x) => x.id === id))
                        .filter(Boolean) as ShotRecord[];
                      const sortedGroupShots = [...groupShots].sort(
                        (a, b) => a.sortOrder - b.sortOrder,
                      );
                      const groupCompleted = groupShots.filter(
                        (s) =>
                          getEffectiveVideoStatus(s, generatingShots) ===
                          "COMPLETED",
                      ).length;
                      const groupFailed = groupShots.filter(
                        (s) =>
                          getEffectiveVideoStatus(s, generatingShots) ===
                          "FAILED",
                      ).length;
                      // 失败组的具体错误（服务端 failed_validation 写到 shot.metadata.videoError），
                      // 在该镜头组旁展示，让用户知道这组为何失败（如 Seedance 内容审核/版权拒）。
                      const groupErrorMessage = (() => {
                        for (const s of groupShots) {
                          if (getEffectiveVideoStatus(s, generatingShots) !== "FAILED") continue;
                          const m = (s.metadata ?? {}) as Record<string, unknown>;
                          if (typeof m.videoError === "string" && m.videoError.trim()) {
                            return m.videoError.trim();
                          }
                        }
                        return null;
                      })();
                      const groupPending = groupShots.filter(
                        (s) => {
                          const status = getEffectiveVideoStatus(
                            s,
                            generatingShots,
                          );
                          return status === "PENDING" || status === "FAILED";
                        },
                      );
                      const groupGenerating = groupShots.filter(
                        (s) =>
                          getEffectiveVideoStatus(s, generatingShots) ===
                          "GENERATING",
                      );
                      const groupProgress =
                        g.shotIds.length > 0
                          ? Math.round(
                              (groupCompleted / g.shotIds.length) * 100,
                            )
                          : 0;
                      const groupDone =
                        groupCompleted === g.shotIds.length;
                      const hasRemaining = groupPending.length > 0;
                      const isRemainingSuffix = (() => {
                        if (!hasRemaining) return false;
                        const pendingIdSet = new Set(
                          groupPending.map((s) => s.id),
                        );
                        let lastCompletedIdx = -1;
                        sortedGroupShots.forEach((s, idx) => {
                          if (
                            getEffectiveVideoStatus(s, generatingShots) ===
                            "COMPLETED"
                          )
                            lastCompletedIdx = idx;
                        });
                        if (lastCompletedIdx < 0) return false;
                        return sortedGroupShots
                          .slice(lastCompletedIdx + 1)
                          .every((s) => pendingIdSet.has(s.id));
                      })();

                      // “生成剩余”只提交待生成后缀；其他组操作提交整个组。按钮积分
                      // 与实际 shotIds 使用同一集合，避免展示少扣、实际整组计费。
                      const generationTargetShotIds = isRemainingSuffix
                        ? sortedGroupShots
                            .filter((shot) =>
                              groupPending.some((pending) => pending.id === shot.id),
                            )
                            .map((shot) => shot.id)
                        : g.shotIds;
                      const groupEstimateCredits = estimateCreditsForShotIds(
                        generationTargetShotIds,
                      );

                      const firstShot = sortedGroupShots[0];
                      const firstShotId = firstShot?.id;
                      const firstMeta = (firstShot?.metadata ?? {}) as Record<
                        string,
                        unknown
                      >;
                      const savedPrompt = firstMeta.seedanceGroupPrompt;
                      const hasSavedPrompt =
                        typeof savedPrompt === "string" &&
                        savedPrompt.trim().length > 0;
                      // 真实引用资产图（快照落库：与提交时参考图数组严格同序，图片N=refs[N-1]）。
                      const groupRefs = Array.isArray(
                        (firstMeta.seedanceGroupPromptReferences as { refs?: unknown } | undefined)
                          ?.refs,
                      )
                        ? ((
                            firstMeta.seedanceGroupPromptReferences as {
                              refs: Array<{
                                url?: unknown;
                                name?: unknown;
                                kind?: unknown;
                                variantLabel?: unknown;
                                variantCode?: unknown;
                              }>;
                            }
                          ).refs.filter(
                            (ref) =>
                              typeof ref?.url === "string" && ref.url.length > 0,
                          ))
                        : [];
                      const hasCustomPrompt =
                        hasSavedPrompt &&
                        firstMeta.seedanceGroupPromptSource === "user";
                      const promptStatus = getGroupPromptUiStatus(
                        firstMeta,
                        g.shotIds,
                      );
                      const promptStatusLabel =
                        promptStatus === "READY"
                          ? "READY 已就绪"
                          : promptStatus === "STALE"
                            ? "STALE 待重新整合"
                            : "MISSING 未生成";
                      // 组提示词审核锁定派生量（C 方案）
                      const promptApproved =
                        firstMeta.seedanceGroupPromptApproved === true;
                      const promptFinalized =
                        hasSavedPrompt &&
                        firstMeta.seedanceGroupPromptRewritten === true;
                      // 认可后即使资产/镜头变了（STALE）也只提醒不阻断、不重写。
                      const promptStaleHint =
                        promptApproved && promptStatus === "STALE";
                      // 组视频片段（同组共享 currentMaterialUrl；渐进回传已写入）。
                      const groupClipUrl =
                        groupShots.find(
                          (s) =>
                            getEffectiveVideoStatus(s, generatingShots) ===
                            "COMPLETED",
                        )?.currentMaterialUrl ?? null;
                      const finalizingThis =
                        finalizingFirstShotId === firstShotId;

                      const buttonLabel = groupDone
                        ? "重新生成"
                        : isRemainingSuffix
                          ? `生成剩余 ${groupPending.length} 镜`
                          : hasRemaining && groupCompleted > 0
                            ? "全部重新生成"
                            : "成组生成";

                      const getShotStatusIcon = (s: ShotRecord) => {
                        const status = getEffectiveVideoStatus(
                          s,
                          generatingShots,
                        );
                        if (status === "COMPLETED") {
                          return (
                            <span
                              title={`${s.shotSeq || s.id.slice(0, 6)} · 已完成`}
                              className="w-5 h-5 rounded-full bg-[var(--success)]/15 text-[var(--success)] flex items-center justify-center flex-shrink-0"
                            >
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 16 16"
                                fill="none"
                              >
                                <path
                                  d="M3 8l3.5 3.5L13 5"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                          );
                        }
                        if (status === "GENERATING") {
                          return (
                            <span
                              title={`${s.shotSeq || s.id.slice(0, 6)} · 生成中`}
                              className="w-5 h-5 rounded-full bg-[var(--action)]/15 text-[var(--action)] flex items-center justify-center flex-shrink-0"
                            >
                              <span className="relative block h-1 w-3 overflow-hidden rounded-full bg-current/20">
                                <span className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-current" style={{ animation: "loadingbar 1.2s ease-in-out infinite" }} />
                              </span>
                            </span>
                          );
                        }
                        if (status === "FAILED") {
                          return (
                            <span
                              title={`${s.shotSeq || s.id.slice(0, 6)} · 失败`}
                              className="w-5 h-5 rounded-full bg-[var(--error)]/15 text-[var(--error)] flex items-center justify-center flex-shrink-0"
                            >
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 16 16"
                                fill="none"
                              >
                                <path
                                  d="M4 4l8 8M12 4l-8 8"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                />
                              </svg>
                            </span>
                          );
                        }
                        return (
                          <span
                            title={`${s.shotSeq || s.id.slice(0, 6)} · 待生成`}
                            className="w-5 h-5 rounded-full bg-[var(--text-3)]/10 text-[var(--text-3)] flex items-center justify-center flex-shrink-0"
                          >
                            <span className="w-2 h-2 rounded-full bg-current" />
                          </span>
                        );
                      };

                      const getShotStatusLabel = (s: ShotRecord) => {
                        const status = getEffectiveVideoStatus(
                          s,
                          generatingShots,
                        );
                        if (status === "COMPLETED")
                          return "text-[var(--success)]";
                        if (status === "GENERATING")
                          return "text-[var(--action)]";
                        if (status === "FAILED") return "text-[var(--error)]";
                        return "text-[var(--text-3)]";
                      };

                      return (
                        <div key={gi} className="card p-3 flex flex-col gap-3">
                          <div className="flex items-center gap-3">
                            <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-[var(--action-dim)] flex items-center justify-center">
                              <span className="text-xs font-bold text-[var(--action)]">
                                {gi + 1}
                              </span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-[var(--text)]">
                                {g.groupLabel}
                              </div>
                              <div className="text-xs text-[var(--text-3)] mt-0.5">
                                {g.shotIds.length} 镜合并 · 资产合集 + 连续时间码
                                {groupDone ? (
                                  <span className="ml-2 text-[var(--success)]">
                                    · 全部完成
                                  </span>
                                ) : (
                                  <>
                                    {groupCompleted > 0 && (
                                      <span className="ml-2 text-[var(--success)]">
                                        · {groupCompleted} 已完成
                                      </span>
                                    )}
                                    {groupGenerating.length > 0 && (
                                      <span className="ml-2 text-[var(--action)]">
                                        · {groupGenerating.length} 生成中
                                      </span>
                                    )}
                                    {hasRemaining && (
                                      <span className="ml-2 text-[var(--warning)]">
                                        · {groupPending.length} 待生成
                                      </span>
                                    )}
                                    {groupFailed > 0 && (
                                      <span className="ml-2 text-[var(--error)]">
                                        · {groupFailed} 失败
                                      </span>
                                    )}
                                  </>
                                )}
                              </div>
                              <div className="text-[11px] text-[var(--text-3)] mt-1">
                                全部成功扣 {formatCredits(groupEstimateCredits)}{" "}
                                积分 · {videoModel.split("/").pop()} ·{" "}
                                {paramsDraft.resolution}
                                <span
                                  className={`ml-2 ${
                                    promptStatus === "READY"
                                      ? "text-[var(--success)]"
                                      : promptStatus === "STALE"
                                        ? "text-[var(--warning)]"
                                        : "text-[var(--text-3)]"
                                  }`}
                                >
                                  · 提示词 {promptStatusLabel}
                                </span>
                              </div>
                            </div>
                            <Button
                              onClick={() =>
                                handleGenerateGroup(generationTargetShotIds)
                              }
                              variant="primary"
                              size="sm"
                              loading={anyGenerating}
                              disabled={isReview}
                              className="flex-shrink-0"
                              title={buttonLabel}
                            >
                              {anyGenerating ? (
                                <>生成中</>
                              ) : (
                                <>
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                  >
                                    <path
                                      d="M5 4v16l14-8L5 4z"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                  {buttonLabel}
                                  <span className="rounded bg-black/10 px-1 py-0.5 text-[10px] tabular-nums">
                                    {formatCredits(groupEstimateCredits)}积分
                                  </span>
                                </>
                              )}
                            </Button>
                          </div>

                          {/* 每个镜头的状态指示器 */}
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {sortedGroupShots.map((s, sIdx) => (
                              <div
                                key={s.id}
                                className="flex items-center gap-1"
                                title={`${s.shotSeq || s.id.slice(0, 6)} · ${s.durationSeconds || 2}s`}
                              >
                                {sIdx > 0 && (
                                  <span className="text-[var(--text-3)]/40 mx-0.5">
                                    →
                                  </span>
                                )}
                                {getShotStatusIcon(s)}
                                <span
                                  className={`text-[11px] font-medium tabular-nums ${getShotStatusLabel(s)}`}
                                >
                                  {s.shotSeq || `#${sIdx + 1}`}
                                </span>
                              </div>
                            ))}
                          </div>

                          {groupErrorMessage && (
                            <div className="flex items-start gap-1.5 text-[11px] text-[var(--error)] bg-[var(--error)]/8 rounded px-2 py-1.5">
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                className="flex-shrink-0 mt-0.5"
                              >
                                <path
                                  d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                              <span className="break-all">{groupErrorMessage}</span>
                            </div>
                          )}

                          {/* 组进度 */}
                          {groupProgress > 0 && !groupDone && (
                            <ProgressBar
                              progress={groupProgress}
                              label={`生成中 · ${groupCompleted}/${g.shotIds.length} 镜头覆盖`}
                              size="sm"
                              pulse={groupProgress < 100}
                              completed={groupProgress >= 100}
                            />
                          )}
                          {groupDone && (
                            <div className="flex items-center gap-2 text-xs text-[var(--success)]">
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 16 16"
                                fill="none"
                              >
                                <path
                                  d="M3 8l3.5 3.5L13 5"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                              全部 {g.shotIds.length} 镜已完成
                            </div>
                          )}

                          {/* 组提示词审核锁定 + 组视频片段（C+E 方案） */}
                          <div className="rounded-lg border border-[var(--border-light)] bg-[var(--bg-2)]/40 p-3 space-y-2">
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <span className="text-xs font-medium text-[var(--text-2)]">
                                组提示词
                                {promptApproved && (
                                  <span className="ml-1.5 text-[var(--accent)]">
                                    🔒 已认可锁定
                                  </span>
                                )}
                                {promptStaleHint && (
                                  <span
                                    className="ml-1.5 text-[var(--warning)]"
                                    title="资产/镜头已变更，当前锁定提示词可能对不上参考图。可点「重新生成」更新。"
                                  >
                                    ⚠ 可能过期
                                  </span>
                                )}
                              </span>
                              <div className="flex items-center gap-1.5">
                                {!promptFinalized && !promptApproved && (
                                  <button
                                    type="button"
                                    disabled={finalizingThis}
                                    onClick={() =>
                                      void finalizeGroupPrompt(
                                        g.shotIds,
                                        firstShotId ?? "",
                                        false,
                                      )
                                    }
                                    className="btn-ghost px-2.5 py-1 rounded-md text-xs whitespace-nowrap disabled:opacity-50"
                                  >
                                    {finalizingThis ? "生成中…" : "🔍 生成最终提示词"}
                                  </button>
                                )}
                                {promptFinalized && !promptApproved && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void approveGroupPrompt(firstShotId ?? "", true)
                                    }
                                    className="btn-primary px-2.5 py-1 rounded-md text-xs whitespace-nowrap"
                                  >
                                    ✓ 认可锁定
                                  </button>
                                )}
                                {(promptFinalized || promptApproved) && (
                                  <button
                                    type="button"
                                    disabled={finalizingThis}
                                    onClick={() =>
                                      void finalizeGroupPrompt(
                                        g.shotIds,
                                        firstShotId ?? "",
                                        true,
                                      )
                                    }
                                    className="btn-ghost px-2.5 py-1 rounded-md text-xs whitespace-nowrap disabled:opacity-50"
                                    title="重新生成最终提示词（会解除当前锁定）"
                                  >
                                    {finalizingThis ? "生成中…" : "重新生成"}
                                  </button>
                                )}
                              </div>
                            </div>
                            {/* 真实引用资产图（提交顺序+变体编号，生产核对用） */}
                            {groupRefs.length > 0 && (
                              <div className="mb-2">
                                <ReferenceAssetStrip refs={groupRefs} />
                              </div>
                            )}
                            {hasSavedPrompt && typeof savedPrompt === "string" ? (
                              <GroupPromptEditor
                                savedPrompt={savedPrompt}
                                disabled={chainSubmitting || finalizingThis}
                                onSave={(prompt) =>
                                  saveGroupPrompt(firstShotId ?? "", prompt)
                                }
                              />
                            ) : (
                              <p className="text-[11px] text-[var(--text-3)]">
                                尚无最终提示词。点「生成最终提示词」由 AI 生成审核友好版本供你核对，认可后生产只用此提示词、不再反复调 AI。
                              </p>
                            )}
                          </div>

                          {/* 组视频片段（同组共享，方便核对） — 预览框过大已收小：限高 200px + object-contain（竖屏视频完整显示，不再裁切/留大黑边） */}
                          {groupClipUrl && (
                            <div
                              className="relative h-[200px] w-full bg-[var(--bg-hover)] rounded-lg overflow-hidden cursor-pointer hover:opacity-90 transition-opacity"
                              onClick={(e) => {
                                e.stopPropagation();
                                const completedItems = shots.filter(
                                  (sh) =>
                                    sh.videoStatus === "COMPLETED" &&
                                    sh.currentMaterialUrl,
                                );
                                const idx = completedItems.findIndex(
                                  (sh) => sh.currentMaterialUrl === groupClipUrl,
                                );
                                if (idx >= 0) setVideoZoomIndex(idx);
                              }}
                              title="点击放大查看组视频"
                            >
                              <video
                                src={groupClipUrl}
                                className="h-full w-full object-contain"
                                preload="metadata"
                                muted
                                onMouseEnter={(e) => {
                                  (e.target as HTMLVideoElement)
                                    .play()
                                    .catch(() => undefined);
                                }}
                                onMouseLeave={(e) => {
                                  const v = e.target as HTMLVideoElement;
                                  v.pause();
                                  v.currentTime = 0;
                                }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

            {/* P12 镜头列表（支持选择） */}
            <div className="flex-1 space-y-3">
              {shots.length === 0 && (
                <div className="text-center py-24 text-[var(--text-3)]">
                  暂无镜头数据，请先在「分镜」阶段生成镜头
                </div>
              )}
              {shots.map((s, i) => {
                const isGenerating = generatingShots.has(s.id);
                const isCompleted = s.videoStatus === "COMPLETED";
                const isFailed = s.videoStatus === "FAILED";
                const isSelected = selectedShotIds.has(s.id);
                const canSelect = !isGenerating && !isReview;
                const assetReferences = shotAssetBindingsMap.get(s.id) ?? [];
                return (
                  <div
                    key={s.id}
                    onClick={(e) => {
                      if (canSelect) toggleShotSelection(s.id, e.shiftKey);
                    }}
                    className={`card p-4 flex flex-col gap-3 animate-fade-in cursor-pointer transition-all ${
                      isSelected
                        ? "ring-2 ring-[var(--action)] bg-[var(--action-dim)]/10"
                        : ""
                    } ${isGenerating ? "ring-1 ring-[var(--action)]/30" : ""} ${isFailed ? "ring-1 ring-[var(--error)]/30" : ""} ${
                      canSelect ? "hover:border-[var(--action)]/40" : ""
                    }`}
                    style={{ animationDelay: `${i * 30}ms` }}
                  >
                    <div className="flex items-start gap-4">
                      {/* 选择框 + 状态图标 */}
                      <div className="flex-shrink-0 mt-1 flex items-center gap-2">
                        {canSelect && (
                          <div
                            className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                              isSelected
                                ? "bg-[var(--action)] border-[var(--action)]"
                                : "border-[var(--border-light)]"
                            }`}
                          >
                            {isSelected && (
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 16 16"
                                fill="none"
                              >
                                <path
                                  d="M3 8l3.5 3.5L13 5"
                                  stroke="white"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </div>
                        )}
                        {isCompleted ? (
                          <div className="w-10 h-10 rounded-xl bg-[var(--success-dim)] flex items-center justify-center">
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 16 16"
                              fill="none"
                            >
                              <path
                                d="M3 8l3.5 3.5L13 5"
                                stroke="var(--success)"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </div>
                        ) : isFailed ? (
                          <div className="w-10 h-10 rounded-xl bg-[var(--error-dim)] flex items-center justify-center">
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 16 16"
                              fill="none"
                            >
                              <path
                                d="M4 4l8 8M12 4l-8 8"
                                stroke="var(--error)"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                              />
                            </svg>
                          </div>
                        ) : isGenerating ? (
                          <div
                            className="w-10 h-10 rounded-xl bg-[var(--action-dim)] flex items-center justify-center"
                            title="镜头生成中"
                          >
                            <span
                              role="progressbar"
                              aria-label="镜头生成中"
                              className="relative block h-1 w-7 overflow-hidden rounded-full bg-[var(--action)]/20"
                            >
                              <span
                                className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-[var(--action)]"
                                style={{ animation: "loadingbar 1.2s ease-in-out infinite" }}
                              />
                            </span>
                          </div>
                        ) : (
                          <div className="w-10 h-10 rounded-xl bg-[var(--bg-hover)] flex items-center justify-center text-[var(--text-3)] font-bold text-sm">
                            {String(i + 1).padStart(2, "0")}
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                          {s.shotSeq && (
                            <span className="font-mono text-xs text-[var(--text-3)]">
                              {s.shotSeq}
                            </span>
                          )}
                          <span
                            className={`badge ${
                              isCompleted
                                ? "badge-success"
                                : isFailed
                                  ? "badge-error"
                                  : isGenerating
                                    ? "badge-accent"
                                    : "badge-muted"
                            }`}
                          >
                            {isCompleted
                              ? "已完成"
                              : isFailed
                                ? "生成失败"
                                : isGenerating
                                  ? "生成中"
                                  : "待生成"}
                          </span>
                          {isCompleted &&
                            (() => {
                              const updatedAt = s.metadata?.materialUpdatedAt as
                                | string
                                | undefined;
                              if (!updatedAt) return false;
                              // 2026-08-03：「新」徽标改为读 3 遍自动消失（不再用 24h）。
                              // 每次用户点击查看该镜头视频时 newSeenCount +1，满 3 次不再显示。
                              return Number(s.metadata?.newSeenCount ?? 0) < 3;
                            })() && (
                              <span
                                className="badge badge-accent"
                                title="新生成的素材（读过 3 次后消失）"
                              >
                                新
                              </span>
                            )}
                          {s.durationSeconds != null && (
                            <span className="text-[10px] text-[var(--text-3)] tabular-nums">
                              {s.durationSeconds}s
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-[var(--text-2)] leading-relaxed break-words whitespace-pre-wrap">
                          {s.visualPrompt || "无描述"}
                        </p>
                        {assetReferences.length > 0 && (
                          <ShotAssetReferenceBadges
                            references={assetReferences}
                            className="mt-2"
                          />
                        )}
                      </div>
                      <div className="flex-shrink-0 flex flex-col gap-2">
                        {isCompleted && s.currentMaterialUrl && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const completedItems = shots.filter(
                                (sh) =>
                                  sh.videoStatus === "COMPLETED" &&
                                  sh.currentMaterialUrl,
                              );
                              const idx = completedItems.findIndex(
                                (sh) => sh.id === s.id,
                              );
                              if (idx >= 0) setVideoZoomIndex(idx);
                              void markShotRead(s.id);
                            }}
                            className="btn-ghost px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                            >
                              <path
                                d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                              <circle
                                cx="12"
                                cy="12"
                                r="3"
                                stroke="currentColor"
                                strokeWidth="2"
                              />
                            </svg>
                            查看
                          </button>
                        )}
                        {!isGenerating && !isReview && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              // 已完成镜头先二次确认；待生成/失败镜头直接打开单镜参数弹窗。
                              // 两条路径最终都以 [s.id] 调 scoped chain-generate。
                              if (isCompleted) {
                                setRegenerateConfirmShotId(s.id);
                              } else {
                                handleGenerateGroup([s.id]);
                              }
                            }}
                            className="btn-ghost px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1"
                          >
                            {isCompleted ? "重新生成" : isFailed ? "重试" : "生成"}
                          </button>
                        )}
                      </div>
                    </div>
                    {/* 已完成 → 缩略图（点击放大；sf-asset:// 直接 video src） */}
                    {isCompleted && s.currentMaterialUrl && (
                      <div
                        className="relative w-full aspect-video bg-[var(--bg-hover)] rounded-lg overflow-hidden cursor-pointer hover:opacity-90 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation();
                          const completedItems = shots.filter(
                            (sh) =>
                              sh.videoStatus === "COMPLETED" &&
                              sh.currentMaterialUrl,
                          );
                          const idx = completedItems.findIndex(
                            (sh) => sh.id === s.id,
                          );
                          if (idx >= 0) setVideoZoomIndex(idx);
                          void markShotRead(s.id);
                        }}
                        title="点击放大查看视频"
                      >
                        <video
                          src={s.currentMaterialUrl}
                          className="w-full h-full object-cover"
                          preload="metadata"
                          muted
                          onMouseEnter={(e) => {
                            (e.target as HTMLVideoElement)
                              .play()
                              .catch(() => undefined);
                          }}
                          onMouseLeave={(e) => {
                            const v = e.target as HTMLVideoElement;
                            v.pause();
                            v.currentTime = 0;
                          }}
                        />
                      </div>
                    )}
                    {/* 错误信息：失败时显示 */}
                    {isFailed && (
                      <p className="text-xs text-[var(--error)] bg-[var(--error-dim)] px-3 py-2 rounded-lg">
                        {(s.metadata?.errorMessage as string) || "生成失败"}
                      </p>
                    )}
                  </div>
                );
              })}
              {/* 底部留白，避免浮动条遮挡 */}
              {selectedShotIds.size > 0 && <div className="h-20" />}
            </div>

            {/* P13 浮动选择操作栏 */}
            {selectedShotIds.size > 0 &&
              viewMode === "list" &&
              (() => {
                const consecutive = isSelectionConsecutive();
                const { total, valid, overLimit } = getSelectionDuration();
                const canGenerate =
                  consecutive &&
                  !overLimit &&
                  valid >= 4 &&
                  !isReview;
                return (
                  <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 px-6 py-3 rounded-2xl bg-[var(--bg-elevated)] border border-[var(--border-light)] shadow-2xl backdrop-blur-md">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-[var(--action-dim)] flex items-center justify-center">
                        <span className="text-sm font-bold text-[var(--action)]">
                          {selectedShotIds.size}
                        </span>
                      </div>
                      <span className="text-sm text-[var(--text-2)]">
                        个镜头已选
                      </span>
                    </div>
                    <div className="h-6 w-px bg-[var(--border-light)]" />
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-[var(--text-3)]">总时长</span>
                      <span className="font-mono font-medium text-[var(--text)]">
                        {total}s
                      </span>
                      <span className="text-[var(--text-3)]">→</span>
                      <span
                        className={`font-mono font-medium ${
                          overLimit
                            ? "text-[var(--warning)]"
                            : "text-[var(--accent)]"
                        }`}
                      >
                        {overLimit ? "超限" : `${valid}s 档`}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-[var(--text-3)]">全部成功积分</span>
                      <span className="font-mono font-medium text-[var(--accent)]">
                        {formatCredits(selectedEstimateCredits)}
                      </span>
                    </div>
                    {!consecutive && (
                      <span className="text-xs text-[var(--warning)]">
                        ⚠ 镜头不连续
                      </span>
                    )}
                    {consecutive && overLimit && (
                      <span className="text-xs text-[var(--warning)]">
                       ⚠ 超过 {maxGroupDuration}s 上限
                      </span>
                    )}
                    {consecutive && valid < 4 && (
                      <span className="text-xs text-[var(--warning)]">
                        ⚠ 不足 4s 最低时长
                      </span>
                    )}
                    <div className="h-6 w-px bg-[var(--border-light)]" />
                    <button
                      onClick={() => void handleGenerateSelected()}
                      disabled={!canGenerate}
                      className="btn-primary px-4 py-2 rounded-[var(--radius-sm)] text-sm inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <path
                          d="M5 4v16l14-8L5 4z"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      生成视频{" "}
                      <span className="rounded bg-black/10 px-1.5 py-0.5 text-[10px] tabular-nums">
                        {formatCredits(selectedEstimateCredits)}积分
                      </span>
                    </button>
                    <button
                      onClick={clearSelection}
                      className="btn-ghost px-3 py-2 rounded-lg text-sm text-[var(--text-3)] hover:text-[var(--text)]"
                    >
                      清空
                    </button>
                  </div>
                );
              })()}
          </div>
        ) : (
          /* P33 编辑器视图（VideoEditor — 另有 agent 维护） */
          <VideoEditor
            shots={shots as unknown as React.ComponentProps<typeof VideoEditor>["shots"]}
            completedShots={completedShots}
            generatingShots={generatingShots}
            isReview={isReview}
            onRefresh={onRefresh}
            projectId={projectId}
            onExportFilm={() => void handleExportFilm()}
            exporting={exportSubmitting || exportRunning}
            exportProgress={exportJob?.progress ?? 0}
            exportStage={exportJob?.stage ?? ""}
          />
        )}

        {/* P31 存为模板弹窗 */}
        {savePresetDialog.open && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={() =>
              setSavePresetDialog({ open: false, name: "", params: null })
            }
          >
            <div
              className="w-full max-w-md mx-4 p-5 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-light)] shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 mb-3">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6L12 2z"
                    stroke="var(--accent)"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <h3 className="text-sm font-bold text-[var(--text)]">
                  存为参数模板
                </h3>
              </div>
              <div className="text-xs text-[var(--text-3)] mb-3">
                将当前{" "}
                {savePresetDialog.params
                  ? Object.keys(savePresetDialog.params).length
                  : 0}{" "}
                项参数保存为模板，可跨项目批量应用。
              </div>
              <input
                type="text"
                value={savePresetDialog.name}
                onChange={(e) =>
                  setSavePresetDialog((prev) => ({
                    ...prev,
                    name: e.target.value,
                  }))
                }
                placeholder="模板名称（如：竖屏短视频-9:16）"
                maxLength={60}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSavePreset();
                }}
                className="w-full px-3 py-2 rounded-lg bg-[var(--bg)] border border-[var(--border-light)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--action)]/50"
              />
              {savePresetDialog.params && (
                <div className="mt-2 p-2 rounded-lg bg-[var(--bg-hover)] text-[10px] text-[var(--text-3)] flex flex-wrap gap-1.5">
                  {Object.entries(savePresetDialog.params).map(([k, v]) => (
                    <span
                      key={k}
                      className="px-1.5 py-0.5 rounded bg-[var(--accent-dim)] text-[var(--accent)] tabular-nums"
                    >
                      {k}: {String(v)}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-end gap-2 mt-4">
                <button
                  onClick={() =>
                    setSavePresetDialog({ open: false, name: "", params: null })
                  }
                  className="btn-ghost px-3 py-1.5 rounded-lg text-xs"
                >
                  取消
                </button>
                <button
                  onClick={() => void handleSavePreset()}
                  disabled={!savePresetDialog.name.trim()}
                  className="btn-primary px-4 py-1.5 rounded-[var(--radius-sm)] text-xs inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  保存模板
                </button>
              </div>
            </div>
          </div>
        )}

        {/* P14 一键出片参数弹窗（chain mode） */}
        {chainParamsDialogOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={() => {
              if (!chainSubmitting && !chainRunning && !persistedChainLock)
                setChainParamsDialogOpen(false);
            }}
          >
            <div
              className="w-full max-w-2xl mx-4 p-6 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-light)] shadow-2xl max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              {/* 标题 */}
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-base font-bold text-[var(--text)] flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
                        stroke="var(--accent)"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    一键出片参数
                  </h3>
                  <p className="text-xs text-[var(--text-3)] mt-0.5">
                    设置该集所有镜头的统一参数（云端按 provider 校验/忽略未识别项）
                  </p>
                </div>
                <button
                  onClick={() => {
                    if (!chainSubmitting && !chainRunning && !persistedChainLock)
                      setChainParamsDialogOpen(false);
                  }}
                  className="text-[var(--text-3)] hover:text-[var(--text)] p-1"
                  disabled={
                    chainSubmitting || chainRunning || !!persistedChainLock
                  }
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M18 6L6 18M6 6l12 12"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>

              {renderPresetSection()}
              {renderVideoParamsSection()}

              {/* 严格模式保连续性；并行模式适合独立镜头，按输入顺序合片。 */}
              <div className="mb-5">
                <div className="text-xs font-bold text-[var(--text-2)] mb-2 flex items-center gap-1.5">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 15a3 3 0 100-6 3 3 0 000 6z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  生成模式
                </div>
                <div className="flex items-center gap-4 mb-2">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="chainMode"
                      checked={chainMode === "strict"}
                      onChange={() => setChainMode("strict")}
                      className="w-3.5 h-3.5 accent-[var(--action)]"
                    />
                    <span className="text-xs text-[var(--text-2)]">
                      串行模式（按组依次生成）
                    </span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="chainMode"
                      checked={chainMode === "fast"}
                      onChange={() => setChainMode("fast")}
                      className="w-3.5 h-3.5 accent-[var(--action)]"
                    />
                  <span className="text-xs text-[var(--text-2)]">
                      并行加速（独立生成）
                    </span>
                  </label>
                </div>
                {chainMode === "fast" && (
                  <div className="flex items-center gap-2 mb-2 pl-1">
                    <label className="text-xs text-[var(--text-2)]">
                      并发数
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={chainConcurrency}
                      onChange={(e) =>
                        setChainConcurrency(
                          Math.min(
                            12,
                            Math.max(1, Number(e.target.value) || 1),
                          ),
                        )
                      }
                      className="w-16 px-2 py-1 rounded-lg bg-[var(--bg)] border border-[var(--border-light)] text-xs text-[var(--text)] focus:outline-none focus:border-[var(--action)]/50"
                    />
                    <span className="text-[10px] text-[var(--text-3)]">
                      对齐单 API key 上限；多 key 池可调高（最大 12）
                    </span>
                  </div>
                )}
                <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={chainForce}
                      onChange={(e) => setChainForce(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-[var(--border-light)] accent-[var(--action)]"
                  />
                  <span className="text-xs text-[var(--text-2)]">
                    强制重生（忽略已有镜头素材）
                  </span>
                </label>
                <p className="mt-2 text-[10px] text-[var(--text-3)]">
                  严格模式会把上一组末帧传给下一组；并行模式取消该依赖以提升速度，最终合片顺序不变。
                </p>
              </div>

              {/* 底部按钮 */}
              <div className="flex items-center justify-end gap-2 pt-3 border-t border-[var(--border-light)]">
                <div className="mr-auto text-xs text-[var(--text-3)]">
                  <span className="inline-flex items-center gap-2 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-dim)] px-3 py-1.5 text-[var(--accent)]">
                    全部成功扣{" "}
                    <strong className="tabular-nums">
                      {formatCredits(chainEstimateCredits)}
                    </strong>{" "}
                    积分
                    <span className="text-[10px] text-[var(--text-3)]">
                      {videoModel.split("/").pop()} · {paramsDraft.resolution}
                    </span>
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setChainParamsDialogOpen(false)}
                  disabled={chainSubmitting || chainRunning}
                >
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={chainSubmitting}
                  progress={chainSubmitting ? chainSubmissionProgress : undefined}
                  onClick={() => void handleChainConfirm()}
                  disabled={
                    chainSubmitting || chainRunning || !!persistedChainLock
                  }
                >
                  开始生成{" "}
                  <span className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] tabular-nums">
                    {formatCredits(chainEstimateCredits)}积分
                  </span>
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* P14 成组生成参数弹窗（group mode — dramaforge 适配，提交时转 chain） */}
        {groupParamsDialogOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={() => {
              if (!chainSubmitting) setGroupParamsDialogOpen(false);
            }}
          >
            <div
              className="w-full max-w-2xl mx-4 p-6 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-light)] shadow-2xl max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-base font-bold text-[var(--text)] flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M5 4v16l14-8L5 4z"
                        stroke="var(--accent)"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    成组生成参数
                  </h3>
                  <p className="text-xs text-[var(--text-3)] mt-0.5">
                    设置当前 {groupParamsTargetShotIds.length} 个目标镜头的生成参数；不会扩大到整集
                  </p>
                </div>
                <button
                  onClick={() => {
                    if (!chainSubmitting) setGroupParamsDialogOpen(false);
                  }}
                  className="text-[var(--text-3)] hover:text-[var(--text)] p-1"
                  disabled={chainSubmitting}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M18 6L6 18M6 6l12 12"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>

              {renderPresetSection()}
              {renderVideoParamsSection()}

              {/* 组提示词预览/编辑（A 方案：合并自原卡片"生成提示词"入口） */}
              <div className="card mb-2 overflow-hidden">
                <button
                  onClick={() => setGroupPromptCollapsed((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-[var(--bg-hover)]/40 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      className="text-[var(--accent)]"
                    >
                      <path
                        d="M4 6h16M4 12h10M4 18h7"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="text-xs font-semibold text-[var(--text-2)]">
                      镚头组提示词
                    </span>
                    <span className="text-[10px] text-[var(--text-3)]/70">
                      生成时自动整合；可在此查看或修改后再生成
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        void loadDialogPrompt(groupParamsTargetShotIds, true);
                      }}
                      className="text-[11px] text-[var(--action)] hover:underline"
                    >
                      {dialogPromptLoading ? "整合中…" : "重新整合"}
                    </span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="none"
                      className={`text-[var(--text-3)] transition-transform ${groupPromptCollapsed ? "" : "rotate-180"}`}
                    >
                      <path
                        d="M3 6l5 5 5-5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                </button>
                {!groupPromptCollapsed && (
                  <div className="px-4 pb-3">
                    <textarea
                      value={dialogPromptDraft}
                      onChange={(e) => {
                        setDialogPromptDraft(e.target.value);
                        setDialogPromptDirty(true);
                      }}
                      disabled={dialogPromptLoading || chainSubmitting}
                      rows={12}
                      placeholder={
                        dialogPromptLoading
                          ? "正在整合镚头组提示词…"
                          : "提示词将在生成时自动整合；可在此查看或修改后再生成。"
                      }
                      className="w-full resize-y rounded-lg border border-[var(--border-light)] bg-[var(--bg-elevated)] px-2.5 py-2 text-xs text-[var(--text)] placeholder:text-[var(--text-3)] focus:border-[var(--accent)] focus:outline-none leading-5"
                    />
                    <p className="text-[10px] text-[var(--text-3)] mt-1">
                      生成或重新整合后自动保存；修改后生成将优先使用您的版本。
                    </p>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-[var(--border-light)]">
                <div className="mr-auto text-xs text-[var(--text-3)]">
                  <span className="inline-flex items-center gap-2 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-dim)] px-3 py-1.5 text-[var(--accent)]">
                    全部成功扣{" "}
                    <strong className="tabular-nums">
                      {formatCredits(groupDialogEstimateCredits)}
                    </strong>{" "}
                    积分
                    <span className="text-[10px] text-[var(--text-3)]">
                      {videoModel.split("/").pop()} · {paramsDraft.resolution}
                    </span>
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleSaveDialogPrompt()}
                  disabled={!dialogPromptDirty || chainSubmitting}
                >
                  保存提示词
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setGroupParamsDialogOpen(false)}
                  disabled={chainSubmitting}
                >
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={chainSubmitting}
                  progress={chainSubmitting ? chainSubmissionProgress : undefined}
                  onClick={() => void handleGenerateGroupConfirm()}
                >
                  生成{" "}
                  <span className="rounded bg-black/10 px-1.5 py-0.5 text-[10px] tabular-nums">
                    {formatCredits(groupDialogEstimateCredits)}积分
                  </span>
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 隐藏的文件输入（导入 JSON 参数） */}
        <input
          type="file"
          ref={importFileRef}
          accept=".json"
          onChange={(e) => void handleImportParams(e)}
          className="hidden"
        />

        {/* 单镜重制确认：确认后打开单镜参数弹窗，最终只提交一个 shotId。 */}
        <ConfirmDialog
          open={regenerateConfirmShotId !== null}
          title="重新生成视频"
          message={`仅重新生成当前镜头，成功后预计扣 ${formatCredits(regenerateConfirmEstimateCredits)} 积分，确定继续？`}
          variant="warning"
          confirmLabel={`确定 · ${formatCredits(regenerateConfirmEstimateCredits)} 积分起`}
          onConfirm={() => {
            if (regenerateConfirmShotId) {
              handleGenerateGroup([regenerateConfirmShotId]);
              setRegenerateConfirmShotId(null);
            }
          }}
          onCancel={() => setRegenerateConfirmShotId(null)}
        />
      </div>

      {/* P19 放大查看单镜头视频 */}
      {(() => {
        const videoZoomItems: ZoomItem[] = shots
          .filter((s) => s.videoStatus === "COMPLETED" && s.currentMaterialUrl)
          .map((s, i, arr) => {
            const globalIdx = shots.findIndex((x) => x.id === s.id);
            return {
              id: s.id,
              title: `镜头 ${String(globalIdx + 1).padStart(2, "0")}${s.shotSeq ? ` · ${s.shotSeq}` : ""}`,
              subtitle: `${i + 1} / ${arr.length}`,
              videoSrc: s.currentMaterialUrl ?? undefined,
              downloadable: true,
              meta: [
                ...(s.durationSeconds != null
                  ? [{ label: "时长", value: `${s.durationSeconds.toFixed(1)}s` }]
                  : []),
                { label: "画面提示词", value: s.visualPrompt || "—" },
              ],
            };
          });
        return (
          <ZoomViewer
            mode="video"
            items={videoZoomItems}
            index={Math.max(0, videoZoomIndex)}
            open={videoZoomIndex >= 0}
            onClose={() => setVideoZoomIndex(-1)}
            onIndexChange={setVideoZoomIndex}
          />
        );
      })()}

      {/* P20 放大查看成片（单条，禁用导航） */}
      <ZoomViewer
        mode="video"
        items={
          chainResult
            ? [
                {
                  id: "film",
                  title: "成片预览",
                  videoSrc: chainResult.filmUrl,
                  downloadable: true,
                  meta: [
                    { label: "总镜头数", value: `${chainResult.totalShots ?? shots.length}` },
                    ...(chainResult.totalGroups !== undefined
                      ? [{ label: "总组数", value: `${chainResult.totalGroups}` }]
                      : []),
                    ...(chainResult.totalDuration !== undefined
                      ? [
                          {
                            label: "总时长",
                            value: `${chainResult.totalDuration.toFixed(1)}s`,
                          },
                        ]
                      : []),
                    ...(chainResult.reusedGroups
                      ? [
                          {
                            label: "复用组数",
                            value: `${chainResult.reusedGroups}`,
                          },
                        ]
                      : []),
                    ...(chainResult.generatedGroups
                      ? [
                          {
                            label: "生成组数",
                            value: `${chainResult.generatedGroups}`,
                          },
                        ]
                      : []),
                    ...(chainResult.failedGroups
                      ? [
                          {
                            label: "失败组数",
                            value: `${chainResult.failedGroups}`,
                          },
                        ]
                      : []),
                  ],
                },
              ]
            : []
        }
        index={0}
        open={filmZoomOpen}
        onClose={() => setFilmZoomOpen(false)}
        onIndexChange={() => undefined}
        disableNavigation
      />
    </div>
  );
}

// 显式 re-export 默认模型常量，避免 EpisodeWorkspace import 路径走样
export { DEFAULT_VIDEO_MODEL };
