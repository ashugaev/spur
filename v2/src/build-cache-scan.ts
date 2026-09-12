import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";

// Read-only build-cache discovery, split out from disk-gc.ts so
// disk-budget.ts's report path can use it WITHOUT importing disk-gc.ts (and
// therefore without pulling in `fs.rm`/`execFile`/cache-retention.js into
// the daemon's import graph — see disk-budget.ts's own call-site comment
// and cache-retention.ts:19-36). This module has no destructive surface at
// all: it only ever reads directory entries and stats.

const BUILD_CACHE_MAX_DEPTH = 3;
const BUILD_CACHE_SKIP_NAMES = new Set(["node_modules", ".git"]);

export interface BuildCacheDirFact {
  path: string;
  newestMtimeMs: number;
}

async function newestMtimeMs(dirPath: string): Promise<number> {
  let newest = 0;
  const st = await lstat(dirPath);
  newest = Math.max(newest, st.mtimeMs);
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return newest;
  }
  for (const name of entries) {
    try {
      const childStat = await lstat(join(dirPath, name));
      if (childStat.mtimeMs > newest) newest = childStat.mtimeMs;
    } catch {
      // vanished mid-walk — not a signal either way.
    }
  }
  return newest;
}

// Bounded, depth-3 walk from a worktree root, skipping node_modules and .git,
// collecting directories whose path ends `/.cache/webpack` or `/.next/cache`.
// Never an unbounded filesystem walk (same discipline as cache-retention.ts's
// pin resolution) — a worktree can contain arbitrarily deep node_modules
// trees, which BUILD_CACHE_SKIP_NAMES prunes before depth even matters.
export async function findBuildCacheDirs(worktreeRoot: string): Promise<BuildCacheDirFact[]> {
  const found: BuildCacheDirFact[] = [];

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (depth > BUILD_CACHE_MAX_DEPTH) return;
    let names: string[];
    try {
      names = await readdir(dirPath);
    } catch {
      return;
    }
    for (const name of names) {
      if (BUILD_CACHE_SKIP_NAMES.has(name)) continue;
      const childPath = join(dirPath, name);
      let st: Awaited<ReturnType<typeof lstat>>;
      try {
        st = await lstat(childPath);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const isWebpackCache = childPath.endsWith(join(".cache", "webpack"));
      const isNextCache = childPath.endsWith(join(".next", "cache"));
      if (isWebpackCache || isNextCache) {
        found.push({ path: childPath, newestMtimeMs: await newestMtimeMs(childPath) });
        continue; // do not descend into a matched build-cache dir itself
      }
      await walk(childPath, depth + 1);
    }
  }

  await walk(worktreeRoot, 0);
  return found;
}
