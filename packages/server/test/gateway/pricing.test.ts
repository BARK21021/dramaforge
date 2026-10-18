import { describe, expect, it } from 'vitest';
import {
  estimateSpeechDurationSeconds,
  getCapabilityCostYuan,
  isDeepSeekPeakTime,
} from '../../src/gateway/pricing';

describe('gateway capability pricing', () => {
  it('prices DeepSeek from official cache-aware off-peak rates', () => {
    expect(getCapabilityCostYuan(
      'deepseek/deepseek-v4-pro',
      'text_generation',
      {},
      { meta: { tokensUsed: { input: 1_000, output: 500, cacheHit: 400, cacheMiss: 600 } } },
      new Date('2026-07-22T00:30:00.000Z'), // 北京 08:30，平时段
    )).toBe(0.00481);
    expect(getCapabilityCostYuan(
      'openai/gpt-4o',
      'text_generation',
      {},
      { meta: { tokensUsed: { input: 1_000, output: 500 } } },
    )).toBe(0);
  });

  it('doubles all DeepSeek token rates in Beijing peak windows', () => {
    const usage = { meta: { tokensUsed: { input: 1_000_000, output: 100_000, cacheHit: 200_000 } } };
    const offPeak = getCapabilityCostYuan(
      'deepseek/deepseek-v4-flash', 'text_generation', {}, usage,
      new Date('2026-07-22T00:30:00.000Z'),
    );
    const morningPeak = getCapabilityCostYuan(
      'deepseek/deepseek-v4-flash', 'text_generation', {}, usage,
      new Date('2026-07-22T01:00:00.000Z'),
    );
    const afternoonPeak = getCapabilityCostYuan(
      'deepseek/deepseek-v4-flash', 'text_generation', {}, usage,
      new Date('2026-07-22T06:00:00.000Z'),
    );

    expect(offPeak).toBe(1.004);
    expect(morningPeak).toBe(2.008);
    expect(afternoonPeak).toBe(2.008);
    expect(isDeepSeekPeakTime(new Date('2026-07-22T04:00:00.000Z'))).toBe(false);
    expect(isDeepSeekPeakTime(new Date('2026-07-22T10:00:00.000Z'))).toBe(false);
  });

  it('prices image count and Seedance by pixel tokens', () => {
    expect(getCapabilityCostYuan(
      'ark/doubao-seedream-5-0-260128',
      'image_generation',
      { count: 3 },
      {},
    )).toBe(0.66);
    expect(getCapabilityCostYuan(
      'ark/doubao-seedance-2-0-260128',
      'video_generation',
      { duration: 10 },
      { meta: { duration: 8 } },
    )).toBe(9.936);
    expect(getCapabilityCostYuan(
      'ark/doubao-seedance-2-0-mini-260615',
      'video_generation',
      { duration: 15, resolution: '480p' },
      {},
    )).toBe(3.4776);
    expect(getCapabilityCostYuan(
      'ark/doubao-seedance-2-0-mini-260615',
      'video_generation',
      { duration: 15, resolution: '480p', referenceVideoUrls: ['https://example/video.mp4'] },
      {},
    )).toBe(2.1168);
  });

  it('uses provider audio duration then falls back to documented text estimate', () => {
    expect(estimateSpeechDurationSeconds('你好世界')).toBe(1);
    expect(getCapabilityCostYuan(
      'ark/cosyvoice',
      'tts',
      { text: '这是十六个汉字的测试语音文本内容' },
      { meta: { duration: 5 } },
    )).toBe(0.05);
    expect(getCapabilityCostYuan(
      'ark/cosyvoice',
      'tts',
      { text: '一二三四五六七八' },
      { meta: { duration: 0 } },
    )).toBe(0.02);
  });

  it('leaves unknown models unbilled', () => {
    expect(getCapabilityCostYuan('unknown/model', 'video_generation', { duration: 10 }, {})).toBe(0);
  });

  it('prices video_understanding / video_to_script by Kimi token rate (P0-3)', () => {
    // K2.6 文本与多模态 token 同价：8.4元/M input+output。
    // 10K input + 5K output = 0.084 + 0.042 = 0.126 元（平台成本，yuanToCredits 再加价）。
    const usage = { meta: { tokensUsed: { input: 10_000, output: 5_000 } } };
    expect(getCapabilityCostYuan(
      'kimi/kimi-k2.6',
      'video_understanding',
      {},
      usage,
    )).toBe(0.126);
    expect(getCapabilityCostYuan(
      'kimi/kimi-k2.6',
      'video_to_script',
      {},
      usage,
    )).toBe(0.126);
    // 与 text_generation 同用量同价（共用 token 单价表，防止能力间计费漂移）。
    expect(getCapabilityCostYuan('kimi/kimi-k2.6', 'text_generation', {}, usage)).toBe(0.126);
  });

  it('prices video_to_script 可选模型 k2.7-code-highspeed / k3 同 Kimi token 率（不再漏扣）', () => {
    const usage = { meta: { tokensUsed: { input: 10_000, output: 5_000 } } };
    expect(getCapabilityCostYuan('kimi/kimi-k2.7-code-highspeed', 'video_to_script', {}, usage)).toBe(0.126);
    expect(getCapabilityCostYuan('kimi/kimi-k3', 'video_to_script', {}, usage)).toBe(0.126);
  });

  it('leaves unknown video_understanding models unbilled (宁可漏扣不误扣)', () => {
    expect(getCapabilityCostYuan(
      'kimi/unknown-model',
      'video_understanding',
      {},
      { meta: { tokensUsed: { input: 10_000, output: 5_000 } } },
    )).toBe(0);
    // provider 未返回 token 用量时计 0，不凭空估算。
    expect(getCapabilityCostYuan(
      'kimi/kimi-k2.6',
      'video_to_script',
      {},
      { meta: {} },
    )).toBe(0);
  });
});
