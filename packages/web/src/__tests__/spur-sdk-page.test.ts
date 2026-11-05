// @vitest-environment node
import { describe, expect, it } from "vitest";
import { flush, pageRig } from "./fixtures/spur-sdk-rig";

// Page transport (/p/<id>/): fetch to ./_spur/*, one EventSource on ./_spur/events.

describe("page transport", () => {
  it("opens exactly one EventSource on ./_spur/events and loads _state/page", async () => {
    const r = await pageRig("");
    expect(r.sources.map((source) => source.url)).toEqual(["./_spur/events"]);
    expect(r.requests[0]).toMatchObject({ method: "GET", url: "./_spur/db/docs/_state/page" });
    r.win.spur.db.collection("a").onSnapshot(() => undefined);
    r.win.spur.db.collection("b").onSnapshot(() => undefined);
    await flush();
    expect(r.sources).toHaveLength(1);
  });

  it("applies CSS system colors as theme defaults", async () => {
    const r = await pageRig("");
    const root = r.doc.documentElement;
    expect(root.style.getPropertyValue("--spur-bg-base")).toBe("Canvas");
    expect(root.style.getPropertyValue("--spur-text-primary")).toBe("CanvasText");
    expect(root.style.getPropertyValue("--spur-accent")).toBe("AccentColor");
  });

  it("reruns onSnapshot after a change event for its collection only", async () => {
    const r = await pageRig("");
    let docs = [{ id: "a" }];
    r.respond((method, url) =>
      method === "POST" && url === "./_spur/db/query/items" ? [200, { docs }] : undefined,
    );
    const seen: unknown[] = [];
    r.win.spur.db.collection("items").onSnapshot((next) => seen.push(next));
    await flush();
    docs = [{ id: "a" }, { id: "b" }];
    r.sources[0]?.emit("change", { seq: 1, collection: "other", id: "x", op: "set" }, "1");
    await flush();
    expect(seen).toHaveLength(1);
    r.sources[0]?.emit("change", { seq: 2, collection: "items", id: "b", op: "set" }, "2");
    await flush();
    expect(seen).toEqual([[{ id: "a" }], [{ id: "a" }, { id: "b" }]]);
    r.sources[0]?.emit("reset", { lastSeq: 9 });
    await flush();
    expect(seen).toHaveLength(3);
  });

  it("reloads the page on a reload event", async () => {
    const r = await pageRig("");
    r.sources[0]?.emit("reload", { path: "index.html" });
    expect(r.reloads).toBe(1);
  });

  it("emits agent status events", async () => {
    const r = await pageRig("");
    const states: unknown[] = [];
    r.win.spur.on("agent", (status) => states.push(status));
    r.sources[0]?.emit("agent", { state: "working", sessionId: "pg-films-ab12" });
    expect(states).toEqual([{ state: "working", sessionId: "pg-films-ab12" }]);
  });

  it("resolves agent.invoke from the _actions doc reached through the stream", async () => {
    const r = await pageRig("");
    let status = "pending";
    r.respond((method, url, body) => {
      if (method === "POST" && url === "./_spur/actions") {
        const id = (body as { id: string }).id;
        return [200, { id, rev: 1, data: { action: "pick", status: "pending" } }];
      }
      if (method === "GET" && url.startsWith("./_spur/db/docs/_actions/")) {
        const id = decodeURIComponent(url.split("/").at(-1) ?? "");
        return [
          200,
          {
            id,
            rev: 2,
            data: { action: "pick", status, ...(status === "done" ? { result: { ok: 1 } } : {}) },
          },
        ];
      }
      return undefined;
    });
    const pending = r.win.spur.agent.invoke("pick", { film: "Dune" });
    await flush();
    const post = r.requests.find((request) => request.url === "./_spur/actions");
    expect(post?.body).toMatchObject({
      action: "pick",
      payload: { film: "Dune" },
      source: { kind: "page" },
    });
    expect(post?.body).not.toHaveProperty("userGesture");
    const id = (post?.body as { id: string }).id;
    expect(r.win.spur.action).toMatchObject({ id, status: "queued" });
    status = "done";
    r.sources[0]?.emit("change", { seq: 3, collection: "_actions", id, op: "set", rev: 2 }, "3");
    await expect(pending).resolves.toEqual({ ok: true, id, result: { ok: 1 } });
    expect(r.win.spur.action).toMatchObject({ id, status: "completed" });
  });

  it("chat sends, polls messages and renders text inertly", async () => {
    const r = await pageRig("<spur-chat></spur-chat>");
    r.respond((method, url) => {
      if (method === "GET" && url.startsWith("./_spur/agent/messages")) {
        return [
          200,
          {
            sessionId: "pg-films-ab12",
            nextFrom: 2,
            status: { state: "idle", sessionId: "pg-films-ab12" },
            messages: [
              { index: 0, role: "user", text: "hi" },
              { index: 1, role: "assistant", text: '<img src=x onerror="window.pwned=1">' },
            ],
          },
        ];
      }
      if (method === "POST" && url === "./_spur/agent/send")
        return [200, { sessionId: "pg-films-ab12" }];
      return undefined;
    });
    await flush();
    // The first poll ran at ready, before this responder; the next one is 2 s later.
    r.advance(2000);
    await flush();
    const log = r.doc.querySelector(".spur-chat-log");
    expect(log?.children).toHaveLength(2);
    expect(log?.querySelector("img")).toBeNull();
    expect(log?.textContent).toContain("<img src=x");
    expect(r.win.pwned).toBeUndefined();
    expect(r.doc.querySelector(".spur-chat-status")?.textContent).toBe("Agent idle");

    const input = r.doc.querySelector(".spur-chat-form input") as HTMLInputElement;
    input.value = "suggest films";
    const form = r.doc.querySelector(".spur-chat-form") as HTMLFormElement;
    form.dispatchEvent(new r.win.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const send = r.requests.find((request) => request.url === "./_spur/agent/send");
    // A synthetic submit is untrusted: no user gesture.
    expect(send?.body).toEqual({ message: "suggest films", userGesture: false });
    r.advance(2000);
    await flush();
    expect(
      r.requests.filter((request) => request.url.startsWith("./_spur/agent/messages")).at(-1)?.url,
    ).toBe("./_spur/agent/messages?from=2");
  });

  it("renders an action message as a tagged label line and spaces the status off the log", async () => {
    const r = await pageRig("<style>spur-chat{display:block}</style><spur-chat></spur-chat>");
    r.respond((method, url) =>
      method === "GET" && url.startsWith("./_spur/agent/messages")
        ? [
            200,
            {
              sessionId: "pg-films-ab12",
              nextFrom: 2,
              status: { state: "idle", sessionId: "pg-films-ab12" },
              messages: [
                { index: 0, role: "user", kind: "action", text: "Pick film" },
                { index: 1, role: "assistant", kind: "reply", text: "Picked." },
              ],
            },
          ]
        : undefined,
    );
    await flush();
    r.advance(2000);
    await flush();
    const [action, reply] = Array.from(r.doc.querySelectorAll(".spur-chat-msg"));
    expect(action?.getAttribute("data-kind")).toBe("action");
    expect(action?.querySelector(".spur-chat-tag")?.textContent).toBe("Action");
    expect(action?.textContent).toBe("ActionPick film");
    expect(reply?.getAttribute("data-kind")).toBe("reply");
    expect(reply?.textContent).toBe("Picked.");
    const log = r.doc.querySelector(".spur-chat-log") as Element;
    expect(r.win.getComputedStyle(log).marginTop).toBe("8px");
  });

  it("restarts the message cursor when the agent session changes", async () => {
    const r = await pageRig("");
    let sessionId = "pg-films-aaaa";
    r.respond((method, url) => {
      if (method !== "GET" || !url.startsWith("./_spur/agent/messages")) return undefined;
      const from = Number(new URL(url, "http://host/").searchParams.get("from") ?? "0");
      const messages = [0, 1]
        .filter((index) => index >= from)
        .map((index) => ({ index, role: "assistant", text: `${sessionId} #${index}` }));
      return [200, { sessionId, nextFrom: 2, status: { state: "idle", sessionId }, messages }];
    });
    const texts: string[] = [];
    r.win.spur.agent.onMessage((message: { text: string }) => texts.push(message.text));
    await flush();
    r.advance(2000);
    await flush();
    sessionId = "pg-films-bbbb";
    r.advance(2000);
    await flush();
    expect(texts).toEqual([
      "pg-films-aaaa #0",
      "pg-films-aaaa #1",
      "pg-films-bbbb #0",
      "pg-films-bbbb #1",
    ]);
    r.advance(2000);
    await flush();
    expect(
      r.requests.filter((request) => request.url.startsWith("./_spur/agent/messages")).at(-1)?.url,
    ).toBe("./_spur/agent/messages?from=2");
  });

  it("drops a malformed stream frame and keeps handling the next one", async () => {
    const r = await pageRig("");
    const states: unknown[] = [];
    r.win.spur.on("agent", (status) => states.push(status));
    expect(() => r.sources[0]?.emitRaw("change", "{not json")).not.toThrow();
    expect(() => r.sources[0]?.emitRaw("agent", "{not json")).not.toThrow();
    r.sources[0]?.emit("agent", { state: "working", sessionId: "pg-films-ab12" });
    expect(states).toEqual([{ state: "working", sessionId: "pg-films-ab12" }]);
  });

  it("saves state to _state/page, debounced", async () => {
    const r = await pageRig("");
    r.win.spur.state.set({ tab: 1 });
    r.win.spur.state.set({ tab: 2 });
    r.advance(500);
    await flush();
    const writes = r.requests.filter(
      (request) => request.method === "POST" && request.url === "./_spur/db/docs/_state/page",
    );
    expect(writes).toEqual([
      {
        method: "POST",
        url: "./_spur/db/docs/_state/page",
        body: { data: { app: { tab: 2 }, controls: [] } },
      },
    ]);
  });
});
