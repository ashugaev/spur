import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { reserveNextSessionId } from "../../src/ids.js";
import { readSession, writeSession } from "../../src/metadata.js";
import {
  assertPagePrefixFree,
  buildPageProject,
  createPage,
  pageProjectId,
  readPageConfig,
  removePageDir,
  renderPageAgentPrompt,
} from "../../src/pages.js";
import { SessionEndedError } from "../../src/session-service.js";
import {
  AUTO_DELIVERY_BUDGET,
  StoreAgent,
  mapAgentState,
  type AgentStatus,
  type StoreAgentSessions,
} from "../../src/store-agent.js";
import { StoreError, StoreService, pageDirPath } from "../../src/stores.js";
import type {
  ConversationResponse,
  KillSessionRequest,
  SessionRecord,
  SessionState,
  SpawnSessionRequest,
  TranscriptEntry,
} from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeRecord {
  id: string;
  project: string;
  status: SessionRecord["status"];
  state: SessionState;
  entries: TranscriptEntry[];
}

class FakeSessions implements StoreAgentSessions {
  readonly records = new Map<string, FakeRecord>();
  readonly spawns: SpawnSessionRequest[] = [];
  readonly sends: Array<{ sessionId: string; message: string; queue: boolean | undefined }> = [];
  readonly restores: string[] = [];
  readonly kills: Array<{ sessionId: string; request: KillSessionRequest | undefined }> = [];
  restoreFails = false;
  onLaunch: (record: FakeRecord) => void = () => undefined;
  onSend: (record: FakeRecord) => void = () => undefined;
  private counter = 0;

  get launches(): number {
    return this.spawns.length + this.restores.length;
  }

  add(record: Partial<FakeRecord> & { id: string; project: string }): FakeRecord {
    const full: FakeRecord = { status: "running", state: "waiting", entries: [], ...record };
    this.records.set(full.id, full);
    return full;
  }

  async get(sessionId: string) {
    const record = this.records.get(sessionId);
    if (!record) throw new Error(`missing ${sessionId}`);
    return { status: record.status, state: record.state };
  }

  async send(sessionId: string, request: { message: string; queue?: boolean }) {
    const record = this.records.get(sessionId);
    if (!record || record.status === "killed" || record.status === "completed") {
      throw new SessionEndedError(`Session ${sessionId} ended`);
    }
    this.sends.push({ sessionId, message: request.message, queue: request.queue });
    this.onSend(record);
    return {};
  }

  async restore(sessionId: string) {
    this.restores.push(sessionId);
    if (this.restoreFails) throw new Error("resume impossible");
    const record = this.records.get(sessionId) as FakeRecord;
    record.status = "running";
    this.onLaunch(record);
    return {};
  }

  async spawnInBackground(request: SpawnSessionRequest) {
    this.spawns.push(request);
    this.counter += 1;
    const record = this.add({
      id: `pg-x-${String(this.counter).padStart(4, "0")}`,
      project: request.project,
    });
    this.onLaunch(record);
    return { id: record.id };
  }

  async getConversation(sessionId: string): Promise<ConversationResponse> {
    const record = this.records.get(sessionId) as FakeRecord;
    return {
      messages: [],
      entries: record.entries,
      durationMs: 0,
      state: record.state,
      startIndex: 0,
      totalEntries: record.entries.length,
    };
  }

  async kill(sessionId: string, request?: KillSessionRequest) {
    this.kills.push({ sessionId, request });
    (this.records.get(sessionId) as FakeRecord).status = "killed";
    return {};
  }
}

