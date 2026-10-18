import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportProjectBundle, importProjectBundle } from '../../main/project-bundle';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project bundle', () => {
  it('copies client-local media and rewrites every reference when imported on another machine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-project-bundle-'));
    roots.push(root);
    const oldUserData = join(root, 'old-user-data');
    const newUserData = join(root, 'new-user-data');
    const destination = join(root, 'exports');
    await mkdir(join(oldUserData, 'clips'), { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(oldUserData, 'clips', 'asset-old.png'), new Uint8Array([1, 2, 3]));

    const snapshot = {
      format: 'dramaforge-project',
      version: 1,
      project: { id: 'p1', title: '迁移测试' },
      records: {
        assets: [{ imageUrl: 'sf-asset://asset-old.png' }],
        shots: [{ metadata: { refs: ['sf-asset://asset-old.png'] } }],
      },
    };
    const exported = await exportProjectBundle({
      snapshot,
      title: '迁移测试',
      destinationParent: destination,
      userDataDir: oldUserData,
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.mediaCount).toBe(1);

    const imported = await importProjectBundle({
      bundlePath: exported.bundlePath,
      userDataDir: newUserData,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const restored = imported.snapshot as typeof snapshot;
    const imageUrl = restored.records.assets[0].imageUrl;
    expect(imageUrl).toMatch(/^sf-asset:\/\/[A-Za-z0-9-]+\.png$/);
    expect(restored.records.shots[0].metadata.refs[0]).toBe(imageUrl);
    const bytes = await readFile(join(newUserData, 'clips', imageUrl.slice('sf-asset://'.length)));
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('rejects a folder that is not a supported migration package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-project-bundle-invalid-'));
    roots.push(root);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ format: 'other' }), 'utf8');
    const result = await importProjectBundle({ bundlePath: root, userDataDir: join(root, 'user') });
    expect(result).toEqual({
      ok: false,
      error: { code: 'INVALID_BUNDLE', message: '不是受支持的 DramaForge 项目迁移包' },
    });
  });
});
