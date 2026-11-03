// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  SNIPPET_STATUS_LABELS,
  SNIPPET_THEME_TOKENS,
  SNIPPET_TO_FRAME,
  SNIPPET_TO_HOST,
  SNIPPET_WINDOW_MSG,
} from "@/lib/snippets/snippet-protocol";

const SDK_PATH = resolve(__dirname, "../../public/snippets/spur-snippet-sdk.v1.js");
const sdkSource = readFileSync(SDK_PATH, "utf8");

type Msg = Record<string, unknown>;
interface SpurApi {
  invoke(actionId: string, payload?: unknown): Promise<Msg>;
  retry(): Promise<Msg>;
  on(event: string, handler: (data: unknown) => void): () => void;
  once(event: string, handler: (data: unknown) => void): () => void;
  state: { get(): unknown; set(value: unknown): void };
  requestFullscreen(): Promise<boolean>;
  exitFullscreen(): void;
  selection(sourceId?: string): unknown;
  ready(): Promise<unknown>;
  formatRejection(result: Msg): string;
  readonly action: { status: string } | null;
}
type Win = JSDOM["window"] & { spur: SpurApi; [key: string]: unknown };

// Library fields expose a `value` property.
function fieldValue(node: Element | null): unknown {
  return (node as unknown as { value: unknown }).value;
}

interface Rig {
  win: Win;
  doc: Document;
  hellos: Msg[];
  sent: Msg[];
  port: { onmessage: ((event: { data: unknown }) => void) | null };
  fonts: Array<{ family: string; data: unknown; weight: string }>;
  height: { value: number };
  advance(ms: number): void;
  frame(): void;
  connect(context?: Record<string, unknown>): void;
  fromHost(message: Msg): void;
  ofType(type: string): Msg[];
  click(selector: string): void;
}

const THEME = {
  mode: "dark",
  tokens: Object.fromEntries(SNIPPET_THEME_TOKENS.map((token) => [token, `v-${token}`])),
};

async function rig(body: string, options: { booted?: boolean } = {}): Promise<Rig> {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    runScripts: "outside-only",
    pretendToBeVisual: false,
  });
  const win = dom.window as unknown as Win;
  await new Promise<void>((done) => win.addEventListener("load", () => done()));
  const hellos: Msg[] = [];
  const sent: Msg[] = [];
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (m: Msg) => sent.push(m),
  };
  const height = { value: 100 };
  const fonts: Rig["fonts"] = [];

  // Deterministic scheduler: the SDK has no absence fallback for timers or frames.
  let now = 0;
  let nextId = 1;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let frames: Array<() => void> = [];
  win.setTimeout = ((fn: () => void, delay = 0) => {
    const id = nextId++;
    timers.push({ id, at: now + delay, fn });
    return id;
  }) as unknown as typeof win.setTimeout;
  win.clearTimeout = ((id: number) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  }) as unknown as typeof win.clearTimeout;
  win.requestAnimationFrame = ((fn: () => void) =>
    frames.push(fn)) as unknown as typeof win.requestAnimationFrame;
  win.postMessage = ((message: Msg) => hellos.push(message)) as unknown as typeof win.postMessage;
  win.TextEncoder = TextEncoder;
  win.ResizeObserver = class {
    observe(): void {}
  };
  win.FontFace = class {
    constructor(
      public family: string,
      public data: unknown,
      public descriptors: { weight: string },
    ) {
      fonts.push({ family, data, weight: descriptors.weight });
    }
    load(): Promise<void> {
      return Promise.resolve();
    }
  };
  Object.defineProperty(win.document, "fonts", { value: { add: vi.fn() } });
  win.document.documentElement.getBoundingClientRect = () => ({ height: height.value }) as DOMRect;
  win.Range.prototype.getBoundingClientRect = () =>
    ({ top: 10, left: 5, height: 10, width: 20 }) as DOMRect;
  win.__SPUR_SNIPPET_BOOT__ = { nonce: "n0nce" };
  win.eval(sdkSource);

  const helper: Rig = {
    win,
    doc: win.document,
    hellos,
    sent,
    port,
    fonts,
    height,
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
      for (const fn of queued) fn();
    },
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
            previousRevision: null,
            state: null,
            controls: [],
            action: null,
            actions: [{ id: "go", label: "Go" }],
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
    click(selector) {
      const node = win.document.querySelector(selector);
      if (!node) throw new Error(`no ${selector}`);
      const target = node.querySelector("button") ?? node;
      target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    },
  };
  if (options.booted !== false) {
    helper.connect();
    helper.advance(0);
  }
  return helper;
}

