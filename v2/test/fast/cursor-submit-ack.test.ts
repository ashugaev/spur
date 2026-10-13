import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type * as FsPromisesModule from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CursorJsonlStateModule from "../../src/cursor-jsonl-state.js";

const {
  findCursorAckTranscriptFileMock,
  resolveCursorPinnedTranscriptPathMock,
  findCursorSessionIdMock,
  statMock,
  realStatHolder,
} = vi.hoisted(() => ({
  findCursorAckTranscriptFileMock:
    vi.fn<(worktreePath: string, agentSessionId?: string) => Promise<string | null>>(),
  resolveCursorPinnedTranscriptPathMock:
    vi.fn<(worktreePath: string, agentSessionId: string) => Promise<string>>(),
  findCursorSessionIdMock:
    vi.fn<(worktreePath: string, options?: { configDir?: string }) => Promise<string | null>>(),
  statMock: vi.fn<(path: string) => Promise<unknown>>(),
  realStatHolder: { stat: undefined as undefined | ((path: string) => Promise<unknown>) },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>();
  realStatHolder.stat = actual.stat as unknown as (path: string) => Promise<unknown>;
  statMock.mockImplementation(realStatHolder.stat);
  return { ...actual, stat: statMock };
});

vi.mock("../../src/cursor-jsonl-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CursorJsonlStateModule>();
  return {
    findCursorAckTranscriptFile: findCursorAckTranscriptFileMock,
    resolveCursorPinnedTranscriptPath: resolveCursorPinnedTranscriptPathMock,
    readCursorStableOffset: actual.readCursorStableOffset,
  };
});

vi.mock("../../src/agents/cursor.js", () => ({
  findCursorSessionId: findCursorSessionIdMock,
}));

import { readSession, writeSession } from "../../src/metadata.js";
import { createTempDir } from "../helpers/common.js";
import {
  captureCursorSubmitBaseline,
  persistCursorSubmitBaseline,
  restoreCursorSubmitBaseline,
  scanCursorJsonlForMessage,
} from "../../src/agents/cursor-submit-ack.js";

const tempDirs: string[] = [];

beforeEach(() => {
  findCursorAckTranscriptFileMock.mockReset();
  resolveCursorPinnedTranscriptPathMock.mockReset();
  findCursorSessionIdMock.mockReset();
  statMock.mockReset();
  if (realStatHolder.stat) statMock.mockImplementation(realStatHolder.stat);
});

// Report `birthtimeMs` for `target` only; every other path stats for real.
function stubBirthtime(target: string, birthtimeMs: number): void {
  statMock.mockImplementation(async (path: string) => {
    const real = (await realStatHolder.stat?.(path)) as Record<string, unknown>;
    return path === target ? { ...real, birthtimeMs } : real;
  });
}

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
    const result = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id");
    expect(result?.file).toBe(filePath);
    expect(result?.size).toBeGreaterThan(0);
    expect(findCursorAckTranscriptFileMock).toHaveBeenCalledWith("/tmp/worktree", "pinned-id");
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
    expect(result).toEqual({ file: pendingPath, size: 0, capturedAtMs: expect.any(Number) });
  });

  it("stamps capturedAtMs within the capture window; persist and restore carry it only when set", async () => {
    const filePath = await makeJsonl("stamp.jsonl", [userTurn("hi")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(filePath);
    const before = Date.now();
    const result = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id");
    const after = Date.now();
    expect(result?.capturedAtMs).toBeGreaterThanOrEqual(before);
    expect(result?.capturedAtMs).toBeLessThanOrEqual(after);
    if (!result) return;
    const persisted = persistCursorSubmitBaseline(result);
    expect(persisted.capturedAtMs).toBe(result.capturedAtMs);
    expect(restoreCursorSubmitBaseline(persisted).capturedAtMs).toBe(result.capturedAtMs);
    const bare = restoreCursorSubmitBaseline({ file: filePath, size: 1 });
    expect("capturedAtMs" in bare).toBe(false);
    expect("capturedAtMs" in persistCursorSubmitBaseline(bare)).toBe(false);
  });

  it("still returns null with no id and nothing resolved (I3, unchanged)", async () => {
    findCursorAckTranscriptFileMock.mockResolvedValue(null);
    const result = await captureCursorSubmitBaseline("/tmp/worktree");
    expect(result).toBeNull();
    expect(resolveCursorPinnedTranscriptPathMock).not.toHaveBeenCalled();
  });
});

