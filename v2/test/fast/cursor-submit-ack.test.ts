import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findLatestCursorTranscriptFileMock } = vi.hoisted(() => ({
  findLatestCursorTranscriptFileMock:
    vi.fn<(worktreePath: string, agentSessionId?: string) => Promise<string | null>>(),
}));

vi.mock("../../src/cursor-jsonl-state.js", () => ({
  findLatestCursorTranscriptFile: findLatestCursorTranscriptFileMock,
}));

import {
  captureCursorSubmitBaseline,
  scanCursorJsonlForMessage,
} from "../../src/agents/cursor-submit-ack.js";

const tempDirs: string[] = [];

beforeEach(() => {
  findLatestCursorTranscriptFileMock.mockReset();
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeJsonl(filename: string, lines: Array<Record<string, unknown>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cursor-submit-ack-"));
  tempDirs.push(root);
  const filePath = join(root, filename);
  const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(filePath, body, { encoding: "utf8", flag: "w" });
  return filePath;
}

async function appendJsonl(filePath: string, lines: Array<Record<string, unknown>>): Promise<void> {
  const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(filePath, body, { encoding: "utf8", flag: "a" });
}

function userTurn(text: string): Record<string, unknown> {
  return { role: "user", message: { content: [{ type: "text", text }] } };
}

describe("captureCursorSubmitBaseline", () => {
  it("returns null when no transcript exists", async () => {
    findLatestCursorTranscriptFileMock.mockResolvedValue(null);
    const result = await captureCursorSubmitBaseline("/tmp/worktree");
    expect(result).toBeNull();
  });

  it("returns the file path and current size when a transcript exists", async () => {
    const filePath = await makeJsonl("a.jsonl", [userTurn("hi")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    const result = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id");
    expect(result?.file).toBe(filePath);
    expect(result?.size).toBeGreaterThan(0);
    expect(findLatestCursorTranscriptFileMock).toHaveBeenCalledWith("/tmp/worktree", "pinned-id");
  });
});

describe("scanCursorJsonlForMessage", () => {
  it("forwards pinned agentSessionId to findLatestCursorTranscriptFile on rotation check", async () => {
    const filePath = await makeJsonl("init.jsonl", [userTurn("hi")]);
    const rotatedPath = await makeJsonl("rotated.jsonl", [userTurn("target")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(rotatedPath);
    const found = await scanCursorJsonlForMessage(
      { file: filePath, size: (await stat(filePath)).size },
      "target",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(found).toBe(true);
    expect(findLatestCursorTranscriptFileMock).toHaveBeenCalledWith("/tmp/worktree", "pinned-id");
  });
  it("matches a user turn that wraps the sent text in cursor context tags", async () => {
    const filePath = await makeJsonl("wrap.jsonl", []);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      userTurn("<timestamp>now</timestamp>\n<user_query>\nship the task\n</user_query>"),
    ]);
    const found = await scanCursorJsonlForMessage(
      { file: filePath, size: 0 },
      "ship the task",
      "/tmp/worktree",
    );
    expect(found).toBe(true);
  });

  it("ignores assistant turns whose text matches", async () => {
    const filePath = await makeJsonl("assistant.jsonl", []);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      { role: "assistant", message: { content: [{ type: "text", text: "ship the task" }] } },
    ]);
    const found = await scanCursorJsonlForMessage(
      { file: filePath, size: 0 },
      "ship the task",
      "/tmp/worktree",
    );
    expect(found).toBe(false);
  });

  it("ignores prior matching turns before the byte-offset baseline", async () => {
    const filePath = await makeJsonl("offset.jsonl", [userTurn("hi there")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    const baseline = { file: filePath, size: (await stat(filePath)).size };
    const found = await scanCursorJsonlForMessage(baseline, "hi there", "/tmp/worktree");
    expect(found).toBe(false);
  });

  it("finds a turn appended after the baseline", async () => {
    const filePath = await makeJsonl("append.jsonl", [userTurn("old turn")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    const baseline = { file: filePath, size: (await stat(filePath)).size };
    await appendJsonl(filePath, [userTurn("new turn")]);
    const found = await scanCursorJsonlForMessage(baseline, "new turn", "/tmp/worktree");
    expect(found).toBe(true);
  });

  it("scans a freshly rotated transcript from offset 0 when latest differs", async () => {
    const baselineFile = await makeJsonl("baseline.jsonl", [userTurn("old")]);
    const baseline = { file: baselineFile, size: (await stat(baselineFile)).size };
    const rotatedFile = await makeJsonl("rotated.jsonl", [userTurn("new")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(rotatedFile);
    const found = await scanCursorJsonlForMessage(baseline, "new", "/tmp/worktree");
    expect(found).toBe(true);
  });

  it("returns false for an empty target", async () => {
    const filePath = await makeJsonl("empty.jsonl", [userTurn("anything")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    const found = await scanCursorJsonlForMessage(
      { file: filePath, size: 0 },
      "   ",
      "/tmp/worktree",
    );
    expect(found).toBe(false);
  });

  it("matches long sends on the task prefix when slot instructions are omitted from the transcript", async () => {
    const taskPrefix = "Review PR https://github.com/example/repo/pull/1 for bugs.";
    const sentMessage = `${taskPrefix}\n\nSession metadata:\n- Set the session title once at task start`;
    const filePath = await makeJsonl("long.jsonl", []);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      userTurn(`<timestamp>now</timestamp>\n<user_query>\n${taskPrefix}\n</user_query>`),
    ]);
    const found = await scanCursorJsonlForMessage(
      { file: filePath, size: 0 },
      sentMessage,
      "/tmp/worktree",
    );
    expect(found).toBe(true);
  });
});
