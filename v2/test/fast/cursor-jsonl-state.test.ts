import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectCursorRateLimit } from "../../src/rate-limit-detect.js";
import {
  classifyCursorJsonlState,
  CURSOR_JSONL_TOOL_USE_GRACE_MS,
  findLatestCursorTranscriptFile,
  parseCursorJsonlRecord,
  readCursorJsonlState,
  readCursorTranscriptEntries,
  toCursorProjectPath,
  type CursorParsedRecord,
} from "../../src/cursor-jsonl-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CURSOR_FIXTURES_DIR = resolve(__dirname, "../fixtures/agent-history/cursor");
const NOW = 1_700_000_000_000;

function parseFixture(content: string): CursorParsedRecord[] {
  const records: CursorParsedRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const record = parseCursorJsonlRecord(trimmed, NOW);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

function rec(overrides: Partial<CursorParsedRecord>): CursorParsedRecord {
  return {
    role: "assistant",
    hasToolUse: false,
    hasToolResult: false,
    timestampMs: NOW - 10_000,
    ...overrides,
  };
}

describe("classifyCursorJsonlState", () => {
  it("returns working for empty records", () => {
    expect(classifyCursorJsonlState([], NOW)).toBe("working");
  });

  it("returns error when the last record is a turn_ended error", async () => {
    const records = parseFixture(
      await readFile(join(CURSOR_FIXTURES_DIR, "turn-ended-error.jsonl"), "utf8"),
    );
    expect(records.length).toBe(1);
    expect(classifyCursorJsonlState(records, NOW)).toBe("error");
  });

  it("drops a non-error turn_ended record (no error field)", () => {
    const record = parseCursorJsonlRecord('{"type":"turn_ended","status":"completed"}', NOW);
    expect(record).toBeNull();
  });

  it("keeps fresh background work active after the foreground turn is aborted", async () => {
    const records = parseFixture(
      await readFile(join(CURSOR_FIXTURES_DIR, "aborted-background-work.jsonl"), "utf8"),
    );
    expect(records.length).toBe(3);
    expect(classifyCursorJsonlState(records, NOW, NOW)).toBe("working");
  });

  it("returns waiting for stale assistant tool_use past the tool_use grace window", () => {
    expect(
      classifyCursorJsonlState(
        [
          rec({
            role: "assistant",
            hasToolUse: true,
            timestampMs: NOW - CURSOR_JSONL_TOOL_USE_GRACE_MS - 60_000,
          }),
        ],
        NOW,
      ),
    ).toBe("waiting");
  });

  it("returns working for fresh assistant tool_use within the activity window", () => {
    expect(
      classifyCursorJsonlState(
        [rec({ role: "assistant", hasToolUse: true, timestampMs: NOW - 5_000 })],
        NOW,
      ),
    ).toBe("working");
  });

  it("returns working for stale assistant tool_use when file mtime is recent", () => {
    expect(
      classifyCursorJsonlState(
        [rec({ role: "assistant", hasToolUse: true, timestampMs: NOW - 120_000 })],
        NOW,
        NOW,
      ),
    ).toBe("working");
  });

  it("returns working when the last assistant record has tool_use", () => {
    expect(
      classifyCursorJsonlState(
        [rec({ role: "user" }), rec({ role: "assistant", hasToolUse: true })],
        NOW,
      ),
    ).toBe("working");
  });

  it("returns waiting when the last assistant record is text-only", () => {
    expect(classifyCursorJsonlState([rec({ role: "assistant" })], NOW)).toBe("waiting");
  });

  it("returns working for an assistant tool_use record exactly at the grace boundary", () => {
    expect(
      classifyCursorJsonlState(
        [
          rec({
            role: "assistant",
            hasToolUse: true,
            timestampMs: NOW - CURSOR_JSONL_TOOL_USE_GRACE_MS,
          }),
        ],
        NOW,
      ),
    ).toBe("working");
  });

  it("returns waiting for an assistant tool_use record just past the grace boundary", () => {
    expect(
      classifyCursorJsonlState(
        [
          rec({
            role: "assistant",
            hasToolUse: true,
            timestampMs: NOW - CURSOR_JSONL_TOOL_USE_GRACE_MS - 1,
          }),
        ],
        NOW,
      ),
    ).toBe("waiting");
  });

  it("returns working for a stale assistant tool_use record when fileMtimeMs is fresh", () => {
    expect(
      classifyCursorJsonlState(
        [
          rec({
            role: "assistant",
            hasToolUse: true,
            timestampMs: NOW - CURSOR_JSONL_TOOL_USE_GRACE_MS - 1,
          }),
        ],
        NOW,
        NOW - 10_000,
      ),
    ).toBe("working");
  });

  it("returns waiting for a stale assistant tool_use record with stale fileMtimeMs", () => {
    expect(
      classifyCursorJsonlState(
        [
          rec({
            role: "assistant",
            hasToolUse: true,
            timestampMs: NOW - CURSOR_JSONL_TOOL_USE_GRACE_MS - 1,
          }),
        ],
        NOW,
        NOW - CURSOR_JSONL_TOOL_USE_GRACE_MS - 1,
      ),
    ).toBe("waiting");
  });

  it("returns waiting for a genuinely stale tool_use record even when it was just re-parsed with a fresh fallback timestamp (post-restart re-read)", () => {
    // Cursor JSONL never carries a real per-record timestamp, so a fresh reader
    // (e.g. right after a daemon restart resets the in-memory reader map) stamps
    // every re-read record with the current parse-time "now" as its timestampMs,
    // exactly like parseCursorJsonlRecord's fallbackTimestampMs does in production.
    // fileMtimeMs (the file's real last-write time) must win over that meaningless
    // "now" stamp, or staleness detection is defeated for up to a full grace window
    // after every restart.
    const line = JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "tool_use", name: "Shell", input: {} }] },
    });
    const record = parseCursorJsonlRecord(line, NOW);
    expect(record).toBeDefined();
    if (!record) {
      return;
    }
    expect(classifyCursorJsonlState([record], NOW, NOW - CURSOR_JSONL_TOOL_USE_GRACE_MS - 1)).toBe(
      "waiting",
    );
  });

  it("returns working when the last user record has tool_result", () => {
    expect(classifyCursorJsonlState([rec({ role: "user", hasToolResult: true })], NOW)).toBe(
      "working",
    );
  });

  it("returns waiting for a stale tool_result past the activity window", () => {
    expect(
      classifyCursorJsonlState(
        [rec({ role: "user", hasToolResult: true, timestampMs: NOW - 120_000 })],
        NOW,
      ),
    ).toBe("waiting");
  });

  it("returns waiting for a stale user prompt past the activity window", () => {
    expect(classifyCursorJsonlState([rec({ role: "user", timestampMs: NOW - 120_000 })], NOW)).toBe(
      "waiting",
    );
  });

  it("parses turn_ended error records for rate-limit detection", () => {
    const line = JSON.stringify({
      type: "turn_ended",
      status: "error",
      error:
        "Increase limits for faster responses You're out of usage. Switch to auto, Auto, or Composer 2.5, or ask your admin to increase your limit to continue.",
    });
    const record = parseCursorJsonlRecord(line, NOW);
    expect(record?.terminalError).toBe(true);
    expect(record?.text).toContain("out of usage");
    expect(detectCursorRateLimit(record?.text ?? null)).toEqual({
      limited: true,
      reason: "cursor out of usage",
    });
    expect(record).toBeDefined();
    if (!record) {
      return;
    }
    // classifyCursorJsonlState no longer does rate-limit string matching itself;
    // it maps every terminalError to "error". Rate-limit promotion to
    // "rate_limited" happens exclusively via detectCursorRateLimit, layered on
    // top by readCursorJsonlState / session-service.ts (see the full-pipeline
    // regression test below).
    expect(classifyCursorJsonlState([record], NOW)).toBe("error");
  });

  it("ignores rate-limit prose in normal assistant messages", () => {
    const prose = rec({
      role: "assistant",
      text: "The usage limit reached handler still needs tests.",
    });
    let terminalErrorText: string | null = null;
    for (let i = [prose].length - 1; i >= 0; i--) {
      const record = [prose][i];
      if (record?.terminalError && typeof record.text === "string" && record.text.length > 0) {
        terminalErrorText = record.text;
        break;
      }
    }
    expect(terminalErrorText).toBeNull();
  });
});

