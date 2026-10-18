import React, { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';

describe('Button processing progress', () => {
  it('loading 按钮始终渲染条形进度，并保持忙碌与禁用语义', async () => {
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    let root: ReactTestRenderer | undefined;

    await act(async () => {
      root = create(createElement(Button, { loading: true }, '保存中'));
    });

    const button = root!.root.findByType('button');
    expect(button.props['aria-busy']).toBe(true);
    expect(button.props.disabled).toBe(true);
    expect(root!.root.findAllByProps({ role: 'progressbar' })).toHaveLength(1);

    await act(async () => root?.unmount());
  });

  it('有真实百分比时把数值写入按钮进度条', async () => {
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    let root: ReactTestRenderer | undefined;

    await act(async () => {
      root = create(createElement(Button, { loading: true, progress: 42 }, '导出中'));
    });

    const progressbar = root!.root.findByProps({ role: 'progressbar' });
    expect(progressbar.props['aria-valuenow']).toBe(42);
    expect(
      progressbar.findAll((node) => node.props.style?.width === '42%'),
    ).toHaveLength(1);

    await act(async () => root?.unmount());
  });

  it('旧 Spinner 调用点统一渲染横向进度条，不再输出转圈动画', async () => {
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    let root: ReactTestRenderer | undefined;

    await act(async () => {
      root = create(createElement(Spinner, { size: 28 }));
    });

    const progressbar = root!.root.findByProps({ role: 'progressbar' });
    expect(progressbar.props.style.width).toBe(84);
    expect(String(progressbar.props.className)).not.toContain('animate-spin');

    await act(async () => root?.unmount());
  });

  it('高频异步操作统一接入 Button loading，避免只改文案而没有按钮进度', () => {
    const sources = [
      '../components/features/GenerationProgress.tsx',
      '../components/features/ApiKeyPoolCard.tsx',
      '../app/workspace/[projectId]/components/EpisodeListStage.tsx',
      '../app/settings/page.tsx',
    ].map((relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8'));

    expect(sources[0]).toContain('loading={cancelling}');
    expect(sources[0]).toContain('loading={retrying}');
    expect(sources[1]).toContain('loading={isResetting}');
    expect(sources[1]).toContain('loading={isToggling}');
    expect(sources[2]).toContain('loading={reordering?.index === idx && reordering.dir === -1}');
    expect(sources[2]).toContain('loading={reordering?.index === idx && reordering.dir === 1}');
    expect(sources[3]).toContain('loading={signingOut}');
  });
});
