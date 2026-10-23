import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CursorJsonlStateModule from "../../src/cursor-jsonl-state.js";

const {
  findLatestCursorTranscriptFileMock,
  resolveCursorPinnedTranscriptPathMock,
  findCursorSessionIdMock,
} = vi.hoisted(() => ({
  findLatestCursorTranscriptFileMock:
    vi.fn<(worktreePath: string, agentSessionId: string) => Promise<string | null>>(),
  resolveCursorPinnedTranscriptPathMock:
    vi.fn<(worktreePath: string, agentSessionId: string) => Promise<string>>(),
  findCursorSessionIdMock:
    vi.fn<(worktreePath: string, options?: { configDir?: string }) => Promise<string | null>>(),
}));

vi.mock("../../src/cursor-jsonl-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CursorJsonlStateModule>();
  return {
    cursorChatIdFromTranscriptPath: actual.cursorChatIdFromTranscriptPath,
    findLatestCursorTranscriptFile: findLatestCursorTranscriptFileMock,
    resolveCursorPinnedTranscriptPath: resolveCursorPinnedTranscriptPathMock,
    readCursorStableOffset: actual.readCursorStableOffset,
  };
});

vi.mock("../../src/agents/cursor.js", () => ({
  findCursorSessionId: findCursorSessionIdMock,
}));

import {
  captureCursorSubmitBaseline,
  persistCursorSubmitBaseline,
  restoreCursorSubmitBaseline,
  scanCursorJsonlForMessage,
} from "../../src/agents/cursor-submit-ack.js";

const tempDirs: string[] = [];

beforeEach(() => {
  findLatestCursorTranscriptFileMock.mockReset();
  resolveCursorPinnedTranscriptPathMock.mockReset();
  findCursorSessionIdMock.mockReset();
});

