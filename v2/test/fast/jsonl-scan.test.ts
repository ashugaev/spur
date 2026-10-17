import type * as FsPromises from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREFIX_VERIFY_BYTES, hashHistoryTail } from "../../src/agent-history-delta.js";
import { SCAN_CHUNK_BYTES, readJsonlTailHash, scanJsonlLines } from "../../src/jsonl-scan.js";

const readLengths: number[] = [];
const readBuffers: Buffer[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<unknown>;
      (handle as unknown as { read: unknown }).read = (...a: unknown[]) => {
        readLengths.push(a[2] as number);
        readBuffers.push(a[0] as Buffer);
        return read(...a);
      };
      return handle;
    },
  };
});

let dir = "";

beforeEach(async () => {
  readLengths.length = 0;
  readBuffers.length = 0;
  dir = await mkdtemp(join(tmpdir(), "jsonl-scan-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function collect(
  path: string,
  offset = 0,
  accept = true,
  size?: number,
): Promise<{ lines: string[]; flags: boolean[]; consumedBytes: number } | null> {
  const lines: string[] = [];
  const flags: boolean[] = [];
  const scan = await scanJsonlLines(
    path,
    offset,
    (line, terminated) => {
      flags.push(terminated);
      if (terminated || accept) lines.push(line);
      return accept;
    },
    size,
  );
  return scan ? { lines, flags, consumedBytes: scan.consumedBytes } : null;
}

describe("scanJsonlLines", () => {
  it.each([
    { body: "", offset: 0, size: 0, accept: true },
    { body: ' \t\r\n{"a":"é🙂"}\r\n \t', offset: 0, accept: true },
    { body: '{"skip":1}\n \t{"a":"é🙂"} \r', offset: 11, accept: true },
    { body: '{"a":1}\n{"partial"', offset: 0, accept: false },
    { body: '{"a":1}\n{"b":2}\n', offset: 0, size: 8, accept: true },
    { body: " \t\r", offset: 0, accept: true },
    { body: `{"long":"${"é🙂".repeat(SCAN_CHUNK_BYTES / 2)}"}\n`, offset: 0, accept: true },
  ])("returns an owned raw consumed tail for case %#", async ({ body, offset, size, accept }) => {
    const path = join(dir, "raw-tail.jsonl");
    const raw = Buffer.from(body);
    await writeFile(path, raw);
    const flags: boolean[] = [];
    const scan = await scanJsonlLines(
      path,
      offset,
      (_line, terminated) => {
        flags.push(terminated);
        return accept;
      },
      size,
    );
    expect(scan).not.toBeNull();
    if (!scan) throw new Error("expected scan");
    const end = offset + scan.consumedBytes;
    const expected = raw.subarray(Math.max(offset, end - PREFIX_VERIFY_BYTES), end);
    expect(scan.tail).toEqual(expected);
    expect(scan.tail.length).toBe(Math.min(PREFIX_VERIFY_BYTES, scan.consumedBytes));
    expect(readLengths.reduce((sum, length) => sum + length, 0)).toBe(
      (size ?? raw.length) - offset,
    );
    for (const buffer of readBuffers) buffer.fill(0);
    expect(scan.tail).toEqual(expected);
    if (body.endsWith('{"partial"')) {
      expect(scan.consumedBytes).toBe(8);
      expect(flags).toEqual([true, false]);
    }
    if (body === " \t\r") {
      expect(scan.consumedBytes).toBe(0);
      expect(flags).toEqual([]);
    }
  });

  it("returns null when a callback throws", async () => {
    const path = join(dir, "callback-error.jsonl");
    await writeFile(path, '{"a":1}\n');
    expect(
      await scanJsonlLines(path, 0, () => {
        throw new Error("callback failed");
      }),
    ).toBeNull();
  });

  it("yields every line once across a multi-chunk file in bounded reads", async () => {
    const filler = "x".repeat(1000);
    const lines = Array.from({ length: 3 * Math.ceil(SCAN_CHUNK_BYTES / 1000) + 7 }, (_, i) =>
      JSON.stringify({ i, filler }),
    );
    const body = `${lines.join("\n")}\n`;
    const path = join(dir, "a.jsonl");
    await writeFile(path, body);

    const result = await collect(path);

    expect(result?.lines).toEqual(lines);
    expect(result?.consumedBytes).toBe(Buffer.byteLength(body));
    expect(Math.max(...readLengths)).toBeLessThanOrEqual(SCAN_CHUNK_BYTES);
    expect(readLengths.length).toBeGreaterThanOrEqual(3);
  });

  it("handles a line longer than one chunk", async () => {
    const long = JSON.stringify({ blob: "y".repeat(SCAN_CHUNK_BYTES * 2 + 5) });
    const path = join(dir, "long.jsonl");
    await writeFile(path, `${long}\n{"a":1}\n`);

    const result = await collect(path);

    expect(result?.lines).toEqual([long, '{"a":1}']);
    expect(Math.max(...readLengths)).toBeLessThanOrEqual(SCAN_CHUNK_BYTES);
  });

  it("consumes a complete unterminated trailing line the callback accepts", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, '{"a":1}\n{"b":2}');

    const result = await collect(path);

    expect(result?.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(result?.flags).toEqual([true, false]);
    expect(result?.consumedBytes).toBe(Buffer.byteLength('{"a":1}\n{"b":2}'));
  });

  it("excludes a trailing line the callback rejects from consumedBytes", async () => {
    const path = join(dir, "r.jsonl");
    await writeFile(path, '{"a":1}\n{"b"');

    const result = await collect(path, 0, false);

    expect(result?.lines).toEqual(['{"a":1}']);
    expect(result?.consumedBytes).toBe(Buffer.byteLength('{"a":1}\n'));
  });

  it("starts at the given offset", async () => {
    const path = join(dir, "o.jsonl");
    await writeFile(path, '{"a":1}\n{"b":2}\n');

    const result = await collect(path, Buffer.byteLength('{"a":1}\n'));

    expect(result?.lines).toEqual(['{"b":2}']);
    expect(result?.consumedBytes).toBe(Buffer.byteLength('{"b":2}\n'));
  });

  it("takes the size from the handle when omitted and caps at an explicit size", async () => {
    const path = join(dir, "s.jsonl");
    await writeFile(path, '{"a":1}\n{"b":2}\n');

    expect((await collect(path))?.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect((await collect(path, 0, true, Buffer.byteLength('{"a":1}\n')))?.lines).toEqual([
      '{"a":1}',
    ]);
  });

  it("returns null for a missing file", async () => {
    expect(await collect(join(dir, "missing.jsonl"))).toBeNull();
  });
});

describe("readJsonlTailHash", () => {
  it("hashes the last PREFIX_VERIFY_BYTES before the offset", async () => {
    const body = "z".repeat(PREFIX_VERIFY_BYTES + 100);
    const path = join(dir, "h.jsonl");
    await writeFile(path, `${body}tail`);

    expect(await readJsonlTailHash(path, body.length)).toBe(
      hashHistoryTail(Buffer.from(body.slice(100))),
    );
    expect(await readJsonlTailHash(path, 10)).toBe(hashHistoryTail(Buffer.from(body.slice(0, 10))));
    expect(await readJsonlTailHash(join(dir, "missing"), 10)).toBeNull();
  });
});