describe("parseCursorJsonlRecord text retention", () => {
  it("does not populate text on an ordinary assistant record with a message body", () => {
    const line = JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "text", text: "Here is a long assistant reply body." }] },
    });
    const record = parseCursorJsonlRecord(line, NOW);
    expect(record).toBeDefined();
    expect(record?.role).toBe("assistant");
    expect(record?.text).toBeUndefined();
  });

  it("still populates text on a turn_ended terminal-error record", () => {
    const line = JSON.stringify({
      type: "turn_ended",
      status: "error",
      error: "Rate limited: out of usage",
    });
    const record = parseCursorJsonlRecord(line, NOW);
    expect(record?.terminalError).toBe(true);
    expect(record?.text).toBe("Rate limited: out of usage");
  });

  it("still surfaces the terminal error text via latestCursorTerminalError-equivalent classification", () => {
    const ordinary = parseCursorJsonlRecord(
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "no error here" }] },
      }),
      NOW,
    );
    const errorLine = JSON.stringify({
      type: "turn_ended",
      status: "error",
      error: "Rate limited: out of usage",
    });
    const error = parseCursorJsonlRecord(errorLine, NOW);
    expect(ordinary).toBeDefined();
    expect(error).toBeDefined();
    if (!ordinary || !error) return;
    // classifyCursorJsonlState never reads `text`; the ordinary record's
    // missing text field must not change the classified state.
    expect(classifyCursorJsonlState([ordinary, error], NOW)).toBe("error");
  });

  it("classifies historical turn error followed by user message as working when recent", () => {
    const errorLine = JSON.stringify({
      type: "turn_ended",
      status: "error",
      error: "Rate limited: out of usage",
    });
    const error = parseCursorJsonlRecord(errorLine, NOW - 10_000);
    const userTurn = parseCursorJsonlRecord(
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "retry now" }] },
      }),
      NOW - 5_000,
    );
    expect(error).toBeDefined();
    expect(userTurn).toBeDefined();
    if (!error || !userTurn) return;

    expect(classifyCursorJsonlState([error, userTurn], NOW)).toBe("working");
  });

  it("classifies historical turn error followed by assistant final text as waiting", () => {
    const errorLine = JSON.stringify({
      type: "turn_ended",
      status: "error",
      error: "transport failure",
    });
    const error = parseCursorJsonlRecord(errorLine, NOW - 20_000);
    const assistantTurn = parseCursorJsonlRecord(
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "Task completed successfully." }] },
      }),
      NOW - 5_000,
    );
    expect(error).toBeDefined();
    expect(assistantTurn).toBeDefined();
    if (!error || !assistantTurn) return;

    expect(classifyCursorJsonlState([error, assistantTurn], NOW)).toBe("waiting");
  });
});

