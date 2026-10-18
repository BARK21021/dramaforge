import React, { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldAddToast, ToastProvider, useToast } from '../components/ui/Toast';

afterEach(() => {
  vi.useRealTimers();
});

describe('shouldAddToast', () => {
  it('同类型同文案仍在显示时不重复入队', () => {
    const active = [{ id: 1, type: 'error' as const, message: '云端服务暂时不可用，请稍后重试' }];

    expect(shouldAddToast(active, 'error', '云端服务暂时不可用，请稍后重试')).toBe(false);
    expect(shouldAddToast(active, 'warning', '云端服务暂时不可用，请稍后重试')).toBe(true);
  });

  it('新增 toast 前后保持 context value 引用稳定', async () => {
    vi.useFakeTimers();
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    const observed: Array<ReturnType<typeof useToast>> = [];

    function Probe() {
      observed.push(useToast());
      return null;
    }

    let root: ReactTestRenderer | undefined;
    await act(async () => {
      root = create(createElement(ToastProvider, null, createElement(Probe)));
    });
    const before = observed.at(-1);
    expect(before).toBeDefined();

    await act(async () => {
      before!.error('触发 provider 内部状态更新');
    });

    expect(observed.at(-1)).toBe(before);
    await act(async () => root?.unmount());
    vi.clearAllTimers();
  });
});
