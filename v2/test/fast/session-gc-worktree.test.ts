import { existsSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { listSessions, writeSession } from "../../src/metadata.js";
import {
  createGcDeps,
  executeSessionGc,
  planSessionGc,
  type GcOpenPrIndex,
  type SessionGcExecutorDeps,
} from "../../src/session-gc.js";
import { workspaceExists } from "../../src/workspace.js";
import type { AppConfig, SessionRecord } from "../../src/types.js";
import { createTempDir, execFileAsync } from "../helpers/common.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

interface Fixture {
  config: AppConfig;
  repoPath: string;
  worktreePath: string;
  session: SessionRecord;
}

// Real git repo + real `git worktree add`, so the removal path under test is
// the same `git worktree remove` the daemon runs — a mocked git cannot show
// that the parent repo's worktree metadata ends up consistent.
async function createFixture(): Promise<Fixture> {
  const root = await createTempDir("spur-gc-worktree-");
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
  await git(repoPath, "config", "user.email", "gc@example.com");
  await git(repoPath, "config", "user.name", "GC Test");
  await writeFile(join(repoPath, "README.md"), "gc fixture\n", "utf8");
  await git(repoPath, "add", "README.md");
  await git(repoPath, "commit", "-m", "init");
  await git(repoPath, "remote", "add", "origin", originPath);
  await git(repoPath, "push", "-u", "origin", "main");

  const worktreePath = join(worktreeDir, "api", "api-1");
  await git(repoPath, "worktree", "add", "-b", "feature/gc-one", worktreePath, "main");

  const configPath = join(root, "spur.yaml");
  await writeFile(
    configPath,
    [
      `dataDir: ${dataDir}`,
      `worktreeDir: ${worktreeDir}`,
      "projects:",
      "  api:",
      `    path: ${repoPath}`,
      "",
    ].join("\n"),
    "utf8",
  );
  const config = loadConfig(configPath);

  const session: SessionRecord = {
    id: "api-1",
    project: "api",
    workspaceId: "api-1",
    agent: "claude",
    prompt: "ship it",
    branch: "feature/gc-one",
    worktree: true,
    worktreePath,
    tmuxSession: "api-1",
    launchCommand: "claude",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  writeSession(config.dataDir, session);

  return { config, repoPath, worktreePath, session };
}

// Only the gh probe is faked; removal, archival, sizing, and the dirty and
// unpushed guards all run for real against the fixture repo.
function depsWithoutGh(config: AppConfig, openPrs: GcOpenPrIndex): SessionGcExecutorDeps {
  return {
    ...createGcDeps(config),
    openPrIndex: async () => openPrs,
  };
}

function planFor(config: AppConfig) {
  return planSessionGc({
    sessions: listSessions(config.dataDir),
    worktreeDir: config.worktreeDir,
    now: new Date("2026-08-01T00:00:00.000Z"),
    olderThanDays: 30,
    statuses: ["completed", "killed", "stopped"],
    limit: 100,
    pathExists: (path) => workspaceExists(path),
  });
}

const NO_OPEN_PRS: GcOpenPrIndex = { numbers: new Set(), branches: new Set() };

describe("session gc against a real git worktree", () => {
  it("removes the worktree through git, prunes the repo, archives the record, and reports freed bytes", async () => {
    const fixture = await createFixture();
    const plan = planFor(fixture.config);

    expect(plan.groups[0]?.action).toBe("reclaim");

    const report = await executeSessionGc(plan, depsWithoutGh(fixture.config, NO_OPEN_PRS), {
      dryRun: false,
      sizes: true,
    });

    expect(report.groups[0]?.removed).toBe(true);
    expect(report.groups[0]?.archived).toBe(true);
    expect(existsSync(fixture.worktreePath)).toBe(false);
    expect(report.totals.freedBytes ?? 0).toBeGreaterThan(0);

    // git-side metadata is consistent: the repo no longer lists the worktree.
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: fixture.repoPath,
    });
    expect(stdout).not.toContain(fixture.worktreePath);

    // The record left dataDir/sessions and lives under sessions-archive.
    expect(listSessions(fixture.config.dataDir)).toEqual([]);
    expect(existsSync(join(fixture.config.dataDir, "sessions-archive", "api", "api-1.json"))).toBe(
      true,
    );
  });

  it("dry run leaves the worktree and the record exactly where they were", async () => {
    const fixture = await createFixture();

    const report = await executeSessionGc(
      planFor(fixture.config),
      depsWithoutGh(fixture.config, NO_OPEN_PRS),
      { dryRun: true, sizes: true },
    );

    expect(report.groups[0]?.action).toBe("reclaim");
    expect(report.groups[0]?.removed).toBe(false);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(listSessions(fixture.config.dataDir).map((session) => session.id)).toEqual(["api-1"]);
  });

  it("blocks an uncommitted-work worktree instead of letting git worktree remove --force destroy it", async () => {
    const fixture = await createFixture();
    writeFileSync(join(fixture.worktreePath, "scratch.txt"), "unsaved work\n");

    const report = await executeSessionGc(
      planFor(fixture.config),
      depsWithoutGh(fixture.config, NO_OPEN_PRS),
      { dryRun: false, sizes: false },
    );

    expect(report.groups[0]?.action).toBe("blocked");
    expect(report.groups[0]?.blockReasons).toEqual(["uncommitted_changes"]);
    expect(existsSync(join(fixture.worktreePath, "scratch.txt"))).toBe(true);
    expect(listSessions(fixture.config.dataDir).map((session) => session.id)).toEqual(["api-1"]);
  });

  it("blocks a stale-parked session's worktree — it is an idle in-progress task, not an abandoned one (FIX 5)", async () => {
    const fixture = await createFixture();
    writeSession(fixture.config.dataDir, {
      ...fixture.session,
      status: "stopped",
      stopReason: "stale_timeout",
    });

    const report = await executeSessionGc(
      planFor(fixture.config),
      depsWithoutGh(fixture.config, NO_OPEN_PRS),
      { dryRun: false, sizes: false },
    );

    expect(report.groups[0]?.blockReasons).toEqual(["live_session"]);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(listSessions(fixture.config.dataDir).map((session) => session.id)).toEqual(["api-1"]);
  });

  it("blocks a stale-parked session's record from archival even when its worktree is already gone from disk (GC's second liveness check, GAP C)", async () => {
    // Distinct from the "blocks a stale-parked session's worktree" case
    // above: there the worktree still exists on disk, so the plan classifies
    // action "reclaim" and the FIRST liveness check (guarding removeWorktree)
    // is what fires. Here the worktree is already gone before planning even
    // runs (e.g. a prior GC run removed it but crashed before archiving, or
    // it was deleted out of band) — planSessionGc's own pathExists check
    // then classifies this group "archive" outright, with no
    // protectedSessionIds passed in by this test's planFor helper. The only
    // thing standing between this parked-and-still-resumable record and
    // archiveGroup is executeSessionGc's SECOND liveness check, right before
    // archiving. A mutation dropping that second check would archive it: the
    // session vanishes from the fleet and can never be woken again.
    const fixture = await createFixture();
    writeSession(fixture.config.dataDir, {
      ...fixture.session,
      status: "stopped",
      stopReason: "stale_timeout",
    });
    await rm(fixture.worktreePath, { recursive: true, force: true });

    const plan = planFor(fixture.config);
    expect(plan.groups[0]?.action).toBe("archive");

    const report = await executeSessionGc(plan, depsWithoutGh(fixture.config, NO_OPEN_PRS), {
      dryRun: false,
      sizes: false,
    });

    expect(report.groups[0]?.blockReasons).toEqual(["live_session"]);
    expect(report.groups[0]?.archived).toBe(false);
    expect(listSessions(fixture.config.dataDir).map((session) => session.id)).toEqual(["api-1"]);
    expect(existsSync(join(fixture.config.dataDir, "sessions-archive", "api", "api-1.json"))).toBe(
      false,
    );
  });

  it("blocks a worktree holding unpushed commits", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.worktreePath, "feature.txt"), "local only\n", "utf8");
    await git(fixture.worktreePath, "add", "feature.txt");
    await git(fixture.worktreePath, "commit", "-m", "local work");

    const report = await executeSessionGc(
      planFor(fixture.config),
      depsWithoutGh(fixture.config, NO_OPEN_PRS),
      { dryRun: false, sizes: false },
    );

    expect(report.groups[0]?.blockReasons).toEqual(["unpushed_commits"]);
    expect(existsSync(fixture.worktreePath)).toBe(true);
  });

  it("blocks a worktree whose branch still has an open PR", async () => {
    const fixture = await createFixture();

    const report = await executeSessionGc(
      planFor(fixture.config),
      depsWithoutGh(fixture.config, {
        numbers: new Set(),
        branches: new Set(["feature/gc-one"]),
      }),
      { dryRun: false, sizes: false },
    );

    expect(report.groups[0]?.blockReasons).toEqual(["open_pr"]);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(listSessions(fixture.config.dataDir).map((session) => session.id)).toEqual(["api-1"]);
  });
});
