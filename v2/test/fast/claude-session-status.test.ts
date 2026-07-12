import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyClaudeSessionStatus,
  readClaudeSessionStatus,
} from "../../src/claude-session-status.js";

const tempDirs: string[] = [];

async function makeSessionsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-sessions-"));
  tempDirs.push(dir);
  return dir;
}

async function writeStatus(
  sessionsDir: string,
  name: string,
  record: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(sessionsDir, name), JSON.stringify(record), "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("classifyClaudeSessionStatus", () => {
  it("maps observed Claude statuses to Spur session states", () => {
    expect(classifyClaudeSessionStatus("busy")).toBe("working");
    expect(classifyClaudeSessionStatus("idle")).toBe("waiting");
    expect(classifyClaudeSessionStatus("waiting", "permission prompt")).toBe("needs_input");
    expect(classifyClaudeSessionStatus("waiting")).toBe("waiting");
  });

  it("returns null for unknown status details so JSONL can classify", () => {
    expect(classifyClaudeSessionStatus("paused")).toBeNull();
    expect(classifyClaudeSessionStatus("waiting", "tool result")).toBeNull();
  });
});

describe("readClaudeSessionStatus", () => {
  it("reads the latest matching status by cwd", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStatus(sessionsDir, "old.json", {
      cwd: "/tmp/spur-worktrees/api/api-1",
      status: "idle",
      updatedAt: "2026-03-18T10:00:00.000Z",
    });
    await writeStatus(sessionsDir, "new.json", {
      cwd: "/tmp/spur-worktrees/api/api-1",
      status: "busy",
      statusUpdated: "2026-03-18T10:05:00.000Z",
    });

    const result = await readClaudeSessionStatus(
      "/tmp/spur-worktrees/api/api-1",
      undefined,
      sessionsDir,
    );

    expect(result).toMatchObject({
      state: "working",
      status: "busy",
      filePath: join(sessionsDir, "new.json"),
    });
  });

  it("matches by native session id when cwd differs", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStatus(sessionsDir, "native.json", {
      cwd: "/tmp/other",
      sessionId: "native-session-1",
      status: "waiting",
      waitingFor: "permission prompt",
      statusUpdatedAt: "2026-03-18T10:05:00.000Z",
    });

    const result = await readClaudeSessionStatus(
      "/tmp/spur-worktrees/api/api-1",
      "native-session-1",
      sessionsDir,
    );

    expect(result).toMatchObject({
      state: "needs_input",
      status: "waiting",
      waitingFor: "permission prompt",
      sessionId: "native-session-1",
    });
  });

  it("ignores a stranger's status file that shares the workspace when a pane pid is known", async () => {
    const sessionsDir = await makeSessionsDir();
    // Idle process actually in this session's pane.
    await writeStatus(sessionsDir, "mine.json", {
      cwd: "/tmp/shared",
      pid: 200,
      status: "idle",
      updatedAt: "2026-03-18T10:00:00.000Z",
    });
    // Newer file from an unrelated Claude in the same shared workspace, stuck
    // on a permission prompt — the pre-pane behaviour would have picked this.
    await writeStatus(sessionsDir, "stranger.json", {
      cwd: "/tmp/shared",
      pid: 900,
      status: "waiting",
      waitingFor: "permission prompt",
      updatedAt: "2026-03-18T10:05:00.000Z",
    });

    // tmux 50 -> pane 100 -> 200 (mine); 900 is unrelated.
    const readPpid = async (pid: number) =>
      pid === 200 ? 100 : pid === 100 ? 50 : pid === 900 ? 1 : null;

    const result = await readClaudeSessionStatus("/tmp/shared", undefined, sessionsDir, {
      panePid: 100,
      readPpid,
    });

    expect(result).toMatchObject({ state: "waiting", status: "idle", pid: 200 });
  });

  it("returns null rather than a stranger's file when the pane owns nothing", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStatus(sessionsDir, "stranger.json", {
      cwd: "/tmp/shared",
      pid: 900,
      status: "waiting",
      waitingFor: "permission prompt",
      updatedAt: "2026-03-18T10:05:00.000Z",
    });
    // pane 100 is introspectable (parent 50) but owns no status-file pid.
    const readPpid = async (pid: number) => (pid === 100 ? 50 : pid === 900 ? 1 : null);

    await expect(
      readClaudeSessionStatus("/tmp/shared", undefined, sessionsDir, { panePid: 100, readPpid }),
    ).resolves.toBeNull();
  });

  it("falls back to weaker keys when process ancestry is unreadable", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStatus(sessionsDir, "only.json", {
      cwd: "/tmp/shared",
      pid: 900,
      status: "busy",
      updatedAt: "2026-03-18T10:05:00.000Z",
    });
    // procfs unreadable for every pid (e.g. non-Linux host).
    const readPpid = async () => null;

    const result = await readClaudeSessionStatus("/tmp/shared", undefined, sessionsDir, {
      panePid: 100,
      readPpid,
    });

    expect(result).toMatchObject({ state: "working", status: "busy" });
  });

  it("returns null for malformed JSON, non-matching sessions, and unknown status values", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeFile(join(sessionsDir, "bad.json"), "{", "utf8");
    await writeStatus(sessionsDir, "other.json", {
      cwd: "/tmp/other",
      status: "busy",
      updatedAt: "2026-03-18T10:00:00.000Z",
    });
    await writeStatus(sessionsDir, "unknown.json", {
      cwd: "/tmp/spur-worktrees/api/api-1",
      status: "waiting",
      waitingFor: "network",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });

    await expect(
      readClaudeSessionStatus("/tmp/spur-worktrees/api/api-1", undefined, sessionsDir),
    ).resolves.toBeNull();
  });
});
