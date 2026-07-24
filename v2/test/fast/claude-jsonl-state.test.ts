import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyClaudeJsonlState,
  parseConversationLines,
  readClaudeJsonlState,
  readClaudeTranscriptEntries,
  type ParsedRecord,
} from "../../src/claude-jsonl-state.js";
import type { TranscriptEntry } from "../../src/types.js";

const { findLatestSessionFileMock, sessionFileForIdMock } = vi.hoisted(() => ({
  findLatestSessionFileMock: vi.fn(),
  sessionFileForIdMock: vi.fn(),
}));
vi.mock("../../src/agents/claude.js", () => ({
  findLatestSessionFile: findLatestSessionFileMock,
  sessionFileForId: sessionFileForIdMock,
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = 1_700_000_000_000;

function rec(overrides: Partial<ParsedRecord> & { type: string }): ParsedRecord {
  return { timestampMs: NOW - 10_000, ...overrides };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("classifyClaudeJsonlState", () => {
  it("returns working for empty records", () => {
    expect(classifyClaudeJsonlState([], NOW)).toBe("working");
  });

  // ── assistant stop reasons → waiting ───────────────────────────────

  it("returns waiting for assistant end_turn", () => {
    const records = [rec({ type: "assistant", stopReason: "end_turn" })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("waiting");
  });

  it("returns waiting for assistant stop_sequence", () => {
    const records = [rec({ type: "assistant", stopReason: "stop_sequence" })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("waiting");
  });

  it("returns waiting for assistant refusal", () => {
    const records = [rec({ type: "assistant", stopReason: "refusal" })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("waiting");
  });

  it("returns waiting for assistant max_tokens", () => {
    const records = [rec({ type: "assistant", stopReason: "max_tokens" })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("waiting");
  });

  // ── assistant tool_use ─────────────────────────────────────────────

  it("returns working for tool_use with recent progress", () => {
    const toolTime = NOW - 2_000;
    const records = [
      rec({ type: "assistant", hasToolUse: true, timestampMs: toolTime }),
      rec({ type: "progress", timestampMs: toolTime + 1_000 }),
    ];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("working");
  });

  it("returns working for tool_use within activity window", () => {
    const records = [rec({ type: "assistant", hasToolUse: true, timestampMs: NOW - 30_000 })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("working");
  });

  it("returns needs_input immediately for AskUserQuestion metadata", () => {
    const records = [
      rec({
        type: "assistant",
        hasToolUse: true,
        requestsUserInput: true,
        timestampMs: NOW - 500,
      }),
    ];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("needs_input");
  });

  it("returns waiting for tool_use past activity window with no progress", () => {
    const records = [rec({ type: "assistant", hasToolUse: true, timestampMs: NOW - 70_000 })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("waiting");
  });

  it("returns needs_input for assistant AskUserQuestion tool_use regardless of timing", () => {
    const records = [
      rec({
        type: "assistant",
        hasToolUse: true,
        requestsUserInput: true,
        timestampMs: NOW - 10 * 60_000,
      }),
    ];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("needs_input");
  });

  // ── assistant without stop reason or tool_use → working ────────────

  it("returns working for assistant without stop reason", () => {
    const records = [rec({ type: "assistant" })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("working");
  });

  // ── system / stop_hook_summary / file-history-snapshot → waiting ───

  it("returns waiting for system record", () => {
    const records = [rec({ type: "system" })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("waiting");
  });

  it("returns waiting for stop_hook_summary", () => {
    const records = [rec({ type: "stop_hook_summary" })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("waiting");
  });

  it("returns waiting for file-history-snapshot", () => {
    const records = [rec({ type: "file-history-snapshot" })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("waiting");
  });

  // ── user records → working ─────────────────────────────────────────

  it("returns working for user message", () => {
    const records = [rec({ type: "user", role: "user" })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("working");
  });

  it("returns working for user tool_result", () => {
    const records = [rec({ type: "user", role: "tool_result" })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("working");
  });

  it("returns working for user tool_result within activity window", () => {
    const records = [rec({ type: "user", role: "tool_result", timestampMs: NOW - 5_000 })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("working");
  });

  it("returns needs_input for user tool_result past activity window (agent stalled)", () => {
    const records = [rec({ type: "user", role: "tool_result", timestampMs: NOW - 120_000 })];
    expect(classifyClaudeJsonlState(records, NOW, NOW - 120_000)).toBe("needs_input");
  });

  it("returns waiting for plain user message past activity window", () => {
    const records = [rec({ type: "user", role: "user", timestampMs: NOW - 120_000 })];
    expect(classifyClaudeJsonlState(records, NOW, NOW - 120_000)).toBe("waiting");
  });

  // ── progress → working ─────────────────────────────────────────────

  it("returns working for progress record", () => {
    const records = [rec({ type: "progress" })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("working");
  });

  // ── mixed sequences ────────────────────────────────────────────────

  it("uses the last meaningful record in a sequence", () => {
    const records = [
      rec({ type: "user", role: "user" }),
      rec({ type: "assistant", stopReason: "end_turn" }),
    ];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("waiting");
  });

  it("progress after assistant end_turn means working", () => {
    const records = [
      rec({ type: "assistant", stopReason: "end_turn" }),
      rec({ type: "progress", timestampMs: NOW }),
    ];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("working");
  });

  it("user message after waiting means working", () => {
    const records = [
      rec({ type: "assistant", stopReason: "end_turn" }),
      rec({ type: "user", role: "user" }),
    ];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("working");
  });

  // ── fallback type → working ────────────────────────────────────────

  it("returns working for unknown record types (fallback)", () => {
    const records = [rec({ type: "unknown_type" })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("working");
  });
});

// ── parseConversationLines ──────────────────────────────────────────

describe("parseConversationLines", () => {
  function jsonl(...records: Record<string, unknown>[]): string[] {
    return records.map((r) => JSON.stringify(r));
  }

  it("extracts text from user and assistant messages", () => {
    const lines = jsonl(
      { type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
        },
      },
    );
    const { messages } = parseConversationLines(lines, NOW);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", text: "hello" });
    expect(messages[1]).toMatchObject({ role: "assistant", text: "hi" });
  });

  it("excludes tool_result-only user messages", () => {
    const lines = jsonl({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
      },
    });
    const { messages } = parseConversationLines(lines, NOW);
    expect(messages).toHaveLength(0);
  });

  it("excludes tool_use-only assistant messages", () => {
    const lines = jsonl({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "Read", input: {} }],
      },
    });
    const { messages } = parseConversationLines(lines, NOW);
    expect(messages).toHaveLength(0);
  });

  it("extracts only text from mixed content", () => {
    const lines = jsonl({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that." },
          { type: "tool_use", id: "x", name: "Read", input: {} },
        ],
      },
    });
    const { messages } = parseConversationLines(lines, NOW);
    expect(messages).toHaveLength(1);
    const firstMessage = messages[0];
    if (!firstMessage) {
      throw new Error("expected one parsed message");
    }
    expect(firstMessage.text).toBe("Let me read that.");
  });

  it("handles string content (user prompt via spur send)", () => {
    const lines = jsonl({ type: "user", message: { role: "user", content: "fix the bug" } });
    const { messages } = parseConversationLines(lines, NOW);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", text: "fix the bug" });
  });

  it("returns empty for file with no conversation records", () => {
    const lines = jsonl({ type: "progress" }, { type: "system" });
    const { messages } = parseConversationLines(lines, NOW);
    expect(messages).toHaveLength(0);
  });

  it("classifies state alongside conversation extraction", () => {
    const lines = jsonl({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
      },
    });
    const { state } = parseConversationLines(lines, NOW);
    expect(state).toBe("waiting");
  });

  it("keeps the same spur-0190 tail fixture working inside the activity window", async () => {
    const fixturePath = join(
      __dirname,
      "../fixtures/agent-history/claude/needs-input-spur-0190-tail.jsonl",
    );
    const fixture = await readFile(fixturePath, "utf8");
    const tempDir = await mkdtemp(join(tmpdir(), "spur-0190-tail-"));
    const tempFile = join(tempDir, "spur-0190-tail.jsonl");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-11T16:44:38.000Z"));

    try {
      await writeFile(tempFile, fixture, "utf8");
      const result = await readClaudeJsonlState(tempDir, {
        filePath: tempFile,
        lastOffset: 0,
        lastMtimeMs: 0,
        tailRecords: [],
      });
      expect(result).not.toBeNull();
      if (!result) {
        throw new Error("expected fixture result");
      }
      expect(result.state).toBe("working");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("classifies the stale activity tail as waiting once the activity window elapses without an identified question", async () => {
    const fixturePath = join(
      __dirname,
      "../fixtures/agent-history/claude/waiting-stale-activity-tail.jsonl",
    );
    const fixture = await readFile(fixturePath, "utf8");
    const tempDir = await mkdtemp(join(tmpdir(), "stale-activity-tail-"));
    const tempFile = join(tempDir, "stale-activity-tail.jsonl");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T08:27:00.000Z"));

    try {
      await writeFile(tempFile, fixture, "utf8");
      const lastActivity = new Date("2026-05-04T08:25:28.551Z");
      await utimes(tempFile, lastActivity, lastActivity);
      const result = await readClaudeJsonlState(tempDir, {
        filePath: tempFile,
        lastOffset: 0,
        lastMtimeMs: 0,
        tailRecords: [],
      });
      expect(result).not.toBeNull();
      if (!result) {
        throw new Error("expected fixture result");
      }
      expect(result.state).toBe("waiting");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("readClaudeJsonlState rate limit detection", () => {
  const fixtures = [
    "ratelimit-trailing-system-record-0f9e.jsonl",
    "ratelimit-trailing-system-record-5b47.jsonl",
    "ratelimit-trailing-system-record-6be6.jsonl",
  ];

  it.each(fixtures)(
    "flags %s as rate limited despite the trailing system record",
    async (fixtureName) => {
      const fixturePath = join(__dirname, "../fixtures/agent-history/claude", fixtureName);
      const fixture = await readFile(fixturePath, "utf8");
      const tempDir = await mkdtemp(join(tmpdir(), "ratelimit-trailing-system-record-"));
      const tempFile = join(tempDir, fixtureName);

      try {
        await writeFile(tempFile, fixture, "utf8");
        const result = await readClaudeJsonlState(tempDir, {
          filePath: tempFile,
          lastOffset: 0,
          lastMtimeMs: 0,
          tailRecords: [],
        });
        expect(result).not.toBeNull();
        if (!result) {
          throw new Error("expected fixture result");
        }
        expect(result.rateLimit).toEqual({ limited: true, reason: "claude rate_limit" });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});

describe("readClaudeTranscriptEntries", () => {
  afterEach(() => {
    findLatestSessionFileMock.mockReset();
    sessionFileForIdMock.mockReset();
  });

  function isQuestion(
    entry: TranscriptEntry,
  ): entry is Extract<TranscriptEntry, { kind: "question" }> {
    return entry.kind === "question";
  }

  function isTool(entry: TranscriptEntry): entry is Extract<TranscriptEntry, { kind: "tool" }> {
    return entry.kind === "tool";
  }

  it("parses a question entry (with options) and a tool entry, in file-line order", async () => {
    const fixturePath = join(
      __dirname,
      "../fixtures/agent-history/claude/needs-input-ask-user-spur-6e9a-tail.jsonl",
    );
    findLatestSessionFileMock.mockResolvedValue(fixturePath);

    const entries = await readClaudeTranscriptEntries("/tmp/spur-worktrees/api/spur-6e9a");
    expect(entries).not.toBeNull();
    if (!entries) throw new Error("expected entries");

    expect(findLatestSessionFileMock).toHaveBeenCalledWith("/tmp/spur-worktrees/api/spur-6e9a");

    const question = entries.find(isQuestion);
    expect(question).toBeDefined();
    if (!question) throw new Error("expected a question entry");
    expect(question.options?.map((option) => option.label)).toEqual([
      "TypeScript",
      "Python",
      "Go",
      "Rust",
    ]);
    expect(question.options?.map((option) => option.index)).toEqual([0, 1, 2, 3]);

    const tool = entries.find(isTool);
    expect(tool).toBeDefined();
    if (!tool) throw new Error("expected a tool entry");
    expect(tool.name).toBe("ToolSearch");

    // The ToolSearch tool_use record precedes the AskUserQuestion record in the fixture.
    expect(entries.indexOf(tool)).toBeLessThan(entries.indexOf(question));
  });

  it("resolves the transcript by pinned agentSessionId when provided", async () => {
    const fixturePath = join(
      __dirname,
      "../fixtures/agent-history/claude/needs-input-ask-user-spur-6e9a-tail.jsonl",
    );
    sessionFileForIdMock.mockResolvedValue(fixturePath);

    const entries = await readClaudeTranscriptEntries(
      "/tmp/spur-worktrees/api/spur-6e9a",
      "pinned-session-id",
    );

    expect(sessionFileForIdMock).toHaveBeenCalledWith(
      "/tmp/spur-worktrees/api/spur-6e9a",
      "pinned-session-id",
    );
    expect(findLatestSessionFileMock).not.toHaveBeenCalled();
    expect(entries).not.toBeNull();
  });

  it("returns null when no transcript file resolves", async () => {
    findLatestSessionFileMock.mockResolvedValue(null);

    const entries = await readClaudeTranscriptEntries("/tmp/spur-worktrees/api/missing");

    expect(entries).toBeNull();
  });
});
