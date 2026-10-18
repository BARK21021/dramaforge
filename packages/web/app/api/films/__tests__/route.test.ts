import { beforeEach, describe, expect, it } from 'vitest';
import { serverMock, getServerSessionMock, DEFAULT_SESSION } from '../../../../test/mocks';
import { readJson } from '../../../../test/helpers';
import { GET } from '../route';

describe('GET /api/films', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.listUserFilms.mockReset().mockResolvedValue([]);
  });

  it('requires an authenticated user', async () => {
    getServerSessionMock.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(await readJson(response)).toMatchObject({
      success: false,
      code: 'UNAUTHORIZED',
    });
    expect(serverMock.listUserFilms).not.toHaveBeenCalled();
  });

  it('returns the episode films selected by the server boundary', async () => {
    const films = [
      {
        id: 'film-1',
        type: 'CHAIN_COMPILE',
        projectId: 'project-1',
        projectTitle: '示例项目',
        episodeId: 'episode-1',
        episodeNumber: 1,
        episodeTitle: '第一集',
        outputUrl: 'sf-asset://films/film-1.mp4',
        localKey: 'film-1',
        shotCount: 8,
        totalDuration: 42,
        createdAt: '2026-07-21T00:00:00.000Z',
      },
    ];
    serverMock.listUserFilms.mockResolvedValue(films);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(serverMock.listUserFilms).toHaveBeenCalledWith('user-1');
    expect(await readJson(response)).toEqual({ success: true, data: films });
  });
});