describe("Cursor JSONL fixtures", () => {
  it.each([
    ["working-tool-use.jsonl", "working"],
    ["working-tool-result.jsonl", "working"],
    ["waiting-final-text.jsonl", "waiting"],
    ["needs-input-ask-user.jsonl", "needs_input"],
    ["turn-ended-error.jsonl", "error"],
  ])("classifies %s as %s", async (fixture, expectedState) => {
    const content = await readFile(join(CURSOR_FIXTURES_DIR, fixture), "utf8");
    const records = parseFixture(content);
    expect(records.length).toBeGreaterThan(0);
    expect(classifyCursorJsonlState(records, NOW)).toBe(expectedState);
  });
});

// Real tail JSONL captured from four live sp-project Cursor sessions
// (spur-68fd, spur-6a5e, spur-4be1, spur-e5fc) that were shown stuck on
// needs_input after a generic transport failure killed the turn — no menu,
// no question, nothing for a human to answer. needs_input is reserved for
// genuine agent questions (AskUserQuestion, plan-approval, permission
// prompt); a dead transport is session-error evidence, so it must map to
// "error" instead.
describe("Cursor JSONL terminalError regression (real sp-project sessions)", () => {
  it.each([
    ["turn-ended-error-transport-canceled.jsonl", "http/2 stream closed with error code CANCEL"],
    ["turn-ended-error-writable-iterable-closed-1.jsonl", "WritableIterable is closed"],
    ["turn-ended-error-writable-iterable-closed-2.jsonl", "WritableIterable is closed"],
    ["turn-ended-error-writable-iterable-closed-3.jsonl", "WritableIterable is closed"],
  ])("classifies %s as error, not needs_input (%s)", async (fixture) => {
    const content = await readFile(join(CURSOR_FIXTURES_DIR, fixture), "utf8");
    const records = parseFixture(content);
    expect(records.length).toBeGreaterThan(0);
    const state = classifyCursorJsonlState(records, NOW);
    expect(state).toBe("error");
    expect(state).not.toBe("needs_input");
  });
});

