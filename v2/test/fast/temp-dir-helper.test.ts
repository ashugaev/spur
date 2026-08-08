import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTrackedTempDirs, createTempDir } from "../helpers/common.js";

// node's os.tmpdir() falls back TMPDIR -> TMP -> TEMP -> "/tmp" on this
// platform, so all three must be pinned/restored to keep the test hermetic.
// HOME is included so the symlink tests below can point homedir() at a
// fabricated ~/.spur without leaking into any other test in this file.
const savedEnv = {
  TMPDIR: process.env.TMPDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
  HOME: process.env.HOME,
};

function setTmpEnv(dir: string): void {
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
}

// Each test's own mkdtempSync scratch root (distinct from whatever
// createTempDir allocates inside it) is registered here and swept in
// afterEach, so a failing assertion mid-test can't leak it — the exact
// failure mode this file exists to guard against.
const scratchRoots: string[] = [];

function newScratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "spur-helper-test-"));
  scratchRoots.push(dir);
  return dir;
}

afterEach(async () => {
  if (savedEnv.TMPDIR === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = savedEnv.TMPDIR;
  }
  if (savedEnv.TMP === undefined) {
    delete process.env.TMP;
  } else {
    process.env.TMP = savedEnv.TMP;
  }
  if (savedEnv.TEMP === undefined) {
    delete process.env.TEMP;
  } else {
    process.env.TEMP = savedEnv.TEMP;
  }
  if (savedEnv.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedEnv.HOME;
  }
  await cleanupTrackedTempDirs();
  await Promise.all(scratchRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createTempDir", () => {
  it("creates a dir under TMPDIR and not under ~/.spur", async () => {
    const scratchRoot = newScratchRoot();
    setTmpEnv(scratchRoot);

    const dir = await createTempDir("spur-probe-");

    expect(resolve(dir).startsWith(resolve(scratchRoot))).toBe(true);
    expect(resolve(dir).startsWith(resolve(join(homedir(), ".spur")))).toBe(false);
  });

  it("throws when TMPDIR has an ancestor spur.yaml", async () => {
    const scratchRoot = newScratchRoot();
    writeFileSync(join(scratchRoot, "spur.yaml"), "projects: {}\n");
    const nested = join(scratchRoot, "nested");
    mkdirSync(nested);
    setTmpEnv(nested);

    await expect(createTempDir("spur-probe-")).rejects.toThrow(/spur\.yaml/);
  });

  it("throws when TMPDIR is $HOME (an ancestor of ~/.spur)", async () => {
    setTmpEnv(homedir());

    await expect(createTempDir("spur-probe-")).rejects.toThrow(/~\/\.spur|\.spur/);
  });

  it("throws when TMPDIR is inside ~/.spur", async () => {
    setTmpEnv(join(homedir(), ".spur", "worktrees"));

    await expect(createTempDir("spur-probe-")).rejects.toThrow(/\.spur/);
  });

  it("throws when TMPDIR is symlinked into a real ~/.spur/worktrees (resolveReal must follow it)", async () => {
    const scratchRoot = newScratchRoot();
    const fakeHome = join(scratchRoot, "home");
    const realWorktrees = join(fakeHome, ".spur", "worktrees");
    mkdirSync(realWorktrees, { recursive: true });
    process.env.HOME = fakeHome;
    const link = join(scratchRoot, "lnk");
    symlinkSync(realWorktrees, link);
    setTmpEnv(link);

    await expect(createTempDir("spur-probe-")).rejects.toThrow(/\.spur/);
  });

  it("throws when TMPDIR is symlinked into a spur.yaml tree (resolveReal must follow it)", async () => {
    const scratchRoot = newScratchRoot();
    const realTree = join(scratchRoot, "real-tree");
    mkdirSync(realTree, { recursive: true });
    writeFileSync(join(realTree, "spur.yaml"), "projects: {}\n");
    const nested = join(realTree, "nested");
    mkdirSync(nested);
    const link = join(scratchRoot, "lnk-yaml");
    symlinkSync(nested, link);
    setTmpEnv(link);

    await expect(createTempDir("spur-probe-")).rejects.toThrow(/spur\.yaml/);
  });

  it("throws when TMPDIR is the filesystem root (root-as-ancestor-of-everything)", async () => {
    setTmpEnv("/");

    // The rejection must be the ~/.spur ancestor guard, not a generic
    // mkdtemp permission error (which a non-root process would also get at
    // "/" but which says nothing about .spur) — that distinguishes "the
    // guard fired" from "mkdtemp happened to fail anyway".
    await expect(createTempDir("spur-probe-")).rejects.toThrow(/\.spur/);
  });

  it("throws with the wrapper's own text and the root in the message when TMPDIR does not exist", async () => {
    const scratchRoot = newScratchRoot();
    const missing = join(scratchRoot, "does-not-exist");
    setTmpEnv(missing);

    // Pins the wrapper itself, not just the raw ENOENT text it wraps (which
    // already contains the missing path and would pass even if the wrapper
    // were deleted and mkdtemp's own error propagated unchanged).
    await expect(createTempDir("spur-probe-")).rejects.toThrow(
      /Failed to create a temp dir under TMPDIR=/,
    );
    await expect(createTempDir("spur-probe-")).rejects.toThrow(
      new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    await expect(createTempDir("spur-probe-")).rejects.toMatchObject({
      cause: expect.anything(),
    });
  });

  it("cleanupTrackedTempDirs removes every dir created since the last cleanup, and is idempotent", async () => {
    const scratchRoot = newScratchRoot();
    setTmpEnv(scratchRoot);

    const a = await createTempDir("spur-probe-");
    const b = await createTempDir("spur-probe-");

    await cleanupTrackedTempDirs();

    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);

    // idempotent: calling again with nothing tracked must not throw.
    await expect(cleanupTrackedTempDirs()).resolves.toBeUndefined();
  });
});
