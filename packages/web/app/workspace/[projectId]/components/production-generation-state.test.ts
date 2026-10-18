import { describe, expect, it } from "vitest";
import {
  deriveGeneratingShotIds,
  getEffectiveVideoStatus,
} from "./production-generation-state";

describe("production generation UI state", () => {
  it("treats the active chain targets as generating before shot rows persist that status", () => {
    const shots = [
      { id: "shot-1", videoStatus: "PENDING" },
      { id: "shot-2", videoStatus: "PENDING" },
      { id: "shot-3", videoStatus: "PENDING" },
    ];
    const generatingShotIds = deriveGeneratingShotIds(shots, {
      status: "RUNNING",
      progress: 37,
      targetShotIds: ["shot-2", "shot-3"],
    });

    expect([...generatingShotIds]).toEqual(["shot-2", "shot-3"]);
    expect(
      shots.map((shot) => getEffectiveVideoStatus(shot, generatingShotIds)),
    ).toEqual(["PENDING", "GENERATING", "GENERATING"]);
  });

  it("treats an active chain without targetShotIds as a whole-episode job", () => {
    const shots = [
      { id: "shot-1", videoStatus: "PENDING" },
      { id: "shot-2", videoStatus: "PENDING" },
    ];

    expect([
      ...deriveGeneratingShotIds(shots, {
        status: "PENDING",
        progress: 0,
      }),
    ]).toEqual(["shot-1", "shot-2"]);
  });

  it("removes the chain overlay at terminal state but keeps persisted generating rows", () => {
    const shots = [
      { id: "shot-1", videoStatus: "GENERATING" },
      { id: "shot-2", videoStatus: "PENDING" },
    ];

    expect([
      ...deriveGeneratingShotIds(shots, {
        status: "COMPLETED",
        progress: 100,
        targetShotIds: ["shot-2"],
      }),
    ]).toEqual(["shot-1"]);
  });
});
