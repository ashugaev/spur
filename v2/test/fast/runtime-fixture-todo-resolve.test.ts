import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeAgentScript } from "../helpers/runtime.js";

// Regression coverage for the #751 daemon-authoritative-todo fixture race:
// the fake agent's resolve_initial_todo used to swallow a failed "todo
// complete" with `|| true`, silently leaving the seeded item open with no
// diagnostic. Separately, Cursor wrote an assistant-role transcript record
// at startup, before resolve_initial_todo ever ran; the daemon's `complete`
// gate is unconditional on session state, so this ordering alone never
// caused the 409, but it did make the "waiting" state a false signal that
// resolve_initial_todo had already run, which the fix below relies on to
// make `waitForState(..., "waiting")` a trustworthy synchronization point
// for runtime tests that call `spur complete` right after it.

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type TodoStubMode = "succeed" | "fail" | "resolved-elsewhere" | "list-fails-after-first";

function writeTodoStub(dir: string, mode: TodoStubMode): string {
  const stubPath = join(dir, "spur-todo-stub.sh");
  const resolvedMarker = join(dir, "resolved-elsewhere.marker");
  const listCallCounter = join(dir, "list-call-count");
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  list)
    if [[ "${mode}" == "list-fails-after-first" ]]; then
      count=0
      [[ -f "${listCallCounter}" ]] && count="$(cat "${listCallCounter}")"
      count=$((count + 1))
      printf '%s' "$count" > "${listCallCounter}"
      if [[ "$count" -gt 1 ]]; then
        # Simulate list itself becoming unavailable (daemon hiccup, transient
        # CLI cold-start failure) on every call after the initial lookup.
        exit 1
      fi
    fi
    if [[ -f "${resolvedMarker}" ]]; then
      printf '{"items":[]}'
    else
      printf '{"items":[{"id":"item-1","status":"open"}]}'
    fi
    ;;
  complete)
    if [[ "${mode}" == "resolved-elsewhere" ]]; then
      # Simulate another actor completing the item between this attempt's
      # list and complete calls: the complete call itself still fails (as a
      # real todo_transition_conflict would), but the item is no longer open.
      touch "${resolvedMarker}"
      exit 1
    fi
    if [[ "${mode}" == "succeed" ]]; then
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return stubPath;
}

function runCursorFixture(args: { todoStubMode: TodoStubMode }): {
  status: number | null;
  logText: string;
  transcriptDir: string;
} {
  const home = makeTempDir("spur-fixture-home-");
  const logDir = makeTempDir("spur-fixture-log-");
  const cwd = makeTempDir("spur-fixture-cwd-");
  const scriptPath = join(makeTempDir("spur-fixture-bin-"), "agent.sh");
  writeFileSync(scriptPath, fakeAgentScript("cursor"), { encoding: "utf8" });
  chmodSync(scriptPath, 0o755);
  const todoCommand = writeTodoStub(makeTempDir("spur-fixture-todo-"), args.todoStubMode);

  const result = spawnSync("bash", [scriptPath], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      SPUR_FAKE_AGENT_LOG_DIR: logDir,
      SPUR_SESSION: "fixture-session",
      SPUR_TODO_COMMAND: todoCommand,
    },
    input: "",
    encoding: "utf8",
    timeout: 10_000,
  });

  const logFile = join(logDir, "fixture-session.log");
  const logText = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  // Mirrors the fixture's own `cursor_project_slug` derivation exactly:
  // strip leading slashes, drop every dot, then replace each remaining
  // slash with a hyphen (no run-collapsing, unlike the production
  // toCursorProjectPath slugifier).
  const cursorProjectSlug = cwd.replace(/^\/+/, "").replaceAll(".", "").replaceAll("/", "-");
  const transcriptDir = join(
    home,
    ".cursor",
    "projects",
    cursorProjectSlug,
    "agent-transcripts",
    "chat-fixture-session",
  );

  return { status: result.status, logText, transcriptDir };
}

describe("fakeAgentScript resolve_initial_todo (fixture race regression)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("completes the seeded todo item and signals waiting once it lands", () => {
    const { status, transcriptDir } = runCursorFixture({ todoStubMode: "succeed" });

    expect(status).toBe(0);
    const transcriptFile = join(transcriptDir, "chat-fixture-session.jsonl");
    expect(existsSync(transcriptFile)).toBe(true);
    const lines = readFileSync(transcriptFile, "utf8").trim().split("\n");
    // Exactly one assistant record: the fixture must not also write an
    // early "ready" record before resolve_initial_todo runs. That early
    // write let the daemon report "waiting" before the seeded todo had
    // landed, so a test waiting on "waiting" as its synchronization point
    // before calling `complete` would not actually be synchronized.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      role: "assistant",
      message: { content: [{ type: "text", text: "done" }] },
    });
  });

  it("fails loudly instead of silently swallowing a todo complete failure", () => {
    const { status, logText, transcriptDir } = runCursorFixture({ todoStubMode: "fail" });

    expect(status).toBe(1);
    expect(logText).toContain("resolve_initial_todo: failed to complete seeded todo item item-1");
    // The script must exit before ever reaching the waiting signal, so no
    // transcript record — and therefore no "waiting" state — is produced.
    const transcriptFile = join(transcriptDir, "chat-fixture-session.jsonl");
    expect(existsSync(transcriptFile)).toBe(false);
  });

  it("does not fail loud when a failed complete call actually landed (todo_transition_conflict)", () => {
    const { status, transcriptDir } = runCursorFixture({ todoStubMode: "resolved-elsewhere" });

    expect(status).toBe(0);
    const transcriptFile = join(transcriptDir, "chat-fixture-session.jsonl");
    expect(existsSync(transcriptFile)).toBe(true);
  });

  it("never reads a transient list failure as resolved, and still fails loud", () => {
    // complete always fails and list becomes unavailable after the initial
    // lookup: a bare "empty means resolved" re-check would misread the
    // first list failure as "resolved" and return success silently, leaving
    // the seeded item open with no diagnostic — the exact swallow this
    // fixture exists to eliminate.
    const { status, logText, transcriptDir } = runCursorFixture({
      todoStubMode: "list-fails-after-first",
    });

    expect(status).toBe(1);
    expect(logText).toContain("resolve_initial_todo: failed to complete seeded todo item item-1");
    const transcriptFile = join(transcriptDir, "chat-fixture-session.jsonl");
    expect(existsSync(transcriptFile)).toBe(false);
  });
});
