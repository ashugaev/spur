import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureCursorSubmitBaseline,
  scanCursorJsonlForMessage,
} from "../../src/agents/cursor-submit-ack.js";
import { toCursorProjectPath } from "../../src/cursor-jsonl-state.js";

// Real filesystem, no mocks of the chat-id or transcript resolvers (#889): the
// shared project transcripts dir holds a NEWER peer transcript carrying the
// sent text, and the session-private chats dir decides which chat is ours.
describe("cursor no-id submit ack on a real filesystem (#889)", () => {
  const SENT = "ship the task";
  let root: string;
  let worktreePath: string;
  let configDir: string;
  let transcriptsDir: string;

  function turn(text: string): string {
    return `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } })}\n`;
  }

  async function writeTranscript(chatId: string, body: string): Promise<string> {
    const file = join(transcriptsDir, chatId, `${chatId}.jsonl`);
    await mkdir(join(transcriptsDir, chatId), { recursive: true });
    await writeFile(file, body);
    return file;
  }

  async function createPrivateChat(chatId: string): Promise<void> {
    const hash = createHash("md5").update(worktreePath).digest("hex");
    const chatDir = join(configDir, "chats", hash, chatId);
    await mkdir(chatDir, { recursive: true });
    await writeFile(join(chatDir, "store.db"), "");
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "cursor-ack-real-fs-")));
    vi.stubEnv("HOME", join(root, "home"));
    worktreePath = join(root, "worktree");
    await mkdir(worktreePath, { recursive: true });
    configDir = join(root, "data", "cursor", "session-1");
    transcriptsDir = join(
      root,
      "home",
      ".cursor",
      "projects",
      toCursorProjectPath(worktreePath),
      "agent-transcripts",
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function writeNewerDecoy(): Promise<string> {
    const decoy = await writeTranscript("peer-chat", turn(SENT));
    const future = new Date(Date.now() + 60_000);
    await utimes(decoy, future, future);
    return decoy;
  }

  it("acks the own chat's first record, never the newer peer transcript", async () => {
    const decoy = await writeNewerDecoy();
    const options = { cursorConfigDir: configDir };

    const baseline = await captureCursorSubmitBaseline(worktreePath, undefined, options);
    expect(baseline).toEqual({ file: null, size: 0 });
    if (!baseline) return;

    const firstPoll = await scanCursorJsonlForMessage(
      baseline,
      SENT,
      worktreePath,
      undefined,
      options,
    );
    expect(firstPoll).toEqual({ found: false, scannedFile: null });

    await createPrivateChat("own-chat");
    const ownFile = await writeTranscript("own-chat", turn(SENT));
    const secondPoll = await scanCursorJsonlForMessage(
      baseline,
      SENT,
      worktreePath,
      undefined,
      options,
    );
    expect(secondPoll).toEqual({ found: true, scannedFile: ownFile });
    expect(secondPoll.scannedFile).not.toBe(decoy);
  });

  it("does not ack when the own chat lacks the text, and never scans the peer", async () => {
    const decoy = await writeNewerDecoy();
    const options = { cursorConfigDir: configDir };

    const baseline = await captureCursorSubmitBaseline(worktreePath, undefined, options);
    if (!baseline) throw new Error("expected a pending baseline");
    await createPrivateChat("own-chat");
    const ownFile = await writeTranscript("own-chat", turn("something else"));

    const result = await scanCursorJsonlForMessage(
      baseline,
      SENT,
      worktreePath,
      undefined,
      options,
    );
    expect(result).toEqual({ found: false, scannedFile: ownFile });
    expect(result.scannedFile).not.toBe(decoy);
  });
});
