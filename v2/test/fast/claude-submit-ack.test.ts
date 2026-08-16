import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findLatestSessionFileMock, sessionFileForIdMock, sessionFilePathForIdMock } = vi.hoisted(
  () => ({
    findLatestSessionFileMock: vi.fn<(worktreePath: string) => Promise<string | null>>(),
    sessionFileForIdMock: vi.fn<(worktreePath: string, id: string) => Promise<string | null>>(),
    sessionFilePathForIdMock: vi.fn<(worktreePath: string, id: string) => string>(),
  }),
);

vi.mock("../../src/agents/claude.js", () => ({
  findLatestSessionFile: findLatestSessionFileMock,
  sessionFileForId: sessionFileForIdMock,
  sessionFilePathForId: sessionFilePathForIdMock,
}));

import {
  captureClaudeSubmitBaseline,
  scanClaudeJsonlForMessage,
} from "../../src/agents/claude-submit-ack.js";

const tempDirs: string[] = [];

beforeEach(() => {
  findLatestSessionFileMock.mockReset();
  sessionFileForIdMock.mockReset().mockResolvedValue(null);
  sessionFilePathForIdMock
    .mockReset()
    .mockImplementation((worktreePath, id) => join(worktreePath, `${id}.jsonl`));
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeJsonl(filename: string, lines: Array<Record<string, unknown>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "claude-submit-ack-"));
  tempDirs.push(root);
  const filePath = join(root, filename);
  const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(filePath, body, { encoding: "utf8", flag: "w" });
  return filePath;
}

async function appendJsonl(filePath: string, lines: Array<Record<string, unknown>>): Promise<void> {
  const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(filePath, body, { encoding: "utf8", flag: "a" });
}

describe("captureClaudeSubmitBaseline", () => {
  it("returns null when no JSONL file exists", async () => {
    findLatestSessionFileMock.mockResolvedValue(null);
    const result = await captureClaudeSubmitBaseline("/tmp/whatever");
    expect(result).toBeNull();
  });

  it("returns the file path and current size when a JSONL exists", async () => {
    const filePath = await makeJsonl("a.jsonl", [
      { type: "user", message: { role: "user", content: "hi" } },
    ]);
    findLatestSessionFileMock.mockResolvedValue(filePath);
    const result = await captureClaudeSubmitBaseline("/tmp/worktree");
    expect(result?.file).toBe(filePath);
    expect(result?.size).toBeGreaterThan(0);
  });

  it("returns null when stat fails (file missing)", async () => {
    findLatestSessionFileMock.mockResolvedValue("/no/such/file.jsonl");
    const result = await captureClaudeSubmitBaseline("/tmp/worktree");
    expect(result).toBeNull();
  });

  it("returns null for a pinned id without a transcript when the launch is not fresh", async () => {
    const result = await captureClaudeSubmitBaseline("/tmp/worktree", "pinned-id");
    expect(result).toBeNull();
    expect(sessionFilePathForIdMock).not.toHaveBeenCalled();
  });

  it("builds a zero-size baseline at the pinned id path on a fresh launch", async () => {
    // A freshly launched claude creates `<uuid>.jsonl` only when it persists the
    // first submitted message, so the launch send must arm against the path the
    // pinned id will create instead of skipping the ack.
    const result = await captureClaudeSubmitBaseline("/tmp/worktree", "pinned-id", {
      freshLaunch: true,
    });
    expect(result).toEqual({ file: "/tmp/worktree/pinned-id.jsonl", size: 0 });
  });

  it("prefers an existing transcript over the constructed path on a fresh launch", async () => {
    const filePath = await makeJsonl("existing.jsonl", [
      { type: "user", message: { role: "user", content: "hi" } },
    ]);
    sessionFileForIdMock.mockResolvedValue(filePath);
    const result = await captureClaudeSubmitBaseline("/tmp/worktree", "pinned-id", {
      freshLaunch: true,
    });
    expect(result?.file).toBe(filePath);
    expect(result?.size).toBeGreaterThan(0);
  });
});