describe("scanCursorJsonlForMessage", () => {
  it("forwards pinned agentSessionId to findCursorAckTranscriptFile on rotation check", async () => {
    const filePath = await makeJsonl("init.jsonl", [userTurn("hi")]);
    const rotatedPath = await makeJsonl("rotated.jsonl", [userTurn("target")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(rotatedPath);
    const result = await scanCursorJsonlForMessage(
      { file: filePath, size: (await stat(filePath)).size },
      "target",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(result.found).toBe(true);
    expect(result.scannedFile).toBe(rotatedPath);
    expect(findCursorAckTranscriptFileMock).toHaveBeenCalledWith("/tmp/worktree", "pinned-id");
  });
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
    findCursorAckTranscriptFileMock.mockResolvedValue(filePath);
    const baseline = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id");
    if (!baseline) throw new Error("expected a baseline");
    await writeFile(
      filePath,
      [userTurn("old turn"), assistantOk, userTurn("new turn")]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
      "utf8",
    );

    const result = await scanCursorJsonlForMessage(baseline, "new turn", "/tmp/worktree");
    expect(result.found).toBe(true);
    const stale = await scanCursorJsonlForMessage(baseline, "old turn", "/tmp/worktree");
    expect(stale.found).toBe(false);
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
    expect(baseline).toEqual({ file: pendingPath, size: 0, capturedAtMs: expect.any(Number) });
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

    findCursorAckTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
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

    findCursorAckTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
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
  // because findCursorAckTranscriptFile also resolves back to baseline.file.
  it("falls through to the pinned-file re-resolve, and finds no rescan when both agree with the pin", async () => {
    const pinnedFile = await makeJsonl("pinned-2.jsonl", [userTurn("earlier turn")]);
    const baseline = { file: pinnedFile, size: (await stat(pinnedFile)).size };
    findCursorAckTranscriptFileMock.mockResolvedValue(pinnedFile);

    findCursorSessionIdMock.mockResolvedValue("pinned-id");
    const sameIdResult = await scanCursorJsonlForMessage(
      baseline,
      "never appears",
      "/tmp/worktree",
      "pinned-id",
      { cursorConfigDir: "/tmp/spur-data/cursor/session-1" },
    );
    expect(sameIdResult).toEqual({ found: false, scannedFile: pinnedFile });
    expect(findCursorAckTranscriptFileMock).toHaveBeenCalledWith("/tmp/worktree", "pinned-id");

    findCursorAckTranscriptFileMock.mockClear();
    findCursorSessionIdMock.mockResolvedValue(null);
    const noIdResult = await scanCursorJsonlForMessage(
      baseline,
      "never appears",
      "/tmp/worktree",
      "pinned-id",
      { cursorConfigDir: "/tmp/spur-data/cursor/session-1" },
    );
    expect(noIdResult).toEqual({ found: false, scannedFile: pinnedFile });
    expect(findCursorAckTranscriptFileMock).toHaveBeenCalledWith("/tmp/worktree", "pinned-id");
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
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
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
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
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
      capturedAtMs: expect.any(Number),
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
    findCursorAckTranscriptFileMock.mockResolvedValue(pinnedFile);
    findCursorSessionIdMock.mockResolvedValue("pinned-id");

    const live = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id", {
      cursorConfigDir: "/tmp/spur-data/cursor/session-1",
    });
    expect(live && persistCursorSubmitBaseline(live)).toEqual({
      file: pinnedFile,
      size: (await stat(pinnedFile)).size,
      capturedAtMs: expect.any(Number),
    });
  });
});

// #982: a rotated chat CREATED BY the send has the sent query as its first
// record, already below the first-sighting floor. Cursor records carry no
// timestamp, so the file's birthtime against the capture stamp decides.
describe("rotated chat created by the send (#982)", () => {
  const options = { cursorConfigDir: "/tmp/spur-data/cursor/session-1" };
  const stamp = 1_700_000_000_000;

  async function setup(rotatedTurns: Array<Record<string, unknown>>) {
    const pinnedFile = await makeJsonl("pinned-self.jsonl", [userTurn("earlier turn")]);
    const rotatedFile = await makeJsonl("rotated-self.jsonl", rotatedTurns);
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "rotated-id" ? rotatedFile : pinnedFile,
    );
    findCursorSessionIdMock.mockResolvedValue("rotated-id");
    const baseline = {
      file: pinnedFile,
      size: (await stat(pinnedFile)).size,
      capturedAtMs: stamp,
    };
    return { baseline, rotatedFile };
  }

  const scan = (baseline: Parameters<typeof scanCursorJsonlForMessage>[0], text: string) =>
    scanCursorJsonlForMessage(baseline, text, "/tmp/worktree", "pinned-id", options);

  it("acks on the first poll when the rotated chat was born after capture", async () => {
    const { baseline, rotatedFile } = await setup([userTurn("ship the task")]);
    stubBirthtime(rotatedFile, stamp + 5);
    expect(await scan(baseline, "ship the task")).toEqual({
      found: true,
      scannedFile: rotatedFile,
    });
  });

  it("keeps the floor for a rotated chat born before capture", async () => {
    const { baseline, rotatedFile } = await setup([userTurn("continue")]);
    stubBirthtime(rotatedFile, stamp - 5000);
    expect(await scan(baseline, "continue")).toEqual({ found: false, scannedFile: rotatedFile });
  });

  it("keeps the floor when birthtime is unknown (0), acking only a later turn", async () => {
    const { baseline, rotatedFile } = await setup([userTurn("ship the task")]);
    stubBirthtime(rotatedFile, 0);
    expect((await scan(baseline, "ship the task")).found).toBe(false);
    await appendJsonl(rotatedFile, [userTurn("ship the task")]);
    expect((await scan(baseline, "ship the task")).found).toBe(true);
  });

  it("keeps the floor for a sub-millisecond-later birthtime (floored to the stamp)", async () => {
    const { baseline, rotatedFile } = await setup([userTurn("continue")]);
    stubBirthtime(rotatedFile, stamp + 0.5);
    expect((await scan(baseline, "continue")).found).toBe(false);
  });

  it("keeps the floor when stat of the rotated file rejects", async () => {
    const { baseline, rotatedFile } = await setup([userTurn("continue")]);
    statMock.mockImplementation(async (path: string) => {
      if (path === rotatedFile) throw new Error("ENOENT");
      return realStatHolder.stat?.(path);
    });
    expect((await scan(baseline, "continue")).found).toBe(false);
  });

  it("keeps the floor for a legacy baseline without a stamp", async () => {
    const { baseline, rotatedFile } = await setup([userTurn("continue")]);
    stubBirthtime(rotatedFile, stamp + 5);
    const legacy = restoreCursorSubmitBaseline({ file: baseline.file, size: baseline.size });
    expect((await scan(legacy, "continue")).found).toBe(false);
  });

  it("survives capture, persist, JSON, session storage and restore", async () => {
    const pinnedFile = await makeJsonl("pinned-rt.jsonl", [userTurn("earlier turn")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(pinnedFile);
    findCursorSessionIdMock.mockResolvedValue(null);
    const live = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id", options);
    expect(live?.capturedAtMs).toEqual(expect.any(Number));
    if (!live) return;
    const persisted = JSON.parse(JSON.stringify(persistCursorSubmitBaseline(live))) as ReturnType<
      typeof persistCursorSubmitBaseline
    >;
    const dataDir = await createTempDir("spur-cursor-ack-");
    tempDirs.push(dataDir);
    writeSession(dataDir, {
      id: "api-1",
      project: "api",
      agent: "cursor",
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "cursor",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
      queuedMessageTyped: {
        message: "m",
        typedAt: "2026-03-18T10:00:30.000Z",
        ackBaseline: { agent: "cursor", ...persisted },
      },
    });
    const stored = readSession(dataDir, "api-1")?.queuedMessageTyped?.ackBaseline;
    expect(stored).toMatchObject({ agent: "cursor", capturedAtMs: live.capturedAtMs });
    if (stored?.agent !== "cursor") throw new Error("expected cursor baseline");
    const restored = restoreCursorSubmitBaseline(stored);

    // Cursor now rotates to a chat created by the send.
    const rotatedFile = await makeJsonl("rotated-rt.jsonl", [userTurn("ship the task")]);
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "rotated-id" ? rotatedFile : pinnedFile,
    );
    findCursorSessionIdMock.mockResolvedValue("rotated-id");
    stubBirthtime(rotatedFile, (live.capturedAtMs ?? 0) + 5);
    expect(await scan(restored, "ship the task")).toEqual({
      found: true,
      scannedFile: rotatedFile,
    });
  });
});
