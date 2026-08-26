import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyHostSkillTarget,
  installHostSkills,
  renderHostSkillWarnings,
} from "../../src/host-skills.js";

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

  it("T1-new (AC1, AC2) fresh home with no agent dirs: nothing is created, everything is skipped", async () => {
    const { root, skillsDir } = await writeFakeInstallRoot();
    cleanupRoots.push(root);

    const outcomes = installHostSkills({ home, skillsDir });

    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(readdirSync(home)).toEqual([]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === "skipped" && o.reason === "host-dir-absent")).toBe(
      true,
    );
  });

  it("T15 (AC4) only .claude/skills exists: links there, skips .codex", async () => {
    const { root, skillsDir, skillDir } = await writeFakeInstallRoot();
    cleanupRoots.push(root);
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });

    const outcomes = installHostSkills({ home, skillsDir });

    const claudeOutcome = outcomes.find((o) => o.dir === join(home, ".claude", "skills", "spur"));
    expect(claudeOutcome?.status).toBe("linked");
    expect(readlinkSync(join(home, ".claude", "skills", "spur"))).toBe(skillDir);
    const codexOutcome = outcomes.find((o) => o.skill === "spur" && o.dir.includes(".codex"));
    expect(codexOutcome?.status).toBe("skipped");
    expect(codexOutcome?.reason).toBe("host-dir-absent");
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("T16 (AC5) a symlinked skills dir counts as present and gets the link", async () => {
    const { root, skillsDir, skillDir } = await writeFakeInstallRoot();
    cleanupRoots.push(root);
    const realDir = await mkdtemp(join(tmpdir(), "spur-host-skills-symlinked-root-"));
    cleanupRoots.push(realDir);
    mkdirSync(join(home, ".claude"), { recursive: true });
    symlinkSync(realDir, join(home, ".claude", "skills"), "dir");

    const outcomes = installHostSkills({ home, skillsDir });

    const claudeOutcome = outcomes.find((o) => o.dir === join(home, ".claude", "skills", "spur"));
    expect(claudeOutcome?.status).toBe("linked");
    expect(readlinkSync(join(realDir, "spur"))).toBe(skillDir);
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
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(home, ".codex", "skills"), { recursive: true });

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

  // `chmod` raises no EACCES for root (uid 0) — a permission-based test
  // running under root would go GREEN having exercised nothing. Skip
  // visibly rather than pass silently; see A3 below for the same guard.
  it.skipIf(process.getuid?.() === 0)(
    "T6-new (AC6) an existing but unwritable skills dir yields an error outcome, never throws",
    async () => {
      const { root, skillsDir } = await writeFakeInstallRoot();
      cleanupRoots.push(root);

      const claudeSkills = join(home, ".claude", "skills");
      mkdirSync(claudeSkills, { recursive: true });
      chmodSync(claudeSkills, 0o555);

      try {
        expect(() => installHostSkills({ home, skillsDir })).not.toThrow();
        const outcomes = installHostSkills({ home, skillsDir });
        const claudeOutcome = outcomes.find((o) => o.dir === join(claudeSkills, "spur"));
        expect(claudeOutcome?.status).toBe("error");
        expect(claudeOutcome?.error).toBeTruthy();
      } finally {
        chmodSync(claudeSkills, 0o755);
      }
    },
  );

  it("T7b (AC7b) installHostSkillsForDaemonStart gates on the real default config path", async () => {
    // `config.ts` computes DEFAULT_INSTANCE_CONFIG_PATH from `homedir()` at
    // module-eval time, so HOME must be pinned BEFORE a fresh import — reset
    // the module registry and re-import under the pinned HOME.
    const originalHome = process.env["HOME"];
    process.env["HOME"] = home;
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(home, ".codex", "skills"), { recursive: true });
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
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });

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
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });

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
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });

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

  it("T14 (AC3) renderHostSkillWarnings collapses N absent-root skips into 2 lines, one per root", async () => {
    const { root, skillsDir } = await writeFakeInstallRoot();
    cleanupRoots.push(root);
    // Two packaged skills so the collapse (one line per ROOT, not per
    // skill) is actually exercised — with a single skill, one-per-root and
    // one-per-skill produce the same line count and the test proves nothing.
    await mkdir(join(skillsDir, "second-skill"), { recursive: true });
    await writeFile(
      join(skillsDir, "second-skill", "SKILL.md"),
      "---\nname: second-skill\n---\n",
      "utf8",
    );

    const outcomes = installHostSkills({ home, skillsDir });
    expect(outcomes).toHaveLength(4);

    const lines = renderHostSkillWarnings(outcomes);

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain("does not create it");
      expect(line).toContain("spur reinit");
    }
    expect(lines.some((line) => line.includes(join(home, ".claude", "skills")))).toBe(true);
    expect(lines.some((line) => line.includes(join(home, ".codex", "skills")))).toBe(true);
  });

  it("A1: an empty resolved HOME (relative) is rejected — nothing created anywhere, warned once", async () => {
    const { root, skillsDir } = await writeFakeInstallRoot();
    cleanupRoots.push(root);
    const outcomes = installHostSkills({ home: "", skillsDir });

    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.every((o) => o.status === "skipped" && o.reason === "home-not-absolute")).toBe(
      true,
    );
    // Nothing was created relative to process.cwd() either.
    expect(existsSync(join(process.cwd(), ".claude"))).toBe(false);
    expect(existsSync(join(process.cwd(), ".codex"))).toBe(false);

    const lines = renderHostSkillWarnings(outcomes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not an absolute path");
    expect(lines[0]).toContain("spur reinit");
  });

  // Same root-uid guard as T6-new: `chmod 000` grants root read/traverse
  // regardless, so this test would go GREEN having exercised nothing.
  it.skipIf(process.getuid?.() === 0)(
    "A3: EACCES on a link's resolved target classifies foreign, not dangling — link is never touched",
    async () => {
      const claudeSkills = join(home, ".claude", "skills");
      mkdirSync(claudeSkills, { recursive: true });
      const parent = await mkdtemp(join(tmpdir(), "spur-host-skills-eacces-parent-"));
      // The resolved target's PARENT is itself named `skills`, matching the
      // ownership pattern `<root>/skills/<name>` — this is the exact shape
      // that a buggy `existsSync`-based check would misread as dangling and
      // reclaim as Spur-owned once EACCES makes it read `false`.
      const target = join(parent, "skills", "existing-target");
      await mkdir(target, { recursive: true });
      const link = join(claudeSkills, "spur");
      symlinkSync(target, link, "dir");
      chmodSync(parent, 0o000);

      try {
        expect(classifyHostSkillTarget(link)).toBe("foreign-symlink");

        const { root, skillsDir } = await writeFakeInstallRoot();
        cleanupRoots.push(root);
        const outcomes = installHostSkills({ home, skillsDir });
        const claudeOutcome = outcomes.find((o) => o.dir === link);

        expect(claudeOutcome?.status).toBe("conflict");
        expect(claudeOutcome?.conflictKind).toBe("foreign-symlink");
        expect(readlinkSync(link)).toBe(target);

        const lines = renderHostSkillWarnings(outcomes);
        expect(lines.some((line) => line.includes(link) && line.includes("conflict"))).toBe(true);
      } finally {
        chmodSync(parent, 0o755);
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  // Same root-uid guard: chmod 000 grants root traversal regardless.
  it.skipIf(process.getuid?.() === 0)(
    "an unreadable root (EACCES on a parent) is skipped as host-dir-unreadable, distinct from host-dir-absent — never sent to mkdir -p",
    async () => {
      const claudeDir = join(home, ".claude");
      mkdirSync(join(claudeDir, "skills"), { recursive: true });
      chmodSync(claudeDir, 0o000);

      try {
        const { root, skillsDir } = await writeFakeInstallRoot();
        cleanupRoots.push(root);
        const outcomes = installHostSkills({ home, skillsDir });

        const claudeOutcome = outcomes.find((o) => o.dir.includes(join(".claude", "skills")));
        expect(claudeOutcome?.status).toBe("skipped");
        expect(claudeOutcome?.reason).toBe("host-dir-unreadable");
        const codexOutcome = outcomes.find((o) => o.dir.includes(join(".codex", "skills")));
        expect(codexOutcome?.status).toBe("skipped");
        expect(codexOutcome?.reason).toBe("host-dir-absent");

        const lines = renderHostSkillWarnings(outcomes);
        const claudeLine = lines.find((line) => line.includes(join(home, ".claude", "skills")));
        const codexLine = lines.find((line) => line.includes(join(home, ".codex", "skills")));
        expect(claudeLine).toContain("permission denied");
        expect(claudeLine).not.toContain("mkdir -p");
        expect(codexLine).toContain("mkdir -p");
      } finally {
        chmodSync(claudeDir, 0o755);
      }
    },
  );
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

  it("classifies a RELATIVE dangling link text as owned (self-referential ELOOP, proven) — the resolved path decides, not the raw text", async () => {
    // A relative dangling text like `spur` or `./spur` has no `skills`
    // component of its own; only the RESOLVED path (which does, because the
    // link itself lives under a `.../skills/` dir) may decide ownership.
    // This link is self-referential (resolvedTarget === link), which is the
    // ONE proven-dangling ELOOP shape — `statSync` raises ELOOP here, not
    // ENOENT, so this test is what actually pins the ELOOP branch, even
    // though its name predates that fact.
    const skillsSubdir = join(home, "some-root", "skills");
    await mkdir(skillsSubdir, { recursive: true });
    const link = join(skillsSubdir, "spur");
    // Self-referential relative dangling link: resolves under the same
    // `skills/` dir but never points at a real path.
    await symlink("spur", link);
    expect(classifyHostSkillTarget(link)).toBe("owned");
  });

  it("classifies a deep RESOLVABLE symlink chain (ELOOP from depth, not a loop) as foreign, never as dangling", async () => {
    // Linux raises ELOOP once a chain exceeds ~40 hops even when every link
    // resolves to something real at the end — this must NOT be inferred as
    // proof of non-existence. Reproduces the reported shape exactly: the
    // link's OWN immediate target (one hop, what `resolvedTarget` actually
    // holds — `statSync` resolves the FULL chain, but the ownership check
    // reads only this one hop) sits under a dir literally named `skills`,
    // which is what a buggy "any ELOOP is dangling" branch would misread as
    // Spur's own `<root>/skills/<name>` shape and reclaim. The chain then
    // continues another 59 hops down to a real directory with content.
    const claudeSkills = join(home, ".claude", "skills");
    await mkdir(claudeSkills, { recursive: true });
    const dotsSkills = join(home, "dots", "skills");
    await mkdir(dotsSkills, { recursive: true });
    const realTarget = join(home, "real-target");
    await mkdir(realTarget, { recursive: true });
    await writeFile(join(realTarget, "marker.txt"), "still here", "utf8");

    let previous = realTarget;
    for (let i = 59; i >= 1; i--) {
      const hop = join(dotsSkills, `a${i}`);
      await symlink(previous, hop, "dir");
      previous = hop;
    }
    const link = join(claudeSkills, "spur");
    await symlink(previous, link, "dir");

    expect(classifyHostSkillTarget(link)).toBe("foreign-symlink");
    // The real target and its content, and the chain head, must be
    // untouched — proves this never got misread as owned-and-reclaimable.
    expect(existsSync(join(realTarget, "marker.txt"))).toBe(true);
    expect(readlinkSync(link)).toBe(join(dotsSkills, "a1"));
  });
});