// Last assistant JSONL lines captured from three real sp-project Cursor sessions
// that were observed stuck reporting "working" for 3.2-3.7 hours with zero live
// child processes (the bug this suite guards against). Extracted verbatim except
// for prompt/response text, which upstream already redacts to "[REDACTED]".
const LIVE_STALE_WORKING_LINES = [
  '{"role":"assistant","message":{"content":[{"type":"text","text":"[REDACTED]"},{"type":"tool_use","name":"Read","input":{"path":"/home/alek/projects/ao/v2/src/isolated-project-config.ts"}},{"type":"tool_use","name":"Read","input":{"limit":95,"offset":50,"path":"/home/alek/projects/ao/spur.yaml"}},{"type":"tool_use","name":"Read","input":{"limit":40,"offset":100,"path":"/home/alek/projects/ao/v2/test/fast/isolated-project-config.test.ts"}}]}}',
  '{"role":"assistant","message":{"content":[{"type":"text","text":"[REDACTED]"},{"type":"tool_use","name":"Grep","input":{"path":"/home/alek/projects/ao/packages/web/src/lib/types.ts","pattern":"ATTENTION_ZONE_ORDER","-A":5}}]}}',
  '{"role":"assistant","message":{"content":[{"type":"text","text":"[REDACTED]"},{"type":"tool_use","name":"Grep","input":{"path":"/home/alek/projects/ao/v2/test/fast/config.test.ts","pattern":"cursorBlock\\\\?\\\\.prompt|Review PR \\\\{\\\\{url\\\\}\\\\}"}},{"type":"tool_use","name":"Shell","input":{"command":"gh pr checks 520 --repo ashugaev/spur --watch 2>&1 | head -20","description":"Wait for Quality CI check result","block_until_ms":120000}}]}}',
];
const LIVE_STALE_GAP_MS = 3.2 * 60 * 60_000; // 3.2 hours, matching the shortest observed live stuck duration

describe("Cursor JSONL live stale-working regression (real sp-project sessions)", () => {
  it.each(LIVE_STALE_WORKING_LINES.map((line, index) => [index, line] as const))(
    "classifies fixture %i as waiting once the observed 3.2h+ live gap has passed",
    (_index, line) => {
      const baseTimestampMs = NOW;
      const record = parseCursorJsonlRecord(line, baseTimestampMs);
      expect(record).toBeDefined();
      if (!record) {
        return;
      }
      expect(record.role).toBe("assistant");
      expect(record.hasToolUse).toBe(true);
      expect(classifyCursorJsonlState([record], baseTimestampMs + LIVE_STALE_GAP_MS)).toBe(
        "waiting",
      );
    },
  );

  it("still classifies the same tool_use shape as working within the grace window", () => {
    const baseTimestampMs = NOW;
    const record = parseCursorJsonlRecord(LIVE_STALE_WORKING_LINES[0] ?? "", baseTimestampMs);
    expect(record).toBeDefined();
    if (!record) {
      return;
    }
    expect(classifyCursorJsonlState([record], baseTimestampMs + 10_000)).toBe("working");
  });
});

