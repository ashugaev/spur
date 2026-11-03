import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSdkLoader,
  createSnippetHost,
  decideInvoke,
  type SnippetChannel,
  type SnippetFontBuffer,
  type SnippetHost,
  type SnippetHostDeps,
  type SnippetPort,
  type SnippetSessionUpdate,
} from "@/lib/snippets/snippet-host";
import type { SnippetManifest } from "@/lib/snippets/snippet-manifest";
import type { SnippetSendOutcome, SnippetTheme } from "@/lib/snippets/snippet-protocol";
import {
  budgetKey,
  readSnippetBudget,
  readSnippetRecord,
  recordKey,
  type SnippetStorage,
} from "@/lib/snippets/snippet-store";

class MemoryStorage implements SnippetStorage {
  data = new Map<string, string>();
  failSet: (key: string) => boolean = () => false;
  failGet = false;
  get length(): number {
    return this.data.size;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.failGet) throw new Error("denied");
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failSet(key)) throw new DOMException("full", "QuotaExceededError");
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

class FakePort implements SnippetPort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  toFrame: Array<Record<string, unknown>> = [];
  closed = false;
  postMessage(message: unknown): void {
    this.toFrame.push(message as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.toFrame.filter((message) => message.type === type);
  }
}

const SID = "sp-ab12";
const THEME = { mode: "dark", tokens: {} } as unknown as SnippetTheme;
const notePayload = {
  type: "object",
  properties: { note: { type: "string", maxLength: 50 } },
} as const;

function manifest(overrides: Partial<SnippetManifest> = {}): SnippetManifest {
  return {
    protocolVersion: 1,
    snippetId: "picker",
    ownerSessionId: SID,
    instanceId: "inst-00000001",
    revision: 1,
    title: "Picker",
    actions: [
      { id: "go", label: "Go", payload: notePayload },
      { id: "danger", label: "Danger", payload: notePayload, confirm: "always" },
    ],
    ...overrides,
  };
}

interface Harness {
  host: SnippetHost;
  storage: MemoryStorage;
  sent: string[];
  ports: FakePort[];
  posts: Array<{ message: Record<string, unknown>; transfer: unknown[] }>;
  focused: { value: boolean };
  sendOutcome: { value: () => Promise<SnippetSendOutcome> };
  sdkLoads: boolean[];
  sdk: { fail: boolean };
  fonts: { value: SnippetFontBuffer[] };
  fullscreenRequests: boolean[];
  port(): FakePort;
  hello(nonce?: string): void;
  connect(): FakePort;
  invoke(actionId: string, payload: unknown, callId?: string): Record<string, unknown> | undefined;
  session(update?: Partial<SnippetSessionUpdate>): void;
  remount(m?: SnippetManifest): Harness;
}

let counter = 0;

