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
