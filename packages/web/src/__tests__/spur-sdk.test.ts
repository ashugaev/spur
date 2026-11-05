// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  SNIPPET_STATUS_LABELS,
  SNIPPET_THEME_TOKENS,
  SNIPPET_TO_FRAME,
  SNIPPET_TO_HOST,
  SNIPPET_WINDOW_MSG,
} from "@/lib/snippets/snippet-protocol";
import { flush, portRig, sdkSource } from "./fixtures/spur-sdk-rig";

// Snippet frame (port transport) behavior of the one SDK, plus the component library.

const FORM = `
  <spur-choice-list id="pick" name="selected" mode="multiple">
    <spur-choice value="a"><spur-selectable-text source-id="va">alpha text</spur-selectable-text></spur-choice>
    <spur-choice value="b">beta</spur-choice>
  </spur-choice-list>
  <spur-form id="f" action="regenerate">
    <spur-text-input name="title" maxlength="20" label="Title"></spur-text-input>
    <spur-textarea id="note" name="instruction" maxlength="100" label="Instruction"></spur-textarea>
  </spur-form>
  <spur-button id="choose" action="choose" form="f" variant="primary">Choose</spur-button>
  <spur-status></spur-status>
  <button id="plain" data-spur-action="go" data-spur-payload='{"n":1}'>Plain</button>
`;

describe("handshake", () => {
  it("says hello with protocol 2 at most 25 times and stops on connect", async () => {
    const r = await portRig("", { booted: false });
    expect(r.hellos[0]).toEqual({ type: "spur:hello", protocolVersion: 2, nonce: "n0nce" });
    r.advance(200 * 3);
    expect(r.hellos).toHaveLength(4);
    r.connect();
    r.advance(200 * 30);
    expect(r.hellos).toHaveLength(4);
  });

  it("resolves ready with the context, applies theme tokens and color-scheme", async () => {
    const r = await portRig("", { booted: false });
    const ready = r.win.spur.ready();
    r.connect({ fonts: [{ family: "Spur Mono", weight: "400", data: new ArrayBuffer(2) }] });
    await expect(ready).resolves.toMatchObject({ snippetId: "picker" });
    const root = r.doc.documentElement;
    for (const token of SNIPPET_THEME_TOKENS) {
      expect(root.style.getPropertyValue(`--spur-${token}`)).toBe(`v-${token}`);
    }
    expect(root.style.colorScheme).toBe("dark");
    expect(r.fonts).toEqual([{ family: "Spur Mono" }]);
  });
});

describe("constants", () => {
  it("message type strings equal snippet-protocol", () => {
    const strings = [
      ...Object.values(SNIPPET_WINDOW_MSG),
      ...Object.values(SNIPPET_TO_HOST),
      ...Object.values(SNIPPET_TO_FRAME),
    ];
    const block = /const MSG = \{([\s\S]*?)\};/.exec(sdkSource)?.[1] ?? "";
    const declared = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect([...declared].sort()).toEqual([...new Set(strings)].sort());
  });

  it("status labels match the host labels", () => {
    const block = /const STATUS_LABELS = \{([\s\S]*?)\};/.exec(sdkSource)?.[1] ?? "";
    const declared = Object.fromEntries(
      [...block.matchAll(/(\w+): "([^"]+)"/g)].map((match) => [match[1], match[2]]),
    );
    for (const [status, label] of Object.entries(declared)) {
      if (status === "error") expect(label).toBe("Send failed");
      else expect(SNIPPET_STATUS_LABELS[status as keyof typeof SNIPPET_STATUS_LABELS]).toBe(label);
    }
  });
});

describe("agent.invoke over the port", () => {
  it("posts invoke and resolves with the host's final result shape", async () => {
    const r = await portRig("");
    const pending = r.win.spur.agent.invoke("go", { a: 1 });
    expect(r.ofType("invoke")).toEqual([
      { type: "invoke", action: "go", payload: { a: 1 }, callId: expect.any(String) },
    ]);
    r.reply("invoke-result", { ok: true, id: "act-1", result: { picked: 2 } });
    await expect(pending).resolves.toEqual({ ok: true, id: "act-1", result: { picked: 2 } });
  });

  it("marks trusted clicks and forwards retry without a payload", async () => {
    const r = await portRig(FORM);
    r.click("#choose");
    expect(r.ofType("invoke")[0]).toMatchObject({ action: "choose" });
    // Synthetic clicks are untrusted: no trusted flag.
    expect(r.ofType("invoke")[0]).not.toHaveProperty("trusted");
    r.fromHost({ type: "action", action: { id: "act-1", action: "choose", status: "error" } });
    r.reply("invoke-result", { ok: false, reason: "failed", id: "act-1", error: "boom" });
    await flush();
    void r.win.spur.agent.retry();
    expect(r.ofType("invoke")[1]).toMatchObject({ type: "invoke", action: "choose", retry: true });
  });

  it("returns not_connected before connect and never posts", async () => {
    const r = await portRig("", { booted: false });
    await expect(r.win.spur.agent.invoke("go", {})).resolves.toEqual({
      ok: false,
      reason: "not_connected",
    });
    expect(r.sent).toHaveLength(0);
  });

  it("disables bound controls with aria-busy while the action is not terminal", async () => {
    const r = await portRig(FORM);
    r.fromHost({ type: "action", action: { id: "act-1", action: "choose", status: "queued" } });
    await flush();
    expect(r.doc.querySelector("#choose")?.getAttribute("aria-busy")).toBe("true");
    expect(r.doc.querySelector("#choose")?.hasAttribute("disabled")).toBe(true);
    r.fromHost({ type: "action", action: { id: "act-1", action: "choose", status: "completed" } });
    await flush();
    expect(r.doc.querySelector("#choose")?.hasAttribute("aria-busy")).toBe(false);
    expect(r.doc.querySelector("#choose")?.hasAttribute("disabled")).toBe(false);
  });

  it("shows a pre-delivery rejection in spur-status", async () => {
    const r = await portRig(FORM);
    const pending = r.win.spur.agent.invoke("go", {});
    r.reply("invoke-result", { ok: false, reason: "payload_too_large" });
    await pending;
    expect(r.doc.querySelector("spur-status")?.textContent).toContain("Payload is too large.");
  });

  it("builds form payloads and data-spur-action payloads", async () => {
    const r = await portRig(FORM);
    const input = r.doc.querySelector("spur-text-input input") as HTMLInputElement;
    input.value = "Dune";
    r.click("#choose");
    expect(r.ofType("invoke")[0]).toMatchObject({ payload: { title: "Dune" } });
    r.reply("invoke-result", { ok: false, reason: "declined" });
    await flush();
    r.click("#plain");
    expect(r.ofType("invoke")[1]).toMatchObject({ action: "go", payload: { n: 1 } });
  });
});

