import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSnippetManifest } from "@/lib/snippets/snippet-manifest";
import { snippetStateDocId } from "@/lib/snippets/snippet-protocol";
import { readSnippetBudget } from "@/lib/snippets/snippet-store";
import { createStoreChangePoller, STORE_POLL_INTERVAL_MS } from "@/lib/store-change-poller";
import {
  FakeDaemon,
  type FakePoller,
  flush,
  harness,
  manifest,
  OWNER_STORE,
  ready,
  SID,
  type Harness,
} from "./fixtures/snippet-host-rig";

const OWNER = "/api/stores/session%3Asp-ab12";
const PAGE = "/api/stores/page%3Afilms";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

function urls(h: Harness): string[] {
  return h.daemon.requests.map((request) => `${request.method} ${request.url}`);
}

function ownerChange(h: Harness, id: string): void {
  (h.poller as FakePoller).emit(OWNER_STORE, {
    type: "changes",
    changes: [{ seq: 9, collection: "_actions", id, op: "set", rev: 2 }],
  });
}

describe("db over the port", () => {
  it("forwards db calls to the data store and answers with the same type and callId", async () => {
    const h = harness();
    const port = await ready(h);
    port.emit({ type: "db", callId: "d1", method: "POST", path: "docs/items", body: { data: {} } });
    port.emit({ type: "db", callId: "d2", method: "POST", path: "query/items", body: {} });
    port.emit({ type: "db", callId: "d3", method: "GET", path: "docs/items/a_b-1" });
    await flush();
    expect(urls(h)).toEqual(
      expect.arrayContaining([
        `POST ${OWNER}/docs/items`,
        `POST ${OWNER}/query/items`,
        `GET ${OWNER}/docs/items/a_b-1`,
      ]),
    );
    expect(port.reply("db", "d1")).toMatchObject({ ok: true, status: 200 });
  });

  it("the frame cannot name or escape the store", async () => {
    const h = harness({ manifest: manifest({ store: "page:films" }) });
    const port = await ready(h);
    const before = h.daemon.requests.length;
    const paths = [
      "../session%3Asp-other/docs/items",
      "docs/items/..",
      "docs/a%2Fb",
      "actions",
      "agent/send",
      "actions/x/complete",
      "docs/_actions/x/complete",
      "changes?since=0",
    ];
    for (const [index, path] of paths.entries()) {
      port.emit({ type: "db", callId: `x${index}`, method: "POST", path, body: {} });
    }
    port.emit({ type: "db", callId: "m", method: "PUT", path: "docs/items/a", body: {} });
    await flush();
    expect(h.daemon.requests).toHaveLength(before);
    for (const callId of [...paths.keys()].map((index) => `x${index}`).concat("m")) {
      expect(port.reply("db", callId)).toMatchObject({ ok: false, status: 400 });
    }
    port.emit({ type: "db-subscribe", store: "session:sp-other" });
    expect(h.poller.activeStores().sort()).toEqual([OWNER_STORE, "page:films"].sort());
  });

  it("honors manifest store page:<id> for data while actions stay on the owner store", async () => {
    const h = harness({ manifest: manifest({ store: "page:films" }) });
    const port = await ready(h);
    port.emit({ type: "db", callId: "d1", method: "GET", path: "docs/items/a" });
    h.invoke("go", { note: "a" });
    await flush();
    expect(urls(h)).toContain(`GET ${PAGE}/docs/items/a`);
    expect(h.daemon.posts("/actions")[0]?.url).toBe(`${OWNER}/actions`);
    const foreign = parseSnippetManifest(
      `<script type="application/spur-snippet+json">${JSON.stringify({
        ...manifest(),
        store: "session:sp-other",
      })}</script>`,
      { sessionId: SID, snippetId: "picker" },
    );
    expect(foreign).toMatchObject({ ok: false, error: { path: "/store" } });
  });
});

