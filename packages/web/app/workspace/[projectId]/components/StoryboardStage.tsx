"use client";

/**
 * @file StoryboardStage.tsx — 分镜设计阶段组件（批6 Step 1）
 *
 * 镜像 app1 `F:\app1\src\app\workspace\[projectId]\components\StoryboardStage.tsx`
 * （688 行 S1-S12），适配 dramaforge C/S 架构。
 *
 * 职责（与 app1 对齐，S1-S12）：
 *   1. 触发分镜生成（POST /api/projects/[id]/episodes/[episodeId]/generate-storyboard）
 *   2. 镜头分组算法（computeGroups，与 app1 严格对齐，getGroupKey 复合 key）
 *   3. 镜头表格展示 + 行内编辑（描述/景别/运镜/时长/画面提示词）
 *   4. ShotAssetReferenceBadges 资产引用徽标 + hover 缩略图（Step 2 简化版）
 *   5. 跳转下一阶段（生产）
 *
 * dramaforge 翻译（OP1-OP7 全修）：
 *   - OP4：useStoryboardGenerating 模块 store → 本地 useState(false)（无多 Tab 防重）
 *   - OP3：@core/shot/asset-reference → ./shot-asset-reference（Step 2 简化版）
 *   - OP2：ShotAssetReferenceBadges 用 <img>（sf-asset:// 不兼容 next/image）
 *   - OP5：handleGenerate URL episode 级（非项目级）
 *   - OP7：toast 用 d.shots?.length（dramaforge route 返回 {shots} 非 {shotCount}）
 *   - OP1：handleSave URL episode 级 + body 字段映射（route 做 metadata read-merge）
 *   - 删 @core/types/entities import → 本地 ShotAssetReferenceBinding/ShotReferencedAssets
 *   - 删 useStoryboardGenerating/setStoryboardGenerating import → 本地 useState
 *
 * 数据形状（dramaforge ShotRecord 适配）：
 *   - description/shotSize/cameraMovement/dialogue 不在顶层列，存 metadata
 *     （OP1 route 做 read-merge-write）
 *   - shotSeq 是 string|null，统一改用 shotIndex（number）做序号显示/排序
 *
 * 双色方案铁律（对齐 app1）：
 *   - 「生成分镜」按钮使用 --action 蓝（可点击行为）
 *   - 镜头组标签使用 --accent 琥珀（身份/分组标识）
 *   - 超时 badge 使用 --error 红（警示）
 *
 * GC 自检：
 *   - GC-1（BYOK 禁）：无 key 在代码 ✓
 *   - GC-3（app1 只读）：仅镜像，未改 app1 ✓
 *   - GC-5（无新 .sql）：PATCH 纯 metadata JSONB，无新列 ✓
 *   - GC-6（行为等价）：S1-S12 镜像 app1，OP1-OP7 修复后行为对齐 ✓
 *   - GC-7（URL shape）：episode 级 URL + 本地 state 替模块 store ✓
 *   - GC-8（视觉对齐）：双色铁律 + CSS 变量照搬 ✓
 *   - dramaforge-assets-client-local：S10 直接用 asset.imageUrl sf-asset://，server 不碰字节 ✓
 */

import * as React from 'react';
import { cn } from '../../../../components/ui/cn';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { formatShotLabel } from '../../../../lib/shot-label';
import { Input, Textarea } from '../../../../components/ui/Input';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { ProgressBar } from '../../../../components/ui/ProgressBar';
import { useToast } from '../../../../components/ui/Toast';
import { ShotAssetReferenceBadges } from './ShotAssetReferenceBadges';
import { StoryboardVersionHistory } from './StoryboardVersionHistory';
import {
  resolveShotAssetReferenceBindings,
  isDefaultCostumeKey,
  type ShotAssetReferenceBinding,
  type ShotReferencedAssets,
  type CharacterCostumeRef,
} from './shot-asset-reference';
import type { AssetRecord, ShotRecord } from '@dramaforge/server';
import { getGenerationLock } from '../../../../hooks/useGenerationLock';
import { useInFlightGeneration } from '../../../../hooks/useInFlightGeneration';
import { useEpisodeTask } from '../../../../hooks/useEpisodeTask';
import { setTaskId } from '../../../../lib/episode-task-store';
import { GenerationProgress } from '../../../../components/features/GenerationProgress';
import { ModelSelector } from '../../../../components/ui/ModelSelector';
import { VIDEO_MODELS } from '../../../../lib/models';
import { maxDurationForVideoModel } from '@server/domain/prompt/seedance-helpers';

// ============================================================
// 常量（照搬 app1，对齐 Seedance 2.0）
// ============================================================

/** Seedance 2.0 有效时长档位 */
const VALID_DURATIONS = [4, 5, 6, 8, 10, 15];
/** 单组最大时长（秒，Seedance 硬约束） */
const MAX_GROUP_DURATION = 15;
/** 单镜最小时长（秒） */
const MIN_SHOT_DURATION = 0.5;
/** 单镜最大时长（秒） */
const MAX_SHOT_DURATION = 4.0;
/**
 * 资产用量约束上限（仅展示用）。真源：
 *   chain-generate/route.ts MAX_CHARACTER_REFERENCES=4 / MAX_TOTAL_REFERENCES=9
 *   （= server seedance-helpers MAX_REFERENCE_CHARACTERS=4 / MAX_REFERENCE_IMAGES=9）。
 * 改真源时同步改这里。
 */
const CONSTRAINT_MAX_CHARACTERS = 4;
const CONSTRAINT_MAX_TOTAL = 9;

/**
 * 将时长向上取整到最近的 Seedance 有效档位（优先取较长档位最大化填充）。
 */
function roundUpToValidDuration(seconds: number, ladder: readonly number[] = VALID_DURATIONS): number {
  for (const d of ladder) {
    if (seconds <= d) return d;
  }
  return ladder[ladder.length - 1];
}

// ============================================================
// 镜头分组算法（与 app1 严格对齐，复合 key 避免跨场景合并）
// ============================================================

/**
 * 提取镜头的复合分组 key (sceneId, groupIndex)。
 *
 * 兜底读取顺序（与 app1 ProductionStage 对齐）：
 *   metadata.storyboardTable.groupIndex → metadata.groupIndex
 *   metadata.sceneId → metadata.storyboardTable.sceneId → "unknown"
 *
 * 新分镜由后处理写入 groupIndex；旧数据没有分组字段时返回 null，并安全回退为单镜组。
 */
function getGroupKey(shot: ShotRecord): string | null {
  const meta = (shot.metadata || {}) as Record<string, unknown>;
  const sbTable = (meta.storyboardTable || {}) as Record<string, unknown>;
  const gIdxRaw = sbTable.groupIndex ?? meta.groupIndex ?? -1;
  const gIdx = typeof gIdxRaw === 'number' ? gIdxRaw : -1;
  if (gIdx < 0) return null;
  const sceneId =
    (typeof meta.sceneId === 'string' && meta.sceneId) ||
    (typeof sbTable.sceneId === 'string' && sbTable.sceneId) ||
    'unknown';
  return `${sceneId}::${gIdx}`;
}

// ============================================================
// 字段 helpers（多源兜底，照搬 app1 S9）
// ============================================================

function getStoryboardTable(shot: ShotRecord): Record<string, unknown> {
  const meta = shot.metadata && typeof shot.metadata === 'object' ? shot.metadata : {};
  const sbTable = (meta as Record<string, unknown>).storyboardTable;
  return sbTable && typeof sbTable === 'object' ? (sbTable as Record<string, unknown>) : {};
}

/** 取镜头语义组名（建场组/推进组/高潮组…），缺省 null。 */
function getShotGroupName(shot: ShotRecord): string | null {
  const meta = (shot.metadata || {}) as Record<string, unknown>;
  const sbTable = (meta.storyboardTable || {}) as Record<string, unknown>;
  const label =
    (typeof meta.groupLabel === 'string' && meta.groupLabel) ||
    (typeof sbTable.groupLabel === 'string' && sbTable.groupLabel) ||
    null;
  return label || null;
}

function getShotPromptSource(shot: ShotRecord): string {
  const meta =
    shot.metadata && typeof shot.metadata === 'object'
      ? (shot.metadata as Record<string, unknown>)
      : null;
  const timecodePrompt =
    meta && typeof meta.timecodePrompt === 'string' ? meta.timecodePrompt : '';
  return timecodePrompt || shot.visualPrompt || '';
}

