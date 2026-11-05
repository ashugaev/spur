import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSdkLoader,
  createSnippetHost,
  decideInvoke,
  decideSend,
} from "@/lib/snippets/snippet-host";
import { budgetKey, readSnippetBudget, recordKey } from "@/lib/snippets/snippet-store";
import {
  FakeDaemon,
  FakePoller,
  FakePort,
  flush,
  harness,
  manifest,
  MemoryStorage,
  ready,
  SID,
  THEME,
  type Harness,
} from "./fixtures/snippet-host-rig";

const sent = (h: Harness) => h.daemon.posts("/actions").length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("decideInvoke", () => {
  const base = {
    connected: true,
    conflict: false,
    manifest: manifest(),
    actionId: "go",
    payload: { note: "x" },
    canSend: true,
    busy: false,
    hasInteraction: true,
    gates: { ok: true as const, unconfirmedRevision: null, unconfirmed: 0 },
  };
  it("evaluates rejections in order", () => {
    expect(
      decideInvoke({ ...base, connected: false, conflict: true, actionId: "nope" }),
    ).toMatchObject({ reason: "not_connected" });
    expect(decideInvoke({ ...base, conflict: true, actionId: "nope" })).toMatchObject({
      reason: "stale",
    });
    expect(decideInvoke({ ...base, actionId: "nope", canSend: false })).toMatchObject({
      reason: "unknown_action",
    });
    expect(decideInvoke({ ...base, payload: { note: 1 }, canSend: false })).toMatchObject({
      reason: "invalid_payload",
    });
    expect(decideInvoke({ ...base, canSend: false, busy: true })).toMatchObject({
      reason: "session_unavailable",
    });
    expect(decideInvoke({ ...base, busy: true })).toMatchObject({ reason: "busy" });
  });
  it("rejects a payload over 48 KiB by UTF-8 bytes", () => {
    const wide = manifest({
      actions: [
        {
          id: "go",
          label: "Go",
          payload: { type: "object", properties: { note: { type: "string", maxLength: 20000 } } },
        },
      ],
    });
    expect(
      decideInvoke({ ...base, manifest: wide, payload: { note: "日".repeat(16_400) } }),
    ).toMatchObject({ reason: "payload_too_large" });
  });
  it("picks each confirm reason", () => {
    expect(decideInvoke({ ...base, actionId: "danger" })).toMatchObject({
      kind: "confirm",
      reason: "declared",
    });
    expect(decideInvoke({ ...base, hasInteraction: false })).toMatchObject({
      kind: "confirm",
      reason: "no_focus",
    });
    expect(decideInvoke({ ...base, gates: { ok: false } })).toMatchObject({
      kind: "confirm",
      reason: "storage_unavailable",
    });
    expect(
      decideInvoke({ ...base, gates: { ok: true, unconfirmedRevision: 1, unconfirmed: 1 } }),
    ).toMatchObject({ reason: "repeat_in_revision" });
    expect(
      decideInvoke({ ...base, gates: { ok: true, unconfirmedRevision: null, unconfirmed: 10 } }),
    ).toMatchObject({ reason: "budget" });
    expect(decideInvoke(base)).toMatchObject({ kind: "send", label: "Go" });
  });
  it("a trusted click skips the confirm gates but not structure or availability", () => {
    expect(
      decideInvoke({ ...base, trusted: true, hasInteraction: false, gates: { ok: false } }),
    ).toMatchObject({ kind: "send" });
    expect(decideInvoke({ ...base, trusted: true, canSend: false })).toMatchObject({
      reason: "session_unavailable",
    });
    expect(decideInvoke({ ...base, trusted: true, busy: true })).toMatchObject({ reason: "busy" });
  });
});

