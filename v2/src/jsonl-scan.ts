import { open } from "node:fs/promises";
import { hashHistoryTail, PREFIX_VERIFY_BYTES } from "./agent-history-delta.js";

// Ceiling on one read's allocation. Whole-file reads of multi-MB transcripts
// plus a string copy exhaust the daemon heap at boot, when every reader is cold.
export const SCAN_CHUNK_BYTES = 1 << 20; // 1 MiB

/**
 * Feed each non-empty trimmed line of `[offset, size)` to `onLine`, reading at
 * most `chunkBytes` at a time. `size` defaults to the opened handle's size.
 *
 * `consumedBytes` counts whole terminated lines. A trailing unterminated line
 * is consumed only when `onLine(line, false)` returns true; a rejected one is
 * excluded and re-read once its completing bytes arrive. The return value is
 * ignored for terminated lines. `tail` copies the last PREFIX_VERIFY_BYTES of
 * bytes consumed in this scan. `onConsumed` observes those raw bytes synchronously
 * per consumed chunk, including whitespace and terminators. Returns null on fs errors.
 */
export async function scanJsonlLines(
  filePath: string,
  offset: number,
  onLine: (line: string, terminated: boolean) => boolean,
  size?: number,
  onConsumed?: (bytes: Buffer) => void,
  chunkBytes = SCAN_CHUNK_BYTES,
): Promise<{ consumedBytes: number; tail: Buffer } | null> {
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(filePath, "r");
    const end = size ?? (await fd.stat()).size;
    let position = offset;
    let pending = Buffer.alloc(0);
    let tail: Buffer = Buffer.alloc(0);
    const retainTail = (bytes: Buffer): void => {
      onConsumed?.(bytes);
      tail = Buffer.from(
        Buffer.concat([tail, bytes.subarray(-PREFIX_VERIFY_BYTES)]).subarray(-PREFIX_VERIFY_BYTES),
      );
    };
    while (position < end) {
      const length = Math.min(chunkBytes, end - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await fd.read(chunk, 0, length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const combined =
        pending.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      const lastNewline = combined.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        pending = combined;
        continue;
      }
      for (const line of combined
        .subarray(0, lastNewline + 1)
        .toString("utf8")
        .split("\n")) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed, true);
      }
      retainTail(combined.subarray(0, lastNewline + 1));
      pending = combined.subarray(lastNewline + 1);
    }
    const trailing = pending.toString("utf8").trim();
    if (trailing && onLine(trailing, false)) {
      retainTail(pending);
      pending = Buffer.alloc(0);
    }
    return { consumedBytes: position - offset - pending.length, tail };
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}

/** Hash of the last PREFIX_VERIFY_BYTES before `endOffset`; null on any fs error. */
export async function readJsonlTailHash(
  filePath: string,
  endOffset: number,
): Promise<string | null> {
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(filePath, "r");
    const start = Math.max(0, endOffset - PREFIX_VERIFY_BYTES);
    const buffer = Buffer.alloc(endOffset - start);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, start);
    return hashHistoryTail(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}
