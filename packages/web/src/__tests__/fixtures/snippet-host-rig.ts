// Test rig for the snippet host: fake port/channel, in-memory localStorage, an
// in-memory store daemon behind `deps.request`, and a manual change poller.

import { vi } from "vitest";
import {
  createSnippetHost,
  type SnippetChannel,
  type SnippetFontBuffer,
  type SnippetHost,
  type SnippetHostDeps,
  type SnippetPort,
  type SnippetSessionUpdate,
  type StoreResponse,
} from "@/lib/snippets/snippet-host";
import type { SnippetManifest } from "@/lib/snippets/snippet-manifest";
import type { SnippetTheme } from "@/lib/snippets/snippet-protocol";
import type { SnippetStorage } from "@/lib/snippets/snippet-store";
import type {
  StoreChangeEvent,
  StoreChangeListener,
  StoreChangePoller,
} from "@/lib/store-change-poller";

export class MemoryStorage implements SnippetStorage {
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

export class FakePort implements SnippetPort {
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
  reply(type: string, callId: string): Record<string, unknown> | undefined {
    return this.ofType(type).find((message) => message.callId === callId);
  }
}

export class FakePoller implements StoreChangePoller {
  subs = new Map<string, Set<StoreChangeListener>>();
  subscribe(store: string, listener: StoreChangeListener): () => void {
    const set = this.subs.get(store) ?? new Set();
    set.add(listener);
    this.subs.set(store, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.subs.delete(store);
    };
  }
  activeStores(): string[] {
    return [...this.subs.keys()];
  }
  count(store: string): number {
    return this.subs.get(store)?.size ?? 0;
  }
  emit(store: string, event: StoreChangeEvent): void {
    for (const listener of [...(this.subs.get(store) ?? [])]) listener(event);
  }
}

export interface RequestRecord {
  method: string;
  url: string;
  body: unknown;
}

interface ActionDocRecord {
  id: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

// Minimal store daemon: `_actions` invoke/get/query, `_state` docs, agent routes.
export class FakeDaemon {
  requests: RequestRecord[] = [];
  actions = new Map<string, ActionDocRecord>();
  docs = new Map<string, unknown>();
  // Override for one route: return a response to short-circuit.
  intercept: (record: RequestRecord) => StoreResponse | null = () => null;
  // When false, POST /actions answers but leaves the response hanging.
  hold = false;
  held: Array<() => void> = [];

  handle(method: string, url: string, body: unknown): Promise<StoreResponse> {
    const record = { method, url, body };
    this.requests.push(record);
    const overridden = this.intercept(record);
    if (overridden) return Promise.resolve(overridden);
    const response = this.route(record);
    if (this.hold && url.endsWith("/actions")) {
      return new Promise((resolve) => this.held.push(() => resolve(response)));
    }
    return Promise.resolve(response);
  }

  private route({ method, url, body }: RequestRecord): StoreResponse {
    const [path = "", search = ""] = url.split("?");
    const segments = path.split("/").slice(4).map(decodeURIComponent);
    const ok = (value: unknown): StoreResponse => ({ ok: true, status: 200, body: value });
    const missing: StoreResponse = { ok: false, status: 404, body: { error: "not found" } };
    if (method === "POST" && segments[0] === "actions") {
      const request = body as Record<string, unknown>;
      const doc: ActionDocRecord = {
        id: String(request.id),
        rev: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        data: {
          action: request.action,
          label: request.label,
          source: request.source,
          payload: request.payload,
          status: "pending",
          ...(request.retryOf ? { retryOf: request.retryOf } : {}),
          createdAt: new Date().toISOString(),
        },
      };
      this.actions.set(doc.id, doc);
      return ok(doc);
    }
    if (segments[0] === "docs" && segments[1] === "_actions" && segments[2]) {
      const doc = this.actions.get(segments[2]);
      return doc ? ok(doc) : missing;
    }
    if (method === "POST" && segments[0] === "query" && segments[1] === "_actions") {
      const query = body as { where: Array<{ field: string; value: unknown }> };
      const match = [...this.actions.values()]
        .filter((doc) =>
          query.where.every(({ field, value }) => {
            const source = doc.data.source as Record<string, unknown>;
            return source[field.slice("source.".length)] === value;
          }),
        )
        .sort((a, b) => ((a.data.createdAt as string) < (b.data.createdAt as string) ? 1 : -1));
      return ok({ docs: match.slice(0, 1) });
    }
    if (segments[0] === "docs") {
      const key = `${decodeURIComponent(path.split("/")[3] ?? "")}/${segments.slice(1).join("/")}`;
      if (method === "GET") {
        const data = this.docs.get(key);
        return data === undefined ? missing : ok({ id: segments[2], rev: 1, data });
      }
      if (method === "POST") {
        this.docs.set(key, (body as { data: unknown }).data);
        return ok({ id: segments[2], rev: 1, data: (body as { data: unknown }).data });
      }
    }
    if (segments[0] === "agent" && segments[1] === "send") return ok({ sessionId: "sp-ab12" });
    if (segments[0] === "agent" && segments[1] === "status") {
      return ok({ state: "idle", sessionId: "sp-ab12" });
    }
    if (segments[0] === "agent" && segments[1] === "messages") {
      return ok({ sessionId: "sp-ab12", messages: [], nextFrom: 0, search });
    }
    return ok({});
  }

