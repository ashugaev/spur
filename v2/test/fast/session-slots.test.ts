import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
    expect(prompt).toContain(
      "Update the session title and related links as soon as you know them.",
    );
    expect(prompt).toContain("Use `spur service logs` to inspect service and sidecar logs");
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
    const sessionWrapper = readFileSync(join(toolDir, "spur-session"), "utf8");
    expect(wrapper).toContain("--config '/tmp/spur.yaml'");
    expect(wrapper).toContain('"$@"');
    expect(sessionWrapper).toContain("--config '/tmp/spur.yaml'");
    expect(readFileSync(join(toolDir, SLOT_TOOL_NAME), "utf8")).toContain(
      'exec "$SCRIPT_DIR/spur-session" slots --session \'api-1\' "$@"',
    );
  });

  it("writes spur-sidecar wrapper through the local spur helper", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-2",
      configPath: "/tmp/spur.yaml",
    });

    const sidecar = readFileSync(join(toolDir, "spur-sidecar"), "utf8");
    expect(sidecar).toContain(
      'exec "$SCRIPT_DIR/spur-session" sidecar "$action" --session \'api-2\' "$@"',
    );
    expect(sidecar).toContain('action="start"');
    expect(sidecar).toContain('if [[ "$' + '{1-}" == "start" || "$' + '{1-}" == "stop" ]]');
  });

  it("keeps spur-sidecar bound to the stable session wrapper when spur is overwritten", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-3",
      configPath: "/tmp/spur.yaml",
    });

    const captureFile = join(dataDir, "captured-args.txt");
    writeFileSync(
      join(toolDir, "spur"),
      `#!/usr/bin/env bash
set -euo pipefail
exit 7
`,
      { encoding: "utf8", mode: 0o755 },
    );
    writeFileSync(
      join(toolDir, "spur-session"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > ${JSON.stringify(captureFile)}
`,
      { encoding: "utf8", mode: 0o755 },
    );

    execFileSync(join(toolDir, "spur-sidecar"), ["stop", "--name", "isolated-ui"], {
      env: { ...process.env },
    });

    expect(readFileSync(captureFile, "utf8")).toBe(
      ["sidecar", "stop", "--session", "api-3", "--name", "isolated-ui", ""].join("\n"),
    );
  });
});
