import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSessionSlotTool,
  SLOT_TOOL_NAME,
  applySlotsUpdate,
  normalizeSlotsUpdate,
  withSessionSlotInstructions,
} from "../../src/session-slots.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

  it("writes the spur wrapper alongside slot helpers", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-1",
      configPath: "/tmp/spur.yaml",
    });

    const wrapper = readFileSync(join(toolDir, "spur"), "utf8");
    expect(wrapper).toContain("--config '/tmp/spur.yaml'");
    expect(wrapper).toContain('"$@"');
    expect(readFileSync(join(toolDir, SLOT_TOOL_NAME), "utf8")).toContain(
      "slots --session 'api-1'",
    );
  });

  it("writes spur-sidecar wrapper pointing at prod config", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-2",
      configPath: "/tmp/spur.yaml",
    });

    const sidecar = readFileSync(join(toolDir, "spur-sidecar"), "utf8");
    expect(sidecar).toContain("sidecar start");
    expect(sidecar).toContain("--session 'api-2'");
    expect(sidecar).toContain("--config '/tmp/spur.yaml'");
  });
});