describe("decideSend", () => {
  const base = {
    connected: true,
    message: "hi",
    canSend: true,
    confirmPending: false,
    hasInteraction: true,
    gates: { ok: true as const, unconfirmedRevision: 1, unconfirmed: 0 },
  };
  it("rejects, confirms and sends like invoke, without the per-revision gate", () => {
    expect(decideSend({ ...base, connected: false })).toMatchObject({ reason: "not_connected" });
    expect(decideSend({ ...base, message: "  " })).toMatchObject({ reason: "invalid_payload" });
    expect(decideSend({ ...base, message: 5 })).toMatchObject({ reason: "invalid_payload" });
    expect(decideSend({ ...base, message: "日".repeat(16_400) })).toMatchObject({
      reason: "payload_too_large",
    });
    expect(decideSend({ ...base, canSend: false })).toMatchObject({
      reason: "session_unavailable",
    });
    expect(decideSend({ ...base, confirmPending: true })).toMatchObject({ reason: "busy" });
    expect(decideSend({ ...base, hasInteraction: false })).toMatchObject({
      kind: "confirm",
      reason: "no_focus",
    });
    expect(decideSend({ ...base, gates: { ok: false } })).toMatchObject({
      reason: "storage_unavailable",
    });
    expect(
      decideSend({ ...base, gates: { ok: true, unconfirmedRevision: null, unconfirmed: 10 } }),
    ).toMatchObject({ reason: "budget" });
    expect(decideSend(base)).toEqual({ kind: "send", message: "hi" });
  });
});