async function setup(prefixes: string[] = []) {
  const dataDir = await createTempDir("spur-store-agent-");
  tempDirs.push(dataDir);
  createPage(dataDir, { id: "films", title: "Films" });
  const sessions = new FakeSessions();
  let clock = Date.parse("2026-11-05T00:00:00.000Z");
  const statuses: Array<[string, AgentStatus]> = [];
  const make = () => {
    const stores = new StoreService({
      dataDir,
      readSession: (id) => {
        const record = sessions.records.get(id);
        return record ? { id: record.id, status: record.status } : null;
      },
    });
    const agent = new StoreAgent({
      stores,
      sessions,
      dataDir: () => dataDir,
      readSession: (id) => sessions.records.get(id) ?? null,
      projectPrefixes: () => prefixes,
      onStatus: (pageId, status) => statuses.push([pageId, status]),
      now: () => clock,
    });
    return { stores, agent };
  };
  return {
    dataDir,
    sessions,
    statuses,
    ...make(),
    reopen: make,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

async function outcome(promise: Promise<unknown>): Promise<number | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof StoreError) return error.statusCode;
    throw error;
  }
}

describe("page agent spawn and binding", () => {
  it("spawns lazily with the page prompt only and delivers by queued send", async () => {
    const { agent, sessions, dataDir, stores } = await setup();
    const result = await agent.ensureAndDeliver("page:films", "hello agent", true);
    expect(sessions.spawns).toHaveLength(1);
    expect(sessions.spawns[0]).toMatchObject({
      project: "spur-page-films",
      agent: "claude",
      prompt: renderPageAgentPrompt("films", readPageConfig(dataDir, "films")),
    });
    expect(sessions.spawns[0]?.prompt).not.toContain("hello agent");
    expect(sessions.sends).toEqual([
      { sessionId: result.sessionId, message: "hello agent", queue: true },
    ]);
    expect(await stores.readMeta("page:films", "agent.binding")).toEqual({
      sessionId: result.sessionId,
    });
    await agent.ensureAndDeliver("page:films", "again", true);
    expect(sessions.spawns).toHaveLength(1);
  });

  it("spawns once under concurrent deliveries", async () => {
    const { agent, sessions } = await setup();
    await Promise.all([1, 2, 3].map((n) => agent.ensureAndDeliver("page:films", `m${n}`, true)));
    expect(sessions.spawns).toHaveLength(1);
    expect(sessions.sends.map((send) => send.message)).toEqual(["m1", "m2", "m3"]);
  });

  it("ignores a binding to a session of another project", async () => {
    const { agent, sessions, stores } = await setup();
    sessions.add({ id: "demo-1", project: "demo" });
    await stores.transactMeta("page:films", (meta) =>
      meta.set("agent.binding", { sessionId: "demo-1" }),
    );
    const result = await agent.ensureAndDeliver("page:films", "hi", true);
    expect(result.sessionId).not.toBe("demo-1");
    expect(sessions.spawns).toHaveLength(1);
    expect(sessions.sends.some((send) => send.sessionId === "demo-1")).toBe(false);
  });

  it("refuses to spawn when a project owns the page prefix", async () => {
    const { agent, sessions } = await setup(["pg-films"]);
    expect(await outcome(agent.ensureAndDeliver("page:films", "hi", true))).toBe(409);
    expect(sessions.spawns).toHaveLength(0);
    expect(() => assertPagePrefixFree("films", ["pg-films"])).toThrow(StoreError);
    expect(() => assertPagePrefixFree("films", ["pg"])).not.toThrow();
  });
});

