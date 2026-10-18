import { describe, expect, it } from 'vitest';

import {
  assertRewriteStructurePreserved,
  extractTimecodeRanges,
} from '../lib/seedance-narrative-rewrite';

// 一段贴近真实生产的镜头组提示词片段（含开场连续性锁定 + 单镜时间码 + 画面/镜头行）。
const ORIGINAL = [
  '## 开场连续性锁定',
  '主体开场状态：[瓦莱莉娅]+[伊莱亚斯身后]+[抬起下巴点头，眼眶边缘有极浅湿意]',
  '首尾衔接：本组首镜紧接上一镜头组的末帧（即本组参考图的最后一张），继承其场景状态与主光方向。',
  '',
  '### 当前生成组分镜',
  '',
  'Shot 1 [00:00-00:05]（5.0秒）',
  '画面：特写，固定，平视，瓦莱莉娅眼眶边缘的浅湿在壁炉光下反射微光。',
  '镜头：特写、平视，固定；从瓦莱莉娅深吸一口气开始，结束在肩膀下沉。',
  '',
  'Shot 2 [00:05-00:10]（5.0秒）',
  '画面：中景，缓推，平视，瓦莱莉娅转身走向书架。',
  '镜头：中景、平视，缓推；从转身开始，结束在手指触碰书脊。',
].join('\n');

describe('extractTimecodeRanges', () => {
  it('提取所有 [MM:SS-MM:SS] 区间', () => {
    expect(extractTimecodeRanges(ORIGINAL)).toEqual(['00:00-00:05', '00:05-00:10']);
  });

  it('兼容全角连字符与空格', () => {
    expect(extractTimecodeRanges('Shot 1 [00:00—00:05]')).toEqual(['00:00-00:05']);
    expect(extractTimecodeRanges('Shot 1 [00:00 - 00:05]')).toEqual(['00:00-00:05']);
  });

  it('无时间码返回空数组', () => {
    expect(extractTimecodeRanges('没有任何时间码的文本')).toEqual([]);
  });
});

describe('assertRewriteStructurePreserved', () => {
  it('忠实重写（同时间码 + 衔接标记保留）不抛', () => {
    const rewritten = ORIGINAL.replace('瓦莱莉娅眼眶边缘的浅湿', '瓦莱莉娅眼角的微光');
    expect(() => assertRewriteStructurePreserved(ORIGINAL, rewritten)).not.toThrow();
  });

  it('丢失一个时间码（镜头被删/合并）→ 抛', () => {
    const rewritten = ORIGINAL.split('\n').filter((l) => !l.startsWith('Shot 2')).join('\n');
    expect(() => assertRewriteStructurePreserved(ORIGINAL, rewritten)).toThrow(/时间码数量/);
  });

  it('改写时间码值（时长错位）→ 抛', () => {
    const rewritten = ORIGINAL.replace('[00:00-00:05]', '[00:00-00:03]');
    expect(() => assertRewriteStructurePreserved(ORIGINAL, rewritten)).toThrow(/丢失\/改写了时间码/);
  });

  it('删除主体开场状态行 → 抛', () => {
    const rewritten = ORIGINAL.split('\n').filter((l) => !l.startsWith('主体开场状态')).join('\n');
    expect(() => assertRewriteStructurePreserved(ORIGINAL, rewritten)).toThrow(/主体开场状态/);
  });

  it('删除首尾衔接行 → 抛', () => {
    const rewritten = ORIGINAL.split('\n').filter((l) => !l.startsWith('首尾衔接')).join('\n');
    expect(() => assertRewriteStructurePreserved(ORIGINAL, rewritten)).toThrow(/首尾衔接/);
  });

  it('原文无衔接标记时不强制要求（首组无上一组）→ 不抛', () => {
    const noLock = [
      '### 当前生成组分镜',
      'Shot 1 [00:00-00:05]（5.0秒）',
      '画面：开场全景。',
    ].join('\n');
    expect(() => assertRewriteStructurePreserved(noLock, noLock.replace('开场全景', '开场的全景'))).not.toThrow();
  });
});
