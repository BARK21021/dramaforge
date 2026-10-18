// ============================================================
// POST /api/projects/[id]/whole-script-asset-extraction — 契约测试（转绘 X4.4）
// ============================================================
// 覆盖：
//   - 401 / 404（非本人）
//   - 400 EMPTY_SCRIPT（novelText 过短/缺失）
//   - 200 OVERSEAS prepared script（整剧本地化后正常提取）
//   - 200 DOMESTIC happy（created/totalDetected 透传 + model 透传）
//   - 502 GatewayError
// domain 层 dedup/AI/parse 逻辑见 server/test/domain/whole-script-extraction.test.ts
// mock：@dramaforge/server（projectRepo/extractWholeScriptAssets/GatewayError）+ session
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  serverMock,
  getServerSessionMock,
  DEFAULT_SESSION,
} from '../../../../../../test/mocks';
import { makeRequest, readJson } from '../../../../../../test/helpers';
import { POST } from '../route';

const { projectRepo, episodeRepo, extractWholeScriptAssets, GatewayError } = serverMock;

const PROJECT_ID = 'proj-1';
const NOVEL = '第1集 张三走进酒馆。'.repeat(20); // ≥ 50 chars

function ctx() {
  return { params: Promise.resolve({ id: PROJECT_ID }) };
}

describe('POST /api/projects/[id]/whole-script-asset-extraction (转绘 X4.4)', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    projectRepo.getById.mockReset();
    episodeRepo.listByProject.mockReset();
    extractWholeScriptAssets.mockReset();
    projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'user-1',
      category: 'DOMESTIC',
      novelText: NOVEL,
    });
    // 无分集时回退 project.novelText（保留既有 novelText 行为契约）
    episodeRepo.listByProject.mockResolvedValue([]);
  });

  it('401 未登录', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const res = await POST(makeRequest({ method: 'POST', body: {} }), ctx());
    expect(res.status).toBe(401);
    expect(extractWholeScriptAssets).not.toHaveBeenCalled();
  });

  it('404 项目不属于当前用户', async () => {
    projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'someone-else',
      category: 'DOMESTIC',
      novelText: NOVEL,
    });
    const res = await POST(makeRequest({ method: 'POST', body: {} }), ctx());
    expect(res.status).toBe(404);
    expect(extractWholeScriptAssets).not.toHaveBeenCalled();
  });

  it('400 EMPTY_SCRIPT（novelText 过短）', async () => {
    projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'user-1',
      category: 'DOMESTIC',
      novelText: '太短了',
    });
    const res = await POST(makeRequest({ method: 'POST', body: {} }), ctx());
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { code?: string };
    expect(body.code).toBe('EMPTY_SCRIPT');
    expect(extractWholeScriptAssets).not.toHaveBeenCalled();
  });

  it('200 OVERSEAS 已完成整剧本地化后正常提取', async () => {
    projectRepo.getById.mockResolvedValue({
      id: PROJECT_ID,
      userId: 'user-1',
      category: 'OVERSEAS',
      novelText: NOVEL,
    });
    extractWholeScriptAssets.mockResolvedValue({
      created: 5,
      totalDetected: 6,
      cost: 0.2,
    });
    const res = await POST(makeRequest({ method: 'POST', body: {} }), ctx());
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { data: { created: number; totalDetected: number } };
    expect(body.data.created).toBe(5);
    expect(body.data.totalDetected).toBe(6);
    // category 透传给 domain（OVERSEAS）
    const [, , , category] = extractWholeScriptAssets.mock.calls[0];
    expect(category).toBe('OVERSEAS');
  });

  it('200 DOMESTIC happy：created/totalDetected 透传 + model 透传', async () => {
    extractWholeScriptAssets.mockResolvedValue({ created: 6, totalDetected: 8, cost: 0 });
    const res = await POST(
      makeRequest({ method: 'POST', body: { model: 'deepseek/r1' } }),
      ctx(),
    );
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { data: { created: number; totalDetected: number } };
    expect(body.data.created).toBe(6);
    expect(body.data.totalDetected).toBe(8);

    // 签名：(projectId, novelText, userId, category, model?)
    const [pid, , uid, category, model] = extractWholeScriptAssets.mock.calls[0];
    expect(pid).toBe(PROJECT_ID);
    expect(uid).toBe('user-1');
    expect(category).toBe('DOMESTIC');
    expect(model).toBe('deepseek/r1');
  });

  it('200 有分集时从分集重建带 === EP{n} === 标记文本（已有项目无需重拆即可按集标注）', async () => {
    episodeRepo.listByProject.mockResolvedValue([
      { episodeNumber: 1, title: '开端', novelText: '第一集正文。'.repeat(10), content: null },
      { episodeNumber: 2, title: null, novelText: null, content: '第二集正文。'.repeat(10) },
    ]);
    extractWholeScriptAssets.mockResolvedValue({ created: 2, totalDetected: 2, cost: 0 });

    const res = await POST(makeRequest({ method: 'POST', body: {} }), ctx());
    expect(res.status).toBe(200);
    // 传给 domain 的 novelText（arg[1]）应含两集的 EP 标记
    const novelText = extractWholeScriptAssets.mock.calls[0][1] as string;
    expect(novelText).toContain('=== EP1 开端 ===');
    expect(novelText).toContain('第一集正文');
    expect(novelText).toContain('=== EP2 ===');
    expect(novelText).toContain('第二集正文');
  });

  it('502 GatewayError', async () => {
    extractWholeScriptAssets.mockRejectedValue(
      new GatewayError('deepseek', '上游限流', 429),
    );
    const res = await POST(makeRequest({ method: 'POST', body: {} }), ctx());
    expect(res.status).toBe(429);
    const body = (await readJson(res)) as { code?: string };
    expect(body.code).toBe('AI_GATEWAY_ERROR');
  });

  it('502 domain 返回格式无效（EXTRACTION_FAILED）', async () => {
    extractWholeScriptAssets.mockRejectedValue(new Error('整剧资产提取返回格式无效'));
    const res = await POST(makeRequest({ method: 'POST', body: {} }), ctx());
    expect(res.status).toBe(502);
    const body = (await readJson(res)) as { code?: string };
    expect(body.code).toBe('EXTRACTION_FAILED');
  });
});
