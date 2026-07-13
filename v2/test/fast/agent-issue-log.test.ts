import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_ISSUE_LOG_CONFIG,
  agentIssueLogPath,
  appendAgentIssue,
  readAgentIssueLog,
  setAgentIssueLogConfig,
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

beforeEach(() => {
  setAgentIssueLogConfig(DEFAULT_AGENT_ISSUE_LOG_CONFIG);
});

afterEach(async () => {
  setAgentIssueLogConfig(DEFAULT_AGENT_ISSUE_LOG_CONFIG);
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

    expect(readAgentIssueLog(dir).map((entry) => entry.text)).toEqual([
      "third",
      "second",
      "first",
    ]);
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
  it("rotates into a .1.gz archive, prunes deeper archives, and keeps the last record", async () => {
    const dir = await makeDir();
    setAgentIssueLogConfig({ hotBytes: 200, retainArchives: 2 });

    for (let i = 0; i < 40; i += 1) {
      appendAgentIssue(dir, record({ text: `entry-${i}` }));
    }

    const path = agentIssueLogPath(dir);
    expect(existsSync(`${path}.1.gz`)).toBe(true);
    expect(existsSync(`${path}.3.gz`)).toBe(false);

    const entries = readAgentIssueLog(dir);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(40);
    // Newest-first: the very last append survives in the live file at the top.
    expect(entries[0]?.text).toBe("entry-39");
  });
});