describe("change feed", () => {
  it("one poller serves N panels; the last unmount stops it", async () => {
    const calls: string[] = [];
    const poller = createStoreChangePoller({
      fetchChanges: (store, since) => {
        calls.push(store);
        return Promise.resolve({ changes: [], lastSeq: since });
      },
    });
    const daemon = new FakeDaemon();
    const panels = [
      harness({ poller, daemon }),
      harness({ poller, daemon, manifest: manifest({ snippetId: "two" }) }),
      harness({ poller, daemon, manifest: manifest({ snippetId: "three", store: "page:films" }) }),
    ];
    for (const panel of panels) {
      const port = await ready(panel);
      port.emit({ type: "db-subscribe" });
    }
    expect(poller.activeStores().sort()).toEqual([OWNER_STORE, "page:films"].sort());
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(STORE_POLL_INTERVAL_MS);
    expect(calls.sort()).toEqual([OWNER_STORE, "page:films"].sort());
    panels[2]?.host.dispose();
    expect(poller.activeStores()).toEqual([OWNER_STORE]);
    panels[0]?.host.dispose();
    panels[1]?.port().emit({ type: "db-unsubscribe" });
    expect(poller.activeStores()).toEqual([OWNER_STORE]);
    panels[1]?.host.dispose();
    expect(poller.activeStores()).toEqual([]);
  });

  it("forwards data-store changes once per collection and owner action changes as status", async () => {
    const h = harness({ manifest: manifest({ store: "page:films" }) });
    const port = await ready(h);
    const poller = h.poller as FakePoller;
    poller.emit("page:films", {
      type: "changes",
      changes: [{ seq: 1, collection: "items", id: "a", op: "set", rev: 1 }],
    });
    expect(port.ofType("db-change")).toHaveLength(0);
    port.emit({ type: "db-subscribe" });
    poller.emit("page:films", {
      type: "changes",
      changes: [
        { seq: 2, collection: "items", id: "a", op: "set", rev: 2 },
        { seq: 3, collection: "items", id: "b", op: "set", rev: 1 },
        { seq: 4, collection: "tags", id: "t", op: "delete", rev: 3 },
      ],
    });
    expect(port.ofType("db-change").map((m) => (m.change as { seq: number }).seq)).toEqual([3, 4]);
    poller.emit("page:films", { type: "reset" });
    expect(port.ofType("db-reset")).toHaveLength(1);

    h.invoke("go", { note: "a" }, "c1");
    await flush();
    const id = h.host.getState().action?.id ?? "";
    h.daemon.complete(id, { status: "done", result: { picked: "Dune" } });
    ownerChange(h, id);
    await flush();
    expect(port.ofType("action").at(-1)?.action).toMatchObject({ id, status: "completed" });
    expect(port.ofType("db-change")).toHaveLength(2);
  });
});

describe("agent over the port", () => {
  it("send, messages and status hit session:<owner> even with a page data store", async () => {
    const h = harness({ manifest: manifest({ store: "page:films" }) });
    const port = await ready(h);
    port.emit({ type: "agent", op: "send", message: "hello", userGesture: false, callId: "a1" });
    port.emit({ type: "agent", op: "messages", from: 4, callId: "a2" });
    port.emit({ type: "agent", op: "status", callId: "a3" });
    await flush();
    expect(h.daemon.posts("/agent/send")[0]).toMatchObject({
      url: `${OWNER}/agent/send`,
      body: { message: "hello", userGesture: true },
    });
    expect(urls(h)).toEqual(
      expect.arrayContaining([`GET ${OWNER}/agent/messages?from=4`, `GET ${OWNER}/agent/status`]),
    );
    expect(port.reply("agent", "a1")).toMatchObject({ ok: true, body: { sessionId: SID } });
    expect(port.reply("agent", "a3")).toMatchObject({ ok: true, body: { state: "idle" } });
  });

  it("a send without interaction waits for confirm; sends count toward the unconfirmed budget", async () => {
    const h = harness();
    await flush();
    const port = await h.connect();
    port.emit({ type: "agent", op: "send", message: "hello", callId: "a1" });
    await flush();
    expect(h.host.getState().confirm).toEqual({
      kind: "send",
      reason: "no_focus",
      message: "hello",
    });
    expect(h.daemon.posts("/agent/send")).toHaveLength(0);
    h.host.confirmSend(true);
    await flush();
    expect(h.daemon.posts("/agent/send")).toHaveLength(1);
    expect(port.reply("agent", "a1")).toMatchObject({ ok: true });

    h.focused.value = true;
    for (let index = 0; index < 10; index += 1) {
      port.emit({ type: "agent", op: "send", message: `m${index}`, callId: `s${index}` });
    }
    await flush();
    expect(h.daemon.posts("/agent/send")).toHaveLength(11);
    expect(readSnippetBudget(h.storage, SID)).toMatchObject({ value: { unconfirmed: 10 } });
    port.emit({ type: "agent", op: "send", message: "eleventh", callId: "s10" });
    expect(h.host.getState().confirm).toMatchObject({ kind: "send", reason: "budget" });
    h.host.confirmDiscard(true);
    expect(port.reply("agent", "s10")).toMatchObject({ ok: false, body: { error: "declined" } });
    // Sends never mark the revision, so the next invoke is not a repeat.
    h.host.confirmSend(true);
    h.invoke("go", { note: "a" });
    expect(h.host.getState().confirm?.reason).toBe("budget");
  });
});