/** 从时间码提示词行解析景别/机位/运镜（app1 同款正则） */
function parsePromptCameraFields(prompt?: string | null): {
  shotSize?: string;
  cameraAngle?: string;
  cameraMovement?: string;
} {
  if (!prompt || typeof prompt !== 'string') return {};
  const tcLineMatch = prompt.match(/\[\d{2}:\d{2}(?:\.\d+)?-\d{2}:\d{2}(?:\.\d+)?\][^\n\r]*/);
  if (!tcLineMatch) return {};
  const line = tcLineMatch[0];
  const contentAfterTc = line.replace(
    /\[\d{2}:\d{2}(?:\.\d+)?-\d{2}:\d{2}(?:\.\d+)?\][,，]?/,
    '',
  );
  const fields = contentAfterTc.split(/[，,]/).map((field) => field.trim());
  return {
    shotSize: fields[0] || undefined,
    cameraAngle: fields[1] || undefined,
    cameraMovement: fields[2] || undefined,
  };
}

function getShotSizeValue(shot: ShotRecord): string {
  const sbTable = getStoryboardTable(shot);
  const parsed = parsePromptCameraFields(getShotPromptSource(shot));
  return (
    (typeof sbTable.shotSize === 'string' ? sbTable.shotSize : '') ||
    parsed.shotSize ||
    ''
  );
}

function getCameraAngleValue(shot: ShotRecord): string {
  const sbTable = getStoryboardTable(shot);
  const parsed = parsePromptCameraFields(getShotPromptSource(shot));
  return (
    (typeof sbTable.cameraAngle === 'string' ? sbTable.cameraAngle : '') ||
    parsed.cameraAngle ||
    ''
  );
}

function getCameraMovementValue(shot: ShotRecord): string {
  const sbTable = getStoryboardTable(shot);
  const parsed = parsePromptCameraFields(getShotPromptSource(shot));
  return (
    (typeof sbTable.cameraMovement === 'string' ? sbTable.cameraMovement : '') ||
    parsed.cameraMovement ||
    ''
  );
}

/**
 * 描述（dramaforge 适配）：
 *   app1 Shot 顶层有 description 列；dramaforge ShotRecord 无此列，存 metadata.description
 *   （OP1 route 做 read-merge-write）。
 */
function getShotDescription(shot: ShotRecord): string {
  const meta = (shot.metadata || {}) as Record<string, unknown>;
  return typeof meta.description === 'string' ? meta.description : '';
}

/**
 * 对白（dramaforge 适配）：存 metadata.dialogue（OP1 route 做 read-merge-write）。
 */
function getShotDialogue(shot: ShotRecord): string {
  const meta = (shot.metadata || {}) as Record<string, unknown>;
  return typeof meta.dialogue === 'string' ? meta.dialogue : '';
}

/**
 * 结构化提示词（2026-07-28 对齐参考产品分镜制作）：场景/场景设计/画面信息。
 * 存 metadata.structuredPrompt。AI 生成时填充，UI 可编辑。
 */
function getStructuredPrompt(shot: ShotRecord): {
  scene: string;
  sceneDesign: string;
  visualInfo: string;
} {
  const meta = (shot.metadata || {}) as Record<string, unknown>;
  const sp =
    meta.structuredPrompt && typeof meta.structuredPrompt === 'object'
      ? (meta.structuredPrompt as Record<string, unknown>)
      : {};
  return {
    scene: typeof sp.scene === 'string' ? sp.scene : '',
    sceneDesign: typeof sp.sceneDesign === 'string' ? sp.sceneDesign : '',
    visualInfo: typeof sp.visualInfo === 'string' ? sp.visualInfo : '',
  };
}

/**
 * 参考视频风格开关（2026-07-28）：镜运/对白/音效/光影/画风。
 * 存 metadata.referenceStyle（布尔）。生成时是否参考对应维度。
 */
function getReferenceStyle(shot: ShotRecord): {
  cameraMovement: boolean;
  dialogue: boolean;
  sfx: boolean;
  lighting: boolean;
  artStyle: boolean;
} {
  const meta = (shot.metadata || {}) as Record<string, unknown>;
  const rs =
    meta.referenceStyle && typeof meta.referenceStyle === 'object'
      ? (meta.referenceStyle as Record<string, unknown>)
      : {};
  return {
    cameraMovement: !!rs.cameraMovement,
    dialogue: !!rs.dialogue,
    sfx: !!rs.sfx,
    lighting: !!rs.lighting,
    artStyle: !!rs.artStyle,
  };
}

/**
 * 取镜头引用的资产 binding 列表。
 *
 * 优先用 metadata.assetReferenceBindings（已绑定缓存），否则实时调
 * resolveShotAssetReferenceBindings 解析 referencedAssets + assets 索引。
 */
function getShotAssetReferenceBindingsList(
  shot: ShotRecord,
  assets: AssetRecord[],
  projectId: string,
): ShotAssetReferenceBinding[] {
  const metadata =
    shot.metadata && typeof shot.metadata === 'object'
      ? (shot.metadata as Record<string, unknown>)
      : {};
  const savedBindings = Array.isArray(metadata.assetReferenceBindings)
    ? (metadata.assetReferenceBindings as ShotAssetReferenceBinding[])
    : [];
  if (savedBindings.length > 0) return savedBindings;
  return resolveShotAssetReferenceBindings(
    {
      referencedAssets: (shot.referencedAssets || null) as ShotReferencedAssets | null,
      metadata: metadata,
    },
    assets,
    projectId,
  );
}

// ============================================================
// 类型定义
// ============================================================

/** 镜头分组结果 */
interface ShotGroup {
  /** 组内镜头 ID 列表（按 shotIndex 排序） */
  shotIds: string[];
  /** 组总时长（秒） */
  totalDuration: number;
  /** 对齐到 Seedance 有效时长的组时长 */
  validDuration: number;
  /** 组展示标签（如"组 1·建场组"） */
  groupLabel: string;
  /** 复合 key（sceneId + groupIndex） */
  groupKey: string;
}

export interface StoryboardStageProps {
  projectId: string;
  episodeId?: string | null;
  /** 镜头列表（dramaforge ShotRecord[]，episode 级） */
  shots: ShotRecord[];
  /**
   * 分集数据（消费 title 用于顶部标题显示 + scriptData.scenes 判断编剧分析是否完成；
   * 类型宽松以兼容 EpisodeRecord 的 nullable 字段，避免不必要的不兼容报错）。
   */
  episode?: {
    id: string;
    title?: string | null;
    episodeNumber?: number | null;
    /** 编剧分析产物（含 scenes 场景结构）；为空 = 尚未完成分析，分镜生成前置门控。 */
    scriptData?: unknown;
  } | null;
  /** 参考视频时长（秒）；>0 表示有参考视频，生成时完全跟随、不弹窗。来自 episode.scriptData.sourceVideoDurationSeconds。 */
  sourceVideoDurationSeconds?: number | null;
  /** 项目全部资产（ShotAssetReferenceBadges 缩略图源） */
  assets?: AssetRecord[];
  /** 项目分类（OVERSEAS / DOMESTIC 等） */
  category?: string;
  /** API 调用封装（useApi 装配，envelope 解析 + toast） */
  api: (url: string, options?: RequestInit) => Promise<unknown>;
  /** 刷新数据回调（父组件 EpisodeWorkspace.loadShots） */
  onRefresh?: () => void;
  /** 视频模型 ID（与 EpisodeWorkspace 双向同步） */
  videoModel?: string;
  setVideoModel?: (id: string) => void;
  /** 跳转下一阶段（生产）回调 */
  onNavigateNext?: () => void;
  /** 容器额外类名 */
  className?: string;
}

/**
 * 按镜头编组：优先用已有 (sceneId, groupIndex) 复合 key，超 15s 自动拆分，
 * 无编组的进入 ungrouped。
 *
 * 严格对齐 app1（不强制合并末尾小组）；旧数据无 groupIndex 时按单镜组兼容。
 */
