import type * as NodeFs from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Counts the three fs calls the nested walk makes below depth 1 (readdirSync per descended
// directory, realpathSync and statSync per entry). vi.spyOn cannot wrap these bindings:
// session-artifacts.ts imports them as named ESM bindings, and vitest throws
// "Cannot spy on export ... Module namespace is not configurable in ESM." Wrapping node:fs
// itself with vi.mock's importOriginal delegates to the real filesystem so the fixture tree
// still gets built and walked for real; only the call counts are observed.
const counts = vi.hoisted(() => ({ readdirSync: 0, realpathSync: 0, statSync: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readdirSync: ((...args: unknown[]) => {
      counts.readdirSync++;
      return (actual.readdirSync as (...fnArgs: unknown[]) => unknown)(...args);
    }) as unknown as typeof actual.readdirSync,
    realpathSync: ((...args: unknown[]) => {
      counts.realpathSync++;
      return (actual.realpathSync as (...fnArgs: unknown[]) => unknown)(...args);
    }) as unknown as typeof actual.realpathSync,
    statSync: ((...args: unknown[]) => {
      counts.statSync++;
      return (actual.statSync as (...fnArgs: unknown[]) => unknown)(...args);
    }) as unknown as typeof actual.statSync,
  };
});

const { MAX_NESTED_ARTIFACT_WALK_ENTRIES, listSessionArtifacts, sessionArtifactsDir } =
  await import("../../src/session-artifacts.js");
const { createTempDir } = await import("../helpers/common.js");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  counts.readdirSync = 0;
  counts.realpathSync = 0;
  counts.statSync = 0;
});

describe("session artifact walk budget", () => {
  it("examines at most MAX_NESTED_ARTIFACT_WALK_ENTRIES entries below the root", async () => {
    const dataDir = await createTempDir("spur-artifacts-budget-");
    tempDirs.push(dataDir);
    const sessionId = "api-budget";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    mkdirSync(dir, { recursive: true });

    // 200 depth-1 files, unbudgeted, plus 20 depth-1 directories each holding 300 nested
    // files: 6,000 nested files, far past MAX_NESTED_ARTIFACT_WALK_ENTRIES.
    const depth1Count = 200;
    for (let index = 0; index < depth1Count; index++) {
      writeFileSync(join(dir, `root-${index}.txt`), "x", "utf8");
    }
    for (let dirIndex = 0; dirIndex < 20; dirIndex++) {
      const nestedDir = join(dir, `nested-${dirIndex}`);
      mkdirSync(nestedDir, { recursive: true });
      for (let fileIndex = 0; fileIndex < 300; fileIndex++) {
        writeFileSync(join(nestedDir, `f-${fileIndex}.txt`), "x", "utf8");
      }
    }

    // Only the walk under test should be measured; discard whatever the fixture setup and
    // createTempDir's own containment checks cost.
    counts.readdirSync = 0;
    counts.realpathSync = 0;
    counts.statSync = 0;

    const { truncated } = listSessionArtifacts(dataDir, sessionId);
    expect(truncated).toBe(true);

    // One readdirSync per directory descended below the root, one realpathSync and one
    // statSync per entry examined below the root: each bounded by the walk-entry budget.
    // The root level is unbudgeted by design (D8) and still costs its own small, fixed
    // overhead: one readdirSync, one realpathSync (resolving the root itself), and one
    // statSync per depth-1 plain file (no realpathSync needed there — see the "root-level
    // syscall note"). That overhead is linear in depth1Count, not in the 6,000-file nested
    // tree, so a generous fixed allowance still proves the nested walk itself is bounded.
    const rootOverhead = depth1Count + 10;
    expect(counts.realpathSync).toBeLessThanOrEqual(
      MAX_NESTED_ARTIFACT_WALK_ENTRIES + rootOverhead,
    );
    expect(counts.statSync).toBeLessThanOrEqual(MAX_NESTED_ARTIFACT_WALK_ENTRIES + rootOverhead);
    expect(counts.readdirSync).toBeLessThanOrEqual(MAX_NESTED_ARTIFACT_WALK_ENTRIES + rootOverhead);
    // And it must be nowhere near the unbounded case: 6,000 nested files plus 20
    // directories would cost ~6,020 stat/realpath calls if the walk were unbounded.
    expect(counts.statSync).toBeLessThan(6000);
  });
});
