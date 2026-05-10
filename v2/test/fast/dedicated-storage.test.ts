import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  appendDedicatedAttachmentInput,
  appendDedicatedTextInput,
  dedicatedStorageDir,
  ensureDedicatedStorageDir,
} from "../../src/dedicated-storage.js";

const DATA_DIR = resolve(`/tmp/spur-dedicated-storage-test-${process.pid}`);

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSONL record: ${message}`, { cause: error });
  }
}

function readRecords(sessionId: string): unknown[] {
  const file = join(dedicatedStorageDir(DATA_DIR, sessionId), "inputs.jsonl");
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(parseJsonLine);
}

describe("dedicated storage", () => {
  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("creates the session storage directory", () => {
    const dir = ensureDedicatedStorageDir(DATA_DIR, "api-1");

    expect(dir).toBe(join(DATA_DIR, "dedicated-storage", "api-1"));
    expect(existsSync(join(dir, "attachments"))).toBe(true);
  });

  it("appends text input records to JSONL", () => {
    appendDedicatedTextInput(DATA_DIR, "api-1", {
      kind: "spawn_prompt",
      text: "  ship it  ",
      metadata: { source: "spawn" },
    });

    expect(readRecords("api-1")).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        type: "text",
        kind: "spawn_prompt",
        text: "ship it",
        metadata: { source: "spawn" },
      }),
    ]);
  });

  it("copies attachment bytes and records metadata", () => {
    const sourceDir = join(DATA_DIR, "source");
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "shot.png");
    writeFileSync(sourcePath, "png-bytes");

    appendDedicatedAttachmentInput(DATA_DIR, "api-1", {
      kind: "send_attachment",
      sourcePath,
      name: "shot.png",
      metadata: { source: "send" },
    });

    const record = readRecords("api-1")[0];
    expect(record).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        type: "attachment",
        kind: "send_attachment",
        name: "shot.png",
        size: "png-bytes".length,
        sha256: createHash("sha256").update("png-bytes").digest("hex"),
        metadata: { source: "send" },
      }),
    );
    const relativePath =
      typeof record === "object" && record !== null && "relativePath" in record
        ? record.relativePath
        : null;
    expect(typeof relativePath).toBe("string");
    expect(
      readFileSync(join(dedicatedStorageDir(DATA_DIR, "api-1"), String(relativePath)), "utf8"),
    ).toBe("png-bytes");
  });
});
