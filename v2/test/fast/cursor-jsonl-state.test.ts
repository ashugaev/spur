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

  it("returns needs_input when the last record is a turn_ended error", async () => {
    const records = parseFixture(
      await readFile(join(CURSOR_FIXTURES_DIR, "turn-ended-error.jsonl"), "utf8"),
    );
    expect(records.length).toBe(1);
    expect(classifyCursorJsonlState(records, NOW)).toBe("needs_input");
  });

  it("drops a non-error turn_ended record (no error field)", () => {
    const record = parseCursorJsonlRecord('{"type":"turn_ended","status":"completed"}', NOW);
    expect(record).toBeNull();
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
    expect(classifyCursorJsonlState([record], NOW)).toBe("needs_input");
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

describe("Cursor JSONL fixtures", () => {
  it.each([
    ["working-tool-use.jsonl", "working"],
    ["working-tool-result.jsonl", "working"],
    ["waiting-final-text.jsonl", "waiting"],
    ["needs-input-ask-user.jsonl", "needs_input"],
    ["turn-ended-error.jsonl", "needs_input"],
  ])("classifies %s as %s", async (fixture, expectedState) => {
    const content = await readFile(join(CURSOR_FIXTURES_DIR, fixture), "utf8");
    const records = parseFixture(content);
    expect(records.length).toBeGreaterThan(0);
    expect(classifyCursorJsonlState(records, NOW)).toBe(expectedState);
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
});
