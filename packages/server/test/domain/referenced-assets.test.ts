// ============================================================
// ③ server/domain/storyboard — validateReferencedAssetsShape 单测
// ============================================================
//
// 单镜头资产重绑的结构校验纯函数（形状/非空/子集/上限）。
// 名字解析校验（listAssets + normalizeAssetName）在 web 路由测试覆盖。

import { describe, it, expect } from 'vitest';
import {
  validateReferencedAssetsShape,
  REFERENCED_ASSETS_LIMITS,
} from '../../src/domain/storyboard/validation';

describe('validateReferencedAssetsShape', () => {
  it('null / undefined 视为合法（不更新该字段）', () => {
    expect(validateReferencedAssetsShape(null).valid).toBe(true);
    expect(validateReferencedAssetsShape(undefined).valid).toBe(true);
  });

  it('非对象（数组/字符串）拒绝', () => {
    expect(validateReferencedAssetsShape([] as never).valid).toBe(false);
    expect(validateReferencedAssetsShape('x' as never).valid).toBe(false);
  });

  it('正常对象通过', () => {
    expect(
      validateReferencedAssetsShape({
        characters: ['林夏'],
        speakingCharacters: ['林夏'],
        environments: ['采石场'],
        items: ['旧雨伞'],
      }).valid,
    ).toBe(true);
  });

  it('部分字段（只给 characters）通过', () => {
    expect(validateReferencedAssetsShape({ characters: ['林夏'] }).valid).toBe(true);
  });

  it('空数组通过', () => {
    expect(validateReferencedAssetsShape({ characters: [] }).valid).toBe(true);
  });

  it('字段非数组拒绝', () => {
    expect(validateReferencedAssetsShape({ characters: '林夏' } as never).valid).toBe(false);
  });

  it('数组含空串/纯空白/非字符串 拒绝', () => {
    expect(validateReferencedAssetsShape({ characters: ['林夏', ''] }).valid).toBe(false);
    expect(validateReferencedAssetsShape({ characters: ['  '] }).valid).toBe(false);
    expect(validateReferencedAssetsShape({ characters: ['林夏', 5] } as never).valid).toBe(false);
  });

  it('characters 超上限拒绝', () => {
    const tooMany = Array.from(
      { length: REFERENCED_ASSETS_LIMITS.characters + 1 },
      (_, i) => `角色${i}`,
    );
    expect(validateReferencedAssetsShape({ characters: tooMany }).valid).toBe(false);
  });

  it('speakingCharacters ⊆ characters 通过', () => {
    expect(
      validateReferencedAssetsShape({ characters: ['林夏', '白药'], speakingCharacters: ['林夏'] })
        .valid,
    ).toBe(true);
  });

  it('speakingCharacters 引用未在 characters 的角色拒绝', () => {
    expect(
      validateReferencedAssetsShape({ characters: ['林夏'], speakingCharacters: ['白药'] }).valid,
    ).toBe(false);
  });

  it('speakingCharacters 归一化匹配（标点/大小写/空格无关）', () => {
    // characters='林夏'，speaking='林 夏' 归一化后均为 '林夏' → 通过
    expect(
      validateReferencedAssetsShape({ characters: ['林夏'], speakingCharacters: ['林 夏'] }).valid,
    ).toBe(true);
  });

  it('speakingCharacters 存在但 characters 缺失 拒绝', () => {
    expect(validateReferencedAssetsShape({ speakingCharacters: ['林夏'] }).valid).toBe(false);
  });
});
