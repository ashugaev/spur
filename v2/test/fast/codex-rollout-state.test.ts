import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCodexRolloutState,
  readCodexTranscriptEntries,
  type CodexRolloutReaderState,
} from "../../src/agents/codex.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STALE_WORKING_FIXTURE = join(
  __dirname,
  "../fixtures/agent-history/codex/stale-working-spur-1c0e-tail.jsonl",
);
const INTERRUPTED_TAIL_FIXTURE = join(
  __dirname,
  "../fixtures/agent-history/codex/interrupted-spur-00b0-tail.jsonl",
);
const WORKING_CURRENT_SESSION_FIXTURE = join(
  __dirname,
  "../fixtures/agent-history/codex/working-spur-67c0-rollout-tail.jsonl",
);
const IDLE_FIXTURE_SESSION_FIXTURE = join(
  __dirname,
  "../fixtures/agent-history/codex/idle-fixture-session-trailing-tool-output-tail.jsonl",
);
const WORKING_UNMATCHED_TOOL_CALL_FIXTURE = join(
  __dirname,
  "../fixtures/agent-history/codex/working-unmatched-tool-call-tail.jsonl",
);

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeSessionsDir(content: string, filename = "rollout-test.jsonl"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-rollout-"));
  tempDirs.push(root);
  const dayDir = join(root, "sessions", "2026", "04", "19");
  await mkdir(dayDir, { recursive: true });
  await writeFile(join(dayDir, filename), content, { encoding: "utf8", flag: "w" });
  return join(root, "sessions");
}

interface SessionFile {
  filename: string;
  content: string;
  mtimeMs: number;
}

