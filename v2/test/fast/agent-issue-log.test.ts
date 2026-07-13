import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as jsonlLogIo from "../../src/jsonl-log-io.js";
import {
  agentIssueLogPath,
  appendAgentIssue,
  readAgentIssueLog,
  type AgentIssueRecord,
} from "../../src/agent-issue-log.js";

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spur-agent-issue-"));
  dirs.push(dir);
  return dir;
}

function record(overrides: Partial<AgentIssueRecord> = {}): AgentIssueRecord {
  return {
    ts: "2026-07-12T00:00:00.000Z",
    text: "sidecar won't start",
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("appendAgentIssue", () => {
  it("writes one parseable line with all fields", async () => {
    const dir = await makeDir();
    appendAgentIssue(dir, record({ sessionId: "demo-1", projectId: "sp" }));

    const raw = await readFile(agentIssueLogPath(dir), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(raw.trim())).toEqual({
      ts: "2026-07-12T00:00:00.000Z",
      text: "sidecar won't start",
      sessionId: "demo-1",
      projectId: "sp",
    });
  });

  it("omits sessionId and projectId when not provided", async () => {
    const dir = await makeDir();
    appendAgentIssue(dir, record());

    const parsed = JSON.parse((await readFile(agentIssueLogPath(dir), "utf8")).trim());
    expect("sessionId" in parsed).toBe(false);
    expect("projectId" in parsed).toBe(false);
  });

  it("writes no per-session shard", async () => {
    const dir = await makeDir();
    appendAgentIssue(dir, record({ sessionId: "demo-1" }));

    expect(existsSync(join(dir, "sessions"))).toBe(false);
  });
});

describe("readAgentIssueLog", () => {
  it("returns records newest-first", async () => {
    const dir = await makeDir();
    appendAgentIssue(dir, record({ text: "first" }));
    appendAgentIssue(dir, record({ text: "second" }));
    appendAgentIssue(dir, record({ text: "third" }));

    expect(readAgentIssueLog(dir).map((entry) => entry.text)).toEqual(["third", "second", "first"]);
  });

  it("caps to the newest N entries with --limit", async () => {
    const dir = await makeDir();
    appendAgentIssue(dir, record({ text: "first" }));
    appendAgentIssue(dir, record({ text: "second" }));
    appendAgentIssue(dir, record({ text: "third" }));

    expect(readAgentIssueLog(dir, { limit: 2 }).map((entry) => entry.text)).toEqual([
      "third",
      "second",
    ]);
  });

  it("filters by projectId", async () => {
    const dir = await makeDir();
    appendAgentIssue(dir, record({ text: "a", projectId: "sp" }));
    appendAgentIssue(dir, record({ text: "b", projectId: "other" }));

    expect(readAgentIssueLog(dir, { projectId: "sp" }).map((entry) => entry.text)).toEqual(["a"]);
  });

  it("filters by sessionId", async () => {
    const dir = await makeDir();
    appendAgentIssue(dir, record({ text: "a", sessionId: "demo-1" }));
    appendAgentIssue(dir, record({ text: "b", sessionId: "demo-2" }));

    expect(readAgentIssueLog(dir, { sessionId: "demo-2" }).map((entry) => entry.text)).toEqual([
      "b",
    ]);
  });
});

describe("rotation", () => {
  // tryRotate's own mechanics (gzip shift + prune) are covered by jsonl-log-io. This
  // module only owns the boundary: appendAgentIssue must hand the live path plus the
  // hardcoded 50 MiB / 5-archive policy to tryRotate on every write.
  it("invokes tryRotate with the live path and the hardcoded retention policy", async () => {
    const dir = await makeDir();
    const spy = vi.spyOn(jsonlLogIo, "tryRotate");

    appendAgentIssue(dir, record());

    expect(spy).toHaveBeenCalledWith(agentIssueLogPath(dir), 50 * 1024 * 1024, 5);
  });
});
