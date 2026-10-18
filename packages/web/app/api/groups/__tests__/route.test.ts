import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SESSION, getServerSessionMock, serverMock } from '../../../../test/mocks';
import { makeRequest, readJson } from '../../../../test/helpers';
import { GET } from '../route';

describe('GET /api/groups', () => {
  beforeEach(() => {
    getServerSessionMock.mockResolvedValue(DEFAULT_SESSION);
    serverMock.query.mockReset();
  });

  it('groups current completed shots by their shared video instead of render-job whole output', async () => {
    serverMock.query.mockResolvedValue({
      rows: [
        {
          shotId: 'shot-1', projectId: 'project-1', projectTitle: '项目',
          episodeId: 'episode-1', episodeNumber: 1, episodeTitle: '春天',
          durationSeconds: 3, videoUrl: 'sf-asset://job-group-1.mp4',
          updatedAt: new Date('2026-07-21T01:00:00Z'),
        },
        {
          shotId: 'shot-2', projectId: 'project-1', projectTitle: '项目',
          episodeId: 'episode-1', episodeNumber: 1, episodeTitle: '春天',
          durationSeconds: 4, videoUrl: 'sf-asset://job-group-1.mp4',
          updatedAt: new Date('2026-07-21T01:00:01Z'),
        },
        {
          shotId: 'shot-3', projectId: 'project-1', projectTitle: '项目',
          episodeId: 'episode-1', episodeNumber: 1, episodeTitle: '春天',
          durationSeconds: 5, videoUrl: 'https://provider.example/group-2.mp4',
          updatedAt: new Date('2026-07-21T02:00:00Z'),
        },
        {
          shotId: 'shot-4', projectId: 'project-1', projectTitle: '项目',
          episodeId: 'episode-2', episodeNumber: 2, episodeTitle: null,
          durationSeconds: 2, videoUrl: 'sf-asset://job-group-3.mp4',
          updatedAt: new Date('2026-07-21T03:00:00Z'),
        },
      ],
      rowCount: 4,
    });

    const response = await GET(makeRequest({ url: 'http://localhost/api/groups' }));
    const payload = await readJson(response) as { data: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(serverMock.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM shots s'),
      [DEFAULT_SESSION.user.id],
    );
    expect(payload.data).toEqual([
      expect.objectContaining({
        id: 'shot-1', episodeId: 'episode-1', groupIndex: 1,
        videoUrl: 'sf-asset://job-group-1.mp4', localKey: 'job-group-1.mp4',
        shotCount: 2, duration: 7,
      }),
      expect.objectContaining({
        id: 'shot-3', episodeId: 'episode-1', groupIndex: 2,
        videoUrl: 'https://provider.example/group-2.mp4', localKey: null,
        shotCount: 1, duration: 5,
      }),
      expect.objectContaining({
        id: 'shot-4', episodeId: 'episode-2', groupIndex: 1,
        shotCount: 1, duration: 2,
      }),
    ]);
  });

  it('filters by owner and completed non-empty material in SQL', async () => {
    serverMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await GET(makeRequest({ url: 'http://localhost/api/groups' }));
    const sql = String(serverMock.query.mock.calls[0]?.[0]);
    expect(sql).toContain('p."userId" = $1');
    expect(sql).toContain('s."videoStatus" = \'COMPLETED\'');
    expect(sql).toContain('COALESCE(s."currentMaterialUrl", \'\') <> \'\'');
  });
});
