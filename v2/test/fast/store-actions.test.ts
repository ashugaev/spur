import { readFile, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPage } from "../../src/pages.js";
import { StoreAgent, type StoreAgentSessions } from "../../src/store-agent.js";
import {
  ACTION_PENDING_CAP,
  ACTION_TIMEOUT_MS,
  StoreActions,
  buildActionEnvelope,
} from "../../src/store-actions.js";
import {
  MAX_STORE_BYTES,
  StoreError,
  StoreService,
  type StoreSessionView,
  pageDirPath,
} from "../../src/stores.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const FIXTURE = new URL("../fixtures/spur-action-envelope.txt", import.meta.url);

async function setup(
  options: { deliver?: (storeId: string, message: string) => Promise<void> } = {},
) {
  const dataDir = await createTempDir("spur-store-actions-");
  tempDirs.push(dataDir);
  createPage(dataDir, { id: "films" });
  const sessions: Record<string, StoreSessionView> = { "sp-1": { id: "sp-1", status: "running" } };
  let clock = Date.parse("2026-11-05T00:00:00.000Z");
  const delivered: Array<{ storeId: string; message: string; userGesture: boolean }> = [];
  const make = () => {
    const stores = new StoreService({ dataDir, readSession: (id) => sessions[id] ?? null });
    const actions = new StoreActions({
      stores,
      now: () => clock,
      deliver: async (storeId, message, userGesture) => {
        delivered.push({ storeId, message, userGesture });
        await options.deliver?.(storeId, message);
      },
    });
    return { stores, actions };
  };
  return {
    dataDir,
    sessions,
    delivered,
    ...make(),
    reopen: make,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function invokeBody(id: string, extra: Record<string, unknown> = {}) {
  return { id, action: "pick", source: { kind: "page" }, payload: { film: "Dune" }, ...extra };
}

async function status(promise: Promise<unknown>): Promise<number | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof StoreError) return error.statusCode;
    throw error;
  }
}

describe("action envelope", () => {
  it("equals the shared fixture", async () => {
    const envelope = buildActionEnvelope({
      id: "act-0001abcd",
      store: "page:films",
      action: "pick",
      label: "Pick film",
      source: { kind: "page" },
      payload: { film: "Dune", rating: 5 },
    });
    expect(envelope).toBe((await readFile(FIXTURE, "utf8")).trimEnd());
  });

  it("names the snippet and revision for snippet sources", () => {
    const envelope = buildActionEnvelope({
      id: "act-0001abcd",
      store: "session:sp-1",
      action: "save",
      label: "Save",
      source: { kind: "snippet", snippetId: "form", instanceId: "inst-0001", revision: 3 },
      payload: {},
    });
    expect(envelope.split("\n")[1]).toBe(
      'User action "Save" (save) from snippet form revision 3, store session:sp-1, id act-0001abcd.',
    );
    expect(envelope).toContain("spur db session:sp-1 done act-0001abcd");
  });

  it("rejects labels with newline, bidi override, bracket or quote", async () => {
    const { actions, delivered } = await setup();
    for (const label of ["a\nb", "evil‮abc", "[x]", 'say "hi"', "", "x".repeat(81)]) {
      expect(
        await status(actions.invoke("page:films", invokeBody("act-00000001", { label }))),
        label,
      ).toBe(400);
    }
    expect(delivered).toHaveLength(0);
  });

  it("validates id, action name, source and payload size", async () => {
    const { actions } = await setup();
    expect(await status(actions.invoke("page:films", invokeBody("short")))).toBe(400);
    expect(
      await status(actions.invoke("page:films", invokeBody("act-00000001", { action: "Pick" }))),
    ).toBe(400);
    expect(
      await status(
        actions.invoke("page:films", invokeBody("act-00000001", { source: { kind: "other" } })),
      ),
    ).toBe(400);
    expect(
      await status(
        actions.invoke(
          "page:films",
          invokeBody("act-00000001", { payload: { blob: "x".repeat(50_000) } }),
        ),
      ),
    ).toBe(413);
  });
});

