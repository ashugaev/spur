import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { findBuildCacheDirs } from "./disk-gc.js";

const execFileAsync = promisify(execFile);

export type DiskBudgetRootId =
  | "session-artifacts"
  | "worktrees"
  | "session-tools"
  | "opencode-store"
  | "npm-cacache"
  | "npm-npx"
  | "playwright-browsers"
  | "playwright-mcp-profiles"
  | "worktree-build-caches";

export type DiskBudgetOwner = "disk-gc" | "spur cache" | "opencode-gc" | "spur gc" | "none";

export interface DiskBudgetRoot {
  id: DiskBudgetRootId;
  path: string;
  sizeBytes: number | null;
  status: "measured" | "absent" | "unmeasured";
  // "this run's reclaim set includes this root" — NOT "never reclaimable".
  reclaimedByDiskGc: boolean;
  reclaimedBy: DiskBudgetOwner;
}

export interface DiskBudgetReport {
  generatedAt: string;
  roots: DiskBudgetRoot[];
  totals: { attributableBytes: number };
}

export interface DiskBudgetDeps {
  // Bytes via `du -s --block-size=1`, or null if the path does not exist.
  // Injected so tests never spawn a real `du`.
  du: (path: string, signal?: AbortSignal) => Promise<number | null>;
}

export interface MeasureDiskBudgetOptions {
  dataDir: string;
  worktreeDir: string;
  home?: string;
  xdgDataHome?: string;
  signal?: AbortSignal;
  // Real worktree paths under worktreeDir to aggregate build-cache bytes
  // for the report row — a plain list, not the reclaim decision (T3's
  // planner in disk-gc.ts owns which of these are actually reclaimable).
  worktreePaths?: readonly string[];
  listBuildCacheDirs?: (worktreePath: string) => Promise<{ path: string }[]>;
}

const ROOT_ORDER: readonly {
  id: DiskBudgetRootId;
  reclaimedByDiskGc: boolean;
  reclaimedBy: DiskBudgetOwner;
}[] = [
  { id: "session-artifacts", reclaimedByDiskGc: false, reclaimedBy: "none" },
  { id: "worktrees", reclaimedByDiskGc: false, reclaimedBy: "spur gc" },
  { id: "session-tools", reclaimedByDiskGc: false, reclaimedBy: "none" },
  { id: "opencode-store", reclaimedByDiskGc: false, reclaimedBy: "none" },
  { id: "npm-cacache", reclaimedByDiskGc: false, reclaimedBy: "spur cache" },
  { id: "npm-npx", reclaimedByDiskGc: false, reclaimedBy: "spur cache" },
  { id: "playwright-browsers", reclaimedByDiskGc: true, reclaimedBy: "disk-gc" },
  { id: "playwright-mcp-profiles", reclaimedByDiskGc: true, reclaimedBy: "disk-gc" },
  { id: "worktree-build-caches", reclaimedByDiskGc: true, reclaimedBy: "disk-gc" },
];

function rootPath(id: DiskBudgetRootId, options: MeasureDiskBudgetOptions): string {
  const home = options.home ?? homedir();
  switch (id) {
    case "session-artifacts":
      return join(options.dataDir, "session-artifacts");
    case "worktrees":
      return options.worktreeDir;
    case "session-tools":
      return join(options.dataDir, "session-tools");
    case "opencode-store":
      return join(options.xdgDataHome ?? join(home, ".local", "share"), "opencode");
    case "npm-cacache":
      return join(home, ".npm", "_cacache");
    case "npm-npx":
      return join(home, ".npm", "_npx");
    case "playwright-browsers":
      return join(home, ".cache", "ms-playwright");
    case "playwright-mcp-profiles":
      return join(home, ".cache", "ms-playwright-mcp");
    case "worktree-build-caches":
      // Aggregate row — not a single filesystem path; reported for display
      // only, under the worktreeDir umbrella.
      return buildCacheAggregatePath(options.worktreeDir);
  }
}

function buildCacheAggregatePath(worktreeDir: string): string {
  return `${worktreeDir}/**/.cache/webpack, **/.next/cache`;
}

