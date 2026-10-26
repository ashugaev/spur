// Pins #1109: every metadata scanner skips an entry that vanishes (ENOENT)
// between the outer listing and the inner readdir/stat/read, and still throws
// on any other fs error. A real filesystem cannot vanish an entry at an exact
// call on demand, so node:fs is partially mocked: a one-shot fault keyed by
// function and absolute path either removes the target (so the delegated real
// call raises a genuine ENOENT) or throws EACCES.
import type * as NodeFs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type FaultFn = "readdirSync" | "statSync" | "readFileSync";
type FaultKind = "vanish" | "eacces";

const faults = new Map<string, FaultKind>();

function faultKey(fn: FaultFn, path: string): string {
  return `${fn}:${path}`;
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();

  function wrap<F extends FaultFn>(fn: F): (typeof actual)[F] {
    const real = actual[fn] as (...args: unknown[]) => unknown;
    return ((...args: unknown[]) => {
      const path = args[0];
      const key = typeof path === "string" ? faultKey(fn, path) : null;
      const kind = key ? faults.get(key) : undefined;
      if (key && kind) {
        faults.delete(key);
        if (kind === "eacces") {
          throw Object.assign(new Error(`EACCES: permission denied, ${fn} '${String(path)}'`), {
            code: "EACCES",
          });
        }
        actual.rmSync(path as string, { recursive: true, force: true });
      }
      return real(...args);
    }) as unknown as (typeof actual)[F];
  }

  return {
    ...actual,
    readdirSync: wrap("readdirSync"),
    statSync: wrap("statSync"),
    readFileSync: wrap("readFileSync"),
  };
});

const {
  deleteServiceSourceStatesForService,
  listActiveServiceProblems,
  listRuntimeLogCursorKeys,
  listServiceInstances,
  listServiceInstancesForSession,
  listSessions,
  readReviewSourceSnapshots,
  writeReviewSourceSnapshot,
  writeRuntimeLogCursor,
  writeServiceInstance,
  writeServiceSourceState,
  writeSession,
} = await import("../../src/metadata.js");
const { existsSync, mkdirSync } = await import("node:fs");

const tempDirs: string[] = [];

