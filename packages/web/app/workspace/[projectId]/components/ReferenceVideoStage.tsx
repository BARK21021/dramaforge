// ============================================================
// ReferenceVideoStage — 海外转绘（参考视频 REFERENCE_VIDEO）输入阶段
// ============================================================
//
// 流程（桌面客户端，浏览器禁用）：
//   1. 上传原视频 → sf.stageOriginalVideo（本地暂存，字节不上网）
//   2. 场景切割 → sf.cutReferenceVideo（ffmpeg，≤15s、720p 封顶，本地）
//   3. 切片直传 → POST /api/storage/presign 拿 presigned PUT URL →
//      sf.uploadReferenceClips（main 流式 PUT MinIO，零服务器字节）
//   4. 落库元数据 → POST /api/projects/[id]/reference-video/clips
//   5. kimi 转剧本（模型可选 K2.6/K2.7 Code/K3）→ video-to-script-full
//   6. kimi 资产提取（同一下拉模型）→ whole-script-asset-extraction
//
// 生成阶段由 chain-generate 按场景对齐切片做 video-to-video 转绘（ProductionStage）。
// ============================================================

'use client';

import React from 'react';
import {
  VIDEO_TO_SCRIPT_MODELS,
  DEFAULT_VIDEO_TO_SCRIPT_MODEL,
} from '../../../../lib/models';
import { LanguageMenu } from './LanguageMenu';
import type { TargetLanguage } from '@dramaforge/server/prompt';
import { setTaskId } from '../../../../lib/episode-task-store';
import { GenerationProgress } from '../../../../components/features/GenerationProgress';
import { useEpisodeTask } from '../../../../hooks/useEpisodeTask';

const ALLOWED_EXT = ['mp4', 'webm', 'mov', 'mkv'];
/** 本地暂存上限 3GiB（对齐 original-uploads；本地不传云端，无网络限制）。 */
const MAX_VIDEO_BYTES = 3 * 1024 * 1024 * 1024;

interface SfShellLite {
  isElectron?: boolean;
  stageOriginalVideo(input: { file: File; filename: string }): Promise<{
    outcome: 'staged' | 'cancelled';
    videoUrl?: string;
    totalDurationSec?: number;
    error?: { code: string; message: string };
  }>;
  cutReferenceVideo(input: { videoPath: string; maxHeight?: number }): Promise<{
    ok: boolean;
    clips?: Array<{ path: string; startSec: number; endSec: number; durationSec: number; height: number }>;
    sourceDurationSec?: number;
    error?: { code: string; message: string };
  }>;
  onCutReferenceVideoProgress(cb: (p: { stage: string; done: number; total: number }) => void): () => void;
  uploadReferenceClips(input: {
    clips: Array<{ path: string; presignUrl: string }>;
  }): Promise<{ ok: boolean; uploaded?: number; errors?: Array<{ path: string; message: string }> }>;
  onUploadReferenceClipsProgress(cb: (p: { done: number; total: number }) => void): () => void;
}

type Phase =
  | 'idle'        // 未上传
  | 'staged'      // 已暂存本地，待切割
  | 'cutting'     // 场景切割中
  | 'uploading'   // 切片直传 MinIO
  | 'saved'       // 切片元数据已落库，待转剧本
  | 'scripting'   // kimi 转剧本 + 资产提取
  | 'done';

