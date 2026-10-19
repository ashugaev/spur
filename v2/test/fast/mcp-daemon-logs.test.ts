import { appendFileSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTempDir } from "../helpers/common.js";
import { readDaemonLogs } from "../../src/mcp-daemon-logs.js";

const line = (n: number) => JSON.stringify({ event: "daemon.test", message: `${n}` }) + "\n";
it("bounds pages, excludes session/service logs and reaches every daemon event", async () => {
  const data = await createTempDir("mcp-logs-");
  writeFileSync(
    join(data, "events.jsonl"),
    line(1) +
      JSON.stringify({ event: "daemon.test", sessionId: "other", message: "private-session" }) +
      "\n" +
      line(2) +
      line(3),
  );
  const first = readDaemonLogs(data, { limit: 1 });
  expect(first).toMatchObject({ status: "available", entries: [{ message: "1" }], eof: false });
  const second = readDaemonLogs(data, { cursor: first.nextCursor!, limit: 1 });
  expect(second).toMatchObject({ entries: [{ message: "2" }] });
  const third = readDaemonLogs(data, { cursor: second.nextCursor! });
  expect(third).toMatchObject({ entries: [{ message: "3" }], eof: true, archivesIncluded: false });
  expect(JSON.stringify([first, second, third])).not.toContain("private-session");
});
it("bounds giant records and malformed records without losing following entries", async () => {
  const data = await createTempDir("mcp-huge-logs-");
  writeFileSync(
    join(data, "events.jsonl"),
    JSON.stringify({ event: "daemon.test", message: "x".repeat(100000) }) + "\ninvalid\n" + line(2),
  );
  let cursor: string | undefined;
  let truncated = 0;
  let found = false;
  for (let page = 0; page < 10; page++) {
    const result = readDaemonLogs(data, { cursor });
    expect(result.bytesScanned).toBeLessThanOrEqual(16384);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32768);
    truncated += result.truncatedRecords ?? 0;
    found ||= result.entries.some((entry) => entry.message === "2");
    cursor = result.nextCursor ?? undefined;
    if (result.eof) break;
  }
  expect(found).toBe(true);
  expect(truncated).toBe(1);
});
it("detects rotation and truncate/regrow, reports unavailable and rejects caller paths", async () => {
  const data = await createTempDir("mcp-rotated-logs-");
  const file = join(data, "events.jsonl");
  expect(readDaemonLogs(data, {})).toMatchObject({
    status: "unavailable",
    reason: "journal_missing",
  });
  writeFileSync(file, line(1));
  const first = readDaemonLogs(data, {});
  renameSync(file, `${file}.1`);
  writeFileSync(file, line(2));
  expect(readDaemonLogs(data, { cursor: first.nextCursor! })).toMatchObject({
    status: "rotated",
    nextCursor: null,
  });
  const second = readDaemonLogs(data, {});
  writeFileSync(file, line(3) + line(4));
  expect(readDaemonLogs(data, { cursor: second.nextCursor! }).status).toBe("rotated");
  expect(() => readDaemonLogs(data, { cursor: "../../private" })).toThrow("cursor");
  const other = join(data, "other");
  mkdirSync(other);
  symlinkSync(file, join(other, "events.jsonl"));
  expect(readDaemonLogs(other, {})).toMatchObject({
    status: "unavailable",
    reason: "journal_inaccessible",
  });
});
it("retries an incomplete final line after append", async () => {
  const data = await createTempDir("mcp-partial-log-");
  const file = join(data, "events.jsonl");
  writeFileSync(file, line(1).slice(0, -1));
  const first = readDaemonLogs(data, {});
  expect(first.entries).toEqual([]);
  appendFileSync(file, "\n");
  expect(readDaemonLogs(data, { cursor: first.nextCursor! }).entries).toMatchObject([
    { message: "1" },
  ]);
});

it("retains existing auto-ping handle redaction", async () => {
  const data = await createTempDir("mcp-redacted-log-");
  const handle = `ap1_${"a".repeat(43)}`;
  writeFileSync(
    join(data, "events.jsonl"),
    JSON.stringify({ event: "daemon.test", message: handle }) + "\n",
  );
  const result = readDaemonLogs(data, {});
  expect(result.entries).toMatchObject([{ message: "[auto-ping-handle]" }]);
  expect(JSON.stringify(result)).not.toContain(handle);
});