async function flush(): Promise<void> {
  await new Promise((resolveFlush) => setTimeout(resolveFlush, 0));
}

function lastCallId(r: Rig, type = "invoke"): string {
  const messages = r.ofType(type);
  return String(messages[messages.length - 1]?.callId);
}

const FORM = `
  <spur-choice-list id="pick" name="selected" mode="multiple">
    <spur-choice value="a"><spur-selectable-text source-id="va">alpha 😀 text</spur-selectable-text></spur-choice>
    <spur-choice value="b"><spur-selectable-text source-id="vb">beta</spur-selectable-text></spur-choice>
  </spur-choice-list>
  <spur-form id="f" action="regenerate">
    <spur-text-input name="title" maxlength="20" label="Title"></spur-text-input>
    <spur-textarea id="note" name="instruction" maxlength="100" label="Instruction"></spur-textarea>
  </spur-form>
  <spur-button id="choose" action="choose" form="f" variant="primary">Choose</spur-button>
  <spur-selection-toolbar for="va vb" field="selection">
    <spur-button id="modify" action="modify-selection">Modify</spur-button>
  </spur-selection-toolbar>
  <button id="plain" data-spur-action="go" data-spur-payload='{"n":1}'>Plain</button>
`;

describe("handshake", () => {
  it("repeats hello at most 25 times and stops on connect", async () => {
    const r = await rig("", { booted: false });
    expect(r.hellos).toHaveLength(1);
    expect(r.hellos[0]).toEqual({ type: "spur:hello", protocolVersion: 1, nonce: "n0nce" });
    r.advance(200 * 40);
    expect(r.hellos).toHaveLength(25);

    const r2 = await rig("", { booted: false });
    r2.advance(200 * 3);
    expect(r2.hellos).toHaveLength(4);
    r2.connect();
    r2.advance(200 * 20);
    expect(r2.hellos).toHaveLength(4);
  });

  it("ignores connect messages that do not come from the parent window", async () => {
    const r = await rig("", { booted: false });
    const event = new r.win.Event("message");
    Object.assign(event, {
      data: { type: "spur:connect", context: {} },
      source: {},
      ports: [r.port],
    });
    r.win.dispatchEvent(event);
    let resolved = false;
    void r.win.spur.ready().then(() => (resolved = true));
    await flush();
    expect(resolved).toBe(false);
  });

  it("resolves ready with the context and applies theme tokens and fonts", async () => {
    const r = await rig("", { booted: false });
    const ready = r.win.spur.ready();
    r.connect({ fonts: [{ family: "Spur Mono", weight: "400", data: new ArrayBuffer(2) }] });
    await expect(ready).resolves.toMatchObject({ snippetId: "picker" });
    const root = r.doc.documentElement;
    for (const token of SNIPPET_THEME_TOKENS) {
      expect(root.style.getPropertyValue(`--spur-${token}`)).toBe(`v-${token}`);
    }
    expect(r.fonts).toEqual([
      { family: "Spur Mono", weight: "400", data: expect.any(ArrayBuffer) },
    ]);
    expect(root.style.getPropertyValue("--spur-font")).toContain('"Spur Mono"');
  });

  it("omits the font stack when connect carries no fonts", async () => {
    const r = await rig("");
    expect(r.fonts).toEqual([]);
    expect(r.doc.documentElement.style.getPropertyValue("--spur-font")).toBe("");
  });
});

