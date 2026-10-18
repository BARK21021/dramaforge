/**
 * Opt-in real image-provider smoke test.
 * Run with DRAMAFORGE_REAL_IMAGE_SMOKE=1; CI/full regression skips it by default.
 * Credentials come from server env and output never includes keys or signed URLs.
 */
import { describe, expect, it } from 'vitest';
import { callAI } from '../../src/gateway';

const MODELS = [
  'ark/doubao-seedream-5-0-pro-260628',
  'ark/doubao-seedream-5-0-260128',
  'ark/doubao-seedream-4-5-251128',
  'ark/doubao-seedream-4-0-250828',
];

describe.runIf(process.env.DRAMAFORGE_REAL_IMAGE_SMOKE === '1')('real image providers', () => {
  it('generates one valid image with every configured ARK image model', async () => {
    const audit: Array<Record<string, unknown>> = [];
    for (const model of MODELS) {
      const startedAt = Date.now();
      const result = await callAI('ark', model, {
        capability: 'image_generation',
        input: {
          prompt: 'A single red ceramic cup on a neutral studio background, product photo, no text',
          negativePrompt: 'letters, watermark, logo, duplicate objects',
          width: 1024,
          height: 1024,
          count: 1,
        },
      });
      const imageCount = Array.isArray(result.meta?.images) ? result.meta.images.length : 0;
      audit.push({
        model,
        ok: /^https?:\/\//.test(result.url),
        imageCount,
        costYuan: result.cost ?? null,
        latencyMs: Date.now() - startedAt,
      });
      expect(result.url, `${model} should return a downloadable URL`).toMatch(/^https?:\/\//);
      expect(imageCount).toBeGreaterThan(0);
    }
    console.info('[real-image-smoke]', JSON.stringify(audit));
  }, 300_000);
});
