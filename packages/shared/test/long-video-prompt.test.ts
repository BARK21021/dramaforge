import { describe, expect, it } from 'vitest';
import {
  buildFullScriptPrompt,
  buildMergeScriptPrompt,
  buildOutlinePrompt,
  buildRewriteFromOutlinePrompt,
} from '../src/long-video-prompt';

describe('long-video episode planning prompts', () => {
  it('derives outline episode range from video duration instead of forcing 50~70', () => {
    const prompt = buildOutlinePrompt('一段中文剧情转写', 15 * 60, 'zh');

    expect(prompt.system).toContain('8~10 集');
    expect(prompt.system).not.toContain('50~70');
    expect(prompt.user).toContain('8~10 集');
  });

  it('uses the same duration-derived range in direct and merged screenplay prompts', () => {
    const direct = buildFullScriptPrompt('中文转写', 'zh', 60 * 60);
    const merged = buildMergeScriptPrompt('视觉剧本', '语音转写', '', '', '', 60 * 60);

    for (const prompt of [direct, merged]) {
      expect(`${prompt.system}\n${prompt.user}`).toContain('32~40 集');
      expect(`${prompt.system}\n${prompt.user}`).not.toContain('50~70');
      expect(`${prompt.system}\n${prompt.user}`).not.toContain('30,000-50,000');
    }
  });

  it('uses a duration formula, not a fixed fallback, when duration is unavailable', () => {
    const prompt = buildFullScriptPrompt('中文转写', 'zh');
    const content = `${prompt.system}\n${prompt.user}`;

    expect(content).toContain('按有效剧情时长动态反推');
    expect(content).not.toContain('50~70');
  });
});

describe('buildRewriteFromOutlinePrompt quality constraints', () => {
  it('requires six-way progression rotation and non-template conflict payoffs', () => {
    const { system } = buildRewriteFromOutlinePrompt('原剧本', '详细大纲', 60 * 60);

    expect(system).toContain('选择代价型');
    expect(system).toContain('关系扳机型');
    expect(system).toContain('信息揭露型');
    expect(system).toContain('能力证明型');
    expect(system).toContain('利益翻转型');
    expect(system).toContain('情感共振型');
    expect(system).toContain('连续三集内不得使用同一种推进类型');
    expect(system).toContain('禁止「众人嘲讽→主角亮身份→众人跪舔」');
    expect(system).toContain('围观者反应必须分层');
  });

  it('rotates causal hook types and explicitly bans production meta-commentary', () => {
    const { system } = buildRewriteFromOutlinePrompt('原剧本', '详细大纲', undefined, undefined, {
      start: 11,
      end: 20,
      total: 40,
    });

    expect(system).toContain('行动决策钩子');
    expect(system).toContain('关系变化钩子');
    expect(system).toContain('信息碎片钩子');
    expect(system).toContain('时限压力钩子');
    expect(system).toContain('空间转移钩子');
    expect(system).toContain('连续三集内不得重复使用同一钩子类型');
    expect(system).toContain('最高优先级·元文本禁令');
    expect(system).toContain('本次只生成');
    expect(system).toContain('作为AI');
  });
});
