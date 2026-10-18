// ============================================================
// ③ server/domain/episode — sweepStuckAnalyzing + resetAnalyzingToInput 单测
// ============================================================
//
// 覆盖闭环守卫（spec B3）：
//   - sweepStuckAnalyzing：裸 SQL 复位 stageStatus='analyzing' 且 updatedAt 过期
//     （>35min，越过 inline task 30min timeoutAt + 余量）的集 → input/PENDING。
//     幂等（WHERE 仅匹配 analyzing）。
//   - resetAnalyzingToInput：按 id 精确复位，WHERE 守卫 analyzing 防误伤并发成功。
//
// 这两个方法必须走裸 SQL，不能经 episodeRepo.update——update() 的单调推进守卫
// 会把 analyzing→input 回退静默忽略（applied=current），那正是「卡死 analyzing」
// 的隐藏根因。本测试断言 SQL 形态（含 WHERE/INTERVAL/SET），不依赖真实 PG。
//
// 风格对齐 project/service.test.ts：mock @server/infra(query) + 断言 SQL 文本。
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@server/infra', () => ({
  query: vi.fn(),
  tx: vi.fn(),
}));
vi.mock('@shared/utils', () => ({ genId: vi.fn(() => 'gen-id') }));

import { episodeRepo } from '../../src/domain/episode/service';
import { query } from '@server/infra';

const q = vi.mocked(query);

describe('episodeRepo.sweepStuckAnalyzing', () => {
  beforeEach(() => q.mockReset());

  it('发出裸 SQL：仅复位 analyzing 且 updatedAt 超 35min 的集 → input/PENDING', async () => {
    // 模拟 sweep 命中 2 个卡死集（RETURNING id 行数 = 复位计数）
    q.mockResolvedValue({
      rows: [{ id: 'ep-stuck-1' }, { id: 'ep-stuck-2' }],
      rowCount: 2,
    });

    const n = await episodeRepo.sweepStuckAnalyzing();

    expect(n).toBe(2);
    expect(q).toHaveBeenCalledTimes(1);
    const [sql] = q.mock.calls[0];
    const s = String(sql);
    // 只动 analyzing（幂等，不误伤其他阶段）
    expect(s).toContain(`"stageStatus"='analyzing'`);
    // 35min 阈值（inline task timeoutAt 30min + 余量）
    expect(s).toContain(`INTERVAL '35 minutes'`);
    // 复位目标
    expect(s).toContain(`"stageStatus"='input'`);
    expect(s).toContain(`status='PENDING'`);
    // RETURNING 用行数计数（不依赖 rowCount，pg 驱动偶发不填）
    expect(s).toMatch(/RETURNING\s+id/i);
  });

  it('无卡死集时返回 0（幂等空操作）', async () => {
    q.mockResolvedValue({ rows: [], rowCount: 0 });
    const n = await episodeRepo.sweepStuckAnalyzing();
    expect(n).toBe(0);
  });

  it('不带 WHERE 范围之外的阶段（assets/storyboard 等不动）', async () => {
    q.mockResolvedValue({ rows: [], rowCount: 0 });
    await episodeRepo.sweepStuckAnalyzing();
    const s = String(q.mock.calls[0][0]);
    // 不应出现对其他 stageStatus 值的 SET
    expect(s).not.toContain(`"stageStatus"='assets'`);
    expect(s).not.toContain(`"stageStatus"='storyboard'`);
  });
});

describe('episodeRepo.resetAnalyzingToInput', () => {
  beforeEach(() => q.mockReset());

  it('按 id 精确复位，WHERE 守卫 analyzing 防误伤并发成功路径', async () => {
    q.mockResolvedValue({ rows: [], rowCount: 0 });

    await episodeRepo.resetAnalyzingToInput('ep-1');

    expect(q).toHaveBeenCalledTimes(1);
    const [sql, params] = q.mock.calls[0];
    const s = String(sql);
    expect(s).toContain(`"stageStatus"='input'`);
    expect(s).toContain(`status='PENDING'`);
    // id 限定 + analyzing 守卫（并发已推进到 assets 时本调用 0 行，不覆盖成功）
    expect(s).toContain(`WHERE id=$1`);
    expect(s).toContain(`"stageStatus"='analyzing'`);
    expect(params).toEqual(['ep-1']);
  });

  it('复位后刷新 updatedAt（让 35min sweep 不会立刻再命中同一行）', async () => {
    q.mockResolvedValue({ rows: [], rowCount: 0 });
    await episodeRepo.resetAnalyzingToInput('ep-1');
    const s = String(q.mock.calls[0][0]);
    expect(s).toMatch(/"updatedAt"=NOW\(\)/i);
  });
});