function harness(
  opts: {
    storage?: MemoryStorage;
    manifest?: SnippetManifest;
    html?: string;
    sdkFail?: boolean;
  } = {},
): Harness {
  const storage = opts.storage ?? new MemoryStorage();
  const sent: string[] = [];
  const ports: FakePort[] = [];
  const posts: Harness["posts"] = [];
  const focused = { value: false };
  const sendOutcome = {
    value: (): Promise<SnippetSendOutcome> => Promise.resolve({ kind: "response", status: 200 }),
  };
  const sdkLoads: boolean[] = [];
  const sdk = { fail: opts.sdkFail ?? false };
  const fonts: { value: SnippetFontBuffer[] } = { value: [] };
  const fullscreenRequests: boolean[] = [];
  const deps: SnippetHostDeps = {
    sessionId: SID,
    postToFrame: (message, transfer) =>
      posts.push({ message: message as Record<string, unknown>, transfer }),
    createChannel: (): SnippetChannel => {
      const hostPort = new FakePort();
      ports.push(hostPort);
      return { hostPort, framePort: { port: ports.length } };
    },
    send: (prompt) => {
      sent.push(prompt);
      return sendOutcome.value();
    },
    loadSdk: (refetch) => {
      sdkLoads.push(refetch);
      return sdk.fail ? Promise.reject(new Error("sdk")) : Promise.resolve("sdk-source");
    },
    getFonts: () => fonts.value,
    getTheme: () => THEME,
    storage,
    now: () => Date.now(),
    uuid: () => `req-${String((counter += 1)).padStart(8, "0")}`,
    nonce: () => `nonce-${(counter += 1)}`,
    isFrameFocused: () => focused.value,
    onFullscreenRequest: (open) => fullscreenRequests.push(open),
  };
  const host = createSnippetHost(deps, {
    manifest: opts.manifest ?? manifest(),
    html: opts.html ?? "<html>a</html>",
  });
  const h: Harness = {
    host,
    storage,
    sent,
    ports,
    posts,
    focused,
    sendOutcome,
    sdkLoads,
    sdk,
    fonts,
    fullscreenRequests,
    port: () => ports[ports.length - 1]!,
    hello: (nonce) =>
      host.onWindowMessage(
        { type: "spur:hello", protocolVersion: 1, nonce: nonce ?? host.getState().nonce },
        true,
      ),
    connect: () => {
      h.hello();
      return h.port();
    },
    invoke: (actionId, payload, callId = `c${(counter += 1)}`) => {
      const port = h.port();
      port.emit({ type: "invoke", callId, actionId, payload });
      return port.ofType("invoke-result").find((message) => message.callId === callId);
    },
    session: (update = {}) =>
      host.updateSession({
        canSend: true,
        state: "working",
        queuedMessages: [],
        messages: [],
        fileSettled: true,
        ...update,
      }),
    remount: (m) => harness({ storage, ...(m ? { manifest: m } : {}) }),
  };
  return h;
}

