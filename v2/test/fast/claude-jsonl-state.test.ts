import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyClaudeJsonlState,
  hasTrailingClaudeServerError,
  MAX_CONVERSATION_MESSAGES,
  parseConversationBatch,
  parseJsonlRecord,
  readClaudeConversationTail,
  readClaudeJsonlState,
  readClaudeTranscriptEntries,
  type ParsedRecord,
} from "../../src/claude-jsonl-state.js";
import type { TranscriptEntry } from "../../src/types.js";

// Path resolution is mocked so the tail reader tests can point at temp files.
// The readClaudeJsonlState tests below pass a concrete `reader.filePath`, so
// they bypass resolution entirely and are unaffected by these mocks.
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

  // ── trailing server_error → error ───────────────────────────────────

  it("returns error for a trailing server_error record", () => {
    const records = [rec({ type: "assistant", stopReason: "stop_sequence", serverError: true })];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("error");
  });

  it("keeps error when a progress record follows the server_error record", () => {
    const records = [
      rec({ type: "assistant", stopReason: "stop_sequence", serverError: true }),
      rec({ type: "progress" }),
    ];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("error");
  });

  it("keeps error when a system record follows the server_error record", () => {
    const records = [
      rec({ type: "assistant", stopReason: "stop_sequence", serverError: true }),
      rec({ type: "system" }),
    ];
    expect(classifyClaudeJsonlState(records, NOW)).toBe("error");
  });
});

// ── parseJsonlRecord: server_error detector ──────────────────────────

describe("parseJsonlRecord server_error detection", () => {
  const CLAUDE_SERVER_ERROR_WITH_STATUS_LINE = JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    apiErrorStatus: 529,
    error: "server_error",
    message: {
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: "API Error: 529 Overloaded." }],
    },
  });
  const CLAUDE_SERVER_ERROR_NO_STATUS_LINE = JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    error: "server_error",
    message: {
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: "API Error: Unable to connect to API (ConnectionRefused)" }],
    },
  });
  const CLAUDE_RATE_LIMIT_LINE = JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    error: "rate_limit",
    message: {
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your session limit · resets 1pm (UTC)" }],
    },
  });
  const CLAUDE_PROSE_MENTIONING_500_LINE = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "The server returned API Error: 500 earlier, now fixed." }],
    },
  });

  it("flags a server_error record with apiErrorStatus", () => {
    const record = parseJsonlRecord(CLAUDE_SERVER_ERROR_WITH_STATUS_LINE, 0);
    expect(record?.serverError).toBe(true);
  });

  it("flags a server_error record with no apiErrorStatus (connection-refused class)", () => {
    const record = parseJsonlRecord(CLAUDE_SERVER_ERROR_NO_STATUS_LINE, 0);
    expect(record?.serverError).toBe(true);
  });

  it("does not flag a rate_limit record", () => {
    const record = parseJsonlRecord(CLAUDE_RATE_LIMIT_LINE, 0);
    expect(record?.serverError).toBeUndefined();
    expect(record?.rateLimited).toBe(true);
  });

  it("does not flag assistant prose that merely mentions API Error: 500", () => {
    const record = parseJsonlRecord(CLAUDE_PROSE_MENTIONING_500_LINE, 0);
    expect(record?.serverError).toBeUndefined();
  });
});

// ── hasTrailingClaudeServerError ──────────────────────────────────────

describe("hasTrailingClaudeServerError", () => {
  it("returns true for a trailing server_error record", () => {
    const records = [rec({ type: "assistant", serverError: true })];
    expect(hasTrailingClaudeServerError(records)).toBe(true);
  });

  it("skips bookkeeping records to find the trailing server_error record", () => {
    const records = [
      rec({ type: "assistant", serverError: true }),
      rec({ type: "system" }),
      rec({ type: "file-history-snapshot" }),
    ];
    expect(hasTrailingClaudeServerError(records)).toBe(true);
  });

  it("returns false once a normal assistant end_turn record follows", () => {
    const records = [
      rec({ type: "assistant", serverError: true }),
      rec({ type: "system" }),
      rec({ type: "assistant", stopReason: "end_turn" }),
    ];
    expect(hasTrailingClaudeServerError(records)).toBe(false);
  });

  it("returns false once a plain user record follows", () => {
    const records = [
      rec({ type: "assistant", serverError: true }),
      rec({ type: "system" }),
      rec({ type: "user", role: "user" }),
    ];
    expect(hasTrailingClaudeServerError(records)).toBe(false);
  });

  it("returns false with no records", () => {
    expect(hasTrailingClaudeServerError([])).toBe(false);
  });
});

// ── parseConversationBatch ──────────────────────────────────────────

