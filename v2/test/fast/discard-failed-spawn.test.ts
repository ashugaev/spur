import { existsSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSession, writeSession } from "../../src/metadata.js";
import { SessionService } from "../../src/session-service.js";
import type { SessionRecord, WorkItemTriggerOrigin } from "../../src/types.js";
import { createWorktree, deleteLocalBranch } from "../../src/workspace.js";
import { createTempDir, execFileAsync } from "../helpers/common.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

interface Fixture {
  root: string;
  repoPath: string;
  dataDir: string;
  worktreeDir: string;
  logEvent: ReturnType<typeof vi.fn>;
  discard(sessionId: string): Promise<void>;
}

const triggerOrigin: WorkItemTriggerOrigin = {
  triggerId: "review",
  sourceId: "pr-watch",
  externalId: "acme/api#7",
  blockIndex: 0,
};

// Real temp git repo with an origin, real metadata, real workspace helpers.
// discardFailedSpawn reads only config.dataDir, getProject and logEvent from
// the service, so it runs on a stand-in `this`.
async function createFixture(): Promise<Fixture> {
  const root = await createTempDir("spur-discard-");
  tempDirs.push(root);
  const originPath = join(root, "origin.git");
  const repoPath = join(root, "repo");
  const dataDir = join(root, "data");
  const worktreeDir = join(root, "worktrees");
  await mkdir(originPath, { recursive: true });
  await mkdir(repoPath, { recursive: true });
  await mkdir(worktreeDir, { recursive: true });
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", originPath]);
  await git(repoPath, "init", "--initial-branch=main");
  await git(repoPath, "config", "user.email", "discard@example.com");
  await git(repoPath, "config", "user.name", "Discard Test");
  await writeFile(join(repoPath, "README.md"), "fixture\n", "utf8");
  await git(repoPath, "add", "README.md");
  await git(repoPath, "commit", "-m", "init");
  await git(repoPath, "remote", "add", "origin", originPath);
  await git(repoPath, "push", "-u", "origin", "main");
  const logEvent = vi.fn();
  const standIn = {
    config: { dataDir },
    getProject: () => ({ path: repoPath }),
    logEvent,
  };
  return {
    root,
    repoPath,
    dataDir,
    worktreeDir,
    logEvent,
    discard: (sessionId) =>
      SessionService.prototype.discardFailedSpawn.call(standIn as never, sessionId),
  };
}

function erroredRecord(id: string, overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    id,
    project: "api",
    workspaceId: id,
    agent: "claude",
    prompt: "review",
    branch: id,
    worktree: true,
    worktreePath: "",
    tmuxSession: id,
    launchCommand: "",
    status: "errored",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    error: "boom",
    triggerOrigin,
    ...overrides,
  };
}

function archivedPath(fixture: Fixture, id: string): string {
  return join(fixture.dataDir, "sessions-archive", "api", `${id}.json`);
}

async function branches(fixture: Fixture, name: string): Promise<string> {
  return git(fixture.repoPath, "branch", "--list", name);
}

