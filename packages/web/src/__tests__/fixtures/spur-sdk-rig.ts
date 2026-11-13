import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { vi } from "vitest";
import { SNIPPET_THEME_TOKENS } from "@/lib/snippets/snippet-protocol";

// Loads public/spur/spur-sdk.v2.js into a JSDOM window, either as a snippet frame
// (port transport) or as a page (fetch + EventSource transport), with a deterministic
// timer queue.

export const SDK_PATH = resolve(__dirname, "../../../public/spur/spur-sdk.v2.js");
export const sdkSource = readFileSync(SDK_PATH, "utf8");

export type Msg = Record<string, unknown>;
export interface SpurQuery {
  where(field: string, op: string, value: unknown): SpurQuery;
  orderBy(field: string, direction?: string): SpurQuery;
  limit(count: number): SpurQuery;
  get(): Promise<Msg[]>;
  onSnapshot(cb: (docs: Msg[]) => void): () => void;
}
export interface SpurCollection extends SpurQuery {
  add(data: unknown): Promise<Msg>;
  doc(id: string): {
    get(): Promise<Msg | null>;
    set(data: unknown): Promise<Msg>;
    update(data: unknown): Promise<Msg>;
    delete(): Promise<Msg>;
  };
}
export interface SpurApi {
  ready(): Promise<Msg>;
  db: { collection(name: string): SpurCollection };
  state: { get(): unknown; set(value: unknown): void };
  agent: {
    invoke(action: string, payload?: unknown): Promise<Msg>;
    retry(): Promise<Msg>;
    send(text: string): Promise<Msg>;
    onMessage(cb: (message: Msg) => void): () => void;
    status(): Promise<Msg>;
  };
  on(event: string, handler: (data: unknown) => void): () => void;
  once(event: string, handler: (data: unknown) => void): () => void;
  requestFullscreen(): Promise<boolean>;
  exitFullscreen(): void;
  selection(sourceId?: string): unknown;
  readonly action: Msg | null;
  protocolVersion: number;
}
export type Win = JSDOM["window"] & { spur: SpurApi; [key: string]: unknown };

export const THEME = {
  mode: "dark",
  tokens: Object.fromEntries(SNIPPET_THEME_TOKENS.map((token) => [token, `v-${token}`])),
};

export async function flush(times = 3): Promise<void> {
  for (let index = 0; index < times; index++) {
    await new Promise((done) => setTimeout(done, 0));
  }
}

interface Clock {
  advance(ms: number): void;
  frame(): void;
  pendingFrames(): number;
}

function installClock(win: Win): Clock {
  let now = 0;
  let nextId = 1;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let frames: Array<{ id: number; fn: () => void }> = [];
  win.Date.now = () => now;
  win.setTimeout = ((fn: () => void, delay = 0) => {
    const id = nextId++;
    timers.push({ id, at: now + delay, fn });
    return id;
  }) as unknown as typeof win.setTimeout;
  win.clearTimeout = ((id: number) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  }) as unknown as typeof win.clearTimeout;
  win.requestAnimationFrame = ((fn: () => void) => {
    const id = nextId++;
    frames.push({ id, fn });
    return id;
  }) as unknown as typeof win.requestAnimationFrame;
  win.cancelAnimationFrame = ((id: number) => {
    frames = frames.filter((frame) => frame.id !== id);
  }) as typeof win.cancelAnimationFrame;
  return {
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.fn();
      }
      now = end;
    },
    frame() {
      const queued = frames;
      frames = [];
      for (const { fn } of queued) fn();
    },
    pendingFrames: () => frames.length,
  };
}

async function makeWindow(body: string, url: string, onNavigate?: () => void): Promise<Win> {
  // JSDOM cannot navigate; location.reload() reports a "navigation" jsdomError instead.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => {
    if (/navigation/.test(error.message)) onNavigate?.();
  });
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    runScripts: "outside-only",
    pretendToBeVisual: false,
    virtualConsole,
    ...(url === "about:srcdoc" ? {} : { url }),
  });
  const win = dom.window as unknown as Win;
  await new Promise<void>((done) => win.addEventListener("load", () => done()));
  win.TextEncoder = TextEncoder;
  if (!win.crypto?.getRandomValues) {
    Object.defineProperty(win, "crypto", { value: globalThis.crypto });
  }
  win.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
  win.Range.prototype.getBoundingClientRect = () =>
    ({ top: 10, left: 5, height: 10, width: 20 }) as DOMRect;
  return win;
}

export interface PortRig extends Clock {
  win: Win;
  doc: Document;
  hellos: Msg[];
  sent: Msg[];
  fonts: Array<{ family: string }>;
  height: { value: number };
  connect(context?: Msg): void;
  fromHost(message: Msg): void;
  ofType(type: string): Msg[];
  reply(type: string, payload: Msg): void;
  click(selector: string): void;
}

