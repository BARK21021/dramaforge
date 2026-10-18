import { describe, expect, it } from 'vitest';
import { getTaskLabel } from '../components/features/active-task-bar';

describe('active task labels', () => {
  it('刷新恢复视频转剧本任务时显示业务名称', () => {
    expect(getTaskLabel('VIDEO_TO_SCRIPT', '1323838f-task')).toBe('视频转剧本');
  });
});
