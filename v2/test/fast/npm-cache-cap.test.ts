import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  planNpmCacheCap,
  planNpmCacheVictims,
  readNpmCacheIndex,
} from "../../src/npm-cache-cap.js";

describe("planNpmCacheVictims (pure)", () => {
  it("ranks index entries oldest-first and stops at the cap", () => {
    const entries = [
      { key: "c", integrity: "sha512-c", time: 300, size: 40 },
      { key: "a", integrity: "sha512-a", time: 100, size: 50 },
      { key: "b", integrity: "sha512-b", time: 200, size: 30 },
    ];
    // current 150, cap 80 -> oldest (a, 50) brings projected to 100, still
    // over cap; next (b, 30) brings it to 70 <= 80, so both are victims and
    // c (newest) is never touched.
    const plan = planNpmCacheVictims(entries, 150, 80);
    expect(plan.victims.map((v) => v.key)).toEqual(["a", "b"]);
    expect(plan.victimBytes).toBe(80);
    expect(plan.indexedTotalBytes).toBe(120);
  });

  it("selects nothing when already under the cap", () => {
    const entries = [{ key: "a", integrity: "sha512-a", time: 100, size: 50 }];
    const plan = planNpmCacheVictims(entries, 40, 100);
    expect(plan.victims).toEqual([]);
    expect(plan.victimBytes).toBe(0);
  });

  it("collapses entries that share an integrity, keeping the oldest occurrence", () => {
    const entries = [
      { key: "registry-tarball:a", integrity: "sha512-shared", time: 100, size: 1000 },
      { key: "pacote:tarball:a", integrity: "sha512-shared", time: 150, size: 1000 },
      { key: "b", integrity: "sha512-b", time: 200, size: 500 },
    ];
    const plan = planNpmCacheVictims(entries, 1500, 600);
    // Deduped index total counts the shared blob once (1000 + 500 = 1500),
    // not twice (which would read 2500). Victim selection then only needs
    // to evict the one shared-integrity entry to clear the 600 cap.
    expect(plan.indexedTotalBytes).toBe(1500);
    expect(plan.victims.map((v) => v.key)).toEqual(["registry-tarball:a"]);
    expect(plan.victimBytes).toBe(1000);
  });
});

describe("readNpmCacheIndex / planNpmCacheCap (mkdtemp synthetic tree)", () => {
  let cacachePath: string;

  beforeEach(async () => {
    cacachePath = await mkdtemp(join(tmpdir(), "spur-npm-cache-cap-"));
  });

  afterEach(async () => {
    await rm(cacachePath, { recursive: true, force: true });
  });

  async function writeIndexLine(hash: string, entry: Record<string, unknown>): Promise<void> {
    const dir = join(cacachePath, "index-v5", hash.slice(0, 2), hash.slice(2, 4));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, hash.slice(4)), `${hash}\t${JSON.stringify(entry)}\n`);
  }

  it("reads a real index-v5 tree and ranks it", async () => {
    await writeIndexLine("aabbccdd0001", {
      key: "make-fetch-happen:request-cache:https://registry/a",
      integrity: "sha512-a",
      time: 100,
      size: 1000,
    });
    await writeIndexLine("aabbccdd0002", {
      key: "make-fetch-happen:request-cache:https://registry/b",
      integrity: "sha512-b",
      time: 200,
      size: 2000,
    });

    const entries = await readNpmCacheIndex(cacachePath);
    expect(entries).toHaveLength(2);

    const result = await planNpmCacheCap(cacachePath, 3000, 2500);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.victims.map((v) => v.size)).toEqual([1000]);
    }
  });

  it("collapses repeated index-v5 lines for one key to the newest by time", async () => {
    const key = "make-fetch-happen:request-cache:https://registry/a";
    // cacache's index-v5 is append-only: a re-fetched key gets a second line
    // in the same bucket file rather than rewriting the first.
    const dir = join(cacachePath, "index-v5", "aa", "bb");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "aabbccdd"),
      [
        `aabbccdd0001\t${JSON.stringify({ key, integrity: "sha512-old", time: 100, size: 1000 })}`,
        `aabbccdd0002\t${JSON.stringify({ key, integrity: "sha512-new", time: 200, size: 2000 })}`,
      ].join("\n") + "\n",
    );

    const entries = await readNpmCacheIndex(cacachePath);
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toEqual({ key, integrity: "sha512-new", time: 200, size: 2000 });
  });

  it("a malformed index line fails closed and selects nothing", async () => {
    const dir = join(cacachePath, "index-v5", "aa", "bb");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "corrupt"), "aabbccdd\tnot-json-at-all\n");

    const entries = await readNpmCacheIndex(cacachePath);
    expect(entries).toBeUndefined();

    const result = await planNpmCacheCap(cacachePath, 999_999, 100);
    expect(result).toEqual({ ok: false, reason: "npm_index_unreadable" });
  });

  it("a missing index-v5 directory fails closed", async () => {
    const result = await planNpmCacheCap(join(cacachePath, "nope"), 999_999, 100);
    expect(result).toEqual({ ok: false, reason: "npm_index_unreadable" });
  });
});