describe("findLatestCursorTranscriptFile", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("resolves the newest transcript under the encoded cursor project dir", async () => {
    const worktreePath = await mkdtemp(join(homedir(), "spur-cursor-jsonl-"));
    tempRoots.push(worktreePath);
    tempRoots.push(join(homedir(), ".cursor", "projects", toCursorProjectPath(worktreePath)));

    const transcriptsDir = join(
      homedir(),
      ".cursor",
      "projects",
      toCursorProjectPath(worktreePath),
      "agent-transcripts",
    );
    await mkdir(join(transcriptsDir, "older-chat"), { recursive: true });
    await mkdir(join(transcriptsDir, "newer-chat"), { recursive: true });
    await writeFile(
      join(transcriptsDir, "older-chat", "older-chat.jsonl"),
      '{"role":"assistant","message":{"content":[{"type":"text","text":"old"}]}}\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(
      join(transcriptsDir, "newer-chat", "newer-chat.jsonl"),
      '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]}}\n',
    );

    const filePath = await findLatestCursorTranscriptFile(worktreePath);
    expect(filePath).toBe(join(transcriptsDir, "newer-chat", "newer-chat.jsonl"));

    const state = await readCursorJsonlState(worktreePath);
    expect(state?.state).toBe("working");
    expect(state?.reader.filePath).toBe(filePath);
  });

  it("stamps a cold read with the file's mtime rather than the current wall clock", async () => {
    const worktreePath = await mkdtemp(join(homedir(), "spur-cursor-jsonl-cold-"));
    tempRoots.push(worktreePath);
    tempRoots.push(join(homedir(), ".cursor", "projects", toCursorProjectPath(worktreePath)));

    const transcriptsDir = join(
      homedir(),
      ".cursor",
      "projects",
      toCursorProjectPath(worktreePath),
      "agent-transcripts",
    );
    await mkdir(join(transcriptsDir, "old-chat"), { recursive: true });
    const transcriptPath = join(transcriptsDir, "old-chat", "old-chat.jsonl");
    await writeFile(
      transcriptPath,
      '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]}}\n',
    );
    const staleMtime = new Date(Date.now() - CURSOR_JSONL_TOOL_USE_GRACE_MS - 60_000);
    await utimes(transcriptPath, staleMtime, staleMtime);

    // First-ever read (no reader passed) must classify against the file's real
    // last-write time, not "now" — otherwise a long-stale backlog always looks fresh.
    const state = await readCursorJsonlState(worktreePath);
    expect(state?.state).toBe("waiting");
  });

  it("resolves pinned transcripts across symlinked worktree aliases", async () => {
    const root = await mkdtemp(join(homedir(), "spur-cursor-jsonl-alias-"));
    tempRoots.push(root);
    const canonical = join(root, "canonical");
    const alias = join(root, "alias");
    await mkdir(canonical);
    await symlink(canonical, alias);

    const agentSessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const canonicalTranscriptsDir = join(
      homedir(),
      ".cursor",
      "projects",
      toCursorProjectPath(canonical),
      "agent-transcripts",
    );
    const aliasTranscriptsDir = join(
      homedir(),
      ".cursor",
      "projects",
      toCursorProjectPath(alias),
      "agent-transcripts",
    );
    tempRoots.push(join(homedir(), ".cursor", "projects", toCursorProjectPath(canonical)));
    tempRoots.push(join(homedir(), ".cursor", "projects", toCursorProjectPath(alias)));

    await mkdir(join(aliasTranscriptsDir, "stale-chat"), { recursive: true });
    await writeFile(
      join(aliasTranscriptsDir, "stale-chat", "stale-chat.jsonl"),
      '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"AskUserQuestion","input":{}}]}}\n',
    );
    await mkdir(join(canonicalTranscriptsDir, agentSessionId), { recursive: true });
    await writeFile(
      join(canonicalTranscriptsDir, agentSessionId, `${agentSessionId}.jsonl`),
      '{"role":"assistant","message":{"content":[{"type":"text","text":"done"}]}}\n',
    );

    const filePath = await findLatestCursorTranscriptFile(alias, agentSessionId);
    expect(filePath).toBe(join(canonicalTranscriptsDir, agentSessionId, `${agentSessionId}.jsonl`));

    const state = await readCursorJsonlState(alias, undefined, agentSessionId);
    expect(state?.state).toBe("waiting");
    expect(state?.reader.filePath).toBe(filePath);
  });

  it("still surfaces rate_limited via detectCursorRateLimit end-to-end even though classifyCursorJsonlState now returns error for terminalError", async () => {
    // Regression control: classifyCursorJsonlState no longer distinguishes
    // rate-limit wording from any other terminalError (it always returns
    // "error"). Confirm the full readCursorJsonlState pipeline still detects
    // the rate limit independently via detectCursorRateLimit, so downstream
    // callers (session-service.ts) can still promote to "rate_limited".
    const worktreePath = await mkdtemp(join(homedir(), "spur-cursor-jsonl-ratelimit-"));
    tempRoots.push(worktreePath);
    tempRoots.push(join(homedir(), ".cursor", "projects", toCursorProjectPath(worktreePath)));

    const transcriptsDir = join(
      homedir(),
      ".cursor",
      "projects",
      toCursorProjectPath(worktreePath),
      "agent-transcripts",
    );
    await mkdir(join(transcriptsDir, "rate-limit-chat"), { recursive: true });
    await writeFile(
      join(transcriptsDir, "rate-limit-chat", "rate-limit-chat.jsonl"),
      `${JSON.stringify({
        type: "turn_ended",
        status: "error",
        error:
          "Increase limits for faster responses You're out of usage. Switch to auto, Auto, or Composer 2.5, or ask your admin to increase your limit to continue.",
      })}\n`,
    );

    const state = await readCursorJsonlState(worktreePath);
    expect(state?.state).toBe("error");
    expect(state?.rateLimit).toEqual({ limited: true, reason: "cursor out of usage" });
  });

  it("returns null for rateLimit when historical terminalError is followed by user turn", async () => {
    const worktreePath = await mkdtemp(join(homedir(), "spur-cursor-jsonl-historical-err-"));
    tempRoots.push(worktreePath);
    tempRoots.push(join(homedir(), ".cursor", "projects", toCursorProjectPath(worktreePath)));

    const transcriptsDir = join(
      homedir(),
      ".cursor",
      "projects",
      toCursorProjectPath(worktreePath),
      "agent-transcripts",
    );
    await mkdir(join(transcriptsDir, "chat-session"), { recursive: true });
    await writeFile(
      join(transcriptsDir, "chat-session", "chat-session.jsonl"),
      `${JSON.stringify({
        type: "turn_ended",
        status: "error",
        error: "Rate limited: out of usage",
      })}\n${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "continue work" }] },
      })}\n`,
    );

    const state = await readCursorJsonlState(worktreePath);
    expect(state?.state).toBe("working");
    expect(state?.rateLimit).toBeNull();
  });

  it("findLatestCursorTranscriptFile with minMtimeMs ignores transcripts modified before minMtimeMs", async () => {
    const worktreePath = await mkdtemp(join(homedir(), "spur-cursor-jsonl-min-mtime-"));
    tempRoots.push(worktreePath);
    tempRoots.push(join(homedir(), ".cursor", "projects", toCursorProjectPath(worktreePath)));

    const transcriptsDir = join(
      homedir(),
      ".cursor",
      "projects",
      toCursorProjectPath(worktreePath),
      "agent-transcripts",
    );
    await mkdir(join(transcriptsDir, "old-session"), { recursive: true });
    const oldPath = join(transcriptsDir, "old-session", "old-session.jsonl");
    await writeFile(
      oldPath,
      '{"role":"assistant","message":{"content":[{"type":"text","text":"old"}]}}\n',
    );
    const oldTime = new Date(1_000_000);
    await utimes(oldPath, oldTime, oldTime);

    const threshold = 2_000_000;
    const ignored = await findLatestCursorTranscriptFile(worktreePath, undefined, {
      minMtimeMs: threshold,
    });
    expect(ignored).toBeNull();

    await mkdir(join(transcriptsDir, "new-session"), { recursive: true });
    const newPath = join(transcriptsDir, "new-session", "new-session.jsonl");
    await writeFile(
      newPath,
      '{"role":"assistant","message":{"content":[{"type":"text","text":"new"}]}}\n',
    );
    const newTime = new Date(3_000_000);
    await utimes(newPath, newTime, newTime);

    const found = await findLatestCursorTranscriptFile(worktreePath, undefined, {
      minMtimeMs: threshold,
    });
    expect(found).toBe(newPath);
  });

  it("isolates transcript lookup in shared directory when agentSessionId is pinned", async () => {
    const worktreePath = await mkdtemp(join(homedir(), "spur-cursor-jsonl-pinned-"));
    tempRoots.push(worktreePath);
    tempRoots.push(join(homedir(), ".cursor", "projects", toCursorProjectPath(worktreePath)));

    const transcriptsDir = join(
      homedir(),
      ".cursor",
      "projects",
      toCursorProjectPath(worktreePath),
      "agent-transcripts",
    );
    const id1 = "11111111-1111-1111-1111-111111111111";
    const id2 = "22222222-2222-2222-2222-222222222222";

    await mkdir(join(transcriptsDir, id1), { recursive: true });
    const file1 = join(transcriptsDir, id1, `${id1}.jsonl`);
    await writeFile(
      file1,
      '{"role":"assistant","message":{"content":[{"type":"text","text":"session 1"}]}}\n',
    );
    const time1 = new Date(10_000_000);
    await utimes(file1, time1, time1);

    await mkdir(join(transcriptsDir, id2), { recursive: true });
    const file2 = join(transcriptsDir, id2, `${id2}.jsonl`);
    await writeFile(
      file2,
      '{"role":"assistant","message":{"content":[{"type":"text","text":"session 2"}]}}\n',
    );
    const time2 = new Date(20_000_000);
    await utimes(file2, time2, time2);

    // Default lookup without pinned id picks newest (file2)
    const latestUnpinned = await findLatestCursorTranscriptFile(worktreePath);
    expect(latestUnpinned).toBe(file2);

    // Pinned lookup for id1 returns file1 despite file2 being newer
    const pinned1 = await findLatestCursorTranscriptFile(worktreePath, id1);
    expect(pinned1).toBe(file1);
  });
});

