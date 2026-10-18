import { describe, expect, it } from 'vitest';
import {
  buildEpisodeSplitPrompt,
  parseEpisodeSplitResponse,
  validateSplitAttempt,
} from '../../src/domain/episode/split-service';

describe('original script episode split contract', () => {
  it('parses fenced JSON and preserves episode content verbatim', () => {
    const source = '第一幕。\n第二幕。';
    const result = parseEpisodeSplitResponse(`说明文字\n\`\`\`json\n${JSON.stringify({
      episodes: [
        { episodeNumber: 1, title: '第一集', content: '第一幕。\n' },
        { episodeNumber: 2, title: '第二集', content: '第二幕。' },
      ],
    })}\n\`\`\``);
    expect(result.map((episode) => episode.content).join('')).toBe(source);
    expect(result.map((episode) => episode.episodeNumber)).toEqual([1, 2]);
  });

  it('rejects responses without usable episode content', () => {
    expect(() => parseEpisodeSplitResponse('{"episodes":[{"content":""}]}')).toThrow(
      'AI 分集返回格式无效',
    );
  });

  it('asks AI to read the complete source and discover the actual episode count dynamically', () => {
    const prompt = buildEpisodeSplitPrompt('第一幕。第二幕。');
    expect(prompt.system).toContain('只切分');
    expect(prompt.system).toContain('不删减');
    expect(prompt.system).toContain('读到最后');
    expect(prompt.system).toContain('动态确定');
    expect(prompt.system).not.toContain('恰好输出 45 集');
  });

  it('includes the frozen original as structural authority for an overseas styled manuscript', () => {
    const source = '第1集\n原文一\n第2集\n原文二';
    const styled = 'Episode 1\nStyled one\nEpisode 2\nStyled two';
    const prompt = buildEpisodeSplitPrompt(styled, undefined, source);

    expect(prompt.system).toContain('结构权威原文');
    expect(prompt.system).toContain('待拆分转风格稿');
    expect(prompt.user).toContain(source);
    expect(prompt.user).toContain(styled);
  });

  it('does not duplicate the manuscript when source and target are the same', () => {
    const script = '第1集\n正文一\n第2集\n正文二';
    const prompt = buildEpisodeSplitPrompt(script, undefined, script);

    expect(prompt.user.match(/第1集/g)).toHaveLength(1);
    expect(prompt.user).not.toContain('结构权威原文开始');
    expect(prompt.user).toContain('待拆分完整剧本开始');
  });

  it('requires unified heading line as the first line of every episode content', () => {
    const prompt = buildEpisodeSplitPrompt('第一幕。第二幕。');
    expect(prompt.system).toContain('统一格式要求');
    expect(prompt.system).toContain('## 第N集');
    expect(prompt.system).toContain('剥离标题行');
  });

  it('anchors cuts on explicit headings and drops the drifted AI boundary', () => {
    // 真实场景复刻：原文含连续「## 第N集」标题行，AI 复述时把上一集结尾的
    // 标点错归到下一集开头（字数漂移的典型症状）。标题锚点必须纠正它。
    const novelText = '项目头\n\n## 第1集\n甲说：你好。\n\n## 第2集\n乙说：再见。\n\n## 第3集\n丙说：走好。';
    // AI 逐字复现时丢了第1集结尾的「。」、把「再」错归给第1集——字数漂移
    const raw = JSON.stringify({
      episodes: [
        { episodeNumber: 1, title: '第 1 集', content: '## 第1集\n甲说：你好' },
        { episodeNumber: 2, title: '第 2 集', content: '。\n\n## 第2集\n乙说：再见。' },
        { episodeNumber: 3, title: '第 3 集', content: '## 第3集\n丙说：走好。' },
      ],
    });

    const result = validateSplitAttempt(raw, novelText);

    expect(result.drafts).toBeDefined();
    expect(result.splitMode).toBe('ai-heading-anchored');
    const contents = result.drafts!.map((d) => d.content);
    // 拼接必须逐字等于原文（在原文上切）
    expect(contents.join('')).toBe(novelText);
    // 每集必须以自己的标题行开头——边界由服务端标题锚点保证，不粘连上集结尾
    // 第1集含项目头+完整结尾；标题前的分隔空行归属上一集（无损）
    expect(contents[0]).toBe('项目头\n\n## 第1集\n甲说：你好。\n\n');
    expect(contents[1]).toBe('## 第2集\n乙说：再见。\n\n');
    expect(contents[2]).toBe('## 第3集\n丙说：走好。');
    // 上集结尾标点归位：第1集结尾「。」不再丢失
    expect(contents[0]).toContain('甲说：你好。');
    // 下集开头不再粘连上集残片：第2集开头就是标题行
    expect(contents[1].startsWith('## 第2集')).toBe(true);
  });

  it('reconstructs losslessly when AI only normalizes punctuation (e.g. quotes English dialogue)', () => {
    // 中英混排剧本：英文台词原文无引号（dramaforge 格式「角色：台词」）。
    const novelText = '第1集\nLeo（哭腔）：Dont cry.\n第2集\nArthur：You cant leave.';
    // AI 逐字复现时给英文台词包了双引号（标点美化），但一个字都没改。
    const raw = JSON.stringify({
      episodes: [
        { episodeNumber: 1, title: '第 1 集', content: '第1集\nLeo（哭腔）："Dont cry."' },
        { episodeNumber: 2, title: '第 2 集', content: '\n第2集\nArthur："You cant leave."' },
      ],
    });

    const result = validateSplitAttempt(raw, novelText);

    expect(result.drafts).toBeDefined();
    // 原文含「第1集/第2集」标题行 → 标题锚点优先，切点精确
    expect(result.splitMode).toBe('ai-heading-anchored');
    // 拼接必须逐字等于原文：原文标点保留，AI 多加的引号被丢弃。
    expect(result.drafts!.map((draft) => draft.content).join('')).toBe(novelText);
    // 任一集 content 都不得含 AI 凭空添加的双引号。
    expect(result.drafts!.every((draft) => !draft.content.includes('"'))).toBe(true);
  });

  it('still rejects when AI substantially rewrote content (length ratio outside tolerance)', () => {
    // AI 把原文大幅扩写改写：纯字流不等（字内容不同）且紧凑长度比远超 1.5% 容差，
    // 标点无关档与近无损容错档都不应放行——防止 AI 失控改写却被原文重切静默吞掉。
    const novelText = '甲集短。乙集短。';
    const raw = JSON.stringify({
      episodes: [
        { episodeNumber: 1, title: '一', content: '甲集被扩写成长得多的完全不同内容文字。' },
        { episodeNumber: 2, title: '二', content: '乙集同样被改写并扩写了很多额外字。' },
      ],
    });

    const result = validateSplitAttempt(raw, novelText);

    expect(result.drafts).toBeUndefined();
    expect(result.failureReason).toContain('无损覆盖失败');
  });

  it('uses word-flow tolerance (95-105%) as fallback when AI altered a few chars', () => {
    // 原文 20 字；AI 第 2 集多输 1 字（字流比例 21/20=1.05，落在 95-105 兜底带）。
    const novelText = '甲乙丙丁戊甲乙丙丁戊甲乙丙丁戊甲乙丙丁戊';
    const raw = JSON.stringify({
      episodes: [
        { episodeNumber: 1, title: '一', content: '甲乙丙丁戊甲乙丙丁戊' },
        { episodeNumber: 2, title: '二', content: '甲乙丙丁戊甲乙丙丁戊甲' },
      ],
    });
    const result = validateSplitAttempt(raw, novelText);
    expect(result.drafts).toBeDefined();
    expect(result.splitMode).toBe('ai-whitespace-repaired');
    // 兜底用原文重切，拼接逐字无损；AI 多输的字被丢弃。
    expect(result.drafts!.map((d) => d.content).join('')).toBe(novelText);
  });

  it('anchors on unified headings even when AI adds heading lines to a headingless novel', () => {
    // 无标题剧本：AI 按统一格式契约在 content 第一行加「## 第N集」，正文逐字取自原文。
    // 服务端剥离标题行后拼接必须仍等于原文（内容无损），并用锚点串定位切点。
    const novelText = '第一幕甲说你好。\n第二幕乙说再见。\n第三幕丙说走好。';
    const raw = JSON.stringify({
      episodes: [
        { episodeNumber: 1, title: '第 1 集', content: '## 第1集\n第一幕甲说你好。' },
        { episodeNumber: 2, title: '第 2 集', content: '## 第2集\n第二幕乙说再见。' },
        { episodeNumber: 3, title: '第 3 集', content: '## 第3集\n第三幕丙说走好。' },
      ],
    });

    const result = validateSplitAttempt(raw, novelText);

    expect(result.drafts).toBeDefined();
    // 原文无显式标题（无 ## 行），但 AI 标题行被剥离后拼接==原文 → 锚点串定位
    expect(result.drafts!.map((d) => d.content).join('')).toBe(novelText);
    // 落库 content 必须是原文切片：不得残留 AI 添加的标题行（否则拼接≠原文）
    expect(result.drafts!.some((d) => d.content.startsWith('## 第'))).toBe(false);
  });
});