describe("parseConversationBatch", () => {
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
    const { messages } = parseConversationBatch(lines, NOW);
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
    const { messages } = parseConversationBatch(lines, NOW);
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
    const { messages } = parseConversationBatch(lines, NOW);
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
    const { messages } = parseConversationBatch(lines, NOW);
    expect(messages).toHaveLength(1);
    const firstMessage = messages[0];
    if (!firstMessage) {
      throw new Error("expected one parsed message");
    }
    expect(firstMessage.text).toBe("Let me read that.");
  });

  it("handles string content (user prompt via spur send)", () => {
    const lines = jsonl({ type: "user", message: { role: "user", content: "fix the bug" } });
    const { messages } = parseConversationBatch(lines, NOW);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", text: "fix the bug" });
  });

  it("returns empty for file with no conversation records", () => {
    const lines = jsonl({ type: "progress" }, { type: "system" });
    const { messages } = parseConversationBatch(lines, NOW);
    expect(messages).toHaveLength(0);
  });

  it("truncates message text longer than the cap and leaves shorter text unchanged", () => {
    const longText = "x".repeat(3000);
    const shortText = "y".repeat(2000);
    const lines = jsonl(
      { type: "user", message: { role: "user", content: [{ type: "text", text: longText }] } },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: shortText }] },
      },
    );
    const { messages } = parseConversationBatch(lines, NOW);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.text).toHaveLength(2000);
    expect(messages[1]?.text).toBe(shortText);
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
    const { records } = parseConversationBatch(lines, NOW);
    expect(classifyClaudeJsonlState(records, NOW)).toBe("waiting");
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

