import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendEventLog,
  readEventLog,
  readSessionEventLog,
  eventLogPath,
} from "../../src/event-log.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spur-event-log-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
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
    expect(new Date(ts!).getTime()).not.toBeNaN();
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
});
