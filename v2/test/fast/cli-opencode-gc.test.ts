import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProgram, renderOpenCodeGcResult } from "../../src/cli.js";
import type { OpenCodeGcReport } from "../../src/opencode-gc.js";

function command() {
  const found = createProgram("/tmp/dist/cli.js").commands.find(
    (entry) => entry.name() === "opencode-gc",
  );
  if (!found) throw new Error("opencode-gc command is not registered");
  return found;
}

function report(overrides: Partial<OpenCodeGcReport> = {}): OpenCodeGcReport {
  return {
    dryRun: true,
    storeRoot: "/store",
    reason: null,
    olderThanDays: 14,
    statuses: ["completed", "killed"],
    enumeration: { listedCount: 279, limit: 100_000, truncated: false, note: "floor" },
    sessions: [
      {
        id: "ses_fc843fe5dffegfDFNqCKw6TP4W",
        directory: "/w/a",
        canonicalDirectory: "/w/a",
        updatedAt: "2026-08-01T00:00:00.000Z",
        ageDays: 40.5,
        recordIds: ["spur-a"],
        deleted: false,
      },
    ],
    skipped: [{ id: "ses_other", reason: "protected_live_record" }],
    snapshotLeaves: [{ path: "/store/snapshot/p/dead", sizeBytes: 80_146_432, removed: false }],
    log: {
      path: "/store/log/opencode.log",
      archivePath: "/store/log/opencode.log.1",
      duBytes: 484_297_755,
      retainedBytes: 16_777_216,
      freedBytes: 467_520_539,
      projected: true,
      truncated: false,
    },
    vacuum: { attempted: false, ok: false, blockReasons: ["no_sessions_deleted"] },
    totals: {
      sessionsSelected: 1,
      sessionsDeleted: 0,
      snapshotLeavesRemoved: 0,
      freedBytes: 547_666_971,
      dbPayloadBytesEstimate: 2_100_182_202,
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
  it("labels the DB payload an estimate and never sums it into freed bytes (I4)", () => {
    const rendered = renderOpenCodeGcResult(report());

    expect(rendered).toContain("DB payload (estimate, not disk): 2.0 GB");
    expect(rendered).toContain("Freed (files): 522.3 MB");
    expect(rendered).toContain("DB file bytes returned by VACUUM: -");
  });

  it("states the total is a floor and names the escape hatch on a dry run", () => {
    const rendered = renderOpenCodeGcResult(report());

    expect(rendered).toContain("a floor");
    expect(rendered).toContain("Re-run with --execute to apply.");
    expect(rendered).toContain("VACUUM skipped: no_sessions_deleted.");
  });

  it("renders nothing but the reason when the store could not be resolved", () => {
    expect(renderOpenCodeGcResult(report({ reason: "store_unresolved" }))).toContain(
      "No plan: store_unresolved",
    );
  });
});
