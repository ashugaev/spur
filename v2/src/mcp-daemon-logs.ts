import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { eventLogPath } from "./event-log.js";
import { redactAutoPingHandles } from "./auto-ping.js";

const cursorSchema = z
  .object({
    ino: z.number(),
    dev: z.number(),
    birth: z.number(),
    size: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    discarding: z.boolean(),
    prefixLength: z.number().int().min(0).max(64),
    prefixHash: z.string(),
    source: z.enum(["events", "runtime"]),
  })
  .strict();

/** Reads the fixed daemon journal, never a caller-selected file or session shard. */
export function readDaemonLogs(
  dataDir: string,
  input: {
    cursor?: string | undefined;
    limit?: number | undefined;
    maxBytes?: number | undefined;
    source?: "events" | "runtime" | undefined;
  },
) {
  const limit = input.limit ?? 50;
  const maxBytes = input.maxBytes ?? 16384;
  const selection = input.source ?? "events";
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > 16384
  )
    throw new Error("Invalid daemon log bounds");
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (input.cursor) {
    if (input.cursor.length > 1024) throw new Error("Invalid daemon log cursor");
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
      );
      if (cursor.source !== selection) throw new Error("Log cursor source mismatch");
    } catch {
      throw new Error("Invalid daemon log cursor");
    }
  }
  let fd: number | undefined;
  const source = selection === "runtime" ? "daemon-runtime-diagnostics" : "daemon-event-journal";
  try {
    fd = openSync(
      eventLogPath(dataDir),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Daemon journal is not a regular file");
    const prefixLength = Math.min(64, stat.size);
    const prefix = Buffer.alloc(prefixLength);
    readSync(fd, prefix, 0, prefixLength, 0);
    const prefixHash = createHash("sha256").update(prefix).digest("hex");
    const previousPrefixHash = cursor
      ? createHash("sha256").update(prefix.subarray(0, cursor.prefixLength)).digest("hex")
      : undefined;
    if (
      cursor &&
      (cursor.ino !== stat.ino ||
        cursor.dev !== stat.dev ||
        cursor.birth !== stat.birthtimeMs ||
        stat.size < cursor.size ||
        cursor.prefixHash !== previousPrefixHash)
    ) {
      return {
        source,
        status: "rotated",
        entries: [],
        nextCursor: null,
        message:
          "Journal rotated or was truncated; omit cursor to read current journal. Archives are not followed",
      };
    }
    let offset = cursor?.offset ?? 0;
    if (offset > stat.size) throw new Error("Daemon log cursor exceeds journal");
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size - offset));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, offset);
    let position = 0;
    let discarding = cursor?.discarding ?? false;
    let truncatedRecords = 0;
    let invalidRecords = 0;
    const entries: Record<string, unknown>[] = [];
    while (position < bytesRead && entries.length < limit) {
      const newline = buffer.indexOf(10, position);
      if (newline < 0) {
        // Re-read an ordinary line from its start on the next bounded page.
        if (!discarding && position > 0) break;
        // A partial final line can still be in flight. Re-read it after append.
        if (offset + bytesRead === stat.size && !discarding && bytesRead < maxBytes) break;
        if (!discarding) truncatedRecords++;
        discarding = true;
        position = bytesRead;
        break;
      }
      const line = buffer.subarray(position, newline).toString("utf8");
      position = newline + 1;
      if (discarding) {
        discarding = false;
        continue;
      }
      try {
        const value: unknown = JSON.parse(redactAutoPingHandles(line));
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          invalidRecords++;
          continue;
        }
        const record = value as Record<string, unknown>;
        if (typeof record.event !== "string") {
          invalidRecords++;
          continue;
        }
        if (
          record.sessionId !== undefined ||
          !(record.event.startsWith("daemon.") || record.event.startsWith("http."))
        )
          continue;
        if (selection === "runtime" && record.event !== "daemon.diagnostic") continue;
        entries.push(record);
      } catch {
        invalidRecords++;
      }
    }
    offset += position;
    const nextCursor = Buffer.from(
      JSON.stringify({
        ino: stat.ino,
        dev: stat.dev,
        birth: stat.birthtimeMs,
        size: stat.size,
        offset,
        discarding,
        prefixLength,
        prefixHash,
        source: selection,
      }),
    ).toString("base64url");
    return {
      source,
      status: "available",
      entries,
      nextCursor,
      eof: offset === stat.size,
      bytesScanned: bytesRead,
      truncatedRecords,
      invalidRecords,
      archivesIncluded: false,
      diagnosticCapture:
        "Daemon logger callbacks and server warnings; raw stdout/stderr before server startup and external journals are unavailable",
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT")
      return {
        source,
        status: "unavailable",
        entries: [],
        nextCursor: null,
        reason: "journal_missing",
      };
    if (code === "EACCES" || code === "EPERM" || code === "ELOOP")
      return {
        source,
        status: "unavailable",
        entries: [],
        nextCursor: null,
        reason: "journal_inaccessible",
      };
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
