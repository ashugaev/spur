import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(
      classifyCursorJsonlState([rec({ role: "user", hasToolResult: true })], NOW),
    ).toBe("working");
  });

  it("returns waiting for a stale user prompt past the activity window", () => {
    expect(
      classifyCursorJsonlState([rec({ role: "user", timestampMs: NOW - 120_000 })], NOW),
    ).toBe("waiting");
  });
});

describe("Cursor JSONL fixtures", () => {
  it.each([
    ["working-tool-use.jsonl", "working"],
    ["working-tool-result.jsonl", "working"],
    ["waiting-final-text.jsonl", "waiting"],
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
    await writeFile(join(transcriptsDir, "older-chat", "older-chat.jsonl"), '{"role":"assistant","message":{"content":[{"type":"text","text":"old"}]}}\n');
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
});
