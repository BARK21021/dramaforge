import React, { createElement } from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { VideoEditor } from "./VideoEditor";

describe("VideoEditor responsive layout", () => {
  it("uses three sibling columns from the 1024px breakpoint", async () => {
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    let root: ReactTestRenderer | undefined;

    await act(async () => {
      root = create(
        createElement(VideoEditor, {
          shots: [
            {
              id: "shot-1",
              shotSeq: 1,
              description: "Opening shot",
              videoStatus: "PENDING",
            },
          ],
          completedShots: 0,
          generatingShots: new Set<string>(),
          isReview: false,
          onRefresh: () => undefined,
          projectId: "project-1",
          onExportFilm: () => undefined,
          exporting: false,
          exportProgress: 0,
          exportStage: "",
        }),
      );
    });

    const layout = root!.root.find(
      (node) =>
        typeof node.props.className === "string" &&
        node.props.className.includes(
          "grid min-h-0 flex-1 grid-cols-1 gap-0",
        ),
    );

    expect(layout.props.className).toContain(
      "lg:grid-cols-[200px_minmax(0,1fr)_240px]",
    );
    expect(
      layout.children
        .filter(
          (child): child is ReactTestInstance =>
            typeof child === "object" && child !== null && "type" in child,
        )
        .map((child) => child.type),
    ).toEqual(["aside", "main", "aside", "div"]);

    await act(async () => root?.unmount());
  });
});
