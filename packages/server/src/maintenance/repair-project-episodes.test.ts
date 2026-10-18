import { describe, expect, it } from 'vitest';

import { serializeRepairCloneValue } from './repair-project-episodes';

describe('serializeRepairCloneValue', () => {
  it('serializes jsonb arrays as JSON instead of PostgreSQL array literals', () => {
    expect(serializeRepairCloneValue('assets', 'identityLock', ['深棕色短发背头', '灰蓝眼睛']))
      .toBe('["深棕色短发背头","灰蓝眼睛"]');
  });

  it('preserves non-json values and null json values', () => {
    expect(serializeRepairCloneValue('assets', 'name', ['原值'])).toEqual(['原值']);
    expect(serializeRepairCloneValue('projects', 'scriptData', null)).toBeNull();
  });
});
