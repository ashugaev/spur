import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanupDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  while (cleanupDirs.length > 0) {
    const current = cleanupDirs.pop();
    if (!current) {
      throw new Error("Expected a cleanup directory");
    }
    await rm(current, { recursive: true, force: true });
  }
});

describe("agent resume metadata", () => {
  it("keeps Codex hooks enabled in the interactive launch plan", async () => {
    vi.resetModules();
    const { buildCodexPlan } = await import("../../src/agents/codex.js");

    const plan = buildCodexPlan("hello");

    expect(plan.launchCommand).toContain("-c features.codex_hooks=true");
    expect(plan.launchCommand).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("keeps scanning Codex session headers when an early JSONL line is malformed", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "spur-codex-home-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;

    const worktreePath = join(homeDir, "workspace");
    const sessionDir = join(homeDir, ".codex", "sessions", "2026", "03", "18");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "rollout-test.jsonl"),
      [
        "{bad json",
        JSON.stringify({ type: "session_meta", cwd: worktreePath, model: "test-model" }),
        JSON.stringify({ threadId: "thread-123" }),
      ].join("\n"),
      "utf8",
    );

    vi.resetModules();
    const { buildCodexResumePlan, findCodexSessionId } = await import("../../src/agents/codex.js");

    const sessionId = await findCodexSessionId(worktreePath);
    const plan = buildCodexResumePlan(sessionId ?? "", "/tmp/fake-codex");

    expect(sessionId).toBe("thread-123");
    expect(plan.launchCommand).toContain("'/tmp/fake-codex' resume -c features.codex_hooks=true");
    expect(plan.launchCommand).toContain("thread-123");
  });

  it("accepts the current Codex session_meta payload shape", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "spur-codex-home-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;

    const worktreePath = join(homeDir, "workspace");
    const sessionDir = join(homeDir, ".codex", "sessions", "2026", "03", "19");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "rollout-test.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "session-123",
            cwd: worktreePath,
          },
        }),
      ].join("\n"),
      "utf8",
    );

    vi.resetModules();
    const { buildCodexResumePlan, findCodexSessionId } = await import("../../src/agents/codex.js");

    const sessionId = await findCodexSessionId(worktreePath);
    const plan = buildCodexResumePlan(sessionId ?? "", "/tmp/fake-codex");

    expect(sessionId).toBe("session-123");
    expect(plan.launchCommand).toContain("'/tmp/fake-codex' resume -c features.codex_hooks=true");
    expect(plan.launchCommand).toContain("session-123");
  });

  it("matches a canonical Codex cwd when the requested worktree path uses a symlinked prefix", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "spur-codex-home-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;

    const worktreePath = join(homeDir, "workspace");
    await mkdir(worktreePath, { recursive: true });
    const canonicalWorktreePath = await realpath(worktreePath);
    const sessionDir = join(homeDir, ".codex", "sessions", "2026", "03", "19");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "rollout-test.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "session-456",
            cwd: canonicalWorktreePath,
          },
        }),
      ].join("\n"),
      "utf8",
    );

    vi.resetModules();
    const { buildCodexResumePlan, findCodexSessionId } = await import("../../src/agents/codex.js");

    const sessionId = await findCodexSessionId(worktreePath);
    const plan = buildCodexResumePlan(sessionId ?? "", "/tmp/fake-codex");

    expect(sessionId).toBe("session-456");
    expect(plan.launchCommand).toContain("resume -c features.codex_hooks=true");
    expect(plan.launchCommand).toContain("session-456");
  });
});