describe("page agent recovery", () => {
  async function bound(status: SessionRecord["status"], state: SessionState = "waiting") {
    const ctx = await setup();
    await ctx.agent.ensureAndDeliver("page:films", "first", true);
    const record = [...ctx.sessions.records.values()][0] as FakeRecord;
    record.status = status;
    record.state = state;
    return { ...ctx, record };
  }
  const recoverCount = (stores: StoreService) => stores.readMeta("page:films", "budget.recover");

  it("charges and sends to a stopped session", async () => {
    const { agent, sessions, stores, record } = await bound("stopped");
    await agent.ensureAndDeliver("page:films", "next", false);
    expect(await recoverCount(stores)).toBe(1);
    expect(sessions.sends.at(-1)).toMatchObject({ sessionId: record.id, message: "next" });
    expect(sessions.spawns).toHaveLength(1);
  });

  it("charges a classified-stopped running session", async () => {
    const { agent, stores } = await bound("running", "stopped");
    await agent.ensureAndDeliver("page:films", "next", false);
    expect(await recoverCount(stores)).toBe(1);
  });

  it("restores an errored session and sends", async () => {
    const { agent, sessions, stores, record } = await bound("errored");
    await agent.ensureAndDeliver("page:films", "next", false);
    expect(sessions.restores).toEqual([record.id]);
    expect(sessions.sends.at(-1)?.sessionId).toBe(record.id);
    expect(await recoverCount(stores)).toBe(1);
  });

  it("spawns fresh when restore throws, charging once", async () => {
    const { agent, sessions, stores, record } = await bound("errored");
    sessions.restoreFails = true;
    const result = await agent.ensureAndDeliver("page:films", "next", false);
    expect(result.sessionId).not.toBe(record.id);
    expect(sessions.spawns).toHaveLength(2);
    expect(await recoverCount(stores)).toBe(1);
    expect(await stores.readMeta("page:films", "agent.binding")).toEqual({
      sessionId: result.sessionId,
    });
  });

  it("spawns fresh, charged, when a send finds the session ended", async () => {
    const { agent, sessions, stores, record } = await bound("running");
    sessions.onSend = () => undefined;
    record.status = "running";
    const original = sessions.send.bind(sessions);
    let first = true;
    sessions.send = async (sessionId, request) => {
      if (first && sessionId === record.id) {
        first = false;
        throw new SessionEndedError("gone");
      }
      return original(sessionId, request);
    };
    const result = await agent.ensureAndDeliver("page:films", "next", false);
    expect(result.sessionId).not.toBe(record.id);
    expect(await recoverCount(stores)).toBe(1);
  });

  it("sends to a budget_limited session without a charge", async () => {
    const { agent, stores, sessions, record } = await bound("budget_limited");
    await agent.ensureAndDeliver("page:films", "next", false);
    expect(await recoverCount(stores)).toBe(0);
    expect(sessions.sends.at(-1)?.sessionId).toBe(record.id);
  });

  it("bounds a crash loop of automated sends over one hour to exactly 4 launches", async () => {
    const { agent, sessions, advance } = await setup();
    sessions.onLaunch = (record) => {
      record.status = "errored";
    };
    const results: Array<number | "ok"> = [];
    for (let minute = 0; minute < 60; minute += 5) {
      results.push(await outcome(agent.ensureAndDeliver("page:films", `reload ${minute}`, false)));
      advance(5 * 60 * 1000);
    }
    expect(sessions.launches).toBe(4);
    expect(results.slice(0, 4)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(results.slice(4).every((result) => result === 503 || result === 429)).toBe(true);
  });

  it("resets the recovery counter on agent progress", async () => {
    const { agent, sessions, stores, record, advance, now } = await bound("stopped");
    await agent.ensureAndDeliver("page:films", "a", false);
    record.status = "stopped";
    await agent.ensureAndDeliver("page:films", "b", false);
    expect(await recoverCount(stores)).toBe(2);
    advance(1000);
    record.entries.push({ kind: "message", role: "assistant", text: "done", timestampMs: now() });
    record.status = "running";
    record.state = "waiting";
    await agent.ensureAndDeliver("page:films", "c", false);
    expect(await recoverCount(stores)).toBe(0);
    expect(sessions.sends.at(-1)?.message).toBe("c");
  });

  it("does not count a reply while the agent is still working as progress", async () => {
    const { agent, stores, record, advance, now } = await bound("stopped");
    await agent.ensureAndDeliver("page:films", "a", false);
    advance(1000);
    record.entries.push({
      kind: "message",
      role: "assistant",
      text: "partial",
      timestampMs: now(),
    });
    record.status = "running";
    record.state = "working";
    await agent.ensureAndDeliver("page:films", "b", false);
    expect(await recoverCount(stores)).toBe(1);
  });

  it("resets the recovery counter on a user-gesture delivery", async () => {
    const { agent, stores, record } = await bound("stopped");
    await agent.ensureAndDeliver("page:films", "a", false);
    expect(await recoverCount(stores)).toBe(1);
    record.status = "running";
    await agent.ensureAndDeliver("page:films", "b", true);
    expect(await recoverCount(stores)).toBe(0);
  });
});

describe("delivery budgets", () => {
  it("caps a reload-send loop over one hour at 10 automated deliveries", async () => {
    const { agent, sessions, advance, now } = await setup();
    sessions.onSend = (record) => {
      record.entries.push({ kind: "message", role: "assistant", text: "ok", timestampMs: now() });
    };
    for (let second = 0; second < 3600; second += 30) {
      await outcome(agent.ensureAndDeliver("page:films", "page reloaded", false));
      advance(30_000);
    }
    expect(sessions.sends).toHaveLength(AUTO_DELIVERY_BUDGET);
  });

  it("resets the automated counter on a user-gesture delivery", async () => {
    const { agent, sessions } = await setup();
    for (let n = 0; n < AUTO_DELIVERY_BUDGET; n++)
      await agent.ensureAndDeliver("page:films", "auto", false);
    expect(await outcome(agent.ensureAndDeliver("page:films", "auto", false))).toBe(429);
    await agent.ensureAndDeliver("page:films", "user", true);
    expect(await outcome(agent.ensureAndDeliver("page:films", "auto", false))).toBe("ok");
    expect(sessions.sends.filter((send) => send.message === "auto")).toHaveLength(
      AUTO_DELIVERY_BUDGET + 1,
    );
  });

  it("rejects the 31st user message within 10 minutes, then accepts after the window", async () => {
    const { agent, advance } = await setup();
    for (let n = 0; n < 30; n++) {
      expect(await outcome(agent.ensureAndDeliver("page:films", `u${n}`, true))).toBe("ok");
      advance(10_000);
    }
    expect(await outcome(agent.ensureAndDeliver("page:films", "u30", true))).toBe(429);
    advance(10 * 60 * 1000);
    expect(await outcome(agent.ensureAndDeliver("page:films", "u31", true))).toBe("ok");
  });

  it("keeps budgets across a reopen", async () => {
    const { agent, reopen } = await setup();
    for (let n = 0; n < AUTO_DELIVERY_BUDGET; n++)
      await agent.ensureAndDeliver("page:films", "auto", false);
    const fresh = reopen();
    expect(await outcome(fresh.agent.ensureAndDeliver("page:films", "auto", false))).toBe(429);
  });
});

describe("session store owner", () => {
  it("sends queue:true to the owning session, 409 once terminal, never spawns", async () => {
    const { agent, sessions } = await setup();
    sessions.add({ id: "demo-1", project: "demo" });
    expect(await agent.ensureAndDeliver("session:demo-1", "hi", true)).toEqual({
      sessionId: "demo-1",
    });
    expect(sessions.sends).toEqual([{ sessionId: "demo-1", message: "hi", queue: true }]);
    (sessions.records.get("demo-1") as FakeRecord).status = "completed";
    expect(await outcome(agent.ensureAndDeliver("session:demo-1", "late", true))).toBe(409);
    expect(await outcome(agent.ensureAndDeliver("session:nope", "x", true))).toBe(404);
    expect(sessions.spawns).toHaveLength(0);
    expect(await agent.status("session:demo-1")).toEqual({ state: "error", sessionId: "demo-1" });
  });
});

describe("agent status", () => {
  it("maps session status and state", async () => {
    expect(mapAgentState({ status: "running", state: "working" })).toBe("working");
    expect(mapAgentState({ status: "running", state: "waiting" })).toBe("idle");
    expect(mapAgentState({ status: "stopped", state: "stale" })).toBe("idle");
    expect(mapAgentState({ status: "running", state: "rate_limited" })).toBe("rate_limited");
    expect(mapAgentState({ status: "budget_limited", state: "stopped" })).toBe("rate_limited");
    expect(mapAgentState({ status: "errored", state: "error" })).toBe("error");
    expect(mapAgentState({ status: "killed", state: "killed" })).toBe("error");
  });

  it("reports none before the first spawn and emits changes to page listeners", async () => {
    const { agent, sessions, statuses } = await setup();
    expect(await agent.status("page:films")).toEqual({ state: "none", sessionId: null });
    const { sessionId } = await agent.ensureAndDeliver("page:films", "hi", true);
    (sessions.records.get(sessionId) as FakeRecord).state = "working";
    await agent.sample(["films"]);
    await agent.sample(["films"]);
    expect(statuses).toEqual([["films", { state: "working", sessionId }]]);
  });
});

describe("page delete", () => {
  it("kills the bound session with skipPrCheck before removing the page", async () => {
    const { agent, sessions, dataDir } = await setup();
    const { sessionId } = await agent.ensureAndDeliver("page:films", "hi", true);
    const order: string[] = [];
    const kill = sessions.kill.bind(sessions);
    sessions.kill = async (id, request) => {
      order.push("kill");
      return kill(id, request);
    };
    await agent.deletePage("films", () => {
      order.push("remove");
      removePageDir(dataDir, "films");
    });
    expect(sessions.kills).toEqual([{ sessionId, request: { skipPrCheck: true } }]);
    expect(order).toEqual(["kill", "remove"]);
  });

  it("serializes a concurrent send with delete: send completes first or fails 404, no spawn after removal", async () => {
    const { agent, sessions, dataDir } = await setup();
    const remove = () => removePageDir(dataDir, "films");
    const [sent, deleted, late] = await Promise.all([
      outcome(agent.ensureAndDeliver("page:films", "hi", true)),
      outcome(agent.deletePage("films", remove)),
      outcome(agent.ensureAndDeliver("page:films", "late", true)),
    ]);
    expect(sent).toBe("ok");
    expect(deleted).toBe("ok");
    expect(late).toBe(404);
    expect(sessions.spawns).toHaveLength(1);
    expect(sessions.kills).toHaveLength(1);
  });
});

describe("page project", () => {
  it("pins worktree:false, restoreAfterReboot:false, the page dir and prefix pg-<pageId>", async () => {
    const { dataDir } = await setup();
    createPage(dataDir, { id: "notes", runtime: "codex", model: "gpt-5" });
    expect(buildPageProject(dataDir, "films")).toMatchObject({
      name: "spur-page-films",
      path: pageDirPath(dataDir, "films"),
      sessionPrefix: "pg-films",
      worktree: false,
      restoreAfterReboot: false,
      defaultAgent: "claude",
      sidecars: {},
      sources: {},
      triggers: {},
    });
    expect(buildPageProject(dataDir, "notes").defaultModels).toEqual({ codex: "gpt-5" });
  });

  it("reserves distinct ids for two pages and a user project with prefix pg", async () => {
    const { dataDir } = await setup();
    createPage(dataDir, { id: "films-ab12" });
    const films = await reserveNextSessionId(dataDir, pageProjectId("films"), "pg-films");
    const filmsAb = await reserveNextSessionId(
      dataDir,
      pageProjectId("films-ab12"),
      "pg-films-ab12",
    );
    const user = await reserveNextSessionId(dataDir, "pgproj", "pg");
    expect(films).toMatch(/^pg-films-[0-9a-f]{4}$/);
    expect(filmsAb).toMatch(/^pg-films-ab12-[0-9a-f]{4}$/);
    expect(user).toMatch(/^pg-[0-9a-f]{4}$/);
    const base = {
      agent: "claude" as const,
      prompt: "x",
      branch: "main",
      worktree: false,
      worktreePath: dataDir,
      launchCommand: "claude",
      status: "running" as const,
      createdAt: "2026-11-05T00:00:00.000Z",
      updatedAt: "2026-11-05T00:00:00.000Z",
    };
    for (const [id, project] of [
      [films, pageProjectId("films")],
      [filmsAb, pageProjectId("films-ab12")],
      [user, "pgproj"],
    ] as const) {
      writeSession(dataDir, { ...base, id, project, workspaceId: id, tmuxSession: id });
    }
    expect(readSession(dataDir, films)?.project).toBe("spur-page-films");
    expect(readSession(dataDir, filmsAb)?.project).toBe("spur-page-films-ab12");
    expect(readSession(dataDir, user)?.project).toBe("pgproj");
  });
});
