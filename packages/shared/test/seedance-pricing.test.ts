// ============================================================
// Seedance 2.0 共享计费公式测试
// ============================================================
// 前端预估与服务端扣费共同依赖此纯函数；这里固定 app1 的像素 token、
// 分辨率回退及“有视频输入/无视频输入”费率，防止两端再次漂移。

import { describe, expect, it } from 'vitest';
import {
  estimateSeedanceBilling,
  hasSeedanceVideoInput,
  normalizeSeedanceResolution,
} from '../src/seedance-pricing';

describe('Seedance pricing', () => {
  it('uses the exact 480p mini pixel-token formula', () => {
    const estimate = estimateSeedanceBilling(
      'ark/doubao-seedance-2-0-mini-260615',
      { duration: 15, resolution: '480p' },
    );

    expect(estimate).toMatchObject({
      tokenUsage: 151_200,
      ratePerKTokens: 0.023,
      cost: 3.4776,
      hasVideoInput: false,
    });
  });

  it('uses the lower video-input rate when a valid reference exists', () => {
    const estimate = estimateSeedanceBilling(
      'ark/doubao-seedance-2-0-mini-260615',
      { duration: 15, resolution: '480p', referenceVideoUrls: ['sf-asset://first-frame.mp4'] },
    );

    expect(estimate?.ratePerKTokens).toBe(0.014);
    expect(estimate?.cost).toBe(2.1168);
    expect(hasSeedanceVideoInput({ referenceVideoUrls: ['', 'video.mp4'] })).toBe(true);
  });

  it('falls back to each model default resolution and rejects unknown models', () => {
    expect(normalizeSeedanceResolution('ark/doubao-seedance-2-0-fast-260128', '4k')).toBe('720p');
    expect(estimateSeedanceBilling('unknown/model', { duration: 5 })).toBeNull();
  });
});
