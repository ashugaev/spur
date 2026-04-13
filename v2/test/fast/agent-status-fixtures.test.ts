import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  classifyClaudeJsonlState,
  readClaudeJsonlState,
  type ParsedRecord,
} from "../../src/claude-jsonl-state.js";
import { readAgentHookState } from "../../src/agent-hook-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../fixtures/agent-history");
const CLAUDE_DIR = join(FIXTURES_DIR, "claude");
const CODEX_DIR = join(FIXTURES_DIR, "codex");
const MANIFEST_PATH = join(FIXTURES_DIR, "MANIFEST.sha256");

// ── Helpers ─────────────────────────────────────────────────────────────

/** Parse a JSONL fixture into ParsedRecord[] with controlled timestamps. */
function parseFixtureJsonl(content: string, timestampMs: number): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof parsed["type"] === "string" ? parsed["type"] : "";
    if (type === "progress") {
      records.push({ type: "progress", timestampMs });
      continue;
    }
    if (type === "system" || type === "stop_hook_summary" || type === "file-history-snapshot") {
      records.push({ type, timestampMs });
      continue;
    }
    const message =
      typeof parsed["message"] === "object" && parsed["message"] !== null
        ? (parsed["message"] as Record<string, unknown>)
        : parsed;
    const role =
      typeof message["role"] === "string"
        ? message["role"]
        : typeof parsed["role"] === "string"
          ? parsed["role"]
          : "";
    if (role === "assistant") {
      const stopReason =
        typeof message["stop_reason"] === "string" ? message["stop_reason"] : undefined;
      const content = Array.isArray(message["content"]) ? message["content"] : [];
      const hasToolUse = content.some(
        (block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>)["type"] === "tool_use",
      );
      records.push({
        type: "assistant",
        role: "assistant",
        ...(stopReason ? { stopReason } : {}),
        hasToolUse,
        timestampMs,
      });
      continue;
    }
    if (role === "user") {
      const content = Array.isArray(message["content"]) ? message["content"] : [];
      const hasToolResult = content.some(
        (block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>)["type"] === "tool_result",
      );
      records.push({
        type: "user",
        role: hasToolResult ? "tool_result" : "user",
        timestampMs,
      });
      continue;
    }
    if (type) {
      records.push({ type, timestampMs });
    }
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
    if (match) {
      entries.set(match[2]!, match[1]!);
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
  const STALE = NOW - 20_000; // 20s ago — past the 15s tool_use stale window

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

  // ── tool_use: fresh = working, stale = needs_input ──────────────────

  it("classifies tool_use within stale window as working", async () => {
    const content = await readFile(join(CLAUDE_DIR, "working-tool-use-fresh.jsonl"), "utf8");
    const records = parseFixtureJsonl(content, NOW);
    expect(records.length).toBeGreaterThan(0);
    // Records timestamped at NOW, checked at NOW → within 15s window → working
    expect(classifyClaudeJsonlState(records, NOW)).toBe("working");
  });

  it("classifies tool_use past stale window as needs_input", async () => {
    const content = await readFile(join(CLAUDE_DIR, "needs-input-tool-use-stale.jsonl"), "utf8");
    // Records timestamped 20s ago, checked at NOW → past 15s window → needs_input
    const records = parseFixtureJsonl(content, STALE);
    expect(records.length).toBeGreaterThan(0);
    expect(classifyClaudeJsonlState(records, NOW)).toBe("needs_input");
  });

  it("classifies the raw spur-0190 tail fixture as waiting once stale", async () => {
    const fixture = await readFile(join(CLAUDE_DIR, "waiting-spur-0190-tail.jsonl"), "utf8");
    const tempDir = await mkdtemp(join(tmpdir(), "spur-0190-tail-"));
    const tempFile = join(tempDir, "spur-0190-tail.jsonl");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-11T16:46:10.500Z"));

    try {
      await writeFile(tempFile, fixture, "utf8");
      const result = await readClaudeJsonlState(tempDir, {
        filePath: tempFile,
        lastOffset: 0,
        lastMtimeMs: 0,
        tailRecords: [],
      });
      expect(result).not.toBeNull();
      expect(result!.state).toBe("waiting");
    } finally {
      vi.useRealTimers();
      await rm(tempDir, { recursive: true, force: true });
    }
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
    expect(lines.some((line) => line.includes(hookState.turnId!))).toBe(true);
    expect(lines.some((line) => line.includes("Process running with session ID"))).toBe(true);
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
        expect(state!.state).toBe(parsed.state);
        if (parsed.hookEvent) {
          expect(state!.hookEvent).toBe(parsed.hookEvent);
        }
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
