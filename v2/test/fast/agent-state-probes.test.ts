import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanupDirs: string[] = [];
const originalHome = process.env.HOME;

function toClaudeProjectPath(worktreePath: string): string {
  return worktreePath.replaceAll("\\", "/").replaceAll(":", "").replace(/[/.]/g, "-");
}

async function writeJsonl(
  filePath: string,
  lines: Array<Record<string, unknown>>,
  modifiedAt: Date,
) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  await utimes(filePath, modifiedAt, modifiedAt);
}

afterEach(async () => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("agent state probes", () => {
  it("maps recent Claude progress entries to working", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "spur-claude-probe-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;
    const worktreePath = join(homeDir, "workspace");
    const signalAt = new Date("2026-03-24T10:04:30.000Z");
    await writeJsonl(
      join(homeDir, ".claude", "projects", toClaudeProjectPath(worktreePath), "session.jsonl"),
      [{ type: "progress" }],
      signalAt,
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T10:05:00.000Z"));
    vi.resetModules();
    const { probeClaudeState } = await import("../../src/agents/claude.js");

    const result = await probeClaudeState(worktreePath, {
      processAlive: true,
      signalWindowMs: 90_000,
    });

    expect(result).toEqual({
      state: "working",
      signalAt,
    });
  });

  it("maps Claude permission requests to needs_input while the process is live", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "spur-claude-probe-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;
    const worktreePath = join(homeDir, "workspace");
    const signalAt = new Date("2026-03-24T10:04:30.000Z");
    await writeJsonl(
      join(homeDir, ".claude", "projects", toClaudeProjectPath(worktreePath), "session.jsonl"),
      [{ type: "permission_request" }],
      signalAt,
    );

    vi.resetModules();
    const { probeClaudeState } = await import("../../src/agents/claude.js");

    const result = await probeClaudeState(worktreePath, {
      processAlive: true,
      signalWindowMs: 90_000,
    });

    expect(result).toEqual({
      state: "needs_input",
      signalAt,
    });
  });

  it("reads Claude state from the file tail even with large and malformed trailing content", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "spur-claude-probe-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;
    const worktreePath = join(homeDir, "workspace");
    const signalAt = new Date("2026-03-24T10:04:30.000Z");
    const sessionFile = join(
      homeDir,
      ".claude",
      "projects",
      toClaudeProjectPath(worktreePath),
      "session.jsonl",
    );
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      `${"x".repeat(140_000)}\n${JSON.stringify({ type: "permission_request" })}\n{broken-json}\n`,
      "utf8",
    );
    await utimes(sessionFile, signalAt, signalAt);

    vi.resetModules();
    const { probeClaudeState } = await import("../../src/agents/claude.js");

    const result = await probeClaudeState(worktreePath, {
      processAlive: true,
      signalWindowMs: 90_000,
    });

    expect(result).toEqual({
      state: "needs_input",
      signalAt,
    });
  });

  it("maps Claude error entries to error after the process exits", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "spur-claude-probe-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;
    const worktreePath = join(homeDir, "workspace");
    const signalAt = new Date("2026-03-24T10:04:30.000Z");
    await writeJsonl(
      join(homeDir, ".claude", "projects", toClaudeProjectPath(worktreePath), "session.jsonl"),
      [{ type: "error" }],
      signalAt,
    );

    vi.resetModules();
    const { probeClaudeState } = await import("../../src/agents/claude.js");

    const result = await probeClaudeState(worktreePath, {
      processAlive: false,
      signalWindowMs: 90_000,
    });

    expect(result).toEqual({
      state: "error",
      signalAt,
    });
  });

  it("maps stale Codex rollout files to waiting", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "spur-codex-probe-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;
    const worktreePath = join(homeDir, "workspace");
    const signalAt = new Date("2026-03-24T09:59:00.000Z");
    await writeJsonl(
      join(homeDir, ".codex", "sessions", "2026", "03", "24", "rollout-test.jsonl"),
      [{ type: "session_meta", cwd: worktreePath }],
      signalAt,
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T10:05:00.000Z"));
    vi.resetModules();
    const { probeCodexState } = await import("../../src/agents/codex.js");

    const result = await probeCodexState(worktreePath, {
      processAlive: true,
      signalWindowMs: 90_000,
    });

    expect(result).toEqual({
      state: "waiting",
      signalAt,
    });
  });

  it("maps stopped Codex processes to stopped even with a matching session file", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "spur-codex-probe-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;
    const worktreePath = join(homeDir, "workspace");
    const signalAt = new Date("2026-03-24T10:04:30.000Z");
    await writeJsonl(
      join(homeDir, ".codex", "sessions", "2026", "03", "24", "rollout-test.jsonl"),
      [{ type: "session_meta", payload: { cwd: worktreePath, id: "thread-1" } }],
      signalAt,
    );

    vi.resetModules();
    const { probeCodexState } = await import("../../src/agents/codex.js");

    const result = await probeCodexState(worktreePath, {
      processAlive: false,
      signalWindowMs: 90_000,
    });

    expect(result).toEqual({
      state: "stopped",
      signalAt,
    });
  });
});