describe("db, state and agent over the port", () => {
  it("sends db requests by relative path and never names a store", async () => {
    const r = await portRig("");
    const added = r.win.spur.db.collection("items").add({ title: "Dune" });
    await flush();
    expect(r.ofType("db")[0]).toEqual({
      type: "db",
      method: "POST",
      path: "docs/items",
      body: { data: { title: "Dune" } },
      callId: expect.any(String),
    });
    r.reply("db", { ok: true, status: 201, body: { id: "d1", rev: 1, data: { title: "Dune" } } });
    await expect(added).resolves.toMatchObject({ id: "d1" });
    expect(JSON.stringify(r.ofType("db"))).not.toContain("session:");
  });

  it("subscribes once for snapshots and reruns the query on db-change", async () => {
    const r = await portRig("");
    const seen: unknown[] = [];
    const off = r.win.spur.db.collection("items").onSnapshot((docs) => seen.push(docs));
    await flush();
    expect(r.ofType("db-subscribe")).toEqual([{ type: "db-subscribe", store: "session:sp-ab12" }]);
    r.reply("db", { ok: true, status: 200, body: { docs: [{ id: "a" }] } });
    await flush();
    r.fromHost({ type: "db-change", change: { seq: 1, collection: "items", id: "b", op: "set" } });
    await flush();
    r.reply("db", { ok: true, status: 200, body: { docs: [{ id: "a" }, { id: "b" }] } });
    await flush();
    expect(seen).toEqual([[{ id: "a" }], [{ id: "a" }, { id: "b" }]]);
    off();
    expect(r.ofType("db-unsubscribe")).toHaveLength(1);
  });

  it("coalesces state writes into one trailing state-set and throws over 64 KiB", async () => {
    const r = await portRig("");
    for (let index = 0; index < 50; index++) r.win.spur.state.set({ index });
    r.advance(500);
    expect(r.ofType("state-set")).toEqual([
      { type: "state-set", app: { index: 49 }, controls: [] },
    ]);
    // RangeError of the JSDOM realm: match by message.
    expect(() => r.win.spur.state.set({ big: "x".repeat(70_000) })).toThrow("over 64 KiB");
  });

  it("reads state and controls from the connect context", async () => {
    const r = await portRig(FORM, { booted: false });
    r.connect({ state: { tab: 2 }, controls: [{ id: "note", value: "saved" }] });
    await flush();
    expect(r.win.spur.state.get()).toEqual({ tab: 2 });
    const note = r.doc.querySelector("#note textarea") as HTMLTextAreaElement;
    expect(note.value).toBe("saved");
  });

  it("agent send carries userGesture only from trusted events", async () => {
    const r = await portRig("");
    void r.win.spur.agent.send("hello");
    expect(r.ofType("agent")[0]).toMatchObject({
      type: "agent",
      op: "send",
      message: "hello",
      userGesture: false,
    });
  });

  it("forwards agent-event status to listeners", async () => {
    const r = await portRig("");
    const states: unknown[] = [];
    r.win.spur.on("agent", (status) => states.push(status));
    r.fromHost({ type: "agent-event", status: { state: "working", sessionId: "sp-ab12" } });
    expect(states).toEqual([{ state: "working", sessionId: "sp-ab12" }]);
  });
});

describe("frame host plumbing", () => {
  it("reports height changes once per frame", async () => {
    const r = await portRig("");
    r.frame();
    expect(r.ofType("resize")).toEqual([{ type: "resize", height: 100 }]);
    r.height.value = 140;
    r.doc.body.appendChild(r.doc.createElement("div"));
    await flush();
    r.frame();
    expect(r.ofType("resize").at(-1)).toEqual({ type: "resize", height: 140 });
  });

  it("requestFullscreen resolves with the host grant", async () => {
    const r = await portRig("");
    const granted = r.win.spur.requestFullscreen();
    r.reply("fullscreen", { granted: true, fullscreen: true });
    await expect(granted).resolves.toBe(true);
  });
});
