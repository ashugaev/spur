import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { gunzipSync, gzipSync } from "node:zlib";

const READ_CHUNK = 1 << 16; // 64 KiB — keeps peak memory bounded regardless of file size.

export function archivePath(path: string, index: number): string {
  return `${path}.${index}.gz`;
}

export function readFileBytes(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, buf, offset, size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return buf;
  } finally {
    closeSync(fd);
  }
}

// Single shared rotation helper. Crash-tolerant; callers wrap in try/catch so a
// rotation failure never breaks the logging hot path.
function maybeRotate(path: string, maxBytes: number, retainArchives: number): void {
  if (!existsSync(path) || statSync(path).size <= maxBytes) {
    return;
  }
  // Shift existing <path>.N.gz upward (descending) and prune beyond retainArchives.
  for (let index = retainArchives; index >= 1; index -= 1) {
    const current = archivePath(path, index);
    if (!existsSync(current)) continue;
    if (index >= retainArchives) {
      unlinkSync(current);
      continue;
    }
    renameSync(current, archivePath(path, index + 1));
  }
  // Move the live file aside, gzip it into .1.gz, drop the temp.
  const temp = `${path}.1`;
  renameSync(path, temp);
  writeFileSync(archivePath(path, 1), gzipSync(readFileBytes(temp)), { mode: 0o600 });
  unlinkSync(temp);
}

export function tryRotate(path: string, maxBytes: number, retainArchives: number): void {
  try {
    maybeRotate(path, maxBytes, retainArchives);
  } catch {
    // Rotation must never block Spur runtime behavior.
  }
}

// Split decoded string chunks into newline-delimited lines. The caller pushes chunks
// via write(); flush() drains the trailing carry. Holds at most one pending line, so
// it adds no memory beyond what the chunk source already keeps resident.
function makeLineSplitter() {
  let carry = "";
  return {
    *write(chunk: string): Generator<string> {
      carry += chunk;
      let idx = carry.indexOf("\n");
      while (idx !== -1) {
        yield carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        idx = carry.indexOf("\n");
      }
    },
    *flush(tail: string): Generator<string> {
      carry += tail;
      if (carry.length > 0) yield carry;
    },
  };
}

// Streams the live (uncompressed) log in 64 KiB readSync chunks — never loads the
// whole file, keeping peak memory bounded regardless of file size.
export function* iterLiveLines(path: string): Generator<string> {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const buf = Buffer.alloc(READ_CHUNK);
    const decoder = new StringDecoder("utf8");
    const splitter = makeLineSplitter();
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, buf, 0, Math.min(READ_CHUNK, size - offset), offset);
      if (n <= 0) break;
      offset += n;
      yield* splitter.write(decoder.write(buf.subarray(0, n)));
    }
    yield* splitter.flush(decoder.end());
  } finally {
    closeSync(fd);
  }
}

// Transparent gzip read: decompress once, then iterate the decompressed buffer in
// 64 KiB chunks. (gunzipSync materializes the full decompressed buffer — tracked as a
// separate streaming-vs-gunzip review item.)
function* iterGzipLogLines(path: string): Generator<string> {
  if (!existsSync(path)) return;
  const decompressed = gunzipSync(readFileBytes(path));
  const decoder = new StringDecoder("utf8");
  const splitter = makeLineSplitter();
  let offset = 0;
  while (offset < decompressed.length) {
    const end = Math.min(offset + READ_CHUNK, decompressed.length);
    yield* splitter.write(decoder.write(decompressed.subarray(offset, end)));
    offset = end;
  }
  yield* splitter.flush(decoder.end());
}

// Archived shards oldest-first (highest index down to .1.gz), then the live path.
export function* iterArchivedThenLive(path: string, retainArchives: number): Generator<string> {
  for (let index = retainArchives; index >= 1; index -= 1) {
    yield* iterGzipLogLines(archivePath(path, index));
  }
  yield* iterLiveLines(path);
}

export function parseJsonLine<T>(line: string): T | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}