describe("scanClaudeJsonlForMessage", () => {
  it("matches user message with content as string", async () => {
    const filePath = await makeJsonl("string-content.jsonl", []);
    findLatestSessionFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      { type: "user", message: { role: "user", content: "hello world" } },
    ]);
    const found = await scanClaudeJsonlForMessage(
      { file: filePath, size: 0 },
      "hello world",
      "/tmp/worktree",
    );
    expect(found).toBe(true);
  });

  it("matches user message with content as text-block array", async () => {
    const filePath = await makeJsonl("array-content.jsonl", []);
    findLatestSessionFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "ship the task" }],
        },
      },
    ]);
    const found = await scanClaudeJsonlForMessage(
      { file: filePath, size: 0 },
      "ship the task",
      "/tmp/worktree",
    );
    expect(found).toBe(true);
  });

  it("ignores tool_result blocks even when their inner text matches", async () => {
    const filePath = await makeJsonl("tool-result.jsonl", []);
    findLatestSessionFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: [{ type: "text", text: "ship the task" }],
            },
          ],
        },
      },
    ]);
    const found = await scanClaudeJsonlForMessage(
      { file: filePath, size: 0 },
      "ship the task",
      "/tmp/worktree",
    );
    expect(found).toBe(false);
  });

  it("returns false when no matching user message exists", async () => {
    const filePath = await makeJsonl("mismatch.jsonl", [
      { type: "user", message: { role: "user", content: "different" } },
    ]);
    findLatestSessionFileMock.mockResolvedValue(filePath);
    const found = await scanClaudeJsonlForMessage(
      { file: filePath, size: 0 },
      "expected",
      "/tmp/worktree",
    );
    expect(found).toBe(false);
  });

  it("ignores prior identical messages before the byte-offset baseline", async () => {
    const filePath = await makeJsonl("offset.jsonl", [
      { type: "user", message: { role: "user", content: "hi there" } },
    ]);
    findLatestSessionFileMock.mockResolvedValue(filePath);
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(filePath);
    const baseline = { file: filePath, size: stat.size };

    const found = await scanClaudeJsonlForMessage(baseline, "hi there", "/tmp/worktree");
    expect(found).toBe(false);
  });

  it("finds a new identical message appended after the baseline", async () => {
    const filePath = await makeJsonl("append.jsonl", [
      { type: "user", message: { role: "user", content: "hi there" } },
    ]);
    findLatestSessionFileMock.mockResolvedValue(filePath);
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(filePath);
    const baseline = { file: filePath, size: stat.size };

    await appendJsonl(filePath, [{ type: "user", message: { role: "user", content: "hi there" } }]);

    const found = await scanClaudeJsonlForMessage(baseline, "hi there", "/tmp/worktree");
    expect(found).toBe(true);
  });

  it("scans a freshly rotated JSONL file from offset 0 when latest differs", async () => {
    const baselineFile = await makeJsonl("baseline.jsonl", [
      { type: "user", message: { role: "user", content: "old" } },
    ]);
    const fs = await import("node:fs/promises");
    const baselineStat = await fs.stat(baselineFile);
    const baseline = { file: baselineFile, size: baselineStat.size };

    const rotatedFile = await makeJsonl("rotated.jsonl", [
      { type: "user", message: { role: "user", content: "new" } },
    ]);
    findLatestSessionFileMock.mockResolvedValue(rotatedFile);

    const found = await scanClaudeJsonlForMessage(baseline, "new", "/tmp/worktree");
    expect(found).toBe(true);
  });

  it("resolves the pinned id when the constructed baseline file never appears", async () => {
    const realFile = await makeJsonl("pinned.jsonl", [
      { type: "user", message: { role: "user", content: "step one" } },
    ]);
    sessionFileForIdMock.mockResolvedValue(realFile);

    const found = await scanClaudeJsonlForMessage(
      { file: "/no/such/dir/pinned-id.jsonl", size: 0 },
      "step one",
      "/tmp/worktree",
      "pinned-id",
    );
    expect(found).toBe(true);
  });

  it("trims whitespace before comparing", async () => {
    const filePath = await makeJsonl("trim.jsonl", [
      { type: "user", message: { role: "user", content: "trim me" } },
    ]);
    findLatestSessionFileMock.mockResolvedValue(filePath);
    const found = await scanClaudeJsonlForMessage(
      { file: filePath, size: 0 },
      "  trim me  ",
      "/tmp/worktree",
    );
    expect(found).toBe(true);
  });

  it("ignores a leading Ctrl-U recorded by Claude after tmux line clearing", async () => {
    const filePath = await makeJsonl("ctrl-u.jsonl", []);
    findLatestSessionFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      { type: "user", message: { role: "user", content: "\u0015restored prompt" } },
    ]);
    const found = await scanClaudeJsonlForMessage(
      { file: filePath, size: 0 },
      "restored prompt",
      "/tmp/worktree",
    );
    expect(found).toBe(true);
  });

  it("matches when JSONL stores \\r separators and target uses \\n", async () => {
    const filePath = await makeJsonl("cr-separators.jsonl", []);
    findLatestSessionFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      { type: "user", message: { role: "user", content: "line one\rline two\rline three" } },
    ]);
    const found = await scanClaudeJsonlForMessage(
      { file: filePath, size: 0 },
      "line one\nline two\nline three",
      "/tmp/worktree",
    );
    expect(found).toBe(true);
  });

  it("matches when JSONL stores \\r\\n separators and target uses \\n", async () => {
    const filePath = await makeJsonl("crlf-separators.jsonl", []);
    findLatestSessionFileMock.mockResolvedValue(filePath);
    await appendJsonl(filePath, [
      { type: "user", message: { role: "user", content: "first\r\nsecond" } },
    ]);
    const found = await scanClaudeJsonlForMessage(
      { file: filePath, size: 0 },
      "first\nsecond",
      "/tmp/worktree",
    );
    expect(found).toBe(true);
  });
});