export function ReferenceVideoStage({
  projectId,
  episodeId,
  projectTitle,
  api,
  onNavigateNext,
  onRefresh,
}: {
  projectId: string;
  episodeId: string;
  projectTitle: string;
  api: (url: string, options?: RequestInit) => Promise<any>;
  onNavigateNext?: () => void;
  onRefresh?: () => void;
}) {
  const sf = React.useMemo<SfShellLite | null>(() => {
    if (typeof window === 'undefined') return null;
    const shell = (window as unknown as { sfShell?: SfShellLite }).sfShell;
    return shell?.isElectron ? shell : null;
  }, []);

  const [videoModel, setVideoModel] = React.useState<string>(DEFAULT_VIDEO_TO_SCRIPT_MODEL);
  const [targetLanguage, setTargetLanguage] = React.useState<TargetLanguage | null>(null);
  const [progressLabel, setProgressLabel] = React.useState('');
  const [k3TaskId, setK3TaskId] = React.useState<string | null>(null);
  // 刷新恢复：从 localStorage 读 STORY_ANALYZE taskId（K3 分析也用这个 key）。
  const recoverTask = useEpisodeTask(episodeId, 'STORY_ANALYZE');
  React.useEffect(() => {
    if (recoverTask.taskId && recoverTask.status === 'RUNNING' && !k3TaskId) {
      setK3TaskId(recoverTask.taskId);
      setPhase('scripting');
    }
  }, [recoverTask.taskId, recoverTask.status, k3TaskId]);
  const [phase, setPhaseRaw] = React.useState<Phase>('idle');
  const [phaseRestored, setPhaseRestored] = React.useState(false);

  // Wrap setPhase to persist to server
  const setPhase = React.useCallback((p: Phase) => {
    setPhaseRaw(p);
    // Best-effort persist (fire-and-forget, errors silently ignored)
    api('/api/projects/' + encodeURIComponent(projectId) + '/reference-video/clips', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: p }),
    }).catch(() => {});
  }, [api, projectId]);

  // On mount: restore phase from server
  React.useEffect(() => {
    let cancelled = false;
    api('/api/projects/' + encodeURIComponent(projectId)).then((data) => {
      if (cancelled) return;
      const rv = data?.scriptData?.referenceVideo;
      if (rv && typeof rv.phase === 'string') {
        const valid: Phase[] = ['idle','staged','cutting','uploading','saved','scripting','done'];
        if (valid.includes(rv.phase)) {
          setPhaseRaw(rv.phase as Phase);
        }
      }
      setPhaseRestored(true);
    }).catch(() => setPhaseRestored(true));
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Visual stepper definition
  const STEPS: Array<{ key: Phase; label: string }> = [
    { key: 'staged', label: '上传视频' },
    { key: 'cutting', label: '场景切割' },
    { key: 'uploading', label: '上传切片' },
    { key: 'saved', label: '元数据落库' },
    { key: 'scripting', label: 'K3 分析' },
    { key: 'done', label: '完成' },
  ];
  const stepOrder: Record<Phase, number> = {
    idle: -1, staged: 0, cutting: 1, uploading: 2, saved: 3, scripting: 4, done: 5,
  };
  const currentStepIdx = stepOrder[phase];
  const [error, setError] = React.useState<string>('');
  const [filename, setFilename] = React.useState('');
  const [videoPath, setVideoPath] = React.useState('');
  const [sourceDurationSec, setSourceDurationSec] = React.useState(0);
  const [clips, setClips] = React.useState<
    Array<{ path: string; startSec: number; endSec: number; durationSec: number; height: number }>
  >([]);
  const [cutProgress, setCutProgress] = React.useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [uploadProgress, setUploadProgress] = React.useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [working, setWorking] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // 切割进度订阅（组件卸载自动取消）。
  React.useEffect(() => {
    if (!sf) return undefined;
    const offCut = sf.onCutReferenceVideoProgress((p) => {
      setCutProgress({ done: p.done, total: p.total });
      if (p.stage === 'cutting') setPhase('cutting');
    });
    const offUpload = sf.onUploadReferenceClipsProgress((p) => {
      setUploadProgress(p);
    });
    return () => {
      offCut();
      offUpload();
    };
  }, [sf]);

  const handleFile = async (file: File): Promise<void> => {
    if (!sf) return;
    setError('');
    const lower = file.name.toLowerCase();
    if (!ALLOWED_EXT.some((ext) => lower.endsWith(ext))) {
      setError('仅支持 MP4 / WebM / MOV / MKV 视频');
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      setError('视频过大（上限 3GB）');
      return;
    }
    setFilename(file.name);
    setWorking(true);
    try {
      const staged = await sf.stageOriginalVideo({ file, filename: file.name });
      if (staged.outcome !== 'staged' || !staged.videoUrl) {
        setError(staged.error?.message ?? '本地暂存失败');
        setPhase('idle');
        return;
      }
      setVideoPath(staged.videoUrl);
      setSourceDurationSec(staged.totalDurationSec ?? 0);
      setPhase('staged');
    } finally {
      setWorking(false);
    }
  };

  const handleCut = async (): Promise<void> => {
    if (!sf || !videoPath) return;
    setError('');
    setWorking(true);
    setPhase('cutting');
    setCutProgress({ done: 0, total: 0 });
    try {
      const result = await sf.cutReferenceVideo({ videoPath, maxHeight: 720 });
      if (!result.ok || !result.clips) {
        setError(result.error?.message ?? '切割失败');
        setPhase('staged');
        return;
      }
      if (result.clips.length === 0) {
        setError('未切割出任何切片');
        setPhase('staged');
        return;
      }
      setClips(result.clips);
      if (result.sourceDurationSec && result.sourceDurationSec > 0) {
        setSourceDurationSec(result.sourceDurationSec);
      }
      setCutProgress({ done: result.clips.length, total: result.clips.length });
      await handleUpload(result.clips);
    } finally {
      setWorking(false);
    }
  };

  const handleUpload = async (
    cutClips: Array<{ path: string; startSec: number; endSec: number; durationSec: number; height: number }>,
  ): Promise<void> => {
    if (!sf) return;
    setPhase('uploading');
    setUploadProgress({ done: 0, total: cutClips.length });
    // 1) presigned PUT URL. api() returns parsed data or null, not a Response.
    const presignData = await api(`/api/storage/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, count: cutClips.length }),
    });
    if (!presignData || !presignData.keys || !presignData.urls) {
      setError('presign 失败，请确认存储后端可用（MinIO）');
      setPhase('staged');
      return;
    }
    const { keys, urls } = presignData;

    // 2) main 进程流式 PUT（内存恒定）。
    const uploadRes = await sf.uploadReferenceClips({
      clips: cutClips.map((clip, i) => ({ path: clip.path, presignUrl: urls[i] })),
    });
    if (!uploadRes.ok) {
      setError(
        `切片上传失败 ${uploadRes.uploaded ?? 0}/${cutClips.length}：${
          uploadRes.errors?.map((e) => e.message).join('；') ?? ''
        }`,
      );
      setPhase('staged');
      return;
    }
    setUploadProgress({ done: cutClips.length, total: cutClips.length });

    // 3) zero-byte metadata persist.
    const clipsData = await api(`/api/projects/${projectId}/reference-video/clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clips: cutClips.map((clip, i) => ({
          index: i,
          startSec: clip.startSec,
          endSec: clip.endSec,
          durationSec: clip.durationSec,
          fileKey: keys[i],
          height: clip.height,
        })),
        sourceDurationSec,
      }),
    });
    if (!clipsData) {
      setError('切片元数据落库失败');
      setPhase('staged');
      return;
    }
    setPhase('saved');
    onRefresh?.();
  };

  const handleScript = async (): Promise<void> => {
    setError('');
    setWorking(true);
    setPhase('scripting');
    setProgressLabel('正在分析视频…');
    try {
      let file = fileInputRef.current?.files?.[0];
      if (!file) {
        setError('视频文件已丢失，请重新选择');
        setPhase('saved');
        return;
      }
      try {
        const sf = (window as unknown as { sfShell?: { preprocessVideoForUpload?: (f: File) => Promise<{ ok: boolean; file?: Uint8Array; filename?: string }> } }).sfShell;
        if (sf?.preprocessVideoForUpload) {
          const pre = await sf.preprocessVideoForUpload(file);
          if (pre.ok && pre.file) {
            file = new File([pre.file as BlobPart], pre.filename || 'video-480p.mp4', { type: 'video/mp4' });
          }
        }
      } catch { /* 预处理失败用原文件 */ }

      // 1) 视频分析：结构化逐镜头表 + DeepSeek 翻译到目标语言 + 创建 episode + 填 scenes/referenceVideoShots
      const form = new FormData();
      form.append('video', file);
      form.append('model', videoModel);
      form.append('episodeId', episodeId);
      if (targetLanguage) {
        form.append('targetLanguage', targetLanguage.en);
      }
      const k3Res = await api(`/api/projects/${projectId}/reference-video/k3-analyze`, {
        method: 'POST',
        body: form,
      });
      if (!k3Res || !k3Res.taskId) {
        setError('分析失败，请检查余额与文件大小');
        setPhase('saved');
        return;
      }
      // k3-analyze 现在返回 202 + taskId（异步后台跑），存 taskId 驱动 GenerationProgress
      setK3TaskId(k3Res.taskId);
      setTaskId('STORY_ANALYZE', episodeId, k3Res.taskId);

      // 资产提取在 K3 完成（GenerationProgress onComplete）后再跑，不在此阻塞。
    } finally {
      setWorking(false);
      setProgressLabel('');
    }
  };


  if (!sf) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-[var(--text-2)]">
        <div>参考视频转绘需要桌面客户端（Electron）才能在本机切割原视频。</div>
        <div className="text-xs text-[var(--text-3)]">
          请下载并登录 DramaForge 桌面客户端后重新打开本项目。
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-[var(--text-1)]">
          参考视频转绘 · {projectTitle}
        </h2>
        <span className="text-xs text-[var(--text-3)]">
          {clips.length > 0 ? `已切割 ${clips.length} 个场景切片（≤15s，720p）` : '原片在本机切割，切片直传对象存储'}
        </span>
      </div>

      {/* 持久化进度条 */}
      {currentStepIdx >= 0 && (
        <div className="flex items-center gap-1 px-4 sm:px-6 py-3 border-b border-[var(--border-light)] flex-shrink-0 overflow-x-auto">
          {STEPS.map((step, i) => {
            const isDone = i < currentStepIdx;
            const isActive = i === currentStepIdx;
            return (
              <React.Fragment key={step.key}>
                <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                  isActive ? 'bg-[var(--action-dim)] text-[var(--action)]' :
                  isDone ? 'text-[var(--text-2)]' :
                  'text-[var(--text-3)] opacity-50'
                }`}>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                    isDone ? 'bg-[var(--action)] text-white' :
                    isActive ? 'bg-[var(--action)] text-white' :
                    'bg-[var(--bg-hover)] text-[var(--text-3)]'
                  }`}>
                    {isDone ? '✓' : i + 1}
                  </span>
                  {step.label}
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`w-4 h-px ${isDone ? 'bg-[var(--action)]' : 'bg-[var(--border-light)]'}`} />
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}

      {/* 步骤 1：选择原视频 */}
      <div className="rounded-xl border border-[var(--border-light)] bg-[var(--bg)] p-4">
        <div className="mb-2 text-sm font-medium text-[var(--text-1)]">① 选择原视频</div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp4,.webm,.mov,.mkv,video/*"
          className="block w-full text-sm text-[var(--text-2)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--action)] file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:opacity-90"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
          disabled={working}
        />
        {filename && (
          <div className="mt-2 text-xs text-[var(--text-3)]">
            {filename}（{sourceDurationSec > 0 ? `${sourceDurationSec.toFixed(1)}s` : '时长未知'}）
          </div>
        )}
        {phase === 'idle' && !error && (
          <div className="mt-2 text-xs text-[var(--text-3)]">
            选择后先暂存本机（不上传云端），再切割场景。
          </div>
        )}
      </div>

      {/* 步骤 2：切割 + 直传 */}
      {(phase === 'staged' || phase === 'cutting' || phase === 'uploading' || phase === 'saved' || phase === 'scripting' || phase === 'done') && (
        <div className="rounded-xl border border-[var(--border-light)] bg-[var(--bg)] p-4">
          <div className="mb-2 text-sm font-medium text-[var(--text-1)]">② 场景切割与直传</div>
          {phase === 'staged' && (
            <button
              type="button"
              onClick={() => void handleCut()}
              disabled={working}
              className="rounded-md bg-[var(--action)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              开始场景切割
            </button>
          )}
          {phase === 'cutting' && (
            <div className="text-xs text-[var(--text-2)]">
              场景检测与切割中… {cutProgress.done}/{cutProgress.total}
            </div>
          )}
          {phase === 'uploading' && (
            <div className="text-xs text-[var(--text-2)]">
              切片直传对象存储… {uploadProgress.done}/{uploadProgress.total}
            </div>
          )}
          {(phase === 'saved' || phase === 'scripting' || phase === 'done') && (
            <div className="text-xs text-[var(--text-2)]">
              ✓ 已切割 {clips.length} 片并直传完成（每片 ≤15s / 720p）
            </div>
          )}
        </div>
      )}

      {/* 步骤 3：视频转剧本 + 资产提取 */}
      {(phase === 'saved' || phase === 'scripting' || phase === 'done') && (
        <div className="rounded-xl border border-[var(--border-light)] bg-[var(--bg)] p-4">
          <div className="mb-2 text-sm font-medium text-[var(--text-1)]">③ 视频转剧本与资产提取</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--text-3)] whitespace-nowrap">AI 模型</span>
            <select
              value={videoModel}
              onChange={(e) => setVideoModel(e.target.value)}
              disabled={working || phase === 'done'}
              className="input-base px-3 py-1.5 rounded-lg text-xs cursor-pointer disabled:opacity-50"
              aria-label="视频转剧本模型"
            >
              {VIDEO_TO_SCRIPT_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}（{m.hint}）
                </option>
              ))}
            </select>
            <span className="text-xs text-[var(--text-3)] whitespace-nowrap">目标语言</span>
            <LanguageMenu
              value={targetLanguage}
              onChange={(lang) => setTargetLanguage(lang)}
              disabled={working || phase === 'done'}
            />
            {phase === 'saved' && (
              <button
                type="button"
                onClick={() => void handleScript()}
                disabled={working}
                className="rounded-md bg-[var(--action)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                转剧本 + 分析 + 资产提取
              </button>
            )}
            {phase === 'scripting' && (
              k3TaskId ? (
                <GenerationProgress
                  taskId={k3TaskId}
                  label="分析中"
                  estimatedDuration={180}
                  onComplete={() => {
                    setK3TaskId(null);
                    setPhase('done');
                    // K3 完成后跑资产提取
                    void api(`/api/projects/${projectId}/whole-script-asset-extraction`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash' }),
                    }).then(() => {
                      onRefresh?.();
                      onNavigateNext?.();
                    }).catch(() => {
                      onRefresh?.();
                      onNavigateNext?.();
                    });
                  }}
                  onFailure={() => { setK3TaskId(null); setPhase('saved'); }}
                />
              ) : (
                <span className="text-xs text-[var(--text-2)]">{progressLabel || '处理中…'}</span>
              )
            )}
            {phase === 'done' && (
              <span className="text-xs text-[var(--text-2)]">✓ 完成，可进入分镜与生成</span>
            )}
          </div>
          <div className="mt-2 text-xs text-[var(--text-3)]">
            AI 分析视频生成剧本 → 按目标语言转风格 → 结构化分析（场景/角色/信息点）→ 自动提取海外资产。目标语言为「无」时保留原语言，不全转英文。
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-[var(--danger-border, #fca5a5)] bg-[var(--danger-bg, #fef2f2)] px-4 py-2 text-sm text-[var(--danger, #dc2626)]">
          {error}
        </div>
      )}
    </div>
  );
}
