"use client";

/**
 * @file AssetDesignStage.tsx — 资产设定阶段组件（阶段 3，批5）
 *
 * 镜像 app1 `F:\app1\src\app\workspace\[projectId]\components\AssetDesignStage.tsx`
 * （2654 行，5 组件：AssetDesignStage + CharacterSidebar + AssetCard +
 * CharacterEditorPanel + VoiceSelector + VoiceBrowserModal），并使用 app1 的异步任务
 * 生命周期（任务队列 + SSE + 轮询恢复 + 本地持久锁）。
 *
 * 职责（A1-A18，对齐 app1，并按 C/S 媒体边界优化）：
 *   1. A1 标题区：h2 + 副标题（角色/物品/环境/实体 + 已确认统计）
 *   2. A2 顶部操作：「完成资产设定，进入分镜」按钮
 *   3. A3 工具栏：进度条（确认进度 + 生成中 pulse）+ 已锁定统计
 *   4. A4 四类 Tab + 添加 + 重新提取 + 生成当页 + 全部生成 + 重新生成 +
 *      一键确认 + 一键解锁
 *   5. A5 重新提取中进度（ProgressBar pulse）
 *   6. A6 增强提示词折叠卡（编辑/查看双态，父组件持有 localStorage）
 *   7. A7 添加资产表单
 *   8. A8 主内容区：CHARACTER/PROP/LOCATION/ENTITY 左右分栏（CharacterSidebar +
 *      CharacterEditorPanel）
 *   9. A10 重新提取：POST /asset-extraction（dramaforge 247 行最小集，body {model}）
 *   10. A11 AssetCard：图片版本、描述/改名、富字段、造型、音色、网格/彩铅、
 *       生成/确认/删除按钮
 *   11. A13 删除确认对话框
 *   12. A14 放大查看（ZoomViewer，支持滚轮缩放、左右切换）
 *
 * 与 app1 差异（行为等价，GC 翻译）：
 *   - 删 isProviderReady/BYOK（GC-1：key 云端始终就绪）
 *   - 删 proxyImageUrl 代理（OP3 必修：直接用 asset.imageUrl sf-asset://，
 *     dramaforge 无 /api/.../image?v= 代理 route，原逻辑会 404）
 *   - 造型变体、角色/ENTITY 音色库、彩铅/网格和级联改名已接回；本地音频/图片
 *     通过 sfShell 读取，服务器只保存 sf-asset:// 标识和文本元数据。
 *   - 音色绑定区复用 VoiceBrowserModal。
 *     视觉照搬 app1（F:\app1\src\...\AssetDesignStage.tsx:2108-2653）；C/S 适配：
 *     列表/试听走 sfShell.listPresetVoices/readPresetVoice（wav 字节客户端本地，
 *     server 零音频字节）；绑定 PATCH {voiceSource:'library', voiceId, voiceTrait}，
 *     字段已在 PATCH 白名单（批4阶段2）。AI 资产提取建议音色预填 voiceTrait
 *     （asset-extraction route 调 validateSuggestedVoices 校正文件名 + manifest
 *     存 packages/server/data/voices-manifest.json 喂 buildAssetExtractionPrompt）。
 *   - 批2b 加回 handleUploadImage：File → sfShell.saveLocalAsset（IPC 批2a）→
 *     sf-asset:// key → PATCH imageUrl。无 /api/upload，服务器零媒体字节。
 *   - 改 IMAGE_MODELS/LANGUAGE_MODELS 从 @/lib/models import（dramaforge 静态目录）
 *   - 改 ASSET_RESOLUTIONS/ASSET_IMAGE_STYLES 从 @dramaforge/server/prompt import
 *     （subpath export，避免主 barrel node:* 依赖污染 client bundle）
 *   - handleGenerateImage 与批量生成对齐 app1：POST 返回 taskId 后立即跟踪，
 *     worker 持久化并回写，终态由 SSE 或 /api/tasks 轮询恢复。
 *
 * 媒体落地（dramaforge-assets-client-local 核心翻译，Step 5）：
 *   landAssetImage 通过客户端资产桥完成两阶段提交：
 *   - Electron：sfShell.downloadAsset(providerUrl, {ext:'png'}) → 拿 protocolUrl
 *     （sf-asset://<key>.png）→ PATCH /assets/[assetId] body {imageUrl:protocolUrl}
 *     → 成功后返回 protocolUrl 供 <img src> 显示（持久，不过期）。
 *   - 浏览器/dev：sfShell 不存在时明确提示使用桌面客户端，不把临时供应商 URL
 *     冒充已持久化资产。
 *   - server 全程不碰媒体字节（dramaforge-assets-client-local 满足）。
 *
 * 双色方案铁律（对齐 app1）：
 *   - 「完成资产设定」「生成」「确认」按钮使用 --action 蓝（可点击行为）
 *   - 类型徽章 / 富字段标签使用 --accent 琥珀（身份/品牌层）
 *   - 锁定标记使用 --warning 橙（警示层）
 *
 * GC 翻译：
 *   - GC-1（BYOK 禁）：无 isProviderReady，所有 provider 始终就绪 ✓
 *   - GC-3（app1 只读）：仅镜像，未改 app1 ✓
 *   - GC-5（无新 .sql）：富列已在 0001-init.sql:178-263 存在 ✓
 *   - GC-6（行为等价）：A1-A14 镜像 app1，删 SSE/BYOK/proxyImageUrl/costumes/音色/
 *     pencil/grid/credits 后行为对齐 app1 设计意图 ✓
 *   - GC-7：资产生图生命周期对齐 app1 的 SSE+taskId+server storage ✓
 *   - GC-8（key 不入 git）：无 key 在代码/配置 ✓
 *   - dramaforge-assets-client-local：媒体字节只存客户端 sf-asset://，server 不存任何字节 ✓
 *   - dramaforge-keys-cloud-server-only：云端 key ✓
 *   - dramaforge-frontend-align-app1：UI 1:1 镜像 app1（删 defer 项后） ✓
 *   - prefer-better-lib-not-selfbuilt：ConfirmDialog/ProgressBar/StageProgress/
 *     ZoomViewer/Button/Toast/Spinner/ModelSelector 全复用批0 UI 组件 ✓
 */

import * as React from "react";
import { Spinner } from "../../../../components/ui/Spinner";
import { Button } from "../../../../components/ui/Button";
import { useToast } from "../../../../components/ui/Toast";
import { ConfirmDialog } from "../../../../components/ui/ConfirmDialog";
import { Modal } from "../../../../components/ui/Modal";
import { StageProgress } from "../../../../components/ui/StageProgress";
import { ProgressBar } from "../../../../components/ui/ProgressBar";
import { ZoomViewer, type ZoomItem } from "../../../../components/ui/ZoomViewer";
import { ModelSelector } from "../../../../components/ui/ModelSelector";
import { GenerationProgress } from "../../../../components/features/GenerationProgress";
import { useSSE, trackTaskId, untrackTaskId } from "../../../../hooks/useTaskStatus";
import { AssetMasterPanel } from "./AssetMasterPanel";
import { SeasonInheritDialog } from "./SeasonInheritDialog";
import {
  clearGenerationLockByTaskId,
  listGenerationLocks,
  setGenerationLock,
} from "../../../../hooks/useGenerationLock";
import {
  LANGUAGE_MODELS,
  IMAGE_MODELS,
} from "../../../../lib/models";
import {
  buildMissingAssetImageCandidates,
  buildRegenerateAssetImageCandidates,
  type AssetImageGenerationCandidate,
} from "../../../../lib/asset-image-candidates";
// 客户端组件走 prompt 子路径（避免主 barrel 的 node:* 依赖污染 client bundle）。
// ASSET_RESOLUTIONS 是纯常量，subpath export 已就绪
// （package.json exports: "./prompt": "./src/domain/prompt/index.ts"）。
// 画风由项目锁定风格 + 可编辑增强提示词共同决定；分辨率常量由 prompt 子路径共享。
import { ASSET_RESOLUTIONS } from "@dramaforge/server/prompt";
// AssetRecord 契约由 @dramaforge/server 主 barrel 导出；type-only import 擦除运行时引用。
import type { AssetRecord } from "@dramaforge/server";
// 批6 音色库：sfShell 桥类型（SfShellPresetVoice 用于 VoiceBrowserModal state）。
// 全局 Window.sfShell 由 types/sf-shell.d.ts 增强，tsconfig 已含 types/**/*.ts。
import type { SfShellPresetVoice } from "../../../../types/sf-shell";

// ============================================================
// 常量
// ============================================================

