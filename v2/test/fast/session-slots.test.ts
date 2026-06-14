import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSessionSlotTool,
  PROJECT_MEMORY_TOOL_NAME,
  SLOT_TOOL_NAME,
  AGENT_STATE_TOOL_NAME,
  applySlotsUpdate,
  normalizeSlotsUpdate,
  withProjectMemoryInstructions,
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

  it("normalizes legacy PR aliases to pr", () => {
    expect(
      normalizeSlotsUpdate({
        links: [{ label: "github_pr", url: "https://github.com/org/repo/pull/9" }],
      }),
    ).toEqual({
      clearTitle: false,
      links: [{ label: "pr", url: "https://github.com/org/repo/pull/9" }],
      unlinkLabels: [],
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

  it("sets title once when no current title exists", () => {
    const updated = applySlotsUpdate(undefined, { title: "T", setTitleIfAbsent: true });
    expect(updated?.title).toBe("T");
  });

  it("preserves existing title when setTitleIfAbsent is true", () => {
    const updated = applySlotsUpdate(
      { title: "Old", links: [] },
      { title: "New", setTitleIfAbsent: true },
    );
    expect(updated?.title).toBe("Old");
  });

  it("overwrites title without setTitleIfAbsent", () => {
    const updated = applySlotsUpdate({ title: "Old", links: [] }, { title: "New" });
    expect(updated?.title).toBe("New");
  });

  it("treats empty current title as absent for setTitleIfAbsent", () => {
    const updated = applySlotsUpdate(
      { title: "", links: [] },
      { title: "First", setTitleIfAbsent: true },
    );
    expect(updated?.title).toBe("First");
  });

  it("rejects setTitleIfAbsent without a title", () => {
    expect(() => normalizeSlotsUpdate({ setTitleIfAbsent: true })).toThrow(
      "setTitleIfAbsent requires a title",
    );
  });

  it("injects helper instructions only once", () => {
    const prompt = withSessionSlotInstructions("Fix the build");
    expect(prompt).toContain(SLOT_TOOL_NAME);
    expect(prompt).toContain("Set the session title once at task start");
    expect(prompt).toContain("--title-if-absent");
    expect(prompt).toContain("describe the whole task end-to-end");
    expect(prompt).toContain("--link pr=https://...");
    expect(prompt).toContain("Use `spur service logs` to inspect service and sidecar logs");
    expect(withSessionSlotInstructions(prompt)).toBe(prompt);
  });

  it("injects project memory instructions only once", () => {
    const prompt = withProjectMemoryInstructions("Fix the build");
    expect(prompt).toContain(PROJECT_MEMORY_TOOL_NAME);
    expect(prompt).toContain("Read shared project memory before final checks");
    expect(prompt).toContain("user-feedback-derived rules");
    expect(prompt).toContain(".spur/memory.tsv");
    expect(prompt).toContain("id<TAB>text");
    expect(withProjectMemoryInstructions(prompt)).toBe(prompt);
  });

  it("writes the spur wrapper alongside slot helpers", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-1",
      configPath: "/tmp/spur.yaml",
      projectPath: "/tmp/project",
    });

    const wrapper = readFileSync(join(toolDir, "spur"), "utf8");
    expect(wrapper).toContain("--config '/tmp/spur.yaml'");
    expect(wrapper).toContain('"$@"');
    expect(readFileSync(join(toolDir, SLOT_TOOL_NAME), "utf8")).toContain(
      'exec "$SCRIPT_DIR/spur" slots --session \'api-1\' "$@"',
    );
  });

  it("writes spur-sidecar wrapper through the local spur helper", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-2",
      configPath: "/tmp/spur.yaml",
      projectPath: "/tmp/project",
    });

    const sidecar = readFileSync(join(toolDir, "spur-sidecar"), "utf8");
    expect(sidecar).toContain('exec "$SCRIPT_DIR/spur" sidecar "$action" --session \'api-2\' "$@"');
    expect(sidecar).toContain('action="start"');
    expect(sidecar).toContain('if [[ "$' + '{1-}" == "start" || "$' + '{1-}" == "stop" ]]');
  });

  it("writes project memory helper for flat TSV rules", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    const projectDir = await createTempDir("spur-memory-project-");
    tempDirs.push(dataDir, projectDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-5",
      configPath: "/tmp/spur.yaml",
      projectPath: projectDir,
    });
    const toolPath = join(toolDir, PROJECT_MEMORY_TOOL_NAME);

    const id = execFileSync(toolPath, ["add", "Use Sidecar for tests unless user bypasses it."], {
      env: { ...process.env },
      encoding: "utf8",
    }).trim();

    expect(id).toMatch(/^pm_\d{8}_0001$/);
    expect(execFileSync(toolPath, ["read"], { env: { ...process.env }, encoding: "utf8" })).toBe(
      `${id}\tUse Sidecar for tests unless user bypasses it.\n`,
    );
    expect(readFileSync(join(projectDir, ".spur", "memory.tsv"), "utf8")).toBe(
      `${id}\tUse Sidecar for tests unless user bypasses it.\n`,
    );

    execFileSync(toolPath, ["remove", id], { env: { ...process.env } });
    expect(execFileSync(toolPath, ["read"], { env: { ...process.env }, encoding: "utf8" })).toBe(
      "",
    );
  });

  it("lets spur-sidecar follow an overwritten local spur wrapper", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-3",
      configPath: "/tmp/spur.yaml",
      projectPath: "/tmp/project",
    });

    const captureFile = join(dataDir, "captured-args.txt");
    writeFileSync(
      join(toolDir, "spur"),
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

  it("skips hook-state helper scripts for cursor sessions", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-3",
      configPath: "/tmp/spur.yaml",
      projectPath: "/tmp/project",
      agent: "cursor",
    });

    expect(() => readFileSync(join(toolDir, AGENT_STATE_TOOL_NAME), "utf8")).toThrow();
  });

  it("maps structured question metadata to needs_input in the agent state helper", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-4",
      configPath: "/tmp/spur.yaml",
      projectPath: "/tmp/project",
    });

    execFileSync(join(toolDir, "spur-agent-state"), {
      env: { ...process.env },
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        turn_id: "api-4-7",
        questions: [{ header: "Plan", question: "Which tier should I run next?" }],
      }),
    });

    const state = JSON.parse(
      readFileSync(join(dataDir, "session-agent-state", "api-4.json"), "utf8"),
    ) as {
      state: string;
      hookEvent?: string;
      turnId?: string;
    };

    expect(state).toMatchObject({
      state: "needs_input",
      hookEvent: "UserPromptSubmit",
      turnId: "api-4-7",
    });
  });
});
