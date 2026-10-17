import type * as FsPromises from "node:fs/promises";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_ROLLOUT_READ_MAX_CONCURRENCY,
  readCodexRolloutState,
  readCodexTranscriptEntries,
  type CodexRolloutReaderState,
  type CodexRolloutReadResult,
} from "../../src/agents/codex.js";
import { hashHistoryTail, PREFIX_VERIFY_BYTES } from "../../src/agent-history-delta.js";
import { SCAN_CHUNK_BYTES } from "../../src/jsonl-scan.js";
import { reconcileTokenUsage } from "../../src/token-usage.js";

// Passthrough fs mock that records how rollout files are opened and read.
const probe = vi.hoisted(() => ({
  readFileCalls: [] as string[],
  reads: [] as Array<{ path: string; length: number; position: number }>,
  live: 0,
  peak: 0,
  delayReads: false,
  statFail: new Set<string>(),
  readFail: new Set<string>(),
  closeFail: new Set<string>(),
  beforeRead: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      probe.readFileCalls.push(String(args[0]));
      return actual.readFile(...args);
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (probe.statFail.has(String(args[0]))) return Promise.reject(new Error("stat failed"));
      return actual.stat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      probe.live += 1;
      probe.peak = Math.max(probe.peak, probe.live);
      const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<unknown>;
      const close = handle.close.bind(handle);
      (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        await probe.beforeRead?.();
        if (probe.delayReads) await new Promise((resolve) => setTimeout(resolve, 0));
        probe.reads.push({ path, length: a[2] as number, position: a[3] as number });
        if (probe.readFail.has(path)) throw new Error("read failed");
        return read(...a);
      };
      handle.close = async () => {
        probe.live -= 1;
        await close();
        if (probe.closeFail.delete(path)) throw new Error("close failed");
      };
      return handle;
    },
  };
});

