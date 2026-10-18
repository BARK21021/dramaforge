// ============================================================
// POST /api/projects/[id]/export-film — 成片导出（批7 Step 4）
// ============================================================
//
// 把单集/项目下所有已完成镜头（currentMaterialUrl 非空）拼成 CONCAT render_job。
// 客户端 render-worker 拉取该 job → executor.ts CONCAT case 写本地
// filmsDir/<jobId>.mp4 → result.outputUrl(sf-asset://)。
//
// 镜像 app1 `F:\app1\src\app\api\projects\[projectId]\export-film\route.ts`
// (128 行) 简化版：
//   - 不加 outputUploadUrl（dramaforge OP1 / dramaforge-assets-client-local）
//   - 不创建 BullMQ FILM_EXPORT task（dramaforge 用 CONCAT render_job + 客户端 worker）
//   - 镜头查询用 dramaforge listShots（与 chain-generate route 同款）
//   - 入参仅 episodeId（可选；不传则取该集所有完成镜头——dramaforge 单集作用域，
//     不像 app1 支持项目级跨集导出；episodeId 留作兼容字段）
//
// 鉴权：session REQUIRED。响应：
//   200 { success:true, data: { renderJobId, taskId, shotCount } }
//   400 NO_COMPLETED_SHOTS / 401 / 404 / 500
// web 禁止 import ffmpeg。
// ============================================================

import type { NextRequest } from 'next/server';
import {
  buildEpisodeConcatClips,
  dispatchFilmExport,
  episodeRepo,
  projectRepo,
  listShots,
} from '@dramaforge/server';
import { genId } from '@dramaforge/shared';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;

    // ownership
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    // 可选 episodeId（dramaforge 作用域：单集；不传则尝试项目级，但 listShots 需要 episodeId
    // — 兼容字段，未传时仍尝试拿 episode.first 或返 400）
    let body: { episodeId?: unknown } = {};
    try {
      const raw = (await req.json()) as unknown;
      body = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { episodeId?: unknown })
        : {};
    } catch {
      body = {};
    }
    const episodeId =
      typeof body.episodeId === 'string' && body.episodeId.length > 0
        ? body.episodeId
        : undefined;

    let episode: Awaited<ReturnType<typeof episodeRepo.getById>> = null;
    if (episodeId) {
      episode = await episodeRepo.getById(episodeId);
      if (!episode || episode.projectId !== projectId) {
        return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
      }
    }

    // 查已完成镜头（currentMaterialUrl 非空 + COMPLETED）。
    // episodeId 必填校验：dramaforge 单集作用域（缺则 400 提示）。
    if (!episodeId) {
      return apiFail(
        { error: '请指定要导出的分集', code: 'EPISODE_REQUIRED' },
        400,
      );
    }
    const allShots = await listShots(projectId, episodeId);
    const completedShots = allShots.filter(
      (s) => s.videoStatus === 'COMPLETED' && !!s.currentMaterialUrl,
    );

    if (completedShots.length === 0) {
      return apiFail(
        {
          error: '没有可导出的镜头，请先生成视频（至少需要一个已生成视频的镜头）',
          code: 'NO_COMPLETED_SHOTS',
        },
        400,
      );
    }

    // 组装 CONCAT input。outputUploadUrl 不设（OP1 本地写）。
    // currentMaterialUrl 在 dramaforge 是 sf-asset://（Electron protocol）— 客户端
    // render-worker 在主进程内可直接 fetch（net.fetch 在 registerAssetProtocol
    // 中已挂载）。
    // 批8 R6: filmMeta 透传到 input JSONB —— films GET route 提取做项目过滤 +
    // 卡片展示。客户端 executor 不读此字段，行为零影响。
    //
    // chain-generate 是组视频架构：组内每个镜头的 currentMaterialUrl 指向同一个
    // 组视频。必须按 url 去重，否则同一组视频会被 concat N 次（N=组内镜头数），
    // 导致成片时长膨胀 + 画面重复（用户报「显示 2 分钟导出 8 分钟、全是重复镜头」）。
    // buildEpisodeConcatClips 与自动成片路径 (maybeCreateEpisodeConcat) 共用同一
    // 去重逻辑，保证手动导出与自动成片行为一致。
    const orderedShots = [...completedShots].sort(
      (a, b) => (a.sortOrder - b.sortOrder) || (a.shotIndex - b.shotIndex),
    );
    const totalDuration = orderedShots.reduce(
      (sum, s) => sum + (s.durationSeconds ?? 0),
      0,
    );
    const input = {
      clips: buildEpisodeConcatClips(orderedShots),
      filmMeta: {
        projectId,
        episodeId,
        episodeNumber: episode?.episodeNumber ?? null,
        episodeTitle: episode?.title ?? null,
        projectTitle: project.title ?? null,
        shotCount: orderedShots.length,
        totalDuration,
      },
    };

    const taskId = genId();
    const job = await dispatchFilmExport(taskId, auth.userId, input);

    return apiSuccess({
      renderJobId: job.id,
      taskId,
      shotCount: completedShots.length,
    });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/export-film');
  }
}
