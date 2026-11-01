import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CursorJsonlStateModule from "../../src/cursor-jsonl-state.js";
import type * as CursorModule from "../../src/agents/cursor.js";

const {
  findLatestCursorTranscriptFileMock,
  findCursorAckTranscriptFileMock,
  resolveCursorPinnedTranscriptPathMock,
  findCursorSessionIdMock,
  stableReadFault,
} = vi.hoisted(() => {
  const findLatest =
    vi.fn<(worktreePath: string, agentSessionId: string) => Promise<string | null>>();
  return {
    findLatestCursorTranscriptFileMock: findLatest,
    findCursorAckTranscriptFileMock: findLatest,
    resolveCursorPinnedTranscriptPathMock:
      vi.fn<(worktreePath: string, agentSessionId: string) => Promise<string>>(),
    findCursorSessionIdMock:
      vi.fn<(worktreePath: string, options?: { configDir?: string }) => Promise<string | null>>(),
    stableReadFault: { file: "", armed: false, calls: [] as string[] },
  };
});

vi.mock("../../src/cursor-jsonl-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CursorJsonlStateModule>();
  return {
    ...actual,
    cursorChatIdFromTranscriptPath: actual.cursorChatIdFromTranscriptPath,
    findCursorAckTranscriptFile: findCursorAckTranscriptFileMock,
    findLatestCursorTranscriptFile: findLatestCursorTranscriptFileMock,
    resolveCursorPinnedTranscriptPath: resolveCursorPinnedTranscriptPathMock,
    readCursorStableOffset: async (file: string) => {
      if (stableReadFault.armed && file === stableReadFault.file) {
        stableReadFault.armed = false;
        stableReadFault.calls.push(file);
        throw new Error("owned fixture one-shot stable read failure");
      }
      return actual.readCursorStableOffset(file);
    },
  };
});

vi.mock("../../src/agents/cursor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CursorModule>()),
  findCursorSessionId: findCursorSessionIdMock,
}));

import { readSession, writeSession } from "../../src/metadata.js";
import { createTempDir } from "../helpers/common.js";
import * as cursorAck from "../../src/agents/cursor-submit-ack.js";
import {
  createAgentSubmitAckBinding,
  resumeAgentSubmitAckBinding,
  type AgentSubmitAckContext,
  type SubmitAckBinding,
} from "../../src/agents/index.js";
import {
  captureCursorSubmitBaseline,
  cursorDeliveryInput,
  markCursorWriteStart,
  persistCursorSubmitBaseline,
  restoreCursorSubmitBaseline,
  scanCursorJsonlForMessage,
} from "../../src/agents/cursor-submit-ack.js";

const tempDirs: string[] = [];

