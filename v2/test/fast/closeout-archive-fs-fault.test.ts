// Faked node:fs readdirSync result: a Dirent whose is*() are all false (DT_UNKNOWN), which this
// host's filesystem cannot produce on demand. Matched by directory name; other calls pass through.
import type * as NodeFs from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCloseoutArchive } from "../../src/closeout-archive.js";

const FAULT_DIR = "fault-root";
// Runs right before the walker opens a file whose path ends with `match`, then after fstat lies.
const hooks = vi.hoisted(() => ({
  beforeOpen: null as null | { match: string; run: () => void },
  fakeSize: null as null | number,
  procFails: false,
  inodes: null as null | { match: string; values: bigint[] },
  beforeRealpath: null as null | { match: string; run: () => void },
}));

function unknownDirent(name: string): NodeFs.Dirent {
  return {
    name,
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as unknown as NodeFs.Dirent;
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    openSync: ((...args: unknown[]) => {
      const path = args[0];
      const hook = hooks.beforeOpen;
      if (hook && typeof path === "string" && path.endsWith(hook.match)) {
        hooks.beforeOpen = null;
        hook.run();
      }
      return (actual.openSync as (...a: unknown[]) => number)(...args);
    }) as typeof NodeFs.openSync,
    realpathSync: Object.assign(
      ((...args: unknown[]) => {
        const path = args[0];
        const hook = hooks.beforeRealpath;
        if (hook && typeof path === "string" && path.endsWith(hook.match)) {
          hooks.beforeRealpath = null;
          hook.run();
        }
        return (actual.realpathSync as (...a: unknown[]) => unknown)(...args);
      }) as typeof NodeFs.realpathSync,
      { native: actual.realpathSync.native },
    ),
    lstatSync: ((...args: unknown[]) => {
      const stat = (actual.lstatSync as (...a: unknown[]) => NodeFs.BigIntStats)(...args);
      const hook = hooks.inodes;
      const path = args[0];
      const options = args[1] as { bigint?: boolean } | undefined;
      if (!hook || !options?.bigint || typeof path !== "string" || !path.endsWith(hook.match)) {
        return stat;
      }
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        ino: hook.values.shift() ?? stat.ino,
      });
    }) as typeof NodeFs.lstatSync,
    readlinkSync: ((...args: unknown[]) => {
      const path = args[0];
      if (hooks.procFails && typeof path === "string" && path.startsWith("/proc/self/fd/")) {
        throw new Error("simulated missing /proc");
      }
      return (actual.readlinkSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof NodeFs.readlinkSync,
    fstatSync: ((...args: unknown[]) => {
      const stat = (actual.fstatSync as (...a: unknown[]) => NodeFs.Stats)(...args);
      if (hooks.fakeSize === null) return stat;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        size: hooks.fakeSize,
      });
    }) as typeof NodeFs.fstatSync,
    readdirSync: ((...args: unknown[]) => {
      const path = args[0];
      if (typeof path === "string" && path.endsWith(FAULT_DIR)) {
        return ["real.txt", "link.txt", "gone.txt"].map(unknownDirent);
      }
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof NodeFs.readdirSync,
  };
});

let base = "";

afterEach(() => {
  hooks.beforeOpen = null;
  hooks.fakeSize = null;
  hooks.procFails = false;
  hooks.beforeRealpath = null;
  hooks.inodes = null;
  rmSync(base, { recursive: true, force: true });
});

function archive(root: string, include: string[], maxBytes = 1000) {
  const sessionDir = join(base, "sessions", "s1");
  mkdirSync(sessionDir, { recursive: true });
  return writeCloseoutArchive({
    sessionDir,
    sessionId: "s1",
    project: "p",
    completedAt: "2026-01-01T00:00:00.000Z",
    links: [],
    snapshotVersion: null,
    headSha: null,
    roots: { artifacts: root, work: null, workspace: null },
    include,
    maxBytes,
  });
}