// Writes multiple rollout files into one sessions dir and pins each file's mtime
// via utimes so tests can control the mtime ordering independently of content.
async function makeMultiFileSessionsDir(fileSpecs: SessionFile[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-rollout-"));
  tempDirs.push(root);
  const dayDir = join(root, "sessions", "2026", "04", "19");
  await mkdir(dayDir, { recursive: true });
  for (const spec of fileSpecs) {
    const filePath = join(dayDir, spec.filename);
    await writeFile(filePath, spec.content, { encoding: "utf8", flag: "w" });
    const seconds = spec.mtimeMs / 1000;
    await utimes(filePath, seconds, seconds);
  }
  return join(root, "sessions");
}

describe("readCodexRolloutState", () => {
  it("reuses parsed unchanged rollout files and refreshes a changed file", async () => {
    const firstRecord = JSON.stringify({
      timestamp: "2026-05-10T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    const fileName = "rollout-reader-cache.jsonl";
    const sessionsDir = await makeSessionsDir(firstRecord, fileName);
    const filePath = join(sessionsDir, "2026", "04", "19", fileName);
    const reader: CodexRolloutReaderState = { files: new Map() };

    const first = await readCodexRolloutState(sessionsDir, reader);
    const firstCachedFile = reader.files.get(filePath);
    const second = await readCodexRolloutState(sessionsDir, reader);

    expect(first.rollout?.state).toBe("working");
    expect(second).toEqual(first);
    expect(reader.files.get(filePath)).toBe(firstCachedFile);

    await writeFile(
      filePath,
      `${firstRecord}\n${JSON.stringify({
        timestamp: "2026-05-10T10:01:00.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1" },
      })}`,
      "utf8",
    );

    const changed = await readCodexRolloutState(sessionsDir, reader);

    expect(changed.rollout?.state).toBe("waiting");
    expect(reader.files.get(filePath)).not.toBe(firstCachedFile);
  });

  it("reads working from the current Codex rollout tail after an older interrupted turn", async () => {
    const content = await readFile(WORKING_CURRENT_SESSION_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-working-current.jsonl");

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      state: "working",
      reason: "function_call",
      timestamp: "2026-05-10T09:34:55.113Z",
    });
  });

  it("reads waiting from a Codex turn whose tail ends with matched function_call_output", async () => {
    const content = await readFile(IDLE_FIXTURE_SESSION_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-idle-fixture-session.jsonl");

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      state: "waiting",
      reason: "task_complete",
      turnId: "019e112e-6670-7620-9d09-061a78dc96cf",
    });
  });

  it("reads working from an in-flight Codex turn with an unmatched function_call", async () => {
    const content = await readFile(WORKING_UNMATCHED_TOOL_CALL_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-working-unmatched.jsonl");

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      state: "working",
      reason: "function_call",
      timestamp: "2026-05-10T10:01:02.000Z",
    });
  });

  it("treats function_call as state-neutral when its matching function_call_output exists later in the file", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        JSON.stringify({
          timestamp: "2026-05-10T11:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "019e1300-bbbb-7000-9000-000000000003",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-10T11:00:01.000Z",
          type: "response_item",
          payload: { type: "function_call", name: "exec_command", call_id: "call_X" },
        }),
        JSON.stringify({
          timestamp: "2026-05-10T11:00:02.000Z",
          type: "response_item",
          payload: { type: "function_call_output", call_id: "call_X" },
        }),
      ].join("\n"),
      "rollout-matched-pair.jsonl",
    );

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      state: "working",
      reason: "task_started",
      turnId: "019e1300-bbbb-7000-9000-000000000003",
    });
  });

  it("reads waiting from a real task_complete rollout tail", async () => {
    const content = await readFile(STALE_WORKING_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-stale.jsonl");

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      state: "waiting",
      reason: "task_complete",
      turnId: "019d8c38-fab8-7803-adfe-a984a5518abc",
    });
  });

  it("reads waiting when a trailing user message follows task_complete (intelas-e8f8 bug shape)", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        JSON.stringify({
          timestamp: "2026-06-28T09:03:41.314Z",
          type: "event_msg",
          payload: { type: "token_count" },
        }),
        JSON.stringify({
          timestamp: "2026-06-28T09:03:41.327Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "019f0d77-0a2a-77a0-ac7c-d71c20ef3b76",
          },
        }),
        JSON.stringify({
          timestamp: "2026-06-28T09:04:49.801Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text" }] },
        }),
      ].join("\n"),
      "rollout-trailing-message.jsonl",
    );

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      state: "waiting",
      reason: "task_complete",
      turnId: "019f0d77-0a2a-77a0-ac7c-d71c20ef3b76",
    });
  });

  it("uses provider total_tokens without adding cached or reasoning subsets", async () => {
    const sessionsDir = await makeSessionsDir(
      JSON.stringify({
        timestamp: "2026-06-28T09:03:41.314Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 90,
              cached_input_tokens: 50,
              output_tokens: 30,
              reasoning_output_tokens: 20,
              total_tokens: 120,
            },
          },
        },
      }),
      "rollout-usage.jsonl",
    );
    expect((await readCodexRolloutState(sessionsDir)).tokenUsage).toMatchObject({
      inputTokens: 90,
      outputTokens: 30,
      totalTokens: 120,
    });
  });

  it("reads waiting from a real interrupted turn_aborted tail", async () => {
    const content = await readFile(INTERRUPTED_TAIL_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-interrupted.jsonl");

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      state: "waiting",
      reason: "turn_aborted",
      turnId: "019dca92-5592-7043-bdca-211e6b7c11e2",
      timestamp: "2026-04-26T16:14:44.371Z",
    });
  });

  it("derives the live model from the newest turn_context record in the tail", async () => {
    const content = await readFile(INTERRUPTED_TAIL_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-model.jsonl");

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.model).toBe("gpt-5.5");
  });

  it("reports the model of a fresh rollout file whose only signal is turn_context", async () => {
    const sessionsDir = await makeSessionsDir(
      JSON.stringify({
        timestamp: "2026-05-10T10:00:00.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.5-codex" },
      }),
      "rollout-turn-context-only.jsonl",
    );

    const result = await readCodexRolloutState(sessionsDir);

    expect(result).toEqual({ rollout: null, rateLimit: null, model: "gpt-5.5-codex" });
  });

  it("keeps a sibling's rate limit when the newest file carries only a turn_context model", async () => {
    const sessionsDir = await makeMultiFileSessionsDir([
      {
        filename: "fresh-model-only.jsonl",
        content: JSON.stringify({
          timestamp: "2026-05-10T10:00:00.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.5-codex" },
        }),
        mtimeMs: 2_000_000_000_000,
      },
      {
        filename: "rate-limited.jsonl",
        content: JSON.stringify({
          timestamp: "2026-05-10T09:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: { rate_limit_reached_type: "primary" },
          },
        }),
        mtimeMs: 1_000_000_000_000,
      },
    ]);

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rateLimit).toEqual({ limited: true, reason: "codex primary" });
    expect(result.model).toBe("gpt-5.5-codex");
  });

  it("ignores turn_aborted events when the reason is not interrupted", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        JSON.stringify({
          timestamp: "2026-04-26T16:14:44.371Z",
          type: "event_msg",
          payload: {
            type: "turn_aborted",
            turn_id: "spur-abort-1",
            reason: "tool_error",
          },
        }),
      ].join("\n"),
      "rollout-non-interrupted-abort.jsonl",
    );

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toBeNull();
  });

  it("reads needs_input from request_user_input calls", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        JSON.stringify({
          timestamp: "2026-04-19T16:00:00.000Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [] },
        }),
        JSON.stringify({
          timestamp: "2026-04-19T16:00:01.000Z",
          type: "response_item",
          payload: { type: "function_call", name: "request_user_input", arguments: "{}" },
        }),
      ].join("\n"),
      "rollout-request-user-input.jsonl",
    );

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      state: "needs_input",
      reason: "request_user_input",
      timestamp: "2026-04-19T16:00:01.000Z",
    });
  });

  it("reads needs_input from structured input_required events", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        JSON.stringify({
          timestamp: "2026-04-19T16:10:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "show-waiting-menu" },
        }),
        JSON.stringify({
          timestamp: "2026-04-19T16:10:01.000Z",
          type: "event_msg",
          payload: {
            type: "input_required",
            turn_id: "spur-needs-3",
            questions: [{ header: "Plan", question: "Which tier should I run next?" }],
          },
        }),
      ].join("\n"),
      "rollout-input-required.jsonl",
    );

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      state: "needs_input",
      reason: "input_required",
      turnId: "spur-needs-3",
      timestamp: "2026-04-19T16:10:01.000Z",
    });
  });

  it("prefers the file with the newest in-content activity even when a stale file has a newer mtime", async () => {
    const staleContent = JSON.stringify({
      timestamp: "2026-05-10T09:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "019e0000-0000-7000-9000-00000000stal",
      },
    });
    const currentContent = JSON.stringify({
      timestamp: "2026-05-10T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "019e0000-0000-7000-9000-0000000curnt",
      },
    });
    const sessionsDir = await makeMultiFileSessionsDir([
      // Stale content, but its mtime is newer (mimics the heal-rewrite clobber).
      { filename: "stale.jsonl", content: staleContent, mtimeMs: 2_000_000_000_000 },
      // Current content, older mtime.
      { filename: "current.jsonl", content: currentContent, mtimeMs: 1_000_000_000_000 },
    ]);

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      state: "waiting",
      reason: "task_complete",
      turnId: "019e0000-0000-7000-9000-0000000curnt",
      timestamp: "2026-05-10T10:00:00.000Z",
      timestampMs: Date.parse("2026-05-10T10:00:00.000Z"),
    });
  });

  it("aligns rate-limit detection to the selected content-newest file", async () => {
    const currentContent = [
      JSON.stringify({
        timestamp: "2026-05-10T10:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "019e0000-0000-7000-9000-0000000curnt",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-10T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: { rate_limit_reached_type: "primary" },
        },
      }),
    ].join("\n");
    const staleContent = [
      JSON.stringify({
        timestamp: "2026-05-10T09:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "019e0000-0000-7000-9000-00000000stal",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-10T09:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: { primary: { used_percent: 100 } },
        },
      }),
    ].join("\n");
    const sessionsDir = await makeMultiFileSessionsDir([
      { filename: "stale.jsonl", content: staleContent, mtimeMs: 2_000_000_000_000 },
      { filename: "current.jsonl", content: currentContent, mtimeMs: 1_000_000_000_000 },
    ]);

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      turnId: "019e0000-0000-7000-9000-0000000curnt",
    });
    expect(result.rateLimit).toEqual({ limited: true, reason: "codex primary" });
  });

  it("returns the selected file's null rate-limit rather than a stale sibling's", async () => {
    const currentContent = JSON.stringify({
      timestamp: "2026-05-10T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "019e0000-0000-7000-9000-0000000curnt",
      },
    });
    const staleContent = [
      JSON.stringify({
        timestamp: "2026-05-10T09:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "019e0000-0000-7000-9000-00000000stal",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-10T09:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: { primary: { used_percent: 100 } },
        },
      }),
    ].join("\n");
    const sessionsDir = await makeMultiFileSessionsDir([
      { filename: "stale.jsonl", content: staleContent, mtimeMs: 2_000_000_000_000 },
      { filename: "current.jsonl", content: currentContent, mtimeMs: 1_000_000_000_000 },
    ]);

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      turnId: "019e0000-0000-7000-9000-0000000curnt",
    });
    expect(result.rateLimit).toBeNull();
  });

  it("falls back to the newest-mtime file's rate limit when no file has a rollout state", async () => {
    // Neither file has a rollout state line, only token_count rate_limits. With
    // no content timestamp to rank by, this branch legitimately picks by mtime.
    const newerMtimeContent = JSON.stringify({
      timestamp: "2026-05-10T09:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: { rate_limit_reached_type: "primary" },
      },
    });
    const olderMtimeContent = JSON.stringify({
      timestamp: "2026-05-10T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: { primary: { used_percent: 100 } },
      },
    });
    const sessionsDir = await makeMultiFileSessionsDir([
      { filename: "newer-mtime.jsonl", content: newerMtimeContent, mtimeMs: 2_000_000_000_000 },
      { filename: "older-mtime.jsonl", content: olderMtimeContent, mtimeMs: 1_000_000_000_000 },
    ]);

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toBeNull();
    expect(result.rateLimit).toEqual({ limited: true, reason: "codex primary" });
  });

  it("breaks equal in-content timestamps by picking the newer-mtime file", async () => {
    const sharedTimestamp = "2026-05-10T10:00:00.000Z";
    const newerMtimeContent = JSON.stringify({
      timestamp: sharedTimestamp,
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "019e0000-0000-7000-9000-0000000newer",
      },
    });
    const olderMtimeContent = JSON.stringify({
      timestamp: sharedTimestamp,
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "019e0000-0000-7000-9000-0000000older",
      },
    });
    const sessionsDir = await makeMultiFileSessionsDir([
      { filename: "newer-mtime.jsonl", content: newerMtimeContent, mtimeMs: 2_000_000_000_000 },
      { filename: "older-mtime.jsonl", content: olderMtimeContent, mtimeMs: 1_000_000_000_000 },
    ]);

    const result = await readCodexRolloutState(sessionsDir);

    expect(result.rollout).toMatchObject({
      state: "waiting",
      reason: "task_complete",
      turnId: "019e0000-0000-7000-9000-0000000newer",
      timestamp: sharedTimestamp,
      timestampMs: Date.parse(sharedTimestamp),
    });
  });
});

