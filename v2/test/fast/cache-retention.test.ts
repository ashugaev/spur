import type * as ChildProcess from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ProcessTreeModule from "../../src/process-tree.js";
import type { AppConfig } from "../../src/types.js";
import type { InstanceConfigReadResult } from "../../src/config.js";
import type {
  CacheEntry,
  CacheEntryClass,
  EntryOwnership,
  LivenessSnapshot,
} from "../../src/cache-retention.js";

const { execFileMock, canReadProcessTreeMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  canReadProcessTreeMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return { ...actual, execFile: execFileMock };
});

vi.mock("../../src/process-tree.js", async () => {
  const actual = await vi.importActual<typeof ProcessTreeModule>("../../src/process-tree.js");
  return { ...actual, canReadProcessTree: canReadProcessTreeMock };
});

const {
  ageDaysFor,
  classifyEntry,
  executePrune,
  GLOBAL_MIN_AGE_DAYS,
  BROWSER_REVISION_MIN_AGE_DAYS,
  planCachePrune,
  verdictFor,
} = await import("../../src/cache-retention.js");
const { snapshotProcesses } = await import("../../src/process-tree.js");

const DAY_MS = 86_400_000;

function makeEntry(overrides: Partial<CacheEntry> & { entryClass: CacheEntryClass }): CacheEntry {
  return {
    path: "/home/user/.npm/_cacache",
    rootId: "npm-cacache",
    sizeKb: 100,
    ageDays: 0,
    ...overrides,
  };
}

function makeOwnership(overrides: Partial<EntryOwnership> = {}): EntryOwnership {
  return { uid: 1000, isSymlink: false, ...overrides };
}

function makeLiveness(overrides: Partial<LivenessSnapshot> = {}): LivenessSnapshot {
  return {
    processTreeReadable: true,
    processListReadable: true,
    processes: [],
    sessionCwds: [],
    pinnedDirNames: new Set(),
    pinSourceCount: 1,
    instanceConfigOk: true,
    pinSourceNpxHashes: new Set(),
    ...overrides,
  };
}

function fakeInstanceConfig(
  dataDir: string,
  worktreeDir: string,
): Extract<InstanceConfigReadResult, { status: "ok" }> {
  return {
    status: "ok" as const,
    config: {
      configPath: join(dataDir, "config.yaml"),
      server: { host: "127.0.0.1", port: 4310 },
      dataDir,
      worktreeDir,
      projectsRoot: join(dataDir, "projects"),
      defaultAgent: "claude",
      tmux: { socketName: "spur-test" },
      projects: {},
    } as unknown as AppConfig,
  };
}

const MY_UID = 1000;

describe("classifyEntry", () => {
  it("maps a playwright revision dir name to browser-revision with the parsed dirName", () => {
    // AC4: browsers.json's "chromium-headless-shell" + revision "1208" pins
    // the on-disk dir "chromium_headless_shell-1208" — the same transform
    // (name.replace(/-/g,"_") + "-" + revision) that resolvePins applies.
    const expectedDirName = `${"chromium-headless-shell".replace(/-/g, "_")}-1208`;
    expect(expectedDirName).toBe("chromium_headless_shell-1208");
    expect(classifyEntry("playwright-browsers", "chromium_headless_shell-1208")).toEqual({
      kind: "browser-revision",
      browser: "chromium_headless_shell",
      revision: "1208",
      dirName: "chromium_headless_shell-1208",
    });
  });

  it("classifies the running-browser registry dir as browser-registry", () => {
    expect(classifyEntry("playwright-browsers", "b")).toEqual({ kind: "browser-registry" });
  });

  it("classifies a non-matching name in a playwright root as browser-registry (C4 fallback)", () => {
    expect(classifyEntry("playwright-browsers", "some-other-thing")).toEqual({
      kind: "browser-registry",
    });
  });

  it("classifies mcp-* in either playwright root as browser-profile", () => {
    expect(classifyEntry("playwright-browsers", "mcp-chrome-abc123")).toEqual({
      kind: "browser-profile",
    });
    expect(classifyEntry("playwright-mcp-profiles", "mcp-chrome-abc123")).toEqual({
      kind: "browser-profile",
    });
  });

  it("classifies npm-npx entries by hash", () => {
    expect(classifyEntry("npm-npx", "abcd1234")).toEqual({ kind: "npx-package", hash: "abcd1234" });
  });

  it("classifies xdg-cache entries as generic", () => {
    expect(classifyEntry("xdg-cache", "yarn")).toEqual({ kind: "generic", name: "yarn" });
  });

  it("classifies /tmp entries as tmp-entry", () => {
    expect(classifyEntry("tmp", "some-file")).toEqual({ kind: "tmp-entry", name: "some-file" });
  });
});

