// ============================================================
// POST /api/projects/[id]/video-split — 长视频按时长拆多集（转绘 X4.3）
// ============================================================
//
// 对齐 app1 api/projects/[projectId]/video-split/route.ts，但 **C/S 架构差异**：
//
//   app1：multipart 上传视频字节到服务器 tmpdir → 服务器 ffmpeg getVideoDuration +
//         splitVideoByDuration → 同步建 N 集 → 同步返回片段路径（服务器持字节+跑 ffmpeg）
//   dramaforge：服务器禁跑 ffmpeg + 字节不落服务器（dramaforge-assets-client-local）。Electron
//         客户端本地 probe duration+size 后，调本端点（**纯元数据**）：
//           1. expectedCount = ceil(totalDurationSec / segmentSec)
//           2. 同步预建 N 集（episodeRepo.create，title 含时间区间）
//           3. dispatchVideoSplit 派 SPLIT_BY_DURATION render_job（input 带 episodeIds
//              供 client render-worker 后续把片段路径回写到对应 episode）
//           4. project.scriptData.videoSplit 持久化 {taskId, episodeIds, segmentSec,
//              expectedCount, totalDurationSec} 供 UI 追踪 + client 完成后对账
//           5. 返回 {renderJobId, taskId, episodeIds, segmentCount, segmentSec, ...}
//         实际切片由 client render-worker 异步执行（executor SPLIT_BY_DURATION case
//         已就绪）；片段本地路径在 client，server 只持元数据。
//
// 与 app1 的语义差异（诚实记录）：
//   - app1 同步返回 segmentPath；dramaforge 异步，片段路径在 client 侧（UI 订阅 SSE 拿完成
//     事件后由 client/UI 把路径写回 episode，属 X4.3 client 收尾，非本 route 范畴）
//   - expectedCount 是预估值；ffmpeg 按关键帧切，实际片段数可能 ±1。UI 须按实际
//     outputs.length 容错（多余 episode 标空 / 缺的补或删）
//
// Body: { videoUrl, filename, totalBytes, totalDurationSec, segmentSec? }
// 鉴权 + ownership：requireUser → projectRepo.getById → 校验 userId（不限制 category）。
// 响应：200 { success:true, data:{ renderJobId, taskId, episodeIds, segmentCount,
//                              segmentSec, totalDurationSec } }
//       400 INVALID_FILE_TYPE / SEGMENTS_OVER_LIMIT / INVALID_SEGMENT_SEC / 404
// web 禁止 import ffmpeg（duration/size 由客户端 probe 后传入）。
// ============================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { projectRepo, episodeRepo, dispatchVideoSplit } from '@dramaforge/server';
import { genId } from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

/** 允许的视频扩展名（basename 防路径穿越；mkv MIME 常缺失故只认扩展名）。 */
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv']);

/** 默认每段时长 90 秒（1min30s，对齐 app1 DEFAULT_SEGMENT_SEC）。 */
const DEFAULT_SEGMENT_SEC = 90;
/** 每段时长合法区间（对齐 app1 10-3600s）。 */
const MIN_SEGMENT_SEC = 10;
const MAX_SEGMENT_SEC = 3600;
/**
 * 单次拆分集数上限。app1 无上限，但 dramaforge 同步预建 N 集（每集一次 DB 往返），且
 * 短剧实际场景 << 此值；超限时引导用户调大 segmentSec，防误配炸出几千集。
 */
const MAX_EPISODES_PER_SPLIT = 200;

const splitBodySchema = z.object({
  videoUrl: z.string().min(1),
  filename: z.string().min(1),
  totalBytes: z.number().int().positive(),
  totalDurationSec: z.number().positive(),
  segmentSec: z.number().int().min(MIN_SEGMENT_SEC).max(MAX_SEGMENT_SEC).optional(),
});

/** 格式化秒为 HH:MM:SS 或 MM:SS（对齐 app1 formatTimeRange）。 */
function formatTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    let parsed: z.infer<typeof splitBodySchema>;
    try {
      const raw = (await req.json()) as unknown;
      parsed = splitBodySchema.parse(raw);
    } catch (err) {
      if (err instanceof z.ZodError) return handleApiError(err);
      return apiFail({ error: '无效 JSON', code: 'INVALID_JSON' }, 400);
    }

    // 扩展名校验（basename 防路径穿越）。
    const filename = parsed.filename.split(/[\\/]/).pop() ?? parsed.filename;
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
      return apiFail(
        { error: '仅支持 MP4 / WebM / MOV / MKV 视频', code: 'INVALID_FILE_TYPE' },
        400,
      );
    }

    const segmentSec = parsed.segmentSec ?? DEFAULT_SEGMENT_SEC;
    const expectedCount = Math.ceil(parsed.totalDurationSec / segmentSec);
    if (expectedCount > MAX_EPISODES_PER_SPLIT) {
      return apiFail(
        {
          error: `拆分集数 ${expectedCount} 超过上限 ${MAX_EPISODES_PER_SPLIT}，请调大每段时长（segmentSec）`,
          code: 'SEGMENTS_OVER_LIMIT',
        },
        400,
      );
    }

    // 预建 N 集（顺序 await；episodeRepo.create 内部查 max(episodeNumber) 自增，
    // 顺序调用保证集号连续 N, N+1, ...）。title 含预期时间区间供 UI 展示。
    const episodeIds: string[] = [];
    for (let i = 0; i < expectedCount; i += 1) {
      const startSec = i * segmentSec;
      const endSec = Math.min((i + 1) * segmentSec, parsed.totalDurationSec);
      const created = await episodeRepo.create(projectId, {
        title: `第 ${i + 1} 段 (${formatTime(startSec)}-${formatTime(endSec)})`,
      });
      episodeIds.push(created.id);
    }

    const taskId = genId();
    const job = await dispatchVideoSplit(taskId, auth.userId, {
      videoUrl: parsed.videoUrl,
      durationSec: segmentSec,
      outputPrefix: `${projectId}/${taskId}`,
      episodeIds,
    });

    // 持久化拆分元数据（scriptData 浅合并；供 UI 追踪 + client 完成后对账 episodeIds）。
    await projectRepo.update(projectId, {
      scriptData: {
        videoSplit: {
          taskId,
          renderJobId: job.id,
          episodeIds,
          segmentSec,
          expectedCount,
          totalDurationSec: parsed.totalDurationSec,
          startedAt: new Date().toISOString(),
        },
      },
    });

    return apiSuccess({
      renderJobId: job.id,
      taskId,
      episodeIds,
      segmentCount: expectedCount,
      segmentSec,
      totalDurationSec: parsed.totalDurationSec,
    });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/video-split');
  }
}
