import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSessionSlotTool,
  SLOT_TOOL_NAME,
  AGENT_STATE_TOOL_NAME,
  applySlotsUpdate,
  normalizeSlotsUpdate,
  withSessionSlotInstructions,
  TODO_TOOL_NAME,
} from "../../src/session-slots.js";
import { SELF_DESTRUCT_TOOL_NAME } from "../../src/self-destruct.js";
import { createTempDir, findFreePort } from "../helpers/common.js";

const tempDirs: string[] = [];
const PARAM_EXPANSION_OPEN = "$" + "{";

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
      tags: [],
      untags: [],
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
    expect(prompt).toContain("spur agent-issue log");
    expect(withSessionSlotInstructions(prompt)).toBe(prompt);
  });

  it("still injects helper instructions when the prompt asks for a tag by name without naming the CLI", () => {
    const prompt = withSessionSlotInstructions(
      "Run /code-review {{url}}.\nApply the `review` tag to this session.",
      [{ name: "review", description: "Reviewing a PR", color: "hsl(210 62% 64%)" }],
    );
    expect(prompt).toContain(SLOT_TOOL_NAME);
    expect(prompt).toContain("Task tags:");
    expect(prompt).toContain("`review` — Reviewing a PR");
  });

  it("lists available tags in helper instructions when a catalog is provided", () => {
    const prompt = withSessionSlotInstructions("Fix the build", [
      { name: "bug", description: "Fixing a defect", color: "hsl(0 62% 64%)" },
      { name: "docs", description: "Documentation only", color: "hsl(120 62% 64%)" },
    ]);
    expect(prompt).toContain("Task tags:");
    expect(prompt).toContain("Apply a tag only on a clear description match");
    expect(prompt).toContain("apply none");
    expect(prompt).toContain('"$SPUR_SLOT_COMMAND" --tag <name>');
    expect(prompt).toContain('"$SPUR_SLOT_COMMAND" --list-tags');
    expect(prompt).toContain("`bug` — Fixing a defect");
    expect(prompt).toContain("`docs` — Documentation only");
  });

  it("omits the tag block when no catalog is configured", () => {
    expect(withSessionSlotInstructions("Fix the build")).not.toContain("Task tags:");
  });

  it("normalizes tag names and rejects invalid ones", () => {
    expect(normalizeSlotsUpdate({ tags: ["Bug", " docs "], untags: ["OLD"] })).toMatchObject({
      tags: ["bug", "docs"],
      untags: ["old"],
    });
    expect(() => normalizeSlotsUpdate({ tags: ["not a tag"] })).toThrow("tag names must match");
  });

  it("adds, removes, and de-duplicates tags while preserving existing ones", () => {
    const added = applySlotsUpdate({ links: [], tags: ["bug"] }, { tags: ["bug", "docs"] });
    expect(added?.tags).toEqual(["bug", "docs"]);

    const removed = applySlotsUpdate({ links: [], tags: ["bug", "docs"] }, { untags: ["bug"] });
    expect(removed?.tags).toEqual(["docs"]);

    const preserved = applySlotsUpdate({ links: [], tags: ["bug"] }, { title: "Renamed task" });
    expect(preserved?.tags).toEqual(["bug"]);
  });

  it("drops slots when the last tag is removed and nothing else remains", () => {
    expect(applySlotsUpdate({ links: [], tags: ["bug"] }, { untags: ["bug"] })).toBeUndefined();
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
      'exec "$SCRIPT_DIR/spur" slots --session \'api-1\' "$@"',
    );
    expect(readFileSync(join(toolDir, SELF_DESTRUCT_TOOL_NAME), "utf8")).toContain(
      "exec \"$SCRIPT_DIR/spur\" self-destruct 'api-1' --json",
    );
    const todoWrapper = readFileSync(join(toolDir, TODO_TOOL_NAME), "utf8");
    expect(todoWrapper).toContain('exec "$SCRIPT_DIR/spur" todo "$@" --session \'api-1\'');
    expect(todoWrapper).not.toContain("delete");
  });

  it("writes branch helpers when branch naming is configured", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-branch",
      configPath: "/tmp/spur.yaml",
      projectId: "api",
      branchNamingRegex: "^feature/[a-z]+$",
    });

    expect(readFileSync(join(toolDir, "spur-branch"), "utf8")).toContain(
      'exec "$SCRIPT_DIR/spur" branch "$action" --project \'api\' "$@"',
    );
    const gitWrapper = readFileSync(join(toolDir, "git"), "utf8");
    expect(gitWrapper).toContain('if [[ "$git_command" == "push" ]]');
    expect(gitWrapper).toContain('"$SCRIPT_DIR/spur-branch" check "$branch"');
  });

  it("writes spur-sidecar wrapper directly to the parent CLI", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-2",
      configPath: "/tmp/spur.yaml",
    });

    const sidecar = readFileSync(join(toolDir, "spur-sidecar"), "utf8");
    expect(sidecar).toContain(
      "--config '/tmp/spur.yaml' sidecar \"$action\" --session 'api-2' \"$@\"",
    );
    expect(sidecar).not.toContain("SCRIPT_DIR");
    expect(sidecar).not.toContain('"$SCRIPT_DIR/spur"');
    expect(sidecar).toContain('action="start"');
    expect(sidecar).toContain(
      `if [[ "${PARAM_EXPANSION_OPEN}1-}" == "start" || "${PARAM_EXPANSION_OPEN}1-}" == "stop" || "${PARAM_EXPANSION_OPEN}1-}" == "ports" ]]`,
    );
  });

  it("forwards the ports action through to the CLI's sidecar group", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-2",
      configPath: "/tmp/spur.yaml",
    });

    const out = execFileSync(join(toolDir, "spur-sidecar"), ["ports", "--help"], {
      encoding: "utf8",
    });

    expect(out).toContain("Print this session's reserved sidecar ports.");
    expect(out).not.toContain("--clear-port");
  });

  it("blocks git push with global options when the current branch is invalid", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);
    const fakeBinDir = join(dataDir, "fake-bin");
    mkdirSync(fakeBinDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-branch",
      configPath: "/tmp/spur.yaml",
      projectId: "api",
      branchNamingRegex: "^feature/[a-z]+$",
    });
    const capturedArgsPath = join(dataDir, "git-args.txt");
    writeFileSync(
      join(fakeBinDir, "git"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "-C /repo branch --show-current" ]]; then
  echo "bad-name"
  exit 0
