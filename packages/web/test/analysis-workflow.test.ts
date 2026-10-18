import { describe, expect, it, vi } from "vitest";
import { runAnalysisWorkflow } from "../lib/analysis-workflow";

describe("runAnalysisWorkflow (202 inline-task 契约)", () => {
  it("POST /analyze 拿 202 { taskId }，查资产为空 → needAssetExtraction=true，不阻塞", async () => {
    const api = vi
      .fn()
      // 1. POST /analyze → 202 { taskId }
      .mockResolvedValueOnce({ taskId: "task-1" })
      // 2. GET /assets → 空（首次分析）
      .mockResolvedValueOnce({ assets: [] });
    const progress = vi.fn();

    const result = await runAnalysisWorkflow({
      api,
      projectId: "project-1",
      episodeId: "episode-1",
      model: "deepseek/deepseek-v4-pro",
      onProgress: progress,
    });

    expect(result).toEqual({ taskId: "task-1", needAssetExtraction: true });
    expect(api).toHaveBeenNthCalledWith(
      1,
      "/api/projects/project-1/episodes/episode-1/analyze",
      expect.objectContaining({ method: "POST" }),
    );
    expect(api).toHaveBeenNthCalledWith(
      2,
      "/api/projects/project-1/assets",
      expect.objectContaining({ method: "GET" }),
    );
    // 不再顺序调用 POST /asset-extraction（由 onComplete 触发）
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("项目已有资产 → needAssetExtraction=false", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ taskId: "task-2" })
      .mockResolvedValueOnce({ assets: [{ id: "a-1" }, { id: "a-2" }] });

    const result = await runAnalysisWorkflow({
      api,
      projectId: "project-1",
      episodeId: "episode-1",
    });

    expect(result).toEqual({ taskId: "task-2", needAssetExtraction: false });
  });

  it("POST /analyze 返回 null（预检/鉴权失败）→ 返回 null", async () => {
    const api = vi.fn().mockResolvedValueOnce(null);

    await expect(
      runAnalysisWorkflow({
        api,
        projectId: "project-1",
        episodeId: "episode-1",
      }),
    ).resolves.toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("响应无 taskId 字段（旧契约/异常）→ 返回 null", async () => {
    const api = vi.fn().mockResolvedValueOnce({ episode: { id: "e-1" } });

    await expect(
      runAnalysisWorkflow({
        api,
        projectId: "project-1",
        episodeId: "episode-1",
      }),
    ).resolves.toBeNull();
  });
});