describe("constants", () => {
  it("message type strings equal snippet-protocol", () => {
    const strings = [
      ...Object.values(SNIPPET_WINDOW_MSG),
      ...Object.values(SNIPPET_TO_HOST),
      ...Object.values(SNIPPET_TO_FRAME),
    ];
    for (const value of strings) expect(sdkSource).toContain(`"${value}"`);
    const msgBlock = /var MSG = \{([\s\S]*?)\};/.exec(sdkSource)?.[1] ?? "";
    const declared = [...msgBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect([...declared].sort()).toEqual([...new Set(strings)].sort());
  });

  it("status labels equal the host labels (error without the HTTP suffix)", () => {
    const block = /var STATUS_LABELS = \{([\s\S]*?)\};/.exec(sdkSource)?.[1] ?? "";
    const declared = Object.fromEntries(
      [...block.matchAll(/(\w+): "([^"]+)"/g)].map((match) => [match[1], match[2]]),
    );
    expect(declared).toEqual({ ...SNIPPET_STATUS_LABELS, error: "Send failed" });
  });
});

describe("invoke", () => {
  it("posts the invoke message and resolves with the host result", async () => {
    const r = await rig("");
    const pending = r.win.spur.invoke("go", { a: 1 });
    expect(r.ofType("invoke")).toEqual([
      { type: "invoke", actionId: "go", payload: { a: 1 }, callId: expect.any(String) },
    ]);
    r.fromHost({ type: "invoke-result", callId: lastCallId(r), ok: true, requestId: "req-1" });
    await expect(pending).resolves.toEqual({ ok: true, requestId: "req-1" });
  });

  it("returns not_connected without a port and never posts", async () => {
    const r = await rig("", { booted: false });
    await expect(r.win.spur.invoke("go", {})).resolves.toEqual({
      ok: false,
      reason: "not_connected",
    });
    expect(r.sent).toHaveLength(0);
  });

  it("tracks action events, exposes spur.action and notifies listeners once", async () => {
    const r = await rig("");
    const seen: unknown[] = [];
    r.win.spur.on("action", (a: unknown) => seen.push(a));
    const once = vi.fn();
    r.win.spur.once("action", once);
    r.fromHost({ type: "action", action: { requestId: "r", actionId: "go", status: "queued" } });
    r.fromHost({
      type: "action",
      action: { requestId: "r", actionId: "go", status: "processing" },
    });
    expect(r.win.spur.action).toMatchObject({ status: "processing" });
    expect(seen).toHaveLength(2);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("retry sends the last action with retryOf and no payload; refuses non-retryable states", async () => {
    const r = await rig("");
    await expect(r.win.spur.retry()).resolves.toMatchObject({ ok: false });
    expect(r.ofType("invoke")).toHaveLength(0);
    r.fromHost({
      type: "action",
      action: { requestId: "req-9", actionId: "go", status: "queued" },
    });
    await expect(r.win.spur.retry()).resolves.toMatchObject({ ok: false });
    r.fromHost({
      type: "action",
      action: { requestId: "req-9", actionId: "go", status: "error", httpStatus: 409 },
    });
    void r.win.spur.retry();
    const message = r.ofType("invoke")[0] as Msg;
    expect(message).toMatchObject({ actionId: "go", retryOf: "req-9" });
    expect("payload" in message).toBe(false);
  });

  it("reverts to the prior action when a pending confirm is declined", async () => {
    const r = await rig("");
    const pending = r.win.spur.invoke("go", {});
    r.fromHost({
      type: "action",
      action: { requestId: "r2", actionId: "go", status: "awaiting_confirm" },
    });
    expect(r.win.spur.action?.status).toBe("awaiting_confirm");
    r.fromHost({ type: "invoke-result", callId: lastCallId(r), ok: false, reason: "declined" });
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "declined" });
    expect(r.win.spur.action).toBeNull();
  });
});

describe("state", () => {
  it("coalesces 200 keystrokes over 10 s into at most 21 state-set messages", async () => {
    const r = await rig(`<spur-textarea id="note" name="n"></spur-textarea>`);
    const area = r.doc.querySelector("textarea") as HTMLTextAreaElement;
    for (let i = 0; i < 200; i += 1) {
      area.value = "x".repeat(i + 1);
      area.dispatchEvent(new r.win.Event("input", { bubbles: true }));
      r.advance(50);
    }
    r.advance(1000);
    const states = r.ofType("state-set");
    expect(states.length).toBeLessThanOrEqual(21);
    expect(states.length).toBeGreaterThan(5);
    expect(r.sent.length).toBeLessThan(100);
    expect(states[states.length - 1]?.controls).toEqual([{ id: "note", value: "x".repeat(200) }]);
  });

  it("state.set persists through one trailing message and throws over 64 KiB", async () => {
    const r = await rig("");
    r.win.spur.state.set({ a: 1 });
    r.win.spur.state.set({ a: 2 });
    expect(r.ofType("state-set")).toHaveLength(0);
    r.advance(500);
    expect(r.ofType("state-set")).toEqual([
      { type: "state-set", callId: expect.any(String), app: { a: 2 }, controls: [] },
    ]);
    expect(r.win.spur.state.get()).toEqual({ a: 2 });
    expect(() => r.win.spur.state.set("x".repeat(70_000))).toThrow("snippet state over 64 KiB");
  });

  it("restores control values by id, choices only when the value exists", async () => {
    const r = await rig(FORM, { booted: false });
    r.connect({
      controls: [
        { id: "note", value: "kept text" },
        { id: "pick", value: ["a", "zzz"] },
      ],
    });
    expect((r.doc.querySelector("#note textarea") as HTMLTextAreaElement).value).toBe("kept text");
    expect(fieldValue(r.doc.getElementById("pick"))).toEqual([]);
    const r2 = await rig(FORM, { booted: false });
    r2.connect({ controls: [{ id: "pick", value: ["b"] }] });
    expect(fieldValue(r2.doc.getElementById("pick"))).toEqual(["b"]);
  });
});

describe("resize", () => {
  it("reports the root rect height only when it changes, including shrinking", async () => {
    const r = await rig("");
    r.frame();
    expect(r.ofType("resize")).toEqual([{ type: "resize", height: 100 }]);
    r.frame();
    r.win.document.body.appendChild(r.doc.createElement("p"));
    r.advance(0);
    await flush();
    r.frame();
    expect(r.ofType("resize")).toHaveLength(1);
    r.height.value = 300.2;
    r.win.document.body.appendChild(r.doc.createElement("p"));
    await flush();
    r.frame();
    r.height.value = 120;
    r.win.document.body.appendChild(r.doc.createElement("p"));
    await flush();
    r.frame();
    expect(r.ofType("resize").map((m) => m.height)).toEqual([100, 301, 120]);
  });

  it("limits reports to one per animation frame", async () => {
    const r = await rig("");
    r.height.value = 150;
    for (let i = 0; i < 5; i += 1) r.win.document.body.appendChild(r.doc.createElement("p"));
    await flush();
    r.height.value = 160;
    r.frame();
    expect(r.ofType("resize").map((m) => m.height)).toEqual([160]);
  });
});

describe("busy and availability", () => {
  const controls = () => [
    "#plain",
    "#choose",
    "#modify",
    "#pick",
    "spur-choice",
    "spur-text-input",
    "#note",
  ];

  function disabledStates(r: Rig): boolean[] {
    return controls().flatMap((selector) =>
      [...r.doc.querySelectorAll(selector)].map((node) => node.hasAttribute("disabled")),
    );
  }

  it("disables every bound control with aria-busy during a non-terminal action and restores on terminal", async () => {
    const r = await rig(FORM);
    expect(disabledStates(r).every((state) => !state)).toBe(true);
    r.fromHost({
      type: "action",
      action: { requestId: "r", actionId: "go", status: "submitting" },
    });
    expect(disabledStates(r).every(Boolean)).toBe(true);
    for (const node of r.doc.querySelectorAll(
      "spur-button, #plain, spur-choice-list, spur-textarea",
    )) {
      expect(node.getAttribute("aria-busy")).toBe("true");
    }
    r.fromHost({
      type: "action",
      action: { requestId: "r", actionId: "go", status: "processing" },
    });
    expect(disabledStates(r).every(Boolean)).toBe(true);
    r.fromHost({ type: "action", action: { requestId: "r", actionId: "go", status: "completed" } });
    expect(disabledStates(r).every((state) => !state)).toBe(true);
    expect(r.doc.querySelector("[aria-busy]")).toBeNull();
  });

  it("awaiting_confirm counts as busy", async () => {
    const r = await rig(FORM);
    r.fromHost({
      type: "action",
      action: { requestId: "r", actionId: "go", status: "awaiting_confirm" },
    });
    expect(disabledStates(r).every(Boolean)).toBe(true);
  });

  it("shows the spinner only on the invoking control", async () => {
    const r = await rig(FORM);
    r.click("#choose");
    r.fromHost({
      type: "action",
      action: { requestId: "r", actionId: "choose", status: "submitting" },
    });
    expect(r.doc.querySelector("#choose .spur-spin")).not.toBeNull();
    expect(r.doc.querySelector("#modify .spur-spin")).toBeNull();
    r.fromHost({
      type: "action",
      action: { requestId: "r", actionId: "choose", status: "completed" },
    });
    expect(r.doc.querySelector("#choose .spur-spin")).toBeNull();
  });

  it("revision_conflict and session_unavailable disable the same set without aria-busy; canInvoke true restores", async () => {
    const r = await rig(FORM);
    r.fromHost({
      type: "availability",
      availability: { canInvoke: false, reason: "revision_conflict" },
    });
    expect(disabledStates(r).every(Boolean)).toBe(true);
    expect(r.doc.querySelector("[aria-busy]")).toBeNull();
    r.fromHost({ type: "availability", availability: { canInvoke: true, reason: null } });
    expect(disabledStates(r).every((state) => !state)).toBe(true);
    r.fromHost({
      type: "availability",
      availability: { canInvoke: false, reason: "session_unavailable" },
    });
    expect(disabledStates(r).every(Boolean)).toBe(true);
  });

  it("does not clear a disabled attribute the author set", async () => {
    const r = await rig(`<button id="own" data-spur-action="go" disabled>x</button>`);
    r.fromHost({ type: "action", action: { requestId: "r", actionId: "go", status: "queued" } });
    r.fromHost({ type: "action", action: { requestId: "r", actionId: "go", status: "completed" } });
    expect(r.doc.getElementById("own")?.hasAttribute("disabled")).toBe(true);
  });

  it("a disabled control does not invoke", async () => {
    const r = await rig(FORM);
    r.fromHost({
      type: "availability",
      availability: { canInvoke: false, reason: "revision_conflict" },
    });
    r.click("#plain");
    r.click("#choose");
    expect(r.ofType("invoke")).toHaveLength(0);
  });
});

describe("library payloads", () => {
  it("builds form payloads: fields win over static payload, empty optional strings omitted", async () => {
    const r = await rig(
      `${FORM.replace('<spur-button id="choose" action="choose" form="f" variant="primary">', `<spur-button id="choose" action="choose" form="f" payload='{"instruction":"static","extra":1}'>`)}`,
    );
    const pick = r.doc.getElementById("pick");
    r.click("spur-choice[value=a]");
    r.click("spur-choice[value=b]");
    expect(fieldValue(pick)).toEqual(["a", "b"]);
    (r.doc.querySelector("#note textarea") as HTMLTextAreaElement).value = "shorter";
    r.click("#choose");
    expect(r.ofType("invoke")[0]).toMatchObject({
      actionId: "choose",
      payload: { instruction: "shorter", extra: 1 },
    });
    expect((r.ofType("invoke")[0]?.payload as Msg).title).toBeUndefined();
  });

  it("single mode keeps one choice and Enter in a text input submits the form", async () => {
    const r = await rig(
      `<spur-choice-list name="one"><spur-choice value="x">x</spur-choice><spur-choice value="y">y</spur-choice></spur-choice-list>
       <spur-form action="go"><spur-text-input name="title"></spur-text-input></spur-form>`,
    );
    r.click("spur-choice[value=x]");
    r.click("spur-choice[value=y]");
    expect(fieldValue(r.doc.querySelector("spur-choice-list"))).toBe("y");
    const input = r.doc.querySelector("input") as HTMLInputElement;
    input.value = "hi";
    input.dispatchEvent(new r.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(r.ofType("invoke")[0]).toMatchObject({ actionId: "go", payload: { title: "hi" } });
  });

  it("data-spur-action elements invoke with data-spur-payload", async () => {
    const r = await rig(FORM);
    r.click("#plain");
    expect(r.ofType("invoke")[0]).toMatchObject({ actionId: "go", payload: { n: 1 } });
  });

  it("reads a selection with UTF-16 offsets and adds it through the toolbar", async () => {
    const r = await rig(FORM);
    const text = r.doc.querySelector('spur-selectable-text[source-id="va"]') as HTMLElement;
    const node = text.firstChild as Text;
    expect(node.data).toBe("alpha 😀 text");
    const range = r.doc.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 8);
    const selection = r.win.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(r.win.spur.selection()).toEqual({
      sourceId: "va",
      text: "alpha 😀 text",
      start: 6,
      end: 8,
      quote: "😀",
    });
    expect(r.win.spur.selection("vb")).toBeNull();
    r.doc.dispatchEvent(new r.win.Event("selectionchange"));
    const toolbar = r.doc.querySelector("spur-selection-toolbar") as HTMLElement;
    expect(toolbar.hasAttribute("data-visible")).toBe(true);
    expect(toolbar.textContent).toContain("2 chars");
    r.click("#modify");
    expect(r.ofType("invoke")[0]).toMatchObject({
      actionId: "modify-selection",
      payload: { selection: { sourceId: "va", start: 6, end: 8, quote: "😀" } },
    });
  });

  it("hides the toolbar when the selection leaves the listed sources", async () => {
    const r = await rig(
      `<spur-selectable-text source-id="zz">hello</spur-selectable-text><spur-selection-toolbar for="va"></spur-selection-toolbar>`,
    );
    const node = r.doc.querySelector("spur-selectable-text")!.firstChild as Text;
    const range = r.doc.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 3);
    r.win.getSelection()!.addRange(range);
    r.doc.dispatchEvent(new r.win.Event("selectionchange"));
    expect(r.doc.querySelector("spur-selection-toolbar")!.hasAttribute("data-visible")).toBe(false);
  });
});

