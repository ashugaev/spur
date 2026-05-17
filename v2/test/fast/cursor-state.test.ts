import { describe, expect, it } from "vitest";
import { classifyCursorPaneState } from "../../src/cursor-state.js";

describe("classifyCursorPaneState", () => {
  it("reports needs_input when the pane shows a trust prompt", () => {
    expect(
      classifyCursorPaneState({
        pane: "Workspace Trust Required\nDo you trust the contents of this directory?",
        activityAt: new Date("2026-03-18T10:00:00.000Z"),
        now: Date.parse("2026-03-18T10:00:05.000Z"),
      }),
    ).toEqual({
      state: "needs_input",
      reason: "Do you trust the contents of this directory?",
    });
  });

  it("treats an empty pane as working while the agent boots", () => {
    expect(
      classifyCursorPaneState({
        pane: "   ",
        activityAt: null,
      }),
    ).toEqual({
      state: "working",
      reason: "empty pane",
    });
  });

  it("treats recent pane activity as working", () => {
    expect(
      classifyCursorPaneState({
        pane: "Cursor Agent\nComposer 2 Fast",
        activityAt: new Date("2026-03-18T10:00:10.000Z"),
        now: Date.parse("2026-03-18T10:00:20.000Z"),
      }),
    ).toEqual({
      state: "working",
      reason: "recent pane activity",
    });
  });

  it("ignores stale trust text once the Composer prompt is below it", () => {
    expect(
      classifyCursorPaneState({
        pane: `Workspace Trust Required
Do you trust the contents of this directory?
Cursor Agent
Composer 2 Fast`,
        activityAt: new Date("2026-03-18T10:00:00.000Z"),
        now: Date.parse("2026-03-18T10:00:20.000Z"),
      }),
    ).toEqual({
      state: "waiting",
      reason: "idle pane",
    });
  });

  it("falls back to waiting when the pane is idle", () => {
    expect(
      classifyCursorPaneState({
        pane: "Cursor Agent\nComposer 2 Fast",
        activityAt: new Date("2026-03-18T10:00:00.000Z"),
        now: Date.parse("2026-03-18T10:00:20.000Z"),
      }),
    ).toEqual({
      state: "waiting",
      reason: "idle pane",
    });
  });
});