function computeGroups(shotList: ShotRecord[], maxDur: number = MAX_GROUP_DURATION): ShotGroup[] {
  // Build duration ladder: base [4,5,6,8,10,15] + 5s steps up to maxDur (for 2.5's 30s).
  const ladder: number[] = [...VALID_DURATIONS];
  for (let step = 20; step <= maxDur; step += 5) {
    if (!ladder.includes(step)) ladder.push(step);
  }
  const groupMap = new Map<string, ShotRecord[]>();
  const ungrouped: ShotRecord[] = [];

  for (const s of shotList) {
    const key = getGroupKey(s);
    if (key !== null) {
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(s);
    } else {
      ungrouped.push(s);
    }
  }

  // 排序每组内镜头（按 shotIndex）
  const sortedGroups = Array.from(groupMap.entries()).map(([key, shots]) => ({
    key,
    shots: shots.sort((a, b) => (a.shotIndex ?? 0) - (b.shotIndex ?? 0)),
  }));

  // 拆分超 15s 的组（按镜头顺序贪心累计，超 15s 开新子组）
  const result: ShotGroup[] = [];
  let groupCounter = 0;
  for (const { key, shots } of sortedGroups) {
    groupCounter += 1;
    const totalDuration = shots.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);

    if (totalDuration <= maxDur) {
      result.push({
        shotIds: shots.map((s) => s.id),
        totalDuration,
        validDuration: roundUpToValidDuration(totalDuration, ladder),
        groupLabel: `组 ${groupCounter}`,
        groupKey: key,
      });
    } else {
      let current: ShotRecord[] = [];
      let currentDur = 0;
      let splitIdx = 0;
      for (const s of shots) {
        const dur = s.durationSeconds ?? 0;
        if (currentDur + dur > maxDur && current.length > 0) {
          result.push({
            shotIds: current.map((s) => s.id),
            totalDuration: currentDur,
            validDuration: roundUpToValidDuration(currentDur, ladder),
            groupLabel: `组 ${groupCounter}-${splitIdx + 1}`,
            groupKey: `${key}-split${splitIdx}`,
          });
          splitIdx += 1;
          current = [];
          currentDur = 0;
        }
        current.push(s);
        currentDur += dur;
      }
      if (current.length > 0) {
        result.push({
          shotIds: current.map((s) => s.id),
          totalDuration: currentDur,
          validDuration: roundUpToValidDuration(currentDur, ladder),
          groupLabel: splitIdx > 0 ? `组 ${groupCounter}-${splitIdx + 1}` : `组 ${groupCounter}`,
          groupKey: splitIdx > 0 ? `${key}-split${splitIdx}` : key,
        });
      }
    }
  }

  // 未分组镜头：每组单独成组（不强制合并，由用户决定）
  for (const s of ungrouped) {
    groupCounter += 1;
    const dur = s.durationSeconds ?? 0;
    result.push({
      shotIds: [s.id],
      totalDuration: dur,
      validDuration: roundUpToValidDuration(dur, ladder),
      groupLabel: `组 ${groupCounter}（未编组）`,
      groupKey: `ungrouped::${s.id}`,
    });
  }

  return result;
}

// ============================================================
// 组件
// ============================================================

/**
 * 分镜设计阶段组件。
 *
 * 顶部：生成分镜按钮 + 总览统计（镜头数/组数/总时长）
 * 中部：镜头表格（按组分区，行内可编辑描述/运镜/时长/画面提示词）
 * 底部：跳转生产阶段按钮
 */