describe("toCursorProjectPath", () => {
  // Expected slugs verified against real `~/.cursor/projects/<slug>` directories.
  it.each([
    // Slash-adjacent dot (`/.spur`) collapses with the slash into one hyphen.
    ["/home/alek/.spur/worktrees/sp/spur-e7e6", "home-alek-spur-worktrees-sp-spur-e7e6"],
    // Mid-segment dot (`daemon.xOPkB8`) becomes a hyphen — the regression: an
    // earlier version deleted the dot and pointed at a nonexistent project dir.
    [
      "/tmp/spur-isolated-daemon.xOPkB8/data/shepherd",
      "tmp-spur-isolated-daemon-xOPkB8-data-shepherd",
    ],
    // Consecutive separators (`/-`, `--`) collapse to a single hyphen.
    [
      "/tmp/claude-1001/-home-alek--spur/scratchpad/data/shepherd",
      "tmp-claude-1001-home-alek-spur-scratchpad-data-shepherd",
    ],
    // Underscores are kept verbatim — Cursor does not hyphenate them, and the
    // GitHub Actions runner path (`_work`) depends on it.
    [
      "/home/github-runner/actions-runner-3/_work/spur/spur-runtime-ab12/worktrees/test/rt-cursor-1",
      "home-github-runner-actions-runner-3-_work-spur-spur-runtime-ab12-worktrees-test-rt-cursor-1",
    ],
  ])("slugifies %s", (worktreePath, expected) => {
    expect(toCursorProjectPath(worktreePath)).toBe(expected);
  });
});