beforeEach(() => {
  probe.readFileCalls.length = 0;
  probe.reads.length = 0;
  probe.live = 0;
  probe.peak = 0;
  probe.delayReads = false;
  probe.statFail.clear();
  probe.readFail.clear();
  probe.closeFail.clear();
  probe.beforeRead = undefined;
});

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
const TOKEN_RESET_ALIASES_FIXTURE = join(
  __dirname,
  "../fixtures/agent-history/codex/token-reset-aliases.jsonl",
);
const CHILD_PREFIX_REPLAY_FIXTURE = join(
  __dirname,
  "../fixtures/agent-history/codex/child-prefix-replay.jsonl",
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

function sessionMeta(id: string): string {
  return JSON.stringify({
    timestamp: "2026-06-28T08:00:00.000Z",
    type: "session_meta",
    payload: { id },
  });
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

  it("keeps thread settings inside an active turn working until restore is verified", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        JSON.stringify({
          timestamp: "2026-09-25T06:39:51.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "interrupted-turn" },
        }),
        JSON.stringify({
          timestamp: "2026-09-25T06:40:26.000Z",
          type: "event_msg",
          payload: { type: "thread_settings_applied", thread_id: "root-thread" },
        }),
      ].join("\n"),
    );

    const resumed = await readCodexRolloutState(sessionsDir);
    expect(resumed.rollout).toMatchObject({
      state: "working",
      reason: "thread_settings_applied",
      precedingState: {
        state: "working",
        timestampMs: Date.parse("2026-09-25T06:39:51.000Z"),
      },
    });

    const filePath = join(sessionsDir, "2026", "04", "19", "rollout-test.jsonl");
    await writeFile(
      filePath,
      `${await readFile(filePath, "utf8")}\n${JSON.stringify({
        timestamp: "2026-09-25T06:41:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "followup-turn" },
      })}`,
      "utf8",
    );
    const followup = await readCodexRolloutState(sessionsDir);
    expect(followup.rollout).toMatchObject({ state: "working", reason: "task_started" });
  });

  it("keeps the real in-turn settings sequence working before turn_aborted", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        {
          timestamp: "2026-08-11T11:33:40.389Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn" },
        },
        {
          timestamp: "2026-08-11T11:42:28.000Z",
          type: "event_msg",
          payload: { type: "thread_settings_applied", thread_id: "root" },
        },
        {
          timestamp: "2026-08-11T11:42:40.000Z",
          type: "event_msg",
          payload: { type: "token_count", info: {} },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    expect((await readCodexRolloutState(sessionsDir)).rollout).toMatchObject({
      state: "working",
      reason: "thread_settings_applied",
    });
    const filePath = join(sessionsDir, "2026", "04", "19", "rollout-test.jsonl");
    await writeFile(
      filePath,
      `${await readFile(filePath, "utf8")}\n${JSON.stringify({
        timestamp: "2026-08-11T11:42:40.100Z",
        type: "event_msg",
        payload: { type: "turn_aborted", reason: "interrupted", turn_id: "turn" },
      })}`,
    );
    expect((await readCodexRolloutState(sessionsDir)).rollout).toMatchObject({
      state: "waiting",
      reason: "turn_aborted",
    });
  });

  it("keeps an active root working when a newer same-cwd child completes", async () => {
    const rootId = "01a09523-8f47-74f1-9004-fb313fa089d7";
    const childId = "01a09538-0547-7b71-a7f5-8ee2f835f0ef";
    const sessionsDir = await makeMultiFileSessionsDir([
      {
        filename: "root.jsonl",
        content: [
          JSON.stringify({
            type: "session_meta",
            payload: { id: rootId, cwd: "/same/worktree", source: "cli" },
          }),
          JSON.stringify({
            timestamp: "2026-09-12T10:22:11.000Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "root-turn" },
          }),
        ].join("\n"),
        mtimeMs: 1_000,
      },
      {
        filename: "child.jsonl",
        content: [
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: childId,
              cwd: "/same/worktree",
              source: { subagent: { thread_spawn: { parent_thread_id: rootId } } },
            },
          }),
          JSON.stringify({
            timestamp: "2026-09-12T10:45:57.000Z",
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "child-turn" },
          }),
        ].join("\n"),
        mtimeMs: 2_000,
      },
    ]);

    const result = await readCodexRolloutState(sessionsDir, undefined, rootId);
    expect(result.rollout).toMatchObject({
      state: "working",
      reason: "task_started",
      turnId: "root-turn",
    });
    expect(result.threadId).toBe(rootId);
    expect((await readCodexRolloutState(sessionsDir)).rollout?.state).toBe("working");
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
      [
        sessionMeta("usage-session"),
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
      ].join("\n"),
      "rollout-usage.jsonl",
    );
    expect((await readCodexRolloutState(sessionsDir)).tokenUsage).toMatchObject({
      inputTokens: 90,
      outputTokens: 30,
      totalTokens: 120,
    });
  });

  it("normalizes aliases and preserves usage across cumulative resets", async () => {
    const content = await readFile(TOKEN_RESET_ALIASES_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-token-reset-aliases.jsonl");
    const reader: CodexRolloutReaderState = { files: new Map() };
    const first = await readCodexRolloutState(sessionsDir, reader);
    const reread = await readCodexRolloutState(sessionsDir, reader);

    expect(first.tokenUsage).toEqual({
      provider: "codex",
      generationId: "codex:codex-reset-sanitized",
      inputTokens: 148,
      outputTokens: 32,
      totalTokens: 180,
      cacheReadInputTokens: 62,
      cacheWriteInputTokens: 18,
      reasoningOutputTokens: 13,
      observedAtMs: Date.parse("2026-09-24T10:00:04.000Z"),
    });
    expect(reread.tokenUsage).toEqual(first.tokenUsage);
    if (!first.tokenUsage || !reread.tokenUsage) throw new Error("expected token usage");
    const persisted = reconcileTokenUsage(undefined, first.tokenUsage);
    expect(reconcileTokenUsage(persisted, reread.tokenUsage).totalTokens).toBe(180);
  });

  it("removes a child rollout's copied parent prefix", async () => {
    const content = await readFile(CHILD_PREFIX_REPLAY_FIXTURE, "utf8");
    const sessionsDir = await makeSessionsDir(content, "rollout-child-prefix.jsonl");

    expect((await readCodexRolloutState(sessionsDir)).tokenUsage).toEqual({
      provider: "codex",
      generationId: "codex:codex-child-sanitized",
      inputTokens: 24,
      outputTokens: 6,
      totalTokens: 30,
      cacheReadInputTokens: 8,
      reasoningOutputTokens: 2,
      observedAtMs: Date.parse("2026-09-24T11:00:05.000Z"),
    });
  });

  it("rejects token samples with conflicting canonical and alias fields", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        sessionMeta("usage-conflict"),
        JSON.stringify({
          timestamp: "2026-06-28T09:03:41.314Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 90,
                prompt_tokens: 91,
                output_tokens: 30,
                total_tokens: 120,
              },
            },
          },
        }),
      ].join("\n"),
      "rollout-usage-conflict.jsonl",
    );

    expect(await readCodexRolloutState(sessionsDir)).not.toHaveProperty("tokenUsage");
  });

  it("rejects samples whose cache subsets exceed inclusive input", async () => {
    const sessionsDir = await makeSessionsDir(
      [
        sessionMeta("usage-invalid-subsets"),
        JSON.stringify({
          timestamp: "2026-06-28T09:03:41.314Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 90,
                cached_input_tokens: 60,
                cache_write_input_tokens: 40,
                output_tokens: 30,
                total_tokens: 120,
              },
            },
          },
        }),
      ].join("\n"),
      "rollout-usage-invalid-subsets.jsonl",
    );

    expect(await readCodexRolloutState(sessionsDir)).not.toHaveProperty("tokenUsage");
  });

  it("distinguishes absent optional components from measured zero", async () => {
    const tokenLine = (sessionId: string, optional: Record<string, number>) =>
      [
        sessionMeta(sessionId),
        JSON.stringify({
          timestamp: "2026-06-28T09:03:41.314Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 90,
                output_tokens: 30,
                total_tokens: 120,
                ...optional,
              },
            },
          },
        }),
      ].join("\n");
    const sessionsDir = await makeMultiFileSessionsDir([
      {
        filename: "unknown.jsonl",
        content: tokenLine("unknown", {}),
        mtimeMs: 1_000_000_000_000,
      },
      {
        filename: "zero.jsonl",
        content: tokenLine("zero", { cached_input_tokens: 0 }),
        mtimeMs: 2_000_000_000_000,
      },
    ]);

    const measured = await readCodexRolloutState(sessionsDir);
    expect(measured.tokenUsage?.cacheReadInputTokens).toBe(0);
    expect(measured.tokenUsage).not.toHaveProperty("cacheWriteInputTokens");
  });

  it("selects token-only files by the token event timestamp, not file mtime", async () => {
    const tokenLine = (timestamp: string, totalTokens: number, sessionId: string) =>
      [
        sessionMeta(sessionId),
        JSON.stringify({
          timestamp,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: totalTokens - 10,
                output_tokens: 10,
                total_tokens: totalTokens,
              },
            },
          },
        }),
      ].join("\n");
    const sessionsDir = await makeMultiFileSessionsDir([
      {
        filename: "newer-mtime.jsonl",
        content: tokenLine("2026-06-28T09:00:00.000Z", 100, "older-event"),
        mtimeMs: 2_000_000_000_000,
      },
      {
        filename: "newer-event.jsonl",
        content: tokenLine("2026-06-28T10:00:00.000Z", 200, "newer-event"),
        mtimeMs: 1_000_000_000_000,
      },
    ]);

    expect((await readCodexRolloutState(sessionsDir)).tokenUsage).toMatchObject({
      generationId: "codex:newer-event",
      totalTokens: 200,
      observedAtMs: Date.parse("2026-06-28T10:00:00.000Z"),
    });
  });

  it("returns root and short-lived child generations from one sweep", async () => {
    const tokenCount = (timestamp: string, totalTokens: number) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: totalTokens - 10,
              output_tokens: 10,
              total_tokens: totalTokens,
            },
          },
        },
      });
    const rootId = "root-thread";
    const childMeta = (id: string, timestamp: string) =>
      JSON.stringify({
        timestamp,
        type: "session_meta",
        payload: {
          id,
          cwd: "/same/worktree",
          timestamp,
          source: { subagent: { thread_spawn: { parent_thread_id: rootId } } },
        },
      });
    const sessionsDir = await makeMultiFileSessionsDir([
      {
        filename: "root.jsonl",
        content: [
          sessionMeta(rootId),
          JSON.stringify({
            timestamp: "2026-09-12T09:59:00.000Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "root-turn" },
          }),
          tokenCount("2026-09-12T10:00:00.000Z", 100),
        ].join("\n"),
        mtimeMs: 1_000,
      },
    ]);
    const reader: CodexRolloutReaderState = { files: new Map() };
    expect((await readCodexRolloutState(sessionsDir, reader, rootId)).tokenUsages).toMatchObject([
      { generationId: "codex:root-thread", totalTokens: 100 },
    ]);
    const rolloutsDir = join(sessionsDir, "2026", "04", "19");
    await writeFile(
      join(rolloutsDir, "child-a.jsonl"),
      [
        childMeta("child-a", "2026-09-12T10:01:00.000Z"),
        tokenCount("2026-09-12T10:00:59.000Z", 10),
        tokenCount("2026-09-12T10:01:05.000Z", 30),
        JSON.stringify({
          timestamp: "2026-09-12T10:01:06.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "child-a-turn" },
        }),
      ].join("\n"),
    );
    await writeFile(
      join(rolloutsDir, "child-b.jsonl"),
      [
        childMeta("child-b", "2026-09-12T10:02:00.000Z"),
        tokenCount("2026-09-12T10:02:05.000Z", 50),
        JSON.stringify({
          timestamp: "2026-09-12T10:02:06.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "child-b-turn" },
        }),
      ].join("\n"),
    );

    const result = await readCodexRolloutState(sessionsDir, reader, rootId);
    expect(result.rollout).toMatchObject({ state: "working", turnId: "root-turn" });
    expect(result.tokenUsage?.generationId).toBe("codex:root-thread");
    expect(
      result.tokenUsages?.map((sample) => [sample.generationId, sample.totalTokens]).sort(),
    ).toEqual([
      ["codex:child-a", 20],
      ["codex:child-b", 50],
      ["codex:root-thread", 100],
    ]);
  });

  it("keeps token usage bound to the selected active rollout", async () => {
    const tokenLine = (timestamp: string, totalTokens: number, sessionId: string) =>
      [
        sessionMeta(sessionId),
        JSON.stringify({
          timestamp,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: totalTokens - 10,
                output_tokens: 10,
                total_tokens: totalTokens,
              },
            },
          },
        }),
      ].join("\n");
    const active = [
      tokenLine("2026-06-28T09:00:00.000Z", 100, "active"),
      JSON.stringify({
        timestamp: "2026-06-28T11:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "active-turn" },
      }),
    ].join("\n");
    const sessionsDir = await makeMultiFileSessionsDir([
      { filename: "active.jsonl", content: active, mtimeMs: 1_000_000_000_000 },
      {
        filename: "sibling.jsonl",
        content: tokenLine("2026-06-28T10:00:00.000Z", 200, "sibling"),
        mtimeMs: 2_000_000_000_000,
      },
    ]);

    const result = await readCodexRolloutState(sessionsDir);
    expect(result.rollout?.turnId).toBe("active-turn");
    expect(result.tokenUsage).toMatchObject({ totalTokens: 100 });
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