describe("closeout archive with unknown dirent types", () => {
  it("classifies via lstat: file copied, symlink dropped, vanished entry unreadable", async () => {
    base = mkdtempSync(join(tmpdir(), "closeout-fault-"));
    const root = join(base, FAULT_DIR);
    mkdirSync(root);
    writeFileSync(join(root, "real.txt"), "data");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
    const sessionDir = join(base, "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    const manifest = await writeCloseoutArchive({
      sessionDir,
      sessionId: "s1",
      project: "p",
      completedAt: "2026-01-01T00:00:00.000Z",
      links: [],
      snapshotVersion: null,
      headSha: null,
      roots: { artifacts: root, work: null, workspace: null },
      include: ["artifacts:**"],
      maxBytes: 1000,
    });
    expect(manifest.files.map((f) => f.path)).toEqual(["real.txt"]);
    expect(manifest.skipped).toEqual([
      { root: "artifacts", path: "gone.txt", bytes: 0, reason: "unreadable" },
    ]);
  });

  it("skips a file whose ancestor dir became a symlink between walk and open", () => {
    base = mkdtempSync(join(tmpdir(), "closeout-fault-"));
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, "sub", "f.txt"), "inside");
    writeFileSync(join(outside, "f.txt"), "secret");
    hooks.beforeOpen = {
      match: "sub/f.txt",
      run: () => {
        renameSync(join(root, "sub"), join(root, "sub-moved"));
        symlinkSync(outside, join(root, "sub"));
      },
    };
    const manifest = archive(root, ["artifacts:**"]);
    expect(manifest.files).toEqual([]);
    expect(manifest.skipped).toEqual([
      { root: "artifacts", path: "sub/f.txt", bytes: 6, reason: "changed" },
    ]);
  });

  it("does not hang on a file replaced by a FIFO before open", () => {
    base = mkdtempSync(join(tmpdir(), "closeout-fault-"));
    const require = createRequire(new URL("../../../packages/web/package.json", import.meta.url));
    const probe = fileURLToPath(new URL("../fixtures/closeout-fifo-probe.ts", import.meta.url));
    // Parent-enforced timeout: a blocking open would hang a same-process sync archive for good.
    const result = spawnSync(process.execPath, ["--import", require.resolve("tsx"), probe, base], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      files: [],
      skipped: [{ root: "artifacts", path: "f.txt", bytes: 0, reason: "unreadable" }],
    });
  });

  it("skips a file that grew past the budget after its size was read", () => {
    base = mkdtempSync(join(tmpdir(), "closeout-fault-"));
    const root = join(base, "root");
    mkdirSync(root);
    writeFileSync(join(root, "f.txt"), "x".repeat(100));
    hooks.fakeSize = 2;
    const manifest = archive(root, ["artifacts:**"], 10);
    expect(manifest.files).toEqual([]);
    expect(manifest.skipped).toEqual([
      { root: "artifacts", path: "f.txt", bytes: 11, reason: "max_bytes" },
    ]);
  });

  it("without /proc, files are listed as unverified and never read", () => {
    base = mkdtempSync(join(tmpdir(), "closeout-fault-"));
    const root = join(base, "root");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "f.txt"), "inside");
    hooks.procFails = true;
    const manifest = archive(root, ["artifacts:**"]);
    expect(manifest.files).toEqual([]);
    expect(manifest.skipped).toEqual([
      { root: "artifacts", path: "sub/f.txt", bytes: 6, reason: "unverified" },
    ]);
  });

  it("treats a root swapped for a symlink between lstat and realpath as missing", () => {
    base = mkdtempSync(join(tmpdir(), "closeout-fault-"));
    const artifacts = join(base, "artifacts");
    const outside = join(base, "outside");
    mkdirSync(join(artifacts, ".spur-work"), { recursive: true });
    mkdirSync(join(outside, ".spur-work"), { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret");
    writeFileSync(join(outside, ".spur-work", "secret.md"), "secret");
    hooks.beforeRealpath = {
      match: "/artifacts",
      run: () => {
        renameSync(artifacts, join(base, "artifacts-moved"));
        symlinkSync(outside, artifacts);
      },
    };
    const sessionDir = join(base, "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    const manifest = writeCloseoutArchive({
      sessionDir,
      sessionId: "s1",
      project: "p",
      completedAt: "2026-01-01T00:00:00.000Z",
      links: [],
      snapshotVersion: null,
      headSha: null,
      roots: { artifacts, work: join(artifacts, ".spur-work"), workspace: null },
      include: ["work:**", "artifacts:**"],
      maxBytes: 1000,
    });
    expect(manifest.files).toEqual([]);
    expect(manifest.missingRoots).toEqual(["artifacts", "work"]);
  });

  it("compares root inodes as bigint: ids differing only above 2^53 mark the root missing", () => {
    base = mkdtempSync(join(tmpdir(), "closeout-fault-"));
    const root = join(base, "root");
    mkdirSync(root);
    writeFileSync(join(root, "f.txt"), "data");
    // As numbers these two round to the same value; as bigint they differ.
    expect(Number(2n ** 53n)).toBe(Number(2n ** 53n + 1n));
    hooks.inodes = { match: "/root", values: [2n ** 53n, 2n ** 53n + 1n] };
    const manifest = archive(root, ["artifacts:**"]);
    expect(manifest.files).toEqual([]);
    expect(manifest.missingRoots).toEqual(["artifacts"]);
  });
});
