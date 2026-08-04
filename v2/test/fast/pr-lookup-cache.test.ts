import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PR_LOOKUP_IDLE_CAP_MS,
  PR_LOOKUP_LIVE_CAP_MS,
  type PrRepoSlug,
  _resetPrLookupCacheForTests,
  clearPrLookupEntry,
  isPrLookupDue,
  markPrLookupMiss,
  markPrLookupTerminal,
  readPrLookupCache,
  readPrLookupEntry,
} from "../../src/pr-lookup-cache.js";

const SLUG: PrRepoSlug = { owner: "ashugaev", name: "spur" };
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

let dataDir = "";

function repoFile(dir: string = dataDir): string {
  return join(dir, "source-state", "pr-lookup", SLUG.owner, `${SLUG.name}.json`);
}

describe("pr lookup cache", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "spur-pr-lookup-"));
    _resetPrLookupCacheForTests();
  });

  afterEach(() => {
    _resetPrLookupCacheForTests();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("walks the live backoff schedule 1, 2, 4, 5, 5 minutes", () => {
    const schedule = [1, 2, 4, 5, 5].map((minutes) => minutes * MINUTE);
    let now = T0;
    for (const backoff of schedule) {
      const entry = markPrLookupMiss(dataDir, SLUG, "feature/x", now);
      expect(isPrLookupDue(entry, PR_LOOKUP_LIVE_CAP_MS, now + backoff - 1)).toBe(false);
      expect(isPrLookupDue(entry, PR_LOOKUP_LIVE_CAP_MS, now + backoff)).toBe(true);
      now += backoff;
    }
  });

  it("walks the idle backoff schedule 1, 2, 4, 8, 16, 32, 60, 60 minutes", () => {
    const schedule = [1, 2, 4, 8, 16, 32, 60, 60].map((minutes) => minutes * MINUTE);
    let now = T0;
    for (const backoff of schedule) {
      const entry = markPrLookupMiss(dataDir, SLUG, "feature/x", now);
      expect(isPrLookupDue(entry, PR_LOOKUP_IDLE_CAP_MS, now + backoff - 1)).toBe(false);
      expect(isPrLookupDue(entry, PR_LOOKUP_IDLE_CAP_MS, now + backoff)).toBe(true);
      now += backoff;
    }
  });

  it("treats an unknown branch as due", () => {
    expect(isPrLookupDue(null, PR_LOOKUP_IDLE_CAP_MS, T0)).toBe(true);
    expect(readPrLookupEntry(dataDir, SLUG, "feature/x", T0)).toBeNull();
  });

  it("survives a restart through a fresh read of the written file", () => {
    markPrLookupMiss(dataDir, SLUG, "feature/x", T0);
    markPrLookupMiss(dataDir, SLUG, "feature/x", T0 + MINUTE);

    // Fresh process: drop the in-memory map and read the file back.
    _resetPrLookupCacheForTests();
    const entry = readPrLookupEntry(dataDir, SLUG, "feature/x", T0 + 2 * MINUTE);
    expect(entry).toEqual({ branch: "feature/x", misses: 2, lastCheckedAt: T0 + MINUTE });
    // misses 2 means a 2min step measured from the persisted lastCheckedAt.
    expect(isPrLookupDue(entry, PR_LOOKUP_LIVE_CAP_MS, T0 + 2 * MINUTE)).toBe(false);
    expect(isPrLookupDue(entry, PR_LOOKUP_LIVE_CAP_MS, T0 + 3 * MINUTE)).toBe(true);
  });

  it("clears the entry when an open PR is found", () => {
    markPrLookupMiss(dataDir, SLUG, "feature/x", T0);
    clearPrLookupEntry(dataDir, SLUG, "feature/x", T0 + 1_000);

    _resetPrLookupCacheForTests();
    expect(readPrLookupEntry(dataDir, SLUG, "feature/x", T0 + 2_000)).toBeNull();
  });

  it("parks a terminal branch at the cap step for both caps", () => {
    const entry = markPrLookupTerminal(
      dataDir,
      SLUG,
      "feature/x",
      { number: 7, state: "MERGED" },
      T0,
    );
    expect(entry.terminal).toEqual({ number: 7, state: "MERGED" });

    expect(isPrLookupDue(entry, PR_LOOKUP_LIVE_CAP_MS, T0 + PR_LOOKUP_LIVE_CAP_MS - 1)).toBe(false);
    expect(isPrLookupDue(entry, PR_LOOKUP_LIVE_CAP_MS, T0 + PR_LOOKUP_LIVE_CAP_MS)).toBe(true);
    expect(isPrLookupDue(entry, PR_LOOKUP_IDLE_CAP_MS, T0 + PR_LOOKUP_LIVE_CAP_MS)).toBe(false);
    expect(isPrLookupDue(entry, PR_LOOKUP_IDLE_CAP_MS, T0 + PR_LOOKUP_IDLE_CAP_MS)).toBe(true);
  });

  it("prunes entries older than 7 days on read", () => {
    markPrLookupMiss(dataDir, SLUG, "stale", T0);
    markPrLookupMiss(dataDir, SLUG, "fresh", T0 + 6 * 24 * 60 * MINUTE);

    _resetPrLookupCacheForTests();
    const entries = readPrLookupCache(dataDir, SLUG, T0 + 7 * 24 * 60 * MINUTE + 1);
    expect([...entries.keys()]).toEqual(["fresh"]);
  });

  it("caps a repo at 500 entries, evicting the oldest first", () => {
    for (let index = 0; index < 501; index += 1) {
      markPrLookupMiss(dataDir, SLUG, `branch-${index}`, T0 + index);
    }
    const entries = readPrLookupCache(dataDir, SLUG, T0 + 501);
    expect(entries.size).toBe(500);
    expect(entries.has("branch-0")).toBe(false);
    expect(entries.has("branch-1")).toBe(true);
    expect(entries.has("branch-500")).toBe(true);
  });

  it("reads a corrupt file as empty", () => {
    const path = repoFile();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not json", "utf-8");

    expect(readPrLookupCache(dataDir, SLUG, T0).size).toBe(0);
  });

  it("reads an unknown version as empty", () => {
    const path = repoFile();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ version: 2, entries: [{ branch: "x", misses: 1, lastCheckedAt: T0 }] }),
      "utf-8",
    );

    expect(readPrLookupCache(dataDir, SLUG, T0).size).toBe(0);
  });

  it("keys a renamed branch separately", () => {
    markPrLookupMiss(dataDir, SLUG, "feature/old", T0);
    expect(readPrLookupEntry(dataDir, SLUG, "feature/new", T0)).toBeNull();
    expect(isPrLookupDue(readPrLookupEntry(dataDir, SLUG, "feature/new", T0), 5 * MINUTE, T0)).toBe(
      true,
    );
  });

  it("keys each repo in its own file", () => {
    const other: PrRepoSlug = { owner: "ashugaev", name: "other" };
    markPrLookupMiss(dataDir, SLUG, "feature/x", T0);
    expect(readPrLookupEntry(dataDir, other, "feature/x", T0)).toBeNull();
  });

  it("degrades to in-memory when the dataDir cannot be written", () => {
    const readOnlyDir = join(dataDir, "missing", "\0invalid");
    const entry = markPrLookupMiss(readOnlyDir, SLUG, "feature/x", T0);
    expect(entry.misses).toBe(1);
    expect(readPrLookupEntry(readOnlyDir, SLUG, "feature/x", T0)?.misses).toBe(1);
  });
});