  complete(id: string, data: Record<string, unknown>): void {
    const doc = this.actions.get(id);
    if (!doc) throw new Error(`no action ${id}`);
    this.actions.set(id, { ...doc, rev: doc.rev + 1, data: { ...doc.data, ...data } });
  }

  posts(suffix: string): RequestRecord[] {
    return this.requests.filter(
      (r) => r.method === "POST" && r.url.split("?")[0]?.endsWith(suffix),
    );
  }
}

export const SID = "sp-ab12";
export const OWNER_STORE = `session:${SID}`;
export const THEME = { mode: "dark", tokens: {} } as unknown as SnippetTheme;
const notePayload = {
  type: "object",
  properties: { note: { type: "string", maxLength: 50 } },
} as const;

export function manifest(overrides: Partial<SnippetManifest> = {}): SnippetManifest {
  return {
    protocolVersion: 2,
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

export interface Harness {
  host: SnippetHost;
  storage: MemoryStorage;
  daemon: FakeDaemon;
  poller: StoreChangePoller;
  ports: FakePort[];
  posts: Array<{ message: Record<string, unknown>; transfer: unknown[] }>;
  focused: { value: boolean };
  sdkLoads: boolean[];
  sdk: { fail: boolean };
  fonts: { value: SnippetFontBuffer[] };
  fullscreenRequests: boolean[];
  port(): FakePort;
  hello(nonce?: string, protocolVersion?: number): void;
  connect(): Promise<FakePort>;
  invoke(action: string, payload: unknown, callId?: string): string;
  session(update?: Partial<SnippetSessionUpdate>): void;
  remount(m?: SnippetManifest): Harness;
}

let counter = 0;

export function harness(
  opts: {
    storage?: MemoryStorage;
    daemon?: FakeDaemon;
    poller?: StoreChangePoller;
    manifest?: SnippetManifest;
    html?: string;
    sdkFail?: boolean;
  } = {},
): Harness {
  const storage = opts.storage ?? new MemoryStorage();
  const daemon = opts.daemon ?? new FakeDaemon();
  const poller = opts.poller ?? new FakePoller();
  const ports: FakePort[] = [];
  const posts: Harness["posts"] = [];
  const focused = { value: false };
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
    request: (method, url, body) => daemon.handle(method, url, body),
    poller,
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
    daemon,
    poller,
    ports,
    posts,
    focused,
    sdkLoads,
    sdk,
    fonts,
    fullscreenRequests,
    port: () => ports[ports.length - 1]!,
    hello: (nonce, protocolVersion = 2) =>
      host.onWindowMessage(
        { type: "spur:hello", protocolVersion, nonce: nonce ?? host.getState().nonce },
        true,
      ),
    connect: async () => {
      const before = ports.length;
      h.hello();
      // The state doc id hash resolves off the timer queue.
      await vi.waitFor(() => {
        if (ports.length === before) throw new Error("not connected");
      });
      return h.port();
    },
    invoke: (action, payload, callId = `c${(counter += 1)}`) => {
      h.port().emit({ type: "invoke", callId, action, payload });
      return callId;
    },
    session: (update = {}) =>
      host.updateSession({ canSend: true, state: "working", status: "running", ...update }),
    remount: (m) => harness({ storage, daemon, poller, ...(m ? { manifest: m } : {}) }),
  };
  return h;
}

export async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

export async function ready(h: Harness): Promise<FakePort> {
  await flush();
  h.focused.value = true;
  const port = await h.connect();
  await flush();
  return port;
}
