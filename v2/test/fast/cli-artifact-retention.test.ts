import { describe, expect, it } from "vitest";
import type { ArtifactRetentionReport } from "../../src/artifact-retention.js";
import { createProgram, renderArtifactRetentionResult } from "../../src/cli.js";

function report(overrides: Partial<ArtifactRetentionReport> = {}): ArtifactRetentionReport {
  return {
    dryRun: true,
    olderThanDays: 30,
    maxBytesPerSession: 2_147_483_648,
    maxFilesPerSession: 500,
    limit: 100,
    scanned: { anchors: 640, files: 26_110 },
    anchors: [
      {
        anchorId: "spur-b06c",
        sessionIds: ["spur-1d91"],
        totalFiles: 9356,
        totalBytes: 9_649_631_452,
        evictFiles: 8856,
        evictBytes: 9_100_000_000,
        deletedFiles: 0,
        freedBytes: 9_100_000_000,
        blockReasons: [],
      },
    ],
    totals: {
      anchors: 1,
      evictFiles: 8856,
      evictBytes: 9_100_000_000,
      freedBytes: 9_100_000_000,
      errors: 0,
    },
    ...overrides,
  };
}

describe("renderArtifactRetentionResult", () => {
  it("says what a dry run would free and how to apply it", () => {
    const output = renderArtifactRetentionResult(report());
    expect(output).toContain("Scanned 26110 artifact(s) across 640 anchor(s)");
    expect(output).toContain("spur-b06c");
    expect(output).toContain("8856 artifact(s) selected");
    expect(output).toContain("would be freed");
    expect(output).toContain("Re-run with --execute to apply.");
  });

  it("drops the dry-run wording once the run executed", () => {
    const output = renderArtifactRetentionResult(
      report({
        dryRun: false,
        anchors: [],
        totals: {
          anchors: 0,
          evictFiles: 0,
          evictBytes: 0,
          freedBytes: 0,
          errors: 0,
        },
      }),
    );
    expect(output).toContain("Nothing to prune.");
    expect(output).not.toContain("--execute");
  });

  it("renders a blocked anchor's reason instead of its size", () => {
    const output = renderArtifactRetentionResult(
      report({
        anchors: [
          {
            anchorId: "spur-3e4a",
            sessionIds: ["spur-3e4a"],
            totalFiles: 149,
            totalBytes: 1_204_333_560,
            evictFiles: 0,
            evictBytes: 0,
            deletedFiles: 0,
            freedBytes: 0,
            blockReasons: ["listing_truncated"],
          },
        ],
      }),
    );
    expect(output).toContain("listing_truncated");
  });
});

describe("spur artifacts-gc surface", () => {
  const command = () =>
    createProgram("/tmp/dist/cli.js").commands.find((entry) => entry.name() === "artifacts-gc");

  it("is registered and dry run by default", () => {
    const help = command()?.helpInformation() ?? "";
    // Dry-run-by-default is the safety contract: --execute is opt-in, and there is no
    // --dry-run flag to forget, so an operator can never delete by omission.
    expect(help).toContain("dry run unless --execute");
    expect(help).toContain("--execute");
    expect(help).not.toContain("--dry-run");
    expect(command()?.options.map((option) => option.long)).toEqual([
      "--execute",
      "--older-than",
      "--max-bytes",
      "--max-files",
      "--project",
      "--limit",
      "--json",
    ]);
  });

  it("leaves --execute unset when it is not passed", () => {
    const parsed = command();
    parsed?.parseOptions(["--limit", "5"]);
    expect(parsed?.opts()["execute"]).toBeUndefined();
  });
});