async function ready(h: Harness): Promise<FakePort> {
  await vi.advanceTimersByTimeAsync(0);
  h.focused.value = true;
  return h.connect();
}

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
    sessionId: SID,
    actionId: "go",
    payload: { note: "x" },
    canSend: true,
    busy: false,
    hasInteraction: true,
    gates: { ok: true as const, unconfirmedRevision: null, unconfirmed: 0 },
    requestId: "req-00000001",
  };
  it("evaluates rejections in D4 order", () => {
    expect(
      decideInvoke({ ...base, connected: false, conflict: true, actionId: "nope" }),
    ).toMatchObject({ reason: "not_connected" });
    expect(decideInvoke({ ...base, conflict: true, actionId: "nope" })).toMatchObject({
      reason: "revision_conflict",
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
    ).toMatchObject({
      reason: "payload_too_large",
    });
  });
  it("rejects when the built prompt passes 64 KiB although the payload fits", () => {
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
      decideInvoke({
        ...base,
        manifest: wide,
        payload: { a: 1 },
      }),
    ).toMatchObject({ reason: "invalid_payload" });
    const manyQuotes = {
      type: "object",
      properties: {
        a: { type: "string", maxLength: 20000 },
        b: { type: "string", maxLength: 20000 },
        c: { type: "string", maxLength: 20000 },
      },
    } as const;
    const m = manifest({ actions: [{ id: "go", label: "Go", payload: manyQuotes }] });
    const q = '"'.repeat(7000);
    expect(decideInvoke({ ...base, manifest: m, payload: { a: q, b: q, c: q } })).toMatchObject({
      reason: "payload_too_large",
    });
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
    expect(decideInvoke(base)).toMatchObject({ kind: "send" });
    expect(
      decideInvoke({ ...base, gates: { ok: true, unconfirmedRevision: 0, unconfirmed: 9 } }),
    ).toMatchObject({ kind: "send" });
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

describe("handshake and teardown", () => {
  it("loads the SDK, then connects on the first matching hello with the port transferred", async () => {
    const h = harness();
    expect(h.host.getState().phase).toBe("loading");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.host.getState().phase).toBe("connecting");
    h.host.onWindowMessage({ type: "spur:hello", protocolVersion: 1, nonce: "wrong" }, true);
    h.host.onWindowMessage(
      { type: "spur:hello", protocolVersion: 1, nonce: h.host.getState().nonce },
      false,
    );
    expect(h.posts).toHaveLength(0);
    h.hello();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.message.type).toBe("spur:connect");
    expect(h.posts[0]?.transfer).toHaveLength(1);
    h.hello();
    expect(h.posts).toHaveLength(1);
    expect(h.host.getState().phase).toBe("connected");
  });

  it("connects without fonts while the font fetch is pending", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.fonts.value = [];
    h.hello();
    const context = h.posts[0]?.message.context as Record<string, unknown>;
    expect(context.fonts).toBeUndefined();
    expect(context).toMatchObject({
      previousRevision: null,
      actions: [
        { id: "go", label: "Go" },
        { id: "danger", label: "Danger" },
      ],
    });
    const h2 = harness();
    await vi.advanceTimersByTimeAsync(0);
    h2.fonts.value = [{ family: "Spur Mono", weight: "400", data: new ArrayBuffer(4) }];
    h2.hello();
    expect((h2.posts[0]?.message.context as Record<string, unknown>).fonts).toHaveLength(1);
  });

  it("errors with hello_timeout after 10 s without an accepted hello", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.host.getState()).toMatchObject({ phase: "error", error: "hello_timeout" });
  });

  it("shows hello_timeout when the SDK fetch fails, and Reload refetches the SDK", async () => {
    const bad = harness({ sdkFail: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(bad.host.getState()).toMatchObject({
      phase: "error",
      error: "hello_timeout",
      sdkSource: null,
    });
    expect(bad.host.getState().phase).not.toBe("connecting");
    bad.sdk.fail = false;
    bad.host.reload(false);
    expect(bad.sdkLoads).toEqual([false]);
    bad.host.reload(true);
    expect(bad.sdkLoads).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(0);
    expect(bad.host.getState()).toMatchObject({ phase: "connecting", sdkSource: "sdk-source" });
    expect(bad.sent).toHaveLength(0);
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
    const stalled = load(false);
    const outcome = stalled.then(
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

  it("drops port messages over 128 KiB in UTF-8 bytes and counts them toward flood", async () => {
    const h = harness();
    const port = await ready(h);
    port.emit({
      type: "invoke",
      callId: "big",
      actionId: "go",
      payload: { note: "日".repeat(44_000) },
    });
    expect(port.ofType("invoke-result")).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it("counts unserializable messages and ignores malformed ones", async () => {
    const h = harness();
    const port = await ready(h);
    const cyclic: Record<string, unknown> = { type: "resize" };
    cyclic.self = cyclic;
    port.emit(cyclic);
    port.emit("junk");
    port.emit({ type: "unknown" });
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

  it("Reload on hello_timeout, navigated and flood opens a new channel with a new nonce, zero sends, gates untouched", async () => {
    const h = harness();
    await ready(h);
    h.invoke("go", { note: "a" });
    const before = [
      h.storage.data.get(recordKey(SID, "picker")),
      h.storage.data.get(budgetKey(SID)),
    ];
    expect(h.sent).toHaveLength(1);
    h.host.frameLoaded();
    h.host.frameLoaded();
    const nonce = h.host.getState().nonce;
    h.host.reload(false);
    expect(h.host.getState().phase).toBe("error");
    h.host.reload(true);
    expect(h.host.getState().phase).toBe("connecting");
    expect(h.host.getState().nonce).not.toBe(nonce);
    h.hello();
    expect(h.ports).toHaveLength(2);
    expect(h.sent).toHaveLength(1);
    const after = [
      h.storage.data.get(recordKey(SID, "picker")),
      h.storage.data.get(budgetKey(SID)),
    ];
    expect(JSON.parse(after[1] ?? "{}").unconfirmed).toBe(
      JSON.parse(before[1] ?? "{}").unconfirmed,
    );
    expect(JSON.parse(after[0] ?? "{}").unconfirmedRevision).toBe(
      JSON.parse(before[0] ?? "{}").unconfirmedRevision,
    );
  });

  it("does not offer Reload on a protocol mismatch", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.host.onWindowMessage(
      { type: "spur:hello", protocolVersion: 9, nonce: h.host.getState().nonce },
      true,
    );
    expect(h.host.getState()).toMatchObject({ phase: "error", error: "protocol" });
    h.host.reload(true);
    expect(h.host.getState().phase).toBe("error");
    expect(h.ports).toHaveLength(0);
  });
});

describe("rejections send nothing", () => {
  it("returns typed results with zero sends", async () => {
    const h = harness();
    // not connected
    expect(h.host.getState().phase).toBe("loading");
    await ready(h);
    const cases: Array<[string, string, unknown, string]> = [
      ["unknown", "nope", {}, "unknown_action"],
      ["invalid", "go", { note: 5 }, "invalid_payload"],
      ["extra", "go", { note: "a", x: 1 }, "invalid_payload"],
    ];
    for (const [, actionId, payload, reason] of cases) {
      expect(h.invoke(actionId, payload)).toMatchObject({ ok: false, reason });
    }
    const invalid = h.invoke("go", { note: 5 });
    expect(invalid?.issues).toEqual([{ path: "/note", code: "type" }]);
    expect(h.sent).toHaveLength(0);
  });

  it("session_unavailable posts availability and rejects", async () => {
    const h = harness();
    const port = await ready(h);
    h.session({ canSend: false });
    expect(port.ofType("availability")).toHaveLength(1);
    expect(port.ofType("availability")[0]?.availability).toEqual({
      canInvoke: false,
      reason: "session_unavailable",
    });
    expect(h.invoke("go", { note: "a" })).toMatchObject({
      ok: false,
      reason: "session_unavailable",
    });
    h.session({ canSend: true });
    expect(port.ofType("availability")).toHaveLength(2);
    expect(h.sent).toHaveLength(0);
  });

  it("busy while an action is in flight or a confirm is pending", async () => {
    const h = harness();
    await ready(h);
    expect(h.invoke("go", { note: "a" })).toMatchObject({ ok: true });
    expect(h.invoke("go", { note: "b" })).toMatchObject({ ok: false, reason: "busy" });
    expect(h.sent).toHaveLength(1);
  });

  it("not_connected after teardown", async () => {
    const h = harness();
    const port = await ready(h);
    h.host.frameLoaded();
    h.host.frameLoaded();
    port.emit({ type: "invoke", callId: "x", actionId: "go", payload: { note: "a" } });
    expect(h.sent).toHaveLength(0);
  });
});

describe("gates", () => {
  it("G2: no focus signal asks for confirm, zero sends", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.connect();
    h.invoke("go", { note: "a" }, "c1");
    expect(h.sent).toHaveLength(0);
    expect(h.host.getState().confirm).toMatchObject({ reason: "no_focus", actionId: "go" });
    expect(h.host.getState().action?.status).toBe("awaiting_confirm");
    expect(h.port().ofType("invoke-result")).toHaveLength(0);
  });

  it("G2 passes by the blur path and by the hasFocus path", async () => {
    const blur = harness();
    await vi.advanceTimersByTimeAsync(0);
    blur.connect();
    blur.host.noteFrameFocus();
    expect(blur.invoke("go", { note: "a" })).toMatchObject({ ok: true });
    expect(blur.sent).toHaveLength(1);

    const focus = harness();
    await ready(focus);
    expect(focus.invoke("go", { note: "a" })).toMatchObject({ ok: true });
    expect(focus.sent).toHaveLength(1);
  });

  it("G2 blur flag resets with each mounted document", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.connect();
    h.host.noteFrameFocus();
    h.host.applyFile(manifest({ revision: 2 }), "<html>b</html>");
    h.connect();
    h.invoke("go", { note: "a" });
    expect(h.host.getState().confirm?.reason).toBe("no_focus");
    expect(h.sent).toHaveLength(0);
  });

  it("G3: second unconfirmed invoke on one revision needs confirm, also after the first finishes", async () => {
    const h = harness();
    h.sendOutcome.value = () => Promise.resolve({ kind: "response", status: 409 });
    await ready(h);
    h.invoke("go", { note: "a" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.host.getState().action?.status).toBe("error");
    h.invoke("go", { note: "b" }, "c9");
    expect(h.host.getState().confirm?.reason).toBe("repeat_in_revision");
    expect(h.sent).toHaveLength(1);
    // survives a controller re-create on the same storage
    const again = h.remount();
    await ready(again);
    again.invoke("go", { note: "c" }, "c10");
    expect(again.host.getState().confirm?.reason).toBe("repeat_in_revision");
    expect(again.sent).toHaveLength(0);
  });

  it("G4: the 11th consecutive unconfirmed send needs confirm, also after controller re-create", async () => {
    const storage = new MemoryStorage();
    let h = harness({ storage });
    await ready(h);
    for (let revision = 1; revision <= 10; revision += 1) {
      if (revision > 1) {
        h.host.applyFile(manifest({ revision }), `<html>${revision}</html>`);
        h.connect();
      }
      expect(h.invoke("go", { note: "a" })).toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.sent).toHaveLength(10);
    h.host.applyFile(manifest({ revision: 11 }), "<html>11</html>");
    h.connect();
    h.invoke("go", { note: "a" }, "c11");
    expect(h.host.getState().confirm?.reason).toBe("budget");
    expect(h.sent).toHaveLength(10);

    h = harness({ storage, manifest: manifest({ revision: 12 }) });
    await ready(h);
    h.invoke("go", { note: "a" }, "c12");
    expect(h.host.getState().confirm?.reason).toBe("budget");
    expect(h.sent).toHaveLength(0);
  });

  it("budget resets only on a trusted confirm click, never by time", async () => {
    const h = harness();
    await ready(h);
    h.invoke("go", { note: "a" });
    expect(readSnippetBudget(h.storage, SID)).toMatchObject({ value: { unconfirmed: 1 } });
    await vi.advanceTimersByTimeAsync(10 * 24 * 60 * 60 * 1000);
    expect(readSnippetBudget(h.storage, SID)).toMatchObject({ value: { unconfirmed: 1 } });
    h.host.applyFile(manifest({ revision: 2 }), "<html>2</html>");
    h.connect();
    h.focused.value = false;
    h.session();
    h.host.applyFile(manifest({ revision: 3 }), "<html>3</html>");
    h.connect();
    h.invoke("go", { note: "b" });
    expect(h.host.getState().confirm?.reason).toBe("no_focus");
    h.host.confirmSend(false);
    expect(h.host.getState().confirm).not.toBeNull();
    expect(h.sent).toHaveLength(1);
    expect(readSnippetBudget(h.storage, SID)).toMatchObject({ value: { unconfirmed: 1 } });
    h.host.confirmSend(true);
    expect(h.sent).toHaveLength(2);
    expect(readSnippetBudget(h.storage, SID)).toMatchObject({ value: { unconfirmed: 0 } });
  });

  it("Discard resolves declined with zero sends and restores the previous action", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.connect();
    h.invoke("go", { note: "a" }, "c1");
    h.host.confirmDiscard(false);
    expect(h.host.getState().confirm).not.toBeNull();
    h.host.confirmDiscard(true);
    expect(h.port().ofType("invoke-result")[0]).toMatchObject({
      callId: "c1",
      ok: false,
      reason: "declined",
    });
    expect(h.host.getState()).toMatchObject({ confirm: null, action: null });
    expect(h.sent).toHaveLength(0);
  });

  it("trusted Send dispatches once and reports ok to the snippet", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.connect();
    h.invoke("go", { note: "a" }, "c1");
    h.host.confirmSend(true);
    expect(h.sent).toHaveLength(1);
    expect(h.port().ofType("invoke-result")[0]).toMatchObject({ callId: "c1", ok: true });
    h.host.confirmSend(true);
    expect(h.sent).toHaveLength(1);
  });

  it("a declared confirm action asks even with focus", async () => {
    const h = harness();
    await ready(h);
    h.invoke("danger", { note: "a" });
    expect(h.host.getState().confirm?.reason).toBe("declared");
    expect(h.sent).toHaveLength(0);
  });

  it("revision replaced while awaiting confirm resolves stale", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    const port = h.connect();
    h.invoke("go", { note: "a" }, "c1");
    h.host.applyFile(manifest({ revision: 2 }), "<html>2</html>");
    expect(port.ofType("invoke-result")[0]).toMatchObject({
      callId: "c1",
      ok: false,
      reason: "stale",
    });
    expect(h.host.getState().confirm).toBeNull();
    expect(h.sent).toHaveLength(0);
  });

  it("dispose while awaiting confirm resolves stale", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    const port = h.connect();
    h.invoke("go", { note: "a" }, "c1");
    h.host.dispose();
    expect(port.ofType("invoke-result")[0]).toMatchObject({ reason: "stale" });
  });

  it("storage failure routes every invoke to confirm with zero unconfirmed sends", async () => {
    const h = harness();
    await ready(h);
    h.storage.failGet = true;
    h.invoke("go", { note: "a" }, "c1");
    expect(h.host.getState().confirm?.reason).toBe("storage_unavailable");
    expect(h.sent).toHaveLength(0);
  });

  it("a G3/G4 write failure before the POST confirms instead of sending", async () => {
    const h = harness();
    await ready(h);
    h.storage.failSet = (key) => key.startsWith("spur:snippet-budget");
    h.invoke("go", { note: "a" }, "c1");
    expect(h.host.getState().confirm?.reason).toBe("storage_unavailable");
    expect(h.sent).toHaveLength(0);
    const second = harness();
    await ready(second);
    second.storage.failSet = (key) => key.startsWith("spur:snippet:v1");
    second.invoke("go", { note: "a" }, "c2");
    expect(second.host.getState().confirm?.reason).toBe("storage_unavailable");
    expect(second.sent).toHaveLength(0);
  });
});

describe("lifecycle", () => {
  it("walks submitting -> accepted -> queued -> processing -> completed", async () => {
    const h = harness();
    const port = await ready(h);
    h.invoke("go", { note: "a" });
    expect(h.host.getState().action?.status).toBe("submitting");
    await vi.advanceTimersByTimeAsync(0);
    const action = h.host.getState().action!;
    expect(action.status).toBe("accepted");
    h.session({ queuedMessages: [action.prompt] });
    expect(h.host.getState().action?.status).toBe("queued");
    h.session({
      messages: [{ role: "user", text: `"requestId":"${action.requestId}"`, timestampMs: 1 }],
    });
    expect(h.host.getState().action?.status).toBe("processing");
    h.host.applyFile(
      manifest({ revision: 2, respondsToRequestId: action.requestId }),
      "<html>2</html>",
    );
    expect(h.host.getState().action?.status).toBe("completed");
    expect(port.ofType("action").map((m) => (m.action as { status: string }).status)).toEqual([
      "submitting",
      "accepted",
      "queued",
      "processing",
    ]);
    // the revision swap mounts a new document; it learns the outcome from connect
    h.connect();
    expect(h.posts.at(-1)?.message.context).toMatchObject({ action: { status: "completed" } });
  });

  it("a 4xx is an error, 5xx and network failure are delivery_unknown", async () => {
    for (const [outcome, status, httpStatus] of [
      [{ kind: "response", status: 409 }, "error", 409],
      [{ kind: "response", status: 502 }, "delivery_unknown", 502],
      [{ kind: "failure" }, "delivery_unknown", undefined],
    ] as const) {
      const h = harness();
      h.sendOutcome.value = () => Promise.resolve(outcome);
      await ready(h);
      h.invoke("go", { note: "a" });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.host.getState().action?.status).toBe(status);
      expect(h.host.getState().action?.httpStatus).toBe(httpStatus);
    }
  });

  it("a rejected send promise is delivery_unknown", async () => {
    const h = harness();
    h.sendOutcome.value = () => Promise.reject(new Error("boom"));
    await ready(h);
    h.invoke("go", { note: "a" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.host.getState().action?.status).toBe("delivery_unknown");
  });

  it("reload while submitting restores as delivery_unknown", async () => {
    const h = harness();
    h.sendOutcome.value = () => new Promise<SnippetSendOutcome>(() => undefined);
    await ready(h);
    h.invoke("go", { note: "a" });
    expect(h.host.getState().action?.status).toBe("submitting");
    const again = h.remount();
    expect(again.host.getState().action?.status).toBe("delivery_unknown");
    expect(readSnippetRecord(h.storage, SID, "picker")).toMatchObject({
      value: { action: { status: "delivery_unknown" } },
    });
  });

  it("times out 15 minutes after accept and a late matching revision still completes", async () => {
    const h = harness();
    await ready(h);
    h.invoke("go", { note: "a" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    h.session();
    expect(h.host.getState().action?.status).toBe("timeout");
    const id = h.host.getState().action!.requestId;
    h.host.applyFile(manifest({ revision: 2, respondsToRequestId: id }), "<html>2</html>");
    expect(h.host.getState().action?.status).toBe("completed");
  });

  it("Retry from the host button sends a new requestId with retryOf, resets the budget, needs a trusted click", async () => {
    const h = harness();
    h.sendOutcome.value = () => Promise.resolve({ kind: "response", status: 409 });
    await ready(h);
    h.invoke("go", { note: "a" });
    await vi.advanceTimersByTimeAsync(0);
    const failed = h.host.getState().action!;
    expect(failed.status).toBe("error");
    expect(readSnippetBudget(h.storage, SID)).toMatchObject({ value: { unconfirmed: 1 } });
    h.sendOutcome.value = () => Promise.resolve({ kind: "response", status: 200 });
    h.host.retry(false);
    expect(h.sent).toHaveLength(1);
    h.host.retry(true);
    expect(h.sent).toHaveLength(2);
    const next = h.host.getState().action!;
    expect(next.requestId).not.toBe(failed.requestId);
    expect(next.retryOf).toBe(failed.requestId);
    expect(h.sent[1]).toContain(`"retryOf":"${failed.requestId}"`);
    expect(readSnippetBudget(h.storage, SID)).toMatchObject({ value: { unconfirmed: 0 } });
  });

  it("SDK retry re-enters the gates as a new invoke with retryOf", async () => {
    const h = harness();
    h.sendOutcome.value = () => Promise.resolve({ kind: "response", status: 409 });
    const port = await ready(h);
    h.invoke("go", { note: "a" });
    await vi.advanceTimersByTimeAsync(0);
    const failed = h.host.getState().action!;
    h.focused.value = false;
    port.emit({
      type: "invoke",
      callId: "r1",
      actionId: failed.actionId,
      retryOf: failed.requestId,
    });
    expect(h.host.getState().confirm).toMatchObject({
      reason: "no_focus",
      retryOf: failed.requestId,
    });
    expect(h.sent).toHaveLength(1);
    port.emit({ type: "invoke", callId: "r2", actionId: "go", retryOf: "req-unknown" });
    expect(port.ofType("invoke-result").find((m) => m.callId === "r2")).toMatchObject({
      ok: false,
    });
  });

  it("a chat answer completes a processing action, clears busy and allows the next invoke", async () => {
    const h = harness();
    await ready(h);
    h.invoke("go", { note: "a" });
    await vi.advanceTimersByTimeAsync(0);
    const id = h.host.getState().action!.requestId;
    const user = { role: "user" as const, text: `"requestId":"${id}"`, timestampMs: 5 };
    h.session({ messages: [user] });
    expect(h.host.getState().action?.status).toBe("processing");
    h.session({
      messages: [user, { role: "assistant", text: "answered", timestampMs: 9 }],
      state: "waiting",
    });
    expect(h.host.getState().action?.status).toBe("completed");
    h.host.applyFile(manifest({ revision: 2 }), "<html>2</html>");
    h.connect();
    expect(h.invoke("go", { note: "b" })).toMatchObject({ ok: true });
  });

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
    expect(h.invoke("go", { note: "a" })).toMatchObject({ ok: false, reason: "revision_conflict" });
    expect(h.sent).toHaveLength(0);
    expect(h.host.getState().html).toBe("<html>a</html>");
    expect(h.host.applyFile(manifest({ revision: 2 }), "<html>2</html>")).toBe("mounted");
    expect(h.host.getState()).toMatchObject({ conflict: false, availability: { canInvoke: true } });
  });

  it("rejects a lower revision and resets state on a new instance", async () => {
    const h = harness({ manifest: manifest({ revision: 3 }) });
    await ready(h);
    expect(h.host.applyFile(manifest({ revision: 2 }), "<html>old</html>")).toBe("lower_revision");
    expect(h.host.getState().manifest.revision).toBe(3);
    h.port().emit({
      type: "state-set",
      callId: "s1",
      app: { k: 1 },
      controls: [{ id: "c", value: "v" }],
    });
    expect(readSnippetRecord(h.storage, SID, "picker")).toMatchObject({
      value: { state: { app: { k: 1 } } },
    });
    h.host.applyFile(manifest({ revision: 4 }), "<html>4</html>");
    h.connect();
    expect(h.posts.at(-1)?.message.context).toMatchObject({ previousRevision: 3, state: { k: 1 } });
    h.host.applyFile(manifest({ instanceId: "inst-00000002", revision: 1 }), "<html>new</html>");
    h.connect();
    expect(h.posts.at(-1)?.message.context).toMatchObject({
      previousRevision: null,
      state: null,
      controls: [],
    });
  });

  it("state-set persists, acks, and rejects over 64 KiB", async () => {
    const h = harness();
    const port = await ready(h);
    port.emit({ type: "state-set", callId: "s1", app: { a: 1 }, controls: [] });
    expect(port.ofType("state-ack")[0]).toMatchObject({ callId: "s1", ok: true });
    port.emit({ type: "state-set", callId: "s2", app: "x".repeat(70_000), controls: [] });
    expect(port.ofType("state-ack")[1]).toMatchObject({ callId: "s2", ok: false });
    port.emit({ type: "state-set", callId: "s3", app: null, controls: "bad" });
    expect(port.ofType("state-ack")[2]).toMatchObject({ ok: false });
  });

  it("fullscreen request needs the G2 signal; escape exits", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    const port = h.connect();
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
    await vi.advanceTimersByTimeAsync(0);
    h.focused.value = focus;
    h.connect();
    h.invoke("go", { note: "auto" });
    for (let revision = 2; revision <= 51; revision += 1) {
      h.host.applyFile(manifest({ revision }), `<html>${revision}</html>`);
      h.connect();
      h.invoke("go", { note: "auto" });
      await vi.advanceTimersByTimeAsync(0);
    }
    return h.sent.length;
  }
  it("sends nothing across 50 agent revisions when no focus signal exists", async () => {
    expect(await loop(false)).toBe(0);
  });
  it("sends at most 10 with focus forced true", async () => {
    expect(await loop(true)).toBe(10);
  });
});