describe("action delivery", () => {
  it("records a pending doc and delivers once per id across concurrency and reopen", async () => {
    const { actions, delivered, stores, reopen } = await setup();
    const docs = await Promise.all(
      [1, 2, 3].map(() => actions.invoke("page:films", invokeBody("act-00000001"))),
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.message.startsWith("[spur-action v1]\n")).toBe(true);
    expect(docs.every((doc) => doc.id === "act-00000001")).toBe(true);
    expect((await stores.get("page:films", "_actions", "act-00000001")).data).toMatchObject({
      action: "pick",
      label: "pick",
      status: "pending",
      source: { kind: "page" },
      payload: { film: "Dune" },
    });
    await reopen().actions.invoke("page:films", invokeBody("act-00000001"));
    expect(delivered).toHaveLength(1);
  });

  it("marks the doc failed when delivery fails, without retrying", async () => {
    const { actions, stores, delivered } = await setup({
      deliver: async () => {
        throw new StoreError(503, "Page agent recovery budget exhausted");
      },
    });
    expect(await status(actions.invoke("page:films", invokeBody("act-00000001")))).toBe(503);
    expect((await stores.get("page:films", "_actions", "act-00000001")).data).toMatchObject({
      status: "failed",
      error: "Page agent recovery budget exhausted",
    });
    expect(delivered).toHaveLength(1);
  });

  it("caps pending actions at 20 and expires stale ones on the next invoke", async () => {
    const { actions, stores, advance } = await setup();
    for (let n = 0; n < ACTION_PENDING_CAP; n++) {
      await actions.invoke("page:films", invokeBody(`act-${String(n).padStart(8, "0")}`));
    }
    expect(await status(actions.invoke("page:films", invokeBody("act-fresh-001")))).toBe(429);
    advance(ACTION_TIMEOUT_MS + 1000);
    expect(await status(actions.invoke("page:films", invokeBody("act-fresh-002")))).toBe("ok");
    const old = await stores.get("page:films", "_actions", "act-00000000");
    expect(old.data).toMatchObject({ status: "failed", error: "timeout" });
    const changes = await stores.changes("page:films", 0);
    expect(changes.changes.filter((change) => change.id === "act-00000000")).toHaveLength(2);
  });

  it("admits exactly one of two concurrent invokes at 19 pending", async () => {
    const { actions, stores, delivered } = await setup();
    for (let n = 0; n < ACTION_PENDING_CAP - 1; n++) {
      await actions.invoke("page:films", invokeBody(`act-${String(n).padStart(8, "0")}`));
    }
    const results = await Promise.all([
      status(actions.invoke("page:films", invokeBody("act-race-0001"))),
      status(actions.invoke("page:films", invokeBody("act-race-0002"))),
    ]);
    expect(results.sort()).toEqual([429, "ok"]);
    const pending = await stores.query("page:films", "_actions", {
      where: [{ field: "status", op: "==", value: "pending" }],
    });
    expect(pending).toHaveLength(ACTION_PENDING_CAP);
    expect(delivered).toHaveLength(ACTION_PENDING_CAP);
  });

  it("expires a pending action on a store over the size cap", async () => {
    const { actions, stores, dataDir, advance } = await setup();
    await actions.invoke("page:films", invokeBody("act-00000001"));
    await truncate(join(pageDirPath(dataDir, "films"), "data.sqlite"), MAX_STORE_BYTES + 1);
    advance(ACTION_TIMEOUT_MS + 1000);
    await actions.expire("page:films");
    expect((await stores.get("page:films", "_actions", "act-00000001")).data).toMatchObject({
      status: "failed",
      error: "timeout",
    });
    expect(await status(actions.invoke("page:films", invokeBody("act-00000002")))).toBe(413);
  });

  it("keeps an expired action failed on a terminal session store while generic writes stay closed", async () => {
    const { actions, stores, sessions, advance } = await setup();
    await actions.invoke("session:sp-1", invokeBody("act-00000001"));
    sessions["sp-1"] = { id: "sp-1", status: "completed" };
    advance(ACTION_TIMEOUT_MS + 1000);
    await actions.expire("session:sp-1");
    expect((await stores.get("session:sp-1", "_actions", "act-00000001")).data).toMatchObject({
      status: "failed",
      error: "timeout",
    });
    expect((await stores.changes("session:sp-1", 0)).changes).toHaveLength(2);
    expect(await status(stores.set("session:sp-1", "notes", "n1", {}))).toBe(409);
    expect(await status(actions.invoke("session:sp-1", invokeBody("act-00000002")))).toBe(409);
  });

  it("validates retryOf against a failed doc", async () => {
    const { actions, advance } = await setup();
    await actions.invoke("page:films", invokeBody("act-00000001"));
    expect(
      await status(
        actions.invoke("page:films", invokeBody("act-00000002", { retryOf: "act-00000001" })),
      ),
    ).toBe(400);
    expect(
      await status(
        actions.invoke("page:films", invokeBody("act-00000002", { retryOf: "act-missing1" })),
      ),
    ).toBe(400);
    await actions.complete("page:films", "act-00000001", { status: "failed", error: "nope" });
    advance(1);
    const retry = await actions.invoke(
      "page:films",
      invokeBody("act-00000002", { retryOf: "act-00000001" }),
    );
    expect(retry.data).toMatchObject({ status: "pending", retryOf: "act-00000001" });
  });
});