describe("readCodexTranscriptEntries", () => {
  it("parses an assistant message and a tool entry whose output is paired via call_id", async () => {
    const content = await readFile(WORKING_CURRENT_SESSION_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-transcript-working.jsonl");

    const entries = await readCodexTranscriptEntries(sessionsDir);
    expect(entries).not.toBeNull();
    if (!entries) throw new Error("expected entries");

    const assistantMessage = entries.find(
      (entry) => entry.kind === "message" && entry.role === "assistant",
    );
    expect(assistantMessage).toBeDefined();

    const pairedTool = entries.find(
      (entry) => entry.kind === "tool" && entry.callId === "call_5Uzki2Hl1LTKvrICbkwUXLrD",
    );
    expect(pairedTool).toMatchObject({
      kind: "tool",
      name: "exec_command",
      callId: "call_5Uzki2Hl1LTKvrICbkwUXLrD",
    });
    if (pairedTool?.kind === "tool") {
      expect(pairedTool.output).toContain("Total output lines: 50");
    }
  });

  it("emits entries in file-line order", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        JSON.stringify({
          timestamp: "2026-05-10T09:00:00.000Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        }),
        JSON.stringify({
          timestamp: "2026-05-10T09:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call_ordered",
            arguments: "{}",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-10T09:00:02.000Z",
          type: "response_item",
          payload: { type: "function_call_output", call_id: "call_ordered", output: "done" },
        }),
        JSON.stringify({
          timestamp: "2026-05-10T09:00:03.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "all set" }],
          },
        }),
      ].join("\n"),
      "rollout-transcript-order.jsonl",
    );

    const entries = await readCodexTranscriptEntries(sessionsDir);
    expect(entries).not.toBeNull();
    if (!entries) throw new Error("expected entries");

    expect(entries).toEqual([
      {
        kind: "message",
        role: "user",
        text: "hi",
        timestampMs: Date.parse("2026-05-10T09:00:00.000Z"),
      },
      {
        kind: "tool",
        name: "exec_command",
        callId: "call_ordered",
        inputSummary: "{}",
        output: "done",
        timestampMs: Date.parse("2026-05-10T09:00:01.000Z"),
      },
      {
        kind: "message",
        role: "assistant",
        text: "all set",
        timestampMs: Date.parse("2026-05-10T09:00:03.000Z"),
      },
    ]);
  });

  it("parses a reasoning entry from a non-empty summary", async () => {
    const sessionsDir = await makeSessionsDir(
      JSON.stringify({
        timestamp: "2026-05-10T09:00:00.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Checking the failing test." }],
        },
      }),
      "rollout-transcript-reasoning.jsonl",
    );

    const entries = await readCodexTranscriptEntries(sessionsDir);

    expect(entries).toEqual([
      {
        kind: "reasoning",
        text: "Checking the failing test.",
        timestampMs: Date.parse("2026-05-10T09:00:00.000Z"),
      },
    ]);
  });

  it("emits a question entry with options omitted for request_user_input", async () => {
    const sessionsDir = await makeSessionsDir(
      JSON.stringify({
        timestamp: "2026-05-10T09:00:00.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "request_user_input", arguments: "{}" },
      }),
      "rollout-transcript-question.jsonl",
    );

    const entries = await readCodexTranscriptEntries(sessionsDir);

    expect(entries).toEqual([
      {
        kind: "question",
        header: "",
        prompt: "",
        timestampMs: Date.parse("2026-05-10T09:00:00.000Z"),
      },
    ]);
  });
});
