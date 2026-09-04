import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HistoryCaptureStamp,
  captureHistoryDelta,
  cutAtLastNewline,
  hashHistoryTail,
  historyStampKey,
  historyStampSessionId,
  planHistoryCapture,
} from "../../src/agent-history-delta.js";

const SOURCE = "/data/worktrees/api/api-1/.claude/transcript.jsonl";
const TAIL = hashHistoryTail(Buffer.from('{"type":"assistant"}\n', "utf8"));

function stamp(overrides: Partial<HistoryCaptureStamp> = {}): HistoryCaptureStamp {
  return {
    sourcePath: SOURCE,
    size: 2_004_249,
    mtimeMs: 1_770_000_000_000,
    offset: 2_004_249,
    tailHash: TAIL,
    ...overrides,
  };
}

describe("planHistoryCapture", () => {
  it("captures the full source when there is no previous stamp", () => {
    expect(planHistoryCapture(undefined, SOURCE, { size: 512, mtimeMs: 1 }, null)).toEqual({
      kind: "full",
      readFrom: 0,
    });
  });

  it("captures the full source on a source path change", () => {
    const previous = stamp({ sourcePath: "/data/status/api-1.json", size: 1_024, offset: 1_024 });
    expect(planHistoryCapture(previous, SOURCE, { size: 2_004_249, mtimeMs: 2 }, TAIL)).toEqual({
      kind: "full",
      readFrom: 0,
    });
  });

  it("captures the full source when the source was truncated below the offset", () => {
    expect(planHistoryCapture(stamp(), SOURCE, { size: 542_200, mtimeMs: 2 }, TAIL)).toEqual({
      kind: "full",
      readFrom: 0,
    });
  });

  it("captures the full source on an in-place rewrite at identical size and mtime", () => {
    const previous = stamp();
    const rewritten = hashHistoryTail(Buffer.from('{"type":"user"}\n', "utf8"));
    expect(
      planHistoryCapture(
        previous,
        SOURCE,
        { size: previous.size, mtimeMs: previous.mtimeMs },
        rewritten,
      ),
    ).toEqual({ kind: "full", readFrom: 0 });
  });

  it("captures nothing when size and mtime are unchanged", () => {
    const previous = stamp();
    expect(
      planHistoryCapture(
        previous,
        SOURCE,
        { size: previous.size, mtimeMs: previous.mtimeMs },
        TAIL,
      ),
    ).toEqual({ kind: "empty" });
  });

  it("captures a delta from the previous offset when the source grew", () => {
    const previous = stamp();
    expect(
      planHistoryCapture(previous, SOURCE, { size: previous.size + 900, mtimeMs: 9 }, TAIL),
    ).toEqual({ kind: "delta", readFrom: previous.offset });
  });

  it("captures a delta when only the mtime moved at an unchanged size", () => {
    const previous = stamp();
    expect(
      planHistoryCapture(previous, SOURCE, { size: previous.size, mtimeMs: 12 }, TAIL),
    ).toEqual({ kind: "delta", readFrom: previous.offset });
  });
});

describe("cutAtLastNewline", () => {
  it("returns 0 when the buffer holds no newline", () => {
    expect(cutAtLastNewline(Buffer.from('{"partial":', "utf8"))).toBe(0);
  });

  it("returns the whole length when the buffer ends on a newline", () => {
    const buffer = Buffer.from('{"a":1}\n{"b":2}\n', "utf8");
    expect(cutAtLastNewline(buffer)).toBe(buffer.length);
  });

  it("cuts a trailing partial line", () => {
    const buffer = Buffer.from('{"a":1}\n{"b"', "utf8");
    expect(cutAtLastNewline(buffer)).toBe(8);
  });
});

describe("captureHistoryDelta", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spur-history-delta-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function capture(sourcePath: string, previous: HistoryCaptureStamp | undefined) {
    const emitted: string[] = [];
    const stamp = captureHistoryDelta(sourcePath, previous, (payload) => {
      emitted.push(payload.toString("utf8"));
    });
    return { emitted, stamp };
  }

  it("emits the whole source on the first capture", () => {
    const source = join(dir, "transcript.jsonl");
    writeFileSync(source, '{"i":0}\n{"i":1}\n', "utf8");
    const { emitted, stamp } = capture(source, undefined);
    expect(emitted).toEqual(['{"i":0}\n{"i":1}\n']);
    expect(stamp?.offset).toBe(16);
  });

  it("emits the whole new source after a source path change", () => {
    const status = join(dir, "status.json");
    const transcript = join(dir, "transcript.jsonl");
    writeFileSync(status, '{"state":"waiting"}\n', "utf8");
    writeFileSync(transcript, '{"i":0}\n{"i":1}\n{"i":2}\n', "utf8");
    const first = capture(status, undefined);
    const second = capture(transcript, first.stamp ?? undefined);
    expect(second.emitted).toEqual(['{"i":0}\n{"i":1}\n{"i":2}\n']);
  });

  it("emits the whole shrunken source after a truncation", () => {
    const source = join(dir, "transcript.jsonl");
    writeFileSync(source, '{"i":0}\n{"i":1}\n{"i":2}\n', "utf8");
    const first = capture(source, undefined);
    writeFileSync(source, '{"i":9}\n', "utf8");
    const second = capture(source, first.stamp ?? undefined);
    expect(second.emitted).toEqual(['{"i":9}\n']);
  });

  it("emits the whole source after an in-place rewrite at identical size and mtime", () => {
    const source = join(dir, "transcript.jsonl");
    writeFileSync(source, '{"i":0}\n{"i":1}\n', "utf8");
    const first = capture(source, undefined);
    const before = statSync(source);
    writeFileSync(source, '{"i":8}\n{"i":9}\n', "utf8");
    utimesSync(source, before.atime, before.mtime);
    expect(statSync(source).size).toBe(before.size);
    const second = capture(source, first.stamp ?? undefined);
    expect(second.emitted).toEqual(['{"i":8}\n{"i":9}\n']);
  });

  it("emits nothing when the source is unchanged", () => {
    const source = join(dir, "transcript.jsonl");
    writeFileSync(source, '{"i":0}\n', "utf8");
    const first = capture(source, undefined);
    const second = capture(source, first.stamp ?? undefined);
    expect(second.emitted).toEqual([]);
    expect(second.stamp).toBeNull();
  });

  it("holds back a partial trailing line until it ends on a newline", () => {
    const source = join(dir, "transcript.jsonl");
    writeFileSync(source, '{"i":0}\n{"i"', "utf8");
    const first = capture(source, undefined);
    expect(first.emitted).toEqual(['{"i":0}\n']);
    writeFileSync(source, '{"i":0}\n{"i":1}\n', "utf8");
    const second = capture(source, first.stamp ?? undefined);
    expect(second.emitted).toEqual(['{"i":1}\n']);
  });

  it("emits a source that carries no newline at all", () => {
    const source = join(dir, "status.json");
    writeFileSync(source, '{"state":"waiting"}', "utf8");
    const { emitted, stamp } = capture(source, undefined);
    expect(emitted).toEqual(['{"state":"waiting"}']);
    expect(stamp?.offset).toBe(19);
  });
});

describe("historyStampKey", () => {
  it("keys per source path and parses back to the session id", () => {
    const key = historyStampKey("api-1", SOURCE);
    expect(key).not.toBe(historyStampKey("api-1", "/data/status/api-1.json"));
    expect(historyStampSessionId(key)).toBe("api-1");
  });
});
