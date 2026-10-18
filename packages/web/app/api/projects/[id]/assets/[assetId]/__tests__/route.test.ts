import { beforeEach, describe, expect, it } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../../../../../test/mocks';
import { makeParamsCtx, makeRequest, readJson } from '../../../../../../../test/helpers';
import { PATCH } from '../route';

describe('PATCH /api/projects/[id]/assets/[assetId]', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.getAsset.mockReset();
    serverMock.updateAsset.mockReset();
    serverMock.updateAssetCostumesPreservingImages.mockReset();
    serverMock.renameAsset.mockReset();
    serverMock.projectRepo.getById.mockResolvedValue({ id: 'proj-1', userId: 'user-1' });
    serverMock.getAsset.mockResolvedValue({ id: 'ast-1', projectId: 'proj-1', name: '角色' });
  });

  it('forwards grid and pencil switches instead of rejecting them as an empty patch', async () => {
    const updated = {
      id: 'ast-1',
      projectId: 'proj-1',
      name: '角色',
      gridOverlayEnabled: true,
      pencilPaintEnabled: false,
    };
    serverMock.updateAsset.mockResolvedValue(updated);
    const req = makeRequest({
      method: 'PATCH',
      url: 'http://localhost/api/projects/proj-1/assets/ast-1',
      body: { gridOverlayEnabled: true, pencilPaintEnabled: false },
    });

    const res = await PATCH(req, makeParamsCtx({ id: 'proj-1', assetId: 'ast-1' }));
    expect(res.status).toBe(200);
    expect(serverMock.updateAsset).toHaveBeenCalledWith('ast-1', {
      gridOverlayEnabled: true,
      pencilPaintEnabled: false,
    });
    expect(await readJson(res)).toMatchObject({ success: true, data: { asset: updated } });
  });

  it('updates costume metadata through the image-preserving transaction', async () => {
    const costumeUpdated = {
      id: 'ast-1',
      projectId: 'proj-1',
      name: '角色',
      description: 'old',
      costumes: [{ key: 'formal', label: '礼服', imageUrl: 'sf-asset://latest.png' }],
    };
    const fullyUpdated = { ...costumeUpdated, description: 'new' };
    serverMock.updateAssetCostumesPreservingImages.mockResolvedValue(costumeUpdated);
    serverMock.updateAsset.mockResolvedValue(fullyUpdated);
    const requestedCostumes = [{ key: 'formal', label: '晚宴礼服', imageUrl: null }];
    const req = makeRequest({
      method: 'PATCH',
      url: 'http://localhost/api/projects/proj-1/assets/ast-1',
      body: { costumes: requestedCostumes, description: 'new' },
    });

    const res = await PATCH(req, makeParamsCtx({ id: 'proj-1', assetId: 'ast-1' }));

    expect(res.status).toBe(200);
    expect(serverMock.updateAssetCostumesPreservingImages).toHaveBeenCalledWith(
      'ast-1',
      'proj-1',
      requestedCostumes,
    );
    expect(serverMock.updateAsset).toHaveBeenCalledWith('ast-1', { description: 'new' });
    expect(serverMock.updateAsset).not.toHaveBeenCalledWith(
      'ast-1',
      expect.objectContaining({ costumes: expect.anything() }),
    );
    expect(await readJson(res)).toMatchObject({ success: true, data: { asset: fullyUpdated } });
  });
});
