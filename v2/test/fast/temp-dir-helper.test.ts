import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTrackedTempDirs, createTempDir } from "../helpers/common.js";

// node's os.tmpdir() falls back TMPDIR -> TMP -> TEMP -> "/tmp" on this
// platform, so all three must be pinned/restored to keep the test hermetic.
const savedEnv = {
  TMPDIR: process.env.TMPDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
};

function setTmpEnv(dir: string): void {
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
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
  await cleanupTrackedTempDirs();
});

describe("createTempDir", () => {
  it("creates a dir under TMPDIR and not under ~/.spur", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "spur-helper-test-"));
    setTmpEnv(scratchRoot);

    const dir = await createTempDir("spur-probe-");

    expect(resolve(dir).startsWith(resolve(scratchRoot))).toBe(true);
    expect(resolve(dir).startsWith(resolve(join(homedir(), ".spur")))).toBe(false);

    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("throws when TMPDIR has an ancestor spur.yaml", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "spur-helper-test-"));
    writeFileSync(join(scratchRoot, "spur.yaml"), "projects: {}\n");
    const nested = join(scratchRoot, "nested");
    mkdirSync(nested);
    setTmpEnv(nested);

    await expect(createTempDir("spur-probe-")).rejects.toThrow(/spur\.yaml/);

    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("throws when TMPDIR is $HOME (an ancestor of ~/.spur)", async () => {
    setTmpEnv(homedir());

    await expect(createTempDir("spur-probe-")).rejects.toThrow(/~\/\.spur|\.spur/);
  });

  it("throws when TMPDIR is inside ~/.spur", async () => {
    setTmpEnv(join(homedir(), ".spur", "worktrees"));

    await expect(createTempDir("spur-probe-")).rejects.toThrow(/\.spur/);
  });

  it("throws with the root in the message when TMPDIR does not exist", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "spur-helper-test-"));
    const missing = join(scratchRoot, "does-not-exist");
    setTmpEnv(missing);

    await expect(createTempDir("spur-probe-")).rejects.toThrow(
      new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("cleanupTrackedTempDirs removes every dir created since the last cleanup, and is idempotent", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "spur-helper-test-"));
    setTmpEnv(scratchRoot);

    const a = await createTempDir("spur-probe-");
    const b = await createTempDir("spur-probe-");

    await cleanupTrackedTempDirs();

    const { existsSync } = await import("node:fs");
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);

    // idempotent: calling again with nothing tracked must not throw.
    await expect(cleanupTrackedTempDirs()).resolves.toBeUndefined();

    await rm(scratchRoot, { recursive: true, force: true });
  });
});