// Never runs from the daemon process (see cache-retention.ts's call-site
// comment) — only `spur disk` calls this, and only it writes
// `<dataDir>/disk-budget.json`, which is the ONLY thing the daemon's
// runDiskBudgetSweep reads (session-service.ts never calls this function).
export async function measureDiskBudget(
  deps: DiskBudgetDeps,
  options: MeasureDiskBudgetOptions,
): Promise<DiskBudgetReport> {
  const roots: DiskBudgetRoot[] = [];
  let attributableBytes = 0;

  for (const spec of ROOT_ORDER) {
    if (spec.id === "worktree-build-caches") {
      let sizeBytes = 0;
      let anyMeasured = false;
      for (const worktreePath of options.worktreePaths ?? []) {
        const dirs = options.listBuildCacheDirs
          ? await options.listBuildCacheDirs(worktreePath)
          : await findBuildCacheDirs(worktreePath);
        for (const dir of dirs) {
          const bytes = await deps.du(dir.path, options.signal);
          if (bytes !== null) {
            sizeBytes += bytes;
            anyMeasured = true;
          }
        }
      }
      roots.push({
        id: spec.id,
        path: buildCacheAggregatePath(options.worktreeDir),
        sizeBytes: anyMeasured || (options.worktreePaths?.length ?? 0) === 0 ? sizeBytes : null,
        status: anyMeasured || (options.worktreePaths?.length ?? 0) === 0 ? "measured" : "unmeasured",
        reclaimedByDiskGc: spec.reclaimedByDiskGc,
        reclaimedBy: spec.reclaimedBy,
      });
      attributableBytes += sizeBytes;
      continue;
    }

    const path = rootPath(spec.id, options);
    let sizeBytes: number | null;
    try {
      sizeBytes = await deps.du(path, options.signal);
    } catch (error) {
      if (options.signal?.aborted) {
        roots.push({
          id: spec.id,
          path,
          sizeBytes: null,
          status: "unmeasured",
          reclaimedByDiskGc: spec.reclaimedByDiskGc,
          reclaimedBy: spec.reclaimedBy,
        });
        continue;
      }
      throw error;
    }
    if (sizeBytes === null) {
      roots.push({
        id: spec.id,
        path,
        sizeBytes: null,
        status: "absent",
        reclaimedByDiskGc: spec.reclaimedByDiskGc,
        reclaimedBy: spec.reclaimedBy,
      });
      continue;
    }
    roots.push({
      id: spec.id,
      path,
      sizeBytes,
      status: "measured",
      reclaimedByDiskGc: spec.reclaimedByDiskGc,
      reclaimedBy: spec.reclaimedBy,
    });
    attributableBytes += sizeBytes;
  }

  return { generatedAt: new Date().toISOString(), roots, totals: { attributableBytes } };
}

export function diskBudgetReportPath(dataDir: string): string {
  return join(dataDir, "disk-budget.json");
}

export async function writeDiskBudgetReport(
  dataDir: string,
  report: DiskBudgetReport,
): Promise<void> {
  await writeFile(diskBudgetReportPath(dataDir), JSON.stringify(report, null, 2), "utf8");
}

// Fail-closed JSON.parse per the repo rule: any read or parse failure (file
// absent, truncated, malformed) is treated as "no measurement", never as an
// exception the daemon sweep has to handle.
export async function readDiskBudgetReport(dataDir: string): Promise<DiskBudgetReport | undefined> {
  try {
    const raw = await readFile(diskBudgetReportPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { generatedAt?: unknown }).generatedAt !== "string" ||
      !Array.isArray((parsed as { roots?: unknown }).roots) ||
      typeof (parsed as { totals?: { attributableBytes?: unknown } }).totals
        ?.attributableBytes !== "number"
    ) {
      return undefined;
    }
    return parsed as DiskBudgetReport;
  } catch {
    return undefined;
  }
}

const DISK_BUDGET_DU_TIMEOUT_MS = 30_000;

export async function realDu(path: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("du", ["-s", "--block-size=1", "--", path], {
      timeout: DISK_BUDGET_DU_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    const match = /^(\d+)/.exec(stdout);
    const digits = match?.[1];
    return digits ? Number.parseInt(digits, 10) : null;
  } catch (error) {
    // An abort must surface as "unmeasured", never silently collapse into
    // "absent, sizeBytes: 0" — rethrow so measureDiskBudget's own
    // signal?.aborted check can tell the two apart.
    if (signal?.aborted) {
      throw error;
    }
    return null;
  }
}