describe("rejections", () => {
  const issues = [{ path: "/instruction", code: "max_length" }];

  it("maps issue paths to the named field with aria-invalid and a message", async () => {
    const r = await rig(`${FORM}<spur-status></spur-status>`);
    void r.win.spur.invoke("regenerate", { instruction: "x" });
    r.fromHost({
      type: "invoke-result",
      callId: lastCallId(r),
      ok: false,
      reason: "invalid_payload",
      issues,
    });
    await flush();
    const area = r.doc.querySelector("#note textarea") as HTMLTextAreaElement;
    expect(area.getAttribute("aria-invalid")).toBe("true");
    const describedBy = area.getAttribute("aria-describedby") as string;
    expect(r.doc.getElementById(describedBy)?.textContent).toBe("max length");
    expect(r.doc.querySelector("spur-status")?.textContent).toContain("/instruction max length");
    // typing clears the field issue
    area.dispatchEvent(new r.win.Event("input", { bubbles: true }));
    expect(area.hasAttribute("aria-invalid")).toBe(false);
  });

  it("without spur-status renders one fallback per rejection, replaces its text, removes it on the next ok", async () => {
    const r = await rig(FORM.replace("<spur-textarea", "<spur-textarea"));
    const reject = async (reason: string, extra: Msg = {}) => {
      const pending = r.win.spur.invoke("go", {});
      r.fromHost({ type: "invoke-result", callId: lastCallId(r), ok: false, reason, ...extra });
      return pending;
    };
    const before = r.sent.length;
    for (const reason of ["unknown_action", "busy"]) {
      const result = await reject(reason);
      const fallback = r.doc.querySelectorAll("[data-spur-fallback]");
      expect(fallback).toHaveLength(1);
      expect(fallback[0]?.tagName).toBe("SPUR-ERROR");
      expect(fallback[0]?.getAttribute("role")).toBe("alert");
      expect(fallback[0]?.textContent).toBe(r.win.spur.formatRejection(result));
      expect(r.doc.body.lastElementChild).toBe(fallback[0]);
    }
    const invalid = await reject("invalid_payload", { issues });
    expect(r.doc.querySelectorAll("[data-spur-fallback]")).toHaveLength(1);
    expect(r.doc.querySelector("[data-spur-fallback]")?.textContent).toBe(
      "Invalid payload.\n/instruction max length",
    );
    expect(r.win.spur.formatRejection(invalid)).toContain("/instruction max length");
    const pending = r.win.spur.invoke("go", {});
    r.fromHost({ type: "invoke-result", callId: lastCallId(r), ok: true, requestId: "req-1" });
    await pending;
    expect(r.doc.querySelector("[data-spur-fallback]")).toBeNull();
    // only invoke messages were sent; the fallback itself sends nothing
    expect(r.sent.slice(before).every((m) => m.type === "invoke")).toBe(true);
    expect(r.ofType("state-set")).toHaveLength(0);
  });

  it("with spur-status present no fallback renders and the status shows the same text", async () => {
    const r = await rig("<spur-status></spur-status>");
    const pending = r.win.spur.invoke("nope", {});
    r.fromHost({
      type: "invoke-result",
      callId: lastCallId(r),
      ok: false,
      reason: "unknown_action",
    });
    const result = await pending;
    expect(r.doc.querySelector("[data-spur-fallback]")).toBeNull();
    expect(r.doc.querySelector(".spur-status-note")?.textContent).toBe(
      r.win.spur.formatRejection(result),
    );
  });

  it("spur-status shows labels, a spinner when non-terminal and a Retry that calls retry()", async () => {
    const r = await rig("<spur-status></spur-status>");
    const status = r.doc.querySelector("spur-status")!;
    expect(status.hasAttribute("data-active")).toBe(false);
    r.fromHost({ type: "action", action: { requestId: "r", actionId: "go", status: "queued" } });
    expect(status.textContent).toContain("Queued");
    expect(status.querySelector(".spur-spin")).not.toBeNull();
    r.fromHost({
      type: "action",
      action: { requestId: "r", actionId: "go", status: "error", httpStatus: 409 },
    });
    expect(status.textContent).toContain("Send failed · HTTP 409");
    expect(status.querySelector(".spur-spin")).toBeNull();
    (status.querySelector("[data-spur-retry]") as HTMLButtonElement).dispatchEvent(
      new r.win.MouseEvent("click", { bubbles: true }),
    );
    expect(r.ofType("invoke")[0]).toMatchObject({ actionId: "go", retryOf: "r" });
  });
});

describe("fullscreen and escape", () => {
  it("requestFullscreen resolves with the host grant and Escape forwards only while fullscreen", async () => {
    const r = await rig("");
    const pending = r.win.spur.requestFullscreen();
    expect(r.ofType("fullscreen")[0]).toMatchObject({ open: true });
    r.fromHost({
      type: "fullscreen",
      callId: lastCallId(r, "fullscreen"),
      granted: false,
      fullscreen: false,
    });
    await expect(pending).resolves.toBe(false);

    const key = () =>
      r.doc.dispatchEvent(new r.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    key();
    expect(r.ofType("escape")).toHaveLength(0);
    const events: unknown[] = [];
    r.win.spur.on("fullscreen", (e: unknown) => events.push(e));
    r.fromHost({ type: "fullscreen", fullscreen: true });
    expect(events).toEqual([{ fullscreen: true }]);
    key();
    expect(r.ofType("escape")).toHaveLength(1);
    r.win.spur.exitFullscreen();
    expect(r.ofType("fullscreen").at(-1)).toMatchObject({ open: false });
  });
});