export function StoryboardStage({
  projectId,
  episodeId,
  shots,
  episode,
  assets = [],
  sourceVideoDurationSeconds = null,
  // category 透传给 generate-storyboard route（DOMESTIC/OVERSEAS 影响语言分支）。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  category: _category,
  api,
  onRefresh,
  onNavigateNext,
  videoModel: videoModelProp,
  setVideoModel: setVideoModelProp,
  className,
}: StoryboardStageProps) {
  // 视频模型状态：优先用父组件传入的（EpisodeWorkspace 级双向同步），否则本地 state
  const [videoModelLocal, setVideoModelLocal] = React.useState('ark/doubao-seedance-2-0-260128');
  const videoModel = videoModelProp ?? videoModelLocal;
  const setVideoModel = setVideoModelProp ?? setVideoModelLocal;
  // 组划分上限跟随所选模型条目（2026-08-12：Seedance 2.5 双条目——
  // 「30秒·合并组」按 30s 合并镜头组，「仅换模型」保持 15s 不合并）。
  const selectedVideoModel = VIDEO_MODELS.find((m) => m.id === videoModel);
  const maxGroupDuration = Math.min(
    selectedVideoModel?.maxDuration ?? MAX_GROUP_DURATION,
    maxDurationForVideoModel(videoModel.split(":")[0]),
  );
  const toast = useToast();
  // 编剧分析是否已产出场景结构（生成分镜的前置条件；否则后端 400 NO_SCENES，
  // 历史教训：用户在分析完成前点生成分镜得到"该集尚无场景结构"的困惑报错）。
  const sd = (episode?.scriptData ?? null) as { scenes?: unknown } | null;
  const hasScenes = Array.isArray(sd?.scenes) && (sd.scenes as unknown[]).length > 0;
  // 本地 state 负责即时反馈，持久化生成锁负责刷新/多 Tab 防重复与恢复。
  const [generating, setGenerating] = React.useState(false);
  /** 完成定格：任务完成时短暂显示 100% 再卸载进度条（诉求6：进度条要到 100%）。 */
  const [justCompleted, setJustCompleted] = React.useState(false);
  /** 当前在途的分镜 taskId（React state，runGenerate 即时 set，必然触发重渲染
   *  让进度条立刻显示）。localStorage(setTaskId)只作刷新恢复回落——纯靠 localStorage
   *  读不触发 rerender,会在 setGenerating(false) 后漏显进度条。 */
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  /** in-flight 生命周期锁（刷新不丢）：start 写锁 / end 清锁（finally）/ reconcile
   *  查 shots 判 done。generating（本 tab 活跃请求）+ inflight.isGenerating（残留锁，
   *  跨刷新存活）双源——正常完成 finally 清锁，仅刷新中断时锁残留由 reconcile 收尾。 */
  const inflight = useInFlightGeneration({
    key: `storyboard:${episodeId}`,
    scope: 'storyboard',
    projectId,
    episodeId,
    reconcile: async () => {
      if (!episodeId) return null;
      const s = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/shots`,
      )) as { shots?: ShotRecord[] } | null;
      const lock = getGenerationLock(`storyboard:${episodeId}`);
      const prevMaxUpdatedAt = (lock?.metadata?.prevMaxUpdatedAt as number | undefined) ?? 0;
      const startedAt = (lock?.metadata?.startedAt as number | undefined) ?? 0;
      // 落库后 shots.updatedAt 刷新（> 生成前最大值）→ done，绕开 same-count
      // （重新生成 20→20 镜头也能识别：replaceEpisodeShots 后新镜头 updatedAt 必晚于旧值）。
      const nowMaxUpdatedAt = (s?.shots ?? []).reduce((m, sh) => {
        const ts = Date.parse(sh.updatedAt ?? '') || 0;
        return Math.max(m, ts);
      }, 0);
      if (nowMaxUpdatedAt > prevMaxUpdatedAt) return 'done';
      // 锁存活超时（5min）仍无新 updatedAt → failed（断连/异常；仍可手动 reset 逃逸）。
      if (startedAt && Date.now() - startedAt > 5 * 60 * 1000) return 'failed';
      return 'running';
    },
    onCompleted: () => { setJustCompleted(true); setTimeout(() => setJustCompleted(false), 1000); onRefresh?.(); },
    pollMs: 8000,
    maxPolls: 30,
  });
  /** SSE 任务进度（F3）：POST 202 返 taskId → setTaskId → 本 hook 读出 → 实时百分比。 */
  const shotTask = useEpisodeTask(episodeId, 'SHOT_AI');
  // 进度条 taskId 优先取 React state（即时），activeTaskId 为空（刷新后）回落 localStorage。
  const effectiveShotTaskId = activeTaskId ?? shotTask.taskId;
  const TERMINAL_SB = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT']);
  const taskActive = !!effectiveShotTaskId && !TERMINAL_SB.has(shotTask.status ?? '');
  /** 生成中 = 本 tab 活跃请求 OR SSE 任务在途 OR 残留锁（跨刷新）。 */
  const showGenerating = generating || taskActive || inflight.isGenerating || justCompleted;
  /** 残留锁（刷新后）且本 tab 无活跃请求 → 显「清除状态」逃逸悬挂锁。 */
  const showReset = inflight.isGenerating && !generating;
  /** 当前正在编辑的镜头 ID */
  const [editingShotId, setEditingShotId] = React.useState<string | null>(null);
  /** 编辑草稿（PATCH body） */
  const [draft, setDraft] = React.useState<Record<string, unknown>>({});
  /** 引用资产是否被改过（仅在改过时才随 PATCH 发送，避免改描述时被既有陈旧引用名 400 拦住） */
  const [refsTouched, setRefsTouched] = React.useState(false);
  /** 保存中 */
  const [saving, setSaving] = React.useState(false);

  /** 引用资产草稿形状（单镜头重绑；field→资产名数组） */
  type RefsDraft = {
    characters: string[];
    speakingCharacters: string[];
    environments: string[];
    items: string[];
    /** 角色→造型手动覆盖（批7；name∈characters、单选互斥；default 不入库） */
    characterCostumes: CharacterCostumeRef[];
    /** 道具→变体手动覆盖（对齐角色；name∈items） */
    itemCostumes: CharacterCostumeRef[];
    /** 场景→变体手动覆盖（对齐角色；name∈environments） */
    environmentCostumes: CharacterCostumeRef[];
  };

  /** 空引用草稿（draft 无 referencedAssets 时的兜底）。 */
  const EMPTY_REFS: RefsDraft = {
    characters: [],
    speakingCharacters: [],
    environments: [],
    items: [],
    characterCostumes: [],
    itemCostumes: [],
    environmentCostumes: [],
  };

  /** 从镜头读取引用资产草稿（缺字段补空数组）。 */
  const refsDraftFromShot = (shot: ShotRecord): RefsDraft => {
    const r = (shot.referencedAssets || {}) as Partial<RefsDraft>;
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
    const ccArr = (v: unknown): CharacterCostumeRef[] =>
      Array.isArray(v)
        ? v
            .map((x): CharacterCostumeRef | null => {
              if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
              const name = (x as { name?: unknown }).name;
              const costumeKey = (x as { costumeKey?: unknown }).costumeKey;
              if (typeof name !== 'string' || typeof costumeKey !== 'string') return null;
              const n = name.trim();
              const k = costumeKey.trim();
              if (!n || !k) return null;
              return { name: n, costumeKey: k };
            })
            .filter((x): x is CharacterCostumeRef => x !== null)
        : [];
    return {
      characters: arr(r.characters),
      speakingCharacters: arr(r.speakingCharacters),
      environments: arr(r.environments),
      items: arr(r.items),
      characterCostumes: ccArr(r.characterCostumes),
      itemCostumes: ccArr(r.itemCostumes),
      environmentCostumes: ccArr(r.environmentCostumes),
    };
  };

  /** 在某引用字段里增删一个资产名（保持既有顺序，新增追加；联动 speakingCharacters 子集）。 */
  const toggleRef = (
    field: 'characters' | 'environments' | 'items',
    name: string,
  ) => {
    setDraft((d) => {
      const prev = (d.referencedAssets as RefsDraft | undefined) ?? EMPTY_REFS;
      const exists = prev[field].includes(name);
      const nextField = exists
        ? prev[field].filter((n) => n !== name)
        : [...prev[field], name];
      const next: RefsDraft = { ...prev, [field]: nextField };
      // 角色：移除角色时，把不在 characters 里的说话角色 + 造型覆盖一并清掉（维持子集不变量）。
      if (field === 'characters') {
        const charSet = new Set(nextField);
        next.speakingCharacters = prev.speakingCharacters.filter((n) => charSet.has(n));
        next.characterCostumes = prev.characterCostumes.filter((cc) => charSet.has(cc.name));
      }
      // 场景/道具：移除时同步清掉对应变体覆盖（维持子集不变量）。
      if (field === 'environments') {
        const set = new Set(nextField);
        next.environmentCostumes = prev.environmentCostumes.filter((cc) => set.has(cc.name));
      }
      if (field === 'items') {
        const set = new Set(nextField);
        next.itemCostumes = prev.itemCostumes.filter((cc) => set.has(cc.name));
      }
      return { ...d, referencedAssets: next };
    });
    setRefsTouched(true);
  };

  /**
   * 设置某角色的造型（批7；单选互斥）。
   *
   * key=null 或 default → 移除该角色的覆盖条目（选默认 = 删条目，走自动匹配/默认图）。
   * key=非 default → upsert 该角色条目（覆盖原值）。
   */
  const setCharacterCostume = (name: string, key: string | null) => {
    setDraft((d) => {
      const prev = (d.referencedAssets as RefsDraft | undefined) ?? EMPTY_REFS;
      const filtered = prev.characterCostumes.filter((cc) => cc.name !== name);
      const next: CharacterCostumeRef[] =
        key && !isDefaultCostumeKey(key)
          ? [...filtered, { name, costumeKey: key }]
          : filtered;
      return { ...d, referencedAssets: { ...prev, characterCostumes: next } };
    });
    setRefsTouched(true);
  };

  /** 设置某道具的变体（对齐角色；default/移除 → 删条目）。 */
  const setItemCostume = (name: string, key: string | null) => {
    setDraft((d) => {
      const prev = (d.referencedAssets as RefsDraft | undefined) ?? EMPTY_REFS;
      const filtered = prev.itemCostumes.filter((cc) => cc.name !== name);
      const next: CharacterCostumeRef[] =
        key && !isDefaultCostumeKey(key)
          ? [...filtered, { name, costumeKey: key }]
          : filtered;
      return { ...d, referencedAssets: { ...prev, itemCostumes: next } };
    });
    setRefsTouched(true);
  };

  /** 设置某场景的变体（对齐角色；default/移除 → 删条目）。 */
  const setEnvironmentCostume = (name: string, key: string | null) => {
    setDraft((d) => {
      const prev = (d.referencedAssets as RefsDraft | undefined) ?? EMPTY_REFS;
      const filtered = prev.environmentCostumes.filter((cc) => cc.name !== name);
      const next: CharacterCostumeRef[] =
        key && !isDefaultCostumeKey(key)
          ? [...filtered, { name, costumeKey: key }]
          : filtered;
      return { ...d, referencedAssets: { ...prev, environmentCostumes: next } };
    });
    setRefsTouched(true);
  };

  /** 切换说话角色（仅允许在已选 characters 内）。 */
  const toggleSpeaking = (name: string) => {
    setDraft((d) => {
      const prev = (d.referencedAssets as RefsDraft | undefined) ?? EMPTY_REFS;
      const exists = prev.speakingCharacters.includes(name);
      const nextSpeaking = exists
        ? prev.speakingCharacters.filter((n) => n !== name)
        : [...prev.speakingCharacters, name];
      return { ...d, referencedAssets: { ...prev, speakingCharacters: nextSpeaking } };
    });
    setRefsTouched(true);
  };

  /** 分组结果（memoized） */
  const groups = React.useMemo(() => computeGroups(shots, maxGroupDuration), [shots, maxGroupDuration]);

  /** 镜头总时长 */
  const totalDuration = React.useMemo(
    () => shots.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0),
    [shots],
  );

  /** 弹窗时长选项（秒）。1min30s 为默认。 */
  const DURATION_OPTIONS: Array<{ value: string; label: string }> = [
    { value: '15', label: '15 秒' },
    { value: '30', label: '30 秒' },
    { value: '60', label: '1 分钟' },
    { value: '90', label: '1 分 30 秒（默认）' },
    { value: '120', label: '2 分钟' },
    { value: '180', label: '3 分钟' },
    { value: '300', label: '5 分钟' },
    { value: 'custom', label: '自定义' },
  ];
  const [durationModalOpen, setDurationModalOpen] = React.useState(false);
  const [durationChoice, setDurationChoice] = React.useState<string>('90');
  const [customDuration, setCustomDuration] = React.useState<string>('90');
  const [historyOpen, setHistoryOpen] = React.useState(false);

  /**
   * 触发分镜生成（S11，OP5 + OP7）。
   *
   * URL 改 episode 级（dramaforge route shape）；
   * toast 用 d.shots?.length（dramaforge 返回 {shots} 非 {shotCount}）。
   */
  const runGenerate = async (totalDurationSeconds?: number) => {
    if (!episodeId) {
      toast.error('缺少分集 ID');
      return;
    }
    if (showGenerating) {
      toast.warning('分镜生成中，请勿重复触发');
      return;
    }
    const beforeCount = shots.length;
    // 记录生成前 shots 的最大 updatedAt，reconcile 据此识别 done（值变化判定，
    // 绕开 same-count 误判，且无客户端/服务器时钟漂移问题）。
    const prevMaxUpdatedAt = shots.reduce((m, sh) => {
      const ts = Date.parse(sh.updatedAt ?? '') || 0;
      return Math.max(m, ts);
    }, 0);
    inflight.start({ beforeCount, startedAt: Date.now(), prevMaxUpdatedAt });
    setGenerating(true);
    setDurationModalOpen(false);
    toast.info('分镜生成任务已提交，预计 1-3 分钟完成');
    try {
      const rewrite = shots.length > 0;
      const body: { rewrite: boolean; totalDurationSeconds?: number } = { rewrite };
      if (typeof totalDurationSeconds === 'number') body.totalDurationSeconds = totalDurationSeconds;
      const d = (await api(
        `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/generate-storyboard`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      )) as { taskId?: string } | null;
      if (d?.taskId) {
        // 异步：POST 立即返 taskId；setActiveTaskId(React state)必然触发重渲染
        // 让进度条立刻显示；setTaskId 写 localStorage 供刷新恢复。
        // 完成由 GenerationProgress.onComplete / inflight reconcile 触发 onRefresh。
        setActiveTaskId(d.taskId);
        setTaskId('SHOT_AI', episodeId, d.taskId);
        toast.info('分镜生成已开始，进度实时显示');
      } else {
        toast.error('分镜生成失败');
      }
    } catch (e: unknown) {
      toast.error(`分镜生成失败: ${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setGenerating(false);
      inflight.end();
    }
  };

  /**
   * 触发分镜生成入口：有参考视频→完全跟随、直接生成；否则弹窗让用户选总时长。
   */
  const handleGenerate = () => {
    if (!episodeId) {
      toast.error('缺少分集 ID');
      return;
    }
    if (showGenerating) {
      toast.warning('分镜生成中，请勿重复触发');
      return;
    }
    if (sourceVideoDurationSeconds && sourceVideoDurationSeconds > 0) {
      void runGenerate(undefined);
      return;
    }
    setDurationModalOpen(true);
  };

  /** 弹窗确认：把选择折算成秒后执行生成。 */
  const confirmDuration = () => {
    const secs =
      durationChoice === 'custom'
        ? Math.max(10, Math.min(600, Number(customDuration) || 90))
        : Number(durationChoice);
    void runGenerate(secs);
  };

  /**
   * 开始编辑某个镜头（草稿初始化，多源读取）。
   */
  const startEdit = (shot: ShotRecord) => {
    setEditingShotId(shot.id);
    setRefsTouched(false);
    setDraft({
      description: getShotDescription(shot),
      visualPrompt: shot.visualPrompt || '',
      shotSize: getShotSizeValue(shot),
      durationSeconds: shot.durationSeconds ?? 0,
      cameraMovement: getCameraMovementValue(shot),
      cameraAngle: getCameraAngleValue(shot),
      dialogue: getShotDialogue(shot),
      referencedAssets: refsDraftFromShot(shot),
      // 结构化提示词 + 参考风格开关（2026-07-28）；经 body.metadata 浅合并落库
      metadata: {
        structuredPrompt: getStructuredPrompt(shot),
        referenceStyle: getReferenceStyle(shot),
      },
    });
  };

  /**
   * 保存编辑（S12，OP1）。
   *
   * URL 改 episode 级；body 直传 draft（含 description/visualPrompt/shotSize/
   * durationSeconds/cameraMovement/dialogue），route 做字段映射：
   *   - visualPrompt/durationSeconds 透传顶层 ShotUpdatePatch
   *   - description/shotSize/cameraMovement/dialogue 映射到 metadata read-merge-write
   *     （route getShot 读现有 metadata → 合并 → patch.metadata，防静默丢字段）
   */
  const handleSave = async (): Promise<boolean> => {
    if (!editingShotId) return false;
    if (!episodeId) {
      toast.error('缺少分集 ID');
      return false;
    }
    setSaving(true);
    try {
      // 未改引用资产时不随 PATCH 发送 referencedAssets（避免改描述/提示词时被既有
      // 陈旧引用名触发路由层名字解析校验 400）。
      const { referencedAssets: _omit, ...restDraft } = draft;
      const body = refsTouched ? draft : restDraft;
      await api(
        `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/shots/${encodeURIComponent(editingShotId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        },
      );
      toast.success('镜头已更新');
      setEditingShotId(null);
      setDraft({});
      setRefsTouched(false);
      onRefresh?.();
      return true;
    } catch (e: unknown) {
      toast.error(`保存失败: ${e instanceof Error ? e.message : '未知错误'}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  // —— 两栏布局：选中组 + 组级（广播）结构化提示词 / 参考风格（2026-07-28）——
  /** 中栏选中的片段(组) key；null → 默认第一组。 */
  const [selectedGroupId, setSelectedGroupId] = React.useState<string | null>(null);
  /** 选中组（groups 为空时 null）。 */
  const selectedGroup = React.useMemo(() => {
    if (groups.length === 0) return null as ShotGroup | null;
    return (groups.find((g) => g.groupKey === selectedGroupId) ?? groups[0]) as ShotGroup;
  }, [groups, selectedGroupId]);
  /** 选中组的镜头（按 shotIndex）。 */
  const selectedGroupShots = React.useMemo(() => {
    if (!selectedGroup) return [] as ShotRecord[];
    return selectedGroup.shotIds
      .map((id) => shots.find((s) => s.id === id))
      .filter((s): s is ShotRecord => Boolean(s));
  }, [selectedGroup, shots]);

  /** 组级参考风格草稿；读首镜，切换即广播。 */
  const [groupRs, setGroupRs] = React.useState<{
    cameraMovement: boolean;
    dialogue: boolean;
    sfx: boolean;
    lighting: boolean;
    artStyle: boolean;
  }>({ cameraMovement: false, dialogue: false, sfx: false, lighting: false, artStyle: false });
  /** 当前正在编辑（=选中）的镜头记录；详情面板渲染用。列表点击或切组时由 startEdit 设 editingShotId。 */
  const editingShot = React.useMemo(
    () => shots.find((s) => s.id === editingShotId) ?? null,
    [shots, editingShotId],
  );

  /** 配置面板滚动容器；切镜时回顶（基本信息/提示词优先可见，避免停在参考资产段）。 */
  const panelRegionRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    panelRegionRef.current?.scrollTo({ top: 0 });
  }, [editingShotId]);

  /** 切换选中组时从首镜同步组级草稿 + 默认选中首镜（仅依赖 groupKey，避免 onRefresh 冲掉正在编辑的输入）。 */
  React.useEffect(() => {
    const first = selectedGroupShots[0];
    if (first) {
      setGroupRs(getReferenceStyle(first));
      // 默认选中首镜 → 下方 FrameOS 配置面板即时可编辑
      startEdit(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroup?.groupKey]);

  /** 把组级 structuredPrompt + referenceStyle 广播到组内所有镜头（route 做 metadata 浅合并）。 */
  const broadcastGroupMeta = React.useCallback(async () => {
    if (!episodeId || selectedGroupShots.length === 0) return;
    try {
      await Promise.all(
        selectedGroupShots.map((shot) =>
          api(
            `/api/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/shots/${encodeURIComponent(shot.id)}`,
            {
              method: 'PATCH',
              body: JSON.stringify({ metadata: { referenceStyle: groupRs } }),
            },
          ),
        ),
      );
      onRefresh?.();
    } catch (e: unknown) {
      toast.error(`组级字段保存失败: ${e instanceof Error ? e.message : '未知错误'}`);
    }
  }, [api, episodeId, projectId, selectedGroupShots, groupRs, onRefresh, toast]);

  /** 组内参考资产并集计数（约束展示用）。 */
  const groupUnionRefs = React.useMemo(() => {
    const chars = new Set<string>();
    const all = new Set<string>();
    for (const s of selectedGroupShots) {
      const r = (s.referencedAssets || {}) as Partial<RefsDraft>;
      for (const n of Array.isArray(r.characters) ? r.characters : []) {
        chars.add(n);
        all.add(n);
      }
      for (const n of Array.isArray(r.environments) ? r.environments : []) all.add(n);
      for (const n of Array.isArray(r.items) ? r.items : []) all.add(n);
    }
    return { characters: chars.size, total: all.size };
  }, [selectedGroupShots]);

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* S1 顶部操作栏 */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-sm font-semibold text-[var(--text)] truncate">
            分镜设计
            {episode?.title && (
              <span className="text-[var(--text-3)] font-normal ml-2">· {episode.title}</span>
            )}
          </h2>
          {shots.length > 0 && (
            <span className="text-xs text-[var(--text-3)] tabular-nums">
              {shots.length} 镜 · {groups.length} 组 · {totalDuration.toFixed(1)}s
            </span>
          )}
          {sourceVideoDurationSeconds && sourceVideoDurationSeconds > 0 ? (
            <span className="text-xs text-[var(--accent)] tabular-nums">
              目标时长：跟随参考视频 {sourceVideoDurationSeconds.toFixed(1)}s
            </span>
          ) : null}
        </div>
       <div className="flex items-center gap-2 flex-shrink-0">
         {shots.length > 0 && (
           <ModelSelector
             models={VIDEO_MODELS}
             value={videoModel}
             onChange={setVideoModel}
             label="视频模型"
           />
         )}
         <span className="text-xs text-[var(--text-3)]">按实际 Token 结算</span>
          <Button
            variant="primary"
            onClick={() => handleGenerate()}
            loading={showGenerating}
            disabled={!episodeId || showGenerating || (!hasScenes && shots.length === 0)}
            title={!hasScenes && shots.length === 0 ? '请先完成编剧分析（生成场景结构）' : undefined}
          >
            {shots.length > 0 ? '重新生成分镜' : '生成分镜'}
          </Button>
          {shots.length > 0 && (
            <Button variant="ghost" onClick={() => setHistoryOpen(true)}>
              历史版本
            </Button>
          )}
          {shots.length > 0 && onNavigateNext && (
            <Button variant="outline" onClick={onNavigateNext}>
              进入生产
            </Button>
          )}
        </div>
      </div>

      {/* S2/S3 主体：生成中进度 / 空状态 / 镜头表格 */}
      <div className="flex-1 flex flex-col min-h-0 px-4 sm:px-6 py-4">
        {showGenerating && (
          <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--action)]/20 bg-[var(--action-dim)]/20 p-4">
            {effectiveShotTaskId ? (
              <GenerationProgress
                taskId={effectiveShotTaskId}
                label="分镜生成中"
                estimatedDuration={120}
                onComplete={() => { setActiveTaskId(null); onRefresh?.(); }}
                onFailure={() => { setActiveTaskId(null); onRefresh?.(); }}
              />
            ) : (
              <ProgressBar
                progress={justCompleted ? 100 : 0}
                label={justCompleted ? '分镜生成完成' : '分镜生成中'}
                pulse={!justCompleted}
                completed={justCompleted}
              />
            )}
            {showReset && (
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  className="text-xs text-[var(--text-3)] underline hover:text-[var(--text-2)]"
                  onClick={() => inflight.reset()}
                >
                  清除生成状态（如已失败/卡住）
                </button>
              </div>
            )}
          </div>
        )}
        {shots.length === 0 ? (
          <EmptyState
            size="lg"
            icon={
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                <path
                  d="M3 3h18v18H3zM9 3v18M15 3v18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            }
            title={showGenerating ? '分镜生成中...' : '尚未生成分镜'}
            description={
              showGenerating
                ? '请稍候，完成后自动刷新'
                : '点击「生成分镜」按钮，AI 将根据剧本拆解镜头序列'
            }
          />
        ) : (
          <div className="flex-1 flex gap-4 min-h-0">
            {/* 中栏：片段(组)卡片列表（浏览，点击选中） */}
            <div className="w-56 shrink-0 min-h-0 overflow-auto pr-2 space-y-2">
              {groups.map((group) => {
                const gShots = group.shotIds
                  .map((id) => shots.find((s) => s.id === id))
                  .filter(Boolean) as ShotRecord[];
                const isSel = (selectedGroupId ?? groups[0]?.groupKey) === group.groupKey;
                const first = gShots[0];
                const segName = first ? getShotGroupName(first) : null;
                // 组序号 + 语义名：computeGroups 的「组 N」做唯一 ordinal，避免多张同名(建场组×3)卡片无法区分。
                const segLabel = segName ? `${group.groupLabel} · ${segName}` : group.groupLabel;
                return (
                  <button
                    key={group.groupKey}
                    type="button"
                    onClick={() => setSelectedGroupId(group.groupKey)}
                    className={cn(
                      'w-full text-left rounded-[var(--radius-lg)] border p-3 transition-colors',
                      isSel
                        ? 'border-[var(--action)] bg-[var(--action-dim)]/30 border-l-[3px] border-l-[var(--action)]'
                        : 'border-[var(--border)] bg-[var(--bg)] hover:border-[var(--border-strong)]',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[var(--accent)] truncate">{segLabel}</span>
                      <span
                        className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded font-mono flex-shrink-0',
                          group.totalDuration > maxGroupDuration
                            ? 'bg-[var(--error)]/20 text-[var(--error)]'
                            : 'bg-[var(--bg-hover)] text-[var(--text-3)]',
                        )}
                      >
                        {group.totalDuration > maxGroupDuration ? '超时' : 'OK'}
                      </span>
                    </div>
                    <div className="text-[11px] text-[var(--text-3)] tabular-nums mt-0.5">
                      {gShots.length} 镜 · {group.totalDuration.toFixed(1)}s → {group.validDuration}s
                    </div>
                    {first && (
                      <div className="text-[11px] text-[var(--text-2)]/80 line-clamp-1 mt-1">
                        {getShotDescription(first) || first.visualPrompt || '—'}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 右栏：选中组编辑器 */}
            <div className="flex-1 min-h-0 flex flex-col pl-2 min-w-0">
              {selectedGroup ? (
                <div className="flex flex-col flex-1 min-h-0 gap-4">
                  {/* 组标题 + 约束 + 参考视频开关（广播到组内所有镜）。原镜头表的琥珀组标题栏已并入此处，避免「组 N · N镜·Xs」两处重复。 */}
                  <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] p-3 space-y-2 shrink-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-semibold text-[var(--text)] truncate">
                          {(selectedGroupShots[0] && getShotGroupName(selectedGroupShots[0])) ||
                            selectedGroup.groupLabel}
                        </span>
                        <span className="text-[11px] text-[var(--text-3)] tabular-nums whitespace-nowrap">
                          {selectedGroupShots.length} 镜 · {selectedGroup.totalDuration.toFixed(1)}s →{' '}
                          {selectedGroup.validDuration}s
                        </span>
                      </div>
                      <span
                        className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded font-mono whitespace-nowrap',
                          selectedGroup.totalDuration > maxGroupDuration
                            ? 'bg-[var(--error)]/20 text-[var(--error)]'
                            : 'bg-[var(--bg-hover)] text-[var(--text-3)]',
                        )}
                      >
                        {selectedGroup.totalDuration > maxGroupDuration ? '超时' : 'OK'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px]">
                      <span
                        className={
                          groupUnionRefs.characters > CONSTRAINT_MAX_CHARACTERS
                            ? 'text-red-400 font-medium'
                            : 'text-[var(--text-3)]'
                        }
                      >
                        角色 {groupUnionRefs.characters}/{CONSTRAINT_MAX_CHARACTERS}
                      </span>
                      <span
                        className={
                          groupUnionRefs.total > CONSTRAINT_MAX_TOTAL
                            ? 'text-red-400 font-medium'
                            : 'text-[var(--text-3)]'
                        }
                      >
                        总参考 {groupUnionRefs.total}/{CONSTRAINT_MAX_TOTAL}
                      </span>
                    </div>
                    <div className="flex items-center flex-wrap gap-1.5">
                      <span className="text-[10px] text-[var(--text-3)]">参考视频</span>
                      {(
                        [
                          ['cameraMovement', '镜运'],
                          ['dialogue', '对白'],
                          ['sfx', '音效'],
                          ['lighting', '光影'],
                          ['artStyle', '画风'],
                        ] as const
                      ).map(([field, label]) => {
                        const on = groupRs[field];
                        return (
                          <button
                            key={field}
                            type="button"
                            onClick={() => {
                              setGroupRs((p) => ({ ...p, [field]: !p[field] }));
                              void broadcastGroupMeta();
                            }}
                            className={cn(
                              'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                              on
                                ? 'border-[var(--action)] bg-[var(--action-dim)] text-[var(--action)]'
                                : 'border-[var(--border-light)] text-[var(--text-3)] hover:border-[var(--action)]/40',
                            )}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 镜头列表（瘦身只读；选中镜在下方面板编辑）。限高滚动 + 表头吸顶。 */}
                  <div className="shrink-0 max-h-[220px] min-h-0 overflow-auto rounded-[var(--radius-lg)] border border-[var(--border-strong)]">
                    <table className="w-full text-sm">
                      <thead className="bg-[var(--bg-hover)] text-[var(--text-3)] text-xs sticky top-0 z-10">
                        <tr>
                          <th className="px-2 py-2 text-left font-medium w-24">#</th>
                          <th className="px-3 py-2 text-left font-medium min-w-[200px]">描述</th>
                          <th className="px-2 py-2 text-left font-medium w-20">景别</th>
                          <th className="px-2 py-2 text-left font-medium w-20">运镜</th>
                          <th className="px-2 py-2 text-left font-medium w-14">时长</th>
                          <th className="px-2 py-2 text-left font-medium w-16">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedGroupShots.map((shot, idx) => {
                          const isSelected = editingShotId === shot.id;
                          const description = getShotDescription(shot);
                          const dialogue = getShotDialogue(shot);
                          return (
                            <tr
                              key={shot.id}
                              onClick={() => startEdit(shot)}
                              className={cn(
                                'border-t border-[var(--border)] cursor-pointer',
                                isSelected
                                  ? 'bg-[var(--action-dim)]'
                                  : 'hover:bg-[var(--bg-hover)]/50',
                              )}
                            >
                              <td className="px-2 py-2 text-[var(--text-3)] tabular-nums whitespace-nowrap overflow-hidden text-ellipsis max-w-[88px]">
                                {formatShotLabel(
                                  episode?.episodeNumber,
                                  getShotGroupName(shot),
                                  shot.shotIndex ?? idx + 1,
                                )}
                              </td>
                              <td className="px-3 py-2 text-[var(--text-2)] align-top">
                                <div className="line-clamp-2 text-[12px] leading-snug">
                                  {shot.visualPrompt || description || '—'}
                                </div>
                                {dialogue ? (
                                  <div className="line-clamp-2 text-[11px] leading-snug text-[var(--accent)] mt-0.5 break-words">
                                    💬 {dialogue}
                                  </div>
                                ) : null}
                              </td>
                              <td className="px-2 py-2 text-[var(--text-2)] text-xs align-top whitespace-nowrap">
                                {getShotSizeValue(shot) || '—'}
                              </td>
                              <td className="px-2 py-2 text-[var(--text-2)] text-xs align-top whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px]">
                                {getCameraMovementValue(shot) || '—'}
                              </td>
                              <td className="px-2 py-2 text-[var(--text-2)] tabular-nums text-xs align-top">
                                {(shot.durationSeconds ?? 0).toFixed(1)}s
                              </td>
                              <td className="px-2 py-2 align-top whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                                <Button
                                  size="sm"
                                  variant={isSelected ? 'primary' : 'ghost'}
                                  onClick={() => startEdit(shot)}
                                >
                                  编辑
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* 选中镜 FrameOS 配置面板（编辑入口；列表行只读，点选/编辑触发）。编辑逻辑沿用 startEdit/handleSave/draft，零数据改动。 */}
                  <div className="flex-1 min-h-0 overflow-auto pb-3" ref={panelRegionRef}>
                    {editingShot ? (
                      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] p-3 space-y-4">
                        {/* 头：镜头标识 + 保存/重置 */}
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-[var(--text)]">
                            {formatShotLabel(
                              episode?.episodeNumber,
                              getShotGroupName(editingShot),
                              editingShot.shotIndex ??
                                selectedGroupShots.findIndex((s) => s.id === editingShot.id) + 1,
                            )}
                          </span>
                          <div className="flex gap-1">
                            <Button size="sm" variant="primary" onClick={() => void handleSave()} loading={saving}>
                              保存
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => startEdit(editingShot)}>
                              重置
                            </Button>
                          </div>
                        </div>

                        {/* 宽屏两栏：左=基本信息+提示词，右=参考资产；窄屏自动单栏 */}
                        <div className="grid gap-4 lg:grid-cols-2 items-start">
                          <div className="space-y-4 min-w-0">
                        {/* 基本信息：景别 / 机位 / 运镜 / 时长 */}
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className="mb-1 block text-[10px] text-[var(--text-3)]">景别</span>
                            <Input
                              value={(draft.shotSize as string) || ''}
                              onChange={(e) => setDraft((d) => ({ ...d, shotSize: e.target.value }))}
                              placeholder="景别"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[10px] text-[var(--text-3)]">机位</span>
                            <Input
                              value={(draft.cameraAngle as string) || ''}
                              onChange={(e) => setDraft((d) => ({ ...d, cameraAngle: e.target.value }))}
                              placeholder="机位"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[10px] text-[var(--text-3)]">运镜</span>
                            <Input
                              value={(draft.cameraMovement as string) || ''}
                              onChange={(e) => setDraft((d) => ({ ...d, cameraMovement: e.target.value }))}
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[10px] text-[var(--text-3)]">时长（秒）</span>
                            <Input
                              type="number"
                              step="0.5"
                              min={MIN_SHOT_DURATION}
                              max={MAX_SHOT_DURATION}
                              value={typeof draft.durationSeconds === 'number' ? draft.durationSeconds : 0}
                              onChange={(e) =>
                                setDraft((d) => ({ ...d, durationSeconds: Number(e.target.value) }))
                              }
                            />
                          </label>
                        </div>

                        {/* 提示词：画面提示词 / 台词（镜头描述字段无用，已移除） */}
                        <div className="space-y-2">
                          <label className="block">
                            <span className="mb-1 block text-[10px] text-[var(--text-3)]">画面提示词</span>
                            <Textarea
                              rows={4}
                              value={(draft.visualPrompt as string) || ''}
                              onChange={(e) => setDraft((d) => ({ ...d, visualPrompt: e.target.value }))}
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[10px] text-[var(--text-3)]">台词（对白）</span>
                            <Textarea
                              rows={2}
                              value={(draft.dialogue as string) || ''}
                              onChange={(e) => setDraft((d) => ({ ...d, dialogue: e.target.value }))}
                            />
                          </label>
                        </div>
                          </div>

                        {/* 参考资产：用量约束 + 引用重绑（角色/说话/造型/场景/道具）+ 改后预览 */}
                        {(() => {
                          const refs =
                            (draft.referencedAssets as RefsDraft | undefined) ?? EMPTY_REFS;
                          const charCount = refs.characters.length;
                          const totalCount =
                            refs.characters.length + refs.environments.length + refs.items.length;
                          const speakingCount = refs.speakingCharacters.length;
                          const charAssets = assets.filter((a) => a.kind === 'CHARACTER');
                          const locAssets = assets.filter((a) => a.kind === 'LOCATION');
                          const propAssets = assets.filter((a) => a.kind === 'PROP');
                          const shotMeta =
                            editingShot.metadata && typeof editingShot.metadata === 'object'
                              ? (editingShot.metadata as Record<string, unknown>)
                              : {};
                          const shotSbTable =
                            shotMeta.storyboardTable && typeof shotMeta.storyboardTable === 'object'
                              ? (shotMeta.storyboardTable as Record<string, unknown>)
                              : {};
                          const previewSceneId =
                            (typeof shotMeta.sceneId === 'string' && shotMeta.sceneId) ||
                            (typeof shotSbTable.sceneId === 'string' && shotSbTable.sceneId) ||
                            '';
                          const preview = resolveShotAssetReferenceBindings(
                            { referencedAssets: refs, metadata: shotMeta, sceneId: previewSceneId },
                            assets,
                            projectId,
                          );
                          const chipClass = (on: boolean) =>
                            cn(
                              'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                              on
                                ? 'border-[var(--action)] bg-[var(--action-dim)] text-[var(--action)]'
                                : 'border-[var(--border-light)] text-[var(--text-3)] hover:border-[var(--action)]/40',
                            );
                          /**
                           * 渲染「造型/变体」单选 chips：为 boundNames 里有多造型（非 default key）的资产渲染。
                           * 无可选变体返回 null（不渲染该行）。角色/场景/道具共用，对齐人物。
                           */
                          const renderCostumeChips = (
                            label: string,
                            boundNames: string[],
                            kindAssets: typeof charAssets,
                            costumes: CharacterCostumeRef[],
                            setter: (name: string, key: string | null) => void,
                          ) => {
                            type Variant = { key: string; label: string; description?: string };
                            const selectable: Array<{ name: string; variants: Variant[] }> = [];
                            for (const name of boundNames) {
                              const a = kindAssets.find((c) => c.name === name);
                              const rawCostumes =
                                a && Array.isArray(a.costumes)
                                  ? (a.costumes as Array<Record<string, unknown>>)
                                  : [];
                              const variants: Variant[] = [];
                              for (const c of rawCostumes) {
                                if (!c || typeof c !== 'object') continue;
                                const k =
                                  typeof (c as { key?: unknown }).key === 'string'
                                    ? ((c as { key: string }).key).trim()
                                    : '';
                                if (!k || isDefaultCostumeKey(k)) continue;
                                const labelRaw = (c as { label?: unknown }).label;
                                const vlabel =
                                  typeof labelRaw === 'string' && labelRaw.trim()
                                    ? labelRaw.trim()
                                    : k;
                                const descRaw = (c as { description?: unknown }).description;
                                const description = typeof descRaw === 'string' ? descRaw : undefined;
                                variants.push({ key: k, label: vlabel, description });
                              }
                              if (variants.length > 0) selectable.push({ name, variants });
                            }
                            if (selectable.length === 0) return null;
                            return (
                              <div className="flex flex-wrap items-start gap-1.5">
                                <span className="w-10 text-[10px] text-[var(--text-3)] pt-0.5">{label}</span>
                                <div className="flex flex-col gap-1 min-w-0 flex-1">
                                  {selectable.map(({ name, variants }) => {
                                    const selected = costumes.find((cc) => cc.name === name)?.costumeKey;
                                    return (
                                      <div key={name} className="flex flex-wrap items-center gap-1">
                                        <span className="text-[10px] text-[var(--text-3)] mr-0.5">{name}</span>
                                        <button
                                          type="button"
                                          onClick={() => setter(name, null)}
                                          className={chipClass(!selected || isDefaultCostumeKey(selected))}
                                          title="默认造型（走自动匹配 / 主图）"
                                        >
                                          默认
                                        </button>
                                        {variants.map((v) => (
                                          <button
                                            key={v.key}
                                            type="button"
                                            onClick={() => setter(name, v.key)}
                                            className={chipClass(selected === v.key)}
                                            title={v.description}
                                          >
                                            {v.label}
                                          </button>
                                        ))}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          };
                          return (
                            <div className="space-y-2">
                              <div className="flex items-center gap-3 text-[10px] px-0.5">
                                <span
                                  className={
                                    charCount > CONSTRAINT_MAX_CHARACTERS
                                      ? 'text-red-400 font-medium'
                                      : 'text-[var(--text-3)]'
                                  }
                                >
                                  角色 {charCount}/{CONSTRAINT_MAX_CHARACTERS}
                                </span>
                                <span
                                  className={
                                    totalCount > CONSTRAINT_MAX_TOTAL
                                      ? 'text-red-400 font-medium'
                                      : 'text-[var(--text-3)]'
                                  }
                                >
                                  总参考 {totalCount}/{CONSTRAINT_MAX_TOTAL}
                                </span>
                                <span className="text-[var(--text-3)]">说话 {speakingCount}</span>
                              </div>
                              <div className="space-y-2 rounded-lg border border-[var(--border-light)] bg-[var(--bg-2)] p-2">
                                <div className="flex items-center gap-2 text-[10px] text-[var(--text-3)]">
                                  <span>引用资产</span>
                                  <span className="text-[var(--text-3)]/70">
                                    点选修正绑定；下方实时预览槽位（图片N→资产图）
                                  </span>
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="w-10 text-[10px] text-[var(--text-3)]">角色</span>
                                  {charAssets.length === 0 ? (
                                    <span className="text-[10px] text-[var(--text-3)]/60">无角色资产</span>
                                  ) : (
                                    charAssets.map((a) => (
                                      <button
                                        key={a.id}
                                        type="button"
                                        onClick={() => toggleRef('characters', a.name)}
                                        className={chipClass(refs.characters.includes(a.name))}
                                      >
                                        {a.name}
                                      </button>
                                    ))
                                  )}
                                </div>
                                {refs.characters.length > 0 && (
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="w-10 text-[10px] text-[var(--text-3)]">说话</span>
                                    {refs.characters.map((name) => (
                                      <button
                                        key={name}
                                        type="button"
                                        onClick={() => toggleSpeaking(name)}
                                        className={chipClass(refs.speakingCharacters.includes(name))}
                                      >
                                        {name}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                {/* 造型/变体选择：角色/场景/道具共用渲染；只有 default 的资产不渲染该行。 */}
                                {renderCostumeChips(
                                  '造型',
                                  refs.characters,
                                  charAssets,
                                  refs.characterCostumes,
                                  setCharacterCostume,
                                )}
                                {locAssets.length > 0 && (
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="w-10 text-[10px] text-[var(--text-3)]">场景</span>
                                    {locAssets.map((a) => (
                                      <button
                                        key={a.id}
                                        type="button"
                                        onClick={() => toggleRef('environments', a.name)}
                                        className={chipClass(refs.environments.includes(a.name))}
                                      >
                                        {a.name}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                {renderCostumeChips(
                                  '变体',
                                  refs.environments,
                                  locAssets,
                                  refs.environmentCostumes,
                                  setEnvironmentCostume,
                                )}
                                {propAssets.length > 0 && (
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="w-10 text-[10px] text-[var(--text-3)]">道具</span>
                                    {propAssets.map((a) => (
                                      <button
                                        key={a.id}
                                        type="button"
                                        onClick={() => toggleRef('items', a.name)}
                                        className={chipClass(refs.items.includes(a.name))}
                                      >
                                        {a.name}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                {renderCostumeChips(
                                  '变体',
                                  refs.items,
                                  propAssets,
                                  refs.itemCostumes,
                                  setItemCostume,
                                )}
                                <div className="border-t border-[var(--border-light)] pt-1.5">
                                  <div className="mb-1 text-[10px] text-[var(--text-3)]">改后绑定预览</div>
                                  {preview.length > 0 ? (
                                    <ShotAssetReferenceBadges references={preview} compact />
                                  ) : (
                                    <span className="text-[10px] text-[var(--text-3)]/60">
                                      未引用任何资产（出片将无参考图）
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-10 text-sm text-[var(--text-3)]">
                        点选上方镜头查看与编辑
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-center py-16 text-sm text-[var(--text-3)]">
                  选择左侧片段查看与编辑
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <Modal
        open={durationModalOpen}
        onClose={(o) => {
          if (!showGenerating) setDurationModalOpen(o);
        }}
        title="分镜总时长"
        description="选择本集分镜的目标总时长。有参考视频时自动跟随参考视频，无需选择。"
        maxWidthClassName="max-w-md"
      >
        <div className="space-y-2">
          {DURATION_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2 text-sm text-[var(--text-2)] cursor-pointer"
            >
              <input
                type="radio"
                name="duration-choice"
                value={opt.value}
                checked={durationChoice === opt.value}
                onChange={() => setDurationChoice(opt.value)}
              />
              {opt.label}
            </label>
          ))}
          {durationChoice === 'custom' && (
            <div className="flex items-center gap-2 pl-6">
              <Input
                type="number"
                min={10}
                max={600}
                step={5}
                value={customDuration}
                onChange={(e) => setCustomDuration(e.target.value)}
                className="w-28"
              />
              <span className="text-xs text-[var(--text-3)]">秒（10–600）</span>
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => setDurationModalOpen(false)}
            disabled={showGenerating}
          >
            取消
          </Button>
          <Button variant="primary" onClick={() => confirmDuration()} loading={showGenerating}>
            确认生成
          </Button>
        </div>
      </Modal>
      <StoryboardVersionHistory
        open={historyOpen}
        onClose={setHistoryOpen}
        projectId={projectId}
        episodeId={episodeId}
        api={api}
        onRestored={() => {
          onRefresh?.();
        }}
      />
    </div>
  );
}
