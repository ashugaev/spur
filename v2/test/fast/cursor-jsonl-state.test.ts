import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectCursorRateLimit } from "../../src/rate-limit-detect.js";
import {
  classifyCursorJsonlState,
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

  it("returns working when the last user record has tool_result", () => {
    expect(classifyCursorJsonlState([rec({ role: "user", hasToolResult: true })], NOW)).toBe(
      "working",
    );
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
    expect(classifyCursorJsonlState([record], NOW)).toBe("waiting");
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
  ])("classifies %s as %s", async (fixture, expectedState) => {
    const content = await readFile(join(CURSOR_FIXTURES_DIR, fixture), "utf8");
    const records = parseFixture(content);
    expect(records.length).toBeGreaterThan(0);
    expect(classifyCursorJsonlState(records, NOW)).toBe(expectedState);
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
    expect(filePath).toBe(
      join(canonicalTranscriptsDir, agentSessionId, `${agentSessionId}.jsonl`),
    );

    const state = await readCursorJsonlState(alias, undefined, agentSessionId);
    expect(state?.state).toBe("waiting");
    expect(state?.reader.filePath).toBe(filePath);
  });
});
