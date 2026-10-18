// ============================================================
// 单镜 PATCH 契约：状态重置 + metadata 安全合并
// ============================================================
// ProductionStage 会通过本路由清理旧视频结果、保存成组提示词。测试锁定
// ownership、可空素材字段及 read-merge-write，防止 UI 再次得到静默 400。

import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectRecord } from '@dramaforge/shared';
import {
  DEFAULT_SESSION,
  getServerSessionMock,
  serverMock,
} from '../../../../../../../../../test/mocks';
import {
  makeParamsCtx,
  makeRequest,
  readJson,
} from '../../../../../../../../../test/helpers';
import { PATCH } from '../route';

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'proj-1',
    userId: 'user-1',
    title: '项目',
    description: null,
    category: 'DOMESTIC',
    status: 'PRODUCTION',
    version: 1,
    artStyle: null,
    artStylePrompt: null,
    novelText: null,
    videoScriptDraft: null,
    scriptData: null,
    characterMapping: null,
    voiceprintMapping: null,
    longVideoProgress: null,
    sourceProjectId: null,
    scriptOverride: false,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

function makeShot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'shot-1',
    projectId: 'proj-1',
    episodeId: 'ep-1',
    visualPrompt: '原提示词',
    durationSeconds: 5,
    videoStatus: 'COMPLETED',
    currentMaterialId: 'material-1',
    currentMaterialUrl: 'sf-asset://old.mp4',
    metadata: {
      preserved: 'yes',
      storyboardTable: { shotSize: '近景' },
      errorMessage: '旧错误',
    },
    ...overrides,
  };
}

/** 构造 listAssets 返回的最小资产行（路由只读 kind/name）。 */
function makeAsset(id: string, kind: string, name: string) {
  return { id, kind, name };
}

const ctx = () => makeParamsCtx({ id: 'proj-1', episodeId: 'ep-1', shotId: 'shot-1' });

