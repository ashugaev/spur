// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { flush, pageRig, sdkSource } from "./fixtures/spur-sdk-rig";

// Page transport stays at the Page root, including nested documents.

describe("page transport", () => {
  it("uses one root widget/connection on nested HTML and consumes create-open once", async () => {
    const r = await pageRig("<p>App</p>", "/p/films/nested/index.html?chat=open&keep=1");
    r.win.eval(sdkSource);
    await flush();
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]?.url).toBe("/p/films/_spur/events");
    expect(r.doc.querySelectorAll("[data-spur-page-widget]")).toHaveLength(1);
    expect(r.win.location.search).toBe("?keep=1");
    const root = r.doc.querySelector("[data-spur-page-widget]")?.shadowRoot;
    const input = root?.querySelector("textarea") as HTMLTextAreaElement;
    const close = root?.querySelector('[aria-label="Close agent chat"]') as HTMLButtonElement;
    input.value = "keep draft";
    close.click();
    expect(root?.querySelector("iframe")).toBeNull();
    (root?.querySelector('[aria-label="Open agent chat"]') as HTMLButtonElement).click();
    expect(input.value).toBe("keep draft");
    expect(root?.querySelector("iframe")).not.toBeNull();
  });
  it("accepts only its live voice frame and nonce, inserts at selection, never sends", async () => {
    const r = await pageRig("", "/p/films/?chat=open");
    const root = r.doc.querySelector("[data-spur-page-widget]")?.shadowRoot;
    const input = root?.querySelector("textarea") as HTMLTextAreaElement;
    const frame = root?.querySelector("iframe") as HTMLIFrameElement;
    const query = new URL(frame.src).searchParams;
    const data = {
      type: "spur:voice-transcript",
      page: "films",
      chat: query.get("chat"),
      nonce: query.get("nonce"),
      text: "voice",
    };
    input.value = "A  Z";
    input.setSelectionRange(2, 2);
    r.win.dispatchEvent(
      new r.win.MessageEvent("message", {
        origin: "https://foreign.test",
        source: frame.contentWindow,
        data,
      }),
    );
    expect(input.value).toBe("A  Z");
    r.win.dispatchEvent(
      new r.win.MessageEvent("message", {
        origin: "http://host",
        source: frame.contentWindow,
        data: { ...data, nonce: "wrong" },
      }),
    );
    expect(input.value).toBe("A  Z");
    r.win.dispatchEvent(
      new r.win.MessageEvent("message", {
        origin: "http://host",
        source: frame.contentWindow,
        data,
      }),
    );
    expect(input.value).toBe("A voice Z");
    expect(r.requests.filter((entry) => entry.url.endsWith("agent/send"))).toHaveLength(0);
    input.value = "x".repeat(20000);
    input.setSelectionRange(20000, 20000);
    r.win.dispatchEvent(
      new r.win.MessageEvent("message", {
        origin: "http://host",
        source: frame.contentWindow,
        data,
      }),
    );
    expect(root?.querySelector(".spur-chat-status")?.textContent).toContain("exceeds");
    expect(input.value).toHaveLength(20000);
  });
  it("opens exactly one root EventSource and loads _state/page", async () => {
    const r = await pageRig("");
    expect(r.sources.map((source) => source.url)).toEqual(["/p/films/_spur/events"]);
    expect(r.requests[0]).toMatchObject({
      method: "GET",
      url: "/p/films/_spur/db/docs/_state/page",
    });
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
    expect(root.style.getPropertyValue("--spur-status-error")).toBe("");
    const link = r.doc.querySelector("link[data-spur-sdk-palette]");
    expect(link?.getAttribute("href")).toBe("/p/films/_spur/theme.css");
  });

  it("palette stylesheet defines the fixed tones as light-dark pairs", () => {
    const css = readFileSync(
      resolve(__dirname, "../../public/spur/spur-page-theme.v2.css"),
      "utf8",
    );
    for (const token of [
      "text-tertiary",
      "status-error",
      "status-ready",
      "status-working",
      "status-attention",
    ]) {
      expect(css).toMatch(
        new RegExp(`--spur-${token}: light-dark\\(#[0-9a-f]{6}, #[0-9a-f]{6}\\)`),
      );
    }
  });

  it("reruns onSnapshot after a change event for its collection only", async () => {
    const r = await pageRig("");
    let docs = [{ id: "a" }];
    r.respond((method, url) =>
      method === "POST" && url === "/p/films/_spur/db/query/items" ? [200, { docs }] : undefined,
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

  it.each([false, true])(
    "reconciles snapshots on stream open after a missed write (reconnect: %s)",
    async (reconnect) => {
      const r = await pageRig("");
      let docs = [{ id: "a" }];
      r.respond((method, url) =>
        method === "POST" && url === "/p/films/_spur/db/query/items" ? [200, { docs }] : undefined,
      );
      const seen: unknown[] = [];
      r.win.spur.db.collection("items").onSnapshot((next) => seen.push(next));
      await flush();
      if (reconnect) {
        r.sources[0]?.emit("open", {});
        await flush();
        r.sources[0]?.emit("error", {});
      }
      docs = [{ id: "a" }, { id: "b" }];
      r.sources[0]?.emit("open", {});
      await flush();
      expect(seen.at(-1)).toEqual([{ id: "a" }, { id: "b" }]);
      expect(r.sources).toHaveLength(1);
    },
  );

  it("settles an action completed before the stream first opens", async () => {
    const r = await pageRig("");
    let completed = false;
    r.respond((method, url, body) => {
      if (method === "POST" && url === "/p/films/_spur/actions") {
        return [200, { id: (body as { id: string }).id, data: { status: "pending" } }];
      }
      if (method === "GET" && url.startsWith("/p/films/_spur/db/docs/_actions/")) {
        return [
          200,
          {
            id: decodeURIComponent(url.split("/").at(-1) ?? ""),
            data: completed ? { status: "done", result: { saved: true } } : { status: "pending" },
          },
        ];
      }
      return undefined;
    });
    const pending = r.win.spur.agent.invoke("pick", {});
    await flush();
    expect(r.win.spur.action?.status).toBe("queued");
    completed = true;
    r.sources[0]?.emit("open", {});
    await expect(pending).resolves.toMatchObject({ ok: true, result: { saved: true } });
    expect(r.win.spur.action?.status).toBe("completed");
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
      if (method === "POST" && url === "/p/films/_spur/actions") {
        const id = (body as { id: string }).id;
        return [200, { id, rev: 1, data: { action: "pick", status: "pending" } }];
      }
      if (method === "GET" && url.startsWith("/p/films/_spur/db/docs/_actions/")) {
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
    const post = r.requests.find((request) => request.url === "/p/films/_spur/actions");
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

  it("keeps a completed action completed when the invoke POST response arrives late", async () => {
    const r = await pageRig("<spur-button action='pick'>Pick</spur-button>");
    r.respond((method, url) =>
      method === "GET" && url.startsWith("/p/films/_spur/db/docs/_actions/")
        ? [
            200,
            {
              id: decodeURIComponent(url.split("/").at(-1) ?? ""),
              rev: 2,
              data: { action: "pick", status: "done", result: { ok: 1 } },
            },
          ]
        : undefined,
    );
    const realFetch = r.win.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.win.fetch = (async (url: string, init?: { method?: string }) => {
      const response = await realFetch(url, init as never);
      if (init?.method === "POST" && url === "/p/films/_spur/actions") {
        await gate;
        const id = (JSON.parse((init as { body: string }).body) as { id: string }).id;
        return new Response(
          JSON.stringify({ id, rev: 1, data: { action: "pick", status: "pending" } }),
          { status: 200 },
        );
      }
      return response;
    }) as unknown as typeof r.win.fetch;
    const first = r.win.spur.agent.invoke("pick", {});
    await flush();
    const post = r.requests.find((request) => request.url === "/p/films/_spur/actions");
    const id = (post?.body as { id: string }).id;
    r.sources[0]?.emit("change", { seq: 3, collection: "_actions", id, op: "set", rev: 2 }, "3");
    await expect(first).resolves.toEqual({ ok: true, id, result: { ok: 1 } });
    release();
    await flush();
    expect(r.win.spur.action).toMatchObject({ id, status: "completed" });
    expect(r.doc.querySelector("spur-button")?.hasAttribute("aria-busy")).toBe(false);
    await expect(r.win.spur.agent.invoke("pick", {})).resolves.not.toMatchObject({
      reason: "busy",
    });
  });

  it("chat sends, polls messages and renders text inertly", async () => {
    const r = await pageRig("<spur-chat></spur-chat>");
    r.respond((method, url) => {
      if (method === "GET" && url.startsWith("/p/films/_spur/agent/messages")) {
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
      if (method === "POST" && url === "/p/films/_spur/agent/send")
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

    const input = r.doc.querySelector(".spur-chat-form textarea") as HTMLTextAreaElement;
    input.value = "suggest films";
    const form = r.doc.querySelector(".spur-chat-form") as HTMLFormElement;
    form.dispatchEvent(new r.win.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const send = r.requests.find((request) => request.url === "/p/films/_spur/agent/send");
    // A synthetic submit is untrusted: no user gesture.
    expect(send?.body).toEqual({ message: "suggest films", userGesture: false });
    r.advance(2000);
    await flush();
    expect(
      r.requests.filter((request) => request.url.startsWith("/p/films/_spur/agent/messages")).at(-1)
        ?.url,
    ).toBe("/p/films/_spur/agent/messages?from=2");
  });

  it("chat disables the input while sending and flags a failed send until the next input or status", async () => {
    const r = await pageRig("<spur-chat></spur-chat>");
    r.respond((method, url) =>
      method === "POST" && url === "/p/films/_spur/agent/send"
        ? [503, { error: "Agent is down" }]
        : undefined,
    );
    // Hold the send response so the pending state is observable.
    const realFetch = r.win.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.win.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/p/films/_spur/agent/send") await gate;
      return realFetch(url, init);
    }) as typeof r.win.fetch;
    await flush();
    const input = r.doc.querySelector(".spur-chat-form textarea") as HTMLTextAreaElement;
    const status = r.doc.querySelector(".spur-chat-status") as Element;
    const form = r.doc.querySelector(".spur-chat-form") as HTMLFormElement;
    expect(r.doc.querySelector(".spur-chat-log")?.childNodes).toHaveLength(0);
    input.value = "hello";
    form.dispatchEvent(new r.win.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(input.disabled).toBe(true);
    expect(status.textContent).toBe("Sending…");
    release();
    await flush();
    expect(input.disabled).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(status.getAttribute("data-tone")).toBe("error");
    expect(status.textContent).toBe("Agent is down");
    input.dispatchEvent(new r.win.Event("input", { bubbles: true }));
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    r.sources[0]?.emit("agent", { state: "working", sessionId: "pg-films-ab12" });
    expect(status.hasAttribute("data-tone")).toBe(false);
    expect(status.textContent).toBe("Agent working");
  });

  it("renders an action message as a tagged label line and spaces the status off the log", async () => {
    const r = await pageRig("<style>spur-chat{display:block}</style><spur-chat></spur-chat>");
    r.respond((method, url) =>
      method === "GET" && url.startsWith("/p/films/_spur/agent/messages")
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
      if (method !== "GET" || !url.startsWith("/p/films/_spur/agent/messages")) return undefined;
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
      r.requests.filter((request) => request.url.startsWith("/p/films/_spur/agent/messages")).at(-1)
        ?.url,
    ).toBe("/p/films/_spur/agent/messages?from=2");
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
      (request) =>
        request.method === "POST" && request.url === "/p/films/_spur/db/docs/_state/page",
    );
    expect(writes).toEqual([
      {
        method: "POST",
        url: "/p/films/_spur/db/docs/_state/page",
        body: { data: { app: { tab: 2 }, controls: [] } },
      },
    ]);
  });
});