describe("ageDaysFor", () => {
  it("uses max(mtime, ctime), never atime", () => {
    const now = Date.now();
    const mtime = now - 10 * DAY_MS;
    const ctime = now - 3 * DAY_MS;
    // ctime is newer, so age must be 3 days, not 10.
    expect(ageDaysFor(mtime, ctime, now)).toBe(3);
  });
});

describe("verdictFor", () => {
  it("protects vendor-cache at 6 days and marks it prunable at the 7-day floor", () => {
    const liveness = makeLiveness();
    const at6 = makeEntry({
      entryClass: { kind: "vendor-cache" },
      ageDays: GLOBAL_MIN_AGE_DAYS - 1,
    });
    expect(verdictFor(at6, makeOwnership(), liveness, MY_UID)).toEqual({
      kind: "protected",
      reason: {
        kind: "too-recent",
        ageDays: GLOBAL_MIN_AGE_DAYS - 1,
        floorDays: GLOBAL_MIN_AGE_DAYS,
      },
    });
    const at7 = makeEntry({
      entryClass: { kind: "vendor-cache" },
      ageDays: GLOBAL_MIN_AGE_DAYS,
    });
    expect(verdictFor(at7, makeOwnership(), liveness, MY_UID)).toEqual({ kind: "prunable" });
  });

  it("AC1 (class boundary): only vendor-cache, npx-package, browser-revision are prunable; all others class-never-pruned", () => {
    const aged = (kind: CacheEntryClass) =>
      makeEntry({ entryClass: kind, ageDays: 9999, path: "/some/path", rootId: "npm-npx" });
    const liveness = makeLiveness({ pinSourceCount: 1 });

    expect(verdictFor(aged({ kind: "vendor-cache" }), makeOwnership(), liveness, MY_UID).kind).toBe(
      "prunable",
    );
    expect(
      verdictFor(aged({ kind: "npx-package", hash: "abc" }), makeOwnership(), liveness, MY_UID)
        .kind,
    ).toBe("prunable");
    expect(
      verdictFor(
        aged({
          kind: "browser-revision",
          browser: "chromium",
          revision: "1",
          dirName: "chromium-1",
        }),
        makeOwnership(),
        liveness,
        MY_UID,
      ).kind,
    ).toBe("prunable");

    for (const cls of [
      { kind: "browser-profile" } as CacheEntryClass,
      { kind: "browser-registry" } as CacheEntryClass,
      { kind: "generic", name: "whisper.cpp" } as CacheEntryClass,
      { kind: "tmp-entry", name: "scratch" } as CacheEntryClass,
    ]) {
      expect(verdictFor(aged(cls), makeOwnership(), makeLiveness(), MY_UID)).toEqual({
        kind: "protected",
        reason: { kind: "class-never-pruned" },
      });
    }
  });

  it("AC2/AC4: generic and tmp-entry names are class-never-pruned regardless of age", () => {
    const fixtures: Array<{
      rootId: "xdg-cache" | "tmp";
      path: string;
      entryClass: CacheEntryClass;
    }> = [
      ...["yarn", "whisper.cpp", "pip", "go-build", "uv"].map((name) => ({
        rootId: "xdg-cache" as const,
        path: `/home/user/.cache/${name}`,
        entryClass: { kind: "generic" as const, name },
      })),
      ...[
        "systemd-private-abc",
        "tmux-1000",
        ".X11-unix",
        "snap-private-tmp",
        "spur.yaml",
        "spur-worktree",
        "some-scratch-dir",
        "long-lived-socket",
      ].map((name) => ({
        rootId: "tmp" as const,
        path: `/tmp/${name}`,
        entryClass: { kind: "tmp-entry" as const, name },
      })),
    ];
    for (const { rootId, path, entryClass } of fixtures) {
      const entry = makeEntry({ path, rootId, entryClass, ageDays: 9999 });
      expect(verdictFor(entry, makeOwnership(), makeLiveness(), MY_UID)).toEqual({
        kind: "protected",
        reason: { kind: "class-never-pruned" },
      });
    }
  });

  it("AC3: browser-profile entries are class-never-pruned regardless of age or argv", () => {
    const entry = makeEntry({
      path: "/home/user/.cache/ms-playwright/mcp-chrome-abc123",
      rootId: "playwright-browsers",
      entryClass: { kind: "browser-profile" },
      ageDays: 9999,
    });
    const busy = makeLiveness({
      processes: [
        {
          pid: 4242,
          ppid: 1,
          rssKb: 0,
          elapsedSeconds: 0,
          args: `node cli.js --profile ${entry.path}`,
        },
      ],
    });
    expect(verdictFor(entry, makeOwnership(), busy, MY_UID)).toEqual({
      kind: "protected",
      reason: { kind: "class-never-pruned" },
    });
    const idle = makeLiveness({ processes: [] });
    expect(verdictFor(entry, makeOwnership(), idle, MY_UID)).toEqual({
      kind: "protected",
      reason: { kind: "class-never-pruned" },
    });
  });

  it("AC8: npx-package entry whose hash is in pinSourceNpxHashes returns pin-source", () => {
    const entry = makeEntry({
      path: "/home/user/.npm/_npx/abc123",
      rootId: "npm-npx",
      entryClass: { kind: "npx-package", hash: "abc123" },
      ageDays: 9999,
    });
    const withPin = makeLiveness({ pinSourceNpxHashes: new Set(["abc123"]) });
    expect(verdictFor(entry, makeOwnership(), withPin, MY_UID)).toEqual({
      kind: "protected",
      reason: { kind: "pin-source" },
    });
    const withoutPin = makeLiveness({ pinSourceNpxHashes: new Set() });
    expect(verdictFor(entry, makeOwnership(), withoutPin, MY_UID).kind).toBe("prunable");
  });

  it("protects pinned and recent browser revisions while allowing aged unpinned revisions", () => {
    const dirName = "chromium_headless_shell-1208";
    const revisionClass: CacheEntryClass = {
      kind: "browser-revision",
      browser: "chromium_headless_shell",
      revision: "1208",
      dirName,
    };
    const pinned = makeLiveness({ pinnedDirNames: new Set([dirName]), pinSourceCount: 1 });
    const unpinned = makeLiveness({ pinnedDirNames: new Set(), pinSourceCount: 1 });

    const aged400 = makeEntry({ entryClass: revisionClass, ageDays: 400 });
    expect(verdictFor(aged400, makeOwnership(), pinned, MY_UID)).toEqual({
      kind: "protected",
      reason: { kind: "pinned-revision", dirName },
    });
    expect(verdictFor(aged400, makeOwnership(), unpinned, MY_UID)).toEqual({ kind: "prunable" });

    const aged20 = makeEntry({ entryClass: revisionClass, ageDays: 20 });
    expect(verdictFor(aged20, makeOwnership(), unpinned, MY_UID)).toEqual({
      kind: "protected",
      reason: { kind: "too-recent", ageDays: 20, floorDays: BROWSER_REVISION_MIN_AGE_DAYS },
    });
  });

  it("protects browser revisions when no pin source resolves", () => {
    const revisionClass: CacheEntryClass = {
      kind: "browser-revision",
      browser: "chromium",
      revision: "1148",
      dirName: "chromium-1148",
    };
    const noPins = makeLiveness({ pinnedDirNames: new Set(), pinSourceCount: 0 });
    const aged400 = makeEntry({ entryClass: revisionClass, ageDays: 400 });
    expect(verdictFor(aged400, makeOwnership(), noPins, MY_UID)).toEqual({
      kind: "protected",
      reason: { kind: "pin-unresolved" },
    });
  });

  it("protects browser revisions when instance config does not resolve", () => {
    const revisionClass: CacheEntryClass = {
      kind: "browser-revision",
      browser: "chromium",
      revision: "1148",
      dirName: "chromium-1148",
    };
    const noInstanceConfig = makeLiveness({
      pinnedDirNames: new Set(),
      pinSourceCount: 3,
      instanceConfigOk: false,
    });
    const aged400 = makeEntry({ entryClass: revisionClass, ageDays: 400 });
    expect(verdictFor(aged400, makeOwnership(), noInstanceConfig, MY_UID)).toEqual({
      kind: "protected",
      reason: { kind: "pin-unresolved" },
    });
  });

  it("AC12: protects vendor-cache while a package manager is active", () => {
    const entry = makeEntry({
      path: "/home/user/.npm/_cacache",
      rootId: "npm-cacache",
      entryClass: { kind: "vendor-cache" },
      ageDays: 30,
    });
    const busy = makeLiveness({
      processes: [{ pid: 555, ppid: 1, rssKb: 0, elapsedSeconds: 0, args: "npm install left-pad" }],
    });
    expect(verdictFor(entry, makeOwnership(), busy, MY_UID)).toEqual({
      kind: "protected",
      reason: { kind: "package-manager-active", pid: 555 },
    });
    const idle = makeLiveness({
      processes: [{ pid: 555, ppid: 1, rssKb: 0, elapsedSeconds: 0, args: "node server.js" }],
    });
    expect(verdictFor(entry, makeOwnership(), idle, MY_UID)).toEqual({ kind: "prunable" });
  });

  it("AC12: protects every entry when the process tree is unreadable", () => {
    const entry = makeEntry({ entryClass: { kind: "vendor-cache" }, ageDays: 9999 });
    const unreadable = makeLiveness({ processTreeReadable: false });
    expect(verdictFor(entry, makeOwnership(), unreadable, MY_UID)).toEqual({
      kind: "protected",
      reason: { kind: "process-tree-unreadable" },
    });
  });

  it("AC12: protects symlinked and foreign-owned entries", () => {
    const entry = makeEntry({ entryClass: { kind: "vendor-cache" }, ageDays: 9999 });
    expect(verdictFor(entry, makeOwnership({ isSymlink: true }), makeLiveness(), MY_UID)).toEqual({
      kind: "protected",
      reason: { kind: "symlink" },
    });
    expect(verdictFor(entry, makeOwnership({ uid: 0 }), makeLiveness(), MY_UID)).toEqual({
      kind: "protected",
      reason: { kind: "not-owned", uid: 0 },
    });
  });

  it("AC12: check order — symlink fires before class-never-pruned, uid fires before process tree", () => {
    const genericEntry = makeEntry({
      path: "/home/user/.cache/yarn",
      rootId: "xdg-cache",
      entryClass: { kind: "generic", name: "yarn" },
      ageDays: 9999,
    });
    expect(
      verdictFor(genericEntry, makeOwnership({ isSymlink: true }), makeLiveness(), MY_UID),
    ).toEqual({ kind: "protected", reason: { kind: "symlink" } });

    expect(verdictFor(genericEntry, makeOwnership({ uid: 0 }), makeLiveness(), MY_UID)).toEqual({
      kind: "protected",
      reason: { kind: "not-owned", uid: 0 },
    });

    expect(
      verdictFor(
        genericEntry,
        makeOwnership(),
        makeLiveness({ processTreeReadable: false }),
        MY_UID,
      ),
    ).toEqual({ kind: "protected", reason: { kind: "process-tree-unreadable" } });
  });
});

