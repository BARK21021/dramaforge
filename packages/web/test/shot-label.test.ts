import { describe, it, expect } from 'vitest';
import { formatShotLabel, formatShotRange } from '../lib/shot-label';

describe('formatShotLabel', () => {
  it('全集号+组名+镜头序', () => {
    expect(formatShotLabel(3, '高潮组', 4)).toBe('第3集·高潮组·镜头04');
  });
  it('集号缺失省略前缀', () => {
    expect(formatShotLabel(null, '高潮组', 4)).toBe('高潮组·镜头04');
  });
  it('组名缺失省略组段', () => {
    expect(formatShotLabel(3, null, 1)).toBe('第3集·镜头01');
  });
  it('单位数补零', () => {
    expect(formatShotLabel(1, '建场组', 7)).toBe('第1集·建场组·镜头07');
  });
});

describe('formatShotRange', () => {
  it('范围', () => {
    expect(formatShotRange(3, '高潮组', 1, 6)).toBe('第3集·高潮组·镜头01–06');
  });
  it('start===end 退化为单镜头', () => {
    expect(formatShotRange(3, '高潮组', 4, 4)).toBe('第3集·高潮组·镜头04');
  });
  it('无组名', () => {
    expect(formatShotRange(3, null, 1, 12)).toBe('第3集·镜头01–12');
  });
});