beforeEach(() => {
  findLatestCursorTranscriptFileMock.mockReset();
  resolveCursorPinnedTranscriptPathMock.mockReset();
  findCursorSessionIdMock.mockReset();
  stableReadFault.armed = false;
  stableReadFault.file = "";
  stableReadFault.calls = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
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

async function resumeStoredBinding(binding: SubmitAckBinding, ctx: AgentSubmitAckContext) {
  const dataDir = await createTempDir("spur-binding-store-");
  tempDirs.push(dataDir);
  writeSession(dataDir, {
    id: "fixture",
    project: "fixture",
    agent: "cursor",
    prompt: "continue",
    branch: "feature/test",
    worktree: true,
    worktreePath: ctx.worktreePath,
    tmuxSession: "fixture",
    launchCommand: "cursor",
    status: "running",
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:00:00.000Z",
    queuedMessageTyped: {
      message: "continue",
      typedAt: "2026-03-18T10:00:00.000Z",
      ackBaseline: binding.baseline,
    },
  });
  const stored = readSession(dataDir, "fixture")?.queuedMessageTyped?.ackBaseline;
  if (!stored || stored.agent !== "cursor") throw new Error("missing stored Cursor binding");
  const resumed = await resumeAgentSubmitAckBinding("cursor", ctx, stored);
  if (!resumed) throw new Error("missing resumed Cursor binding");
  return { stored, resumed };
}

describe("correlated source boundary evidence", () => {
  it("C2 binding persistence / C2 proof gap: measures F0 and scan-only F1 separately", async () => {
    const pinned = await makeJsonl("pinned.jsonl", [userTurn("continue old")]);
    const known = await makeJsonl("known.jsonl", [userTurn("continue old")]);
    const selected = await makeJsonl("selected.jsonl", [userTurn("continue old")]);
    const files = new Map([
      ["pinned", pinned],
      ["known", known],
      ["selected", selected],
    ]);
    findCursorAckTranscriptFileMock.mockImplementation(
      async (_worktree, id) => files.get(id ?? "") ?? null,
    );
    findCursorSessionIdMock.mockResolvedValue("pinned");
    const ctx = {
      worktreePath: dirname(pinned),
      codexSessionsDir: dirname(pinned),
      agentSessionId: "pinned",
      cursorConfigDir: dirname(pinned),
      message: "continue",
    };
    const binding = await createAgentSubmitAckBinding("cursor", ctx);
    if (!binding || binding.baseline.agent !== "cursor" || !binding.inputText)
      throw new Error("missing real correlated binding");
    const captureFloor = binding.baseline.size;
    const captureDeliveryId = binding.baseline.deliveryId;
    expect(captureDeliveryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(binding.inputText).toBe(cursorDeliveryInput(captureDeliveryId ?? "", "continue"));
    expect(captureFloor).toBeGreaterThan(0);
    await appendJsonl(pinned, [userTurn("continue old before hook")]);
    findCursorSessionIdMock.mockResolvedValue("known");
    await binding.markWriteStart?.();
    const f0 = structuredClone(binding.baseline);
    expect(f0.size).toBe((await stat(pinned)).size);
    expect(f0.size).toBeGreaterThan(captureFloor);
    expect(f0.rotated).toEqual({ file: known, size: (await stat(known)).size });
    expect(f0.rotated?.size).toBeGreaterThan(0);
    expect(f0.deliveryId).toBe(captureDeliveryId);
    const scanSpy = vi.spyOn(cursorAck, "scanCursorJsonlForMessage");
    findCursorSessionIdMock.mockResolvedValue("selected");
    let syntheticCurrentRecordWrites = 0;
    expect(await binding.scan("continue")).toEqual({ found: false, lastScannedFile: selected });
    const live = scanSpy.mock.calls[0]?.[0];
    if (!live) throw new Error("real scanner did not run");
    const f1 = live.rotationOffsets?.get(selected);
    expect(f1).toBe((await stat(selected)).size);
    const { stored, resumed } = await resumeStoredBinding(binding, ctx);
    for (const value of [binding.baseline, stored, resumed.baseline]) expect(value).toEqual(f0);
    expect((await resumed.scan("continue")).found).toBe(false);
    expect(scanSpy.mock.calls.at(-1)?.[0].rotationOffsets?.get(selected)).toBe(f1);
    expect(syntheticCurrentRecordWrites).toBe(0);
    await appendJsonl(selected, [userTurn(binding.inputText)]);
    syntheticCurrentRecordWrites++;
    expect((await binding.scan("continue")).found).toBe(true);
    expect((await resumed.scan("continue")).found).toBe(true);
    const after = await resumeStoredBinding(binding, ctx);
    expect(after.stored).toEqual(f0);
    expect(after.resumed.baseline).toEqual(f0);
    expect((await after.resumed.scan("continue")).found).toBe(true);
    expect(syntheticCurrentRecordWrites).toBe(1);
    expect(live.rotationOffsets?.get(selected)).toBe(f1);
  });

  async function oldThenCurrent(
    binding: SubmitAckBinding,
    ctx: AgentSubmitAckContext,
    file: string,
  ) {
    if (!binding.inputText) throw new Error("missing actual binding input");
    const { stored, resumed } = await resumeStoredBinding(binding, ctx);
    expect(stored).toEqual(binding.baseline);
    expect(resumed.baseline).toEqual(binding.baseline);
    let syntheticCurrentRecordWrites = 0;
    for (const current of [binding, resumed]) {
      expect(await current.scan("continue")).toEqual({ found: false, lastScannedFile: file });
    }
    expect(syntheticCurrentRecordWrites).toBe(0);
    await appendJsonl(file, [userTurn(binding.inputText)]);
    syntheticCurrentRecordWrites++;
    for (const current of [binding, resumed])
      expect((await current.scan("continue")).found).toBe(true);
    expect(syntheticCurrentRecordWrites).toBe(1);
    expect(resumed.baseline).toEqual(binding.baseline);
  }

  it.each([false, true])("C1 proof gap: alternate pinned (%s)", async (privateConfig) => {
    const alternate = await makeJsonl("alternate.jsonl", [userTurn("continue old")]);
    const missing = alternate + ".unresolved";
    findCursorAckTranscriptFileMock.mockResolvedValueOnce(null).mockResolvedValue(alternate);
    resolveCursorPinnedTranscriptPathMock.mockResolvedValue(missing);
    findCursorSessionIdMock.mockResolvedValue("pinned");
    const ctx = {
      worktreePath: dirname(alternate),
      codexSessionsDir: dirname(alternate),
      agentSessionId: "pinned",
      message: "continue",
      ...(privateConfig ? { cursorConfigDir: dirname(alternate) } : {}),
    };
    const binding = await createAgentSubmitAckBinding("cursor", ctx);
    if (!binding || binding.baseline.agent !== "cursor") throw new Error("missing binding");
    expect(binding.baseline.file).toBe(missing);
    await binding.markWriteStart?.();
    await oldThenCurrent(binding, ctx, alternate);
  });

  it.each(["pinned", "rotated"])("C3 proof gap: failed %s refresh", async (mode) => {
    const pinned = await makeJsonl("pinned-read.jsonl", [userTurn("unrelated")]);
    const rotated = await makeJsonl("rotated-read.jsonl", [userTurn("unrelated")]);
    findCursorAckTranscriptFileMock.mockImplementation(async (_path, id) =>
      id === "rotated" ? rotated : pinned,
    );
    findCursorSessionIdMock.mockResolvedValue(mode === "rotated" ? "rotated" : "pinned");
    const ctx = {
      worktreePath: dirname(pinned),
      codexSessionsDir: dirname(pinned),
      agentSessionId: "pinned",
      cursorConfigDir: dirname(pinned),
      message: "continue",
    };
    const binding = await createAgentSubmitAckBinding("cursor", ctx);
    if (!binding || binding.baseline.agent !== "cursor") throw new Error("missing binding");
    const captured = structuredClone(binding.baseline);
    const file = mode === "rotated" ? rotated : pinned;
    const floor = mode === "rotated" ? captured.rotated?.size : captured.size;
    expect(floor).toBeGreaterThan(0);
    const old = JSON.stringify(userTurn("continue old complete")) + "\n";
    await writeFile(file, old, { flag: "a" });
    expect(await readFile(file, "utf8")).toContain(old);
    expect((await stat(file)).size).toBeGreaterThan(floor ?? 0);
    stableReadFault.file = file;
    stableReadFault.armed = true;
    try {
      await binding.markWriteStart?.();
      expect(stableReadFault.calls).toEqual([file]);
      expect(stableReadFault.armed).toBe(false);
      expect(binding.baseline).toEqual(captured);
      expect(await readFile(file, "utf8")).toContain(old);
      await oldThenCurrent(binding, ctx, file);
    } finally {
      stableReadFault.armed = false;
      stableReadFault.file = "";
    }
  });

  it.each(["pinned", "rotated"])("C4 proof gap: old partial %s", async (mode) => {
    const pinned = await makeJsonl("pinned-partial.jsonl", [userTurn("unrelated")]);
    const rotated = await makeJsonl("rotated-partial.jsonl", [userTurn("unrelated")]);
    const file = mode === "rotated" ? rotated : pinned;
    const floor = (await stat(file)).size;
    const old = JSON.stringify(userTurn("continue old partial"));
    await writeFile(file, old.slice(0, -5), { flag: "a" });
    findCursorAckTranscriptFileMock.mockImplementation(async (_path, id) =>
      id === "rotated" ? rotated : pinned,
    );
    findCursorSessionIdMock.mockResolvedValue(mode === "rotated" ? "rotated" : "pinned");
    const ctx = {
      worktreePath: dirname(pinned),
      codexSessionsDir: dirname(pinned),
      agentSessionId: "pinned",
      cursorConfigDir: dirname(pinned),
      message: "continue",
    };
    const binding = await createAgentSubmitAckBinding("cursor", ctx);
    if (!binding || binding.baseline.agent !== "cursor") throw new Error("missing binding");
    await binding.markWriteStart?.();
    const beforeCompletion = structuredClone(binding.baseline);
    expect(mode === "rotated" ? beforeCompletion.rotated?.size : beforeCompletion.size).toBe(floor);
    expect(floor).toBeGreaterThan(0);
    await writeFile(file, old.slice(-5) + "\n", { flag: "a" });
    expect(await readFile(file, "utf8")).toContain(old + "\n");
    await oldThenCurrent(binding, ctx, file);
    expect(binding.baseline).toEqual(beforeCompletion);
  });
});

describe("captureCursorSubmitBaseline", () => {
  it.each([false, true])("Q1/Q1b: live and restored first query, no-ID=%s", async (noId) => {
    const deliveryId = "a1111111-1111-4111-8111-111111111111";
    const file = await makeJsonl("first-correlated.jsonl", []);
    const pinnedFile = await makeJsonl("original-pinned.jsonl", []);
    findCursorAckTranscriptFileMock.mockResolvedValue(null);
    resolveCursorPinnedTranscriptPathMock.mockResolvedValue(pinnedFile);
    findCursorSessionIdMock.mockResolvedValue(null);
    const options = { cursorConfigDir: "/owned/config", deliveryId };
    const sessionId = noId ? undefined : "pinned";
    const baseline = await captureCursorSubmitBaseline("/owned/worktree", sessionId, options);
    if (!baseline) throw new Error("missing correlated baseline");
    expect(baseline.file).toBe(noId ? null : pinnedFile);
    const persisted = persistCursorSubmitBaseline(baseline);
    await markCursorWriteStart(baseline, persisted, "/owned/worktree", sessionId, options);
    const dataDir = await createTempDir("spur-correlated-restore-");
    tempDirs.push(dataDir);
    writeSession(dataDir, {
      id: "api-1",
      project: "api",
      agent: "cursor",
      prompt: "ship café",
      branch: "feature/test",
      worktree: true,
      worktreePath: "/owned/worktree",
      tmuxSession: "api-1",
      launchCommand: "cursor",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:00:00.000Z",
      queuedMessageTyped: {
        message: "ship café",
        typedAt: "2026-03-18T10:00:00.000Z",
        ackBaseline: { agent: "cursor", ...persisted },
      },
    });
    const stored = readSession(dataDir, "api-1")?.queuedMessageTyped?.ackBaseline;
    if (stored?.agent !== "cursor") throw new Error("missing restored correlated baseline");
    const input = cursorDeliveryInput(deliveryId, "ship café");
    // Owned source fixture models exactly one submitted user record; no native claim.
    await appendJsonl(file, [userTurn(`<user_query>\n${input}\n</user_query>`)]);
    findCursorAckTranscriptFileMock.mockResolvedValue(file);
    findCursorSessionIdMock.mockResolvedValue("new-chat");
    for (const current of [baseline, restoreCursorSubmitBaseline(stored)]) {
      const result = await scanCursorJsonlForMessage(
        current,
        "ship café",
        "/owned/worktree",
        sessionId,
        options,
      );
      expect(result.found).toBe(true);
      expect(noId ? current.file === file : (current.rotationOffsets?.get(file) ?? 0) > 0).toBe(
        true,
      );
    }
  });

  it("Q2/Q3b: rejects stale, wrong, split and non-user identities before accepting the current submission", async () => {
    const deliveryId = "a1111111-1111-4111-8111-111111111111";
    const priorId = "b2222222-2222-4222-8222-222222222222";
    const file = await makeJsonl("correlation-negatives.jsonl", [userTurn("ship café")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(file);
    findCursorSessionIdMock.mockResolvedValue("pinned");
    const options = { cursorConfigDir: "/owned/config", deliveryId };
    const baseline = await captureCursorSubmitBaseline("/owned/worktree", "pinned", options);
    if (!baseline) throw new Error("missing baseline");
    const persisted = persistCursorSubmitBaseline(baseline);
    await appendJsonl(file, [userTurn("ship café")]);
    await markCursorWriteStart(baseline, persisted, "/owned/worktree", "pinned", options);
    const rotated = await makeJsonl("new-rotation.jsonl", [
      userTurn("ship café"),
      userTurn(cursorDeliveryInput(priorId, "ship café")),
      { ...userTurn(cursorDeliveryInput(deliveryId, "ship café")), role: "assistant" },
      userTurn(`[Spur delivery: ${deliveryId}]`),
      userTurn("ship café"),
      userTurn(`[Spur delivery: ${deliveryId.slice(0, -1)}]\n\nship café`),
    ]);
    findCursorSessionIdMock.mockResolvedValue("rotated");
    findCursorAckTranscriptFileMock.mockImplementation(async (_path, id) =>
      id === "rotated" ? rotated : file,
    );
    let submissions = 0;
    for (const current of [baseline, restoreCursorSubmitBaseline(persisted)]) {
      const result = await scanCursorJsonlForMessage(
        current,
        "ship café",
        "/owned/worktree",
        "pinned",
        options,
      );
      expect(result.found).toBe(false);
    }
    expect(submissions).toBe(0);
    submissions++;
    await appendJsonl(rotated, [userTurn(cursorDeliveryInput(deliveryId, "ship café"))]);
    expect(submissions).toBe(1);
    const restored = restoreCursorSubmitBaseline(persisted);
    const result = await scanCursorJsonlForMessage(
      restored,
      "ship café",
      "/owned/worktree",
      "pinned",
      options,
    );
    expect(result.found).toBe(true);
  });

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
  // null. the `!binding` branch in session-service.ts treats a null
  // binding as an unconditional un-waited "submitted", so a nonexistent-but-pinned baseline
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
  const options = { cursorConfigDir: "/tmp/spur-data/cursor/session-1" };

  async function restoreStoredBaseline(persisted: ReturnType<typeof persistCursorSubmitBaseline>) {
    const dataDir = await createTempDir("spur-cursor-ack-");
    tempDirs.push(dataDir);
    writeSession(dataDir, {
      id: "api-1",
      project: "api",
      agent: "cursor",
      prompt: "ship it",
      branch: "feature/cursor-ack",
      worktree: true,
      worktreePath: "/tmp/worktree",
      tmuxSession: "api-1",
      launchCommand: "cursor",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:00:00.000Z",
      queuedMessageTyped: {
        message: "continue",
        typedAt: "2026-03-18T10:00:00.000Z",
        ackBaseline: { agent: "cursor", ...persisted },
      },
    });
    const session = readSession(dataDir, "api-1");
    if (!session?.queuedMessageTyped) throw new Error("expected typed marker");
    // Obsolete PR-only input must drop without erasing either saved floor.
    await writeFile(
      join(dataDir, "sessions", "api", "api-1.json"),
      JSON.stringify({
        ...session,
        queuedMessageTyped: {
          ...session.queuedMessageTyped,
          ackBaseline: { agent: "cursor", ...persisted, writeStartedAtMs: 123 },
        },
      }),
    );
    const stored = readSession(dataDir, "api-1")?.queuedMessageTyped?.ackBaseline;
    expect(stored).toEqual({ agent: "cursor", ...persisted });
    if (stored?.agent !== "cursor") throw new Error("expected cursor baseline");
    return restoreCursorSubmitBaseline(stored);
  }

  it("refreshes the pinned prewrite floor before submission", async () => {
    const file = await makeJsonl("pinned-prewrite.jsonl", [userTurn("unrelated")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(file);
    findCursorSessionIdMock.mockResolvedValue("pinned-id");
    const live = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id", options);
    if (!live) throw new Error("expected baseline");
    const capturedFloor = live.size;
    const persisted = persistCursorSubmitBaseline(live);
    await appendJsonl(file, [userTurn("continue old query")]);
    const refreshedFloor = (await stat(file)).size;
    await markCursorWriteStart(live, persisted, "/tmp/worktree", "pinned-id", options);
    const scan = (baseline: typeof live) =>
      scanCursorJsonlForMessage(baseline, "continue", "/tmp/worktree", "pinned-id", options);
    expect((await scan(live)).found).toBe(false);
    expect(refreshedFloor).toBeGreaterThan(capturedFloor);
    expect(live.size).toBe(refreshedFloor);
    expect(persisted.size).toBe(refreshedFloor);
    const restored = await restoreStoredBaseline(JSON.parse(JSON.stringify(persisted)));
    expect((await scan(restored)).found).toBe(false);
    await appendJsonl(file, [userTurn("continue new query")]);
    expect((await scan(live)).found).toBe(true);
    expect((await scan(restored)).found).toBe(true);
    expect(live.size).toBe(refreshedFloor);
  });

  it("refreshes a known rotated prewrite floor before submission", async () => {
    const pinned = await makeJsonl("pinned-known.jsonl", [userTurn("unrelated")]);
    const rotated = await makeJsonl("rotated-known.jsonl", [userTurn("unrelated")]);
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktree, id) =>
      id === "rotated-id" ? rotated : pinned,
    );
    findCursorSessionIdMock.mockResolvedValue("rotated-id");
    const live = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id", options);
    if (!live) throw new Error("expected baseline");
    const capturedFloor = live.rotationOffsets?.get(rotated);
    const persisted = persistCursorSubmitBaseline(live);
    await appendJsonl(rotated, [userTurn("continue old query")]);
    const refreshedFloor = (await stat(rotated)).size;
    await markCursorWriteStart(live, persisted, "/tmp/worktree", "pinned-id", options);
    const scan = (baseline: typeof live) =>
      scanCursorJsonlForMessage(baseline, "continue", "/tmp/worktree", "pinned-id", options);
    expect((await scan(live)).found).toBe(false);
    expect(refreshedFloor).toBeGreaterThan(capturedFloor ?? 0);
    expect(live.rotationOffsets?.get(rotated)).toBe(refreshedFloor);
    expect(persisted.rotated).toEqual({ file: rotated, size: refreshedFloor });
    const restored = await restoreStoredBaseline(JSON.parse(JSON.stringify(persisted)));
    expect((await scan(restored)).found).toBe(false);
    await appendJsonl(rotated, [userTurn("continue new query")]);
    expect((await scan(live)).found).toBe(true);
    expect((await scan(restored)).found).toBe(true);
    expect(live.rotationOffsets?.get(rotated)).toBe(refreshedFloor);
  });

  it("persists the current rotation when an older map entry comes first", async () => {
    const pinned = await makeJsonl("pinned-multiple.jsonl", [userTurn("unrelated")]);
    const older = await makeJsonl("older-rotation.jsonl", [userTurn("unrelated")]);
    const current = await makeJsonl("current-rotation.jsonl", [userTurn("unrelated")]);
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktree, id) =>
      id === "older-id" ? older : id === "current-id" ? current : pinned,
    );
    findCursorSessionIdMock.mockResolvedValue("older-id");
    const live = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id", options);
    if (!live) throw new Error("expected baseline");
    const olderFloor = live.rotationOffsets?.get(older);
    findCursorSessionIdMock.mockResolvedValue("current-id");
    const scan = (baseline: typeof live) =>
      scanCursorJsonlForMessage(baseline, "continue", "/tmp/worktree", "pinned-id", options);
    expect((await scan(live)).found).toBe(false);
    expect([...(live.rotationOffsets?.keys() ?? [])]).toEqual([older, current]);
    const persisted = persistCursorSubmitBaseline(live);
    await appendJsonl(current, [userTurn("continue old query")]);
    const refreshedFloor = (await stat(current)).size;
    await markCursorWriteStart(live, persisted, "/tmp/worktree", "pinned-id", options);
    expect(persisted.rotated).toEqual({ file: current, size: refreshedFloor });
    expect(live.rotationOffsets?.get(older)).toBe(olderFloor);
    expect((await scan(live)).found).toBe(false);
    const restored = await restoreStoredBaseline(JSON.parse(JSON.stringify(persisted)));
    expect(restored.rotationOffsets?.get(current)).toBe(refreshedFloor);
    expect((await scan(restored)).found).toBe(false);
    await appendJsonl(current, [userTurn("continue new query")]);
    expect((await scan(live)).found).toBe(true);
    expect((await scan(restored)).found).toBe(true);
  });

  it("refreshes the pinned floor without a session id or private config", async () => {
    const file = await makeJsonl("unpinned-prewrite.jsonl", [userTurn("unrelated")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(file);
    findCursorSessionIdMock.mockResolvedValue("unpinned-chat");
    const live = await captureCursorSubmitBaseline("/tmp/worktree", undefined, options);
    if (!live) throw new Error("expected baseline");
    const persisted = persistCursorSubmitBaseline(live);
    await appendJsonl(file, [userTurn("continue old query")]);
    await markCursorWriteStart(live, persisted, "/tmp/worktree");
    expect(live.size).toBe((await stat(file)).size);
    expect(persisted.size).toBe(live.size);
    expect((await scanCursorJsonlForMessage(live, "continue", "/tmp/worktree")).found).toBe(false);
    await appendJsonl(file, [userTurn("continue new query")]);
    expect((await scanCursorJsonlForMessage(live, "continue", "/tmp/worktree")).found).toBe(true);
  });

  it.each(["truncated", "missing"])("keeps floors when %s", async (state) => {
    const pinned = await makeJsonl("pinned-retain.jsonl", [userTurn("unrelated")]);
    const rotated = await makeJsonl("rotated-retain.jsonl", [userTurn("unrelated")]);
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktree, id) =>
      id === "rotated-id" ? rotated : pinned,
    );
    findCursorSessionIdMock.mockResolvedValue("rotated-id");
    const live = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id", options);
    if (!live) throw new Error("expected baseline");
    const persisted = persistCursorSubmitBaseline(live);
    const original = structuredClone(persisted);
    for (const file of [pinned, rotated]) {
      if (state === "missing") await rm(file);
      else await writeFile(file, "");
    }
    await markCursorWriteStart(live, persisted, "/tmp/worktree", "pinned-id", options);
    expect(live.size).toBe(original.size);
    expect(live.rotationOffsets?.get(rotated)).toBe(original.rotated?.size);
    expect(persisted).toEqual(original);
  });

  it.each(["pinned", "rotated"])("keeps the %s stable prefix", async (path) => {
    const pinned = await makeJsonl("pinned-stable.jsonl", [userTurn("unrelated")]);
    const rotated = await makeJsonl("rotated-stable.jsonl", [userTurn("unrelated")]);
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktree, id) =>
      id === "rotated-id" ? rotated : pinned,
    );
    findCursorSessionIdMock.mockResolvedValue(path === "rotated" ? "rotated-id" : "pinned-id");
    const live = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id", options);
    if (!live) throw new Error("expected baseline");
    const persisted = persistCursorSubmitBaseline(live);
    const file = path === "rotated" ? rotated : pinned;
    await appendJsonl(file, [userTurn("continue old query")]);
    const stableFloor = (await stat(file)).size;
    const laterRecord = JSON.stringify(userTurn("continue new query"));
    await writeFile(file, `{"type":"turn_ended"}\n\n${laterRecord.slice(0, -5)}`, { flag: "a" });
    await markCursorWriteStart(live, persisted, "/tmp/worktree", "pinned-id", options);
    expect(path === "rotated" ? persisted.rotated?.size : persisted.size).toBe(stableFloor);
    const restored = await restoreStoredBaseline(persisted);
    const scan = (baseline: typeof live) =>
      scanCursorJsonlForMessage(baseline, "continue", "/tmp/worktree", "pinned-id", options);
    expect((await scan(live)).found).toBe(false);
    await writeFile(file, `${laterRecord.slice(-5)}\n`, { flag: "a" });
    expect((await scan(live)).found).toBe(true);
    expect((await scan(restored)).found).toBe(true);
    expect(path === "rotated" ? live.rotationOffsets?.get(rotated) : live.size).toBe(stableFloor);
  });

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

// Defer #982's below-floor first-record acknowledgement: file birth cannot
// distinguish a send-created record from old history copied before paste.
describe("conservative rotated-chat acknowledgement", () => {
  const options = { cursorConfigDir: "/tmp/spur-data/cursor/session-1" };

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
    };
    return { baseline, rotatedFile };
  }

  const scan = (baseline: Parameters<typeof scanCursorJsonlForMessage>[0], text: string) =>
    scanCursorJsonlForMessage(baseline, text, "/tmp/worktree", "pinned-id", options);

  it("rejects a matching first record below the floor", async () => {
    const { baseline, rotatedFile } = await setup([userTurn("ship the task")]);
    expect(await scan(baseline, "ship the task")).toEqual({
      found: false,
      scannedFile: rotatedFile,
    });
    expect((await scan(baseline, "ship the task")).found).toBe(false);
    await appendJsonl(rotatedFile, [userTurn("ship the task")]);
    expect((await scan(baseline, "ship the task")).found).toBe(true);
  });

  it("keeps the floor for a restored baseline", async () => {
    const { baseline } = await setup([userTurn("continue")]);
    const legacy = restoreCursorSubmitBaseline({ file: baseline.file, size: baseline.size });
    expect((await scan(legacy, "continue")).found).toBe(false);
  });

  it("C1: a newly observed chat with an old first query does not ack a later repeat", async () => {
    const { baseline } = await setup([userTurn("old query"), userTurn("continue")]);
    expect((await scan(baseline, "continue")).found).toBe(false);
    expect((await scan(baseline, "continue")).found).toBe(false);
  });

  it("C2b: keeps the floor after non-user and textless records ahead of matching text", async () => {
    const { baseline, rotatedFile } = await setup([
      { role: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      { role: "user", message: { content: [] } },
      userTurn("ship the task"),
    ]);
    expect(await scan(baseline, "ship the task")).toEqual({
      found: false,
      scannedFile: rotatedFile,
    });
  });

  it("C3: a chat sighted empty acks once its first matching record arrives", async () => {
    const { baseline, rotatedFile } = await setup([]);
    expect((await scan(baseline, "ship the task")).found).toBe(false);
    await appendJsonl(rotatedFile, [userTurn("ship the task")]);
    expect(await scan(baseline, "ship the task")).toEqual({
      found: true,
      scannedFile: rotatedFile,
    });
  });

  it("C4: a restored binding floors a newly observed chat", async () => {
    const { baseline } = await setup([userTurn("other"), userTurn("continue")]);
    const restored = restoreCursorSubmitBaseline({
      file: baseline.file,
      size: baseline.size,
    });
    expect((await scan(restored, "continue")).found).toBe(false);
  });

  it("C5: floors the second rotated chat and acknowledges only a later append", async () => {
    const { baseline } = await setup([userTurn("other")]);
    const secondFile = await makeJsonl("rotated-second.jsonl", [userTurn("ship the task")]);
    expect((await scan(baseline, "ship the task")).found).toBe(false);
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "rotated-id" ? secondFile : baseline.file,
    );
    expect(await scan(baseline, "ship the task")).toEqual({
      found: false,
      scannedFile: secondFile,
    });
    await appendJsonl(secondFile, [userTurn("ship the task")]);
    expect(await scan(baseline, "ship the task")).toEqual({ found: true, scannedFile: secondFile });
  });

  // The adapter mutates both objects in place; mirror it.
  async function captureAndMark(): Promise<{
    live: NonNullable<Awaited<ReturnType<typeof captureCursorSubmitBaseline>>>;
    persisted: { agent: "cursor" } & ReturnType<typeof persistCursorSubmitBaseline>;
  }> {
    const live = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id", options);
    if (!live) throw new Error("expected a baseline");
    const persisted = { agent: "cursor" as const, ...persistCursorSubmitBaseline(live) };
    await markCursorWriteStart(live, persisted, "/tmp/worktree", "pinned-id", options);
    return { live, persisted };
  }

  it("R1: rejects old matching text below the first-sighting floor", async () => {
    const pinnedFile = await makeJsonl("pinned-r1.jsonl", [userTurn("earlier turn")]);
    const rotatedFile = await makeJsonl("rotated-r1.jsonl", [userTurn("continue")]);
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "rotated-id" ? rotatedFile : pinnedFile,
    );
    findCursorSessionIdMock.mockResolvedValue("pinned-id");
    const { live } = await captureAndMark();
    findCursorSessionIdMock.mockResolvedValue("rotated-id");
    expect((await scan(live, "continue")).found).toBe(false);
  });

  it("N2b: rejects old first text created after the hook and before any pane write, including after restart", async () => {
    const pinnedFile = await makeJsonl("pinned-r2.jsonl", [userTurn("earlier turn")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(pinnedFile);
    findCursorSessionIdMock.mockResolvedValue("pinned-id");
    const { live } = await captureAndMark();
    // No pane write or new submission occurs between the hook and this rotation.
    const rotatedFile = await makeJsonl("rotated-r2.jsonl", [userTurn("ship the task")]);
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "rotated-id" ? rotatedFile : pinnedFile,
    );
    findCursorSessionIdMock.mockResolvedValue("rotated-id");
    expect(await scan(live, "ship the task")).toEqual({ found: false, scannedFile: rotatedFile });
    const persisted = persistCursorSubmitBaseline(live);
    expect(persisted.rotated).toEqual({ file: rotatedFile, size: (await stat(rotatedFile)).size });
    const restored = restoreCursorSubmitBaseline(persisted);
    expect((await scan(restored, "ship the task")).found).toBe(false);
    await appendJsonl(rotatedFile, [userTurn("ship the task")]);
    expect((await scan(live, "ship the task")).found).toBe(true);
    expect((await scan(restored, "ship the task")).found).toBe(true);
  });

  // R3: F rotated in after capture but before the write holds the old query.
  // The write-start hook floors it on the live baseline AND on the persisted
  // one, so the restart path keeps the same floor.
  it("R3: floors a chat rotated in before the write, live and after persist and restore", async () => {
    const pinnedFile = await makeJsonl("pinned-r3.jsonl", [userTurn("earlier turn")]);
    const rotatedFile = await makeJsonl("rotated-r3.jsonl", [userTurn("continue")]);
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "rotated-id" ? rotatedFile : pinnedFile,
    );
    findCursorSessionIdMock.mockResolvedValue("pinned-id");
    const live = await captureCursorSubmitBaseline("/tmp/worktree", "pinned-id", options);
    if (!live) throw new Error("expected a baseline");
    const persisted = { agent: "cursor" as const, ...persistCursorSubmitBaseline(live) };
    expect(persisted.rotated).toBeUndefined();
    // Rotation lands after capture; the hook (called at write time) sees it.
    findCursorSessionIdMock.mockResolvedValue("rotated-id");
    await markCursorWriteStart(live, persisted, "/tmp/worktree", "pinned-id", options);
    expect(persisted.rotated).toEqual({
      file: rotatedFile,
      size: (await stat(rotatedFile)).size,
    });

    // Persisted state as stored at write time, before the new turn lands.
    const stored = structuredClone(persisted);
    const beforeAppend = restoreCursorSubmitBaseline(stored);
    // Without the new turn the old query alone does not ack after restore.
    expect((await scan(beforeAppend, "continue")).found).toBe(false);

    await appendJsonl(rotatedFile, [userTurn("continue")]);
    expect((await scan(live, "continue")).found).toBe(true);

    const restored = restoreCursorSubmitBaseline(
      JSON.parse(JSON.stringify(stored)) as typeof stored,
    );
    expect(await scan(restored, "continue")).toEqual({ found: true, scannedFile: rotatedFile });
  });

  it("survives capture, write start, persist, JSON, session storage and restore", async () => {
    const pinnedFile = await makeJsonl("pinned-rt.jsonl", [userTurn("earlier turn")]);
    findCursorAckTranscriptFileMock.mockResolvedValue(pinnedFile);
    findCursorSessionIdMock.mockResolvedValue(null);
    const { persisted: marked } = await captureAndMark();
    const persisted = JSON.parse(JSON.stringify(marked)) as typeof marked;
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
        ackBaseline: persisted,
      },
    });
    const stored = readSession(dataDir, "api-1")?.queuedMessageTyped?.ackBaseline;
    expect(stored).toEqual(persisted);
    if (stored?.agent !== "cursor") throw new Error("expected cursor baseline");
    const restored = restoreCursorSubmitBaseline(stored);

    // The restored binding first observes a rotated chat containing matching text.
    const rotatedFile = await makeJsonl("rotated-rt.jsonl", [userTurn("ship the task")]);
    findCursorAckTranscriptFileMock.mockImplementation(async (_worktreePath, agentSessionId) =>
      agentSessionId === "rotated-id" ? rotatedFile : pinnedFile,
    );
    findCursorSessionIdMock.mockResolvedValue("rotated-id");
    expect(await scan(restored, "ship the task")).toEqual({
      found: false,
      scannedFile: rotatedFile,
    });
    const refloored = restoreCursorSubmitBaseline(persistCursorSubmitBaseline(restored));
    expect((await scan(refloored, "ship the task")).found).toBe(false);
    await appendJsonl(rotatedFile, [userTurn("ship the task")]);
    expect((await scan(refloored, "ship the task")).found).toBe(true);
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
