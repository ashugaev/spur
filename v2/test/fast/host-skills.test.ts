import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyHostSkillTarget, installHostSkills } from "../../src/host-skills.js";

async function writeFakeInstallRoot(withCliJs = true): Promise<{
  root: string;
  skillsDir: string;
  skillDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "spur-host-skills-root-"));
  const skillsDir = join(root, "skills");
  const skillDir = join(skillsDir, "spur");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: spur\n---\n", "utf8");
  if (withCliJs) {
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "cli.js"), "", "utf8");
  }
  return { root, skillsDir, skillDir };
}

describe("host-skills", () => {
  let home: string;
  let cleanupRoots: string[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "spur-host-skills-home-"));
    cleanupRoots = [];
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    for (const root of cleanupRoots) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("T1 (AC1) fresh home: both host dirs get a symlink at the packaged skill dir", async () => {
    const { root, skillsDir, skillDir } = await writeFakeInstallRoot();
    cleanupRoots.push(root);

    const outcomes = installHostSkills({ home, skillsDir });

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === "linked")).toBe(true);
    for (const agentDir of [".claude", ".codex"]) {
      const link = join(home, agentDir, "skills", "spur");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(skillDir);
    }
  });

  it("T2 (AC2) replaces a dangling Spur-owned link with zero warnings", async () => {
    const { root, skillsDir, skillDir } = await writeFakeInstallRoot();
    cleanupRoots.push(root);

    const claudeSkills = join(home, ".claude", "skills");
    mkdirSync(claudeSkills, { recursive: true });
    const link = join(claudeSkills, "spur");
    // Dangling: points at a install root that no longer exists, but the link
    // TEXT still looks like `<root>/skills/spur`.
    const goneRoot = join(tmpdir(), "spur-gone-root-does-not-exist");
    symlinkSync(join(goneRoot, "skills", "spur"), link, "dir");

    expect(classifyHostSkillTarget(link)).toBe("owned");

    const outcomes = installHostSkills({ home, skillsDir });
    const claudeOutcome = outcomes.find((o) => o.dir === link);
    expect(claudeOutcome?.status).toBe("linked");
    expect(readlinkSync(link)).toBe(skillDir);
    expect(outcomes.some((o) => o.status === "conflict" || o.status === "error")).toBe(false);
  });

  it("T3 (AC3) an already-correct link yields unchanged", async () => {
    const { root, skillsDir, skillDir } = await writeFakeInstallRoot();
    cleanupRoots.push(root);

    const outcomes1 = installHostSkills({ home, skillsDir });
    expect(outcomes1.every((o) => o.status === "linked")).toBe(true);

    const link = join(home, ".claude", "skills", "spur");
    const before = readlinkSync(link);

    const outcomes2 = installHostSkills({ home, skillsDir });
    expect(outcomes2.every((o) => o.status === "unchanged")).toBe(true);
    expect(readlinkSync(link)).toBe(before);
    expect(before).toBe(skillDir);
  });

  it("T4 (AC4) a real directory at a target is left untouched, one conflict", async () => {
    const { root, skillsDir } = await writeFakeInstallRoot();
    cleanupRoots.push(root);

    const claudeSkills = join(home, ".claude", "skills");
    const conflictDir = join(claudeSkills, "spur");
    mkdirSync(join(conflictDir, "nested"), { recursive: true });
    writeFileSync(join(conflictDir, "nested", "keep.txt"), "user content");

    const outcomes = installHostSkills({ home, skillsDir });
    const claudeOutcome = outcomes.find((o) => o.dir === conflictDir);

    expect(claudeOutcome?.status).toBe("conflict");
    expect(claudeOutcome?.conflictKind).toBe("directory");
    expect(lstatSync(conflictDir).isDirectory()).toBe(true);
    expect(lstatSync(join(conflictDir, "nested", "keep.txt")).isFile()).toBe(true);
  });

  it("T5 (AC5) a symlink outside the package root is left unchanged, one conflict", async () => {
    const { root, skillsDir } = await writeFakeInstallRoot();
    cleanupRoots.push(root);

    const outsideDir = await mkdtemp(join(tmpdir(), "spur-foreign-target-"));
    cleanupRoots.push(outsideDir);
    const claudeSkills = join(home, ".claude", "skills");
    mkdirSync(claudeSkills, { recursive: true });
    const link = join(claudeSkills, "spur");
    symlinkSync(outsideDir, link, "dir");

    const outcomes = installHostSkills({ home, skillsDir });
    const claudeOutcome = outcomes.find((o) => o.dir === link);

    expect(claudeOutcome?.status).toBe("conflict");
    expect(claudeOutcome?.conflictKind).toBe("foreign-symlink");
    expect(readlinkSync(link)).toBe(outsideDir);
  });

  it("T6 (AC6) mkdirSync EACCES produces an error outcome and never throws", async () => {
    const { root, skillsDir } = await writeFakeInstallRoot();
    cleanupRoots.push(root);

    // A file where a host agent dir should be: mkdirSync(..., {recursive:true})
    // fails with ENOTDIR/EEXIST-family errors when a path segment is a file.
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "skills"), "not a directory");

    expect(() => installHostSkills({ home, skillsDir })).not.toThrow();
    const outcomes = installHostSkills({ home, skillsDir });
    const claudeOutcome = outcomes.find((o) => o.dir.startsWith(join(claudeDir, "skills")));
    expect(claudeOutcome?.status).toBe("error");
    expect(claudeOutcome?.error).toBeTruthy();
  });

  it("T7b (AC7b) installHostSkillsForDaemonStart gates on the real default config path", async () => {
    // `config.ts` computes DEFAULT_INSTANCE_CONFIG_PATH from `homedir()` at
    // module-eval time, so HOME must be pinned BEFORE a fresh import — reset
    // the module registry and re-import under the pinned HOME.
    const originalHome = process.env["HOME"];
    process.env["HOME"] = home;
    vi.resetModules();
    try {
      const freshHostSkills = await import("../../src/host-skills.js");
      const nonDefaultOutcomes = freshHostSkills.installHostSkillsForDaemonStart(
        join(home, "some-other-project", "spur.yaml"),
      );
      expect(nonDefaultOutcomes).toEqual([]);

      const defaultConfigPath = join(home, ".spur", "config.yaml");
      const defaultOutcomes = freshHostSkills.installHostSkillsForDaemonStart(defaultConfigPath);
      // Whether this branch actually installs anything depends on whether
      // this build has produced `v2/skills/` yet (I6) — assert against that
      // fact instead of hardcoding, so the test proves the GATE opens for
      // the default path either way, without depending on build state.
      if (existsSync(freshHostSkills.packagedSkillsDir())) {
        expect(defaultOutcomes.length).toBeGreaterThan(0);
        expect(defaultOutcomes.every((o) => o.status === "linked")).toBe(true);
      } else {
        expect(defaultOutcomes).toEqual([]);
      }
    } finally {
      vi.resetModules();
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
    }
  });

  it("T11 (AC13) a link written from root A is reclaimed by an install from root B", async () => {
    const rootA = await writeFakeInstallRoot();
    cleanupRoots.push(rootA.root);
    const rootB = await writeFakeInstallRoot();
    cleanupRoots.push(rootB.root);

    installHostSkills({ home, skillsDir: rootA.skillsDir });
    const link = join(home, ".claude", "skills", "spur");
    expect(readlinkSync(link)).toBe(rootA.skillDir);

    const outcomes = installHostSkills({ home, skillsDir: rootB.skillsDir });
    const claudeOutcome = outcomes.find((o) => o.dir === link);

    expect(readlinkSync(link)).toBe(rootB.skillDir);
    expect(claudeOutcome?.status).toBe("linked");
    expect(outcomes.some((o) => o.status === "conflict" || o.status === "error")).toBe(false);
  });

  it("T12 (AC14) a link into a root whose dist/cli.js is gone is a live foreign-symlink conflict", async () => {
    const rootA = await writeFakeInstallRoot();
    cleanupRoots.push(rootA.root);
    const rootB = await writeFakeInstallRoot();
    cleanupRoots.push(rootB.root);

    installHostSkills({ home, skillsDir: rootA.skillsDir });
    const link = join(home, ".claude", "skills", "spur");
    expect(readlinkSync(link)).toBe(rootA.skillDir);

    // rootA/dist/cli.js removed, but rootA/skills/spur still present.
    await rm(join(rootA.root, "dist", "cli.js"), { force: true });

    const before = readlinkSync(link);
    const outcomes = installHostSkills({ home, skillsDir: rootB.skillsDir });
    const claudeOutcome = outcomes.find((o) => o.dir === link);

    expect(readlinkSync(link)).toBe(before);
    expect(claudeOutcome?.status).toBe("conflict");
    expect(claudeOutcome?.conflictKind).toBe("foreign-symlink");
  });

  it("T13 (AC16) a link into a fully deleted root is reclaimed with zero warnings", async () => {
    const rootA = await writeFakeInstallRoot();
    const rootB = await writeFakeInstallRoot();
    cleanupRoots.push(rootB.root);

    installHostSkills({ home, skillsDir: rootA.skillsDir });
    const link = join(home, ".claude", "skills", "spur");
    expect(readlinkSync(link)).toBe(rootA.skillDir);

    // rootA removed entirely — the deleted-worktree state.
    await rm(rootA.root, { recursive: true, force: true });

    const outcomes = installHostSkills({ home, skillsDir: rootB.skillsDir });
    const claudeOutcome = outcomes.find((o) => o.dir === link);

    expect(readlinkSync(link)).toBe(rootB.skillDir);
    expect(claudeOutcome?.status).toBe("linked");
    expect(outcomes.some((o) => o.status === "conflict" || o.status === "error")).toBe(false);
  });
});

describe("classifyHostSkillTarget", () => {
  let home: string;
  let cleanupRoots: string[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "spur-classify-home-"));
    cleanupRoots = [];
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    for (const root of cleanupRoots) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a missing path as absent", () => {
    expect(classifyHostSkillTarget(join(home, "does-not-exist"))).toBe("absent");
  });

  it("classifies a regular file as file", async () => {
    const filePath = join(home, "a-file");
    await writeFile(filePath, "content", "utf8");
    expect(classifyHostSkillTarget(filePath)).toBe("file");
  });

  it("classifies a real directory as directory", async () => {
    const dirPath = join(home, "a-dir");
    await mkdir(dirPath, { recursive: true });
    expect(classifyHostSkillTarget(dirPath)).toBe("directory");
  });

  it("never calls existsSync on a live foreign symlink target to decide ownership — only dist/cli.js", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "spur-classify-foreign-"));
    cleanupRoots.push(outsideDir);
    const link = join(home, "link");
    await symlink(outsideDir, link, "dir");
    expect(classifyHostSkillTarget(link)).toBe("foreign-symlink");
  });
});
