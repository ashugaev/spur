import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// Bytes hashed at the end of the captured prefix. Sized to hold several JSONL
// records so an in-place rewrite of the tail is detected, while keeping the
// per-transition read O(1) instead of O(source).
export const PREFIX_VERIFY_BYTES = 4096;

const STAMP_KEY_SEPARATOR = "\u0000";

export interface HistoryCaptureStamp {
  sourcePath: string;
  size: number;
  mtimeMs: number;
  offset: number;
  tailHash: string;
}

export type HistoryDeltaPlan =
  | { kind: "full"; readFrom: 0 }
  | { kind: "delta"; readFrom: number }
  | { kind: "empty" };

// One session alternates between the ~1 KB agent status file and the multi-MB
// transcript across consecutive transitions, so the stamp slot is per source
// path, not per session.
export function historyStampKey(sessionId: string, sourcePath: string): string {
  return `${sessionId}${STAMP_KEY_SEPARATOR}${sourcePath}`;
}

export function historyStampSessionId(stampKey: string): string {
  const separatorIndex = stampKey.indexOf(STAMP_KEY_SEPARATOR);
  return separatorIndex === -1 ? stampKey : stampKey.slice(0, separatorIndex);
}

export function hashHistoryTail(tail: Buffer): string {
  return createHash("sha256").update(tail).digest("hex");
}

// Rule order is load-bearing: the tail-hash rule sits before the empty rule so
// an in-place rewrite at identical size and mtime is captured instead of
// silently swallowed.
export function planHistoryCapture(
  previous: HistoryCaptureStamp | undefined,
  sourcePath: string,
  stat: { size: number; mtimeMs: number },
  currentTailHash: string | null,
): HistoryDeltaPlan {
  if (!previous) {
    return { kind: "full", readFrom: 0 };
  }
  if (previous.sourcePath !== sourcePath) {
    return { kind: "full", readFrom: 0 };
  }
  if (stat.size < previous.offset) {
    return { kind: "full", readFrom: 0 };
  }
  if (previous.tailHash !== currentTailHash) {
    return { kind: "full", readFrom: 0 };
  }
  if (stat.size === previous.offset && stat.mtimeMs === previous.mtimeMs) {
    return { kind: "empty" };
  }
  return { kind: "delta", readFrom: previous.offset };
}

// Length of the buffer prefix that ends on a line boundary. 0 when the buffer
// holds no newline.
export function cutAtLastNewline(buffer: Buffer): number {
  return buffer.lastIndexOf(0x0a) + 1;
}

// Bytes ending at `endOffset`, capped at PREFIX_VERIFY_BYTES. Fingerprints the
// captured prefix so an in-place rewrite of the source forces a full copy
// without ever reading the whole file.
function readHistoryTail(fd: number, endOffset: number): Buffer {
  const length = Math.min(PREFIX_VERIFY_BYTES, endOffset);
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const tail = Buffer.alloc(length);
  const read = readSync(fd, tail, 0, length, endOffset - length);
  return read === length ? tail : tail.subarray(0, read);
}

// Emits the bytes the source gained since `previous`, or the whole source when
// the planner resets. Returns null when there is nothing to emit — no artifact
// is written and the caller keeps the previous stamp.
export function captureHistoryDelta(
  sourcePath: string,
  previous: HistoryCaptureStamp | undefined,
  writeArtifact: (payload: Buffer) => void,
): HistoryCaptureStamp | null {
  const fd = openSync(sourcePath, "r");
  try {
    const stat = fstatSync(fd);
    const currentTailHash =
      previous && stat.size >= previous.offset
        ? hashHistoryTail(readHistoryTail(fd, previous.offset))
        : null;
    const plan = planHistoryCapture(previous, sourcePath, stat, currentTailHash);
    if (plan.kind === "empty") {
      return null;
    }
    const pending = Buffer.alloc(stat.size - plan.readFrom);
    if (pending.length > 0) {
      readSync(fd, pending, 0, pending.length, plan.readFrom);
    }
    // Cut on a line boundary so every emitted file is valid JSONL and no
    // partial line is written twice. A source that carries no newline at all
    // (the agent status JSON) is emitted whole.
    const cut = cutAtLastNewline(pending);
    if (cut === 0 && plan.kind === "delta") {
      return null;
    }
    const payload = cut > 0 ? pending.subarray(0, cut) : pending;
    if (payload.length === 0) {
      return null;
    }
    // Written once and never reopened: the artifact route sets content-length
    // from a stat taken before it streams the file.
    writeArtifact(payload);
    const offset = plan.readFrom + payload.length;
    return {
      sourcePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      offset,
      tailHash: hashHistoryTail(readHistoryTail(fd, offset)),
    };
  } finally {
    closeSync(fd);
  }
}
