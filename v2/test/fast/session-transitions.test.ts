import {
  appendFileSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTransitions, parseSessionTransitionsQuery } from "../../src/session-transitions.js";
import type { SessionRecord } from "../../src/types.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "spur-transitions-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const session = (status: SessionRecord["status"] = "running"): SessionRecord => ({
  id: "s-1",
  project: "p",
  agent: "codex",
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "task",
  tmuxSession: "test",
  worktreePath: "/tmp/test",
  branch: "feature/test",
  launchCommand: "test",
  worktree: false,
});
const task = { label: "task", url: "https://example.com/task" };
const role = { label: "role", url: "https://example.com/reviewer" };

describe("retained session transitions", () => {
  it("keeps empty cursors and strict-after ordering across restart without duplicates", () => {
    const dir = temp();
    let store = new SessionTransitions(dir);
    const empty = store.query();
    expect(empty.entries).toEqual([]);
    expect(store.query().nextCursor).toBe(empty.nextCursor);
    store.observeStatus(session(), [task]);
    store.observeState(session(), "working", [task]);
    const first = store.query({ since: empty.nextCursor, limit: 1, kinds: ["status", "state"] });
    expect(first.hasMore).toBe(true);
    store = new SessionTransitions(dir);
    store.observeStatus(session(), [task]);
    store.observeState(session(), "working", [task]);
    const later = store.query({ since: first.nextCursor, kinds: ["status", "state"] });
    expect(later.entries).toHaveLength(1);
    expect(later.entries[0]?.kind).toBe("state");
    expect(store.query({ since: later.nextCursor }).entries).toEqual([]);
  });

  it("filters immutable AND links, advances sparse cursors and never skips next match", () => {
    const store = new SessionTransitions(temp());
    store.observeStatus(session(), [task, role]);
    store.observeState(session(), "working", [task]);
    store.observeState(session(), "rate_limited", [task, role]);
    const query = { links: [task, role], limit: 1 };
    const first = store.query(query);
    expect(first.hasMore).toBe(true);
    const second = store.query({ ...query, since: first.nextCursor });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.to).toBe("rate_limited");
    expect(second.hasMore).toBe(false);
    const none = store.query({ links: [{ label: "absent" }] });
    expect(none.entries).toEqual([]);
    expect(none.nextCursor).toBe(second.nextCursor);
  });

  it("retains reset refinements and rapid relapse, excludes only working/waiting flaps by default", () => {
    const store = new SessionTransitions(temp());
    const limited = {
      ...session(),
      rateLimitedAt: "2026-01-01T00:00:00.000Z",
      rateLimitResetAt: "2027-01-01T01:00:00.000Z",
    };
    store.observeState(limited, "rate_limited", [task]);
    store.observeState(limited, "rate_limited", [task]);
    store.observeState(session(), "working", [task]);
    store.observeState(
      { ...limited, rateLimitResetAt: "2027-01-01T02:00:00.000Z" },
      "rate_limited",
      [task],
    );
    store.observeState(session(), "working", [task]);
    store.observeState(session(), "waiting", [task]);
    expect(store.query().entries.map((entry) => entry.to)).toEqual([
      "rate_limited",
      "working",
      "rate_limited",
      "working",
    ]);
    expect(store.query({ kinds: ["state"] }).entries).toHaveLength(5);
    expect(store.query().entries[1]).not.toHaveProperty("rateLimitResetAt");
  });

  it("keeps non-attention baselines opt-in and persists deduplicated successor associations", () => {
    const dir = temp();
    let store = new SessionTransitions(dir);
    store.observeState(session(), "working", []);
    expect(store.query().entries).toEqual([]);
    expect(store.query({ kinds: ["state"] }).entries).toHaveLength(1);
    store.observeStatus(session("completed"), [task]);
    store.observeStatus(session("completed"), [task], "successor");
    store = new SessionTransitions(dir);
    store.observeStatus(session("completed"), [task], "successor");
    expect(store.query().entries).toHaveLength(2);
    expect(store.query().entries[1]).toMatchObject({
      from: "completed",
      to: "completed",
      successorId: "successor",
      links: [task],
    });
  });

  it("replays checkpoint lag and removes a partial final append before continuing", () => {
    const dir = temp();
    const store = new SessionTransitions(dir);
    const checkpoint = readFileSync(join(dir, "session-transitions", "checkpoint.json"));
    store.observeStatus(session(), [task]);
    const cursor = store.query().nextCursor;
    writeFileSync(join(dir, "session-transitions", "checkpoint.json"), checkpoint);
    appendFileSync(join(dir, "session-transitions", "1.jsonl"), '{"cursor":');
    const restarted = new SessionTransitions(dir);
    expect(restarted.query().nextCursor).toBe(cursor);
    restarted.observeStatus(session("completed"), []);
    expect(new SessionTransitions(dir).query().entries.map((entry) => entry.to)).toEqual([
      "running",
      "completed",
    ]);
  });

  it("returns expired cursors, retains oldest predecessor, rejects foreign and future cursors", () => {
    const dir = temp();
    const bounds = { segmentBytes: 1, retainSegments: 2 };
    const store = new SessionTransitions(dir, bounds);
    const old = store.query().nextCursor;
    store.observeStatus(session(), []);
    const predecessor = store.query().nextCursor;
    store.observeStatus(session("completed"), []);
    store.observeStatus(session("running"), []);
    expect(() => store.query({ since: old })).toThrow("expired");
    expect(store.query({ since: predecessor }).entries).toHaveLength(2);
    expect(
      readdirSync(join(dir, "session-transitions")).filter((name) => name.endsWith(".jsonl")),
    ).toHaveLength(2);
    expect(() => store.query({ since: new SessionTransitions(temp()).query().nextCursor })).toThrow(
      "foreign",
    );
    const future = store.query().nextCursor.replace(/\.\d+$/, ".999");
    expect(() => store.query({ since: future })).toThrow("Future");
    expect(new SessionTransitions(dir, bounds).query({ since: predecessor }).entries).toHaveLength(
      2,
    );
  });

  it("validates feed query and shares S5 URL normalization", () => {
    const query = parseSessionTransitionsQuery(
      new URLSearchParams("link=github_pr=https://EXAMPLE.com&link=role&limit=2&kinds=state"),
    );
    expect(query).toEqual({
      links: [{ label: "pr", url: "https://example.com/" }, { label: "role" }],
      limit: 2,
      kinds: ["state"],
    });
    for (const invalid of [
      "limit=0",
      "limit=1.5",
      "limit=1001",
      "kinds=unknown",
      "since=a&since=b",
      "link=role=reviewer",
    ]) {
      expect(() => parseSessionTransitionsQuery(new URLSearchParams(invalid))).toThrow();
    }
  });

  it("recovers an append whose checkpoint rename failed without duplicate sequence allocation", () => {
    const dir = temp();
    const store = new SessionTransitions(dir);
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("checkpoint failed");
    });
    expect(() => store.observeStatus(session(), [])).toThrow("checkpoint failed");
    expect(store.query().entries.map((entry) => entry.to)).toEqual(["running"]);
    const recovered = new SessionTransitions(dir);
    recovered.observeStatus(session(), []);
    recovered.observeStatus(session("completed"), []);
    expect(recovered.query().entries.map((entry) => entry.to)).toEqual(["running", "completed"]);
  });

  it("retries failed retention deletion without accepting an expired cursor", () => {
    const dir = temp();
    const bounds = { segmentBytes: 1, retainSegments: 2 };
    const store = new SessionTransitions(dir, bounds);
    const expired = store.query().nextCursor;
    store.observeStatus(session(), []);
    const predecessor = store.query().nextCursor;
    store.observeStatus(session("completed"), []);
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw new Error("prune failed");
    });
    expect(() => store.observeStatus(session("running"), [])).toThrow("prune failed");
    expect(() => store.query({ since: expired })).toThrow("expired");
    expect(new SessionTransitions(dir, bounds).query({ since: predecessor }).entries).toHaveLength(
      2,
    );
  });

  it("reads no journal segments for caught-up polls, including after restart", () => {
    const dir = temp();
    let store = new SessionTransitions(dir, { segmentBytes: 1, retainSegments: 6 });
    store.observeStatus(session(), [task]);
    store.observeStatus(session("completed"), [task]);
    store.observeStatus(session("running"), [task]);
    const cursor = store.query().nextCursor;
    vi.mocked(openSync).mockClear();
    expect(store.query({ since: cursor })).toEqual({
      entries: [],
      nextCursor: cursor,
      hasMore: false,
    });
    expect(openSync).not.toHaveBeenCalled();
    store = new SessionTransitions(dir, { segmentBytes: 1, retainSegments: 6 });
    vi.mocked(openSync).mockClear();
    expect(store.query({ since: cursor })).toEqual({
      entries: [],
      nextCursor: cursor,
      hasMore: false,
    });
    expect(openSync).not.toHaveBeenCalled();
  });

  it("reads only relevant segments after a cursor while advancing sparse-filter progress", () => {
    const dir = temp();
    const store = new SessionTransitions(dir, { segmentBytes: 1, retainSegments: 6 });
    store.observeStatus(session(), [task]);
    store.observeStatus(session("completed"), [task]);
    const cursor = store.query().nextCursor;
    store.observeStatus(session("running"), [role]);
    vi.mocked(openSync).mockClear();
    const sparse = store.query({ since: cursor, links: [task] });
    expect(sparse.entries).toEqual([]);
    expect(sparse.nextCursor).not.toBe(cursor);
    expect(vi.mocked(openSync).mock.calls.map(([path]) => path)).toEqual([
      join(dir, "session-transitions", "3.jsonl"),
    ]);
    store.observeStatus(session("completed"), [task]);
    const match = store.query({ since: sparse.nextCursor, links: [task], limit: 1 });
    expect(match.entries.map((entry) => entry.to)).toEqual(["completed"]);
  });

  it("validates relevant segment corruption and every retained segment on restart", () => {
    const dir = temp();
    const bounds = { segmentBytes: 1, retainSegments: 6 };
    const store = new SessionTransitions(dir, bounds);
    store.observeStatus(session(), []);
    store.observeStatus(session("completed"), []);
    const cursor = store.query().nextCursor;
    store.observeStatus(session("running"), []);
    writeFileSync(join(dir, "session-transitions", "1.jsonl"), "{invalid}\n");
    expect(store.query({ since: cursor }).entries.map((entry) => entry.to)).toEqual(["running"]);
    expect(() => new SessionTransitions(dir, bounds)).toThrow("Invalid session transitions JSON");
    writeFileSync(join(dir, "session-transitions", "3.jsonl"), "{invalid}\n");
    expect(() => store.query({ since: cursor })).toThrow("Invalid session transitions JSON");
  });
});
