import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProgram, renderOpenCodeGcResult } from "../../src/cli.js";
import type {
  OpenCodeGcLogResult,
  OpenCodeGcReport,
  OpenCodeGcSessionResult,
} from "../../src/opencode-gc.js";

function command() {
  const found = createProgram("/tmp/dist/cli.js").commands.find(
    (entry) => entry.name() === "opencode-gc",
  );
  if (!found) throw new Error("opencode-gc command is not registered");
  return found;
}

const SESSION: OpenCodeGcSessionResult = {
  id: "ses_fc843fe5dffegfDFNqCKw6TP4W",
  directory: "/w/a",
  canonicalDirectory: "/w/a",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ageDays: 40.5,
  recordIds: ["spur-a"],
  deleted: false,
};

const LOG: OpenCodeGcLogResult = {
  path: "/store/log/opencode.log",
  archivePath: "/store/log/opencode.log.1",
  duBytes: 484_297_755,
  retainedBytes: 16_777_216,
  freedBytes: 467_520_539,
  projected: true,
  truncated: false,
};

function report(overrides: Partial<OpenCodeGcReport> = {}): OpenCodeGcReport {
  return {
    dryRun: true,
    storeRoot: "/store",
    reason: null,
    olderThanDays: 14,
    statuses: ["completed", "killed"],
    enumeration: {
      directories: ["/home/alek/projects/ao"],
      directoriesFailed: 0,
      listedCount: 279,
      limit: 100_000,
      truncated: false,
      note: "floor",
    },
    sessions: [SESSION],
    skipped: [{ id: "ses_other", reason: "protected_live_record" }],
    snapshotLeaves: [{ path: "/store/snapshot/p/dead", sizeBytes: 80_146_432, removed: false }],
    log: LOG,
    vacuum: { attempted: false, ok: false, blockReasons: ["dry_run", "no_sessions_deleted"] },
    totals: {
      sessionsSelected: 1,
      sessionsDeleted: 0,
      sessionsBlocked: 0,
      snapshotLeavesRemoved: 0,
      freedBytes: 547_666_971,
      dbFileBytesFreed: null,
      errors: 0,
    },
    ...overrides,
  };
}

describe("spur opencode-gc options (AC9)", () => {
  it("exposes --execute and never a --dry-run flag", () => {
    const flags = command()
      .options.map((option) => option.long)
      .filter((long): long is string => Boolean(long));

    expect(flags).toEqual([
      "--execute",
      "--older-than",
      "--statuses",
      "--limit",
      "--no-sizes",
      "--json",
    ]);
    expect(flags).not.toContain("--dry-run");
  });

  it("leaves --execute unset by default, so a bare run is a dry run", () => {
    expect(command().opts()["execute"]).toBeUndefined();
    // `--no-sizes` inverts, so `sizes` defaults true and `dryRun` is
    // `!options.execute`.
    expect(command().opts()["sizes"]).toBe(true);
  });

  it("I10 the string --dry-run does not exist anywhere in cli.ts", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
      "utf8",
    );

    expect(source.includes("--dry-run")).toBe(false);
  });
});

describe("renderOpenCodeGcResult", () => {
  it("reports file bytes and the VACUUM delta, and estimates no DB bytes", () => {
    const rendered = renderOpenCodeGcResult(report());

    expect(rendered).toContain("Freed (files): 522.3 MB");
    expect(rendered).toContain("DB file bytes returned by VACUUM: -");
    expect(rendered).toContain("DB bytes are known after the VACUUM runs");
    // No up-front payload estimate exists any more: producing one would open
    // the store, and even a read-only URI rewrites the -shm.
    expect(rendered).not.toContain("estimate");
  });

  it("states the enumeration scope, so a blind plan cannot read as an empty one", () => {
    const listed = renderOpenCodeGcResult(report());
    const blind = renderOpenCodeGcResult(
      report({
        sessions: [],
        snapshotLeaves: [],
        log: null,
        enumeration: { ...report().enumeration, directories: [], listedCount: 0 },
      }),
    );

    expect(listed).toContain("from 1 candidate directory");
    expect(listed).toContain("project-scoped by its cwd");
    expect(listed).toContain("listed  /home/alek/projects/ao");
    expect(blind).toContain("from 0 candidate directories");
    expect(blind).toContain("No candidate directory");
    expect(blind).toContain("Nothing to collect.");
  });

  it("names how many directories failed to list", () => {
    const rendered = renderOpenCodeGcResult(
      report({ enumeration: { ...report().enumeration, directoriesFailed: 2 } }),
    );

    expect(rendered).toContain("2 directories failed to list");
  });

  it("states the total is a floor and names the escape hatch on a dry run", () => {
    const rendered = renderOpenCodeGcResult(report());

    expect(rendered).toContain("a floor");
    expect(rendered).toContain("Re-run with --execute to apply.");
    expect(rendered).toContain("VACUUM skipped: dry_run,no_sessions_deleted.");
  });

  it("marks a projected log term and leaves a measured one unmarked", () => {
    const dry = renderOpenCodeGcResult(report());
    const executed = renderOpenCodeGcResult(
      report({
        dryRun: false,
        log: { ...LOG, projected: false, truncated: true },
      }),
    );

    expect(dry).toContain("[projected, not measured]");
    expect(executed).not.toContain("[projected, not measured]");
  });

  it("names a session blocked by the execute-time freshness re-read", () => {
    const rendered = renderOpenCodeGcResult(
      report({
        dryRun: false,
        sessions: [{ ...SESSION, blockReason: "changed_during_run" }],
        totals: { ...report().totals, sessionsBlocked: 1 },
      }),
    );

    expect(rendered).toContain("blocked");
    expect(rendered).toContain("changed_during_run");
    expect(rendered).toContain("1 blocked by a status change during the run");
  });

  it("renders nothing but the reason when the store could not be resolved", () => {
    expect(renderOpenCodeGcResult(report({ reason: "store_unresolved" }))).toContain(
      "No plan: store_unresolved",
    );
  });
});
