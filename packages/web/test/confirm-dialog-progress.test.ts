import React, { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@radix-ui/react-dialog", async () => {
  const ReactModule = await import("react");
  const host = (name: string) =>
    function Primitive({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
      return ReactModule.createElement(
        "div",
        { ...props, "data-dialog-primitive": name },
        children,
      );
    };

  return {
    Root: host("dialog-root"),
    Portal: host("dialog-portal"),
    Overlay: host("dialog-overlay"),
    Content: host("dialog-content"),
  };
});

import { ConfirmDialog } from "../components/ui/ConfirmDialog";

describe("ConfirmDialog processing progress", () => {
  it("处理中锁定取消和关闭，并在确认按钮显示进度条", async () => {
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    let root: ReactTestRenderer | undefined;

    await act(async () => {
      root = create(
        createElement(ConfirmDialog, {
          open: true,
          title: "删除项目",
          message: "正在删除",
          onCancel,
          onConfirm,
          loading: true,
        }),
      );
    });

    const dialogRoot = root!.root.findByProps({ "data-dialog-primitive": "dialog-root" });
    act(() => dialogRoot.props.onOpenChange(false));
    expect(onCancel).not.toHaveBeenCalled();

    const content = root!.root.findByProps({ "data-dialog-primitive": "dialog-content" });
    const escapeEvent = { preventDefault: vi.fn() };
    act(() => content.props.onEscapeKeyDown(escapeEvent));
    expect(escapeEvent.preventDefault).toHaveBeenCalledOnce();

    const buttons = root!.root.findAllByType("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].props.disabled).toBe(true);
    expect(buttons[1].props.disabled).toBe(true);
    expect(buttons[1].props["aria-busy"]).toBe(true);
    expect(root!.root.findAllByProps({ role: "progressbar" })).toHaveLength(1);

    await act(async () => root?.unmount());
  });

  it("非处理状态仍可以取消关闭", async () => {
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    const onCancel = vi.fn();
    let root: ReactTestRenderer | undefined;

    await act(async () => {
      root = create(
        createElement(ConfirmDialog, {
          open: true,
          title: "确认",
          message: "请确认",
          onCancel,
          onConfirm: vi.fn(),
        }),
      );
    });

    act(() =>
      root!.root
        .findByProps({ "data-dialog-primitive": "dialog-root" })
        .props.onOpenChange(false),
    );
    expect(onCancel).toHaveBeenCalledOnce();

    await act(async () => root?.unmount());
  });
});
