import { describe, expect, it } from "vitest";
import {
  SLOT_TOOL_NAME,
  applySlotsUpdate,
  normalizeSlotsUpdate,
  withSessionSlotInstructions,
} from "../../src/session-slots.js";

describe("session slots", () => {
  it("normalizes and merges title and named links", () => {
    const updated = applySlotsUpdate(
      {
        title: "Current task",
        links: [{ label: "tracker", url: "https://tracker.example.com/TASK-1" }],
      },
      {
        links: [
          { label: "PR", url: "https://github.com/org/repo/pull/42" },
          { label: "tracker", url: "https://tracker.example.com/TASK-2" },
        ],
      },
    );

    expect(updated).toEqual({
      title: "Current task",
      links: [
        { label: "tracker", url: "https://tracker.example.com/TASK-2" },
        { label: "pr", url: "https://github.com/org/repo/pull/42" },
      ],
    });
  });

  it("removes title and links when explicitly cleared", () => {
    const updated = applySlotsUpdate(
      {
        title: "Current task",
        links: [{ label: "tracker", url: "https://tracker.example.com/TASK-1" }],
      },
      {
        clearTitle: true,
        unlinkLabels: ["tracker"],
      },
    );

    expect(updated).toBeUndefined();
  });

  it("rejects invalid link labels and empty updates", () => {
    expect(() =>
      normalizeSlotsUpdate({
        links: [{ label: "bad label", url: "https://example.com" }],
      }),
    ).toThrow("slot link labels must match");

    expect(() => normalizeSlotsUpdate({})).toThrow("slot update requires at least one change");
  });

  it("injects helper instructions only once", () => {
    const prompt = withSessionSlotInstructions("Fix the build");
    expect(prompt).toContain(SLOT_TOOL_NAME);
    expect(withSessionSlotInstructions(prompt)).toBe(prompt);
  });
});