afterEach(async () => {
  // N7: the ack never asks the shared transcripts dir for "the newest" chat.
  for (const call of findLatestCursorTranscriptFileMock.mock.calls) {
    expect(typeof call[1]).toBe("string");
  }
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
  // AC7
  it("returns null with no id and no cursorConfigDir, without any transcript lookup", async () => {
    const result = await captureCursorSubmitBaseline("/tmp/worktree");
    expect(result).toBeNull();
    expect(findLatestCursorTranscriptFileMock).not.toHaveBeenCalled();
    expect(findCursorSessionIdMock).not.toHaveBeenCalled();
  });

  // AC1
  it("no-id capture pins the private-dir chat id", async () => {
    const filePath = await makeJsonl("chat-x.jsonl", [userTurn("hi")]);
    findCursorSessionIdMock.mockResolvedValue("chat-x");
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    const result = await captureCursorSubmitBaseline("/tmp/worktree", undefined, {
      cursorConfigDir: "/tmp/spur-data/cursor/session-1",
    });
    expect(result?.file).toBe(filePath);
    expect(result?.size).toBeGreaterThan(0);
    expect(findCursorSessionIdMock).toHaveBeenCalledWith("/tmp/worktree", {
      configDir: "/tmp/spur-data/cursor/session-1",
    });
    expect(findLatestCursorTranscriptFileMock).toHaveBeenCalledWith("/tmp/worktree", "chat-x");
  });

  // AC2
  it("no-id capture with no chat yields a pending baseline", async () => {
    findCursorSessionIdMock.mockResolvedValue(null);
    const result = await captureCursorSubmitBaseline("/tmp/worktree", undefined, {
      cursorConfigDir: "/tmp/spur-data/cursor/session-1",
    });
    expect(result).toEqual({ file: null, size: 0 });
    expect(findLatestCursorTranscriptFileMock).not.toHaveBeenCalled();
  });

  it("returns the file path and current size when a transcript exists", async () => {
    const filePath = await makeJsonl("a.jsonl", [userTurn("hi")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    const result = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id");
    expect(result?.file).toBe(filePath);
    expect(result?.size).toBeGreaterThan(0);
    expect(findLatestCursorTranscriptFileMock).toHaveBeenCalledWith("/tmp/worktree", "pinned-id");
  });

  // AC4: a pinned path that does not yet exist yields a WAITING baseline, never
  // null. session-service.ts:10468-10470 treats a null binding as an
  // unconditional un-waited "submitted", so a nonexistent-but-pinned baseline
  // must still make the caller wait.
  it("yields a waiting baseline for a pinned id whose transcript does not exist yet", async () => {
    findLatestCursorTranscriptFileMock.mockResolvedValue(null);
    const pendingPath = "/tmp/x/some-id/some-id.jsonl";
    resolveCursorPinnedTranscriptPathMock.mockResolvedValue(pendingPath);
    const result = await captureCursorSubmitBaseline("/tmp/worktree", "some-id");
    expect(result).not.toBeNull();
    expect(result).toEqual({ file: pendingPath, size: 0 });
  });
});

describe("scanCursorJsonlForMessage", () => {
  it("forwards pinned agentSessionId to findLatestCursorTranscriptFile on rotation check", async () => {
    const filePath = await makeJsonl("init.jsonl", [userTurn("hi")]);
    const rotatedPath = await makeJsonl("rotated.jsonl", [userTurn("target")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(rotatedPath);
    const result = await scanCursorJsonlForMessage(
      { file: filePath, size: (await stat(filePath)).size },
      "target",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(result.found).toBe(true);
    expect(result.scannedFile).toBe(rotatedPath);
    expect(findLatestCursorTranscriptFileMock).toHaveBeenCalledWith("/tmp/worktree", "pinned-id");
  });
  it("matches a user turn that wraps the sent text in cursor context tags", async () => {
    const filePath = await makeJsonl("wrap.jsonl", []);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      userTurn("<timestamp>now</timestamp>\n<user_query>\nship the task\n</user_query>"),
    ]);
    const result = await scanCursorJsonlForMessage(
      { file: filePath, size: 0 },
      "ship the task",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(result.found).toBe(true);
  });

  it("ignores assistant turns whose text matches", async () => {
    const filePath = await makeJsonl("assistant.jsonl", []);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      { role: "assistant", message: { content: [{ type: "text", text: "ship the task" }] } },
    ]);
    const result = await scanCursorJsonlForMessage(
      { file: filePath, size: 0 },
      "ship the task",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(result.found).toBe(false);
  });

  it("ignores prior matching turns before the byte-offset baseline", async () => {
    const filePath = await makeJsonl("offset.jsonl", [userTurn("hi there")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    const baseline = { file: filePath, size: (await stat(filePath)).size };
    const result = await scanCursorJsonlForMessage(
      baseline,
      "hi there",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(result.found).toBe(false);
  });

  it("finds a turn appended after the baseline", async () => {
    const filePath = await makeJsonl("append.jsonl", [userTurn("old turn")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    const baseline = { file: filePath, size: (await stat(filePath)).size };
    await appendJsonl(filePath, [userTurn("new turn")]);
    const result = await scanCursorJsonlForMessage(
      baseline,
      "new turn",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(result.found).toBe(true);
    expect(result.scannedFile).toBe(filePath);
  });

  // Cursor rewrites the transcript on submit: the trailing turn_ended line is
  // dropped and the new user turn appended, so the new turn starts before the
  // pre-send file size.
  it("acks a turn cursor wrote by rewriting away the trailing turn_ended line", async () => {
    const turnEnded = { type: "turn_ended", status: "success" };
    const assistantOk = { role: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
    const filePath = await makeJsonl("rewrite.jsonl", [
      userTurn("old turn"),
      assistantOk,
      turnEnded,
    ]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    const baseline = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id");
    if (!baseline) throw new Error("expected a baseline");
    await writeFile(
      filePath,
      [userTurn("old turn"), assistantOk, userTurn("new turn")]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
      "utf8",
    );

    const result = await scanCursorJsonlForMessage(
      baseline,
      "new turn",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(result.found).toBe(true);
    const stale = await scanCursorJsonlForMessage(
      baseline,
      "old turn",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(stale.found).toBe(false);
  });

  it("rescans the pinned file found under another candidate from offset 0", async () => {
    const baselineFile = await makeJsonl("baseline.jsonl", [userTurn("old")]);
    const baseline = { file: baselineFile, size: (await stat(baselineFile)).size };
    const rotatedFile = await makeJsonl("rotated.jsonl", [userTurn("new")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(rotatedFile);
    const result = await scanCursorJsonlForMessage(baseline, "new", "/tmp/worktree", "pinned-id");
    expect(result.found).toBe(true);
    expect(result.scannedFile).toBe(rotatedFile);
  });

  it("returns false for an empty target", async () => {
    const filePath = await makeJsonl("empty.jsonl", [userTurn("anything")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    const result = await scanCursorJsonlForMessage(
      { file: filePath, size: 0 },
      "   ",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(result.found).toBe(false);
  });

  // AC10
  it("empty target on a pending baseline reports no scanned file", async () => {
    const result = await scanCursorJsonlForMessage(
      { file: null, size: 0 },
      "   ",
      "/tmp/worktree",
      undefined,
      { cursorConfigDir: "/tmp/spur-data/cursor/session-1" },
    );
    expect(result).toEqual({ found: false, scannedFile: null });
    expect(findCursorSessionIdMock).not.toHaveBeenCalled();
  });

  it("matches long sends on the task prefix when slot instructions are omitted from the transcript", async () => {
    const taskPrefix = "Review PR https://github.com/example/repo/pull/1 for bugs.";
    const sentMessage = `${taskPrefix}\n\nSession metadata:\n- Set the session title once at task start`;
    const filePath = await makeJsonl("long.jsonl", []);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      userTurn(`<timestamp>now</timestamp>\n<user_query>\n${taskPrefix}\n</user_query>`),
    ]);
    const result = await scanCursorJsonlForMessage(
      { file: filePath, size: 0 },
      sentMessage,
      "/tmp/worktree",
      "pinned-id",
    );
    expect(result.found).toBe(true);
  });

  // AC5: a slow ack is still recognised — text absent at capture time, present
  // on a later poll of the SAME binding, no timers involved (poll-by-poll scan
  // is exactly what waitForSubmitAck does in session-service.ts).
  it("recognises an ack that lands only on a later poll of the same binding", async () => {
    const filePath = await makeJsonl("slow.jsonl", []);
    findLatestCursorTranscriptFileMock.mockResolvedValue(filePath);
    const baseline = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id");
    if (!baseline) throw new Error("expected a baseline");

    const firstPoll = await scanCursorJsonlForMessage(
      baseline,
      "slow turn",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(firstPoll.found).toBe(false);

    await appendJsonl(filePath, [userTurn("slow turn")]);
    const secondPoll = await scanCursorJsonlForMessage(
      baseline,
      "slow turn",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(secondPoll.found).toBe(true);
  });

  // AC5 pending-pin variant: capture happens before cursor has created the
  // transcript file at all (pinned path, size 0); the ack still lands once
  // cursor creates and writes it.
  it("recognises an ack that lands after a pending-pin baseline's file is created", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-submit-ack-pending-"));
    tempDirs.push(root);
    const pendingPath = join(root, "pending-id.jsonl");

    findLatestCursorTranscriptFileMock.mockResolvedValue(null);
    resolveCursorPinnedTranscriptPathMock.mockResolvedValue(pendingPath);
    const baseline = await captureCursorSubmitBaseline("/tmp/worktree", "pending-id");
    expect(baseline).toEqual({ file: pendingPath, size: 0 });
    if (!baseline) throw new Error("expected a baseline");

    const firstPoll = await scanCursorJsonlForMessage(
      baseline,
      "pending turn",
      "/tmp/worktree",
      "pending-id",
    );
    expect(firstPoll.found).toBe(false);

    await writeFile(pendingPath, `${JSON.stringify(userTurn("pending turn"))}\n`, {
      encoding: "utf8",
      flag: "w",
    });
    const secondPoll = await scanCursorJsonlForMessage(
      baseline,
      "pending turn",
      "/tmp/worktree",
      "pending-id",
    );
    expect(secondPoll.found).toBe(true);
  });

  // AC5 (true-positive path only — see the false-positive regression test
  // below): cursor rotated its chat id mid-session; the pinned transcript
  // stays stale forever, so re-resolve the current id from the
  // session-private config dir and scan the rotated transcript. The target
  // text is appended AFTER this binding first observes the rotated file, so
  // it lands on the second poll of the same binding, never the first.
  it("acks via the re-resolved chat id when the pinned transcript is stale", async () => {
    const pinnedFile = await makeJsonl("pinned.jsonl", [userTurn("earlier turn")]);
    const rotatedFile = await makeJsonl("rotated-chat.jsonl", [userTurn("unrelated prior turn")]);
    const baseline = { file: pinnedFile, size: (await stat(pinnedFile)).size };

    findLatestCursorTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "rotated-id" ? rotatedFile : pinnedFile,
    );
    findCursorSessionIdMock.mockResolvedValue("rotated-id");

    const firstPoll = await scanCursorJsonlForMessage(
      baseline,
      "ship the task",
      "/tmp/worktree",
      "pinned-id",
      { cursorConfigDir: "/tmp/spur-data/cursor/session-1" },
    );
    expect(findCursorSessionIdMock).toHaveBeenCalledWith("/tmp/worktree", {
      configDir: "/tmp/spur-data/cursor/session-1",
    });
    expect(firstPoll.found).toBe(false);

    await appendJsonl(rotatedFile, [userTurn("ship the task")]);
    const secondPoll = await scanCursorJsonlForMessage(
      baseline,
      "ship the task",
      "/tmp/worktree",
      "pinned-id",
      { cursorConfigDir: "/tmp/spur-data/cursor/session-1" },
    );
    expect(secondPoll.found).toBe(true);
    expect(secondPoll.scannedFile).toBe(rotatedFile);
  });

  // Regression (false-positive ack, human review on PR #979): the rotated
  // transcript already contains an earlier, unrelated turn with the exact
  // sent text BEFORE this binding ever sees it (e.g. a repeated wake prompt
  // or a short "continue" from a prior send in the same rotated chat).
  // Cursor's substring match must not let that pre-existing turn count as
  // this send's ack.
  it("does not ack on a pre-existing rotated-chat turn that matches the sent text (PR #979)", async () => {
    const pinnedFile = await makeJsonl("pinned-preexisting.jsonl", [userTurn("earlier turn")]);
    const rotatedFile = await makeJsonl("rotated-preexisting.jsonl", [userTurn("continue")]);
    const baseline = { file: pinnedFile, size: (await stat(pinnedFile)).size };

    findLatestCursorTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "rotated-id" ? rotatedFile : pinnedFile,
    );
    findCursorSessionIdMock.mockResolvedValue("rotated-id");

    const result = await scanCursorJsonlForMessage(
      baseline,
      "continue",
      "/tmp/worktree",
      "pinned-id",
      { cursorConfigDir: "/tmp/spur-data/cursor/session-1" },
    );

    expect(result.found).toBe(false);
    expect(result.scannedFile).toBe(rotatedFile);
  });

  // AC6: the re-resolved id equals the pin, or resolves to nothing — no extra
  // file is scanned, result stays bound to the baseline file.
  // AC6 (revised): when the re-resolved chat id equals the pin or is
  // unavailable, no chat-id rotation happened, but the pre-existing
  // pinned-file re-resolve still runs (composed, not short-circuited) — it
  // covers a symlinked worktree's different candidate-path resolution, a
  // separate axis from chat-id rotation. Both compose to "no rescan" here
  // because findLatestCursorTranscriptFile also resolves back to baseline.file.
  it("falls through to the pinned-file re-resolve, and finds no rescan when both agree with the pin", async () => {
    const pinnedFile = await makeJsonl("pinned-2.jsonl", [userTurn("earlier turn")]);
    const baseline = { file: pinnedFile, size: (await stat(pinnedFile)).size };
    findLatestCursorTranscriptFileMock.mockResolvedValue(pinnedFile);

    findCursorSessionIdMock.mockResolvedValue("pinned-id");
    const sameIdResult = await scanCursorJsonlForMessage(
      baseline,
      "never appears",
      "/tmp/worktree",
      "pinned-id",
      { cursorConfigDir: "/tmp/spur-data/cursor/session-1" },
    );
    expect(sameIdResult).toEqual({ found: false, scannedFile: pinnedFile });
    expect(findLatestCursorTranscriptFileMock).toHaveBeenCalledWith("/tmp/worktree", "pinned-id");

    findLatestCursorTranscriptFileMock.mockClear();
    findCursorSessionIdMock.mockResolvedValue(null);
    const noIdResult = await scanCursorJsonlForMessage(
      baseline,
      "never appears",
      "/tmp/worktree",
      "pinned-id",
      { cursorConfigDir: "/tmp/spur-data/cursor/session-1" },
    );
    expect(noIdResult).toEqual({ found: false, scannedFile: pinnedFile });
    expect(findLatestCursorTranscriptFileMock).toHaveBeenCalledWith("/tmp/worktree", "pinned-id");
  });

  // Regression: a symlinked worktree resolves to two candidates. The WAITING
  // baseline is built from the LAST candidate (cursor-jsonl-state.ts:155-156)
  // while findLatestCursorTranscriptFile returns the FIRST candidate whose
  // pinned file actually exists (cursor-jsonl-state.ts:100-107). No chat-id
  // rotation happens here (findCursorSessionId agrees with the pin), so the
  // fix must fall through to the pre-existing pinned-file re-resolve instead
  // of returning found:false as soon as the chat-id check is done.
  it("acks a pinned file written under a different worktree-path candidate with no chat-id rotation", async () => {
    const staleWaitingPath = "/tmp/worktree-symlink/last-candidate/pinned-id.jsonl";
    const actualPinnedFile = await makeJsonl("first-candidate.jsonl", []);
    await appendJsonl(actualPinnedFile, [userTurn("ship the task")]);
    const baseline = { file: staleWaitingPath, size: 0 };

    findCursorSessionIdMock.mockResolvedValue("pinned-id");
    findLatestCursorTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "pinned-id" ? actualPinnedFile : null,
    );

    const result = await scanCursorJsonlForMessage(
      baseline,
      "ship the task",
      "/tmp/worktree",
      "pinned-id",
      { cursorConfigDir: "/tmp/spur-data/cursor/session-1" },
    );

    expect(result).toEqual({ found: true, scannedFile: actualPinnedFile });
  });
});

describe("cursor submit baseline across a restart", () => {
  it("offsets an already-rotated chat at send time and keeps that offset through persist and restore", async () => {
    const pinnedFile = await makeJsonl("pinned-restart.jsonl", [userTurn("earlier turn")]);
    const rotatedFile = await makeJsonl("rotated-restart.jsonl", [userTurn("continue")]);
    findLatestCursorTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "rotated-id" ? rotatedFile : pinnedFile,
    );
    findCursorSessionIdMock.mockResolvedValue("rotated-id");
    const options = { cursorConfigDir: "/tmp/spur-data/cursor/session-1" };

    const live = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id", options);
    expect(live).not.toBeNull();
    if (!live) return;
    const rotatedSize = (await stat(rotatedFile)).size;
    const persisted = JSON.parse(JSON.stringify(persistCursorSubmitBaseline(live))) as ReturnType<
      typeof persistCursorSubmitBaseline
    >;
    expect(persisted).toEqual({
      file: pinnedFile,
      size: (await stat(pinnedFile)).size,
      rotated: { file: rotatedFile, size: rotatedSize },
    });

    // Cursor writes the sent turn to the rotated chat, then the daemon restarts.
    await appendJsonl(rotatedFile, [userTurn("continue")]);
    const restored = restoreCursorSubmitBaseline(persisted);
    const result = await scanCursorJsonlForMessage(
      restored,
      "continue",
      "/tmp/worktree",
      "pinned-id",
      options,
    );
    expect(result).toEqual({ found: true, scannedFile: rotatedFile });

    // The pre-send "continue" alone never acks from the send-time offset.
    const beforeSend = restoreCursorSubmitBaseline({
      ...persisted,
      rotated: { file: rotatedFile, size: rotatedSize + 1_000 },
    });
    expect(
      (
        await scanCursorJsonlForMessage(
          beforeSend,
          "continue",
          "/tmp/worktree",
          "pinned-id",
          options,
        )
      ).found,
    ).toBe(false);
  });

  it("persists no rotation when the chat id matches the pin", async () => {
    const pinnedFile = await makeJsonl("pinned-norotate.jsonl", [userTurn("earlier turn")]);
    findLatestCursorTranscriptFileMock.mockResolvedValue(pinnedFile);
    findCursorSessionIdMock.mockResolvedValue("pinned-id");

    const live = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id", {
      cursorConfigDir: "/tmp/spur-data/cursor/session-1",
    });
    expect(live && persistCursorSubmitBaseline(live)).toEqual({
      file: pinnedFile,
      size: (await stat(pinnedFile)).size,
    });
  });
});

describe("no-id cursor submit ack (#889)", () => {
  const options = { cursorConfigDir: "/tmp/spur-data/cursor/session-1" };

  // AC3
  it("no-id send never acks on a newer peer transcript", async () => {
    const peerFile = await makeJsonl("peer-id.jsonl", [userTurn("ship the task")]);
    findCursorSessionIdMock.mockResolvedValue(null);
    findLatestCursorTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "peer-id" ? peerFile : null,
    );

    const baseline = await captureCursorSubmitBaseline("/tmp/worktree", undefined, options);
    expect(baseline).toEqual({ file: null, size: 0 });
    if (!baseline) return;
    const result = await scanCursorJsonlForMessage(
      baseline,
      "ship the task",
      "/tmp/worktree",
      undefined,
      options,
    );
    expect(result).toEqual({ found: false, scannedFile: null });
    expect(baseline.file).toBeNull();
  });

  // AC4
  it("pending baseline acks the own chat's first record on a later poll", async () => {
    const ownFile = await makeJsonl("own-id.jsonl", [userTurn("ship the task")]);
    findCursorSessionIdMock.mockResolvedValue(null);
    findLatestCursorTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "own-id" ? ownFile : null,
    );
    const baseline = { file: null as string | null, size: 0 };

    const firstPoll = await scanCursorJsonlForMessage(
      baseline,
      "ship the task",
      "/tmp/worktree",
      undefined,
      options,
    );
    expect(firstPoll).toEqual({ found: false, scannedFile: null });

    findCursorSessionIdMock.mockResolvedValue("own-id");
    const secondPoll = await scanCursorJsonlForMessage(
      baseline,
      "ship the task",
      "/tmp/worktree",
      undefined,
      options,
    );
    expect(secondPoll).toEqual({ found: true, scannedFile: ownFile });
    expect(baseline).toEqual({ file: ownFile, size: 0 });
  });

  // AC9
  it("resumed pending baseline with a pinned ctx id acks the own chat from offset 0", async () => {
    const ownFile = await makeJsonl("own-id.jsonl", [userTurn("ship the task")]);
    findLatestCursorTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "own-id" ? ownFile : null,
    );
    const restored = restoreCursorSubmitBaseline({ file: null, size: 0 });

    const result = await scanCursorJsonlForMessage(
      restored,
      "ship the task",
      "/tmp/worktree",
      "own-id",
      options,
    );
    expect(result).toEqual({ found: true, scannedFile: ownFile });
    expect(findCursorSessionIdMock).not.toHaveBeenCalled();
  });

  it("scans the private-dir chat, not a newer peer transcript that holds the text", async () => {
    const ownFile = await makeJsonl("own-id.jsonl", [userTurn("earlier turn")]);
    const peerFile = await makeJsonl("peer-id.jsonl", [userTurn("ship the task")]);
    findCursorSessionIdMock.mockResolvedValue("own-id");
    findLatestCursorTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "peer-id" ? peerFile : ownFile,
    );

    const baseline = await captureCursorSubmitBaseline("/tmp/worktree", undefined, options);
    expect(baseline?.file).toBe(ownFile);
    if (!baseline) return;
    const result = await scanCursorJsonlForMessage(
      baseline,
      "ship the task",
      "/tmp/worktree",
      undefined,
      options,
    );
    expect(result).toEqual({ found: false, scannedFile: ownFile });
    for (const call of findLatestCursorTranscriptFileMock.mock.calls) {
      expect(call[1]).toBe("own-id");
    }
  });

  it("keeps a pending baseline untouched over repeated empty polls", async () => {
    findCursorSessionIdMock.mockResolvedValue(null);
    const baseline = { file: null as string | null, size: 0 };
    for (let poll = 0; poll < 3; poll++) {
      const result = await scanCursorJsonlForMessage(
        baseline,
        "ship the task",
        "/tmp/worktree",
        undefined,
        options,
      );
      expect(result).toEqual({ found: false, scannedFile: null });
    }
    expect(baseline).toEqual({ file: null, size: 0 });
    expect(findLatestCursorTranscriptFileMock).not.toHaveBeenCalled();
  });

  // AC5
  it("pending baseline survives persist and restore", async () => {
    const ownFile = await makeJsonl("own-id.jsonl", [userTurn("ship the task")]);
    findCursorSessionIdMock.mockResolvedValue("own-id");
    findLatestCursorTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "own-id" ? ownFile : null,
    );
    const persisted = persistCursorSubmitBaseline({ file: null, size: 0 });
    expect(persisted).toEqual({ file: null, size: 0 });

    const restored = restoreCursorSubmitBaseline(
      JSON.parse(JSON.stringify(persisted)) as typeof persisted,
    );
    const result = await scanCursorJsonlForMessage(
      restored,
      "ship the task",
      "/tmp/worktree",
      undefined,
      options,
    );
    expect(result).toEqual({ found: true, scannedFile: ownFile });
  });

  // AC6
  it("no-id baseline keeps the rotation floor after a chat rotation", async () => {
    const chatX = await makeJsonl("x-id.jsonl", [userTurn("earlier turn")]);
    const chatY = await makeJsonl("y-id.jsonl", [userTurn("continue")]);
    findLatestCursorTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "y-id" ? chatY : chatX,
    );
    findCursorSessionIdMock.mockResolvedValue("x-id");
    const baseline = await captureCursorSubmitBaseline("/tmp/worktree", undefined, options);
    expect(baseline?.file).toBe(chatX);
    if (!baseline) return;

    findCursorSessionIdMock.mockResolvedValue("y-id");
    const result = await scanCursorJsonlForMessage(
      baseline,
      "continue",
      "/tmp/worktree",
      undefined,
      options,
    );
    expect(result).toEqual({ found: false, scannedFile: chatY });
  });
});