describe("action lifecycle", () => {
  it("POSTs the invoke to the owner store with the snippet source and userGesture", async () => {
    const h = harness();
    await ready(h);
    h.invoke("go", { note: "a" }, "c1");
    expect(h.host.getState().action?.status).toBe("submitting");
    await flush();
    const post = h.daemon.posts("/actions")[0];
    expect(post?.url).toBe(`${OWNER}/actions`);
    expect(post?.body).toEqual({
      id: h.host.getState().action?.id,
      action: "go",
      label: "Go",
      source: { kind: "snippet", snippetId: "picker", instanceId: "inst-00000001", revision: 1 },
      payload: { note: "a" },
      userGesture: true,
    });
  });

  it("takes status from _actions: queued, processing while the agent works, completed with result", async () => {
    const h = harness();
    const port = await ready(h);
    h.invoke("go", { note: "a" }, "c1");
    await flush();
    expect(h.host.getState().action?.status).toBe("queued");
    h.session({ state: "working" });
    expect(h.host.getState().action?.status).toBe("processing");
    expect(port.reply("invoke-result", "c1")).toBeUndefined();
    const id = h.host.getState().action?.id ?? "";
    h.daemon.complete(id, { status: "done", result: { picked: "Dune" } });
    ownerChange(h, id);
    await flush();
    expect(port.reply("invoke-result", "c1")).toEqual({
      type: "invoke-result",
      callId: "c1",
      ok: true,
      id,
      result: { picked: "Dune" },
    });
    expect(port.ofType("action").map((m) => (m.action as { status: string }).status)).toEqual([
      "submitting",
      "queued",
      "processing",
      "completed",
    ]);
  });

  it("timeout arrives only through a daemon change, never from a client timer", async () => {
    const h = harness();
    const port = await ready(h);
    h.invoke("go", { note: "a" }, "c1");
    await flush();
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(h.host.getState().action?.status).toBe("queued");
    const id = h.host.getState().action?.id ?? "";
    h.daemon.complete(id, { status: "failed", error: "timeout" });
    ownerChange(h, id);
    await flush();
    expect(h.host.getState().action?.status).toBe("timeout");
    expect(port.reply("invoke-result", "c1")).toMatchObject({ ok: false, reason: "timeout", id });
  });

  it("a failed doc resolves failed with the agent's error", async () => {
    const h = harness();
    const port = await ready(h);
    h.invoke("go", { note: "a" }, "c1");
    await flush();
    const id = h.host.getState().action?.id ?? "";
    h.daemon.complete(id, { status: "failed", error: "no film" });
    ownerChange(h, id);
    await flush();
    expect(port.reply("invoke-result", "c1")).toMatchObject({
      ok: false,
      reason: "failed",
      id,
      error: "no film",
    });
  });

  it("a refused POST is a local error; Retry resends the payload under a new id without retryOf", async () => {
    const h = harness();
    const port = await ready(h);
    h.daemon.intercept = (request) =>
      request.method === "POST" && request.url.endsWith("/actions")
        ? { ok: false, status: 409, body: { error: "Store is read-only" } }
        : null;
    h.invoke("go", { note: "a" }, "c1");
    await flush();
    expect(h.host.getState().action).toMatchObject({ status: "error", httpStatus: 409 });
    expect(port.reply("invoke-result", "c1")).toEqual({
      type: "invoke-result",
      callId: "c1",
      ok: false,
      reason: "session_unavailable",
    });
    h.daemon.intercept = () => null;
    const first = h.host.getState().action?.id;
    h.host.retry(true);
    await flush();
    const posts = h.daemon.posts("/actions");
    expect(posts).toHaveLength(2);
    const body = posts[1]?.body as Record<string, unknown>;
    expect(body.id).not.toBe(first);
    expect(body.retryOf).toBeUndefined();
    expect(body.payload).toEqual({ note: "a" });
  });

  it("retry reads the payload from the failed doc and sends a new id with retryOf", async () => {
    const h = harness();
    const port = await ready(h);
    h.invoke("go", { note: "a" }, "c1");
    await flush();
    const id = h.host.getState().action?.id ?? "";
    h.daemon.complete(id, { status: "failed", error: "boom", payload: { note: "from-doc" } });
    ownerChange(h, id);
    await flush();
    port.emit({ type: "invoke", callId: "r1", action: "go", retry: true });
    await flush();
    // An SDK retry is a new invoke: the second one on this revision needs a confirm.
    expect(h.host.getState().confirm).toMatchObject({ reason: "repeat_in_revision", retryOf: id });
    h.host.confirmSend(true);
    await flush();
    const body = h.daemon.posts("/actions")[1]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ retryOf: id, payload: { note: "from-doc" }, action: "go" });
    expect(body.id).not.toBe(id);
    expect(h.host.getState().action).toMatchObject({ id: body.id, retryOf: id });

    h.host.retry(true);
    await flush();
    expect(h.daemon.posts("/actions")).toHaveLength(2);
  });

  it("mount restore shows the latest action of this snippet instance", async () => {
    const daemon = new FakeDaemon();
    const add = (id: string, createdAt: string, source: Record<string, unknown>, status: string) =>
      daemon.actions.set(id, {
        id,
        rev: 1,
        createdAt,
        updatedAt: createdAt,
        data: { action: "go", label: "Go", payload: { note: id }, source, status, createdAt },
      });
    const mine = { kind: "snippet", snippetId: "picker", instanceId: "inst-00000001", revision: 1 };
    add("act-old-0001", "2026-11-03T09:00:00.000Z", mine, "done");
    add("act-new-0002", "2026-11-03T09:30:00.000Z", mine, "pending");
    add("act-other-01", "2026-11-03T09:50:00.000Z", { ...mine, snippetId: "other" }, "done");
    add("act-inst-001", "2026-11-03T09:55:00.000Z", { ...mine, instanceId: "inst-2" }, "done");
    const h = harness({ daemon });
    await flush();
    expect(daemon.requests[0]).toMatchObject({
      method: "POST",
      url: `${OWNER}/query/_actions`,
      body: {
        where: [
          { field: "source.snippetId", op: "==", value: "picker" },
          { field: "source.instanceId", op: "==", value: "inst-00000001" },
        ],
        orderBy: { field: "createdAt", direction: "desc" },
        limit: 1,
      },
    });
    expect(h.host.getState().action).toMatchObject({
      id: "act-new-0002",
      status: "queued",
      payload: { note: "act-new-0002" },
    });
    await h.connect();
    expect(h.posts.at(-1)?.message.context).toMatchObject({
      action: { id: "act-new-0002", status: "queued" },
    });
  });
});