/** 四类资产 Tab（对齐 app1，含 ENTITY 实体） */
const ASSET_TABS = [
  { key: "CHARACTER", label: "角色", icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" },
  { key: "PROP", label: "物品", icon: "M20 7l-8-4-8 4 8 4 8-4zM4 7v6l8 4 8-4V7" },
  { key: "LOCATION", label: "环境", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
  { key: "ENTITY", label: "实体", icon: "M4 5a1 1 0 011-1h14a1 1 0 011 1v11a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM2 20h20M9 9h6M9 13h4" },
] as const;

/** kind → 中文 label 映射（富字段标签 + ZoomViewer subtitle 用） */
const KIND_LABELS: Record<string, string> = {
  CHARACTER: "角色",
  PROP: "物品",
  LOCATION: "环境",
  ENTITY: "实体",
};

/** kind → 徽章颜色映射（对齐 app1） */
const KIND_BADGE_COLORS: Record<string, string> = {
  CHARACTER: "bg-[var(--accent-dim)] text-[var(--accent)]",
  PROP: "bg-purple-500/15 text-purple-400",
  LOCATION: "bg-emerald-500/15 text-emerald-400",
  ENTITY: "bg-indigo-500/15 text-indigo-400",
};

/** 批量提交分批大小，避免瞬时请求过多。 */
const BATCH_CHUNK_SIZE = 5;

function getAssetGenerationLockKey(projectId: string, pendingKey: string): string {
  return `asset:${projectId}:${pendingKey}`;
}

function getAssetGenerationLockPrefix(projectId: string): string {
  return `asset:${projectId}:`;
}

// ============================================================
// 主组件
// ============================================================

export interface AssetDesignStageProps {
  /** 项目 ID */
  projectId: string;
  /** 分集 ID（用于 handleReextract 提示文案，dramaforge 资产项目级归属无 episodeId 列） */
  episodeId?: string;
  /** 项目资产完整列表（父组件 EpisodeWorkspace 持有 + 刷新） */
  assets: AssetRecord[];
  /** API 调用封装（useApi 装配，envelope 解析 + toast） */
  api: (url: string, options?: RequestInit) => Promise<unknown>;
  /** 完成资产设定回调（进入分镜阶段） */
  onComplete: () => void;
  /** 刷新数据回调（父组件重新拉 assets） */
  onRefresh: (opts?: { force?: boolean }) => void;
  /** 父组件加载态（按钮 disable 用） */
  loading: boolean;
  /** 是否只读模式（批5 暂传 false，批9 review 模式启用） */
  isReview: boolean;
  /** 生图模型 id（透传 generate-image；GC-1 key 云端仅选模型） */
  imageModel: string;
  setImageModel: (m: string) => void;
  /** 图片分辨率（1K/2K/4K/21:9，对齐 ASSET_RESOLUTIONS） */
  imageResolution: string;
  setImageResolution: (r: string) => void;
  /** 图片画风（对齐 ASSET_IMAGE_STYLES） */
  imageStyle: string;
  setImageStyle: (s: string) => void;
  /** 提取模型（语言模型，handleReextract 用） */
  scriptModel: string;
  setScriptModel: (m: string) => void;
  /** 资产设定增强提示词（指导设计图生成风格/质量，单镜与批量生成时生效） */
  enhancementPrompt?: string;
  setEnhancementPrompt?: (v: string) => void;
  /** 剧本文本长度（重新提取 Token 估算提示用，可选） */
  scriptTextLength?: number;
}

export function AssetDesignStage({
  projectId,
  episodeId,
  assets,
  api,
  onComplete,
  onRefresh,
  loading,
  isReview,
  imageModel,
  setImageModel,
  imageResolution,
  setImageResolution,
  imageStyle,
  setImageStyle,
  scriptModel,
  setScriptModel,
  enhancementPrompt,
  setEnhancementPrompt,
  scriptTextLength = 0,
}: AssetDesignStageProps) {
  const toast = useToast();
  const [activeTab, setActiveTab] = React.useState<string>("CHARACTER");
  /** 顶部视图切换：资产设定（类型 tab 编辑，默认）/ 资产总表（项目级出场矩阵）。 */
  const [designView, setDesignView] = React.useState<"design" | "master">("design");
  const [extracting, setExtracting] = React.useState(false);
  /** 季继承对话框（功能1）：从源季项目继承重复资产外观。 */
  const [inheritOpen, setInheritOpen] = React.useState(false);
  /** 完成定格：提取完成时短暂显示 100% 再卸载进度条（诉求6）。 */
  const [extractJustDone, setExtractJustDone] = React.useState(false);
  /** per-asset 生图模型（覆盖全局 imageModel） */
  const [assetImageModels, setAssetImageModels] = React.useState<Record<string, string>>({});
  /** per-asset 分辨率（覆盖全局 imageResolution） */
  const [assetResolutions, setAssetResolutions] = React.useState<Record<string, string>>({});
  /** per-asset 画风（覆盖全局 imageStyle） */
  const [assetStyles, setAssetStyles] = React.useState<Record<string, string>>({});
  /** 一键批量生成提交中 */
  const [batchGenerating, setBatchGenerating] = React.useState(false);
  /** 批量条只表示任务提交进度；每张图的真实生成/落盘进度由任务卡展示。 */
  const [batchProgress, setBatchProgress] = React.useState<{
    done: number;
    total: number;
    failed: number;
  } | null>(null);
  /** 一键重新生成确认弹窗 */
  const [regenConfirmOpen, setRegenConfirmOpen] = React.useState(false);
  /** 一键确认中 */
  const [batchConfirming, setBatchConfirming] = React.useState(false);
  /** 一键解锁中 */
  const [batchUnlocking, setBatchUnlocking] = React.useState(false);
  /** 单资产生图中（由 pendingTasks 派生；上传时也短暂复用）。 */
  const [generatingIds, setGeneratingIds] = React.useState<Set<string>>(new Set());
  /** 对齐 app1：持久任务映射 taskId → `${assetId}:${costumeKey}`。 */
  const [pendingTasks, setPendingTasks] = React.useState<Map<string, string>>(new Map());
  const pendingRef = React.useRef(pendingTasks);
  pendingRef.current = pendingTasks;
  /** 完成事件可能重放；同一 taskId 只允许执行一次客户端下载与版本提交。 */
  const finalizingTaskIdsRef = React.useRef<Set<string>>(new Set());
  /** 基准优先图生图：异步基准任务（taskId）落地后的 resolver；submitBatchGenerate 按资产等
   *  基准真正提交（sf-asset:// localUrl）再把该 localUrl 作参考图喂给该资产的变体。 */
  const taskResolversRef = React.useRef<Map<string, (localUrl: string | null) => void>>(new Map());
  /** SSE 完成可能早于 awaitBaselineCommitted 注册 resolver（生成极快时），先暂存避免丢事件。 */
  const earlyCompletionsRef = React.useRef<Map<string, string | null>>(new Map());
  /** 仅在批量基准优先流程进行中暂存 early completion，避免单次生成的完成事件长期堆积。 */
  const batchAwaitingRef = React.useRef(false);
  /** base64 仅兼容旧环境，强制串行，避免批量生成时多份编码图片同时占内存。 */
  const base64FallbackTailRef = React.useRef<Promise<void>>(Promise.resolve());
  const finalizeTaskOutputRef = React.useRef<(
    output: unknown,
    pendingKey: string,
  ) => Promise<string | null>>(async () => null);
  /** 图片加载失败的 assetId 集合（landAssetImage PATCH 失败 / sf-asset:// 显示不了） */
  const [imgErrors, setImgErrors] = React.useState<Set<string>>(new Set());
  /** 乐观更新：landAssetImage 返回的 finalUrl（sf-asset:// 或 providerUrl），DB 还没更新也能立即显示 */
  const [localImages, setLocalImages] = React.useState<Record<string, string>>({});

  const { events } = useSSE();

  React.useEffect(() => {
    setGeneratingIds(new Set([...pendingTasks.values()].map((key) => key.split(':')[0]).filter(Boolean)));
  }, [pendingTasks]);

  React.useEffect(() => {
    for (const event of events) {
      if (event.type !== 'status_change' || (event.status !== 'COMPLETED' && event.status !== 'FAILED')) continue;
      const pendingKey = pendingRef.current.get(event.taskId);
      if (!pendingKey) continue;
      const clearPending = () => {
        setPendingTasks((previous) => {
          const next = new Map(previous);
          next.delete(event.taskId);
          return next;
        });
        untrackTaskId(event.taskId);
        clearGenerationLockByTaskId(event.taskId);
      };
      if (event.status === 'FAILED') {
        // 基准优先图生图：让等待该基准的变体批次尽快降级为无参考（文生图）。
        const failResolver = taskResolversRef.current.get(event.taskId);
        if (failResolver) {
          taskResolversRef.current.delete(event.taskId);
          failResolver(null);
        } else if (batchAwaitingRef.current) {
          earlyCompletionsRef.current.set(event.taskId, null);
        }
        clearPending();
        toast.error(friendlyAssetError(event.error));
        continue;
      }
      if (finalizingTaskIdsRef.current.has(event.taskId)) continue;
      finalizingTaskIdsRef.current.add(event.taskId);
      // 服务端完成只代表模型已出图；客户端本地保存和 revision 提交成功才算真正完成。
      void finalizeTaskOutputRef.current(event.result ?? event.output, pendingKey)
        .then((localUrl) => {
          if (localUrl) toast.success('图片已生成并保存到本地');
          else toast.error('模型已生成图片，但保存到本地失败');
          // 把落地后的 localUrl 交给等待该基准的批次（基准优先图生图）。
          const doneResolver = taskResolversRef.current.get(event.taskId);
          if (doneResolver) {
            taskResolversRef.current.delete(event.taskId);
            doneResolver(localUrl);
          } else if (batchAwaitingRef.current) {
            earlyCompletionsRef.current.set(event.taskId, localUrl);
          }
        })
        .finally(() => {
          finalizingTaskIdsRef.current.delete(event.taskId);
          clearPending();
        });
    }
  }, [events, toast]);

  React.useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      const locks = listGenerationLocks(getAssetGenerationLockPrefix(projectId))
        .filter((entry) => typeof entry.taskId === 'string' && typeof entry.metadata?.pendingKey === 'string');
      const STALE_TASK_MS = 15 * 60 * 1000; // 锁龄超 15min 视为死任务（资产生图远不到此）
      const now = Date.now();
      const next = new Map<string, string>();
      await Promise.all(locks.map(async (entry) => {
        const taskId = entry.taskId as string;
        const pendingKey = entry.metadata?.pendingKey as string;
        // B 死任务超时清理：卡死的 AI 任务（提交后一直没到终态）会经
        // pendingTasks→generatingIds 永久锁住整个资产，挡住所有变体的「替换图片」。
        // 锁龄超阈值视为死，清锁 + 不加回 pendingTasks（SSE 若迟到完成仍兜底落地）。
        if (typeof entry.updatedAt === 'number' && now - entry.updatedAt > STALE_TASK_MS) {
          clearGenerationLockByTaskId(taskId);
          untrackTaskId(taskId);
          return;
        }
        try {
          const task = await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'GET' }) as {
            status?: string;
            output?: unknown;
            error?: string;
          } | null;
          if (task && ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(task.status ?? '')) {
            // 页面刷新后也必须补做客户端落盘，不能只刷新资产状态。
            if (task.status === 'COMPLETED') {
              await finalizeTaskOutputRef.current(task.output, pendingKey);
            }
            // E9：恢复轮询发现 FAILED 时也要明确反馈（SSE 断线 / 刷新页面后兜底），否则用户只看到转圈。
            if (task.status === 'FAILED') {
              toast.error(friendlyAssetError(task.error));
            }
            clearGenerationLockByTaskId(taskId);
            untrackTaskId(taskId);
            return;
          }
        } catch {
          // 保留锁；SSE 与下一次轮询继续恢复。
        }
        next.set(taskId, pendingKey);
        trackTaskId(taskId);
      }));
      if (!cancelled) setPendingTasks(next);
    };
    void restore();
    return () => { cancelled = true; };
  }, [api, projectId, toast]);

  /** 资产设定增强提示词（可折叠卡片 / 编辑草稿） */
  const [enhancementModalOpen, setEnhancementModalOpen] = React.useState(false);
  const [enhancementDraft, setEnhancementDraft] = React.useState("");

  /** 放大查看资产图片（"" = 关闭，否则为 assetId） */
  const [imageZoomAssetId, setImageZoomAssetId] = React.useState<string>("");

  /** 左右分栏：当前选中的资产 ID（CHARACTER/PROP/LOCATION/ENTITY Tab 通用） */
  const [selectedAssetId, setSelectedAssetId] = React.useState<string>("");

  /** 响应式：≥1024px 左右分栏，<1024px 上下布局（窄屏列表横向滚动） */
  const [isWideScreen, setIsWideScreen] = React.useState<boolean>(false);
  React.useEffect(() => {
    const check = () => setIsWideScreen(window.innerWidth >= 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  /** 删除确认对话框持有的资产 */
  const [deleteConfirmAsset, setDeleteConfirmAsset] = React.useState<AssetRecord | null>(null);
  /** 删除提交中，用于锁定确认框并显示按钮进度条。 */
  const [deletingAsset, setDeletingAsset] = React.useState(false);

  /** 添加新资产表单 */
  const [showAddForm, setShowAddForm] = React.useState(false);
  const [newAssetKind, setNewAssetKind] = React.useState<string>("CHARACTER");
  const [newAssetName, setNewAssetName] = React.useState("");
  const [newAssetDesc, setNewAssetDesc] = React.useState("");
  const [addingAsset, setAddingAsset] = React.useState(false);

  // ============================================================
  // 派生数据
  // ============================================================
  const tabAssets = assets.filter((a) => a.kind === activeTab);
  const confirmedCount = assets.filter(
    (a) => a.isConfirmed || ((a.metadata as Record<string, unknown> | null)?.confirmed === true),
  ).length;
  const lockedCount = assets.filter((a) => a.regenLocked === true).length;
  const sidebarAssets = tabAssets;
  const selectedSidebarAsset = sidebarAssets.find((a) => a.id === selectedAssetId) || null;
  const pendingImageKeys = React.useMemo(() => new Set(pendingTasks.values()), [pendingTasks]);
  const isAssetGenerating = React.useCallback(
    (assetId: string, costumeKey?: string) =>
      pendingImageKeys.has(`${assetId}:${costumeKey || "default"}`),
    [pendingImageKeys],
  );
  const getAssetTaskId = React.useCallback(
    (assetId: string, costumeKey?: string): string | undefined => {
      const key = `${assetId}:${costumeKey || "default"}`;
      for (const [taskId, pendingKey] of pendingTasks.entries()) {
        if (pendingKey === key) return taskId;
      }
      return undefined;
    },
    [pendingTasks],
  );

  // ============================================================
  // per-asset 模型/分辨率/画风默认值同步（对齐 app1:137-171，简化删 isProviderReady）
  // ============================================================
  React.useEffect(() => {
    setAssetImageModels((prev) => {
      const next = { ...prev };
      for (const asset of assets) {
        if (!next[asset.id]) {
          const modelFromMeta = (asset.metadata as Record<string, unknown> | null)?.imageModel;
          next[asset.id] =
            typeof modelFromMeta === "string" && modelFromMeta ? modelFromMeta : imageModel;
        }
      }
      return next;
    });
    setAssetResolutions((prev) => {
      const next = { ...prev };
      for (const asset of assets) {
        if (!next[asset.id]) {
          const resFromMeta = (asset.metadata as Record<string, unknown> | null)?.imageResolution;
          next[asset.id] =
            typeof resFromMeta === "string" && resFromMeta ? resFromMeta : imageResolution;
        }
      }
      return next;
    });
    setAssetStyles((prev) => {
      const next = { ...prev };
      for (const asset of assets) {
        if (!next[asset.id]) {
          const styleFromMeta = (asset.metadata as Record<string, unknown> | null)?.imageStyle;
          next[asset.id] =
            typeof styleFromMeta === "string" && styleFromMeta ? styleFromMeta : imageStyle;
        }
      }
      return next;
    });
  }, [assets, imageModel, imageResolution, imageStyle]);

  /** activeTab 切换时自动选中第一个资产（对齐 app1:306-313） */
  React.useEffect(() => {
    const exists = sidebarAssets.some((a) => a.id === selectedAssetId);
    if (!exists && sidebarAssets.length > 0) {
      setSelectedAssetId(sidebarAssets[0].id);
    }
  }, [activeTab, sidebarAssets, selectedAssetId]);

  // ============================================================
  // 媒体落地（landAssetImage：供应商 URL → 客户端本地 → 版本事务提交）
  // ============================================================

  /**
   * 含人脸道具必须复用关联角色的当前图，避免结婚照/证件照里人物身份漂移。
   * 本地 sf-asset:// 只能由 Electron 读取，因此转换在客户端完成，服务端仍不存媒体。
   */
  const readFacePropReferenceUrl = React.useCallback(async (
    asset: AssetRecord,
  ): Promise<string | undefined> => {
    if (asset.kind !== "PROP") return undefined;
    const metadata = asset.metadata && typeof asset.metadata === "object"
      ? asset.metadata as Record<string, unknown>
      : {};
    if (metadata.requiresCharacterRef !== true) return undefined;
    const involved = Array.isArray(metadata.involvedCharacters)
      ? metadata.involvedCharacters.filter((name): name is string => typeof name === "string")
      : [];
    const normalizeName = (value: string) => value.toLowerCase().replace(/[\s\-_·.,'"()（）]/g, "");
    const primaryName = involved[0];
    const character = primaryName
      ? assets.find((candidate) =>
          candidate.kind === "CHARACTER" && normalizeName(candidate.name) === normalizeName(primaryName),
        )
      : undefined;
    if (!character?.imageUrl) {
      throw new Error(`含人脸道具需要角色参考图：${primaryName || "未指定角色"}`);
    }
    // 返回 URL 而不是 base64；sf-asset:// 会在提交时通过 Fetch API 流式接力。
    return character.imageUrl;
  }, [assets]);

  /**
   * 把生图结果落地到本地并 PATCH 回写 imageUrl。
   *
   * Electron：sfShell.downloadAsset(providerUrl, {ext:'png'}) → 拿 protocolUrl
   *   （sf-asset://<key>.png）→ PATCH /assets/[assetId] body {imageUrl:protocolUrl} →
   *   成功后返回 protocolUrl 供 <img src> 显示（持久，不过期）。
   * 浏览器/dev：sfShell 不存在或 downloadAsset 失败 → 返回 provider URL（1h 过期，
   *   dev fallback 可接受）；PATCH 失败同样 fallback provider URL 并标记 imgErrors。
   *
   * 用 raw fetch（不走 api 封装）：PATCH 失败不弹 toast（本地文件已落盘，照样能播；
   * 只是 DB 没更新），改标记 imgErrors 让用户感知。
   *
   * 返回值：最终用于 <img src> 的 URL（本地 sf-asset:// 或临时 provider URL）。
   */
  /**
   * 提交图片版本：生成图带 revisionId，上传图由后端分配新版本。
   * 只有提交成功才切换 assets.imageUrl；失败时旧图保持不变，不再制造半提交状态。
   */
  const patchImageUrl = React.useCallback(
    async (
      assetId: string,
      protocolUrl: string,
      revisionId?: string,
      costumeKey = "default",
    ): Promise<{ saved: true; becameCurrent: boolean } | null> => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/images`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              localUrl: protocolUrl,
              ...(revisionId ? { revisionId, source: 'AI' } : { source: 'UPLOAD' }),
              costumeKey,
              activateCurrent: costumeKey === "default",
            }),
          },
        );
        if (!res.ok) {
          setImgErrors((prev) => new Set(prev).add(assetId));
          return null;
        }
        const envelope = await res.json() as {
          success?: boolean;
          data?: { becameCurrent?: boolean };
        };
        if (!envelope.success) return null;
        return {
          saved: true,
          becameCurrent: envelope.data?.becameCurrent === true,
        };
      } catch {
        setImgErrors((prev) => new Set(prev).add(assetId));
        return null;
      }
    },
    [projectId],
  );

  /**
   * 从 provider URL 下载图片到客户端本地（sf-asset://）。
   * 抽出自 landAssetImage（批5.5）：造型变体也共用此逻辑下载，但不走 PATCH imageUrl，
   * 而是调 patchCostumeImage 写入 costumes[idx].imageUrl。
   *
   * 失败时 toast + 标记 imgErrors，返回 null；成功返回 sf-asset:// protocolUrl。
   */
  const downloadProviderImage = React.useCallback(
    async (assetId: string, providerUrl: string): Promise<string | null> => {
      const sf = window.sfShell;
      if (!sf?.downloadAsset) {
        // 浏览器 / dev：无本地存储能力；Electron 却没 sfShell：preload 未注入（根因 A），toast 暴露。
        const isElectron =
          typeof navigator !== "undefined" && /Electron\//.test(navigator.userAgent);
        if (isElectron) {
          toast.error("桌面客户端本地存储能力(sfShell)未加载，图片无法保存到本地。请重启客户端或联系技术支持。");
        }
        return null;
      }

      let protocolUrl: string | null = null;
      let dlError: { code?: string; message?: string } | null = null;
      try {
        // 不强制 ext:'png'：ARK 实际返回 .jpeg，让 downloadAsset 从 URL 后缀自动推断
        // 正确扩展名（避免 .png 扩展名 + JPEG 字节的 MIME 错配）。
        const r = await sf.downloadAsset(providerUrl);
        if (r?.ok && typeof r.protocolUrl === "string") {
          protocolUrl = r.protocolUrl;
        } else if (r && !r.ok) {
          dlError = r.error ?? null;
        }
      } catch (e) {
        protocolUrl = null;
        dlError = { message: e instanceof Error ? e.message : String(e) };
      }

      if (!protocolUrl) {
        toast.error(`图片未保存到本地${dlError ? ` [${dlError.code ?? "ERR"}]: ${dlError.message ?? ""}` : ""}`);
        setImgErrors((prev) => new Set(prev).add(assetId));
        return null;
      }
      return protocolUrl;
    },
    [],
  );

  /**
   * 把生图结果落地到本地并 PATCH 回写 imageUrl（基准图，批5 主链路）。
   * 失败时 fallback 返回 providerUrl（保留显示，dev 可接受）。
   */
  const landAssetImage = React.useCallback(
    async (
      assetId: string,
      providerUrl: string,
      revisionId: string,
      costumeKey = "default",
    ): Promise<{ localUrl: string; becameCurrent: boolean } | null> => {
      const protocolUrl = await downloadProviderImage(assetId, providerUrl);
      if (!protocolUrl) return null;
      const committed = await patchImageUrl(assetId, protocolUrl, revisionId, costumeKey);
      // 两阶段提交失败时继续显示旧图；临时 provider URL 不再冒充已保存版本。
      return committed
        ? { localUrl: protocolUrl, becameCurrent: committed.becameCurrent }
        : null;
    },
    [patchImageUrl, downloadProviderImage],
  );

  /** 把 worker 输出转换为客户端本地资产，并按 revision 顺序提交为当前图或造型图。
   *  返回落地后的 localUrl（sf-asset://，成功）或 null（失败）；供基准优先图生图把基准图喂给变体。 */
  const finalizeTaskOutput = React.useCallback(
    async (output: unknown, pendingKey: string): Promise<string | null> => {
      const record = output && typeof output === "object"
        ? output as Record<string, unknown>
        : {};
      const [fallbackAssetId, fallbackCostumeKey = "default"] = pendingKey.split(":");
      const assetId = typeof record.assetId === "string" ? record.assetId : fallbackAssetId;
      const costumeKey = typeof record.costumeKey === "string" && record.costumeKey
        ? record.costumeKey
        : fallbackCostumeKey;
      const providerUrl = typeof record.imageUrl === "string" ? record.imageUrl : "";
      const revisionId = typeof record.revisionId === "string" ? record.revisionId : "";
      if (!assetId || !providerUrl || !revisionId) return null;

      const landed = await landAssetImage(assetId, providerUrl, revisionId, costumeKey);
      if (!landed) return null;
      // 只有默认造型且本次 revision 真正成为当前版本时，才乐观切换主图。
      if (costumeKey === "default" && landed.becameCurrent) {
        setLocalImages((previous) => ({ ...previous, [assetId]: landed.localUrl }));
      }
      setImgErrors((previous) => {
        const next = new Set(previous);
        next.delete(assetId);
        return next;
      });
      onRefresh({ force: true });
      return landed.localUrl;
    },
    [landAssetImage, onRefresh],
  );
  // 顶部 SSE/恢复 effect 通过 ref 调用，避免把事件订阅移动到大量 handler 之后。
  finalizeTaskOutputRef.current = finalizeTaskOutput;

  // E11：挂载时主动抢救卡在 GENERATED 的 revision（批量生图切走 / SSE 断 / providerUrl 1h 过期
  //   → 环境/道具图不显示）。现有落地纯反应式（SSE + 锁恢复），这里补一次主动 sweep：
  //   遍历资产，把 GENERATED 未落地的 revision 下载到本地并提交 COMMITTED。
  //   仅桌面端（需 sfShell.downloadAsset）；延迟 2s 跑不抢 SSE/锁恢复；sweptRef 保证只跑一次。
  const e11SweptRef = React.useRef(false);
  React.useEffect(() => {
    if (e11SweptRef.current) return;
    e11SweptRef.current = true;
    if (typeof window === "undefined" || !window.sfShell?.downloadAsset) return;
    let cancelled = false;
    const sweep = async () => {
      let landedAny = false;
      for (const a of assets) {
        if (cancelled) return;
        try {
          const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(a.id)}/images`);
          if (!res.ok) continue;
          const env = await res.json() as { data?: Array<{
            id: string;
            status: string;
            providerUrl: string | null;
            localUrl: string | null;
            costumeKey: string;
          }> };
          const pending = (env.data ?? []).filter((r) => r.status === "GENERATED" && r.providerUrl && !r.localUrl);
          for (const r of pending) {
            if (cancelled) return;
            const ok = await landAssetImage(a.id, r.providerUrl as string, r.id, r.costumeKey || "default");
            if (ok) landedAny = true;
          }
        } catch {
          // 单资产失败跳过，继续下一个
        }
      }
      if (landedAny && !cancelled) onRefresh({ force: true });
    };
    const t = setTimeout(() => { void sweep(); }, 2000);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  type AssetImageGenerateOptions = {
    model: string;
    resolution: string;
    style: string;
    enhancementPrompt?: string;
    costumeKey?: string;
  };

  /**
   * 提交生图：本地 sf-asset:// 参考图走原始字节流；公开 URL 和无参考图走轻量 JSON 任务。
   * 服务器只做一次性流接力，媒体不会转成 base64，也不会进入 PG/Redis。
   */
  const submitAssetImageGeneration = React.useCallback(async (
    assetId: string,
    options: AssetImageGenerateOptions,
    referenceImageUrl?: string,
  ): Promise<Record<string, unknown>> => {
    const endpoint = `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/generate-image`;
    if (!referenceImageUrl || /^https?:\/\//i.test(referenceImageUrl)) {
      const data = await api(endpoint, {
        method: "POST",
        body: JSON.stringify({
          ...options,
          ...(referenceImageUrl ? { referenceImageUrl } : {}),
        }),
      });
      return data && typeof data === "object" ? data as Record<string, unknown> : {};
    }
    if (!referenceImageUrl.startsWith("sf-asset://")) {
      throw new Error("参考图必须是本地 sf-asset:// 或公开 HTTPS URL");
    }

    const submitBase64Fallback = async (): Promise<Record<string, unknown>> => {
      const previous = base64FallbackTailRef.current;
      let release!: () => void;
      base64FallbackTailRef.current = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const sf = window.sfShell;
        if (!sf?.readAssetToBaseUrl) throw new Error("当前客户端不支持读取参考图");
        const encoded = await sf.readAssetToBaseUrl(referenceImageUrl);
        if (!encoded?.ok || !encoded.dataUrl) {
          throw new Error(encoded && !encoded.ok ? encoded.error.message : "读取参考图失败");
        }
        const data = await api(endpoint, {
          method: "POST",
          body: JSON.stringify({
            ...options,
            referenceImageBase64: encoded.dataUrl,
            allowBase64Fallback: true,
          }),
        });
        return data && typeof data === "object" ? data as Record<string, unknown> : {};
      } finally {
        release();
      }
    };

    let source: Response;
    try {
      source = await fetch(referenceImageUrl);
    } catch {
      // 旧 Electron 若不支持对自定义 scheme 使用 Fetch API，才进入受控兼容路径。
      return submitBase64Fallback();
    }
    if (!source.ok || !source.body) return submitBase64Fallback();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value) params.set(key, value);
    }
    const response = await fetch(`${endpoint}?${params.toString()}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": source.headers.get("Content-Type") || "image/png",
        "X-SF-Reference-Stream": "1",
      },
      // Chromium 会在供应商消费 relay 时按背压读取，不会把整张图拼成 JSON 字符串。
      body: source.body,
    });
    const envelope = await response.json().catch(() => ({})) as {
      success?: boolean;
      data?: Record<string, unknown>;
      error?: string;
    };
    if (!response.ok || !envelope.success) {
      throw new Error(envelope.error || `参考图生成失败（${response.status}）`);
    }
    return envelope.data ?? {};
  }, [api, projectId]);

  // ============================================================
  // Handlers
  // ============================================================

  /**
   * 用户上传本地图片当资产（批2b，C/S：File → sfShell.saveLocalAsset 写本地 clips
   * → sf-asset:// key → PATCH imageUrl）。服务器零媒体字节（dramaforge-assets-client-local）。
   * 浏览器/dev 无 sfShell.saveLocalAsset → toast 提示用桌面客户端。
   *
   * 批5.5 扩展：costumeKey 指定造型变体（如 "casual"/"formal"/"battle-damaged"）时，
   * 写入 costumes[idx].imageUrl 而非主图；costumeKey === "default" 或未传时走原主图逻辑。
   */
  const handleUploadImage = async (assetId: string, file: File, costumeKey?: string) => {
    const sf = window.sfShell;
    if (!sf?.saveLocalAsset) {
      const isElectron =
        typeof navigator !== "undefined" && /Electron\//.test(navigator.userAgent);
      toast.error(
        isElectron
          ? "桌面客户端本地存储能力(sfShell)未加载，无法上传图片。请重启客户端。"
          : "浏览器模式不支持上传本地图片，请使用桌面客户端。",
      );
      return;
    }
    const ck = costumeKey || "default";
    // A 守卫精确到变体：只挡「该变体正在 AI 生成」，不挡同资产其他变体或上传。
    // 旧逻辑用 generatingIds（assetId 粒度、从 pendingTasks 派生）会把卡死的 AI
    // 任务误锁整个资产，导致所有变体都换不了（用户报「该资产图片正在处理中」）。
    if (pendingImageKeys.has(`${assetId}:${ck}`)) {
      toast.info(`该造型正在生成中，请稍候或换一个变体`);
      return;
    }
    // ext 从文件名后缀推断，回退 MIME，再回退 png
    const extFromName = file.name.split(".").pop()?.toLowerCase();
    const extFromMime =
      file.type === "image/png" ? "png"
      : file.type === "image/jpeg" ? "jpg"
      : file.type === "image/webp" ? "webp"
      : undefined;
    const ext = extFromName || extFromMime || "png";
    const isVariant = ck !== "default";
    // 找到 label 用于 toast 文案
    const assetForLabel = assets.find((a) => a.id === assetId);
    const costumesArr = Array.isArray(assetForLabel?.costumes)
      ? (assetForLabel.costumes as Array<Record<string, unknown>>)
      : [];
    const cvLabel = (costumesArr.find((c) => c.key === ck)?.label as string) || ck;

    setGeneratingIds((prev) => new Set(prev).add(assetId));
    toast.info("图片上传中...");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await sf.saveLocalAsset(bytes, { ext });
      if (!r?.ok || typeof r.protocolUrl !== "string") {
        const err = r && !r.ok ? r.error : null;
        toast.error(
          `图片未保存到本地${err ? ` [${err.code ?? "ERR"}]: ${err.message ?? ""}` : ""}`,
        );
        setImgErrors((prev) => new Set(prev).add(assetId));
        return;
      }
      const protocolUrl = r.protocolUrl;
      // 上传图和 AI 图共用 revision 事务；造型变体只更新命中的 costumes 元素。
      const committed = await patchImageUrl(assetId, protocolUrl, undefined, ck);
      if (!committed?.saved) throw new Error('图片已保存到本地，但版本提交失败，当前图片保持不变');
      if (!isVariant && committed.becameCurrent) {
        setLocalImages((prev) => ({ ...prev, [assetId]: protocolUrl }));
      }
      setImgErrors((prev) => {
        const n = new Set(prev);
        n.delete(assetId);
        return n;
      });
      toast.success(isVariant ? `「${cvLabel}」造型图已上传` : "基准造型图已上传");
      onRefresh({ force: true });
    } catch (e: unknown) {
      toast.error(`图片上传失败: ${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setGeneratingIds((prev) => {
        const n = new Set(prev);
        n.delete(assetId);
        return n;
      });
    }
  };

  /** 重新提取资产（角色/物品/环境）：POST /asset-extraction body {model}（同步直连） */
  const handleReextract = async () => {
    setExtracting(true);
    toast.info(episodeId ? "正在重新分析当前分集并重建资产..." : "正在重新提取角色/物品/环境...");
    try {
      const d = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/asset-extraction`,
        { method: "POST", body: JSON.stringify({ model: scriptModel }) },
      )) as { counts?: { characters: number; items: number; environments: number; entities?: number } } | null;
      if (d && d.counts) {
        toast.success(
          `提取完成：角色 ${d.counts.characters || 0} · 物品 ${d.counts.items || 0} · 环境 ${d.counts.environments || 0} · 实体 ${d.counts.entities || 0}`,
        );
        setExtractJustDone(true);
        setTimeout(() => setExtractJustDone(false), 1000);
        onRefresh({ force: true });
      } else {
        // envelope.success:false 已被 useApi toast；此处重拉拿最新状态
        onRefresh({ force: true });
      }
    } catch (e: unknown) {
      toast.error(`资产提取失败: ${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setExtracting(false);
    }
  };

  /** 单资产生图：提交任务后立即返回，SSE/轮询负责完成、失败和刷新恢复。 */
  const handleGenerateImage = async (assetId: string, _prompt?: string, model?: string, costumeKey?: string) => {
    const assetForLock = assets.find((a) => a.id === assetId);
    if (assetForLock?.regenLocked) {
      toast.warning("该资产已锁定，请先点击卡片上的🔒开关解锁后再重新生成");
      return;
    }
    const ck = costumeKey || "default";
    const pendingKey = `${assetId}:${ck}`;
    if (pendingImageKeys.has(pendingKey)) {
      toast.info("该造型已有图片正在生成中...");
      return;
    }

    const isVariant = ck !== "default";
    const costumesArr = Array.isArray(assetForLock?.costumes)
      ? (assetForLock.costumes as Array<Record<string, unknown>>)
      : [];

    // 诉求3：重生默认基础主体时，联动重生该角色全部变体（复用批量候选构造；
    // 变体以当前 default 图作 i2i 参考，与「一键重新生成」行为一致）。
    // loading/防重由 pendingTasks 派生的 pendingImageKeys/generatingIds 自动承接。
    if (
      !isVariant
      && !!assetForLock
      && assetForLock.kind === "CHARACTER"
      && costumesArr.some((c) => {
        const k = typeof c.key === "string" ? c.key.trim() : "";
        return k && k !== "default";
      })
    ) {
      if (batchGenerating) {
        toast.info("批量生成进行中，请稍候");
        return;
      }
      const candidates = buildRegenerateAssetImageCandidates(
        [assetForLock],
        isAssetGenerating,
      );
      if (candidates.length > 0) {
        toast.info(`联动重生默认图 + ${candidates.length - 1} 个变体...`);
        await submitBatchGenerate(candidates);
      }
      return;
    }

    // 变体必须基于基准图生图：无基准图则拦截（禁止退化文生图）。
    if (isVariant) {
      const defaultImgForVariant =
        (costumesArr.find((c) => c.key === "default")?.imageUrl as string) ||
        assetForLock?.imageUrl;
      if (!defaultImgForVariant) {
        toast.warning("请先生成基准造型图，变体必须基于基准图生图");
        return;
      }
    }

    const selectedModel = model || assetImageModels[assetId] || imageModel;
    toast.info("正在生成图片...");
    setGeneratingIds((previous) => new Set(previous).add(assetId));
    let queuedTask = false;

    try {
      // 变体直接引用基准图 URL；本地 sf-asset:// 由 submit helper 流式读取。
      let referenceImageUrl: string | undefined;
      if (isVariant) {
        const defaultImageUrl =
          (costumesArr.find((c) => c.key === "default")?.imageUrl as string) ||
          assetForLock?.imageUrl;
        referenceImageUrl = typeof defaultImageUrl === "string" ? defaultImageUrl : undefined;
      } else if (assetForLock) {
        referenceImageUrl = await readFacePropReferenceUrl(assetForLock);
      }

      const d = await submitAssetImageGeneration(assetId, {
        model: selectedModel,
        resolution: assetResolutions[assetId] || imageResolution,
        style: assetStyles[assetId] || imageStyle,
        ...(enhancementPrompt?.trim() ? { enhancementPrompt: enhancementPrompt.trim() } : {}),
        ...(isVariant ? { costumeKey: ck } : {}),
      }, referenceImageUrl);
      const taskId = typeof d.taskId === "string" ? d.taskId : "";
      if (taskId) {
        queuedTask = true;
        setPendingTasks((previous) => new Map(previous).set(taskId, pendingKey));
        setGenerationLock({
          key: getAssetGenerationLockKey(projectId, pendingKey),
          scope: "asset_image",
          projectId,
          taskId,
          metadata: { pendingKey },
        });
        trackTaskId(taskId);
      } else if (await finalizeTaskOutput(d, pendingKey)) {
        toast.success("图片已生成并保存到本地");
      } else {
        toast.error("模型已生成图片，但保存到本地失败");
      }
    } catch (e: unknown) {
      toast.error(`图片生成任务提交失败: ${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      if (!queuedTask) {
        setGeneratingIds((previous) => {
          const next = new Set(previous);
          next.delete(assetId);
          return next;
        });
      }
    }
  };

  /**
   * 批量提交图片生成任务（一键生成 / 一键重新生成共用）。
   *
   * 基准优先图生图：按资产分组——每个资产先提交并等基准图（default）落地，再把基准图作
   * 参考图喂给该资产的变体（图生图，跨变体五官一致）。资产之间并发，受 BATCH_CHUNK_SIZE
   * 限流；资产内变体等基准提交后再发。基准 await 失败/超时 → 该资产变体降级为无参考（文生图）。
   */
  type ImageGenerationCandidate = AssetImageGenerationCandidate<AssetRecord>;

  const submitBatchGenerate = async (
    candidates: ImageGenerationCandidate[],
  ) => {
    if (candidates.length === 0) {
      toast.info("当前没有符合条件的资产");
      return;
    }
    batchAwaitingRef.current = true;
    setBatchGenerating(true);
    setBatchProgress({ done: 0, total: candidates.length, failed: 0 });
    toast.info(`开始生成 ${candidates.length} 张资产图片...`);
    let successCount = 0;
    let failCount = 0;
    const reportDone = (failed: boolean) => {
      if (failed) failCount += 1;
      else successCount += 1;
      setBatchProgress((current) => current
        ? {
            ...current,
            done: Math.min(current.total, current.done + 1),
            failed: current.failed + (failed ? 1 : 0),
          }
        : null);
    };

    const readAssetDefaultUrl = (asset: AssetRecord): string | null => {
      const costumes = Array.isArray(asset.costumes)
        ? (asset.costumes as Array<Record<string, unknown>>)
        : [];
      const def = costumes.find((c) => c && c.key === "default");
      const fromCostume = typeof def?.imageUrl === "string" && def.imageUrl.trim() ? def.imageUrl : "";
      if (fromCostume) return fromCostume;
      return typeof asset.imageUrl === "string" && asset.imageUrl.trim() ? asset.imageUrl : null;
    };

    // 提交单张：返回 taskId（异步排队，待 SSE 落地）或 syncLocalUrl（同步已落地）。失败抛错。
    const submitOne = async (
      candidate: ImageGenerationCandidate,
      referenceOverride?: string,
    ): Promise<{ taskId: string; syncLocalUrl: string | null }> => {
      const { asset, costumeKey } = candidate;
      let effectiveReferenceUrl = await readFacePropReferenceUrl(asset);
      const refSrc = referenceOverride ?? candidate.referenceImageUrl;
      if (costumeKey && costumeKey !== "default" && refSrc) {
        effectiveReferenceUrl = refSrc;
      }
      const selectedModelForAsset = assetImageModels[asset.id] || imageModel;
      const d = await submitAssetImageGeneration(asset.id, {
        model: selectedModelForAsset,
        resolution: assetResolutions[asset.id] || imageResolution,
        style: assetStyles[asset.id] || imageStyle,
        ...(enhancementPrompt?.trim() ? { enhancementPrompt: enhancementPrompt.trim() } : {}),
        ...(costumeKey ? { costumeKey } : {}),
      }, effectiveReferenceUrl);
      const pendingKey = `${asset.id}:${costumeKey || "default"}`;
      const taskId = typeof d.taskId === "string" ? d.taskId : "";
      if (taskId) {
        setPendingTasks((previous) => new Map(previous).set(taskId, pendingKey));
        setGenerationLock({
          key: getAssetGenerationLockKey(projectId, pendingKey),
          scope: "asset_image",
          projectId,
          taskId,
          metadata: { pendingKey },
        });
        trackTaskId(taskId);
        return { taskId, syncLocalUrl: null };
      }
      // 同步落地（sf-asset:// 参考图流式路径）：finalizeTaskOutput 返回 localUrl。
      const localUrl = await finalizeTaskOutput(d, pendingKey);
      if (!localUrl) throw new Error("保存到本地失败");
      return { taskId: "", syncLocalUrl: localUrl };
    };

    // 并发上限（防 Next route 超时），与原 BATCH_CHUNK_SIZE 一致。
    let semAvailable = BATCH_CHUNK_SIZE;
    const semQueue: Array<() => void> = [];
    const acquire = (): Promise<void> => new Promise((resolve) => {
      if (semAvailable > 0) {
        semAvailable -= 1;
        resolve();
      } else {
        semQueue.push(resolve);
      }
    });
    const release = () => {
      const next = semQueue.shift();
      if (next) next();
      else semAvailable += 1;
    };
    const submitCapped = async (candidate: ImageGenerationCandidate, referenceOverride?: string) => {
      await acquire();
      try {
        return await submitOne(candidate, referenceOverride);
      } finally {
        release();
      }
    };

    // 等待某 taskId 的基准图落地（SSE COMPLETED resolver）；超时/失败回退 null，由调用方决定跳过变体（不退化文生图）。
    const awaitBaselineCommitted = (taskId: string, timeoutMs = 120000): Promise<string | null> =>
      new Promise((resolve) => {
        const early = earlyCompletionsRef.current.get(taskId);
        if (early !== undefined) {
          earlyCompletionsRef.current.delete(taskId);
          resolve(early);
          return;
        }
        const timer = setTimeout(() => {
          taskResolversRef.current.delete(taskId);
          resolve(null);
        }, timeoutMs);
        taskResolversRef.current.set(taskId, (localUrl) => {
          clearTimeout(timer);
          resolve(localUrl);
        });
      });

    // 按资产分组：基准(default) 与 变体。资产间并发，资产内先基准后变体。
    const groups = new Map<string, { defaults: ImageGenerationCandidate[]; variants: ImageGenerationCandidate[] }>();
    for (const candidate of candidates) {
      const group = groups.get(candidate.asset.id) ?? { defaults: [], variants: [] };
      if (candidate.costumeKey && candidate.costumeKey !== "default") group.variants.push(candidate);
      else group.defaults.push(candidate);
      groups.set(candidate.asset.id, group);
    }

    await Promise.all([...groups.values()].map(async (group) => {
      // 1) 基准优先：提交该资产基准，等其落地拿到 localUrl 作为变体图生图参考。
      let baselineUrl: string | null = null;
      for (const defaultCandidate of group.defaults) {
        // eslint-disable-next-line no-await-in-loop
        try {
          const res = await submitCapped(defaultCandidate);
          if (res.taskId) {
            // eslint-disable-next-line no-await-in-loop
            baselineUrl = (await awaitBaselineCommitted(res.taskId)) ?? readAssetDefaultUrl(defaultCandidate.asset);
          } else {
            baselineUrl = res.syncLocalUrl ?? readAssetDefaultUrl(defaultCandidate.asset);
          }
          reportDone(false);
        } catch {
          reportDone(true);
        }
      }
      // 本批未含基准候选（基准已有图）→ 取资产现有基准图作变体参考。
      if (baselineUrl === null && group.defaults.length === 0 && group.variants.length > 0) {
        baselineUrl = readAssetDefaultUrl(group.variants[0].asset);
      }
      // 2) 变体：必须基于基准图图生图（保五官一致）。基准未就绪/失败 → 不生变体，严禁退化文生图。
      if (group.variants.length > 0 && !baselineUrl) {
        const blockedAssetName = group.variants[0].asset?.name ?? "该资产";
        toast.error(`${blockedAssetName}：基准图未就绪/失败，已跳过 ${group.variants.length} 个变体（变体必须基于基准图生图）`);
        group.variants.forEach(() => reportDone(true));
      } else {
        await Promise.all(group.variants.map(async (variantCandidate) => {
          try {
            await submitCapped(variantCandidate, baselineUrl ?? undefined);
            reportDone(false);
          } catch {
            reportDone(true);
          }
        }));
      }
    }));

    if (successCount > 0) {
      toast.success(`已提交 ${successCount} 张图片生成任务${failCount > 0 ? `，${failCount} 张失败` : ""}`);
    } else if (failCount > 0) {
      toast.error(`全部 ${failCount} 张图片生成失败`);
    }
    batchAwaitingRef.current = false;
    setBatchGenerating(false);
    setBatchProgress(null);
  };

  /** 对齐 app1：首次点击同时提交默认图和全部缺失造型，默认图候选排在变体前。 */
  const buildMissingImageCandidates = (list: AssetRecord[]): ImageGenerationCandidate[] =>
    buildMissingAssetImageCandidates(list, isAssetGenerating);

  /** 当前分类全部重生：默认图 + 每个已定义造型变体，逐图排除生成中任务。 */
  const buildRegenerateCandidates = (list: AssetRecord[]): ImageGenerationCandidate[] =>
    buildRegenerateAssetImageCandidates(list, isAssetGenerating);

  /** 生成当页所有缺图资产 */
  const handleBatchGenerate = async () => {
    if (isReview) {
      toast.info("只读模式，不可操作");
      return;
    }
    const candidates = buildMissingImageCandidates(tabAssets);
    const lockedCnt = tabAssets.filter((a) => a.regenLocked).length;
    if (candidates.length === 0) {
      toast.info(
        lockedCnt > 0
          ? `当前分类下没有可生成的资产（${lockedCnt} 个已锁定，请先「一键解锁」）`
          : "当前分类下没有需要生成图片的资产（已有图或生成中）",
      );
      return;
    }
    if (lockedCnt > 0) toast.info(`已跳过 ${lockedCnt} 个已锁定资产，如需重新生成请先「一键解锁」`);
    await submitBatchGenerate(candidates);
  };

  /** 一键生成所有资产（所有分类下缺图资产） */
  const handleGenerateAllAssets = async () => {
    if (isReview) {
      toast.info("只读模式，不可操作");
      return;
    }
    const candidates = buildMissingImageCandidates(assets);
    const lockedCnt = assets.filter((a) => a.regenLocked).length;
    if (candidates.length === 0) {
      toast.info(
        lockedCnt > 0
          ? `所有资产均已生成或已锁定（${lockedCnt} 个已锁定，请先「一键解锁」）`
          : "所有资产均已生成图片或正在生成中",
      );
      return;
    }
    if (lockedCnt > 0) toast.info(`已跳过 ${lockedCnt} 个已锁定资产，如需重新生成请先「一键解锁」`);
    await submitBatchGenerate(candidates);
  };

  /** 一键重新生成：重新生成当前分类下所有资产（含已有图）的图片 */
  const handleBatchRegenerate = async () => {
    if (isReview) {
      toast.info("只读模式，不可操作");
      return;
    }
    const candidates = buildRegenerateCandidates(tabAssets);
    const lockedCnt = tabAssets.filter((a) => a.regenLocked).length;
    if (candidates.length === 0) {
      toast.info(
        lockedCnt > 0
          ? `当前分类下所有资产均已锁定（${lockedCnt} 个），请先「一键解锁」后再重新生成`
          : "当前分类下没有可重新生成的资产",
      );
      setRegenConfirmOpen(false);
      return;
    }
    if (lockedCnt > 0) toast.info(`已跳过 ${lockedCnt} 个已锁定资产，如需重新生成请先「一键解锁」`);
    await submitBatchGenerate(candidates);
    setRegenConfirmOpen(false);
  };

  /** 更新资产（PATCH /assets/[assetId]，透传白名单字段） */
  const handleUpdateAsset = async (assetId: string, data: Record<string, unknown>) => {
    if (isReview) return null;
    const d = await api(
      `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
      { method: "PATCH", body: JSON.stringify(data) },
    );
    return d;
  };

  /** 确认资产（isConfirmed + regenLocked + metadata.confirmed） */
  const handleConfirmAsset = async (assetId: string) => {
    if (isReview) {
      toast.info("只读模式，不可操作");
      return;
    }
    const d = await handleUpdateAsset(assetId, {
      isConfirmed: true,
      regenLocked: true, // 确认即锁定，防止 AI 重新生图覆盖
      // 不传 metadata：确认只动列标志。旧实现传 {confirmed,confirmedAt} 走全量替换，
      // 把整剧提取写入的 confirmed_voice/suggested_voices 等全擦了（isConfirmed 列已足够）。
    });
    if (d) {
      toast.success("资产已确认并锁定");
      // B7：确认后显式保持选中刚确认的资产，避免 onRefresh 全量刷新时选中跳回第一个。
      setSelectedAssetId(assetId);
      onRefresh({ force: true });
    }
  };

  /** 一键确认所有资产（批量 PATCH，per-asset 循环替代 confirm-assets route） */
  const handleConfirmAllAssets = async () => {
    if (isReview) {
      toast.info("只读模式，不可操作");
      return;
    }
    const candidates = assets.filter(
      (a) => !(a.isConfirmed || (a.metadata as Record<string, unknown> | null)?.confirmed === true),
    );
    if (candidates.length === 0) {
      toast.info("所有资产均已确认");
      return;
    }
    setBatchConfirming(true);
    toast.info(`正在批量确认 ${candidates.length} 个资产...`);
    try {
      const results = await Promise.allSettled(
        candidates.map((a) =>
          api(
            `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(a.id)}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                isConfirmed: true,
                regenLocked: true,
                // 不传 metadata：确认只动列标志，避免全量替换擦掉提取的语音/变体元数据。
              }),
            },
          ),
        ),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const fail = results.length - ok;
      if (fail === 0) {
        toast.success(`已确认 ${ok} 个资产`);
      } else {
        toast.warning(`确认完成：成功 ${ok}，失败 ${fail}`);
      }
      onRefresh({ force: true });
    } catch (e: unknown) {
      toast.error(`批量确认失败: ${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setBatchConfirming(false);
    }
  };

  /** 切换单个资产的重新生成锁 */
  const handleToggleAssetLock = async (assetId: string, locked: boolean) => {
    if (isReview) {
      toast.info("只读模式，不可操作");
      return;
    }
    const d = await handleUpdateAsset(assetId, { regenLocked: locked });
    if (d) {
      toast.success(locked ? "已锁定资产，AI 将无法重新生成" : "已解锁，可重新生成图片");
      onRefresh({ force: true });
    }
  };

  /** 一键解锁全部已锁定资产 */
  const handleUnlockAllAssets = async () => {
    if (isReview) {
      toast.info("只读模式，不可操作");
      return;
    }
    const candidates = assets.filter((a) => a.regenLocked);
    if (candidates.length === 0) {
      toast.info("当前没有已锁定的资产");
      return;
    }
    setBatchUnlocking(true);
    toast.info(`正在解锁 ${candidates.length} 个资产...`);
    try {
      const results = await Promise.allSettled(
        candidates.map((a) =>
          api(
            `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(a.id)}`,
            { method: "PATCH", body: JSON.stringify({ regenLocked: false }) },
          ),
        ),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const fail = results.length - ok;
      if (fail === 0) toast.success(`已解锁 ${ok} 个资产，现在可以重新生成`);
      else toast.warning(`解锁完成：成功 ${ok}，失败 ${fail}`);
      onRefresh({ force: true });
    } catch (e: unknown) {
      toast.error(`批量解锁失败: ${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setBatchUnlocking(false);
    }
  };

  /** 删除资产 */
  const handleDeleteAsset = async (assetId: string) => {
    if (deletingAsset) return;
    setDeletingAsset(true);
    try {
      const d = await api(
        `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
        { method: "DELETE" },
      );
      if (d) {
        toast.success("资产已删除");
        setDeleteConfirmAsset(null);
        onRefresh({ force: true });
      }
    } catch (e: unknown) {
      toast.error(`删除失败: ${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setDeletingAsset(false);
    }
  };

  /** 添加新资产（POST /assets，kind 白名单 CHARACTER/PROP/LOCATION/ENTITY） */
  const handleAddAsset = async () => {
    if (!newAssetName.trim()) {
      toast.error("请输入资产名称");
      return;
    }
    setAddingAsset(true);
    try {
      const d = await api(
        `/api/projects/${encodeURIComponent(projectId)}/assets`,
        {
          method: "POST",
          body: JSON.stringify({
            kind: newAssetKind,
            name: newAssetName.trim(),
            description: newAssetDesc.trim() || undefined,
          }),
        },
      );
      if (d) {
        toast.success(`${newAssetName} 已添加`);
        setNewAssetName("");
        setNewAssetDesc("");
        setShowAddForm(false);
        onRefresh({ force: true });
      }
    } catch (e: unknown) {
      toast.error(`添加失败: ${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setAddingAsset(false);
    }
  };

  // ============================================================
  // 渲染
  // ============================================================
  const currentTabInfo = ASSET_TABS.find((t) => t.key === activeTab);
  const regenCandidates = buildRegenerateCandidates(tabAssets);

  /** [资产设定 | 资产总表] 视图切换控件（master 早返回与 design 标题区共用）。 */
  const designViewToggle = (
    <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--bg)] border border-[var(--border-light)]">
      {(["design", "master"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => setDesignView(v)}
          className={`px-3 py-1 text-xs rounded-md transition-colors ${
            designView === v
              ? "bg-[var(--action)] text-white"
              : "text-[var(--text-3)] hover:text-[var(--text)]"
          }`}
        >
          {v === "design" ? "资产设定" : "资产总表"}
        </button>
      ))}
    </div>
  );

  // 资产总表视图：项目级出场矩阵（与资产设定同页切换）。
  // 早返回安全：其上所有 hooks（useState/useEffect/useCallback/useRef）均已执行。
  if (designView === "master") {
    return (
      <div className="w-full max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6 flex flex-col h-full">
        <div className="flex items-center justify-between mb-4 sm:mb-5">
          <div>
            <h2
              className="text-xl font-bold text-[var(--text)]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              资产总表
            </h2>
            <p className="text-xs text-[var(--text-3)] mt-1">
              项目级资产出场矩阵 · 出场集从分镜引用派生
            </p>
          </div>
          {designViewToggle}
        </div>
        <AssetMasterPanel projectId={projectId} className="flex-1 min-h-0" />
      </div>
    );
  }

  return (
    <div className="w-full max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6 flex flex-col h-full">
      {/* A1. 标题区 + 完成按钮 */}
      <div className="flex items-center justify-between mb-4 sm:mb-5">
        <div>
          <h2
            className="text-xl font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            资产设定
            {isReview && (
              <span className="ml-2 px-2 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-3)] text-[10px] font-medium border border-[var(--border-light)] align-middle">
                可查看/生成
              </span>
            )}
          </h2>
          <p className="text-xs text-[var(--text-3)] mt-1">
            为角色、物品、环境、实体生成设计图并确认，建立一致性设定
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {designViewToggle}
          {!isReview && (
            <button
              onClick={onComplete}
              disabled={loading || confirmedCount === 0}
              className="btn-primary px-5 py-2.5 rounded-xl text-sm inline-flex items-center gap-2 disabled:opacity-50"
              title={
                confirmedCount === 0 ? "请先确认至少一个资产" : "完成资产设定，进入分镜设计阶段"
              }
            >
              {loading ? (
                "处理中..."
              ) : (
                <>
                  完成资产设定，进入分镜
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M6 3l5 5-5 5"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* A3. 工具栏：进度 + 生成状态 */}
      <div className="mb-4 px-3 sm:px-4 py-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border-light)] space-y-2">
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <div className="text-xs text-[var(--text-3)]">
            <span className="text-[var(--text-2)] font-semibold">{confirmedCount}</span>
            <span className="opacity-60">/{assets.length}</span> 已确认
          </div>
          {lockedCount > 0 && (
            <div
              className="text-xs text-[var(--text-3)] inline-flex items-center gap-1"
              title="已锁定的资产不可被 AI 重新生图，需先解锁"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                className="text-[var(--warning)]"
                aria-hidden="true"
              >
                <path
                  d="M6 10V8a6 6 0 1112 0v2M5 10h14v10H5V10z"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-[var(--warning)] font-semibold">{lockedCount}</span>
              <span className="opacity-60"> 已锁定</span>
            </div>
          )}
          {generatingIds.size > 0 && (
            <span className="text-xs text-[var(--action)] inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[var(--action)] animate-pulse" />
              {generatingIds.size} 个资产生成中
            </span>
          )}
        </div>
        <StageProgress
          progress={assets.length > 0 ? Math.round((confirmedCount / assets.length) * 100) : 0}
          stage={generatingIds.size > 0 ? "资产图片生成中" : "资产确认进度"}
          position={`${confirmedCount}/${assets.length} 已确认${generatingIds.size > 0 ? ` · ${generatingIds.size} 生成中` : ""}`}
          completed={confirmedCount === assets.length && assets.length > 0}
          pulse={generatingIds.size > 0}
          size="sm"
          variant={
            generatingIds.size > 0
              ? "accent"
              : confirmedCount === assets.length && assets.length > 0
                ? "success"
                : "accent"
          }
        />
      </div>

      {/* A4. 四类 Tab + 重新提取 + 添加 + 批量生成 */}
      <div className="flex items-center gap-3 mb-4 border-b border-[var(--border-light)] pb-2 overflow-x-auto">
        <div className="flex gap-1 items-center flex-nowrap shrink-0">
          {ASSET_TABS.map((tab) => {
            const count = assets.filter((a) => a.kind === tab.key).length;
            const confirmed = assets.filter(
              (a) =>
                a.kind === tab.key &&
                (a.isConfirmed ||
                  (a.metadata as Record<string, unknown> | null)?.confirmed === true),
            ).length;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all
                  ${activeTab === tab.key
                    ? "bg-[var(--action-dim)] text-[var(--action)] shadow-sm"
                    : "text-[var(--text-3)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]"}`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d={tab.icon}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {tab.label}
                <span className="text-xs opacity-60">
                  ({confirmed}/{count})
                </span>
              </button>
            );
          })}
          {!isReview && (
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="ml-2 flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-medium text-[var(--action)] hover:bg-[var(--action-dim)] transition-all"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              添加{currentTabInfo?.label}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 flex-nowrap shrink-0 ml-auto">
          <ModelSelector
            models={LANGUAGE_MODELS}
            value={scriptModel}
            onChange={setScriptModel}
            label="提取模型"
            showDetails={false}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleReextract()}
            loading={extracting}
            disabled={loading}
            className="whitespace-nowrap"
            title="重新从剧本提取角色/物品/环境（会清除未确认的资产）"
          >
            {extracting ? "提取中" : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                重新提取
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setInheritOpen(true)}
            disabled={loading}
            className="whitespace-nowrap"
            title="从另一季项目继承重复角色/物体/环境/变体的资产外观（图+身份+造型），不新增"
          >
            季继承
          </Button>
          {inheritOpen && (
            <SeasonInheritDialog
              projectId={projectId}
              api={api}
              onClose={() => setInheritOpen(false)}
              onDone={() => onRefresh({ force: true })}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleBatchGenerate()}
            loading={batchGenerating}
            progress={
              batchGenerating && batchProgress
                ? (batchProgress.done / Math.max(1, batchProgress.total)) * 100
                : undefined
            }
            disabled={isReview}
            className="whitespace-nowrap"
            title="为当前分类下所有缺图资产生成设计图"
          >
            {batchGenerating ? "提交中" : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                生成当页
              </>
            )}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleGenerateAllAssets()}
            loading={batchGenerating}
            progress={
              batchGenerating && batchProgress
                ? (batchProgress.done / Math.max(1, batchProgress.total)) * 100
                : undefined
            }
            disabled={isReview}
            className="whitespace-nowrap"
            title="为所有分类（角色/物品/环境/实体）下所有缺图资产生成设计图"
          >
            {batchGenerating ? "提交中" : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M19 11H5m14 0a2 2 0 012 2v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-2a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                全部生成
              </>
            )}
          </Button>
          <button
            onClick={() => setRegenConfirmOpen(true)}
            disabled={batchGenerating || isReview || tabAssets.length === 0}
            className="btn-ghost px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap"
            title={`重新生成当前分类下全部 ${regenCandidates.length} 张默认图和造型变体图`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            全部重新生成（{regenCandidates.length} 张）
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleConfirmAllAssets()}
            loading={batchConfirming}
            disabled={isReview}
            className="whitespace-nowrap"
            title="一键确认所有未确认资产，确认后自动锁定"
          >
            {batchConfirming ? "确认中" : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M5 13l4 4L19 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                一键确认
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleUnlockAllAssets()}
            loading={batchUnlocking}
            disabled={isReview || lockedCount === 0}
            className="whitespace-nowrap"
            title={
              lockedCount === 0
                ? "当前没有已锁定的资产"
                : `一键解锁 ${lockedCount} 个已锁定资产，解锁后可重新生成图片`
            }
          >
            {batchUnlocking ? "解锁中" : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M8 11V7a4 4 0 118 0m-4 6v4m-4 0h8"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <circle cx="12" cy="15" r="2" stroke="currentColor" strokeWidth="2" />
                </svg>
                一键解锁{lockedCount > 0 ? `(${lockedCount})` : ""}
              </>
            )}
          </Button>
          {setEnhancementPrompt && (
            <button
              type="button"
              onClick={() => {
                setEnhancementDraft(enhancementPrompt || "");
                setEnhancementModalOpen(true);
              }}
              className={`btn-ghost px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5 whitespace-nowrap ${(enhancementPrompt || "").trim() ? "text-[var(--accent)]" : ""}`}
              title="编辑资产设定增强提示词（指导设计图生成风格/质量）"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 2l2.4 7.4H22l-6 4.4 2.3 7.2-6.3-4.6L5.7 21l2.3-7.2-6-4.4h7.6L12 2z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
              增强提示词
              {(enhancementPrompt || "").trim() && (
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* A5. 重新提取中进度 */}
      {(extracting || extractJustDone) && (
        <div className="mb-4 rounded-xl border border-[var(--action)]/20 bg-[var(--action-dim)]/20 p-4">
          <ProgressBar
            progress={extractJustDone ? 100 : 0}
            label={extractJustDone ? "资产提取完成" : "资产提取中"}
            stage={extractJustDone ? undefined : "后端正在分析并覆盖旧资产（当前接口无中间百分比）"}
            pulse={!extractJustDone}
            completed={extractJustDone}
          />
          <div className="mt-2 text-xs text-[var(--text-3)]">
            正在重新提取角色、物品、环境，并同步清理上一轮分析生成的旧资产。
          </div>
        </div>
      )}

      {batchGenerating && batchProgress && (
        <div className="mb-4 rounded-xl border border-[var(--action)]/20 bg-[var(--action-dim)]/20 p-4">
          <ProgressBar
            progress={Math.round((batchProgress.done / Math.max(1, batchProgress.total)) * 100)}
            label="批量图片生成与本地落盘"
            stage={`${batchProgress.done}/${batchProgress.total} 已提交${batchProgress.failed ? ` · ${batchProgress.failed} 失败` : ""}`}
            pulse={batchProgress.done < batchProgress.total}
          />
          <div className="mt-2 text-xs text-[var(--text-3)]">
            每张图完成后立即更新当前图，旧图保留在历史版本；较慢的旧请求不能回滚最新图。
          </div>
        </div>
      )}

      {/* A6. 资产设定增强提示词：收进工具栏最右侧按钮 + Modal 弹层（用户要"写到右边去"） */}
      {setEnhancementPrompt && (
        <Modal
          open={enhancementModalOpen}
          onClose={setEnhancementModalOpen}
          title="增强提示词"
          description="用于指导设计图生成风格/质量（单镜生成、一键生成/重新生成时生效）"
          maxWidthClassName="max-w-lg"
        >
          <textarea
            value={enhancementDraft}
            onChange={(e) => setEnhancementDraft(e.target.value)}
            rows={6}
            autoFocus
            placeholder="可选。例如：影视级设定稿、材质纹理清晰；角色含正面/侧面/背面多角度；环境广角构图、氛围光明确；也可直接写期望的画风（如二次元/3D/水彩/写实等）..."
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-2)] border border-[var(--action)]/40 text-xs text-[var(--text)] placeholder:text-[var(--text-3)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--action)]/20 resize-y leading-5"
          />
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={() => {
                setEnhancementPrompt(enhancementDraft);
                setEnhancementModalOpen(false);
                toast.success("增强提示词已保存");
              }}
              className="px-3 py-1.5 rounded-md bg-[var(--action)] text-white text-xs font-medium hover:opacity-90 transition-opacity"
            >
              保存
            </button>
            {(enhancementPrompt || "").trim() && (
              <button
                onClick={() => {
                  setEnhancementPrompt("");
                  setEnhancementDraft("");
                  setEnhancementModalOpen(false);
                  toast.info("已清空增强提示词");
                }}
                className="px-3 py-1.5 rounded-md text-[var(--text-3)] text-xs hover:text-[var(--danger)] transition-colors"
              >
                清空
              </button>
            )}
            <span className="text-[10px] text-[var(--text-3)]/60">
              保存后对后续生成立即生效
            </span>
            <button
              onClick={() => setEnhancementModalOpen(false)}
              className="px-3 py-1.5 rounded-md bg-[var(--bg-hover)] text-[var(--text-2)] text-xs font-medium hover:opacity-80 transition-opacity ml-auto"
            >
              取消
            </button>
          </div>
        </Modal>
      )}

      {/* A7. 添加资产表单 */}
      {showAddForm && !isReview && (
        <div className="mb-4 p-4 rounded-xl bg-[var(--bg-card)] border border-[var(--border-light)]">
          <div className="text-xs font-medium text-[var(--text-2)] mb-3">
            添加新{currentTabInfo?.label}
          </div>
          <div className="flex gap-2 items-start flex-wrap">
            <div className="flex-1 min-w-[120px]">
              <label className="text-[10px] text-[var(--text-3)] mb-1 block">类型</label>
              <select
                value={newAssetKind}
                onChange={(e) => setNewAssetKind(e.target.value)}
                className="input-base w-full px-2 py-1.5 rounded-lg text-xs appearance-none cursor-pointer"
              >
                {ASSET_TABS.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1 min-w-[150px]">
              <label className="text-[10px] text-[var(--text-3)] mb-1 block">名称 *</label>
              <input
                value={newAssetName}
                onChange={(e) => setNewAssetName(e.target.value)}
                className="input-base w-full px-2 py-1.5 rounded-lg text-xs"
                placeholder="输入名称"
              />
            </div>
            <div className="flex-[2] min-w-[200px]">
              <label className="text-[10px] text-[var(--text-3)] mb-1 block">描述（可选）</label>
              <input
                value={newAssetDesc}
                onChange={(e) => setNewAssetDesc(e.target.value)}
                className="input-base w-full px-2 py-1.5 rounded-lg text-xs"
                placeholder="外观/特征/场景描述"
              />
            </div>
            <div className="flex gap-1 items-end">
              <button
                onClick={() => {
                  setShowAddForm(false);
                  setNewAssetName("");
                  setNewAssetDesc("");
                }}
                className="btn-ghost px-3 py-1.5 rounded-lg text-xs"
              >
                取消
              </button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleAddAsset()}
                loading={addingAsset}
                disabled={!newAssetName.trim()}
              >
                添加
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* A8. 主内容区：左右分栏（CHARACTER/PROP/LOCATION/ENTITY 通用） */}
      <div
        className={`flex-1 overflow-hidden flex ${isWideScreen ? "flex-row" : "flex-col"} gap-4 min-h-0 mb-4`}
      >
        {/* 左侧资产列表 */}
        <CharacterSidebar
          assets={sidebarAssets}
          selectedId={selectedAssetId}
          onSelect={setSelectedAssetId}
          proxyUrlFn={(_assetId, originalUrl) => originalUrl || undefined}
          isWideScreen={isWideScreen}
          tabLabel={currentTabInfo?.label || "资产"}
          tabIconPath={currentTabInfo?.icon}
        />

        {/* 右侧编辑面板（选中资产时显示，否则显示空状态） */}
        {selectedSidebarAsset ? (
          <CharacterEditorPanel
            asset={selectedSidebarAsset}
            projectId={projectId}
            onGenerateImage={handleGenerateImage}
            onUpdate={handleUpdateAsset}
            onConfirm={handleConfirmAsset}
            onDelete={() => setDeleteConfirmAsset(selectedSidebarAsset)}
            isGenerating={isAssetGenerating(selectedSidebarAsset.id)}
            taskId={getAssetTaskId(selectedSidebarAsset.id)}
            isVariantGenerating={isAssetGenerating}
            getVariantTaskId={getAssetTaskId}
            imgErrors={imgErrors}
            setImgErrors={setImgErrors}
            toast={toast}
            isReview={isReview}
            imageModel={assetImageModels[selectedSidebarAsset.id] || imageModel}
            onImageModelChange={(model) =>
              setAssetImageModels((prev) => ({ ...prev, [selectedSidebarAsset.id]: model }))
            }
            resolution={assetResolutions[selectedSidebarAsset.id] || imageResolution}
            onResolutionChange={(res) =>
              setAssetResolutions((prev) => ({ ...prev, [selectedSidebarAsset.id]: res }))
            }
            regenLocked={selectedSidebarAsset.regenLocked}
            onLockToggle={handleToggleAssetLock}
            onZoom={(assetId) => setImageZoomAssetId(assetId)}
            onUpload={handleUploadImage}
            onRefresh={() => onRefresh({ force: true })}
            tabLabel={currentTabInfo?.label || "资产"}
          />
        ) : (
          <div className="flex-1 min-h-0 flex items-center justify-center bg-[var(--bg-card)] border border-[var(--border-light)] rounded-xl">
            <div className="text-center">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                className="opacity-20 mx-auto mb-3 text-[var(--text-3)]"
                aria-hidden="true"
              >
                <path
                  d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 100-8 4 4 0 000 8z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <p className="text-sm text-[var(--text-3)]">
                {sidebarAssets.length === 0
                  ? `暂无${currentTabInfo?.label || ""}资产`
                  : `请从左侧选择一个${currentTabInfo?.label || "资产"}进行编辑`}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* A13. 删除确认对话框 */}
      {deleteConfirmAsset && (
        <ConfirmDialog
          open={!!deleteConfirmAsset}
          title="删除资产"
          message={`确定要删除"${deleteConfirmAsset.name}"吗？删除后，引用该资产的分镜仍保留名称引用。此操作不可撤销。`}
          confirmLabel="删除"
          cancelLabel="取消"
          variant="danger"
          onConfirm={() => void handleDeleteAsset(deleteConfirmAsset.id)}
          onCancel={() => {
            if (!deletingAsset) setDeleteConfirmAsset(null);
          }}
          loading={deletingAsset}
        />
      )}

      {/* 一键重新生成确认对话框 */}
      <ConfirmDialog
        open={regenConfirmOpen}
        title="全部重新生成"
        message={`将为当前分类新增 ${regenCandidates.length} 张设计图版本，包含默认图和所有已定义造型变体。已有图片和历史版本都会保留，是否继续？`}
        confirmLabel={`重新生成 ${regenCandidates.length} 张`}
        cancelLabel="取消"
        variant="warning"
        onConfirm={() => void handleBatchRegenerate()}
        onCancel={() => {
          if (!batchGenerating) setRegenConfirmOpen(false);
        }}
        loading={batchGenerating}
      />

      {/* A14. 放大查看资产图片（支持滚轮缩放、拖拽、左右切换当前 tab 下的所有资产） */}
      {(() => {
        const baseItems = tabAssets
          .filter((a) => !!a.imageUrl)
          .map((asset, i, arr) => ({
            id: asset.id,
            title: asset.name,
            subtitle: `${KIND_LABELS[asset.kind] || asset.kind} · ${i + 1}/${arr.length}`,
            // OP3 必修：直接用 asset.imageUrl（sf-asset://），无 proxyImageUrl 代理
            src: localImages[asset.id] || asset.imageUrl || undefined,
            alt: asset.name,
            meta: [
              { label: "类型", value: KIND_LABELS[asset.kind] || asset.kind || "—" },
              { label: "描述", value: asset.description || "—" },
              ...(asset.kind === "CHARACTER"
                ? [
                    { label: "背景", value: asset.background || "—" },
                    { label: "音色特征", value: asset.voiceTrait || "—" },
                    {
                      label: "身份锁定",
                      value: (asset.identityLock || []).join("、") || "—",
                    },
                  ]
                : []),
              ...(asset.assetType ? [{ label: "资产类型", value: asset.assetType }] : []),
            ],
          }));
        // B2：CHARACTER 变体图也并入放大查看（变体图打不开——复用 ZoomViewer，sf-asset:// 天然支持）
        const variantItems = tabAssets
          .filter((a) => a.kind === "CHARACTER" && Array.isArray(a.costumes))
          .flatMap((asset) =>
            (asset.costumes as Array<Record<string, unknown>>)
              .filter(
                (c) =>
                  c &&
                  typeof c.imageUrl === "string" &&
                  (c.key as string) !== "default",
              )
              .map((c) => ({
                id: `${asset.id}__${(c.key as string) || "default"}`,
                title: `${asset.name} · ${(c.label as string) || (c.key as string) || ""}`,
                subtitle: "变体",
                src: (c.imageUrl as string) || undefined,
                alt: asset.name,
                meta: [
                  { label: "类型", value: "变体" },
                  {
                    label: "名称",
                    value: (c.label as string) || (c.key as string) || "—",
                  },
                ],
              })),
          );
        const zoomItems: ZoomItem[] = [...baseItems, ...variantItems];
        const idx = zoomItems.findIndex((it) => it.id === imageZoomAssetId);
        return (
          <ZoomViewer
            mode="image"
            items={zoomItems}
            index={Math.max(0, idx)}
            open={idx >= 0}
            onClose={() => setImageZoomAssetId("")}
            onIndexChange={(i) => setImageZoomAssetId(zoomItems[i]?.id || "")}
          />
        );
      })()}
    </div>
  );
}

// ============================================================
// CharacterSidebar — 左侧资产列表（CHARACTER/PROP/LOCATION/ENTITY 通用）
// ============================================================

interface CharacterSidebarProps {
  assets: AssetRecord[];
  selectedId: string;
  onSelect: (id: string) => void;
  /**
   * 缩略图 URL 构造器。
   * app1 用 proxyUrlFn 返回 `/api/.../image?v=` 代理 URL；dramaforge 无此 route（OP3），
   * 直接返回 originalUrl（sf-asset:// 在 Electron protocol.handle 显示）。
   */
  proxyUrlFn: (assetId: string, originalUrl?: string | null) => string | undefined;
  isWideScreen: boolean;
  tabLabel: string;
  tabIconPath?: string;
}

export function CharacterSidebar({
  assets: assetList,
  selectedId,
  onSelect,
  proxyUrlFn,
  isWideScreen,
  tabLabel,
  tabIconPath,
}: CharacterSidebarProps) {
  const confirmedCount = assetList.filter(
    (c) => c.isConfirmed || (c.metadata as Record<string, unknown> | null)?.confirmed === true,
  ).length;

  return (
    <div
      className={`${isWideScreen ? "w-[340px] xl:w-[380px]" : "w-full h-[140px]"} flex-shrink-0 bg-[var(--bg-card)] border border-[var(--border-light)] rounded-xl overflow-hidden flex ${isWideScreen ? "flex-col" : "flex-row"} min-h-0`}
    >
      {/* 头部 */}
      <div
        className={`px-4 py-3 border-b border-[var(--border-light)] flex-shrink-0 ${!isWideScreen ? "hidden" : ""}`}
      >
        <h3 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
          {tabIconPath ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              className="text-[var(--action)] flex-shrink-0"
              aria-hidden="true"
            >
              <path
                d={tabIconPath}
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
          {tabLabel}列表
        </h3>
        <p className="text-[10px] text-[var(--text-3)] mt-1 tabular-nums">
          {assetList.length} 个{tabLabel} ·{" "}
          <span className="text-[var(--success)]">{confirmedCount} 已确认</span>
        </p>
      </div>

      {/* 列表（可滚动） */}
      <div
        className={`flex-1 overflow-y-auto p-2 min-h-0 ${isWideScreen ? "grid grid-cols-2 gap-1.5 content-start" : "flex flex-row gap-2 overflow-x-auto"}`}
      >
        {assetList.length === 0 ? (
          <div className="text-center py-8 text-[var(--text-3)] text-xs">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              className="opacity-20 mx-auto mb-2"
              aria-hidden="true"
            >
              <path
                d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 100-8 4 4 0 000 8z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            暂无{tabLabel}资产
          </div>
        ) : (
          assetList.map((char) => {
            const isSelected = selectedId === char.id;
            const isConfirmed =
              char.isConfirmed ||
              (char.metadata as Record<string, unknown> | null)?.confirmed === true;
            const hasImage = !!char.imageUrl;
            // OP3：直接用 asset.imageUrl（sf-asset://），无 proxyImageUrl 代理
            const thumbUrl = proxyUrlFn(char.id, char.imageUrl);

            return (
              <button
                key={char.id}
                onClick={() => onSelect(char.id)}
                className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg transition-all text-left group flex-shrink-0
                  ${isSelected
                    ? "bg-[var(--action)]/10 ring-1 ring-[var(--action)]/40 shadow-sm"
                    : "hover:bg-[var(--bg-hover)] border border-transparent"}`}
              >
                {/* 缩略图（36x36 圆角） */}
                {hasImage && thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumbUrl}
                    alt={char.name}
                    className="w-8 h-8 rounded-md object-cover flex-shrink-0 border border-[var(--border-light)]"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-md bg-[var(--bg-hover)] flex items-center justify-center flex-shrink-0 border border-[var(--border-light)]">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      className="text-[var(--text-3)] opacity-50"
                      aria-hidden="true"
                    >
                      <path
                        d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 100-8 4 4 0 000 8z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                )}

                {/* 名称 + 状态 */}
                <div className="flex-1 min-w-0">
                  <div
                    className={`text-xs font-medium truncate ${isSelected ? "text-[var(--action)]" : "text-[var(--text)]"}`}
                  >
                    {char.name}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {isConfirmed ? (
                      <span className="text-[9px] text-[var(--success)] flex items-center gap-0.5">
                        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path
                            d="M3 8l3.5 3.5L13 5"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        已确认
                      </span>
                    ) : (
                      <span className="text-[9px] text-[var(--text-3)]">待确认</span>
                    )}
                    {!hasImage && <span className="text-[9px] text-[var(--warning)]">无图</span>}
                    {char.regenLocked && (
                      <span className="text-[9px] text-[var(--warning)] flex items-center gap-0.5">
                        <svg width="7" height="7" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M6 10V8a6 6 0 1112 0v2M5 10h14v10H5V10z"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                          />
                        </svg>
                        锁
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ============================================================
// AssetCard — 单个资产的编辑/生成/确认（简化版，删 costumes/音色/pencil/grid/credits）
// ============================================================

interface AssetVoiceOption {
  file: string;
  desc: string;
  gender: string;
  source?: string;
}

function readAssetVoiceOptions(value: unknown): AssetVoiceOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const voice = entry as Record<string, unknown>;
    if (typeof voice.file !== "string" || !voice.file) return [];
    return [{
      file: voice.file,
      desc: typeof voice.desc === "string" ? voice.desc : "",
      gender: typeof voice.gender === "string" ? voice.gender : "",
      source: typeof voice.source === "string" ? voice.source : undefined,
    }];
  });
}

interface AssetCardProps {
  asset: AssetRecord;
  projectId: string;
  onGenerateImage: (assetId: string, prompt?: string, model?: string, costumeKey?: string) => void;
  onUpdate: (assetId: string, data: Record<string, unknown>) => Promise<unknown>;
  onConfirm: (assetId: string) => void;
  onDelete?: () => void;
  isGenerating: boolean;
  taskId?: string;
  isVariantGenerating?: (assetId: string, costumeKey?: string) => boolean;
  getVariantTaskId?: (assetId: string, costumeKey?: string) => string | undefined;
  /** 图片加载失败的 assetId 集合（来自父组件 landAssetImage PATCH 失败 / sf-asset:// 显示不了） */
  imgErrors: Set<string>;
  setImgErrors: React.Dispatch<React.SetStateAction<Set<string>>>;
  toast: ReturnType<typeof useToast>;
  isReview: boolean;
  imageModel: string;
  onImageModelChange: (model: string) => void;
  resolution: string;
  onResolutionChange: (res: string) => void;
  regenLocked: boolean | null;
  onLockToggle?: (assetId: string, locked: boolean) => void;
  onZoom?: (assetId: string) => void;
  tabLabel?: string;
  /** 批2b/批5.5：用户上传本地图片（File → sfShell.saveLocalAsset → PATCH）。
   *  costumeKey 指定造型变体（"default" 或未传 = 主图）。Electron only。 */
  onUpload?: (assetId: string, file: File, costumeKey?: string) => void;
  /** 批6 音色库：音色绑定 PATCH 后刷新 assets state（来自 AssetDesignStage onRefresh）。 */
  onRefresh?: () => void;
}

interface AssetImageRevisionView {
  id: string;
  generationOrdinal: number;
  status: "GENERATING" | "GENERATED" | "COMMITTED" | "FAILED";
  source: "AI" | "UPLOAD";
  modelName: string | null;
  localUrl: string | null;
  error: string | null;
  createdAt: string;
}

/** E9：把生图失败 error 映射成用户友好的中文提示（识别 ARK 内容审核）。模块级纯函数。 */
function friendlyAssetError(raw?: string): string {
  const e = (raw || '').toLowerCase();
  if (/outputimagesensitivecontentdetected|sensitivecontent|内容审核|敏感内容/.test(e))
    return '图片被内容审核拒绝，请修改描述或换张参考图后重试';
  if (/accessdenied|forbidden|403/.test(e))
    return '图片生成被拒绝（疑似内容审核），请修改描述后重试';
  return raw || '图片生成失败';
}

function ImageGenerationProgress({ taskId, label = "AI 生成图片中" }: { taskId?: string; label?: string }) {
  return taskId ? (
    <GenerationProgress taskId={taskId} label={label} compact estimatedDuration={60} />
  ) : (
    <ProgressBar
      progress={0}
      label={label}
      size="sm"
      stage="等待服务器返回任务 ID"
      pulse
    />
  );
}

export function AssetCard({
  asset,
  projectId,
  onGenerateImage,
  onUpdate,
  onConfirm,
  onDelete,
  isGenerating,
  taskId,
  isVariantGenerating,
  getVariantTaskId,
  imgErrors,
  setImgErrors,
  toast,
  isReview,
  imageModel,
  onImageModelChange,
  resolution,
  onResolutionChange,
  regenLocked,
  onLockToggle,
  onZoom,
  onUpload,
  onRefresh,
}: AssetCardProps) {
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(asset.name || "");
  const [description, setDescription] = React.useState(asset.description || "");
  const [background, setBackground] = React.useState(asset.background || "");
  const [voiceTrait, setVoiceTrait] = React.useState(asset.voiceTrait || "");
  const [identityLockDraft, setIdentityLockDraft] = React.useState<string>(
    (asset.identityLock || []).join("、"),
  );
  /** 批5.5 造型变体：单个 variant 生成/上传 busy 状态（per-costume-key 跟踪） */
  const [variantBusy, setVariantBusy] = React.useState<Set<string>>(new Set());
  /** 需求8 变体手动编辑：undefined=关闭，null=新增，string=编辑该 key 的变体 */
  const [editingVariantKey, setEditingVariantKey] = React.useState<string | null | undefined>(undefined);
  const [variantForm, setVariantForm] = React.useState<{
    label: string;
    variantType: "costume" | "period";
    description: string;
    /** 该造型出现的场景 id（批7；自由文本逗号分隔，如 "S1, S3"）。 */
    coverageScenes: string;
  }>({ label: "", variantType: "costume", description: "", coverageScenes: "" });
  /** 批6 音色库：浏览音色 modal 开关（CHARACTER only，照搬 app1 voiceBrowserCharId 模式） */
  const [voiceBrowserOpen, setVoiceBrowserOpen] = React.useState(false);
  const [playingVoice, setPlayingVoice] = React.useState<string | null>(null);
  const voiceAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [imageRevisions, setImageRevisions] = React.useState<AssetImageRevisionView[]>([]);
  // 批2b：隐藏 file input + 上传触发（onUpload 存在时启用）
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const triggerUpload = () => {
    if (onUpload) fileInputRef.current?.click();
  };
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // reset 允许重复选同一文件
    if (f && onUpload) await onUpload(asset.id, f);
  };

  /** 批5.5：触发造型变体 AI 生成（基于基准图 i2i） */
  const handleVariantGenerate = async (vk: string) => {
    setVariantBusy((prev) => new Set(prev).add(vk));
    try {
      await onGenerateImage(asset.id, undefined, imageModel, vk);
    } finally {
      setVariantBusy((prev) => {
        const n = new Set(prev);
        n.delete(vk);
        return n;
      });
    }
  };
  /** 批5.5：触发造型变体上传 */
  const handleVariantUpload = async (vk: string, f: File) => {
    if (!onUpload) return;
    setVariantBusy((prev) => new Set(prev).add(vk));
    try {
      await onUpload(asset.id, f, vk);
    } finally {
      setVariantBusy((prev) => {
        const n = new Set(prev);
        n.delete(vk);
        return n;
      });
    }
  };

  /** 需求8：PATCH /assets/[id] 的 costumes 白名单已开（route pickPatch + hasAnyField）。走父组件 onUpdate（= handleUpdateAsset）。 */
  const patchCostumes = (next: Array<Record<string, unknown>>) =>
    onUpdate(asset.id, { costumes: next });
  /** 需求8：打开新增变体编辑器 */
  const openAddVariant = () => {
    setVariantForm({ label: "", variantType: "costume", description: "", coverageScenes: "" });
    setEditingVariantKey(null);
  };
  /** 需求8：打开编辑现有变体 */
  const openEditVariant = (cv: Record<string, unknown>) => {
    // coverageScenes 兼容 camelCase / snake_case（DB 历史 JSONB）；数组 → 逗号分隔文本。
    const scenesRaw =
      (Array.isArray(cv.coverageScenes) ? cv.coverageScenes : cv.coverage_scenes) as unknown[] | undefined;
    const coverageScenes =
      Array.isArray(scenesRaw)
        ? scenesRaw
            .map((s) => (typeof s === "string" ? s.trim() : ""))
            .filter(Boolean)
            .join(", ")
        : "";
    setVariantForm({
      label: String(cv.label ?? ""),
      variantType: cv.variantType === "period" ? "period" : "costume",
      description: String(cv.description ?? ""),
      coverageScenes,
    });
    setEditingVariantKey(String(cv.key ?? ""));
  };
  /** 需求8：保存变体（新增追加 / 编辑替换），新增时生成唯一 custom-<n> key */
  const saveVariant = async () => {
    const costumes = (Array.isArray(asset.costumes) ? asset.costumes : []) as Array<Record<string, unknown>>;
    const label = variantForm.label.trim();
    if (!label) {
      toast.error("请填写变体名称");
      return;
    }
    const editingKey = editingVariantKey;
    const targetKey = editingKey ?? (() => {
      let n = costumes.length + 1;
      let k = `custom-${n}`;
      while (costumes.some((c) => c.key === k)) { n++; k = `custom-${n}`; }
      return k;
    })();
    const base = editingKey ? (costumes.find((c) => c.key === editingKey) || {}) : {};
    // coverageScenes：自由文本「S1, S3」→ string[]（批7；分镜 resolver 按基础场景 id 匹配）。
    const coverageScenes = variantForm.coverageScenes
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const merged = {
      ...base,
      key: targetKey,
      label,
      description: variantForm.description.trim(),
      variantType: variantForm.variantType,
      coverageScenes,
    };
    const idx = costumes.findIndex((c) => c.key === targetKey);
    const next = idx >= 0 ? costumes.map((c, i) => (i === idx ? { ...c, ...merged } : c)) : [...costumes, merged];
    setVariantBusy((prev) => new Set(prev).add(targetKey));
    try {
      await patchCostumes(next);
      setEditingVariantKey(undefined);
      onRefresh?.();
    } catch {
      // api helper 已 toast 错误
    } finally {
      setVariantBusy((prev) => { const n = new Set(prev); n.delete(targetKey); return n; });
    }
  };
  /** 需求8：删除变体（default 基准不允许删） */
  const deleteVariant = async (vk: string) => {
    if (vk === "default") return;
    const costumes = (Array.isArray(asset.costumes) ? asset.costumes : []) as Array<Record<string, unknown>>;
    const next = costumes.filter((c) => c.key !== vk);
    setVariantBusy((prev) => new Set(prev).add(vk));
    try {
      await patchCostumes(next);
      setEditingVariantKey(undefined);
      onRefresh?.();
    } catch {
      // api helper 已 toast 错误
    } finally {
      setVariantBusy((prev) => { const n = new Set(prev); n.delete(vk); return n; });
    }
  };

  const isConfirmed =
    asset.isConfirmed || (asset.metadata as Record<string, unknown> | null)?.confirmed === true;
  const hasImage = !!asset.imageUrl;
  const kind = asset.kind;
  const assetMetadata = asset.metadata && typeof asset.metadata === "object" && !Array.isArray(asset.metadata)
    ? asset.metadata as Record<string, unknown>
    : {};
  const cachedPencilUrl = asset.pencilImageUrl
    ?? (typeof assetMetadata.pencilPaintingUrl === "string" ? assetMetadata.pencilPaintingUrl : null);
  const hasPencilCache = typeof cachedPencilUrl === "string" && cachedPencilUrl.length > 0;
  // PROP「怕变形·需独立参考图」：该场景有站位图时，普通道具已烘焙进站位图被省略；
  // 勾选后此道具仍单独作为参考图（关键/易变形道具）。读 metadata.standaloneReference。
  const standaloneProp = asset.metadata?.standaloneReference === true;
  const suggestedVoices = readAssetVoiceOptions(assetMetadata.suggested_voices);
  const selectedVoices = readAssetVoiceOptions(assetMetadata.selected_voices);
  const confirmedFromMetadata = readAssetVoiceOptions(
    assetMetadata.confirmed_voice ? [assetMetadata.confirmed_voice] : [],
  )[0];
  const confirmedVoice = confirmedFromMetadata ?? (asset.voiceId
    ? { file: asset.voiceId, desc: asset.voiceTrait || "", gender: "", source: asset.voiceSource || undefined }
    : undefined);

  React.useEffect(() => () => {
    voiceAudioRef.current?.pause();
    voiceAudioRef.current = null;
  }, []);

  const playVoice = async (file: string) => {
    if (playingVoice === file) {
      voiceAudioRef.current?.pause();
      voiceAudioRef.current = null;
      setPlayingVoice(null);
      return;
    }
    voiceAudioRef.current?.pause();
    const sf = window.sfShell;
    if (!sf?.readPresetVoice) {
      toast.error("桌面客户端音色试听能力未加载，请使用桌面客户端。");
      return;
    }
    setPlayingVoice(file);
    const result = await sf.readPresetVoice(file);
    if (!result?.ok || typeof result.dataUrl !== "string") {
      setPlayingVoice(null);
      toast.error("音色试听加载失败");
      return;
    }
    const audio = new Audio(result.dataUrl);
    voiceAudioRef.current = audio;
    audio.onended = () => setPlayingVoice(null);
    audio.onerror = () => setPlayingVoice(null);
    await audio.play().catch(() => setPlayingVoice(null));
  };

  const updateVoiceMetadata = async (
    metadataPatch: Record<string, unknown>,
    fieldPatch: Record<string, unknown> = {},
  ) => {
    const result = await onUpdate(asset.id, {
      metadata: { ...assetMetadata, ...metadataPatch },
      ...fieldPatch,
    });
    if (result) onRefresh?.();
    return result;
  };

  const assignVoice = async (voice: AssetVoiceOption) => {
    if (selectedVoices.some((item) => item.file === voice.file)) {
      toast.info("该音色已添加到此角色");
      return;
    }
    const next = [...selectedVoices, { ...voice, source: "user" }];
    if (await updateVoiceMetadata({ selected_voices: next })) {
      toast.success(`已添加候选音色：${voice.desc || voice.file}`);
    }
  };

  const removeVoice = async (file: string) => {
    const removingConfirmed = confirmedVoice?.file === file;
    const next = selectedVoices.filter((voice) => voice.file !== file);
    if (await updateVoiceMetadata(
      { selected_voices: next, ...(removingConfirmed ? { confirmed_voice: null } : {}) },
      removingConfirmed ? { voiceId: null, voiceSource: null, voiceTrait: null } : {},
    )) toast.success("已移除音色");
  };

  const selectVoice = async (voice: AssetVoiceOption) => {
    const next = selectedVoices.some((item) => item.file === voice.file)
      ? selectedVoices
      : [...selectedVoices, { ...voice, source: "user" }];
    if (await updateVoiceMetadata(
      { selected_voices: next, confirmed_voice: voice },
      { voiceId: voice.file, voiceSource: "library", voiceTrait: voice.desc || null },
    )) toast.success(`已选定音色：${voice.desc || voice.file}`);
  };

  const deselectVoice = async () => {
    if (await updateVoiceMetadata(
      { confirmed_voice: null },
      { voiceId: null, voiceSource: null, voiceTrait: null },
    )) toast.success("已取消选定");
  };
  // OP3 必修：直接用 asset.imageUrl（sf-asset://），无 proxyImageUrl 代理
  // （app1 用 /api/.../image?v= 代理 route，dramaforge 无此 route 会 404）
  const imgSrc = hasImage ? asset.imageUrl : "";
  const identityLocks: string[] = asset.identityLock || [];

  /** 保存名称、描述与富字段；名称由后端统一 rename Interface 级联到五大流程。 */
  const handleSaveDesc = async () => {
    if (!name.trim()) {
      toast.error("资产名称不能为空");
      return;
    }
    const data: Record<string, unknown> = { name: name.trim(), description };
    if (kind === "CHARACTER" || kind === "ENTITY") {
      if (kind === "CHARACTER") data.background = background;
      data.voiceTrait = voiceTrait;
      // 将顿号/逗号/换行分隔的文本解析为数组
      data.identityLock = identityLockDraft
        .split(/[、，,\n]+/)
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
    const d = await onUpdate(asset.id, data);
    if (d) {
      toast.success("已更新");
      setEditing(false);
    }
  };

  /** 每次打开都重新读取，确保连续重绘后看到的是服务端已提交的完整版本链。 */
  const openImageHistory = async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(asset.id)}/images`,
      );
      const envelope = (await response.json()) as {
        success?: boolean;
        data?: AssetImageRevisionView[];
        error?: string;
      };
      if (!response.ok || !envelope.success) throw new Error(envelope.error || "读取图片历史失败");
      setImageRevisions(envelope.data ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取图片历史失败");
    } finally {
      setHistoryLoading(false);
    }
  };

  /** B5：把一条历史版本重新设为当前主图。 */
  const activateRevision = async (revisionId: string) => {
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(asset.id)}/images/${encodeURIComponent(revisionId)}/activate`,
        { method: "POST" },
      );
      const envelope = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!response.ok || !envelope.success) throw new Error(envelope.error || "重新应用失败");
      toast.success("已重新应用该版本");
      setHistoryOpen(false);
      onRefresh?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重新应用失败");
    }
  };

  /** B5：下载历史图片到用户选定位（sf-asset:// 不能用 <a download>）。 */
  const downloadRevision = async (localUrl: string | null) => {
    const sf = window.sfShell;
    if (!sf || typeof sf.saveAsset !== "function") {
      toast.info("下载仅桌面端可用");
      return;
    }
    if (!localUrl) {
      toast.error("该版本无本地图，无法下载");
      return;
    }
    const localKey = localUrl.replace(/^sf-asset:\/\//, "");
    const result = await sf.saveAsset(localKey, asset.name);
    if (result.ok) {
      toast.success("已下载");
    } else if (result.error?.code !== "USER_CANCELLED") {
      toast.error(result.error?.message || "下载失败");
    }
  };

  return (
    <div
      className={`card card-hover p-0 overflow-hidden flex flex-col ${isConfirmed ? "ring-1 ring-[var(--success)]/30" : ""}`}
    >
      {/* 图片区域 — 16:9 横向宽高比（角色/物品/环境 AI 生成图多为横向） */}
      <div className="relative w-full aspect-video bg-[var(--bg-hover)] border-b border-[var(--border-light)] flex items-center justify-center overflow-hidden group min-h-[200px]">
        {hasImage && imgSrc ? (
          <>
            {/* 图片本身可点击放大（onZoom 存在时启用，cursor-zoom-in 提示可交互） */}
            {onZoom ? (
              <button
                onClick={() => onZoom(asset.id)}
                className="contents"
                aria-label={`放大查看 ${asset.name}`}
                title="点击放大查看"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imgSrc}
                  alt={asset.name}
                  className={`w-full h-full object-contain bg-[#0a0a0f] cursor-zoom-in ${
                    imgErrors.has(asset.id) ? "opacity-30" : ""
                  }`}
                  onError={() => {
                    setImgErrors((prev) => {
                      const n = new Set(prev);
                      n.add(asset.id);
                      return n;
                    });
                  }}
                />
              </button>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imgSrc}
                alt={asset.name}
                className={`w-full h-full object-contain bg-[#0a0a0f] ${
                  imgErrors.has(asset.id) ? "opacity-30" : ""
                }`}
                onError={() => {
                  setImgErrors((prev) => {
                    const n = new Set(prev);
                    n.add(asset.id);
                    return n;
                  });
                }}
              />
            )}
            {/* hover 遮罩 + 查看大图 */}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 pointer-events-none">
              {onZoom && (
                <button
                  onClick={() => onZoom(asset.id)}
                  className="btn-ghost px-3 py-1.5 rounded-lg text-xs backdrop-blur-sm pointer-events-auto inline-flex items-center gap-1"
                  title="放大查看"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  查看大图
                </button>
              )}
              {onUpload && (
                <button
                  onClick={triggerUpload}
                  className="btn-ghost px-3 py-1.5 rounded-lg text-xs backdrop-blur-sm pointer-events-auto inline-flex items-center gap-1"
                  title="上传/替换图片"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  换图
                </button>
              )}
            </div>
            {/* 生成中 pulse 覆盖 */}
            {isGenerating && (
              <div className="absolute inset-x-0 bottom-0 bg-black/75 backdrop-blur-sm px-3 py-2">
                <ImageGenerationProgress taskId={taskId} label="重新生成图片中" />
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 text-[var(--text-3)]">
            {isGenerating ? (
              <div className="w-full px-4 py-3 space-y-1.5">
                <ImageGenerationProgress taskId={taskId} />
              </div>
            ) : (
              <>
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  className="opacity-30"
                  aria-hidden="true"
                >
                  <path
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="text-xs">暂未生成</span>
                {onUpload && (
                  <button
                    onClick={triggerUpload}
                    className="btn-ghost px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1"
                    title="上传本地图片"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    上传图片
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {/* 批2b：隐藏的图片上传 input（triggerUpload 触发 click） */}
        {onUpload && (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={onFileChange}
          />
        )}
        {/* 确认标记 + 锁定标记（并排显示在右上角） */}
        {(isConfirmed || regenLocked) && (
          <div className="absolute top-2 right-2 flex items-center gap-1">
            {isConfirmed && (
              <span className="px-2 py-0.5 rounded-md bg-[var(--success)]/90 text-[#0a0a0f] text-[10px] font-bold flex items-center gap-1 shadow-sm">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3 8l3.5 3.5L13 5"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                已确认
              </span>
            )}
            {regenLocked && (
              <span
                className="px-2 py-0.5 rounded-md bg-[var(--warning)]/90 text-[#0a0a0f] text-[10px] font-bold flex items-center gap-1 shadow-sm"
                title="资产已锁定，AI 无法重新生图"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M6 10V8a6 6 0 1112 0v2M5 10h14v10H5V10z"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                已锁定
              </span>
            )}
          </div>
        )}
        {/* 类型标记 */}
        <span
          className={`absolute top-2 left-2 px-2 py-0.5 rounded-md text-[10px] font-medium ${KIND_BADGE_COLORS[kind] || "bg-[var(--bg-hover)] text-[var(--text-3)]"}`}
        >
          {KIND_LABELS[kind] || kind}
        </span>
        {/* 图片加载失败提示（landAssetImage PATCH 失败 / sf-asset:// 显示不了） */}
        {hasImage && imgErrors.has(asset.id) && (
          <div className="absolute bottom-2 left-2 right-2 p-2 rounded border border-[var(--error)]/30 bg-[var(--error-dim)] text-[10px] text-[var(--error)]">
            <div className="font-semibold mb-0.5">⚠ 图片加载失败（客户端显示不了）</div>
            <div className="font-mono break-all opacity-80">
              {(imgSrc || "").slice(0, 80)}
              {(imgSrc || "").length > 80 ? "…" : ""}
            </div>
          </div>
        )}
      </div>

      {/* 内容区域 */}
      <div className="p-3 sm:p-4 flex-1 flex flex-col">
        {/* 标题行 */}
        <div className="flex items-center gap-2 mb-2">
          <h3 className="font-semibold text-[var(--text)] text-sm">{asset.name}</h3>
          {asset.assetType && (
            <span className="badge badge-accent text-[10px]">{asset.assetType}</span>
          )}
        </div>

        {editing ? (
          <div className="space-y-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-base w-full px-3 py-2 rounded-lg text-xs"
              maxLength={100}
              placeholder="资产名称"
            />
            <div className="relative">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="input-base w-full px-3 py-2 rounded-lg text-xs resize-none"
                rows={3}
                maxLength={500}
                placeholder={`${KIND_LABELS[kind] || ""}描述...`}
              />
              <span className="absolute bottom-1.5 right-2 text-[10px] text-[var(--text-3)] tabular-nums pointer-events-none">
                {description.length}/500
              </span>
            </div>
            {(kind === "CHARACTER" || kind === "ENTITY") && (
              <>
                {kind === "CHARACTER" && (
                  <textarea
                    value={background}
                    onChange={(e) => setBackground(e.target.value)}
                    className="input-base w-full px-3 py-2 rounded-lg text-xs resize-none"
                    rows={2}
                    placeholder="角色背景故事..."
                  />
                )}
                <input
                  value={voiceTrait}
                  onChange={(e) => setVoiceTrait(e.target.value)}
                  className="input-base w-full px-3 py-2 rounded-lg text-xs"
                  placeholder="音色特征，如：年轻清脆，带有嘶吼、哭腔感"
                />
                <div>
                  <input
                    value={identityLockDraft}
                    onChange={(e) => setIdentityLockDraft(e.target.value)}
                    className="input-base w-full px-3 py-2 rounded-lg text-xs"
                    placeholder="视觉锁定特征，用顿号分隔，如：深蓝色西装、红色胸花、方正脸型"
                  />
                  <p className="text-[10px] text-[var(--text-3)] mt-1">
                    用顿号（、）或逗号分隔多个特征标签
                  </p>
                </div>
              </>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setEditing(false)}
                className="btn-ghost px-3 py-1.5 rounded-lg text-xs"
              >
                取消
              </button>
              <button
                onClick={() => void handleSaveDesc()}
                className="btn-primary px-3 py-1.5 rounded-lg text-xs"
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* 描述 + 编辑按钮 */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-[var(--text-3)] font-medium uppercase tracking-wide">
                  描述
                </span>
                <div className="flex items-center gap-2">
                  {description && (
                    <span className="text-[10px] text-[var(--text-3)] tabular-nums">
                      {description.length} 字
                    </span>
                  )}
                  {!isReview && (
                    <button
                      onClick={() => setEditing(true)}
                      className="text-[var(--action)] text-xs hover:text-[var(--action-hover)] inline-flex items-center gap-0.5"
                    >
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path
                          d="M11 2l3 3-9 9H2v-3l9-9z"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      编辑
                    </button>
                  )}
                </div>
              </div>
              <p className="text-xs text-[var(--text-2)] leading-relaxed max-h-[80px] overflow-y-auto break-words whitespace-pre-wrap">
                {description || "暂无描述"}
              </p>
            </div>

            {/* A11c 富字段标签（CHARACTER identityLock/voiceTrait · PROP significance · LOCATION intExt/mood） */}
            <div className="flex flex-wrap gap-1.5 mb-3">
              {(kind === "CHARACTER" || kind === "ENTITY") && identityLocks.length > 0 && identityLocks.map((lock, i) => (
                <span
                  key={i}
                  className="px-1.5 py-0.5 rounded bg-[var(--accent-dim)] text-[var(--accent)] text-[10px] font-medium"
                >
                  {lock}
                </span>
              ))}
              {(kind === "CHARACTER" || kind === "ENTITY") && asset.voiceTrait && (
                <span
                  title={asset.voiceTrait}
                  className="px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-3)] text-[10px] border border-[var(--border-light)]"
                >
                  🎤 {asset.voiceTrait.length > 20 ? asset.voiceTrait.slice(0, 20) + "..." : asset.voiceTrait}
                </span>
              )}
              {kind === "PROP" && asset.significance && (
                <span className="px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-3)] text-[10px] border border-[var(--border-light)]">
                  📌 {asset.significance}
                </span>
              )}
              {kind === "LOCATION" && asset.intExt && (
                <span className="px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-3)] text-[10px] border border-[var(--border-light)]">
                  {asset.intExt === "INT" ? "🏠 室内" : asset.intExt === "EXT" ? "🌳 室外" : asset.intExt}
                </span>
              )}
              {kind === "LOCATION" && asset.mood && (
                <span className="px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-3)] text-[10px] border border-[var(--border-light)]">
                  🎭 {asset.mood}
                </span>
              )}
            </div>

            {/* A11d 变体 costumes：CHARACTER 造型变体(extraction 预填) + PROP/LOCATION 状态/时段变体(手动 MVP，dramaforge 独建) */}
            {(kind === "CHARACTER" || kind === "PROP" || kind === "LOCATION") && !isReview && (() => {
              const costumes = Array.isArray(asset.costumes)
                ? (asset.costumes as Array<Record<string, unknown>>).filter((c) => c && typeof c === "object")
                : [];
              const variantKindLabel = kind === "PROP" ? "状态" : kind === "LOCATION" ? "时段/状态" : "造型";
              // CHARACTER 由 extraction 预填 costumes；PROP/LOCATION 无预填，空时也要露出"+ 新增"入口。
              if (costumes.length === 0 && kind === "CHARACTER") return null;
              return (
                <div className="mb-3 pt-3 border-t border-[var(--border-light)]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-[var(--text-2)]">👗 {variantKindLabel}变体（{costumes.length}）</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-[var(--text-3)]">基准可上传或 AI 生成；变体基于基准生图</span>
                      <button
                        type="button"
                        onClick={openAddVariant}
                        className="text-[10px] text-[var(--action)] hover:text-[var(--action-hover)]"
                        title={`手动新增${variantKindLabel}变体`}
                      >
                        + 新增
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {costumes.map((cv) => {
                      const vk = (cv.key as string) || "default";
                      const label = (cv.label as string) || vk;
                      const busy = variantBusy.has(vk) || !!isVariantGenerating?.(asset.id, vk);
                      const variantTaskId = getVariantTaskId?.(asset.id, vk);
                      const cvImg = (cv.imageUrl as string | null) || (vk === "default" ? asset.imageUrl : null);
                      return (
                        <div key={vk} className="flex items-center gap-2 p-2 rounded-lg bg-[var(--bg-hover)]/50">
                          {cvImg ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={cvImg}
                              alt={label}
                              onClick={() => onZoom?.(`${asset.id}__${vk}`)}
                              className="w-14 h-14 rounded-lg object-cover border border-[var(--border-light)] flex-shrink-0 cursor-pointer hover:border-[var(--action)] transition-colors"
                            />
                          ) : (
                            <div className="w-14 h-14 rounded-lg border border-dashed border-[var(--border-light)] flex items-center justify-center flex-shrink-0">
                              <span className="text-[9px] text-[var(--text-3)]">未生图</span>
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className={`text-[11px] truncate ${vk === "default" ? "font-bold text-[var(--text-1)]" : "text-[var(--text-2)]"}`}>
                              {label}{vk === "default" ? "（基准）" : ""}{cv.variantType === "period" ? " · 时段" : ""}
                            </div>
                            <div className="mt-1 flex items-center gap-2 flex-wrap">
                              <button
                                onClick={() => void handleVariantGenerate(vk)}
                                disabled={busy}
                                className="text-[10px] text-[var(--action)] hover:text-[var(--action-hover)] disabled:opacity-40 inline-flex items-center gap-0.5"
                                title={vk === "default" ? "AI 生成基准造型" : "基于基准图生图"}
                              >
                                {busy ? (
                                  <>
                                    <Spinner size={10} label="正在生成图片" className="text-[var(--action)]" />
                                    生成中
                                  </>
                                ) : (
                                  <>{cvImg ? "重新生成" : "生成图片"}</>
                                )}
                              </button>
                              <label
                                className="text-[10px] text-[var(--text-3)] hover:text-[var(--text-2)] cursor-pointer inline-flex items-center gap-0.5"
                                title="上传本地图片"
                              >
                                {cvImg ? "替换图片" : "上传图片"}
                                <input
                                  type="file"
                                  accept="image/png,image/jpeg,image/webp"
                                  className="hidden"
                                  onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    e.target.value = "";
                                    if (f) void handleVariantUpload(vk, f);
                                  }}
                                />
                              </label>
                              <button
                                type="button"
                                onClick={() => openEditVariant(cv)}
                                className="text-[10px] text-[var(--text-3)] hover:text-[var(--text-2)]"
                                title="编辑变体名称 / 描述 / 类型"
                              >
                                编辑
                              </button>
                              {vk !== "default" && (
                                <button
                                  type="button"
                                  onClick={() => void deleteVariant(vk)}
                                  className="text-[10px] text-[var(--text-3)] hover:text-red-500"
                                  title="删除该变体"
                                >
                                  删除
                                </button>
                              )}
                            </div>
                            {busy && variantTaskId && (
                              <div className="mt-2">
                                <GenerationProgress
                                  taskId={variantTaskId}
                                  label={cvImg ? "重新生成中" : "生成中"}
                                  compact
                                  estimatedDuration={60}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {editingVariantKey !== undefined && (
                    <div className="mt-2 p-2 rounded-lg border border-[var(--border-light)] bg-[var(--bg-hover)]/30 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <input
                          value={variantForm.label}
                          onChange={(e) => setVariantForm((f) => ({ ...f, label: e.target.value }))}
                          placeholder="变体名称（如 小时候 / 正装）"
                          className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded border border-[var(--border-light)] bg-transparent outline-none"
                        />
                        {kind === "CHARACTER" && (
                        <select
                          value={variantForm.variantType}
                          onChange={(e) => setVariantForm((f) => ({ ...f, variantType: e.target.value as "costume" | "period" }))}
                          className="text-[11px] px-1 py-1 rounded border border-[var(--border-light)] bg-transparent outline-none"
                        >
                          <option value="costume">换装</option>
                          <option value="period">时段</option>
                        </select>
                        )}
                      </div>
                      <textarea
                        value={variantForm.description}
                        onChange={(e) => setVariantForm((f) => ({ ...f, description: e.target.value }))}
                        placeholder={
                          kind === "PROP" ? "状态描述（如 剑拔出挥砍 / 门半开 / 信封已拆）"
                          : kind === "LOCATION" ? "时段或状态描述（如 深夜火把照明 / 战后破损）"
                          : (variantForm.variantType === "period" ? "该时段外貌（年龄 / 身材 / 五官如何演变）" : "服装描述（上衣 / 裤子 / 鞋子 / 材质 / 颜色）")
                        }
                        rows={2}
                        className="w-full text-[11px] px-2 py-1 rounded border border-[var(--border-light)] bg-transparent outline-none resize-none"
                      />
                      {/* 批7 coverageScenes：自由文本逗号分隔场景号（如 S1, S3）。
                          该组件无 scenes prop 且资产设定在分镜生成之前（场景号未定义），
                          故用自由文本让自动匹配立即可用；无数据时优雅回退默认。
                          AI 自动生成 coverageScenes 不做（后续增强，更贴 app1）。 */}
                      <input
                        value={variantForm.coverageScenes}
                        onChange={(e) => setVariantForm((f) => ({ ...f, coverageScenes: e.target.value }))}
                        placeholder="出现场景号，逗号分隔（如 S1, S3）— 留空则仅手动选用"
                        className="w-full text-[11px] px-2 py-1 rounded border border-[var(--border-light)] bg-transparent outline-none"
                      />
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => void saveVariant()}
                          className="text-[10px] px-2 py-0.5 rounded bg-[var(--action)] text-white hover:opacity-90"
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingVariantKey(undefined)}
                          className="text-[10px] text-[var(--text-3)] hover:text-[var(--text-2)]"
                        >
                          取消
                        </button>
                        {variantForm.variantType === "period" && (
                          <span className="text-[9px] text-[var(--text-3)]">时段变体允许年龄 / 身材随时段自然变化</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* 人类角色和非人发声体共用音色库；绑定字段 voiceId/voiceSource/voiceTrait
                通过同一资产 PATCH Interface 保存，避免 ENTITY 另造一套状态模型。
                wav 试听走 sfShell.readPresetVoice(file) 本地读，server 零音频字节。
                浏览器/dev 无 sfShell → VoiceBrowserModal 内 toast 提示用桌面客户端。） */}
            {(kind === "CHARACTER" || kind === "ENTITY") && !isReview && (
              <div className="mb-3 pt-3 border-t border-[var(--border-light)]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-[var(--text-2)]">
                    🎤 {kind === "ENTITY" ? "实体音色" : "角色音色"}
                  </span>
                  <button
                    onClick={() => setVoiceBrowserOpen(true)}
                    className="text-[10px] text-[var(--action)] hover:text-[var(--action-hover)] inline-flex items-center gap-0.5"
                    title="浏览预设音色库"
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M8 2v12M2 8h12"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                    {selectedVoices.length ? "继续添加" : "浏览音色库"}
                  </button>
                </div>
                <VoiceSelector
                  suggestedVoices={suggestedVoices}
                  selectedVoices={selectedVoices}
                  confirmedVoice={confirmedVoice}
                  playingVoice={playingVoice}
                  onPlay={(file) => void playVoice(file)}
                  onRemove={(file) => void removeVoice(file)}
                  onSelect={(voice) => void selectVoice(voice)}
                  onDeselect={() => void deselectVoice()}
                />
              </div>
            )}
            {voiceBrowserOpen && (kind === "CHARACTER" || kind === "ENTITY") && (
              <VoiceBrowserModal
                existingFiles={selectedVoices.map((voice) => voice.file)}
                suggestedVoices={suggestedVoices}
                onClose={() => setVoiceBrowserOpen(false)}
                onAssign={async (file, desc, gender) =>
                  assignVoice({ file, desc, gender, source: "user" })
                }
                toast={toast}
              />
            )}
          </>
        )}

        {/* 操作按钮 - 分组布局：开关组（第一行）+ 操作组（第二行） */}
        <div className="mt-auto pt-3 space-y-2">
          {/* 开关组：锁定开关 + 网格/铅笔开关（网格/铅笔对角色图最有意义，限定 CHARACTER） */}
          <div className="flex gap-2 items-center flex-wrap">
            {!isReview && onLockToggle && (
              <label
                className={`flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-hover)]/50 ${regenLocked ? "ring-1 ring-[var(--warning)]/40" : ""}`}
                title={
                  regenLocked
                    ? "已锁定：AI 无法重新生成此资产。点击解锁"
                    : "未锁定：可 AI 重新生成。点击锁定以保护当前设计图"
                }
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!regenLocked}
                  onClick={() => onLockToggle(asset.id, !regenLocked)}
                  className={`relative w-7 h-4 rounded-full transition-colors ${regenLocked ? "bg-[var(--warning)]" : "bg-[var(--border-light)]"}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${regenLocked ? "translate-x-3" : ""}`}
                  />
                </button>
                <span className="text-[10px] text-[var(--text-2)] flex items-center gap-0.5">
                  {regenLocked ? (
                    <>
                      <svg
                        width="9"
                        height="9"
                        viewBox="0 0 24 24"
                        fill="none"
                        className="text-[var(--warning)]"
                        aria-hidden="true"
                      >
                        <path
                          d="M6 10V8a6 6 0 1112 0v2M5 10h14v10H5V10z"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      锁定
                    </>
                  ) : (
                    "未锁"
                  )}
                </span>
              </label>
            )}
            {/* 人物参考图强制使用 app1 稀疏网格；UI 不再提供会被后端忽略的关闭开关。 */}
            {!isReview && kind === "CHARACTER" && (
              <label
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-hover)]/50 ring-1 ring-[var(--action)]/40"
                title="人物参考图生成视频前强制叠加 app1 稀疏网格"
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked="true"
                  disabled
                  className="relative w-7 h-4 rounded-full bg-[var(--action)] cursor-not-allowed"
                >
                  <span
                    className="absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white translate-x-3"
                  />
                </button>
                <span className="text-[10px] text-[var(--text-2)]">稀疏网格·必开</span>
              </label>
            )}
            {/* 批5/批6：铅笔开关（CHARACTER only， PATCH 白名单已含 pencilPaintEnabled） */}
            {!isReview && kind === "CHARACTER" && (
              <label
                className={`flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-hover)]/50 ${asset.pencilPaintEnabled && hasPencilCache ? "ring-1 ring-[var(--action)]/40" : ""} ${hasPencilCache ? "" : "opacity-50 cursor-not-allowed"}`}
                title={hasPencilCache
                  ? "使用已持久化的彩铅参考图，并在视频阶段还原写实风格"
                  : "尚无彩铅参考图缓存；客户端转换协议未部署，暂不可开启"}
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!asset.pencilPaintEnabled && hasPencilCache}
                  disabled={!hasPencilCache}
                  onClick={() => {
                    if (hasPencilCache) void onUpdate(asset.id, { pencilPaintEnabled: !asset.pencilPaintEnabled });
                  }}
                  className={`relative w-7 h-4 rounded-full transition-colors ${asset.pencilPaintEnabled && hasPencilCache ? "bg-[var(--action)]" : "bg-[var(--border-light)]"} disabled:cursor-not-allowed`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${asset.pencilPaintEnabled && hasPencilCache ? "translate-x-3" : ""}`}
                  />
                </button>
                <span className="text-[10px] text-[var(--text-2)]">彩铅缓存</span>
              </label>
            )}
            {/* PROP「怕变形·需独立参考图」开关：该场景有站位图时普通道具已烘焙进站位图，
                勾选后此道具仍单独作为参考图（关键/易变形道具）。写 metadata.standaloneReference。 */}
            {!isReview && kind === "PROP" && (
              <label
                className={`flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-hover)]/50 ${standaloneProp ? "ring-1 ring-[var(--action)]/40" : ""}`}
                title="该场景有站位图时，普通道具已并入站位图；勾选后此道具仍单独作为参考图（关键/怕变形道具）"
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={standaloneProp}
                  onClick={() => {
                    void onUpdate(asset.id, {
                      metadata: { ...(asset.metadata ?? {}), standaloneReference: !standaloneProp },
                    });
                  }}
                  className={`relative w-7 h-4 rounded-full transition-colors ${standaloneProp ? "bg-[var(--action)]" : "bg-[var(--border-light)]"}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${standaloneProp ? "translate-x-3" : ""}`}
                  />
                </button>
                <span className="text-[10px] text-[var(--text-2)]">独立参考·怕变形</span>
              </label>
            )}
          </div>

          {/* 操作组：分辨率/模型 + 生成/确认/删除 */}
          <div className="flex gap-2 items-center flex-wrap">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-3)]">分辨率:</span>
              <div className="relative">
                <select
                  value={resolution}
                  onChange={(e) => onResolutionChange(e.target.value)}
                  className="input-base px-2 py-1 pr-6 rounded text-[10px] appearance-none cursor-pointer"
                >
                  {ASSET_RESOLUTIONS.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.key}
                    </option>
                  ))}
                </select>
                <svg
                  className="absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none"
                  width="8"
                  height="8"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M4 6l4 4 4-4"
                    stroke="var(--text-3)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>
            <ModelSelector
              models={IMAGE_MODELS}
              value={imageModel}
              onChange={onImageModelChange}
              label="模型"
            />
            <button
              type="button"
              onClick={() => void openImageHistory()}
              className="btn-ghost px-3 py-1.5 rounded-lg text-xs"
              title="查看所有生成和上传版本"
            >
              图片历史
            </button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onGenerateImage(asset.id, undefined, imageModel)}
              loading={isGenerating}
              title={regenLocked ? "资产已锁定，点击将被拦截，请先解锁" : hasImage ? "重新生成设计图" : "生成设计图"}
            >
              {isGenerating ? "生成中" : (
                <>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M8 2v12M2 8h12"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                  {hasImage ? "重新生成" : "生成图片"}
                  {regenLocked ? " 🔒" : ""}
                </>
              )}
            </Button>
            {!isConfirmed ? (
              !isReview ? (
                <button
                  onClick={() => onConfirm(asset.id)}
                  className="btn-ghost px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M3 8l3.5 3.5L13 5"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  确认
                </button>
              ) : (
                <span className="text-xs text-[var(--text-3)] flex items-center gap-1 px-3 py-1.5">
                  未确认
                </span>
              )
            ) : (
              <span className="text-xs text-[var(--success)] flex items-center gap-1 px-3 py-1.5 font-medium">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3 8l3.5 3.5L13 5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                已确认
              </span>
            )}
            {!isReview && onDelete && (
              <button
                onClick={onDelete}
                className="ml-auto p-1.5 rounded-lg text-[var(--text-3)] hover:text-[var(--error)] hover:bg-[var(--error)]/10 transition-colors"
                title="删除资产"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      {historyOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setHistoryOpen(false)}
        >
          <div
            className="w-full max-w-4xl max-h-[80vh] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-[var(--text)]">{asset.name} · 图片历史</h3>
                <p className="text-xs text-[var(--text-3)] mt-1">重绘不会覆盖旧版本；编号越大越新。</p>
              </div>
              <button type="button" className="btn-ghost px-3 py-1.5 rounded-lg text-xs" onClick={() => setHistoryOpen(false)}>
                关闭
              </button>
            </div>
            {historyLoading ? (
              <div className="py-12 flex justify-center"><Spinner size={24} /></div>
            ) : imageRevisions.length === 0 ? (
              <p className="py-12 text-center text-sm text-[var(--text-3)]">暂无图片版本</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {imageRevisions.map((revision) => (
                  <div key={revision.id} className="rounded-lg border border-[var(--border-light)] overflow-hidden bg-[var(--bg-hover)]/40">
                    {revision.localUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={revision.localUrl} alt={`第 ${revision.generationOrdinal} 版`} className="w-full aspect-square object-contain bg-black/40" />
                    ) : (
                      <div className="w-full aspect-square flex items-center justify-center text-xs text-[var(--text-3)]">
                        {revision.status === "FAILED" ? "生成失败" : "尚未提交到本地"}
                      </div>
                    )}
                    <div className="p-2 text-[10px] text-[var(--text-3)] space-y-1">
                      <div className="flex justify-between gap-2">
                        <span>第 {revision.generationOrdinal} 版 · {revision.source === "AI" ? "AI" : "上传"}</span>
                        <span>{revision.status}</span>
                      </div>
                      {revision.modelName && <div className="truncate">{revision.modelName}</div>}
                      {revision.error && <div className="text-[var(--error)] line-clamp-2">{revision.error}</div>}
                      {revision.status === "COMMITTED" && revision.localUrl && (
                        <div className="flex gap-1 pt-1">
                          <button
                            type="button"
                            className="px-1.5 py-0.5 rounded bg-[var(--action)]/10 text-[var(--action)] hover:bg-[var(--action)]/20 text-[9px]"
                            onClick={() => void activateRevision(revision.id)}
                            title="把这个历史版本重新设为当前主图"
                          >
                            重新应用
                          </button>
                          <button
                            type="button"
                            className="px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-3)] hover:text-[var(--text-1)] text-[9px]"
                            onClick={() => void downloadRevision(revision.localUrl)}
                            title="下载该版本图片"
                          >
                            下载
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface VoiceSelectorProps {
  suggestedVoices: AssetVoiceOption[];
  selectedVoices: AssetVoiceOption[];
  confirmedVoice?: AssetVoiceOption;
  playingVoice: string | null;
  onPlay: (file: string) => void;
  onRemove: (file: string) => void;
  onSelect: (voice: AssetVoiceOption) => void;
  onDeselect: () => void;
}

/**
 * 与 app1 一致的三层音色语义：AI 推荐、用户候选、最终选定相互独立。
 * 顶层 voiceId 只作为已选定音色的兼容镜像，不再等同于候选列表。
 */
function VoiceSelector({
  suggestedVoices,
  selectedVoices,
  confirmedVoice,
  playingVoice,
  onPlay,
  onRemove,
  onSelect,
  onDeselect,
}: VoiceSelectorProps) {
  const selectedFiles = new Set(selectedVoices.map((voice) => voice.file));
  const voices = Array.from(
    [...suggestedVoices.map((voice) => ({ ...voice, source: voice.source || "ai" })), ...selectedVoices]
      .reduce((map, voice) => map.set(voice.file, { ...map.get(voice.file), ...voice }), new Map<string, AssetVoiceOption>()),
  ).map(([, voice]) => voice);

  if (voices.length === 0 && !confirmedVoice) {
    return (
      <p className="text-[10px] text-[var(--text-3)] py-1">
        暂无候选音色，点击上方「浏览音色库」添加
      </p>
    );
  }

  const visibleVoices = confirmedVoice && !voices.some((voice) => voice.file === confirmedVoice.file)
    ? [confirmedVoice, ...voices]
    : voices;

  return (
    <div className="space-y-1.5">
      {visibleVoices.map((voice) => {
        const isConfirmed = confirmedVoice?.file === voice.file;
        const isSelected = selectedFiles.has(voice.file);
        const isPlaying = playingVoice === voice.file;
        return (
          <div
            key={voice.file}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border ${
              isConfirmed
                ? "border-[var(--success)] bg-[var(--success)]/8 ring-1 ring-[var(--success)]/20"
                : "border-[var(--border-light)] bg-[var(--bg-hover)]/40"
            }`}
          >
            <button
              type="button"
              onClick={() => onPlay(voice.file)}
              className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                isPlaying
                  ? "bg-[var(--action)] text-white"
                  : "bg-[var(--bg-hover)] text-[var(--text-3)] hover:text-[var(--text)]"
              }`}
              aria-label={isPlaying ? "暂停" : "试听"}
            >
              {isPlaying ? "Ⅱ" : "▶"}
            </button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-[11px] text-[var(--text-1)] truncate">
                  {voice.desc || voice.file}
                </span>
                {voice.gender && (
                  <span className="text-[9px] text-[var(--text-3)]">
                    {voice.gender === "female" ? "女声" : voice.gender === "male" ? "男声" : voice.gender}
                  </span>
                )}
                {voice.source === "ai" && (
                  <span className="px-1 py-0.5 rounded text-[9px] bg-[var(--accent-dim)] text-[var(--accent)]">
                    AI 推荐
                  </span>
                )}
              </div>
              <div className="text-[9px] text-[var(--text-3)] font-mono truncate">{voice.file}</div>
            </div>
            {isConfirmed ? (
              <button
                type="button"
                onClick={onDeselect}
                className="text-[10px] text-[var(--success)] hover:text-[var(--danger)] flex-shrink-0"
                title="取消最终选定"
              >
                已选定
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onSelect(voice)}
                className="text-[10px] text-[var(--action)] hover:text-[var(--action-hover)] flex-shrink-0"
              >
                选定
              </button>
            )}
            {isSelected && !isConfirmed && (
              <button
                type="button"
                onClick={() => onRemove(voice.file)}
                className="text-[var(--text-3)] hover:text-[var(--danger)] px-0.5 flex-shrink-0"
                aria-label="移除候选音色"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// CharacterEditorPanel — CHARACTER Tab 下右侧的纵向三容器编辑视图
// ============================================================

interface CharacterEditorPanelProps {
  asset: AssetRecord;
  projectId: string;
  onGenerateImage: (assetId: string, prompt?: string, model?: string, costumeKey?: string) => void;
  onUpdate: (assetId: string, data: Record<string, unknown>) => Promise<unknown>;
  onConfirm: (assetId: string) => void;
  onDelete?: () => void;
  isGenerating: boolean;
  taskId?: string;
  isVariantGenerating?: (assetId: string, costumeKey?: string) => boolean;
  getVariantTaskId?: (assetId: string, costumeKey?: string) => string | undefined;
  imgErrors: Set<string>;
  setImgErrors: React.Dispatch<React.SetStateAction<Set<string>>>;
  toast: ReturnType<typeof useToast>;
  isReview: boolean;
  imageModel: string;
  onImageModelChange: (model: string) => void;
  resolution: string;
  onResolutionChange: (res: string) => void;
  regenLocked: boolean | null;
  onLockToggle?: (assetId: string, locked: boolean) => void;
  onZoom?: (assetId: string) => void;
  /** 批2b/批5.5：用户上传本地图片（透传给 AssetCard）。 */
  onUpload?: (assetId: string, file: File, costumeKey?: string) => void;
  /** 批6 音色库：音色绑定 PATCH 后刷新 assets state（透传给 AssetCard）。 */
  onRefresh?: () => void;
  tabLabel?: string;
}

export function CharacterEditorPanel(props: CharacterEditorPanelProps) {
  const { asset, tabLabel = "资产" } = props;
  const isConfirmed =
    asset?.isConfirmed || (asset.metadata as Record<string, unknown> | null)?.confirmed === true;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[var(--bg-card)] border border-[var(--border-light)] rounded-xl overflow-hidden">
      {/* 标题栏 - 显示当前编辑的资产名 + 类型标签 + 状态标记 */}
      <div className="px-4 py-3 border-b border-[var(--border-light)] flex items-center justify-between flex-shrink-0 bg-[var(--bg-hover)]/30">
        <div className="flex items-center gap-3 min-w-0">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            className="text-[var(--action)] flex-shrink-0"
            aria-hidden="true"
          >
            <path
              d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 100-8 4 4 0 000 8z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <h3 className="text-sm font-semibold text-[var(--text)] truncate">
            {asset?.name || `未命名${tabLabel}`}
          </h3>
          <span className="px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-3)] text-[10px] border border-[var(--border-light)] flex-shrink-0">
            {tabLabel}
          </span>
          {isConfirmed && (
            <span className="px-1.5 py-0.5 rounded bg-[var(--success)]/15 text-[var(--success)] text-[10px] flex items-center gap-0.5 flex-shrink-0">
              <svg width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3 8l3.5 3.5L13 5"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              已确认
            </span>
          )}
          {props.regenLocked && (
            <span className="px-1.5 py-0.5 rounded bg-[var(--warning)]/15 text-[var(--warning)] text-[10px] flex items-center gap-0.5 flex-shrink-0">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6 10V8a6 6 0 1112 0v2M5 10h14v10H5V10z"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </svg>
              已锁定
            </span>
          )}
        </div>
      </div>

      {/* 编辑区 - 可滚动，内部直接渲染 AssetCard（复用全部编辑能力） */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {/* AssetCard 在编辑面板中居中展示
            - 最大宽度 720px 保证可读性
            - 移动端去除 max-width 限制，占满容器
            - key={asset.id} 强制切换资产时重新挂载，确保内部 state（description/background 等）同步更新 */}
        <div className="w-full max-w-[720px] mx-auto">
          <AssetCard
            key={asset.id}
            asset={asset}
            projectId={props.projectId}
            onGenerateImage={props.onGenerateImage}
            onUpdate={props.onUpdate}
            onConfirm={props.onConfirm}
            onDelete={props.onDelete}
            isGenerating={props.isGenerating}
            taskId={props.taskId}
            isVariantGenerating={props.isVariantGenerating}
            getVariantTaskId={props.getVariantTaskId}
            imgErrors={props.imgErrors}
            setImgErrors={props.setImgErrors}
            toast={props.toast}
            isReview={props.isReview}
            imageModel={props.imageModel}
            onImageModelChange={props.onImageModelChange}
            resolution={props.resolution}
            onResolutionChange={props.onResolutionChange}
            regenLocked={props.regenLocked}
            onLockToggle={props.onLockToggle}
            onZoom={props.onZoom}
            onUpload={props.onUpload}
            onRefresh={props.onRefresh}
            tabLabel={props.tabLabel}
          />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// VoiceBrowserModal — 批6 音色库浏览/试听/绑定 modal（视觉照搬 app1）
// ============================================================
//
// C/S 适配（dramaforge-assets-client-local 核心翻译）：
//   - 列表数据：sfShell.listPresetVoices() 从客户端本地 manifest 读 200 条
//     （wav + manifest 打包进 Electron exe；server 零媒体字节）。
//   - 试听播放：sfShell.readPresetVoice(file) 返 base64 dataUrl → new Audio(dataUrl)
//     （app1 走 /api/reference-audio/[file] HTTP 流；dramaforge 无此 route，全本地）。
//   - 浏览器/dev 无 sfShell → 模态内显示提示，不阻塞关闭（保留 dev 体验）。
//
// 视觉对齐 app1 VoiceBrowserModal（F:\app1\src\app\workspace\[projectId]\
//   components\AssetDesignStage.tsx:2504-2653）：
//   - 全部/女声/男声 三按钮 gender 筛选
//   - 描述/文件名 搜索
//   - 列表项：播放按钮 + 描述 + 性别徽章 + 时长 + 已添加/添加 按钮
//   - 底部统计（总数 + 男女计数）
//   - AI 推荐项加 「✓ AI 推荐」 徽章（dramaforge 扩展：metadata.suggested_voices 来自
//     资产提取，标识 AI 在剧本分析时为该角色推荐的音色）
// ============================================================

interface VoiceBrowserModalProps {
  /** 已加入角色候选列表的音色文件名。 */
  existingFiles: string[];
  /** AI 资产提取时推荐的音色（来自 AssetRecord.metadata.suggested_voices，可选）。 */
  suggestedVoices?: AssetVoiceOption[];
  onClose: () => void;
  /** 添加到候选列表；最终选定在卡片内完成。 */
  onAssign: (file: string, desc: string, gender: string) => Promise<void>;
  toast: ReturnType<typeof useToast>;
}

export function VoiceBrowserModal({
  existingFiles,
  suggestedVoices,
  onClose,
  onAssign,
  toast,
}: VoiceBrowserModalProps) {
  const [voices, setVoices] = React.useState<SfShellPresetVoice[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [filterGender, setFilterGender] = React.useState<"all" | "female" | "male">("all");
  const [playingFile, setPlayingFile] = React.useState<string | null>(null);
  const [bindingFile, setBindingFile] = React.useState<string | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  /** 试听请求令牌：防快速连点竞态（旧请求返回后不再播，避免后台叠播）。 */
  const playTokenRef = React.useRef(0);
  const suggestedFiles = React.useMemo(
    () => new Set((suggestedVoices ?? []).map((v) => v.file)),
    [suggestedVoices],
  );

  // 拉取预设音色列表（sfShell.listPresetVoices）。Electron only。
  React.useEffect(() => {
    let cancelled = false;
    const sf = window.sfShell;
    if (!sf?.listPresetVoices) {
      const isElectron =
        typeof navigator !== "undefined" && /Electron\//.test(navigator.userAgent);
      setLoadError(
        isElectron
          ? "桌面客户端音色库能力(sfShell)未加载，请重启客户端或联系技术支持。"
          : "浏览器模式不支持浏览音色库，请使用桌面客户端。",
      );
      setLoading(false);
      return;
    }
    sf.listPresetVoices()
      .then((r) => {
        if (cancelled) return;
        if (r?.ok && Array.isArray(r.voices)) {
          setVoices(r.voices);
        } else {
          const err = r && !r.ok ? r : null;
          setLoadError(
            `音色清单加载失败${err ? ` [${err.code}]: ${err.message}` : ""}`,
          );
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(`音色清单加载异常: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 卸载时停播音频（防后台继续放）
  React.useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const filtered = voices.filter((v) => {
    const matchSearch =
      !search ||
      v.desc?.toLowerCase().includes(search.toLowerCase()) ||
      v.file.toLowerCase().includes(search.toLowerCase());
    const matchGender = filterGender === "all" || v.gender === filterGender;
    return matchSearch && matchGender;
  });

  const handlePlay = async (file: string) => {
    // 切换：正在播这个 → 停
    if (playingFile === file) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlayingFile(null);
      return;
    }
    // 停掉旧的
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const sf = window.sfShell;
    if (!sf?.readPresetVoice) {
      toast.error("桌面客户端音色试听能力未加载，请使用桌面客户端。");
      return;
    }
    // 取新令牌；await 期间若用户点了别的，旧令牌作废不播。
    const token = ++playTokenRef.current;
    setPlayingFile(file);
    try {
      const r = await sf.readPresetVoice(file);
      if (token !== playTokenRef.current) return; // 已被新点击覆盖，丢弃
      if (!r?.ok || typeof r.dataUrl !== "string") {
        const err = r && !r.ok ? r : null;
        toast.error(
          `试听加载失败${err ? ` [${err.code}]: ${err.message}` : ""}`,
        );
        if (token === playTokenRef.current) setPlayingFile(null);
        return;
      }
      const audio = new Audio(r.dataUrl);
      audioRef.current = audio;
      audio.onended = () => {
        if (token === playTokenRef.current) setPlayingFile(null);
      };
      audio.onerror = () => {
        if (token === playTokenRef.current) setPlayingFile(null);
      };
      await audio.play().catch(() => {
        if (token === playTokenRef.current) setPlayingFile(null);
      });
    } catch (e: unknown) {
      if (token === playTokenRef.current) {
        toast.error(`试听失败: ${e instanceof Error ? e.message : "未知错误"}`);
        setPlayingFile(null);
      }
    }
  };

  const femaleCount = voices.filter((v) => v.gender === "female").length;
  const maleCount = voices.filter((v) => v.gender === "male").length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] bg-[var(--bg-card)] rounded-2xl border border-[var(--border-light)] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-[var(--border-light)]">
          <h3
            className="text-base sm:text-lg font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            浏览音色库
            <span className="ml-2 text-xs sm:text-sm font-normal text-[var(--text-3)]">
              ({loading ? "加载中..." : `${filtered.length} / ${voices.length}`})
            </span>
          </h3>
          <button onClick={onClose} className="btn-ghost p-1.5 rounded-lg" aria-label="关闭">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* 搜索 + 性别筛选 */}
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 px-4 sm:px-6 py-3 border-b border-[var(--border-light)]">
          <div className="relative flex-1 min-w-0">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 rounded-lg bg-[var(--bg-hover)] border border-[var(--border-light)] text-xs text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-[var(--action)]"
              placeholder="搜索音色描述或文件名..."
            />
          </div>
          <div className="flex gap-1 flex-shrink-0">
            {(["all", "female", "male"] as const).map((g) => (
              <button
                key={g}
                onClick={() => setFilterGender(g)}
                className={`px-2 sm:px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  filterGender === g
                    ? "bg-[var(--action-dim)] text-[var(--action)]"
                    : "text-[var(--text-3)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                {g === "all" ? "全部" : g === "female" ? "女声" : "男声"}
              </button>
            ))}
          </div>
        </div>

        {/* 列表 / 加载 / 错误 */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-3 sm:py-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner size={20} />
              <span className="ml-2 text-xs text-[var(--text-3)]">加载音色清单...</span>
            </div>
          ) : loadError ? (
            <div className="p-4 rounded-lg border border-[var(--error)]/30 bg-[var(--error-dim)] text-xs text-[var(--error)]">
              {loadError}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8 text-xs text-[var(--text-3)]">
              没有匹配的音色
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((v) => {
                const isAdded = existingFiles.includes(v.file);
                const isSuggested = suggestedFiles.has(v.file);
                const isPlaying = playingFile === v.file;
                const isBinding = bindingFile === v.file;
                return (
                  <div
                    key={v.file}
                    className={`flex items-center gap-2 sm:gap-4 px-3 sm:px-4 py-2 sm:py-3 rounded-xl border transition-all ${
                      isAdded
                        ? "border-[var(--success)] bg-[var(--success)]/8"
                        : isPlaying
                          ? "border-[var(--action)] bg-[var(--action)]/5"
                          : "border-[var(--border-light)] hover:border-[var(--border)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    {/* 播放/暂停按钮 */}
                    <button
                      onClick={() => void handlePlay(v.file)}
                      className={`w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
                        isPlaying
                          ? "bg-[var(--action)] text-white"
                          : "bg-[var(--bg-hover)] text-[var(--text-3)] hover:text-[var(--text)]"
                      }`}
                      aria-label={isPlaying ? "暂停" : "试听"}
                    >
                      {isPlaying ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"
                            fill="currentColor"
                          />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M8 5v14l11-7L8 5z" fill="currentColor" />
                        </svg>
                      )}
                    </button>

                    {/* 文本信息 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 sm:gap-2 mb-0.5 sm:mb-1 flex-wrap">
                        <span
                          className="text-[11px] sm:text-xs font-medium text-[var(--text)] truncate"
                          title={v.desc || v.file}
                        >
                          {v.desc || v.file}
                        </span>
                        <span
                          className={`px-1 sm:px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-medium flex-shrink-0 ${
                            v.gender === "female"
                              ? "bg-pink-500/15 text-pink-400"
                              : "bg-blue-500/15 text-blue-400"
                          }`}
                        >
                          {v.gender === "female" ? "女" : "男"}
                        </span>
                        {isSuggested && (
                          <span
                            className="px-1 sm:px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-medium flex-shrink-0 bg-[var(--accent-dim)] text-[var(--accent)]"
                            title="AI 资产提取时为本角色推荐的音色"
                          >
                            ✓ AI 推荐
                          </span>
                        )}
                      </div>
                      <span className="text-[9px] sm:text-[10px] text-[var(--text-3)] font-mono truncate block">
                        {v.file}
                      </span>
                    </div>

                    {/* 时长 */}
                    {typeof v.dur === "number" && (
                      <span className="hidden sm:inline text-xs text-[var(--text-3)] font-mono flex-shrink-0">
                        {v.dur}s
                      </span>
                    )}

                    {/* 添加/已添加按钮；最终选定回到角色卡片完成 */}
                    {isAdded ? (
                      <span className="px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[10px] sm:text-xs text-[var(--success)] bg-[var(--success)]/10 font-medium flex-shrink-0 inline-flex items-center gap-0.5">
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 16 16"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M3 8l3.5 3.5L13 5"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        已添加
                      </span>
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={async () => {
                          setBindingFile(v.file);
                          try {
                            await onAssign(v.file, v.desc || "", v.gender || "");
                          } finally {
                            setBindingFile(null);
                          }
                        }}
                        loading={isBinding}
                        className="h-auto px-2 py-1 text-[10px] sm:px-3 sm:py-1.5 sm:text-xs flex-shrink-0"
                      >
                        添加
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部统计 */}
        <div className="px-4 sm:px-6 py-2 sm:py-3 border-t border-[var(--border-light)] text-[10px] sm:text-xs text-[var(--text-3)] flex flex-wrap items-center justify-between gap-2">
          <span>共 {voices.length} 个预设音色</span>
          <span className="flex items-center gap-1 flex-wrap">
            <span className="w-2 h-2 rounded-full bg-pink-400" /> 女声 {femaleCount}
            <span className="w-2 h-2 rounded-full bg-blue-400 ml-2" /> 男声 {maleCount}
          </span>
        </div>
      </div>
    </div>
  );
}