describe("snapshotProcesses (real implementation, mocked execFile)", () => {
  beforeEach(() => execFileMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("parses pid/ppid/rss/etime/args and skips malformed lines", async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: unknown) => {
        const callback = (
          typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
        ) as (error: Error | null, result?: { stdout: string; stderr: string }) => void;
        callback(null, {
          stdout: "1 0 100 00:01 /sbin/init\n42 1 200 01:30 node server.js\nbogus-line\n",
          stderr: "",
        });
        return {} as ChildProcess.ChildProcess;
      },
    );
    const result = await snapshotProcesses();
    expect(result).toEqual({
      status: "ok",
      processes: [
        { pid: 1, ppid: 0, rssKb: 100, elapsedSeconds: 1, args: "/sbin/init" },
        { pid: 42, ppid: 1, rssKb: 200, elapsedSeconds: 90, args: "node server.js" },
      ],
    });
  });
});

describe("planCachePrune / executePrune (mkdtemp synthetic tree)", () => {
  let home: string;
  let tmpRoot: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "spur-cache-retention-home-"));
    tmpRoot = await mkdtemp(join(tmpdir(), "spur-cache-retention-tmp-"));
    execFileMock.mockReset();
    canReadProcessTreeMock.mockReset();
    canReadProcessTreeMock.mockResolvedValue(true);
    // A single innocuous row by default — snapshotProcesses returns "ok" with
    // this row, keeping processListReadable: true for tests that don't override it.
    execFileMock.mockImplementation(
      (file: string, args: string[], optionsOrCallback: unknown, maybeCallback?: unknown) => {
        const callback = (
          typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
        ) as (error: Error | null, result?: { stdout: string; stderr: string }) => void;
        if (file === "ps") {
          callback(null, { stdout: "1 0 100 00:01 /sbin/init\n", stderr: "" });
          return {} as ChildProcess.ChildProcess;
        }
        if (file === "du") {
          const paths = args.slice(1);
          const stdout = paths.map((p) => `100\t${p}`).join("\n");
          callback(null, { stdout, stderr: "" });
          return {} as ChildProcess.ChildProcess;
        }
        callback(new Error(`unexpected exec: ${file}`));
        return {} as ChildProcess.ChildProcess;
      },
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("AC12: an unreadable process tree protects every planned candidate", async () => {
    await mkdir(join(home, ".npm", "_cacache"), { recursive: true });
    const old = new Date(Date.now() - 9999 * DAY_MS);
    await utimes(join(home, ".npm", "_cacache"), old, old);
    canReadProcessTreeMock.mockResolvedValue(false);

    const plan = await planCachePrune({
      home,
      tmpPath: tmpRoot,
      instanceConfig: { status: "absent" },
    });

    expect(plan.processTreeReadable).toBe(false);
    expect(plan.reclaimableKb).toBe(0);
    expect(plan.candidates.length).toBeGreaterThan(0);
    for (const candidate of plan.candidates) {
      expect(candidate.verdict).toEqual({
        kind: "protected",
        reason: { kind: "process-tree-unreadable" },
      });
    }
  });

  it("unavailable ps snapshot protects every planned candidate (fail-closed)", async () => {
    await mkdir(join(home, ".npm", "_cacache"), { recursive: true });
    const old = new Date(Date.now() - 9999 * DAY_MS);
    await utimes(join(home, ".npm", "_cacache"), old, old);
    execFileMock.mockImplementation(
      (file: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: unknown) => {
        const callback = (
          typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
        ) as (error: Error | null, result?: { stdout: string; stderr: string }) => void;
        if (file === "ps") {
          callback(Object.assign(new Error("ps unavailable"), { code: "ENOENT" }));
          return {} as ChildProcess.ChildProcess;
        }
        if (file === "du") {
          const paths = (_args as string[]).slice(1);
          const stdout = paths.map((p) => `100\t${p}`).join("\n");
          callback(null, { stdout, stderr: "" });
          return {} as ChildProcess.ChildProcess;
        }
        callback(new Error(`unexpected exec: ${file}`));
        return {} as ChildProcess.ChildProcess;
      },
    );

    const plan = await planCachePrune({
      home,
      tmpPath: tmpRoot,
      instanceConfig: { status: "absent" },
    });

    expect(plan.candidates.length).toBeGreaterThan(0);
    for (const candidate of plan.candidates) {
      expect(candidate.verdict).toEqual({
        kind: "protected",
        reason: { kind: "process-list-unavailable" },
      });
    }
  });

  it("ps exit 0 with unparsable stdout protects every planned candidate (fail-closed)", async () => {
    await mkdir(join(home, ".npm", "_cacache"), { recursive: true });
    const old = new Date(Date.now() - 9999 * DAY_MS);
    await utimes(join(home, ".npm", "_cacache"), old, old);
    execFileMock.mockImplementation(
      (file: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: unknown) => {
        const callback = (
          typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
        ) as (error: Error | null, result?: { stdout: string; stderr: string }) => void;
        if (file === "ps") {
          // Exit 0 but every row is malformed — zero parseable entries.
          callback(null, { stdout: "not-a-valid-row\nanother-invalid-line\n", stderr: "" });
          return {} as ChildProcess.ChildProcess;
        }
        if (file === "du") {
          const paths = (_args as string[]).slice(1);
          const stdout = paths.map((p) => `100\t${p}`).join("\n");
          callback(null, { stdout, stderr: "" });
          return {} as ChildProcess.ChildProcess;
        }
        callback(new Error(`unexpected exec: ${file}`));
        return {} as ChildProcess.ChildProcess;
      },
    );

    const plan = await planCachePrune({
      home,
      tmpPath: tmpRoot,
      instanceConfig: { status: "absent" },
    });

    expect(plan.candidates.length).toBeGreaterThan(0);
    for (const candidate of plan.candidates) {
      expect(candidate.verdict).toEqual({
        kind: "protected",
        reason: { kind: "process-list-unavailable" },
      });
    }
  });

  it("a du timeout skips the root without rejecting the plan", async () => {
    await mkdir(join(home, ".npm", "_npx", "somehash"), { recursive: true });
    const old = new Date(Date.now() - 60 * DAY_MS);
    await utimes(join(home, ".npm", "_npx", "somehash"), old, old);

    execFileMock.mockImplementation(
      (file: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: unknown) => {
        const callback = (
          typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
        ) as (error: Error | null, result?: { stdout: string; stderr: string }) => void;
        if (file === "ps") {
          callback(null, { stdout: "", stderr: "" });
          return {} as ChildProcess.ChildProcess;
        }
        if (file === "du") {
          callback(Object.assign(new Error("du timed out"), { code: "ETIMEDOUT", killed: true }));
          return {} as ChildProcess.ChildProcess;
        }
        callback(new Error(`unexpected exec: ${file}`));
        return {} as ChildProcess.ChildProcess;
      },
    );

    const plan = await planCachePrune({
      home,
      tmpPath: tmpRoot,
      instanceConfig: { status: "absent" },
    });

    const npxRoot = plan.roots.find((r) => r.rootId === "npm-npx");
    expect(npxRoot).toMatchObject({ status: "skipped", totalKb: 0, entryCount: 0 });
    expect(plan.candidates.some((c) => c.entry.rootId === "npm-npx")).toBe(false);
  });

  it("AC7 (spur-owned): plan marks a prunable entry inside dataDir as spur-owned; execute refuses it", async () => {
    const dataDir = join(home, ".npm");
    const worktreeDir = join(dataDir, "worktrees");
    await mkdir(join(home, ".npm", "_cacache"), { recursive: true });
    const old = new Date(Date.now() - 30 * DAY_MS);
    await utimes(join(home, ".npm", "_cacache"), old, old);

    const config = fakeInstanceConfig(dataDir, worktreeDir);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61 * DAY_MS);
    const plan = await planCachePrune({ home, tmpPath: tmpRoot, instanceConfig: config });

    const npmEntry = plan.candidates.find((c) => c.entry.rootId === "npm-cacache");
    expect(npmEntry?.verdict).toEqual({
      kind: "protected",
      reason: { kind: "spur-owned" },
    });

    // simulate a candidate that is inside dataDir — spur-owned at execute time
    const insideDataDir = join(dataDir, "fake-cache");
    await mkdir(insideDataDir, { recursive: true });
    let outcome: Awaited<ReturnType<typeof executePrune>>;
    try {
      outcome = await executePrune(
        [
          {
            entry: {
              path: insideDataDir,
              rootId: "npm-cacache",
              entryClass: { kind: "vendor-cache" },
              sizeKb: 10,
              ageDays: 61,
            },
            verdict: { kind: "prunable" },
          },
        ],
        config,
        { home },
      );
    } finally {
      vi.useRealTimers();
    }
    expect(outcome.removed).toEqual([]);
    expect(outcome.failures[0]?.message).toContain("Spur data directory");
  });

  it("AC6/AC12/AC14: executePrune rechecks candidates and deletes only the eligible vendor cache", async () => {
    await mkdir(join(home, ".npm", "_cacache"), { recursive: true });
    await mkdir(join(home, ".npm", "_npx"), { recursive: true });
    const realCachePath = join(home, ".npm", "_cacache");
    await writeFile(join(realCachePath, "data"), "x");
    const old = new Date(Date.now() - 60 * DAY_MS);
    await utimes(realCachePath, old, old);

    const escapeTargetDir = await mkdtemp(join(tmpdir(), "spur-cache-retention-escape-"));
    const escapeLink = join(home, ".npm", "_npx", "escape-link");
    await symlink(escapeTargetDir, escapeLink);

    const outsideRootDir = await mkdtemp(join(tmpdir(), "spur-cache-retention-outside-"));

    const config = fakeInstanceConfig(join(home, ".spur"), join(home, ".spur", "worktrees"));

    const candidates = [
      {
        entry: {
          path: realCachePath,
          rootId: "npm-cacache" as const,
          entryClass: { kind: "vendor-cache" as const },
          sizeKb: 10,
          ageDays: 60,
        },
        verdict: { kind: "prunable" as const },
      },
      {
        entry: {
          path: escapeLink,
          rootId: "npm-npx" as const,
          entryClass: { kind: "npx-package" as const, hash: "escape-link" },
          sizeKb: 10,
          ageDays: 60,
        },
        verdict: { kind: "prunable" as const },
      },
      {
        entry: {
          path: outsideRootDir,
          rootId: "npm-npx" as const,
          entryClass: { kind: "npx-package" as const, hash: "outside" },
          sizeKb: 10,
          ageDays: 60,
        },
        verdict: { kind: "prunable" as const },
      },
    ];

    // `ctime` cannot be back-dated by `utimes()` — it always reflects real
    // wall-clock fixture creation, which just happened. executePrune's
    // delete-time re-check uses max(mtime, ctime), so without advancing
    // the clock every one of these freshly-created fixtures would fail the
    // age floor before ever reaching the guard this test targets.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61 * DAY_MS);
    let outcome: Awaited<ReturnType<typeof executePrune>>;
    try {
      outcome = await executePrune(candidates, config, { home });
    } finally {
      vi.useRealTimers();
    }

    expect(outcome.removed).toEqual([{ path: realCachePath, sizeKb: 10 }]);
    const failurePaths = outcome.failures.map((f) => f.path);
    expect(failurePaths).toContain(escapeLink);
    expect(failurePaths).toContain(outsideRootDir);
    const symlinkFailure = outcome.failures.find((f) => f.path === escapeLink);
    expect(symlinkFailure?.message).toContain("symlink");
    const outsideFailure = outcome.failures.find((f) => f.path === outsideRootDir);
    expect(outsideFailure?.message).toContain("outside");

    await rm(escapeTargetDir, { recursive: true, force: true });
    await rm(outsideRootDir, { recursive: true, force: true });
  });

  it("AC7: executePrune refuses candidates inside dataDir or worktreeDir", async () => {
    const dataDir = join(home, ".spur");
    const worktreeDir = join(home, ".spur", "worktrees");
    const insideDataDir = join(dataDir, "some-data");
    const insideWorktreeDir = join(worktreeDir, "proj", "sess");
    await mkdir(insideDataDir, { recursive: true });
    await mkdir(insideWorktreeDir, { recursive: true });
    await writeFile(join(insideDataDir, "data"), "x");
    await writeFile(join(insideWorktreeDir, "data"), "x");

    const config = fakeInstanceConfig(dataDir, worktreeDir);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61 * DAY_MS);
    let outcome: Awaited<ReturnType<typeof executePrune>>;
    try {
      outcome = await executePrune(
        [
          {
            entry: {
              path: insideDataDir,
              rootId: "npm-cacache" as const,
              entryClass: { kind: "vendor-cache" as const },
              sizeKb: 10,
              ageDays: 61,
            },
            verdict: { kind: "prunable" as const },
          },
          {
            entry: {
              path: insideWorktreeDir,
              rootId: "npm-cacache" as const,
              entryClass: { kind: "vendor-cache" as const },
              sizeKb: 10,
              ageDays: 61,
            },
            verdict: { kind: "prunable" as const },
          },
        ],
        config,
        { home },
      );
    } finally {
      vi.useRealTimers();
    }

    expect(outcome.removed).toEqual([]);
    expect(outcome.failures.every((f) => f.message.includes("Spur data directory"))).toBe(true);
  });
});