describe("discardFailedSpawn", () => {
  it("archives the record and deletes its own branch", async () => {
    const f = await createFixture();
    await git(f.repoPath, "branch", "api-1");
    writeSession(f.dataDir, erroredRecord("api-1"));

    await f.discard("api-1");

    expect(await branches(f, "api-1")).toBe("");
    expect(readSession(f.dataDir, "api-1")).toBeNull();
    expect(existsSync(archivedPath(f, "api-1"))).toBe(true);
  });

  it("keeps a branch that is not the session id or is checked out, and archives both", async () => {
    const f = await createFixture();
    await git(f.repoPath, "branch", "feature/shared");
    writeSession(f.dataDir, erroredRecord("api-1", { branch: "feature/shared" }));
    await git(f.repoPath, "branch", "api-2");
    await git(f.repoPath, "worktree", "add", join(f.worktreeDir, "api-2"), "api-2");
    writeSession(f.dataDir, erroredRecord("api-2"));

    await f.discard("api-1");
    await f.discard("api-2");

    expect(await branches(f, "feature/shared")).toContain("feature/shared");
    expect(await branches(f, "api-2")).toContain("api-2");
    expect(existsSync(archivedPath(f, "api-1"))).toBe(true);
    expect(existsSync(archivedPath(f, "api-2"))).toBe(true);
    expect(f.logEvent).not.toHaveBeenCalled();
  });

  it("leaves a record without triggerOrigin or a non-errored record untouched", async () => {
    const f = await createFixture();
    await git(f.repoPath, "branch", "api-1");
    const { triggerOrigin: _origin, ...untagged } = erroredRecord("api-1");
    writeSession(f.dataDir, untagged);
    writeSession(f.dataDir, erroredRecord("api-2", { status: "running" }));

    await f.discard("api-1");
    await f.discard("api-2");

    expect(readSession(f.dataDir, "api-1")).not.toBeNull();
    expect(readSession(f.dataDir, "api-2")).not.toBeNull();
    expect(await branches(f, "api-1")).toContain("api-1");
  });

  it("keeps the branch and record of a session that launched", async () => {
    const f = await createFixture();
    await git(f.repoPath, "branch", "api-1");
    writeSession(f.dataDir, erroredRecord("api-1", { launchCommand: "claude --resume" }));

    await f.discard("api-1");

    expect(readSession(f.dataDir, "api-1")).not.toBeNull();
    expect(await branches(f, "api-1")).toContain("api-1");
  });

  it("archives a record whose branch was never created, without an error", async () => {
    const f = await createFixture();
    writeSession(f.dataDir, erroredRecord("api-1"));

    await f.discard("api-1");

    expect(existsSync(archivedPath(f, "api-1"))).toBe(true);
    expect(f.logEvent).not.toHaveBeenCalled();
  });

  it("deleteLocalBranch and a parallel createWorktree on one repo both resolve", async () => {
    const f = await createFixture();
    await git(f.repoPath, "branch", "api-1");

    const [outcome, worktreePath] = await Promise.all([
      deleteLocalBranch(f.repoPath, "api-1"),
      createWorktree({
        repoPath: f.repoPath,
        worktreeBaseDir: f.worktreeDir,
        projectId: "api",
        sessionId: "api-2",
        branch: "api-2",
        defaultBranch: "main",
        symlinks: [],
      }),
    ]);

    expect(outcome).toBe("deleted");
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("reports checked_out, absent and deleted outcomes", async () => {
    const f = await createFixture();
    await git(f.repoPath, "branch", "api-1");
    await git(f.repoPath, "branch", "api-2");
    await git(f.repoPath, "worktree", "add", join(f.worktreeDir, "api-2"), "api-2");

    expect(await deleteLocalBranch(f.repoPath, "api-2")).toBe("checked_out");
    expect(await deleteLocalBranch(f.repoPath, "api-9")).toBe("absent");
    expect(await deleteLocalBranch(f.repoPath, "api-1")).toBe("deleted");
  });

  it("archives the record and logs discard_failed once when the branch delete fails", async () => {
    const f = await createFixture();
    await git(f.repoPath, "branch", "api-1");
    writeFileSync(join(f.repoPath, ".git", "refs", "heads", "api-1.lock"), "");
    writeSession(f.dataDir, erroredRecord("api-1"));

    await f.discard("api-1");

    expect(existsSync(archivedPath(f, "api-1"))).toBe(true);
    expect(await branches(f, "api-1")).toContain("api-1");
    expect(f.logEvent).toHaveBeenCalledTimes(1);
    expect(f.logEvent).toHaveBeenCalledWith(
      "trigger.spawn.discard_failed",
      expect.objectContaining({ level: "warn", sessionId: "api-1" }),
    );
  });
});