fi
printf '%s\\n' "$@" > ${JSON.stringify(capturedArgsPath)}
`,
      { encoding: "utf8", mode: 0o755 },
    );
    writeFileSync(
      join(toolDir, "spur-branch"),
      `#!/usr/bin/env bash
set -euo pipefail
exit 42
`,
      { encoding: "utf8", mode: 0o755 },
    );

    expect(() =>
      execFileSync(join(toolDir, "git"), ["-C", "/repo", "push"], {
        env: { ...process.env, PATH: `${toolDir}:${fakeBinDir}:${process.env["PATH"] ?? ""}` },
      }),
    ).toThrow();
    expect(() => readFileSync(capturedArgsPath, "utf8")).toThrow();
  });

  it("keeps spur-sidecar isolated from an overwritten local spur wrapper", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    // A real "spur.yaml" is used, not the shared "/tmp/spur.yaml": the
    // wrapper below execs the real CLI, and "/tmp/spur.yaml" is the default
    // instance config that a live daemon on this host (dev box or self-hosted
    // CI runner) may already be listening on at its default port 4310. Point
    // at a fresh port nothing is bound to so this stays a fast, isolated test
    // instead of round-tripping whatever daemon happens to own the shared path.
    const configPath = join(dataDir, "spur.yaml");
    const port = await findFreePort();
    writeFileSync(configPath, `server:\n  host: 127.0.0.1\n  port: ${port}\n`, "utf8");

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-3",
      configPath,
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

    expect(() =>
      // SPUR_DISABLE_AUTOSTART=1 so the CLI throws immediately instead of
      // auto-spawning a daemon on the free port above and waiting up to
      // ~40s for it to come up, which would flake this test past the
      // vitest timeout under load.
      execFileSync(join(toolDir, "spur-sidecar"), ["stop", "--name", "isolated-ui"], {
        env: { ...process.env, SPUR_DISABLE_AUTOSTART: "1" },
      }),
    ).toThrow();

    expect(() => readFileSync(captureFile, "utf8")).toThrow();
  });

  it("skips hook-state helper scripts for cursor sessions", async () => {
    const dataDir = await createTempDir("spur-slots-fast-");
    tempDirs.push(dataDir);

    const toolDir = ensureSessionSlotTool({
      dataDir,
      sessionId: "api-3",
      configPath: "/tmp/spur.yaml",
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
