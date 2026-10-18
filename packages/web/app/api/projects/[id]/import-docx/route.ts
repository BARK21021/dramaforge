// ============================================================
// POST /api/projects/[id]/import-docx — docx 文本导入（批3 Step 4）
// ============================================================
//
// 上传 .docx → mammoth 提取纯文本 → 返回给前端填入 novelText 编辑框。
// 本接口不落盘文件、不写 DB —— 纯「解析→返文本」。前端拿到文本后再走
// PATCH /api/projects/[id]/episodes/[episodeId] 把 novelText 持久化。
//
// GC 翻译（dramaforge-assets-client-local）：
//   .docx 不是媒体资产（是剧本源文档）；服务器内存解析后丢弃字节，只把
//   提取的纯文本返回。不在 MinIO/磁盘/DB 持久化 .docx 字节。
//
// GC 翻译（prefer-better-lib-not-selfbuilt）：
//   mammoth 是 app1 已验证的 docx 解析库，纯 JS 无原生二进制，直接用。
//
// 鉴权：session REQUIRED + 项目 ownership。
// 响应（UI-facing envelope）：
//   200 { success:true, data: { text: string, chars: number } }
//   400 INVALID_FILE_TYPE / FILE_TOO_LARGE / EMPTY_DOC / NO_FILE
//   401 UNAUTHORIZED / 404 NOT_FOUND / 500 INTERNAL_ERROR
//
// body size limit：Next.js 14+ app router 默认 1MB；route 内
// `export const runtime/maxDuration/dynamic` + mammoth 内存解析应对
// 20MB 上限。若实测仍超限，在 next.config.mjs 加 bodySizeLimit。
// web 禁止 import ffmpeg。零 ffmpeg 依赖。
// ============================================================

import type { NextRequest } from 'next/server';
import mammoth from 'mammoth';
import { projectRepo } from '@dramaforge/server';
import { requireUser, AuthError } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** 最大 20MB（剧本 docx 一般远小于此） */
const MAX_DOCX_SIZE = 20 * 1024 * 1024;

/**
 * POST /api/projects/[id]/import-docx
 *
 * 解析上传的 .docx，返回提取的纯文本。文本保留段落换行（mammoth 以空行分隔段落）。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await requireUser();
    if (!auth) throw new AuthError('未登录或登录已过期', 401, 'UNAUTHORIZED');

    const { id: projectId } = await params;

    // ownership 校验：项目归属，统一 404（不区分"不存在"与"无权"，避免泄露存在性）
    const project = await projectRepo.getById(projectId);
    if (!project || project.userId !== auth.userId) {
      return apiFail({ error: '不存在或无权访问', code: 'NOT_FOUND' }, 404);
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return apiFail({ error: '未提供文件', code: 'NO_FILE' }, 400);
    }

    // 类型校验：必 .docx 后缀（.doc 旧格式不支持，mammoth 仅处理 .docx）
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith('.docx')) {
      return apiFail(
        {
          error: '仅支持 .docx 格式（.doc 旧格式请先另存为 .docx 后上传）',
          code: 'INVALID_FILE_TYPE',
        },
        400,
      );
    }
    // 大小校验：≤ 20MB
    if (file.size > MAX_DOCX_SIZE) {
      return apiFail(
        {
          error: `文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），最大支持 20MB`,
          code: 'FILE_TOO_LARGE',
        },
        400,
      );
    }

    // mammoth 提取纯文本
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    // 规范化换行：mammoth 段落间以空行分隔，统一为 \n\n；去除多余空白
    const rawText = (result?.value || '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (rawText.length < 10) {
      return apiFail(
        { error: '文档内容为空或过短，未能提取到有效文本', code: 'EMPTY_DOC' },
        400,
      );
    }

    return apiSuccess({ text: rawText, chars: rawText.length });
  } catch (err) {
    return handleApiError(err, 'POST /api/projects/[id]/import-docx');
  }
}