describe('PATCH /api/projects/[id]/episodes/[episodeId]/shots/[shotId]', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.getShot.mockReset();
    serverMock.updateShot.mockReset();
    serverMock.listAssets.mockReset();
    serverMock.validateReferencedAssetsShape.mockClear();
    serverMock.projectRepo.getById.mockResolvedValue(makeProject());
    serverMock.getShot.mockResolvedValue(makeShot());
    serverMock.updateShot.mockImplementation(async (_id, patch) => ({
      ...makeShot(),
      ...patch,
    }));
    serverMock.listAssets.mockResolvedValue([
      makeAsset('ast-1', 'CHARACTER', '林夏'),
      makeAsset('ast-2', 'CHARACTER', '白药'),
      makeAsset('ast-3', 'LOCATION', '采石场'),
      makeAsset('ast-4', 'PROP', '旧雨伞'),
    ]);
  });

  it('rejects a foreign project before reading or updating the shot', async () => {
    serverMock.projectRepo.getById.mockResolvedValue(makeProject({ userId: 'other-user' }));
    const req = makeRequest({ method: 'PATCH', body: { videoStatus: 'PENDING' } });

    const res = await PATCH(req, ctx());

    expect(res.status).toBe(404);
    expect(serverMock.getShot).not.toHaveBeenCalled();
    expect(serverMock.updateShot).not.toHaveBeenCalled();
  });

  it('resets video state and clears the old material without losing metadata', async () => {
    const req = makeRequest({
      method: 'PATCH',
      body: {
        videoStatus: 'PENDING',
        currentMaterialId: null,
        currentMaterialUrl: null,
        errorMessage: null,
      },
    });

    const res = await PATCH(req, ctx());

    expect(res.status).toBe(200);
    expect(serverMock.updateShot).toHaveBeenCalledWith('shot-1', {
      videoStatus: 'PENDING',
      currentMaterialId: null,
      currentMaterialUrl: null,
      metadata: {
        preserved: 'yes',
        storyboardTable: { shotSize: '近景' },
        errorMessage: null,
      },
    });
  });

  it('merges a group prompt into existing metadata', async () => {
    const req = makeRequest({
      method: 'PATCH',
      body: { metadata: { seedanceGroupPrompt: '统一运镜提示词' } },
    });

    const res = await PATCH(req, ctx());

    expect(res.status).toBe(200);
    expect(serverMock.updateShot).toHaveBeenCalledWith('shot-1', {
      metadata: expect.objectContaining({
        preserved: 'yes',
        seedanceGroupPrompt: '统一运镜提示词',
        storyboardTable: { shotSize: '近景' },
      }),
    });
  });

  it('returns 400 when the service rejects an invalid videoStatus', async () => {
    serverMock.updateShot.mockRejectedValue(new Error('videoStatus 必须为白名单值'));
    const req = makeRequest({ method: 'PATCH', body: { videoStatus: 'DONE' } });

    const res = await PATCH(req, ctx());

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      code: 'VALIDATION_ERROR',
    });
  });

  // ---------- 单镜头资产重绑（referencedAssets）----------

  it('rebinds referencedAssets: resolves names and writes canonical names', async () => {
    const req = makeRequest({
      method: 'PATCH',
      body: {
        referencedAssets: {
          characters: ['林夏'],
          speakingCharacters: ['林夏'],
          environments: ['采石场'],
          items: ['旧雨伞'],
        },
      },
    });

    const res = await PATCH(req, ctx());

    expect(res.status).toBe(200);
    expect(serverMock.updateShot).toHaveBeenCalledWith(
      'shot-1',
      expect.objectContaining({
        referencedAssets: {
          characters: ['林夏'],
          speakingCharacters: ['林夏'],
          environments: ['采石场'],
          items: ['旧雨伞'],
        },
      }),
    );
  });

  it('preserves AI-assigned itemCostumes/environmentCostumes when rebinding (UI does not edit them)', async () => {
    // 分镜 AI 已为镜头写入道具/环境变体赋值；前端草稿重绑资产时不带这两个字段。
    // 若服务端不沿用，手动重绑一次就会抹掉 AI 的变体引用 → 始终回退基准图。
    serverMock.listAssets.mockResolvedValue([
      { id: 'ast-1', kind: 'PROP', name: '银色令牌', costumes: [{ key: 'crushed' }] },
      { id: 'ast-2', kind: 'LOCATION', name: '边境军营', costumes: [{ key: 'goblin-occupied' }] },
    ]);
    serverMock.getShot.mockResolvedValue(
      makeShot({
        referencedAssets: {
          items: ['银色令牌'],
          environments: ['边境军营'],
          itemCostumes: [{ name: '银色令牌', costumeKey: 'crushed' }],
          environmentCostumes: [{ name: '边境军营', costumeKey: 'goblin-occupied' }],
        },
      }),
    );
    const req = makeRequest({
      method: 'PATCH',
      body: { referencedAssets: { items: ['银色令牌'], environments: ['边境军营'] } },
    });

    const res = await PATCH(req, ctx());

    expect(res.status).toBe(200);
    expect(serverMock.updateShot).toHaveBeenCalledWith(
      'shot-1',
      expect.objectContaining({
        referencedAssets: expect.objectContaining({
          items: ['银色令牌'],
          environments: ['边境军营'],
          itemCostumes: [{ name: '银色令牌', costumeKey: 'crushed' }],
          environmentCostumes: [{ name: '边境军营', costumeKey: 'goblin-occupied' }],
        }),
      }),
    );
  });

  it('drops variant assignments for assets no longer referenced on rebind', async () => {
    serverMock.listAssets.mockResolvedValue([
      { id: 'ast-1', kind: 'PROP', name: '银色令牌', costumes: [{ key: 'crushed' }] },
    ]);
    serverMock.getShot.mockResolvedValue(
      makeShot({
        referencedAssets: {
          items: ['银色令牌'],
          itemCostumes: [{ name: '银色令牌', costumeKey: 'crushed' }],
        },
      }),
    );
    // 重绑时移除了该道具 → 其变体赋值应被剔除。
    const req = makeRequest({
      method: 'PATCH',
      body: { referencedAssets: { items: [], environments: [] } },
    });

    const res = await PATCH(req, ctx());

    expect(res.status).toBe(200);
    const patch = serverMock.updateShot.mock.calls[0][1] as {
      referencedAssets: Record<string, unknown>;
    };
    expect(patch.referencedAssets.itemCostumes).toBeUndefined();
  });

  it('rejects a referencedAssets name that resolves to no asset (REFERENCED_ASSET_NOT_FOUND)', async () => {
    const req = makeRequest({
      method: 'PATCH',
      body: { referencedAssets: { characters: ['不存在的角色'] } },
    });

    const res = await PATCH(req, ctx());

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      code: 'REFERENCED_ASSET_NOT_FOUND',
    });
    expect(serverMock.updateShot).not.toHaveBeenCalled();
  });

  it('normalizes referencedAssets names to canonical asset spelling', async () => {
    // '林 夏'（带空格）归一化后命中资产 '林夏'，回写规范名 '林夏'。
    const req = makeRequest({
      method: 'PATCH',
      body: { referencedAssets: { characters: ['林 夏'] } },
    });

    const res = await PATCH(req, ctx());

    expect(res.status).toBe(200);
    expect(serverMock.updateShot).toHaveBeenCalledWith(
      'shot-1',
      expect.objectContaining({ referencedAssets: { characters: ['林夏'] } }),
    );
  });

  it('rejects when validateReferencedAssetsShape reports a structural error', async () => {
    serverMock.validateReferencedAssetsShape.mockReturnValueOnce({
      valid: false,
      errors: ['referencedAssets.speakingCharacters 引用了未在 characters 中的角色：白药'],
    });
    const req = makeRequest({
      method: 'PATCH',
      body: { referencedAssets: { characters: ['林夏'], speakingCharacters: ['白药'] } },
    });

    const res = await PATCH(req, ctx());

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    expect(serverMock.listAssets).not.toHaveBeenCalled();
    expect(serverMock.updateShot).not.toHaveBeenCalled();
  });

  it('clears referencedAssets when null is sent', async () => {
    const req = makeRequest({ method: 'PATCH', body: { referencedAssets: null } });

    const res = await PATCH(req, ctx());

    expect(res.status).toBe(200);
    expect(serverMock.updateShot).toHaveBeenCalledWith(
      'shot-1',
      expect.objectContaining({ referencedAssets: null }),
    );
    // null 直接落库，无需读资产库做名字解析。
    expect(serverMock.listAssets).not.toHaveBeenCalled();
  });
});