describe("handshake and teardown", () => {
  it("loads the SDK, then connects on the first matching hello with the port transferred", async () => {
    const h = harness();
    expect(h.host.getState().phase).toBe("loading");
    await flush();
    expect(h.host.getState().phase).toBe("connecting");
    h.host.onWindowMessage({ type: "spur:hello", protocolVersion: 2, nonce: "wrong" }, true);
    h.host.onWindowMessage(
      { type: "spur:hello", protocolVersion: 2, nonce: h.host.getState().nonce },
      false,
    );
    expect(h.posts).toHaveLength(0);
    await h.connect();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.message.type).toBe("spur:connect");
    expect(h.posts[0]?.transfer).toHaveLength(1);
    h.hello();
    await flush();
    expect(h.posts).toHaveLength(1);
    expect(h.host.getState().phase).toBe("connected");
  });

  it("connect context names both stores, the gate data and fonts when loaded", async () => {
    const h = harness();
    await flush();
    await h.connect();
    const context = h.posts[0]?.message.context as Record<string, unknown>;
    expect(context.fonts).toBeUndefined();
    expect(context).toMatchObject({
      dataStore: `session:${SID}`,
      agentStore: `session:${SID}`,
      snippetId: "picker",
      instanceId: "inst-00000001",
      revision: 1,
      previousRevision: null,
      state: null,
      controls: [],
      action: null,
      actions: [
        { id: "go", label: "Go" },
        { id: "danger", label: "Danger" },
      ],
    });
    const h2 = harness({ manifest: manifest({ store: "page:films" }) });
    await flush();
    h2.fonts.value = [{ family: "Spur Mono", weight: "400", data: new ArrayBuffer(4) }];
    await h2.connect();
    const context2 = h2.posts[0]?.message.context as Record<string, unknown>;
    expect(context2.fonts).toHaveLength(1);
    expect(context2).toMatchObject({ dataStore: "page:films", agentStore: `session:${SID}` });
  });

  it("errors with hello_timeout after 10 s without an accepted hello", async () => {
    const h = harness();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.host.getState()).toMatchObject({ phase: "error", error: "hello_timeout" });
  });

  it("shows hello_timeout when the SDK fetch fails, and Reload refetches the SDK", async () => {
    const bad = harness({ sdkFail: true });
    await flush();
    expect(bad.host.getState()).toMatchObject({
      phase: "error",
      error: "hello_timeout",
      sdkSource: null,
    });
    bad.sdk.fail = false;
    bad.host.reload(false);
    expect(bad.sdkLoads).toEqual([false]);
    bad.host.reload(true);
    expect(bad.sdkLoads).toEqual([false, true]);
    await flush();
    expect(bad.host.getState()).toMatchObject({ phase: "connecting", sdkSource: "sdk-source" });
  });

  it("the SDK loader aborts a stalled fetch after 10 s, caches success and refetches on demand", async () => {
    let calls = 0;
    const aborted: boolean[] = [];
    const load = createSdkLoader((_url, signal) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted.push(true);
            reject(new Error("aborted"));
          });
        });
      }
      return Promise.resolve(`sdk-${calls}`);
    });
    const outcome = load(false).then(
      () => "ok",
      () => "rejected",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toBe("rejected");
    expect(aborted).toEqual([true]);
    await expect(load(false)).resolves.toBe("sdk-2");
    await expect(load(false)).resolves.toBe("sdk-2");
    expect(calls).toBe(2);
    await expect(load(true)).resolves.toBe("sdk-3");
  });

  it("closes the port with navigated on a second iframe load and flood on the 101st message", async () => {
    const nav = harness();
    await ready(nav);
    nav.host.frameLoaded();
    expect(nav.host.getState().phase).toBe("connected");
    nav.host.frameLoaded();
    expect(nav.host.getState()).toMatchObject({ phase: "error", error: "navigated" });
    expect(nav.port().closed).toBe(true);

    const flood = harness();
    const port = await ready(flood);
    for (let i = 0; i < 100; i += 1) port.emit({ type: "resize", height: 200 });
    expect(flood.host.getState().phase).toBe("connected");
    port.emit({ type: "resize", height: 200 });
    expect(flood.host.getState()).toMatchObject({ phase: "error", error: "flood" });
    expect(port.closed).toBe(true);
  });

  it("drops port messages over 128 KiB in UTF-8 bytes", async () => {
    const h = harness();
    const port = await ready(h);
    port.emit({
      type: "invoke",
      callId: "big",
      action: "go",
      payload: { note: "日".repeat(44_000) },
    });
    await flush();
    expect(port.ofType("invoke-result")).toHaveLength(0);
    expect(sent(h)).toBe(0);
  });

  it("ignores malformed messages", async () => {
    const h = harness();
    const port = await ready(h);
    const cyclic: Record<string, unknown> = { type: "resize" };
    cyclic.self = cyclic;
    port.emit(cyclic);
    port.emit("junk");
    port.emit({ type: "unknown" });
    port.emit({ type: "state-load", callId: "x" });
    expect(h.host.getState().phase).toBe("connected");
  });

  it("clamps resize to 120..800 and applies only changes", async () => {
    const h = harness();
    const port = await ready(h);
    port.emit({ type: "resize", height: 40.2 });
    expect(h.host.getState().height).toBe(120);
    port.emit({ type: "resize", height: 5000 });
    expect(h.host.getState().height).toBe(800);
    port.emit({ type: "resize", height: 300.1 });
    expect(h.host.getState().height).toBe(301);
  });

  it("Reload after navigated opens a new channel with a new nonce, zero sends, gates untouched", async () => {
    const h = harness();
    await ready(h);
    h.invoke("go", { note: "a" });
    await flush();
    const before = [
      h.storage.data.get(recordKey(SID, "picker")),
      h.storage.data.get(budgetKey(SID)),
    ];
    expect(sent(h)).toBe(1);
    h.host.frameLoaded();
    h.host.frameLoaded();
    const nonce = h.host.getState().nonce;
    h.host.reload(false);
    expect(h.host.getState().phase).toBe("error");
    h.host.reload(true);
    expect(h.host.getState().phase).toBe("connecting");
    expect(h.host.getState().nonce).not.toBe(nonce);
    await h.connect();
    expect(h.ports).toHaveLength(2);
    expect(sent(h)).toBe(1);
    expect([
      h.storage.data.get(recordKey(SID, "picker")),
      h.storage.data.get(budgetKey(SID)),
    ]).toEqual(before);
  });

  it("a protocol 1 hello fails with protocol and offers no Reload", async () => {
    const h = harness();
    await flush();
    h.hello(undefined, 1);
    expect(h.host.getState()).toMatchObject({ phase: "error", error: "protocol" });
    h.host.reload(true);
    expect(h.host.getState().phase).toBe("error");
    expect(h.ports).toHaveLength(0);
  });

  it("fails with protocol, without connecting, when the state doc id cannot be hashed", async () => {
    vi.stubGlobal("crypto", { subtle: undefined });
    try {
      const h = harness();
      await flush();
      h.hello();
      await flush();
      expect(h.host.getState()).toMatchObject({ phase: "error", error: "protocol" });
      expect(h.posts).toHaveLength(0);
      expect(h.ports).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("agent events", () => {
  it("connects with the agent status and posts agent-event only when the mapped state changes", async () => {
    const h = harness();
    h.host.updateSession({ canSend: true, state: "waiting" });
    const port = await ready(h);
    expect(h.posts[0]?.message.context).toMatchObject({
      agentStatus: { state: "idle", sessionId: SID },
    });
    const events = () => port.toFrame.filter((message) => message.type === "agent-event");
    h.host.updateSession({ canSend: true, state: "needs_input" });
    expect(events()).toHaveLength(0);
    h.host.updateSession({ canSend: true, state: "working" });
    h.host.updateSession({ canSend: true, state: "working" });
    h.host.updateSession({ canSend: false, state: "waiting", status: "budget_limited" });
    h.host.updateSession({ canSend: false, state: "killed", status: "killed" });
    expect(events().map((message) => message.status)).toEqual([
      { state: "working", sessionId: SID },
      { state: "rate_limited", sessionId: SID },
      { state: "error", sessionId: SID },
    ]);
  });

  it.each(["completed", "killed", "errored"] as const)(
    "maps a %s session to error whatever its state",
    async (status) => {
      const h = harness();
      h.host.updateSession({ canSend: true, state: "waiting", status: "running" });
      const port = await ready(h);
      h.host.updateSession({ canSend: false, state: "waiting", status });
      expect(port.toFrame.filter((message) => message.type === "agent-event")).toEqual([
        expect.objectContaining({ status: { state: "error", sessionId: SID } }),
      ]);
    },
  );
});

describe("rejections send nothing", () => {
  it("returns typed results with zero sends", async () => {
    const h = harness();
    const port = await ready(h);
    const cases: Array<[string, unknown, string]> = [
      ["nope", {}, "unknown_action"],
      ["go", { note: 5 }, "invalid_payload"],
      ["go", { note: "a", x: 1 }, "invalid_payload"],
    ];
    for (const [action, payload, reason] of cases) {
      const callId = h.invoke(action, payload);
      expect(port.reply("invoke-result", callId)).toMatchObject({ ok: false, reason });
    }
    const invalid = h.invoke("go", { note: 5 });
    expect(port.reply("invoke-result", invalid)?.issues).toEqual([{ path: "/note", code: "type" }]);
    expect(sent(h)).toBe(0);
  });

  it("session_unavailable posts availability and rejects", async () => {
    const h = harness();
    const port = await ready(h);
    h.session({ canSend: false });
    expect(port.ofType("availability")[0]?.availability).toEqual({
      canInvoke: false,
      reason: "session_unavailable",
    });
    const callId = h.invoke("go", { note: "a" });
    expect(port.reply("invoke-result", callId)).toMatchObject({
      ok: false,
      reason: "session_unavailable",
    });
    h.session({ canSend: true });
    expect(port.ofType("availability")).toHaveLength(2);
    expect(sent(h)).toBe(0);
  });

  it("busy while an action is in flight", async () => {
    const h = harness();
    const port = await ready(h);
    h.invoke("go", { note: "a" });
    await flush();
    const second = h.invoke("go", { note: "b" });
    expect(port.reply("invoke-result", second)).toMatchObject({ ok: false, reason: "busy" });
    expect(sent(h)).toBe(1);
  });

  it("not_connected after teardown", async () => {
    const h = harness();
    const port = await ready(h);
    h.host.frameLoaded();
    h.host.frameLoaded();
    port.emit({ type: "invoke", callId: "x", action: "go", payload: { note: "a" } });
    await flush();
    expect(sent(h)).toBe(0);
  });
});

describe("gates", () => {
  it("no focus signal asks for confirm, zero sends", async () => {
    const h = harness();
    await flush();
    await h.connect();
    h.invoke("go", { note: "a" }, "c1");
    await flush();
    expect(sent(h)).toBe(0);
    expect(h.host.getState().confirm).toMatchObject({ reason: "no_focus", actionId: "go" });
    expect(h.host.getState().action?.status).toBe("awaiting_confirm");
    expect(h.port().ofType("invoke-result")).toHaveLength(0);
  });

  it("passes by the blur path and by the hasFocus path", async () => {
    const blur = harness();
    await flush();
    await blur.connect();
    blur.host.noteFrameFocus();
    blur.invoke("go", { note: "a" });
    await flush();
    expect(sent(blur)).toBe(1);

    const focus = harness();
    await ready(focus);
    focus.invoke("go", { note: "a" });
    await flush();
    expect(sent(focus)).toBe(1);
  });

  it("the blur flag resets with each mounted document", async () => {
    const h = harness();
    await flush();
    await h.connect();
    h.host.noteFrameFocus();
    h.host.applyFile(manifest({ revision: 2 }), "<html>b</html>");
    await h.connect();
    h.invoke("go", { note: "a" });
    expect(h.host.getState().confirm?.reason).toBe("no_focus");
    expect(sent(h)).toBe(0);
  });

  it("second unconfirmed invoke on one revision needs confirm, also after a controller re-create", async () => {
    const h = harness();
    await ready(h);
    h.invoke("go", { note: "a" });
    await flush();
    const id = h.host.getState().action?.id ?? "";
    h.daemon.complete(id, { status: "done", result: { ok: 1 } });
    (h.poller as FakePoller).emit(`session:${SID}`, {
      type: "changes",
      changes: [{ seq: 1, collection: "_actions", id, op: "set", rev: 2 }],
    });
    await flush();
    expect(h.host.getState().action?.status).toBe("completed");
    h.invoke("go", { note: "b" }, "c9");
    expect(h.host.getState().confirm?.reason).toBe("repeat_in_revision");
    expect(sent(h)).toBe(1);
    const again = h.remount();
    await ready(again);
    again.invoke("go", { note: "c" }, "c10");
    expect(again.host.getState().confirm?.reason).toBe("repeat_in_revision");
    expect(sent(again)).toBe(1);
  });

  it("the 11th consecutive unconfirmed send needs confirm, also after controller re-create", async () => {
    const storage = new MemoryStorage();
    let h = harness({ storage });
    await ready(h);
    for (let revision = 1; revision <= 10; revision += 1) {
      if (revision > 1) {
        h.host.applyFile(manifest({ revision }), `<html>${revision}</html>`);
        await h.connect();
      }
      h.invoke("go", { note: "a" });
      await flush();
      const id = h.host.getState().action?.id ?? "";
      h.daemon.complete(id, { status: "done" });
      (h.poller as FakePoller).emit(`session:${SID}`, { type: "reset" });
      await flush();
    }
    expect(sent(h)).toBe(10);
    h.host.applyFile(manifest({ revision: 11 }), "<html>11</html>");
    await h.connect();
    h.invoke("go", { note: "a" }, "c11");
    expect(h.host.getState().confirm?.reason).toBe("budget");
    expect(sent(h)).toBe(10);

    h = harness({ storage, manifest: manifest({ revision: 12 }) });
    await ready(h);
    h.invoke("go", { note: "a" }, "c12");
    expect(h.host.getState().confirm?.reason).toBe("budget");
    expect(sent(h)).toBe(0);
  });

  it("budget resets only on a trusted confirm click, never by time", async () => {
    const h = harness();
    await ready(h);
    h.invoke("go", { note: "a" });
    await flush();
    expect(readSnippetBudget(h.storage, SID)).toMatchObject({ value: { unconfirmed: 1 } });
    await vi.advanceTimersByTimeAsync(10 * 24 * 60 * 60 * 1000);
    expect(readSnippetBudget(h.storage, SID)).toMatchObject({ value: { unconfirmed: 1 } });
    h.daemon.complete(h.host.getState().action?.id ?? "", { status: "done" });
    (h.poller as FakePoller).emit(`session:${SID}`, { type: "reset" });
    await flush();
    h.focused.value = false;
    h.host.applyFile(manifest({ revision: 2 }), "<html>2</html>");
    await h.connect();
    h.invoke("go", { note: "b" });
    expect(h.host.getState().confirm?.reason).toBe("no_focus");
    h.host.confirmSend(false);
    expect(h.host.getState().confirm).not.toBeNull();
    expect(readSnippetBudget(h.storage, SID)).toMatchObject({ value: { unconfirmed: 1 } });
    h.host.confirmSend(true);
    await flush();
    expect(sent(h)).toBe(2);
    expect(readSnippetBudget(h.storage, SID)).toMatchObject({ value: { unconfirmed: 0 } });
  });

  it("Discard resolves declined with zero sends and restores the previous action", async () => {
    const h = harness();
    await flush();
    await h.connect();
    h.invoke("go", { note: "a" }, "c1");
    h.host.confirmDiscard(false);
    expect(h.host.getState().confirm).not.toBeNull();
    h.host.confirmDiscard(true);
    expect(h.port().reply("invoke-result", "c1")).toMatchObject({ ok: false, reason: "declined" });
    expect(h.host.getState()).toMatchObject({ confirm: null, action: null });
    expect(sent(h)).toBe(0);
  });

  it("trusted Send dispatches once; the snippet's promise waits for the final status", async () => {
    const h = harness();
    await flush();
    await h.connect();
    h.invoke("go", { note: "a" }, "c1");
    h.host.confirmSend(true);
    await flush();
    expect(sent(h)).toBe(1);
    expect(h.host.getState().action).toMatchObject({ status: "queued", confirmReason: "no_focus" });
    expect(h.port().reply("invoke-result", "c1")).toBeUndefined();
    h.host.confirmSend(true);
    await flush();
    expect(sent(h)).toBe(1);
  });

  it("a declared confirm action asks even with focus", async () => {
    const h = harness();
    await ready(h);
    h.invoke("danger", { note: "a" });
    expect(h.host.getState().confirm?.reason).toBe("declared");
    expect(sent(h)).toBe(0);
  });

  it("revision replaced or dispose while awaiting confirm resolves stale", async () => {
    const h = harness();
    await flush();
    const port = await h.connect();
    h.invoke("go", { note: "a" }, "c1");
    h.host.applyFile(manifest({ revision: 2 }), "<html>2</html>");
    expect(port.reply("invoke-result", "c1")).toMatchObject({ ok: false, reason: "stale" });
    expect(h.host.getState().confirm).toBeNull();

    const d = harness();
    await flush();
    const dPort = await d.connect();
    d.invoke("go", { note: "a" }, "c2");
    d.host.dispose();
    expect(dPort.reply("invoke-result", "c2")).toMatchObject({ reason: "stale" });
    expect(sent(h) + sent(d)).toBe(0);
  });

  it("storage failure routes every invoke to confirm", async () => {
    const h = harness();
    await ready(h);
    h.storage.failGet = true;
    h.invoke("go", { note: "a" }, "c1");
    expect(h.host.getState().confirm?.reason).toBe("storage_unavailable");
    const second = harness();
    await ready(second);
    second.storage.failSet = (key) => key.startsWith("spur:snippet-budget");
    second.invoke("go", { note: "a" }, "c2");
    expect(second.host.getState().confirm?.reason).toBe("storage_unavailable");
    const third = harness();
    await ready(third);
    third.storage.failSet = (key) => key.startsWith("spur:snippet:v2");
    third.invoke("go", { note: "a" }, "c3");
    expect(third.host.getState().confirm?.reason).toBe("storage_unavailable");
    await flush();
    expect(sent(h) + sent(second) + sent(third)).toBe(0);
  });
});

describe("file changes", () => {
  it("an equal-revision text change posts one availability revision_conflict and rejects invokes; a higher revision restores", async () => {
    const h = harness();
    const port = await ready(h);
    expect(h.host.applyFile(manifest(), "<html>a</html>")).toBe("ignored");
    expect(h.host.applyFile(manifest(), "<html>CHANGED</html>")).toBe("conflict");
    expect(h.host.applyFile(manifest(), "<html>CHANGED2</html>")).toBe("conflict");
    expect(port.ofType("availability")).toHaveLength(1);
    expect(port.ofType("availability")[0]?.availability).toEqual({
      canInvoke: false,
      reason: "revision_conflict",
    });
    const callId = h.invoke("go", { note: "a" });
    expect(port.reply("invoke-result", callId)).toMatchObject({ ok: false, reason: "stale" });
    expect(h.host.getState().html).toBe("<html>a</html>");
    expect(h.host.applyFile(manifest({ revision: 2 }), "<html>2</html>")).toBe("mounted");
    expect(h.host.getState()).toMatchObject({ conflict: false, availability: { canInvoke: true } });
    expect(sent(h)).toBe(0);
  });

  it("refuses a lower revision; previousRevision tracks the instance", async () => {
    const h = harness({ manifest: manifest({ revision: 3 }) });
    await ready(h);
    expect(h.host.applyFile(manifest({ revision: 2 }), "<html>old</html>")).toBe("lower_revision");
    expect(h.host.getState().manifest.revision).toBe(3);
    h.host.applyFile(manifest({ revision: 4 }), "<html>4</html>");
    await h.connect();
    expect(h.posts.at(-1)?.message.context).toMatchObject({ previousRevision: 3 });
    h.host.applyFile(manifest({ instanceId: "inst-00000002", revision: 1 }), "<html>new</html>");
    await h.connect();
    expect(h.posts.at(-1)?.message.context).toMatchObject({ previousRevision: null });
  });

  it("fullscreen request needs the interaction signal; escape exits", async () => {
    const h = harness();
    await flush();
    const port = await h.connect();
    port.emit({ type: "fullscreen", callId: "f1", open: true });
    expect(h.fullscreenRequests).toEqual([]);
    expect(port.ofType("fullscreen")[0]).toMatchObject({ callId: "f1", granted: false });
    h.host.noteFrameFocus();
    port.emit({ type: "fullscreen", callId: "f2", open: true });
    expect(h.fullscreenRequests).toEqual([true]);
    expect(port.ofType("fullscreen")[1]).toMatchObject({ callId: "f2", granted: true });
    h.host.setFullscreen(true);
    port.emit({ type: "escape" });
    expect(h.fullscreenRequests).toEqual([true, false]);
  });
});

describe("agent loop bound", () => {
  async function loop(focus: boolean): Promise<number> {
    const h = harness();
    await flush();
    h.focused.value = focus;
    await h.connect();
    h.invoke("go", { note: "auto" });
    await flush();
    for (let revision = 2; revision <= 51; revision += 1) {
      const id = h.host.getState().action?.id;
      if (id && h.daemon.actions.has(id)) {
        h.daemon.complete(id, { status: "done" });
        (h.poller as FakePoller).emit(`session:${SID}`, { type: "reset" });
        await flush();
      }
      h.host.applyFile(manifest({ revision }), `<html>${revision}</html>`);
      await h.connect();
      h.invoke("go", { note: "auto" });
      await flush();
    }
    return sent(h);
  }
  it("sends nothing across 50 agent revisions when no focus signal exists", async () => {
    expect(await loop(false)).toBe(0);
  });
  it("sends at most 10 with focus forced true", async () => {
    expect(await loop(true)).toBe(10);
  });
});

describe("pending confirm is voided with its document and session state", () => {
  async function pending(h: Harness): Promise<FakePort> {
    await flush();
    const port = await h.connect();
    h.invoke("go", { note: "a" }, "c1");
    expect(h.host.getState().confirm?.reason).toBe("no_focus");
    return port;
  }

  it("a session stop drops the strip as stale and a Send click posts nothing", async () => {
    const h = harness();
    const port = await pending(h);
    h.session({ canSend: false });
    expect(h.host.getState().confirm).toBeNull();
    expect(port.reply("invoke-result", "c1")).toMatchObject({ ok: false, reason: "stale" });
    h.host.confirmSend(true);
    await flush();
    expect(sent(h)).toBe(0);
  });

  it("flood and navigated drop the strip; Reload does not bring it back", async () => {
    for (const cause of ["flood", "navigated"] as const) {
      const h = harness();
      const port = await pending(h);
      if (cause === "flood")
        for (let i = 0; i < 101; i += 1) port.emit({ type: "resize", height: 200 });
      else {
        h.host.frameLoaded();
        h.host.frameLoaded();
      }
      expect(h.host.getState()).toMatchObject({ phase: "error", error: cause, confirm: null });
      expect(h.host.getState().action).toBeNull();
      h.host.reload(true);
      await h.connect();
      expect(h.host.getState().confirm).toBeNull();
      h.host.confirmSend(true);
      await flush();
      expect(sent(h)).toBe(0);
    }
  });
});

describe("fullscreen, theme and focus on the controller", () => {
  it("an error while fullscreen runs the exit path and clears the flag", async () => {
    const h = harness();
    await ready(h);
    h.host.setFullscreen(true);
    h.host.frameLoaded();
    h.host.frameLoaded();
    expect(h.fullscreenRequests).toEqual([false]);
    expect(h.host.getState()).toMatchObject({ phase: "error", fullscreen: false });
    h.host.reload(true);
    h.host.setFullscreen(true);
    expect(h.host.getState().fullscreen).toBe(true);
  });

  it("themeChanged posts the current theme to a connected snippet only", async () => {
    const h = harness();
    h.host.themeChanged();
    await flush();
    h.host.themeChanged();
    const port = await h.connect();
    h.host.themeChanged();
    expect(port.ofType("theme")).toEqual([{ type: "theme", theme: THEME }]);
  });

  it("a window blur before connect does not count toward the interaction gate", async () => {
    const h = harness();
    await flush();
    h.host.noteFrameFocus();
    await h.connect();
    h.invoke("go", { note: "a" }, "c1");
    expect(h.host.getState().confirm?.reason).toBe("no_focus");
  });

  it("a retry with no retryable action is refused as stale", async () => {
    const h = harness();
    const port = await ready(h);
    port.emit({ type: "invoke", callId: "r", action: "go", retry: true });
    await flush();
    expect(port.reply("invoke-result", "r")).toMatchObject({ ok: false, reason: "stale" });
  });
});

describe("SDK load failure while fullscreen", () => {
  it("routes through fail(): the exit path runs and the flag clears", async () => {
    let rejectSdk: (error: Error) => void = () => undefined;
    const fullscreen: boolean[] = [];
    const daemon = new FakeDaemon();
    const host = createSnippetHost(
      {
        sessionId: SID,
        postToFrame: () => undefined,
        createChannel: () => ({ hostPort: new FakePort(), framePort: {} }),
        request: (method, url, body) => daemon.handle(method, url, body),
        poller: new FakePoller(),
        loadSdk: () => new Promise<string>((_resolve, reject) => (rejectSdk = reject)),
        getFonts: () => [],
        getTheme: () => THEME,
        storage: new MemoryStorage(),
        now: () => Date.now(),
        uuid: () => "req-00000001",
        nonce: () => "nonce-x",
        isFrameFocused: () => false,
        onFullscreenRequest: (open) => fullscreen.push(open),
      },
      { manifest: manifest(), html: "<html>a</html>" },
    );
    host.setFullscreen(true);
    rejectSdk(new Error("sdk"));
    await flush();
    expect(host.getState()).toMatchObject({
      phase: "error",
      error: "hello_timeout",
      fullscreen: false,
    });
    expect(fullscreen).toEqual([false]);
  });
});
