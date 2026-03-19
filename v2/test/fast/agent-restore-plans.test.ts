import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanupDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  delete process.env["SPUR_CODEX_BIN"];
  while (cleanupDirs.length > 0) {
    await rm(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

describe("agent restore plans", () => {
  it("keeps scanning Codex session headers when an early JSONL line is malformed", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "spur-codex-home-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;
    process.env.SPUR_CODEX_BIN = "/tmp/fake-codex";

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
    const { buildCodexRestorePlan } = await import("../../src/agents/codex.js");

    const plan = await buildCodexRestorePlan(worktreePath, "restore prompt");

    expect(plan).not.toBeNull();
    expect(plan?.launchCommand).toContain("/tmp/fake-codex resume");
    expect(plan?.launchCommand).toContain("thread-123");
  });
});