describe("action completion", () => {
  it("closes a pending action once and keeps null members of the result", async () => {
    const { actions } = await setup();
    await actions.invoke("page:films", invokeBody("act-00000001"));
    const done = await actions.complete("page:films", "act-00000001", {
      status: "done",
      result: { film: "Dune", note: null },
    });
    expect(done.data).toMatchObject({
      status: "done",
      result: { film: "Dune", note: null },
      action: "pick",
    });
    expect(await status(actions.complete("page:films", "act-00000001", { status: "done" }))).toBe(
      409,
    );
    expect(await status(actions.complete("page:films", "act-missing1", { status: "done" }))).toBe(
      404,
    );
    expect(await status(actions.complete("page:films", "act-00000001", { status: "maybe" }))).toBe(
      400,
    );
    expect(await status(actions.complete("page:films", "act-00000001", { status: "failed" }))).toBe(
      400,
    );
  });

  it("refuses to complete an expired action", async () => {
    const { actions, advance } = await setup();
    await actions.invoke("page:films", invokeBody("act-00000001"));
    advance(ACTION_TIMEOUT_MS + 1);
    const error = await actions
      .complete("page:films", "act-00000001", { status: "done" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).statusCode).toBe(409);
    expect((error as StoreError).message).toContain("timed out");
  });
});

describe("invoke-on-change loop", () => {
  it("is bounded by the automated delivery budget", async () => {
    const dataDir = await createTempDir("spur-store-actions-loop-");
    tempDirs.push(dataDir);
    createPage(dataDir, { id: "films" });
    const stores = new StoreService({ dataDir, readSession: () => null });
    const sends: string[] = [];
    const sessionsFake: StoreAgentSessions = {
      get: async () => ({ status: "running", state: "waiting" }),
      send: async (_sessionId, request) => {
        sends.push(request.message);
        return {};
      },
      restore: async () => ({}),
      spawnInBackground: async () => ({ id: "pg-films-0001" }),
      getConversation: async () => ({
        messages: [],
        entries: [],
        durationMs: 0,
        state: "waiting",
        startIndex: 0,
        totalEntries: 0,
      }),
      kill: async () => ({}),
    };
    const agent = new StoreAgent({
      stores,
      sessions: sessionsFake,
      dataDir: () => dataDir,
      readSession: (id) =>
        id === "pg-films-0001" ? { id, project: "spur-page-films", status: "running" } : null,
      projectPrefixes: () => [],
    });
    const actions = new StoreActions({
      stores,
      deliver: (storeId, message, userGesture) =>
        agent.ensureAndDeliver(storeId, message, userGesture),
    });
    // Buggy page: every _actions change triggers another automated invoke.
    let next = 0;
    const off = stores.onChange("page:films", () => {
      next += 1;
    });
    let invoked = 0;
    while (invoked < 40 && invoked <= next) {
      invoked += 1;
      await actions
        .invoke("page:films", invokeBody(`act-loop-${String(invoked).padStart(4, "0")}`))
        .catch(() => undefined);
    }
    off();
    expect(sends.length).toBeLessThanOrEqual(10);
    expect(invoked).toBe(40);
  });
});
