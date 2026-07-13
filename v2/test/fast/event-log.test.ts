import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendEventLog,
  readEventLog,
  readSessionEventLog,
  eventLogPath,
  sessionEventLogPath,
  setEventLogConfig,
  DEFAULT_EVENT_LOG_HOT_BYTES,
  DEFAULT_EVENT_LOG_SHARD_HOT_BYTES,
  DEFAULT_EVENT_LOG_RETAIN_ARCHIVES,
  buildUserInputLogEntry,
} from "../../src/event-log.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spur-event-log-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  setEventLogConfig({
    hotBytes: DEFAULT_EVENT_LOG_HOT_BYTES,
    shardHotBytes: DEFAULT_EVENT_LOG_SHARD_HOT_BYTES,
    retainArchives: DEFAULT_EVENT_LOG_RETAIN_ARCHIVES,
  });
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("appendEventLog", () => {
  it("creates the data directory and writes JSONL", () => {
    const dataDir = join(makeTempDir(), "nested", "data");
    appendEventLog(dataDir, {
      event: "session.spawn",
      level: "info",
      sessionId: "api-1",
    });
    const entries = readEventLog(dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toBe("session.spawn");
    expect(entries[0]?.sessionId).toBe("api-1");
  });

  it("auto-fills timestamp when omitted", () => {
    const dataDir = makeTempDir();
    appendEventLog(dataDir, { event: "test", level: "info" });
    const entries = readEventLog(dataDir);
    const ts = entries[0]?.timestamp;
    expect(ts).toBeTruthy();
    if (!ts) {
      throw new Error("expected timestamp to be present");
    }
    expect(new Date(ts).getTime()).not.toBeNaN();
  });

  it("preserves an explicit timestamp", () => {
    const dataDir = makeTempDir();
    appendEventLog(dataDir, {
      event: "test",
      level: "info",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const entries = readEventLog(dataDir);
    expect(entries[0]?.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("buildUserInputLogEntry", () => {
  it("trims text, preserves attachment names, and keeps caller metadata", () => {
    expect(
      buildUserInputLogEntry({
        sessionId: "api-1",
        projectId: "api",
        sourceId: "pr-watch",
        triggerId: "send",
        kind: "trigger_send_prompt",
        source: "trigger",
        text: "  fix it  ",
        attachments: [{ id: "shot.png", name: "shot.png" }],
        details: { eventName: "github:comment" },
      }),
    ).toEqual({
      event: "session.input.received",
      level: "info",
      sessionId: "api-1",
      projectId: "api",
      sourceId: "pr-watch",
      triggerId: "send",
      message: "fix it",
      details: {
        eventName: "github:comment",
        inputKind: "trigger_send_prompt",
        source: "trigger",
        text: "fix it",
        attachments: [{ id: "shot.png", name: "shot.png" }],
      },
    });
  });

  it("skips empty input without attachments", () => {
    expect(
      buildUserInputLogEntry({
        sessionId: "api-1",
        projectId: "api",
        kind: "send_message",
        source: "send",
        text: "   ",
      }),
    ).toBeNull();
  });
});

describe("readEventLog", () => {
  it("returns empty array for nonexistent file", () => {
    const dataDir = join(makeTempDir(), "missing");
    expect(readEventLog(dataDir)).toEqual([]);
  });

  it("parses valid JSONL", () => {
    const dataDir = makeTempDir();
    appendEventLog(dataDir, { event: "a", level: "info" });
    appendEventLog(dataDir, { event: "b", level: "warn" });
    const entries = readEventLog(dataDir);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.event).toBe("a");
    expect(entries[1]?.event).toBe("b");
  });

  it("skips malformed lines", () => {
    const dataDir = makeTempDir();
    appendEventLog(dataDir, { event: "good", level: "info" });
    const logFile = eventLogPath(dataDir);
    writeFileSync(logFile, '{"event":"good","level":"info","timestamp":"t"}\nnot json\n');
    const entries = readEventLog(dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toBe("good");
  });
});

describe("readSessionEventLog", () => {
  it("filters entries by sessionId", () => {
    const dataDir = makeTempDir();
    appendEventLog(dataDir, { event: "a", level: "info", sessionId: "api-1" });
    appendEventLog(dataDir, { event: "b", level: "info", sessionId: "api-2" });
    appendEventLog(dataDir, { event: "c", level: "info", sessionId: "api-1" });
    const entries = readSessionEventLog(dataDir, "api-1");
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.sessionId === "api-1")).toBe(true);
  });

  it("respects the limit parameter", () => {
    const dataDir = makeTempDir();
    for (let i = 0; i < 5; i += 1) {
      appendEventLog(dataDir, {
        event: `e${i}`,
        level: "info",
        sessionId: "api-1",
      });
    }
    const entries = readSessionEventLog(dataDir, "api-1", 2);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.event).toBe("e3");
    expect(entries[1]?.event).toBe("e4");
  });

  it("filters runtime entries by scope and name", () => {
    const dataDir = makeTempDir();
    appendEventLog(dataDir, {
      event: "session.spawn.completed",
      level: "info",
      sessionId: "api-1",
    });
    appendEventLog(dataDir, {
      event: "service.output",
      level: "info",
      sessionId: "api-1",
      message: "SERVICE_BOOT",
      details: { serviceId: "web" },
    });
    appendEventLog(dataDir, {
      event: "sidecar.output",
      level: "info",
      sessionId: "api-1",
      message: "BROWSER_READY",
      details: { sidecarName: "isolated-ui" },
    });

    expect(readSessionEventLog(dataDir, "api-1", { scope: "runtime" })).toHaveLength(2);
    expect(readSessionEventLog(dataDir, "api-1", { scope: "service" })).toEqual([
      expect.objectContaining({ event: "service.output", message: "SERVICE_BOOT" }),
    ]);
    expect(
      readSessionEventLog(dataDir, "api-1", { scope: "sidecar", name: "isolated-ui" }),
    ).toEqual([expect.objectContaining({ event: "sidecar.output", message: "BROWSER_READY" })]);
  });

  it("tolerates logs larger than the single-string limit via chunked reads", () => {
    const dataDir = makeTempDir();
    const logFile = eventLogPath(dataDir);
    const filler = "x".repeat(900);
    const lines: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      lines.push(
        JSON.stringify({
          timestamp: "2026-01-01T00:00:00.000Z",
          event: "sidecar.output",
          level: "info",
          sessionId: i % 2 === 0 ? "api-1" : "api-2",
          message: `${filler}-${i}`,
          details: { sidecarName: "isolated-ui" },
        }),
      );
    }
    writeFileSync(logFile, "");
    appendFileSync(logFile, `${lines.join("\n")}\n`);

    const entries = readSessionEventLog(dataDir, "api-1", 3);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.message).toBe(`${filler}-4994`);
    expect(entries[2]?.message).toBe(`${filler}-4998`);
  });
});

describe("rotation", () => {
  it("rotates the active log when it exceeds the configured threshold", () => {
    // ~120-byte lines; threshold 200 bytes forces rotation after a couple of writes.
    setEventLogConfig({ hotBytes: 200, shardHotBytes: 200, retainArchives: 5 });
    const dataDir = makeTempDir();
    for (let i = 0; i < 6; i += 1) {
      appendEventLog(dataDir, { event: `e${i}`, level: "info" });
    }
    const live = eventLogPath(dataDir);
    expect(existsSync(`${live}.1.gz`)).toBe(true);
    // Live file (if present) stayed under the threshold after the most recent rotation.
    const liveSize = existsSync(live) ? readFileSync(live).length : 0;
    expect(liveSize).toBeLessThanOrEqual(200);
    // All written events are still readable across archive + live.
    expect(readEventLog(dataDir)).toHaveLength(6);
  });

  it("gzips archives and prunes beyond retainArchives", () => {
    setEventLogConfig({ hotBytes: 1, shardHotBytes: 1, retainArchives: 2 });
    const dataDir = makeTempDir();
    for (let i = 0; i < 8; i += 1) {
      appendEventLog(dataDir, { event: `e${i}`, level: "info" });
    }
    const live = eventLogPath(dataDir);
    expect(existsSync(`${live}.1.gz`)).toBe(true);
    expect(existsSync(`${live}.2.gz`)).toBe(true);
    // retainArchives=2 keeps only .1.gz and .2.gz.
    expect(existsSync(`${live}.3.gz`)).toBe(false);
    // Archive content is valid gzip.
    expect(() => gunzipSync(readFileSync(`${live}.1.gz`))).not.toThrow();
  });
});

describe("readSessionEventLog across shards", () => {
  it("returns entries across archived and live shards", () => {
    setEventLogConfig({ hotBytes: 1, shardHotBytes: 1, retainArchives: 5 });
    const dataDir = makeTempDir();
    for (let i = 0; i < 4; i += 1) {
      appendEventLog(dataDir, { event: `e${i}`, level: "info", sessionId: "api-1" });
    }
    const entries = readSessionEventLog(dataDir, "api-1");
    expect(entries.map((e) => e.event)).toEqual(["e0", "e1", "e2", "e3"]);
  });

  it("applies limit, scope, and name filters across shards", () => {
    setEventLogConfig({ hotBytes: 1, shardHotBytes: 1, retainArchives: 5 });
    const dataDir = makeTempDir();
    appendEventLog(dataDir, { event: "session.spawn", level: "info", sessionId: "api-1" });
    appendEventLog(dataDir, {
      event: "service.output",
      level: "info",
      sessionId: "api-1",
      message: "BOOT",
      details: { serviceId: "web" },
    });
    appendEventLog(dataDir, {
      event: "sidecar.output",
      level: "info",
      sessionId: "api-1",
      message: "READY",
      details: { sidecarName: "isolated-ui" },
    });
    appendEventLog(dataDir, {
      event: "sidecar.output",
      level: "info",
      sessionId: "api-1",
      message: "OTHER",
      details: { sidecarName: "other" },
    });

    expect(readSessionEventLog(dataDir, "api-1", { scope: "runtime" })).toHaveLength(3);
    expect(readSessionEventLog(dataDir, "api-1", { scope: "service" })).toEqual([
      expect.objectContaining({ event: "service.output", message: "BOOT" }),
    ]);
    expect(
      readSessionEventLog(dataDir, "api-1", { scope: "sidecar", name: "isolated-ui" }),
    ).toEqual([expect.objectContaining({ event: "sidecar.output", message: "READY" })]);
    // limit keeps the most recent N across archives.
    const limited = readSessionEventLog(dataDir, "api-1", 2);
    expect(limited).toHaveLength(2);
    expect(limited[1]?.message).toBe("OTHER");
  });

  it("falls back to global scan when shard dir absent", () => {
    const dataDir = makeTempDir();
    // Write the global log directly without producing a shard dir.
    const line = (event: string): string =>
      `${JSON.stringify({ timestamp: "t", event, level: "info", sessionId: "api-1" })}\n`;
    writeFileSync(eventLogPath(dataDir), `${line("a")}${line("b")}`);
    expect(existsSync(join(dataDir, "sessions", "api-1"))).toBe(false);
    const entries = readSessionEventLog(dataDir, "api-1");
    expect(entries.map((e) => e.event)).toEqual(["a", "b"]);
  });
});

describe("readEventLog across archives", () => {
  it("spans global live and gzipped archives", () => {
    setEventLogConfig({ hotBytes: 1, shardHotBytes: 1, retainArchives: 5 });
    const dataDir = makeTempDir();
    for (let i = 0; i < 5; i += 1) {
      appendEventLog(dataDir, { event: `e${i}`, level: "info" });
    }
    expect(existsSync(`${eventLogPath(dataDir)}.1.gz`)).toBe(true);
    const entries = readEventLog(dataDir);
    expect(entries.map((e) => e.event)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
  });
});

describe("gzip reads", () => {
  it("gunzip read returns byte-identical lines", () => {
    setEventLogConfig({ hotBytes: 1, shardHotBytes: 1, retainArchives: 5 });
    const dataDir = makeTempDir();
    const payloads = ["alpha", "βγδ unicode", "x".repeat(500)];
    for (const message of payloads) {
      appendEventLog(dataDir, { event: "service.output", level: "info", message });
    }
    const messages = readEventLog(dataDir).map((e) => e.message);
    expect(messages).toEqual(payloads);
  });

  it("decompression stays memory bounded for large archives", () => {
    // Moderate threshold so each archive holds many lines (input >> 64KiB across
    // archives) while retainArchives keeps every shard for an ordered full read.
    setEventLogConfig({ hotBytes: 50_000, shardHotBytes: 50_000, retainArchives: 500 });
    const dataDir = makeTempDir();
    const total = 10_000;
    for (let i = 0; i < total; i += 1) {
      appendEventLog(dataDir, { event: "service.output", level: "info", message: `m-${i}` });
    }
    const entries = readEventLog(dataDir);
    expect(entries).toHaveLength(total);
    expect(entries[0]?.message).toBe("m-0");
    expect(entries[total - 1]?.message).toBe(`m-${total - 1}`);
  });
});

describe("dual-write", () => {
  it("appendEventLog dual-writes global and shard for entries with sessionId", () => {
    const dataDir = makeTempDir();
    appendEventLog(dataDir, { event: "a", level: "info", sessionId: "api-1" });
    expect(existsSync(eventLogPath(dataDir))).toBe(true);
    expect(existsSync(sessionEventLogPath(dataDir, "api-1"))).toBe(true);
    expect(readEventLog(dataDir).map((e) => e.event)).toEqual(["a"]);
    expect(readSessionEventLog(dataDir, "api-1").map((e) => e.event)).toEqual(["a"]);
  });

  it("appendEventLog writes only global for entries without sessionId", () => {
    const dataDir = makeTempDir();
    appendEventLog(dataDir, { event: "a", level: "info" });
    expect(existsSync(eventLogPath(dataDir))).toBe(true);
    expect(existsSync(join(dataDir, "sessions"))).toBe(false);
  });
});
