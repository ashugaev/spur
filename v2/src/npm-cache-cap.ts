import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// The only code in the repo coupled to `_cacache`'s private on-disk index
// format (`index-v5`). Quarantined behind one testable, fail-closed function:
// a future npm bumping the index version degrades this to "no cap enforced,
// reported", never to a wrong deletion — deletion always happens through
// npm's own `npm cache clean <key>`, never by reading this module's output
// as a path to remove.

export interface NpmCacheIndexEntry {
  key: string;
  integrity: string;
  time: number;
  size: number;
}

function isValidRawEntry(raw: object): raw is NpmCacheIndexEntry {
  const candidate = raw as Record<string, unknown>;
  return (
    typeof candidate["key"] === "string" &&
    typeof candidate["integrity"] === "string" &&
    typeof candidate["time"] === "number" &&
    typeof candidate["size"] === "number"
  );
}

// One line per index file, tab-separated `<hash>\t<json>`. Only the JSON
// half is parsed; the hash prefix is cacache's own integrity check and is
// not needed here. Any read or parse failure anywhere in the tree aborts the
// whole read (returns undefined) — a partial ranking would be worse than no
// ranking, since a truncated/corrupt index could silently omit large,
// legitimately-old entries from the victim list.
//
// index-v5 is append-only: cacache writes a new line for a key on every
// re-insert, so the same key can appear several times across a file's
// lines. Collapsed here to the newest line per key (by `time`) so a
// re-fetched key is counted once, not once per historical revision.
export async function readNpmCacheIndex(
  cacachePath: string,
): Promise<NpmCacheIndexEntry[] | undefined> {
  const indexDir = join(cacachePath, "index-v5");
  const byKey = new Map<string, NpmCacheIndexEntry>();
  let level1: string[];
  try {
    level1 = await readdir(indexDir);
  } catch {
    return undefined;
  }
  for (const dir1 of level1) {
    let level2: string[];
    try {
      level2 = await readdir(join(indexDir, dir1));
    } catch {
      return undefined;
    }
    for (const dir2 of level2) {
      let level3: string[];
      try {
        level3 = await readdir(join(indexDir, dir1, dir2));
      } catch {
        return undefined;
      }
      for (const fileName of level3) {
        let raw: string;
        try {
          raw = await readFile(join(indexDir, dir1, dir2, fileName), "utf8");
        } catch {
          return undefined;
        }
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const tabIndex = trimmed.indexOf("\t");
          if (tabIndex === -1) {
            return undefined;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed.slice(tabIndex + 1)) as unknown;
          } catch {
            return undefined;
          }
          if (typeof parsed !== "object" || parsed === null || !isValidRawEntry(parsed)) {
            return undefined;
          }
          const existing = byKey.get(parsed.key);
          if (existing === undefined || parsed.time >= existing.time) {
            byKey.set(parsed.key, {
              key: parsed.key,
              integrity: parsed.integrity,
              time: parsed.time,
              size: parsed.size,
            });
          }
        }
      }
    }
  }
  return [...byKey.values()];
}

export interface NpmCacheCapPlan {
  // Entries to `npm cache clean <key>`, oldest `time` first, stopping once
  // the projected total (currentSizeBytes minus accumulated victim bytes)
  // is at or under capBytes. Never includes every entry even when the cap
  // cannot be reached — the caller reports the residual delta instead of
  // looping past what the index can rank.
  victims: NpmCacheIndexEntry[];
  victimBytes: number;
  indexedTotalBytes: number;
}

// Pure — no IO. Sorts ascending by `time` (oldest first), collapses
// entries that share an `integrity` (cacache content-addresses the blob, so
// two keys — e.g. a registry tarball and its `pacote:tarball:` alias — can
// point at the same on-disk bytes; counting both inflates both the victim
// total and the reported index total) keeping the oldest occurrence, then
// accumulates until the projection clears the cap or the index is exhausted.
export function planNpmCacheVictims(
  entries: readonly NpmCacheIndexEntry[],
  currentSizeBytes: number,
  capBytes: number,
): NpmCacheCapPlan {
  const sorted = [...entries].sort((a, b) => a.time - b.time);
  const seenIntegrity = new Set<string>();
  const deduped: NpmCacheIndexEntry[] = [];
  for (const entry of sorted) {
    if (seenIntegrity.has(entry.integrity)) continue;
    seenIntegrity.add(entry.integrity);
    deduped.push(entry);
  }
  const indexedTotalBytes = deduped.reduce((sum, e) => sum + e.size, 0);
  const victims: NpmCacheIndexEntry[] = [];
  let projected = currentSizeBytes;
  let victimBytes = 0;
  for (const entry of deduped) {
    if (projected <= capBytes) break;
    victims.push(entry);
    victimBytes += entry.size;
    projected -= entry.size;
  }
  return { victims, victimBytes, indexedTotalBytes };
}

export type NpmCacheCapResult =
  | { ok: true; plan: NpmCacheCapPlan }
  | { ok: false; reason: "npm_index_unreadable" };

// Combines the read (IO, fail-closed) and the ranking (pure) into the one
// entry point disk-gc.ts calls.
export async function planNpmCacheCap(
  cacachePath: string,
  currentSizeBytes: number,
  capBytes: number,
): Promise<NpmCacheCapResult> {
  const entries = await readNpmCacheIndex(cacachePath);
  if (entries === undefined) {
    return { ok: false, reason: "npm_index_unreadable" };
  }
  return { ok: true, plan: planNpmCacheVictims(entries, currentSizeBytes, capBytes) };
}