describe("readCursorTranscriptEntries", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function seedTranscript(worktreePath: string, fixtureName: string): Promise<void> {
    const content = await readFile(join(CURSOR_FIXTURES_DIR, fixtureName), "utf8");
    const transcriptsDir = join(
      homedir(),
      ".cursor",
      "projects",
      toCursorProjectPath(worktreePath),
      "agent-transcripts",
    );
    const chatDir = join(transcriptsDir, "chat");
    await mkdir(chatDir, { recursive: true });
    await writeFile(join(chatDir, "chat.jsonl"), content);
  }

  it("parses a tool entry (no callId) from a tool_use transcript", async () => {
    const worktreePath = await mkdtemp(join(homedir(), "spur-cursor-transcript-tool-"));
    tempRoots.push(worktreePath);
    tempRoots.push(join(homedir(), ".cursor", "projects", toCursorProjectPath(worktreePath)));
    await seedTranscript(worktreePath, "working-tool-use.jsonl");

    const entries = await readCursorTranscriptEntries(worktreePath);
    expect(entries).not.toBeNull();
    if (!entries) throw new Error("expected entries");

    const tool = entries.find((entry) => entry.kind === "tool");
    expect(tool).toEqual({ kind: "tool", name: "Grep" });
    expect(entries.map((entry) => entry.kind)).toEqual(["message", "message", "tool"]);
  });

  it("parses a question entry with options omitted from an AskUserQuestion transcript", async () => {
    const worktreePath = await mkdtemp(join(homedir(), "spur-cursor-transcript-question-"));
    tempRoots.push(worktreePath);
    tempRoots.push(join(homedir(), ".cursor", "projects", toCursorProjectPath(worktreePath)));
    await seedTranscript(worktreePath, "needs-input-ask-user.jsonl");

    const entries = await readCursorTranscriptEntries(worktreePath);
    expect(entries).not.toBeNull();
    if (!entries) throw new Error("expected entries");

    expect(entries).toEqual([{ kind: "question", header: "", prompt: "" }]);
    const question = entries[0];
    expect(question && "options" in question).toBe(false);
  });

  it("returns null when no transcript resolves", async () => {
    const worktreePath = await mkdtemp(join(homedir(), "spur-cursor-transcript-missing-"));
    tempRoots.push(worktreePath);

    const entries = await readCursorTranscriptEntries(worktreePath);
    expect(entries).toBeNull();
  });
});
