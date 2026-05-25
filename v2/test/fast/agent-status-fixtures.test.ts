import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyClaudeJsonlState,
  parseJsonlRecord,
  type ParsedRecord,
} from "../../src/claude-jsonl-state.js";
import { readAgentHookState } from "../../src/agent-hook-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../fixtures/agent-history");
const CLAUDE_DIR = join(FIXTURES_DIR, "claude");
const CODEX_DIR = join(FIXTURES_DIR, "codex");
const MANIFEST_PATH = join(FIXTURES_DIR, "MANIFEST.sha256");

// ── Helpers ─────────────────────────────────────────────────────────────

/** Parse a JSONL fixture via the production parser, ignoring non-record lines. */
function parseFixtureJsonl(content: string, fallbackTimestampMs: number): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = parseJsonlRecord(trimmed, fallbackTimestampMs);
    if (record) records.push(record);
  }
  return records;
}

async function sha256(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function parseManifest(): Promise<Map<string, string>> {
  const content = await readFile(MANIFEST_PATH, "utf8");
  const entries = new Map<string, string>();
  for (const line of content.trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (match?.[1] && match[2]) {
      entries.set(match[2], match[1]);
    }
  }
  return entries;
}

// ── Fixture integrity ───────────────────────────────────────────────────

describe("Fixture integrity", () => {
  it("all fixture files match their SHA-256 manifest entries", async () => {
    const manifest = await parseManifest();
    expect(manifest.size).toBeGreaterThan(0);
    for (const [relativePath, expectedHash] of manifest) {
      const actualHash = await sha256(join(FIXTURES_DIR, relativePath));
      expect(actualHash, `SHA mismatch for ${relativePath}`).toBe(expectedHash);
    }
  });
});

// ── Claude JSONL state classification from fixtures ─────────────────────

describe("Claude JSONL fixture classification", () => {
  const NOW = 1_700_000_000_000;

  // ── waiting states ──────────────────────────────────────────────────

  it.each([
    ["waiting-end-turn.jsonl", "waiting"],
    ["waiting-stop-sequence.jsonl", "waiting"],
    ["waiting-system.jsonl", "waiting"],
    ["waiting-stop-hook-summary.jsonl", "waiting"],
    ["waiting-file-history-snapshot.jsonl", "waiting"],
  ])("classifies %s as %s", async (fixture, expectedState) => {
    const content = await readFile(join(CLAUDE_DIR, fixture), "utf8");
    const records = parseFixtureJsonl(content, NOW);
    expect(records.length).toBeGreaterThan(0);
    expect(classifyClaudeJsonlState(records, NOW)).toBe(expectedState);
  });

  // ── working states ──────────────────────────────────────────────────

  it.each([
    ["working-progress.jsonl", "working"],
    ["working-user-message.jsonl", "working"],
    ["working-user-tool-result.jsonl", "working"],
    ["working-assistant-streaming.jsonl", "working"],
  ])("classifies %s as %s", async (fixture, expectedState) => {
    const content = await readFile(join(CLAUDE_DIR, fixture), "utf8");
    const records = parseFixtureJsonl(content, NOW);
    expect(records.length).toBeGreaterThan(0);
    expect(classifyClaudeJsonlState(records, NOW)).toBe(expectedState);
  });

  // ── generic tool_use: fresh = working, stale = needs_input ──────────

  it("classifies tool_use within activity window as working", async () => {
    const content = await readFile(join(CLAUDE_DIR, "working-tool-use-fresh.jsonl"), "utf8");
    const records = parseFixtureJsonl(content, NOW);
    expect(records.length).toBeGreaterThan(0);
    // Last record embeds ts 2026-04-07T22:45:14.391Z. +1s into the 60s window → working.
    expect(classifyClaudeJsonlState(records, Date.parse("2026-04-07T22:45:15.391Z"))).toBe(
      "working",
    );
  });

  it("classifies AskUserQuestion tool_use as needs_input regardless of age", async () => {
    const content = await readFile(join(CLAUDE_DIR, "needs-input-tool-use-stale.jsonl"), "utf8");
    const records = parseFixtureJsonl(content, NOW);
    expect(records.length).toBeGreaterThan(0);
    expect(
      classifyClaudeJsonlState(
        records,
        Date.parse("2026-04-11T15:03:36.000Z"),
        Date.parse("2026-04-11T15:02:06.116Z"),
      ),
    ).toBe("needs_input");
  });

  // ── Real-session tails ──────────────────────────────────────────────

  /**
   * Real-session tails exercising the activity-window classifier:
   *   - tool_use inside 60s window (record ts or mtime) → working
   *   - tool_use past 60s window with no AskUserQuestion → waiting
   *   - AskUserQuestion tool_use → needs_input regardless of timing
   *   - fileMtimeMs anchors "last activity" when newer than record ts
   */
  it.each<[string, string, number, number, string]>([
    // spur-052a: last tool_use at 2026-04-15T12:47:58.984Z.
    [
      "working-spur-052a-tail.jsonl",
      "past the 60s window with stale mtime → waiting",
      Date.parse("2026-04-15T13:04:00.000Z"),
      Date.parse("2026-04-15T12:48:00.000Z"),
      "waiting",
    ],
    [
      "working-spur-052a-tail.jsonl",
      "fresh mtime keeps the session inside the activity window → working",
      Date.parse("2026-04-15T13:04:00.000Z"),
      Date.parse("2026-04-15T13:03:59.000Z"),
      "working",
    ],
    // spur-0190: last tool_use at 2026-04-11T16:44:36.778Z.
    [
      "needs-input-spur-0190-tail.jsonl",
      "inside the 60s window → working",
      Date.parse("2026-04-11T16:44:46.500Z"),
      0,
      "working",
    ],
    [
      "needs-input-spur-0190-tail.jsonl",
      "past the 60s window with stale mtime → waiting",
      Date.parse("2026-04-11T16:45:45.000Z"),
      Date.parse("2026-04-11T16:44:37.000Z"),
      "waiting",
    ],
    // AskUserQuestion fixtures: content beats timing.
    [
      "needs-input-ask-user-spur-6e9a-tail.jsonl",
      "AskUserQuestion metadata makes it needs_input immediately",
      Date.parse("2026-04-11T15:02:08.000Z"),
      0,
      "needs_input",
    ],
    [
      "needs-input-ask-user-spur-6e9a-tail.jsonl",
      "AskUserQuestion stays needs_input regardless of age",
      Date.parse("2026-04-11T15:30:00.000Z"),
      Date.parse("2026-04-11T15:02:06.116Z"),
      "needs_input",
    ],
    // spur-36e9: ToolSearch result references AskUserQuestion schema but the
    // session itself never invokes AskUserQuestion → not a real question.
    [
      "working-tool-search-ask-user-ref-spur-36e9-tail.jsonl",
      "ToolSearch reference to AskUserQuestion schema is not a real question → working",
      Date.parse("2026-04-19T09:45:10.500Z"),
      Date.parse("2026-04-19T09:45:10.348Z"),
      "working",
    ],
    // bg-bash web fixture: last tool_use at 2026-04-13T11:19:48.036Z. With stale
    // mtime past the 60s window and no AskUserQuestion, it must classify as waiting.
    [
      "working-bg-bash-web-tail.jsonl",
      "past the 60s window with stale mtime → waiting",
      Date.parse("2026-04-13T11:21:00.000Z"),
      Date.parse("2026-04-13T11:19:48.036Z"),
      "waiting",
    ],
  ])("%s: %s", async (fixture, _description, nowMs, fileMtimeMs, expected) => {
    const content = await readFile(join(CLAUDE_DIR, fixture), "utf8");
    const records = parseFixtureJsonl(content, nowMs);
    expect(records.length).toBeGreaterThan(0);
    expect(classifyClaudeJsonlState(records, nowMs, fileMtimeMs)).toBe(expected);
  });
});

// ── Codex hook state classification from fixtures ────────────────────────

describe("Codex hook state fixture classification", () => {
  it.each([["waiting-stop.json", "waiting"]])(
    "classifies %s as %s",
    async (fixture, expectedState) => {
      const content = await readFile(join(CODEX_DIR, fixture), "utf8");
      const parsed = JSON.parse(content) as { state: string };
      expect(parsed.state).toBe(expectedState);
    },
  );

  it.each([
    ["working-pre-tool-use.json", "working"],
    ["working-post-tool-use.json", "working"],
    ["working-spur-436f.json", "working"],
    ["stale-working-spur-1c0e.json", "working"],
  ])("classifies %s as %s", async (fixture, expectedState) => {
    const content = await readFile(join(CODEX_DIR, fixture), "utf8");
    const parsed = JSON.parse(content) as { state: string };
    expect(parsed.state).toBe(expectedState);
  });

  it("keeps the spur-436f JSONL snapshot aligned with the working hook-state turn", async () => {
    const hookContent = await readFile(join(CODEX_DIR, "working-spur-436f.json"), "utf8");
    const hookState = JSON.parse(hookContent) as {
      state: string;
      hookEvent?: string;
      turnId?: string;
    };
    const jsonlContent = await readFile(join(CODEX_DIR, "working-spur-436f.jsonl"), "utf8");
    const lines = jsonlContent.trim().split("\n").filter(Boolean);

    expect(hookState.state).toBe("working");
    expect(hookState.turnId).toBeTruthy();
    expect(lines).toHaveLength(20);
    const turnId = hookState.turnId;
    if (!turnId) {
      throw new Error("expected spur-436f fixture to include turnId");
    }
    expect(lines.some((line) => line.includes(turnId))).toBe(true);
    expect(lines.some((line) => line.includes("Process running with session ID"))).toBe(true);
  });

  it("captures the spur-1c0e tail where the rollout completed after a stale working hook snapshot", async () => {
    const hookContent = await readFile(join(CODEX_DIR, "stale-working-spur-1c0e.json"), "utf8");
    const hookState = JSON.parse(hookContent) as {
      state: string;
      hookEvent?: string;
      turnId?: string;
    };
    const jsonlContent = await readFile(
      join(CODEX_DIR, "stale-working-spur-1c0e-tail.jsonl"),
      "utf8",
    );
    const lines = jsonlContent.trim().split("\n").filter(Boolean);

    expect(hookState.state).toBe("working");
    expect(hookState.hookEvent).toBe("PreToolUse");
    expect(hookState.turnId).toBeTruthy();
    expect(lines).toHaveLength(40);
    const turnId = hookState.turnId;
    if (!turnId) {
      throw new Error("expected spur-1c0e fixture to include turnId");
    }
    expect(lines.some((line) => line.includes(turnId))).toBe(true);
    expect(
      lines.some((line) => line.includes('"type":"task_complete"') && line.includes(turnId)),
    ).toBe(true);
  });

  it("absent hook file → readAgentHookState returns null → classified as waiting (SPUR1614 regression)", async () => {
    // SPUR1614: Codex session with tmux+process alive but no hook state file.
    // All 20 events in fixtures/agent-history/codex/no-hook-spur1614.jsonl showed
    // "State: working (no hook)" — the bug. Fix: null hook → "waiting", not "working".
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const tmpDir = await mkdtemp(join(tmpdir(), "spur1614-no-hook-"));
    try {
      const fixture = await readFile(join(CODEX_DIR, "no-hook-spur1614.jsonl"), "utf8");
      const lines = fixture.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(20);
      for (const line of lines) {
        const ev = JSON.parse(line) as { message: string };
        expect(ev.message).toBe("State: working (no hook)");
      }
      // No hook file written — simulates a Codex session whose Stop hook never fired.
      // Production mapping (null hook → "waiting") is covered by session-service.test.ts.
      const hookState = readAgentHookState(tmpDir, "spur-1614");
      expect(hookState).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("readAgentHookState parses fixture files correctly", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const tmpDir = await mkdtemp(join(tmpdir(), "codex-fixture-"));
    const stateDir = join(tmpDir, "session-agent-state");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(stateDir, { recursive: true });

    try {
      const fixtures = [
        "waiting-stop.json",
        "working-pre-tool-use.json",
        "working-post-tool-use.json",
        "working-spur-436f.json",
      ];

      for (const fixture of fixtures) {
        const content = await readFile(join(CODEX_DIR, fixture), "utf8");
        const sessionId = fixture.replace(".json", "");
        writeFileSync(join(stateDir, `${sessionId}.json`), content, "utf8");

        const state = readAgentHookState(tmpDir, sessionId);
        expect(state, `readAgentHookState for ${fixture}`).not.toBeNull();

        const parsed = JSON.parse(content) as { state: string; hookEvent?: string };
        if (!state) {
          throw new Error(`expected readAgentHookState to return data for ${fixture}`);
        }
        expect(state.state).toBe(parsed.state);
        if (parsed.hookEvent) {
          expect(state.hookEvent).toBe(parsed.hookEvent);
        }
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