describe("readClaudeJsonlState server error detection", () => {
  const fixtures = [
    "servererror-trailing-system-record-38ce.jsonl",
    "servererror-connection-refused-trailing-system-record-ao.jsonl",
  ];

  it.each(fixtures)("flags %s as error despite the trailing system record", async (fixtureName) => {
    const fixturePath = join(__dirname, "../fixtures/agent-history/claude", fixtureName);
    const fixture = await readFile(fixturePath, "utf8");
    const tempDir = await mkdtemp(join(tmpdir(), "servererror-trailing-system-record-"));
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
      expect(result.state).toBe("error");
      expect(result.serverError).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns serverError: false for the existing rate-limit fixture", async () => {
    const fixturePath = join(
      __dirname,
      "../fixtures/agent-history/claude/ratelimit-trailing-system-record-0f9e.jsonl",
    );
    const fixture = await readFile(fixturePath, "utf8");
    const tempDir = await mkdtemp(join(tmpdir(), "ratelimit-not-server-error-"));
    const tempFile = join(tempDir, "ratelimit-trailing-system-record-0f9e.jsonl");

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
      expect(result.serverError).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns serverError: false for the existing waiting fixture", async () => {
    const fixturePath = join(__dirname, "../fixtures/agent-history/claude/waiting-end-turn.jsonl");
    const fixture = await readFile(fixturePath, "utf8");
    const tempDir = await mkdtemp(join(tmpdir(), "waiting-not-server-error-"));
    const tempFile = join(tempDir, "waiting-end-turn.jsonl");

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
      expect(result.serverError).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("readClaudeJsonlState live model derivation", () => {
  it("derives the live model from the last assistant record on initial read", async () => {
    const fixturePath = join(__dirname, "../fixtures/agent-history/claude/waiting-end-turn.jsonl");
    const fixture = await readFile(fixturePath, "utf8");
    const tempDir = await mkdtemp(join(tmpdir(), "live-model-"));
    const tempFile = join(tempDir, "waiting-end-turn.jsonl");

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
      expect(result.liveModel).toBe("claude-opus-4-6");

      // Re-reading with the returned reader and an unchanged mtime exercises
      // the cached early-return path, which must also derive liveModel.
      const secondResult = await readClaudeJsonlState(tempDir, result.reader);
      expect(secondResult).not.toBeNull();
      if (!secondResult) {
        throw new Error("expected cached fixture result");
      }
      expect(secondResult.liveModel).toBe("claude-opus-4-6");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("never reports the <synthetic> placeholder model", async () => {
    const fixturePath = join(
      __dirname,
      "../fixtures/agent-history/claude/waiting-stop-sequence.jsonl",
    );
    const fixture = await readFile(fixturePath, "utf8");
    const tempDir = await mkdtemp(join(tmpdir(), "live-model-synthetic-"));
    const tempFile = join(tempDir, "waiting-stop-sequence.jsonl");

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
      // The only assistant record is a `<synthetic>` stub, so the header falls
      // back to the persisted spawn-time model instead of showing the stub.
      expect(result.liveModel).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ── readClaudeConversationTail ───────────────────────────────────────

describe("readClaudeConversationTail", () => {
  const TS = "2026-04-11T16:44:38.000Z";

  function assistantLine(text: string): string {
    return JSON.stringify({
      type: "assistant",
      timestamp: TS,
      message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
    });
  }

  function userLine(text: string): string {
    return JSON.stringify({
      type: "user",
      timestamp: TS,
      message: { role: "user", content: [{ type: "text", text }] },
    });
  }

  async function withTempFile(
    fn: (tempDir: string, filePath: string) => Promise<void>,
  ): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), "spur-convo-tail-"));
    const filePath = join(tempDir, "transcript.jsonl");
    try {
      await fn(tempDir, filePath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  afterEach(() => {
    findLatestSessionFileMock.mockReset();
    sessionFileForIdMock.mockReset();
  });

  it("reads a whole transcript one-shot: messages, totalMessages, and state", async () => {
    await withTempFile(async (tempDir, filePath) => {
      findLatestSessionFileMock.mockResolvedValue(filePath);
      await writeFile(filePath, [userLine("hello"), assistantLine("hi")].join("\n") + "\n", "utf8");

      const result = await readClaudeConversationTail(tempDir);
      expect(result).not.toBeNull();
      if (!result) throw new Error("expected result");
      expect(result.messages.map((m) => m.text)).toEqual(["hello", "hi"]);
      expect(result.totalMessages).toBe(2);
      expect(result.hasMore).toBe(false);
      expect(result.state).toBe("waiting");
    });
  });

  it("yields identical messages/state/totalMessages whether read one-shot or in chunks", async () => {
    await withTempFile(async (tempDir, filePath) => {
      findLatestSessionFileMock.mockResolvedValue(filePath);
      const lines = [userLine("q1"), assistantLine("a1"), userLine("q2"), assistantLine("a2")];

      await writeFile(filePath, lines.join("\n") + "\n", "utf8");
      const oneShot = await readClaudeConversationTail(tempDir);

      // Chunked: first half, then append the rest with a bumped mtime.
      await writeFile(filePath, lines.slice(0, 2).join("\n") + "\n", "utf8");
      const first = await readClaudeConversationTail(tempDir);
      await writeFile(filePath, lines.join("\n") + "\n", "utf8");
      const later = new Date(Date.now() + 5000);
      await utimes(filePath, later, later);
      const second = await readClaudeConversationTail(tempDir, first?.reader);

      expect(second?.messages).toEqual(oneShot?.messages);
      expect(second?.totalMessages).toBe(oneShot?.totalMessages);
      expect(second?.state).toBe(oneShot?.state);
    });
  });

  it("caps the returned tail at MAX_CONVERSATION_MESSAGES and reports hasMore", async () => {
    await withTempFile(async (tempDir, filePath) => {
      findLatestSessionFileMock.mockResolvedValue(filePath);
      const total = MAX_CONVERSATION_MESSAGES + 5;
      const lines = Array.from({ length: total }, (_, i) => assistantLine(`m${i}`));
      await writeFile(filePath, lines.join("\n") + "\n", "utf8");

      const result = await readClaudeConversationTail(tempDir);
      if (!result) throw new Error("expected result");
      expect(result.messages).toHaveLength(MAX_CONVERSATION_MESSAGES);
      expect(result.totalMessages).toBe(total);
      expect(result.hasMore).toBe(true);
      // The kept window is the newest MAX_CONVERSATION_MESSAGES messages.
      expect(result.messages[0]?.text).toBe("m5");
      expect(result.messages.at(-1)?.text).toBe(`m${total - 1}`);
    });
  });

  it("sets hasMore false at exactly the cap and true one past it", async () => {
    await withTempFile(async (tempDir, filePath) => {
      findLatestSessionFileMock.mockResolvedValue(filePath);

      const atCap = Array.from({ length: MAX_CONVERSATION_MESSAGES }, (_, i) => assistantLine(`m${i}`));
      await writeFile(filePath, atCap.join("\n") + "\n", "utf8");
      const exact = await readClaudeConversationTail(tempDir);
      expect(exact?.totalMessages).toBe(MAX_CONVERSATION_MESSAGES);
      expect(exact?.hasMore).toBe(false);

      await writeFile(filePath, [...atCap, assistantLine("extra")].join("\n") + "\n", "utf8");
      const over = await readClaudeConversationTail(tempDir);
      expect(over?.totalMessages).toBe(MAX_CONVERSATION_MESSAGES + 1);
      expect(over?.hasMore).toBe(true);
    });
  });

  it("does not emit an unterminated trailing line until it is newline-terminated", async () => {
    await withTempFile(async (tempDir, filePath) => {
      findLatestSessionFileMock.mockResolvedValue(filePath);
      const complete = userLine("hello");
      const trailing = assistantLine("world");
      // First chunk: a complete line + newline, then a partial line with no
      // trailing newline (a transcript event mid-write).
      const partial = trailing.slice(0, trailing.length - 10);
      await writeFile(filePath, `${complete}\n${partial}`, "utf8");

      const first = await readClaudeConversationTail(tempDir);
      if (!first) throw new Error("expected result");
      expect(first.messages.map((m) => m.text)).toEqual(["hello"]);
      expect(first.totalMessages).toBe(1);

      // Append the completing bytes with a trailing newline; bump mtime.
      await writeFile(filePath, `${complete}\n${trailing}\n`, "utf8");
      const later = new Date(Date.now() + 5000);
      await utimes(filePath, later, later);
      const second = await readClaudeConversationTail(tempDir, first.reader);
      if (!second) throw new Error("expected result");
      expect(second.messages.map((m) => m.text)).toEqual(["hello", "world"]);
      expect(second.totalMessages).toBe(2);
    });
  });

  it("rebuilds from offset 0 when the file shrinks below the last offset", async () => {
    await withTempFile(async (tempDir, filePath) => {
      findLatestSessionFileMock.mockResolvedValue(filePath);
      await writeFile(
        filePath,
        [userLine("one"), assistantLine("two"), userLine("three")].join("\n") + "\n",
        "utf8",
      );
      const first = await readClaudeConversationTail(tempDir);

      await writeFile(filePath, userLine("fresh") + "\n", "utf8");
      const second = await readClaudeConversationTail(tempDir, first?.reader);
      expect(second?.messages.map((m) => m.text)).toEqual(["fresh"]);
      expect(second?.totalMessages).toBe(1);
    });
  });

  it("rebuilds when the resolved transcript path changes", async () => {
    await withTempFile(async (tempDir, fileA) => {
      const fileB = join(tempDir, "other.jsonl");
      await writeFile(fileA, [userLine("a1"), assistantLine("a2")].join("\n") + "\n", "utf8");
      await writeFile(fileB, [userLine("b1")].join("\n") + "\n", "utf8");

      findLatestSessionFileMock.mockResolvedValueOnce(fileA);
      const first = await readClaudeConversationTail(tempDir);
      expect(first?.totalMessages).toBe(2);

      findLatestSessionFileMock.mockResolvedValueOnce(fileB);
      const second = await readClaudeConversationTail(tempDir, first?.reader);
      expect(second?.messages.map((m) => m.text)).toEqual(["b1"]);
      expect(second?.totalMessages).toBe(1);
    });
  });

  it("resolves by agentSessionId when pinned and by findLatest when absent", async () => {
    await withTempFile(async (tempDir, filePath) => {
      await writeFile(filePath, userLine("x") + "\n", "utf8");

      sessionFileForIdMock.mockResolvedValue(filePath);
      await readClaudeConversationTail(tempDir, undefined, "sess-1");
      expect(sessionFileForIdMock).toHaveBeenCalledWith(tempDir, "sess-1");
      expect(findLatestSessionFileMock).not.toHaveBeenCalled();

      findLatestSessionFileMock.mockResolvedValue(filePath);
      await readClaudeConversationTail(tempDir);
      expect(findLatestSessionFileMock).toHaveBeenCalledWith(tempDir);
    });
  });

  it("truncates message text over the cap while leaving shorter text intact", async () => {
    await withTempFile(async (tempDir, filePath) => {
      findLatestSessionFileMock.mockResolvedValue(filePath);
      const long = "z".repeat(5000);
      await writeFile(filePath, [userLine(long), assistantLine("short")].join("\n") + "\n", "utf8");

      const result = await readClaudeConversationTail(tempDir);
      expect(result?.messages[0]?.text).toHaveLength(2000);
      expect(result?.messages[1]?.text).toBe("short");
    });
  });

  it("classifies identically to the uncapped pure parser despite the message cap", async () => {
    await withTempFile(async (tempDir, filePath) => {
      findLatestSessionFileMock.mockResolvedValue(filePath);
      const lines = Array.from({ length: MAX_CONVERSATION_MESSAGES + 10 }, (_, i) =>
        assistantLine(`m${i}`),
      );
      await writeFile(filePath, lines.join("\n") + "\n", "utf8");

      const tail = await readClaudeConversationTail(tempDir);
      const now = Date.now();
      const { records } = parseConversationBatch(lines, now);
      expect(tail?.state).toBe(classifyClaudeJsonlState(records, now));
    });
  });
});