const FIXTURE_DIR = join(__dirname, "../fixtures/agent-history/codex");

function rolloutPath(sessionsDir: string, filename: string): string {
  return join(sessionsDir, "2026", "04", "19", filename);
}

function normalizeResult(result: CodexRolloutReadResult): CodexRolloutReadResult {
  return result.rollout
    ? { ...result, rollout: { ...result.rollout, filePath: basename(result.rollout.filePath) } }
    : result;
}

function eventLine(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type: "event_msg", payload: { type, ...payload } });
}

function callLine(timestamp: string, callId: string): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "function_call", name: "exec_command", call_id: callId },
  });
}

function outputLine(timestamp: string, callId: string): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "function_call_output", call_id: callId, output: "ok" },
  });
}

function fillerLine(index: number, bytes: number): string {
  return JSON.stringify({
    timestamp: "2026-05-10T10:00:00.000Z",
    type: "response_item",
    payload: { type: "message", index, text: "f".repeat(bytes) },
  });
}

async function coldRead(content: string, filename: string): Promise<CodexRolloutReadResult> {
  const sessionsDir = await makeSessionsDir(content, filename);
  return normalizeResult(await readCodexRolloutState(sessionsDir));
}

describe("readCodexRolloutState incremental chunked reads", () => {
  it("T0 matches the pre-change golden for every fixture, cold and at every split point", async () => {
    const golden = JSON.parse(
      await readFile(join(FIXTURE_DIR, "rollout-state-golden.json"), "utf8"),
    ) as Record<string, CodexRolloutReadResult>;
    const names = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith(".jsonl")).sort();
    expect(names).toHaveLength(12);
    expect(Object.keys(golden).sort()).toEqual(names);

    for (const name of names) {
      const content = await readFile(join(FIXTURE_DIR, name), "utf8");
      expect(await coldRead(content, name), name).toEqual(golden[name]);

      const sessionsDir = await makeSessionsDir("", name);
      for (
        let split = content.indexOf("\n") + 1;
        split > 0;
        split = content.indexOf("\n", split) + 1
      ) {
        await writeFile(rolloutPath(sessionsDir, name), content.slice(0, split), "utf8");
        const reader: CodexRolloutReaderState = { files: new Map() };
        await readCodexRolloutState(sessionsDir, reader);
        await appendFile(rolloutPath(sessionsDir, name), content.slice(split));
        const incremental = normalizeResult(await readCodexRolloutState(sessionsDir, reader));
        expect(incremental, `${name} split ${split}`).toEqual(golden[name]);
      }
    }
  }, 60_000);

  it("extracts cumulative structured components from a sanitized rollout fixture", async () => {
    const result = await coldRead(
      await readFile(join(FIXTURE_DIR, "token-components.jsonl"), "utf8"),
      "token-components.jsonl",
    );

    expect(result.tokenUsage).toEqual({
      provider: "codex",
      generationId: "codex:thread-sanitized",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadInputTokens: 40,
      cacheWriteInputTokens: 10,
      reasoningOutputTokens: 20,
      observedAtMs: Date.parse("2026-09-24T10:00:01.000Z"),
    });
  });

  it("T1 reads a large rollout in bounded chunks without readFile", async () => {
    const fixture = await readFile(WORKING_UNMATCHED_TOOL_CALL_FIXTURE, "utf8");
    const filler = Array.from({ length: 3 * Math.ceil(SCAN_CHUNK_BYTES / 1000) + 5 }, (_, i) =>
      fillerLine(i, 1000),
    );
    const content = `${fixture.trimEnd()}\n${filler.join("\n")}\n`;
    const sessionsDir = await makeSessionsDir(content, "rollout-large.jsonl");
    const filePath = rolloutPath(sessionsDir, "rollout-large.jsonl");
    probe.readFileCalls.length = 0;

    const result = normalizeResult(await readCodexRolloutState(sessionsDir));

    expect(probe.readFileCalls).not.toContain(filePath);
    const reads = probe.reads.filter((read) => read.path === filePath);
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...reads.map((read) => read.length))).toBeLessThanOrEqual(SCAN_CHUNK_BYTES);
    expect(result).toEqual(await coldRead(fixture, "rollout-large.jsonl"));
  });

  it("T2 reads only appended bytes after an append", async () => {
    const base = [
      eventLine("2026-05-10T10:00:00.000Z", "task_started", { turn_id: "t1" }),
      ...Array.from({ length: 30 }, (_, i) => fillerLine(i, 500)),
    ].join("\n");
    const sessionsDir = await makeSessionsDir(`${base}\n`, "rollout-append.jsonl");
    const filePath = rolloutPath(sessionsDir, "rollout-append.jsonl");
    const reader: CodexRolloutReaderState = { files: new Map() };
    await readCodexRolloutState(sessionsDir, reader);
    const previousSize = Buffer.byteLength(`${base}\n`);
    expect(previousSize).toBeGreaterThan(PREFIX_VERIFY_BYTES);
    const appended = `${eventLine("2026-05-10T10:01:00.000Z", "task_complete", { turn_id: "t1" })}\n`;
    probe.reads.length = 0;
    await appendFile(filePath, appended);

    const result = await readCodexRolloutState(sessionsDir, reader);

    expect(result.rollout?.state).toBe("waiting");
    const reads = probe.reads.filter((read) => read.path === filePath);
    expect(Math.min(...reads.map((read) => read.position))).toBeGreaterThanOrEqual(
      previousSize - PREFIX_VERIFY_BYTES,
    );
    const totalBytes = reads.reduce((sum, read) => sum + read.length, 0);
    expect(totalBytes).toBeLessThanOrEqual(Buffer.byteLength(appended) + PREFIX_VERIFY_BYTES);
    expect(totalBytes).toBe(4206);
    expect(reader.files.get(filePath)?.offset).toBe(previousSize + Buffer.byteLength(appended));
  });

  it("T4 holds back a partial trailing line until it completes", async () => {
    const started = eventLine("2026-05-10T10:00:00.000Z", "task_started", { turn_id: "t1" });
    const complete = eventLine("2026-05-10T10:01:00.000Z", "task_complete", { turn_id: "t1" });
    const half = complete.slice(0, Math.floor(complete.length / 2));
    const sessionsDir = await makeSessionsDir(`${started}\n${half}`, "rollout-partial.jsonl");
    const filePath = rolloutPath(sessionsDir, "rollout-partial.jsonl");
    const reader: CodexRolloutReaderState = { files: new Map() };

    const first = await readCodexRolloutState(sessionsDir, reader);

    expect(first.rollout?.state).toBe("working");
    expect(reader.files.get(filePath)?.offset).toBe(Buffer.byteLength(`${started}\n`));

    await appendFile(filePath, `${complete.slice(half.length)}\n`);
    const second = normalizeResult(await readCodexRolloutState(sessionsDir, reader));

    expect(second).toEqual(await coldRead(`${started}\n${complete}\n`, "rollout-partial.jsonl"));
    expect(second.rollout?.state).toBe("waiting");
  });

  it("retains exact cached raw tails across appends, partial lines and refolds", async () => {
    let content = `${eventLine("2026-05-10T10:00:00.000Z", "task_started", {})}\n \t\r\n`;
    const sessionsDir = await makeSessionsDir(content);
    const filePath = rolloutPath(sessionsDir, "rollout-test.jsonl");
    const reader: CodexRolloutReaderState = { files: new Map() };
    const checkTail = async (): Promise<void> => {
      await readCodexRolloutState(sessionsDir, reader);
      const entry = reader.files.get(filePath);
      if (!entry) throw new Error("expected cache entry");
      const raw = Buffer.from(content);
      const tail = raw.subarray(Math.max(0, entry.offset - PREFIX_VERIFY_BYTES), entry.offset);
      expect(entry.tail).toEqual(tail);
      expect(entry.tailHash).toBe(hashHistoryTail(tail));
    };
    await checkTail();
    const original = reader.files.get(filePath);
    const originalTail = Buffer.from(original?.tail ?? []);
    const originalHash = original?.tailHash;
    for (const append of [
      ` \t${JSON.stringify({ type: "unknown", text: "é🙂" })}\r\n`,
      `${JSON.stringify({ type: "unknown", text: "é🙂".repeat(900) })}\n`,
      '{"partial":',
      '"é🙂"}',
      "\n",
    ]) {
      const previousEntry = reader.files.get(filePath);
      probe.reads.length = 0;
      content += append;
      await appendFile(filePath, append);
      await checkTail();
      expect(Math.min(...probe.reads.map((read) => read.position))).toBeGreaterThanOrEqual(
        Math.max(0, (previousEntry?.offset ?? 0) - PREFIX_VERIFY_BYTES),
      );
      if (append === '{"partial":') {
        expect(reader.files.get(filePath)?.offset).toBe(previousEntry?.offset);
        expect(reader.files.get(filePath)?.tail).toEqual(previousEntry?.tail);
        expect(reader.files.get(filePath)?.tailHash).toBe(previousEntry?.tailHash);
      }
    }
    expect(original?.tail).toEqual(originalTail);
    expect(original?.tailHash).toBe(originalHash);
    const beforeRewrite = reader.files.get(filePath);
    content = `${eventLine("2026-05-10T10:01:00.000Z", "task_complete", {})}\n${JSON.stringify({ text: "x".repeat(7000) })}\n`;
    await writeFile(filePath, content);
    await checkTail();
    expect((await readCodexRolloutState(sessionsDir, reader)).rollout?.state).toBe("waiting");
    expect(reader.files.get(filePath)?.fold).not.toBe(beforeRewrite?.fold);
    content = `${eventLine("2026-05-10T10:02:00.000Z", "task_started", {})}\n`;
    await writeFile(filePath, content);
    await checkTail();
    expect((await readCodexRolloutState(sessionsDir, reader)).rollout?.state).toBe("working");
  });

  it("T5 refolds from scratch after an in-place rewrite", async () => {
    const original = `${eventLine("2026-05-10T10:00:00.000Z", "task_started", { turn_id: "t1" })}\n`;
    const sessionsDir = await makeSessionsDir(original, "rollout-rewrite.jsonl");
    const filePath = rolloutPath(sessionsDir, "rollout-rewrite.jsonl");
    const reader: CodexRolloutReaderState = { files: new Map() };
    expect((await readCodexRolloutState(sessionsDir, reader)).rollout?.state).toBe("working");
    const rewritten = [
      eventLine("2026-05-10T10:02:00.000Z", "task_complete", { turn_id: "t1" }),
      fillerLine(0, 200),
      fillerLine(1, 200),
    ].join("\n");
    expect(Buffer.byteLength(rewritten)).toBeGreaterThan(Buffer.byteLength(original));

    await writeFile(filePath, `${rewritten}\n`, "utf8");
    const result = normalizeResult(await readCodexRolloutState(sessionsDir, reader));

    expect(result).toEqual(await coldRead(`${rewritten}\n`, "rollout-rewrite.jsonl"));
    expect(result.rollout?.state).toBe("waiting");
  });

  it.each([false, true])(
    "T5 refolds a same-size prefix rewrite with partial=%s",
    async (partial) => {
      const pending = partial ? '{"pending":' : "";
      const suffix = `\n${fillerLine(0, 9000)}\n${pending}`;
      const original =
        eventLine("2026-05-10T10:00:00.000Z", "task_started", {}).padEnd(160) + suffix;
      const rewritten =
        eventLine("2026-05-10T10:00:00.000Z", "task_complete", {}).padEnd(160) + suffix;
      const sessionsDir = await makeSessionsDir(original);
      const filePath = rolloutPath(sessionsDir, "rollout-test.jsonl");
      const reader: CodexRolloutReaderState = { files: new Map() };
      expect((await readCodexRolloutState(sessionsDir, reader)).rollout?.state).toBe("working");
      const entry = reader.files.get(filePath);
      if (!entry) throw new Error("expected cache entry");
      const before = await stat(filePath);
      expect(entry.offset).toBe(before.size - Buffer.byteLength(pending));
      expect(Buffer.byteLength(rewritten)).toBe(before.size);
      const unchangedTail = Buffer.from(rewritten).subarray(
        entry.offset - PREFIX_VERIFY_BYTES,
        entry.offset,
      );
      expect(hashHistoryTail(unchangedTail)).toBe(entry.tailHash);

      await writeFile(filePath, rewritten);
      await utimes(filePath, new Date(before.atimeMs), new Date(before.mtimeMs + 2000));
      const after = await stat(filePath);
      expect(after.ino).toBe(before.ino);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).not.toBe(before.mtimeMs);

      const warm = normalizeResult(await readCodexRolloutState(sessionsDir, reader));
      const repeat = normalizeResult(await readCodexRolloutState(sessionsDir, reader));
      const cold = normalizeResult(await readCodexRolloutState(sessionsDir));
      expect(cold.rollout?.state).toBe("waiting");
      expect(warm).toEqual(cold);
      expect(repeat).toEqual(cold);
      expect(reader.files.get(filePath)).not.toBe(entry);
    },
  );

  it("T6 drops a call state once its output arrives in an append", async () => {
    const prefix = [
      eventLine("2026-05-10T10:00:00.000Z", "task_started", { turn_id: "t1" }),
      callLine("2026-05-10T10:00:01.000Z", "call-1"),
    ].join("\n");
    const output = outputLine("2026-05-10T10:00:02.000Z", "call-1");
    const sessionsDir = await makeSessionsDir(`${prefix}\n`, "rollout-matched.jsonl");
    const reader: CodexRolloutReaderState = { files: new Map() };
    expect((await readCodexRolloutState(sessionsDir, reader)).rollout?.reason).toBe(
      "function_call",
    );

    await appendFile(rolloutPath(sessionsDir, "rollout-matched.jsonl"), `${output}\n`);
    const result = normalizeResult(await readCodexRolloutState(sessionsDir, reader));

    expect(result).toEqual(await coldRead(`${prefix}\n${output}\n`, "rollout-matched.jsonl"));
    expect(result.rollout?.reason).toBe("task_started");
  });

  it("T7 does not double-fold on overlapping reads of one reader", async () => {
    const content = await readFile(join(FIXTURE_DIR, "token-reset-aliases.jsonl"), "utf8");
    const lines = content.split("\n").filter(Boolean);
    const prefix = `${lines.slice(0, 2).join("\n")}\n`;
    const rest = `${lines.slice(2).join("\n")}\n`;
    const sessionsDir = await makeSessionsDir(prefix, "rollout-overlap.jsonl");
    const reader: CodexRolloutReaderState = { files: new Map() };
    await readCodexRolloutState(sessionsDir, reader);
    const oldEntry = reader.files.get(rolloutPath(sessionsDir, "rollout-overlap.jsonl"));
    const oldFold = structuredClone(oldEntry?.fold);
    await appendFile(rolloutPath(sessionsDir, "rollout-overlap.jsonl"), rest);

    const [left, right] = await Promise.all([
      readCodexRolloutState(sessionsDir, reader),
      readCodexRolloutState(sessionsDir, reader),
    ]);

    const cold = await coldRead(content, "rollout-overlap.jsonl");
    expect(cold.tokenUsage).toBeDefined();
    expect(normalizeResult(left)).toEqual(cold);
    expect(normalizeResult(right)).toEqual(cold);
    expect(oldEntry?.fold).toEqual(oldFold);
  });

  it.each([false, true])("coalesces overlapping scans after warm=%s", async (warm) => {
    const started = `${eventLine("2026-05-10T10:00:00.000Z", "task_started", { turn_id: "t1" })}\n`;
    const sessionsDir = await makeSessionsDir(started);
    const filePath = rolloutPath(sessionsDir, "rollout-test.jsonl");
    const reader: CodexRolloutReaderState = { files: new Map() };
    if (warm) {
      await readCodexRolloutState(sessionsDir, reader);
      await appendFile(
        filePath,
        `${eventLine("2026-05-10T10:01:00.000Z", "task_complete", { turn_id: "t1" })}\n`,
      );
    }
    probe.reads.length = 0;
    probe.delayReads = true;

    const results = await Promise.all(
      Array.from({ length: 6 }, () => readCodexRolloutState(sessionsDir, reader)),
    );

    expect(
      results.every((result) => result.rollout?.state === (warm ? "waiting" : "working")),
    ).toBe(true);
    // Cold: scan. Append: old hash + appended scan.
    expect(probe.reads.filter((read) => read.path === filePath)).toHaveLength(warm ? 2 : 1);
    expect(probe.live).toBe(0);
  });

  it("restats queued calls so an append during a scan stays fresh", async () => {
    const started = `${eventLine("2026-05-10T10:00:00.000Z", "task_started", { turn_id: "t1" })}\n`;
    const completed = `${eventLine("2026-05-10T10:01:00.000Z", "task_complete", { turn_id: "t1" })}\n`;
    const sessionsDir = await makeSessionsDir(started);
    const reader: CodexRolloutReaderState = { files: new Map() };
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    probe.beforeRead = async () => {
      probe.beforeRead = undefined;
      enter();
      await release;
    };
    const first = readCodexRolloutState(sessionsDir, reader);
    await entered;
    await appendFile(rolloutPath(sessionsDir, "rollout-test.jsonl"), completed);
    const second = readCodexRolloutState(sessionsDir, reader);
    resume();

    expect((await first).rollout?.state).toBe("working");
    expect((await second).rollout?.state).toBe("waiting");
    expect(normalizeResult(await readCodexRolloutState(sessionsDir, reader))).toEqual(
      await coldRead(started + completed, "rollout-test.jsonl"),
    );
  });

  it("releases rejected reader operations and retries failed scans", async () => {
    const sessionsDir = await makeSessionsDir(
      `${eventLine("2026-05-10T10:00:00.000Z", "task_started", {})}\n`,
    );
    const filePath = rolloutPath(sessionsDir, "rollout-test.jsonl");
    const reader: CodexRolloutReaderState = { files: new Map() };
    probe.closeFail.add(filePath);
    const first = readCodexRolloutState(sessionsDir, reader);
    const second = readCodexRolloutState(sessionsDir, reader);
    await expect(first).rejects.toThrow("close failed");
    expect((await second).rollout?.state).toBe("working");

    await appendFile(filePath, `${eventLine("2026-05-10T10:01:00.000Z", "task_complete", {})}\n`);
    probe.readFail.add(filePath);
    expect((await readCodexRolloutState(sessionsDir, reader)).rollout).toBeNull();
    expect(reader.files.has(filePath)).toBe(false);
    probe.readFail.clear();
    expect((await readCodexRolloutState(sessionsDir, reader)).rollout?.state).toBe("waiting");
    expect(probe.live).toBe(0);
  });

  it("drops removed files and keeps restarted readers independent", async () => {
    const sessionsDir = await makeSessionsDir(
      `${eventLine("2026-05-10T10:00:00.000Z", "task_started", {})}\n`,
    );
    const filePath = rolloutPath(sessionsDir, "rollout-test.jsonl");
    const reader: CodexRolloutReaderState = { files: new Map() };
    await readCodexRolloutState(sessionsDir, reader);
    const restarted: CodexRolloutReaderState = { files: new Map() };
    probe.reads.length = 0;
    await Promise.all([
      readCodexRolloutState(sessionsDir, reader),
      readCodexRolloutState(sessionsDir, restarted),
    ]);
    expect(probe.reads.filter((read) => read.path === filePath)).toHaveLength(1);
    expect(restarted.files.get(filePath)).not.toBe(reader.files.get(filePath));
    await rm(filePath);
    expect((await readCodexRolloutState(sessionsDir, reader)).rollout).toBeNull();
    expect(reader.files.size).toBe(0);
  });

  it("preserves structured quota and state across error and unknown records", async () => {
    const prefix = `${sessionMeta("quota-thread")}\n${eventLine("2026-05-10T10:00:00.000Z", "task_started", {})}\n`;
    const appended =
      [
        eventLine("2026-05-10T10:01:00.000Z", "token_count", {
          rate_limits: { primary: { used_percent: 100 } },
        }),
        eventLine("2026-05-10T10:02:00.000Z", "error", { message: "synthetic error" }),
        eventLine("2026-05-10T10:03:00.000Z", "unknown", {}),
        "null",
        "{malformed}",
      ].join("\n") + "\n";
    const sessionsDir = await makeSessionsDir(prefix);
    const reader: CodexRolloutReaderState = { files: new Map() };
    await readCodexRolloutState(sessionsDir, reader);
    await appendFile(rolloutPath(sessionsDir, "rollout-test.jsonl"), appended);

    const [left, right] = await Promise.all([
      readCodexRolloutState(sessionsDir, reader),
      readCodexRolloutState(sessionsDir, reader),
    ]);

    expect(left.rateLimit).not.toBeNull();
    expect(left.rollout?.state).toBe("working");
    expect(left).toEqual(right);
    expect(normalizeResult(left)).toEqual(await coldRead(prefix + appended, "rollout-test.jsonl"));
  });

  it("T8 never scans more rollout files at once than the gate allows", async () => {
    const names = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith(".jsonl")).sort();
    const root = await mkdtemp(join(tmpdir(), "codex-rollout-gate-"));
    tempDirs.push(root);
    const dayDir = join(root, "sessions", "2026", "04", "19");
    await mkdir(dayDir, { recursive: true });
    for (const name of names) await copyFile(join(FIXTURE_DIR, name), join(dayDir, name));
    probe.delayReads = true;

    await readCodexRolloutState(join(root, "sessions"));

    expect(names).toHaveLength(12);
    expect(probe.peak).toBe(CODEX_ROLLOUT_READ_MAX_CONCURRENCY);
    expect(probe.live).toBe(0);
  });

  it("T9 keeps only the state records since the newest anchor", async () => {
    const lines: string[] = [];
    let call = 0;
    const stamp = (): string => new Date(Date.UTC(2026, 4, 10, 10, 0, call++)).toISOString();
    for (let turn = 0; turn < 200; turn += 1) {
      lines.push(eventLine(stamp(), "task_started", { turn_id: `turn-${turn}` }));
      for (let i = 0; i < 5; i += 1) {
        lines.push(
          callLine(stamp(), `call-${turn}-${i}`),
          outputLine(stamp(), `call-${turn}-${i}`),
        );
      }
      lines.push(eventLine(stamp(), "task_complete", { turn_id: `turn-${turn}` }));
    }
    lines.push(eventLine(stamp(), "task_started", { turn_id: "turn-200" }));
    for (let i = 0; i < 5; i += 1) lines.push(callLine(stamp(), `open-${i}`));
    for (let i = 0; i < 3; i += 1) lines.push(outputLine(stamp(), `open-${i}`));
    const sessionsDir = await makeSessionsDir(`${lines.join("\n")}\n`, "rollout-turns.jsonl");
    const reader: CodexRolloutReaderState = { files: new Map() };

    const result = await readCodexRolloutState(sessionsDir, reader);

    const fold = reader.files.get(rolloutPath(sessionsDir, "rollout-turns.jsonl"))?.fold;
    expect(fold?.stateTail.map((record) => record.reason)).toEqual([
      "task_started",
      "function_call",
      "function_call",
      "function_call",
      "function_call",
      "function_call",
    ]);
    expect(fold?.matchedCallIds.size).toBe(200 * 5 + 3);
    expect(result.rollout?.state).toBe("working");
    expect(result.rollout?.callId).toBe("open-4");
  });

  it("T10 returns a result but caches nothing when stat fails", async () => {
    const content = `${eventLine("2026-05-10T10:00:00.000Z", "task_started", { turn_id: "t1" })}\n`;
    const sessionsDir = await makeSessionsDir(content, "rollout-nostat.jsonl");
    const filePath = rolloutPath(sessionsDir, "rollout-nostat.jsonl");
    const reader: CodexRolloutReaderState = { files: new Map() };
    probe.statFail.add(filePath);

    const result = normalizeResult(await readCodexRolloutState(sessionsDir, reader));

    expect(result).toEqual(await coldRead(content, "rollout-nostat.jsonl"));
    expect(result.rollout?.state).toBe("working");
    expect(reader.files.has(filePath)).toBe(false);
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