afterEach(async () => {
  faults.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spur-scan-race-"));
  tempDirs.push(dir);
  return dir;
}

const sessionBase = {
  agent: "claude" as const,
  prompt: "ship it",
  worktree: true,
  worktreePath: "/tmp/spur-worktrees/x",
  launchCommand: "claude",
  status: "completed" as const,
  createdAt: "2026-03-18T10:00:00.000Z",
  updatedAt: "2026-03-18T10:01:00.000Z",
};

function seedSession(dataDir: string, project: string, id: string): void {
  writeSession(dataDir, {
    ...sessionBase,
    id,
    project,
    branch: id,
    tmuxSession: id,
  });
}

function serviceRecord(sessionId: string, serviceId: string) {
  return {
    sessionId,
    project: "api",
    serviceId,
    command: "run",
    cwd: "/tmp",
    tmuxSession: sessionId,
    status: "running" as const,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:00:00.000Z",
  };
}

interface Site {
  name: string;
  // Seeds two entries; fault targets name the (function, path) that hits the first one.
  seed: (dataDir: string) => void;
  run: (dataDir: string) => unknown;
  targets: (dataDir: string) => Array<{ fn: FaultFn; path: string }>;
  // Result after the first entry vanished: only the second survives.
  vanished: unknown;
  // statFingerprint swallows every stat error by design, so a stat-only fault never throws.
  skipEacces?: boolean;
}

const ruleState = (serviceId: string) => ({
  serviceId,
  lastTailLines: [],
  rules: { r1: { active: true } },
});

const sites: Site[] = [
  {
    name: "listSessions (project dir at readdir)",
    seed: (dataDir) => {
      seedSession(dataDir, "alpha", "alpha-1");
      seedSession(dataDir, "beta", "beta-1");
    },
    run: (dataDir) => listSessions(dataDir).map((s) => s.id),
    targets: (dataDir) => [{ fn: "readdirSync", path: join(dataDir, "sessions", "alpha") }],
    vanished: ["beta-1"],
  },
  {
    name: "listSessions (shard dir at stat)",
    seed: (dataDir) => {
      seedSession(dataDir, "alpha", "alpha-1");
      seedSession(dataDir, "beta", "beta-1");
    },
    run: (dataDir) => listSessions(dataDir).map((s) => s.id),
    targets: (dataDir) => [{ fn: "statSync", path: join(dataDir, "sessions", "alpha") }],
    vanished: ["beta-1"],
    skipEacces: true,
  },
  {
    name: "listServiceInstances (session dir at readdir)",
    seed: (dataDir) => {
      writeServiceInstance(dataDir, serviceRecord("s1", "web"));
      writeServiceInstance(dataDir, serviceRecord("s2", "web"));
    },
    run: (dataDir) => listServiceInstances(dataDir).map((s) => s.sessionId),
    targets: (dataDir) => [{ fn: "readdirSync", path: join(dataDir, "services", "s1") }],
    vanished: ["s2"],
  },
  {
    name: "listServiceInstances (file at read)",
    seed: (dataDir) => {
      writeServiceInstance(dataDir, serviceRecord("s1", "web"));
      writeServiceInstance(dataDir, serviceRecord("s2", "web"));
    },
    run: (dataDir) => listServiceInstances(dataDir).map((s) => s.sessionId),
    targets: (dataDir) => [
      { fn: "readFileSync", path: join(dataDir, "services", "s1", "web.json") },
    ],
    vanished: ["s2"],
  },
  {
    name: "listServiceInstancesForSession (dir at readdir)",
    seed: (dataDir) => writeServiceInstance(dataDir, serviceRecord("s1", "web")),
    run: (dataDir) => listServiceInstancesForSession(dataDir, "s1").map((s) => s.serviceId),
    targets: (dataDir) => [{ fn: "readdirSync", path: join(dataDir, "services", "s1") }],
    vanished: [],
  },
  {
    name: "listServiceInstancesForSession (file at read)",
    seed: (dataDir) => {
      writeServiceInstance(dataDir, serviceRecord("s1", "api"));
      writeServiceInstance(dataDir, serviceRecord("s1", "web"));
    },
    run: (dataDir) => listServiceInstancesForSession(dataDir, "s1").map((s) => s.serviceId),
    targets: (dataDir) => [
      { fn: "readFileSync", path: join(dataDir, "services", "s1", "api.json") },
    ],
    vanished: ["web"],
  },
  {
    name: "listRuntimeLogCursorKeys (session dir at readdir)",
    seed: (dataDir) => {
      writeRuntimeLogCursor(dataDir, "s1", "k1", { lastTailLines: [] });
      writeRuntimeLogCursor(dataDir, "s2", "k2", { lastTailLines: [] });
    },
    run: (dataDir) => listRuntimeLogCursorKeys(dataDir),
    targets: (dataDir) => [{ fn: "readdirSync", path: join(dataDir, "runtime-log-state", "s1") }],
    vanished: [{ sessionId: "s2", key: "k2" }],
  },
  {
    name: "readReviewSourceSnapshots (dir at readdir)",
    seed: (dataDir) => {
      writeReviewSourceSnapshot(dataDir, "github", "api", "src", "s1", {
        prNumber: 1,
        signals: new Map(),
      });
    },
    run: (dataDir) => [...readReviewSourceSnapshots(dataDir, "github", "api", "src").keys()],
    targets: (dataDir) => [
      { fn: "readdirSync", path: join(dataDir, "source-state", "github", "api", "src") },
    ],
    vanished: [],
  },
  {
    name: "readReviewSourceSnapshots (file at read)",
    seed: (dataDir) => {
      for (const id of ["s1", "s2"]) {
        writeReviewSourceSnapshot(dataDir, "github", "api", "src", id, {
          prNumber: 1,
          signals: new Map(),
        });
      }
    },
    run: (dataDir) => [...readReviewSourceSnapshots(dataDir, "github", "api", "src").keys()],
    targets: (dataDir) => [
      {
        fn: "readFileSync",
        path: join(dataDir, "source-state", "github", "api", "src", "s1.json"),
      },
    ],
    vanished: ["s2"],
  },
  {
    name: "listActiveServiceProblems (state file at read)",
    seed: (dataDir) => {
      writeServiceSourceState(dataDir, "api", "src-a", "s1", ruleState("web"));
      writeServiceSourceState(dataDir, "api", "src-b", "s1", {
        ...ruleState("web"),
        rules: { r2: { active: true } },
      });
    },
    run: (dataDir) => listActiveServiceProblems(dataDir, "api", "s1", "web"),
    targets: (dataDir) => [
      {
        fn: "readFileSync",
        path: join(dataDir, "source-state", "service", "api", "src-a", "s1.json"),
      },
    ],
    vanished: ["r2"],
  },
  {
    name: "deleteServiceSourceStatesForService (state file at read)",
    seed: (dataDir) => {
      writeServiceSourceState(dataDir, "api", "src-a", "s1", ruleState("web"));
      writeServiceSourceState(dataDir, "api", "src-b", "s1", ruleState("web"));
    },
    run: (dataDir) => {
      deleteServiceSourceStatesForService(dataDir, "api", "s1", "web");
      return [
        existsSync(join(dataDir, "source-state", "service", "api", "src-a", "s1.json")),
        existsSync(join(dataDir, "source-state", "service", "api", "src-b", "s1.json")),
      ];
    },
    targets: (dataDir) => [
      {
        fn: "readFileSync",
        path: join(dataDir, "source-state", "service", "api", "src-a", "s1.json"),
      },
    ],
    vanished: [false, false],
  },
];

describe("metadata scanner mid-scan races", () => {
  it.each(sites)("$name: skips a vanished entry", async (site) => {
    const dataDir = await newDataDir();
    site.seed(dataDir);
    for (const { fn, path } of site.targets(dataDir)) {
      faults.set(faultKey(fn, path), "vanish");
    }

    expect(site.run(dataDir)).toEqual(site.vanished);
    expect(faults.size).toBe(0);
  });

  it.each(sites.filter((site) => !site.skipEacces))("$name: rethrows EACCES", async (site) => {
    const dataDir = await newDataDir();
    site.seed(dataDir);
    for (const { fn, path } of site.targets(dataDir)) {
      faults.set(faultKey(fn, path), "eacces");
    }

    expect(() => site.run(dataDir)).toThrow(/EACCES/);
  });
});

describe("listSessions dir listing cache", () => {
  it("lists a dir again once it is recreated after vanishing mid-scan", async () => {
    const dataDir = await newDataDir();
    seedSession(dataDir, "alpha", "alpha-1");
    seedSession(dataDir, "beta", "beta-1");
    const alphaDir = join(dataDir, "sessions", "alpha");

    faults.set(faultKey("readdirSync", alphaDir), "vanish");
    expect(listSessions(dataDir).map((s) => s.id)).toEqual(["beta-1"]);
    expect(existsSync(alphaDir)).toBe(false);

    mkdirSync(alphaDir, { recursive: true });
    seedSession(dataDir, "alpha", "alpha-2");
    expect(
      listSessions(dataDir)
        .map((s) => s.id)
        .sort(),
    ).toEqual(["alpha-2", "beta-1"]);
  });
});
