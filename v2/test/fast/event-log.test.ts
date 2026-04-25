import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
