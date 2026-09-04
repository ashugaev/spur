import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HistoryCaptureStamp, captureHistoryDelta } from "../../src/agent-history-delta.js";

// Measurement instrument for the PR body. Reproduces the two host failure
// modes at reduced scale and reports bytes written before and after the delta
// capture. BEFORE is exact arithmetic from the same run: the pre-change code
// wrote exactly one file holding the whole source on every invocation, so
// BEFORE bytes = sum of the source size at each capture and BEFORE files =
// number of captures.
const FLAP_SOURCE_BYTES = 1_031_384;
const FLAP_CAPTURES = 200;
const GROW_APPEND_BYTES = 8_000;
const GROW_CAPTURES = 149;

interface Measurement {
  beforeBytes: number;
  beforeFiles: number;
  afterBytes: number;
  afterFiles: number;
}

function jsonlBlock(bytes: number, marker: number): string {
  const prefix = `{"i":${marker},"pad":"`;
  const suffix = '"}\n';
  return prefix + "x".repeat(bytes - prefix.length - suffix.length) + suffix;
}

describe("agent history delta size", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spur-history-delta-size-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function measure(sourcePath: string, driveCapture: (capture: () => void) => void): Measurement {
    let stamp: HistoryCaptureStamp | undefined;
    let beforeBytes = 0;
    let beforeFiles = 0;
    let afterBytes = 0;
    let afterFiles = 0;
    driveCapture(() => {
      beforeBytes += statSync(sourcePath).size;
      beforeFiles += 1;
      const next = captureHistoryDelta(sourcePath, stamp, (payload) => {
        afterBytes += payload.length;
        afterFiles += 1;
      });
      if (next) {
        stamp = next;
      }
    });
    return { beforeBytes, beforeFiles, afterBytes, afterFiles };
  }

  it("collapses an unchanged flapping source to a single capture", () => {
    const source = join(dir, "flap.jsonl");
    writeFileSync(source, jsonlBlock(FLAP_SOURCE_BYTES, 0), "utf8");
    expect(statSync(source).size).toBe(FLAP_SOURCE_BYTES);

    const result = measure(source, (capture) => {
      for (let index = 0; index < FLAP_CAPTURES; index += 1) {
        capture();
      }
    });

    expect(result.beforeBytes).toBe(FLAP_SOURCE_BYTES * FLAP_CAPTURES);
    expect(result.beforeFiles).toBe(FLAP_CAPTURES);
    expect(result.afterFiles).toBe(1);
    expect(result.afterBytes).toBeLessThanOrEqual(Math.round(FLAP_SOURCE_BYTES * 1.1));
    expect(result.beforeBytes / result.afterBytes).toBeGreaterThanOrEqual(150);
    console.log("FLAP", JSON.stringify(result));
  });

  it("collapses a growing source to roughly its final size", () => {
    const source = join(dir, "grow.jsonl");
    writeFileSync(source, "", "utf8");

    const result = measure(source, (capture) => {
      for (let index = 0; index < GROW_CAPTURES; index += 1) {
        appendFileSync(source, jsonlBlock(GROW_APPEND_BYTES, index), "utf8");
        capture();
      }
    });

    const finalBytes = statSync(source).size;
    expect(finalBytes).toBe(GROW_APPEND_BYTES * GROW_CAPTURES);
    expect(result.beforeBytes).toBe(
      (GROW_APPEND_BYTES * (GROW_CAPTURES * (GROW_CAPTURES + 1))) / 2,
    );
    expect(result.beforeFiles).toBe(GROW_CAPTURES);
    expect(result.afterFiles).toBe(GROW_CAPTURES);
    expect(result.afterBytes).toBeLessThanOrEqual(Math.round(finalBytes * 1.05));
    expect(result.beforeBytes / result.afterBytes).toBeGreaterThanOrEqual(50);
    console.log("GROW", JSON.stringify(result));
  });
});