export async function portRig(body = "", options: { booted?: boolean } = {}): Promise<PortRig> {
  const win = await makeWindow(body, "about:srcdoc");
  const clock = installClock(win);
  const hellos: Msg[] = [];
  const sent: Msg[] = [];
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: Msg) => sent.push(message),
  };
  const height = { value: 100 };
  const fonts: Array<{ family: string }> = [];
  win.postMessage = ((message: Msg) => hellos.push(message)) as unknown as typeof win.postMessage;
  win.FontFace = class {
    constructor(public family: string) {
      fonts.push({ family });
    }
    load(): Promise<void> {
      return Promise.resolve();
    }
  };
  Object.defineProperty(win.document, "fonts", { value: { add: vi.fn() } });
  win.document.documentElement.getBoundingClientRect = () => ({ height: height.value }) as DOMRect;
  win.__SPUR_SNIPPET_BOOT__ = { nonce: "n0nce" };
  win.eval(sdkSource);
  const rig: PortRig = {
    ...clock,
    win,
    doc: win.document,
    hellos,
    sent,
    fonts,
    height,
    connect(context = {}) {
      const event = new win.Event("message");
      Object.assign(event, {
        data: {
          type: "spur:connect",
          context: {
            sessionId: "sp-ab12",
            snippetId: "picker",
            instanceId: "inst-00000001",
            revision: 1,
            dataStore: "session:sp-ab12",
            agentStore: "session:sp-ab12",
            state: null,
            controls: [],
            action: null,
            theme: THEME,
            fullscreen: false,
            availability: { canInvoke: true, reason: null },
            ...context,
          },
        },
        source: win.parent,
        ports: [port],
      });
      win.dispatchEvent(event);
    },
    fromHost(message) {
      port.onmessage?.({ data: message });
    },
    ofType: (type) => sent.filter((message) => message.type === type),
    reply(type, payload) {
      // invoke is the one request answered under another type.
      const requestType = type === "invoke-result" ? "invoke" : type;
      const last = sent.filter((message) => message.type === requestType).at(-1);
      port.onmessage?.({ data: { type, callId: last?.callId, ...payload } });
    },
    click(selector) {
      const node = win.document.querySelector(selector);
      if (!node) throw new Error(`no ${selector}`);
      const target = node.querySelector("button") ?? node;
      target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    },
  };
  if (options.booted !== false) {
    rig.connect();
    await flush();
  }
  return rig;
}

export interface FakeEventSource {
  url: string;
  emit(type: string, data: unknown, id?: string): void;
  /** Delivers `data` as the frame text unencoded, e.g. malformed JSON. */
  emitRaw(type: string, data: string): void;
}

export interface PageRig extends Clock {
  win: Win;
  doc: Document;
  requests: Array<{ method: string; url: string; body: unknown }>;
  sources: FakeEventSource[];
  respond(
    handler: (method: string, url: string, body: unknown) => [number, unknown] | undefined,
  ): void;
  reloads: number;
  click(selector: string): void;
}

export async function pageRig(body = "", path = "/p/films/"): Promise<PageRig> {
  const navigation = { count: 0 };
  const win = await makeWindow(body, `http://host${path}`, () => {
    navigation.count += 1;
  });
  const clock = installClock(win);
  const requests: PageRig["requests"] = [];
  const sources: FakeEventSource[] = [];
  let handler: Parameters<PageRig["respond"]>[0] = () => undefined;
  win.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const parsed = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ method, url, body: parsed });
    const [status, payload] = handler(method, url, parsed) ?? [200, {}];
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof win.fetch;
  win.EventSource = class {
    private readonly handlers = new Map<
      string,
      Array<(event: { data: string; lastEventId: string }) => void>
    >();
    constructor(public url: string) {
      sources.push({
        url,
        emit: (type, data, id) => {
          for (const fn of this.handlers.get(type) ?? []) {
            fn({ data: JSON.stringify(data), lastEventId: id ?? "" });
          }
        },
        emitRaw: (type, data) => {
          for (const fn of this.handlers.get(type) ?? []) fn({ data, lastEventId: "" });
        },
      });
    }
    addEventListener(type: string, fn: (event: { data: string; lastEventId: string }) => void) {
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
    }
  } as unknown as typeof win.EventSource;
  const rig: PageRig = {
    ...clock,
    win,
    doc: win.document,
    requests,
    sources,
    get reloads() {
      return navigation.count;
    },
    respond(next) {
      handler = next;
    },
    click(selector) {
      const node = win.document.querySelector(selector);
      if (!node) throw new Error(`no ${selector}`);
      const target = node.querySelector("button") ?? node;
      target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    },
  };
  win.eval(sdkSource);
  await flush();
  return rig;
}