describe("state", () => {
  it("state-set writes the hashed _state doc in the data store and connect loads it back", async () => {
    const h = harness({ manifest: manifest({ store: "page:films" }) });
    const port = await ready(h);
    port.emit({ type: "state-set", app: { k: 1 }, controls: [{ id: "c", value: "v" }] });
    port.emit({ type: "state-set", app: "x".repeat(70_000), controls: [] });
    port.emit({ type: "state-set", app: null, controls: "bad" });
    await flush();
    const docId = await snippetStateDocId(SID, "picker");
    const writes = h.daemon.requests.filter((r) => r.url.includes("/docs/_state/"));
    expect(writes.filter((r) => r.method === "POST")).toEqual([
      {
        method: "POST",
        url: `${PAGE}/docs/_state/${docId}`,
        body: {
          data: { instanceId: "inst-00000001", app: { k: 1 }, controls: [{ id: "c", value: "v" }] },
        },
      },
    ]);
    h.host.applyFile(manifest({ store: "page:films", revision: 2 }), "<html>2</html>");
    await h.connect();
    expect(h.posts.at(-1)?.message.context).toMatchObject({
      state: { k: 1 },
      controls: [{ id: "c", value: "v" }],
    });
    h.host.applyFile(
      manifest({ store: "page:films", instanceId: "inst-00000002" }),
      "<html>new</html>",
    );
    await h.connect();
    expect(h.posts.at(-1)?.message.context).toMatchObject({ state: null, controls: [] });
  });
});

describe("flood", () => {
  it("counts db and agent messages toward the flood limit", async () => {
    const h = harness();
    const port = await ready(h);
    for (let index = 0; index < 50; index += 1) {
      port.emit({ type: "db", callId: `d${index}`, method: "GET", path: "docs/items/a" });
      port.emit({ type: "agent", op: "status", callId: `a${index}` });
    }
    expect(h.host.getState().phase).toBe("connected");
    port.emit({ type: "db-subscribe" });
    expect(h.host.getState()).toMatchObject({ phase: "error", error: "flood" });
  });
});
