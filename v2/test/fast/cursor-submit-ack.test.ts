import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findCursorAckTranscriptFileMock, resolveCursorPinnedTranscriptPathMock } = vi.hoisted(
  () => ({
    findCursorAckTranscriptFileMock:
      vi.fn<(worktreePath: string, agentSessionId?: string) => Promise<string | null>>(),
    resolveCursorPinnedTranscriptPathMock:
      vi.fn<(worktreePath: string, agentSessionId: string) => Promise<string>>(),
  }),
);

vi.mock("../../src/cursor-jsonl-state.js", () => ({
  findCursorAckTranscriptFile: findCursorAckTranscriptFileMock,
  resolveCursorPinnedTranscriptPath: resolveCursorPinnedTranscriptPathMock,
}));

import {
  captureCursorSubmitBaseline,
  scanCursorJsonlForMessage,
} from "../../src/agents/cursor-submit-ack.js";

const tempDirs: string[] = [];

beforeEach(() => {
  findCursorAckTranscriptFileMock.mockReset();
  resolveCursorPinnedTranscriptPathMock.mockReset();
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
  it("returns null when no transcript exists and no id is given", async () => {
    findCursorAckTranscriptFileMock.mockResolvedValue(null);
    const result = await captureCursorSubmitBaseline("/tmp/worktree");
    expect(result).toBeNull();
  });

  it("returns the file path and current size when a transcript exists", async () => {
    const filePath = await makeJsonl("a.jsonl", [userTurn("hi")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(filePath);
    const result = await captureCursorSubmitBaseline("/tmp/worktree");
    expect(result?.file).toBe(filePath);
    expect(result?.size).toBeGreaterThan(0);
  });

  // AC4: a pinned path that does not yet exist yields a WAITING baseline, never
  // null. session-service.ts:10468-10470 treats a null binding as an
  // unconditional un-waited "submitted", so a nonexistent-but-pinned baseline
  // must still make the caller wait.
  it("yields a waiting baseline for a pinned id whose transcript does not exist yet", async () => {
    findCursorAckTranscriptFileMock.mockResolvedValue(null);
    const pendingPath = "/tmp/x/some-id/some-id.jsonl";
    resolveCursorPinnedTranscriptPathMock.mockResolvedValue(pendingPath);
    const result = await captureCursorSubmitBaseline("/tmp/worktree", "some-id");
    expect(result).not.toBeNull();
    expect(result).toEqual({ file: pendingPath, size: 0 });
  });

  it("still returns null with no id and nothing resolved (I3, unchanged)", async () => {
    findCursorAckTranscriptFileMock.mockResolvedValue(null);
    const result = await captureCursorSubmitBaseline("/tmp/worktree");
    expect(result).toBeNull();
    expect(resolveCursorPinnedTranscriptPathMock).not.toHaveBeenCalled();
  });
});

describe("scanCursorJsonlForMessage", () => {
  it("matches a user turn that wraps the sent text in cursor context tags", async () => {
    const filePath = await makeJsonl("wrap.jsonl", []);
    findCursorAckTranscriptFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      userTurn("<timestamp>now</timestamp>\n<user_query>\nship the task\n</user_query>"),
    ]);
    const result = await scanCursorJsonlForMessage(
      { file: filePath, size: 0 },
      "ship the task",
      "/tmp/worktree",
    );
    expect(result.found).toBe(true);
  });

  it("ignores assistant turns whose text matches", async () => {
    const filePath = await makeJsonl("assistant.jsonl", []);
    findCursorAckTranscriptFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      { role: "assistant", message: { content: [{ type: "text", text: "ship the task" }] } },
    ]);
    const result = await scanCursorJsonlForMessage(
      { file: filePath, size: 0 },
      "ship the task",
      "/tmp/worktree",
    );
    expect(result.found).toBe(false);
  });

  it("ignores prior matching turns before the byte-offset baseline", async () => {
    const filePath = await makeJsonl("offset.jsonl", [userTurn("hi there")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(filePath);
    const baseline = { file: filePath, size: (await stat(filePath)).size };
    const result = await scanCursorJsonlForMessage(baseline, "hi there", "/tmp/worktree");
    expect(result.found).toBe(false);
  });

  it("finds a turn appended after the baseline", async () => {
    const filePath = await makeJsonl("append.jsonl", [userTurn("old turn")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(filePath);
    const baseline = { file: filePath, size: (await stat(filePath)).size };
    await appendJsonl(filePath, [userTurn("new turn")]);
    const result = await scanCursorJsonlForMessage(baseline, "new turn", "/tmp/worktree");
    expect(result.found).toBe(true);
    expect(result.scannedFile).toBe(filePath);
  });

  it("scans a freshly rotated transcript from offset 0 when latest differs", async () => {
    const baselineFile = await makeJsonl("baseline.jsonl", [userTurn("old")]);
    const baseline = { file: baselineFile, size: (await stat(baselineFile)).size };
    const rotatedFile = await makeJsonl("rotated.jsonl", [userTurn("new")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(rotatedFile);
    const result = await scanCursorJsonlForMessage(baseline, "new", "/tmp/worktree");
    expect(result.found).toBe(true);
    expect(result.scannedFile).toBe(rotatedFile);
  });

  it("returns false for an empty target", async () => {
    const filePath = await makeJsonl("empty.jsonl", [userTurn("anything")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(filePath);
    const result = await scanCursorJsonlForMessage(
      { file: filePath, size: 0 },
      "   ",
      "/tmp/worktree",
    );
    expect(result.found).toBe(false);
  });

  it("matches long sends on the task prefix when slot instructions are omitted from the transcript", async () => {
    const taskPrefix = "Review PR https://github.com/example/repo/pull/1 for bugs.";
    const sentMessage = `${taskPrefix}\n\nSession metadata:\n- Set the session title once at task start`;
    const filePath = await makeJsonl("long.jsonl", []);
    findCursorAckTranscriptFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      userTurn(`<timestamp>now</timestamp>\n<user_query>\n${taskPrefix}\n</user_query>`),
    ]);
    const result = await scanCursorJsonlForMessage(
      { file: filePath, size: 0 },
      sentMessage,
      "/tmp/worktree",
    );
    expect(result.found).toBe(true);
  });

  // AC5: a slow ack is still recognised — text absent at capture time, present
  // on a later poll of the SAME binding, no timers involved (poll-by-poll scan
  // is exactly what waitForSubmitAck does in session-service.ts).
  it("recognises an ack that lands only on a later poll of the same binding", async () => {
    const filePath = await makeJsonl("slow.jsonl", []);
    findCursorAckTranscriptFileMock.mockResolvedValue(filePath);
    const baseline = await captureCursorSubmitBaseline("/tmp/worktree");
    if (!baseline) throw new Error("expected a baseline");

    const firstPoll = await scanCursorJsonlForMessage(baseline, "slow turn", "/tmp/worktree");
    expect(firstPoll.found).toBe(false);

    await appendJsonl(filePath, [userTurn("slow turn")]);
    const secondPoll = await scanCursorJsonlForMessage(baseline, "slow turn", "/tmp/worktree");
    expect(secondPoll.found).toBe(true);
  });

  // AC5 pending-pin variant: capture happens before cursor has created the
  // transcript file at all (pinned path, size 0); the ack still lands once
  // cursor creates and writes it.
  it("recognises an ack that lands after a pending-pin baseline's file is created", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-submit-ack-pending-"));
    tempDirs.push(root);
    const pendingPath = join(root, "pending-id.jsonl");

    findCursorAckTranscriptFileMock.mockResolvedValue(null);
    resolveCursorPinnedTranscriptPathMock.mockResolvedValue(pendingPath);
    const baseline = await captureCursorSubmitBaseline("/tmp/worktree", "pending-id");
    expect(baseline).toEqual({ file: pendingPath, size: 0 });
    if (!baseline) throw new Error("expected a baseline");

    const firstPoll = await scanCursorJsonlForMessage(baseline, "pending turn", "/tmp/worktree");
    expect(firstPoll.found).toBe(false);

    await writeFile(pendingPath, `${JSON.stringify(userTurn("pending turn"))}\n`, {
      encoding: "utf8",
      flag: "w",
    });
    const secondPoll = await scanCursorJsonlForMessage(baseline, "pending turn", "/tmp/worktree");
    expect(secondPoll.found).toBe(true);
  });
});
