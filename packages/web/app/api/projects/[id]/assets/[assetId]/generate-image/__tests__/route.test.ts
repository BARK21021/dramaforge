import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../../../../../../test/mocks';
import { makeParamsCtx, makeRequest, readJson } from '../../../../../../../../test/helpers';
import { POST } from '../route';

describe('POST /api/projects/[id]/assets/[assetId]/generate-image', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.projectRepo.getById.mockReset();
    serverMock.getAsset.mockReset();
    serverMock.getBalance.mockReset();
    serverMock.beginAssetImageRevision.mockReset();
    serverMock.markAssetImageRevisionGenerated.mockReset();
    serverMock.callAI.mockReset();
    serverMock.enqueueAiTask.mockReset();
    serverMock.buildAssetImagePrompt.mockClear();
    serverMock.sanitizePromptForModeration.mockReset();
    serverMock.sanitizePromptForModeration.mockImplementation((prompt: string) => ({
      sanitized: prompt,
      replacements: [],
    }));
    serverMock.projectRepo.getById.mockResolvedValue({
      id: 'project-1',
      userId: 'user-1',
      category: 'DOMESTIC',
      artStyle: null,
      scriptData: null,
    });
    serverMock.getAsset.mockResolvedValue({
      id: 'asset-1',
      projectId: 'project-1',
      kind: 'CHARACTER',
      name: '角色甲',
      description: '主角',
      costumes: [
        { key: 'default', label: '便装', description: '白衬衫' },
        { key: 'casual', label: '休闲装', description: '蓝色夹克' },
      ],
      regenLocked: false,
    });
    serverMock.getBalance.mockResolvedValue({
      userId: 'user-1',
      credits: 0,
      frozenCredits: 0,
      availableCredits: 0,
      unlimited: true,
    });
    serverMock.beginAssetImageRevision.mockResolvedValue({ id: 'revision-1' });
    serverMock.enqueueAiTask.mockResolvedValue({
      task: { id: 'task-1', status: 'QUEUED' },
      reused: false,
    });
    serverMock.callAI.mockResolvedValue({
      url: 'https://ark/generated.png',
      meta: { images: [{ url: 'https://ark/generated.png' }] },
    });
  });

  it('uses the revision as a unique dedupe scope for ordinary queued generation', async () => {
    const request = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/project-1/assets/asset-1/generate-image',
      body: {
        model: 'ark/doubao-seedream-5-0-260128',
      },
    });

    const response = await POST(
      request,
      makeParamsCtx({ id: 'project-1', assetId: 'asset-1' }),
    );
    const body = await readJson(response);

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ success: true, data: { taskId: 'task-1', revisionId: 'revision-1' } });
    expect(serverMock.enqueueAiTask).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'revision-1',
      storedPayload: expect.not.objectContaining({ referenceImageUrl: expect.anything() }),
    }));
    expect(serverMock.buildAssetImagePrompt).toHaveBeenCalledWith(
      'CHARACTER',
      '角色甲',
      '主角',
      expect.objectContaining({
        costume: expect.objectContaining({
          label: '便装',
          isDefault: true,
        }),
      }),
    );
  });

  it('rejects legacy base64 media before creating a revision or queue job', async () => {
    const request = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/project-1/assets/asset-1/generate-image',
      body: { referenceImageBase64: 'data:image/png;base64,AAAA' },
    });

    const response = await POST(
      request,
      makeParamsCtx({ id: 'project-1', assetId: 'asset-1' }),
    );
    expect(response.status).toBe(400);
    expect(serverMock.beginAssetImageRevision).not.toHaveBeenCalled();
    expect(serverMock.enqueueAiTask).not.toHaveBeenCalled();
  });

  it('rejects an unknown costume variant before balance, revision, or generation', async () => {
    serverMock.getAsset.mockResolvedValue({
      id: 'asset-1',
      projectId: 'project-1',
      kind: 'CHARACTER',
      name: '角色甲',
      description: '主角',
      costumes: [{ key: 'default', label: '便装', description: '白衬衫' }],
      regenLocked: false,
    });
    const response = await POST(
      makeRequest({
        method: 'POST',
        url: 'http://localhost/api/projects/project-1/assets/asset-1/generate-image',
        body: { costumeKey: 'non-existent' },
      }),
      makeParamsCtx({ id: 'project-1', assetId: 'asset-1' }),
    );
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, code: 'COSTUME_NOT_FOUND' });
    expect(serverMock.getBalance).not.toHaveBeenCalled();
    expect(serverMock.beginAssetImageRevision).not.toHaveBeenCalled();
    expect(serverMock.enqueueAiTask).not.toHaveBeenCalled();
    expect(serverMock.callAI).not.toHaveBeenCalled();
  });

  it('relays reference bytes directly to the provider URL without enqueueing or buffering base64', async () => {
    const request = new NextRequest(
      'http://localhost/api/projects/project-1/assets/asset-1/generate-image?model=ark%2Fdoubao-seedream-5-0-260128&costumeKey=casual',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'X-SF-Reference-Stream': '1',
        },
        body: new Uint8Array([137, 80, 78, 71]),
      },
    );

    const response = await POST(
      request,
      makeParamsCtx({ id: 'project-1', assetId: 'asset-1' }),
    );
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: { imageUrl: 'https://ark/generated.png', revisionId: 'revision-1' },
    });
    expect(serverMock.enqueueAiTask).not.toHaveBeenCalled();
    expect(serverMock.callAI).toHaveBeenCalledWith(
      'ark',
      'ark/doubao-seedream-5-0-260128',
      expect.objectContaining({
        input: expect.objectContaining({
          referenceImageUrl: expect.stringMatching(/\/api\/media-relay\/[a-f0-9]{32}$/),
        }),
      }),
    );
    expect(serverMock.markAssetImageRevisionGenerated).toHaveBeenCalledWith(
      'revision-1',
      'https://ark/generated.png',
    );
  });

  it('allows a size-limited base64 fallback only as a synchronous non-queued call', async () => {
    const referenceImageBase64 = 'data:image/png;base64,iVBORw0KGgo=';
    const request = makeRequest({
      method: 'POST',
      url: 'http://localhost/api/projects/project-1/assets/asset-1/generate-image',
      body: {
        model: 'ark/doubao-seedream-5-0-260128',
        referenceImageBase64,
        allowBase64Fallback: true,
      },
    });

    const response = await POST(
      request,
      makeParamsCtx({ id: 'project-1', assetId: 'asset-1' }),
    );
    expect(response.status).toBe(200);
    expect(serverMock.enqueueAiTask).not.toHaveBeenCalled();
    expect(serverMock.callAI).toHaveBeenCalledWith(
      'ark',
      'ark/doubao-seedream-5-0-260128',
      expect.objectContaining({
        input: expect.objectContaining({ referenceImageUrl: referenceImageBase64 }),
      }),
    );
  });

  it('allows people for a face-bearing prop and adds face consistency when a reference stream exists', async () => {
    serverMock.getAsset.mockResolvedValue({
      id: 'asset-face-prop',
      projectId: 'project-1',
      kind: 'PROP',
      name: '结婚照',
      description: '两位主角的合影',
      metadata: { requiresCharacterRef: true, involvedCharacters: ['角色甲'] },
      costumes: [],
      regenLocked: false,
    });
    const response = await POST(
      new NextRequest(
        'http://localhost/api/projects/project-1/assets/asset-face-prop/generate-image',
        {
          method: 'POST',
          headers: { 'Content-Type': 'image/png', 'X-SF-Reference-Stream': '1' },
          body: new Uint8Array([137, 80, 78, 71]),
        },
      ),
      makeParamsCtx({ id: 'project-1', assetId: 'asset-face-prop' }),
    );

    expect(response.status).toBe(200);
    expect(serverMock.buildAssetImagePrompt).toHaveBeenCalledWith(
      'PROP',
      '结婚照',
      '两位主角的合影',
      expect.objectContaining({ allowHumanFigure: true }),
    );
    expect(serverMock.callAI).toHaveBeenCalledWith(
      'ark',
      expect.any(String),
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: expect.stringContaining('人脸必须保持相同五官'),
        }),
      }),
    );
  });

  it('blocks a face-bearing prop without a character reference before charging or creating a revision', async () => {
    serverMock.getAsset.mockResolvedValue({
      id: 'asset-face-prop',
      projectId: 'project-1',
      kind: 'PROP',
      name: '证件照',
      description: '角色证件',
      metadata: { requiresCharacterRef: true, involvedCharacters: ['角色甲'] },
      costumes: [],
      regenLocked: false,
    });
    const response = await POST(
      makeRequest({
        method: 'POST',
        url: 'http://localhost/api/projects/project-1/assets/asset-face-prop/generate-image',
        body: {},
      }),
      makeParamsCtx({ id: 'project-1', assetId: 'asset-face-prop' }),
    );
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, code: 'FACE_PROP_REFERENCE_REQUIRED' });
    expect(serverMock.getBalance).not.toHaveBeenCalled();
    expect(serverMock.beginAssetImageRevision).not.toHaveBeenCalled();
  });

  it('sanitizes moderation-sensitive wording before persisting or dispatching the prompt', async () => {
    serverMock.sanitizePromptForModeration.mockReturnValue({
      sanitized: 'ASSET_PROMPT（已安全替换）',
      replacements: ['血迹 → 污渍'],
    });
    const response = await POST(
      makeRequest({
        method: 'POST',
        url: 'http://localhost/api/projects/project-1/assets/asset-1/generate-image',
        body: {},
      }),
      makeParamsCtx({ id: 'project-1', assetId: 'asset-1' }),
    );

    expect(response.status).toBe(201);
    expect(serverMock.beginAssetImageRevision).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'ASSET_PROMPT（已安全替换）' }),
    );
    expect(serverMock.enqueueAiTask).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ prompt: 'ASSET_PROMPT（已安全替换）' }),
      }),
    );
  });
});
