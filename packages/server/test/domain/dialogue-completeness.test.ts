import { describe, expect, it } from 'vitest';
import {
  extractDialogueLines,
  verifyDialogueCompleteness,
} from '../../src/domain/storyboard/dialogue-completeness';

describe('verifyDialogueCompleteness（原文 novelText vs 分镜台词）', () => {
  it('所有台词都在分镜 → 返回空(无缺失)', () => {
    const novelText = [
      '## S1 [场景] 角色：Leo',
      '造型：Leo=黑发',
      '△Leo 走进房间。',
      'Leo（叹气）：Another damn nightmare.',
      'Leo：What the hell?!',
      '【字幕：Academy】',
    ].join('\n');
    const shots = ['Leo：Another damn nightmare.', 'Leo：What the hell?!'];
    expect(verifyDialogueCompleteness(novelText, shots)).toEqual([]);
  });

  it('漏掉一句 → 该句进缺失清单(复现 ep32 Campus security 漏写)', () => {
    const novelText = [
      'Gemma：Give me the report.',
      'Assistant：The Styling Club consultation room is packed.',
      'Gemma：Good. Campus security?',
      'Assistant：Risk assessments around the Dark Beast Forest are complete.',
      'Gemma：Lift the lockdown? Arthur approved this?',
    ].join('\n');
    // 分镜漏了中间两句(Gemma 校园安全 + Assistant 风险评估)
    const shots = [
      'Gemma：Give me the report.',
      'Assistant：The Styling Club consultation room is packed.',
      'Gemma：Lift the lockdown? Arthur approved this?',
    ];
    const missing = verifyDialogueCompleteness(novelText, shots);
    expect(missing).toHaveLength(2);
    expect(missing[0].line).toBe('Gemma：Good. Campus security?');
    expect(missing[1].line).toBe('Assistant：Risk assessments around the Dark Beast Forest are complete.');
  });

  it('弯撇号 vs 直撇号不影响判定(都算命中)', () => {
    const novelText = "Leo：We're Professor Crow's students too."; // novelText 直撇号
    const shots = ["Leo：We’re Professor Crow’s students too."]; // 分镜弯撇号
    expect(verifyDialogueCompleteness(novelText, shots)).toEqual([]);
  });

  it('同义改写但文本不同 → 算缺失(严格匹配,不认改写)', () => {
    const novelText = "Leo：No wonder they're putting on an act, The Strategist taught them.";
    const shots = ["Leo：No wonder they're all acting. The Strategist taught them, didn't he?"];
    // 文本不同 → 严格匹配判为缺失(提示人工确认是否改写)
    const missing = verifyDialogueCompleteness(novelText, shots);
    expect(missing).toHaveLength(1);
  });

  it('短句(单字叫名 Leo.)漏了 → 能查出', () => {
    const novelText = ['Ulysses（冷淡）：Leo.', 'Ulysses（面无表情）：I need to talk to you.'].join('\n');
    const shots = ['Ulysses：I need to talk to you.']; // 漏了 "Leo."
    const missing = verifyDialogueCompleteness(novelText, shots);
    expect(missing).toHaveLength(1);
    expect(missing[0].line).toBe('Ulysses（冷淡）：Leo.');
  });
});

describe('extractDialogueLines', () => {
  it('只抽台词行,排除造型/场景头/字幕/动作', () => {
    const novelText = [
      '## S1 [石阶 · 夜] 角色：Leo',
      '造型：Leo（幼年）=黑发',
      '△年幼的 Leo 蜷缩着。',
      "Leo（幼年）（哭腔）：Don't cry.",
      '【字幕：Academy Courtyard】',
      '第 36 集 《测试剧》',
    ].join('\n');
    const lines = extractDialogueLines(novelText);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Don't cry.");
  });
});
