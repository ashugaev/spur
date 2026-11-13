import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../../src/server.js";
import { SSE_HEADERS, SseHub } from "../../src/sse.js";
import { pageDirPath } from "../../src/stores.js";
import { createTempDir, findFreePort } from "../helpers/common.js";

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function boot() {
  const root = await createTempDir("spur-server-pages-");
  roots.push(root);
  const repoDir = join(root, "repo");
  const dataDir = join(root, "data");
  await mkdir(repoDir, { recursive: true });
  const port = await findFreePort();
  const configPath = join(root, "spur.yaml");
  await writeFile(
    configPath,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      `dataDir: ${dataDir}`,
      `worktreeDir: ${join(root, "worktrees")}`,
      "projects:",
      "  demo:",
      `    path: ${repoDir}`,
    ].join("\n"),
    "utf8",
  );
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.stop();
  };
  cleanups.push(stop);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  };
  return { base, call, dataDir, stop };
}

describe("page source HTTP boundary", () => {
  it("imports, updates without SSE, exposes errors/recovery and detaches without losing SQL", async () => {
    const { dataDir, base, call } = await boot();
    const source = join(dataDir, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "entry.html"), '<link href="style.css">first');
    await writeFile(join(source, "style.css"), "a{}");
    expect(
      (await call("POST", "/pages", { id: "invalid", source: { path: "relative" } })).status,
    ).toBe(400);
    const created = await call("POST", "/pages", {
      id: "training",
      source: { path: join(source, "entry.html") },
    });
    expect(created.status).toBe(201);
    expect(JSON.parse(created.text)).toMatchObject({ id: "training", sync: { state: "synced" } });
    expect((await fetch(`${base}/pages/training/files/index.html`)).status).toBe(200);
    expect((await call("GET", "/pages/training/files/style.css")).text).toBe("a{}");
    for (const path of ["page.yaml", ".source-sync.json", "data.sqlite"]) {
      expect((await call("GET", `/pages/training/files/${path}`)).status).toBe(404);
    }
    await call("POST", "/stores/page%3Atraining/docs/items/one", { data: { keep: true } });
    await writeFile(join(source, "entry.html"), "automatic");
    await waitFor(
      async () =>
        (await readFile(join(pageDirPath(dataDir, "training"), "index.html"), "utf8")) ===
        "automatic",
      7000,
    );
    await rm(source, { recursive: true });
    const error = await call("PATCH", "/pages/training/source", { path: source });
    expect(JSON.parse(error.text).sync.state).toBe("error");
    expect((await call("GET", "/pages/training/files/index.html")).text).toBe("automatic");
    await mkdir(source);
    await writeFile(join(source, "index.html"), "recovered");
    await waitFor(
      async () => JSON.parse((await call("GET", "/pages")).text).pages[0]?.sync.state === "synced",
      7000,
    );
    expect((await call("GET", "/pages/training/files/index.html")).text).toBe("recovered");
    expect((await call("GET", "/stores/page%3Atraining/docs/items/one")).text).toContain(
      '"keep":true',
    );
    const detached = await call("PATCH", "/pages/training/source", { path: null });
    expect(JSON.parse(detached.text).source).toBeUndefined();
    expect((await call("PATCH", "/pages/training/source", {})).status).toBe(400);
    expect((await call("PATCH", "/pages/missing/source", { path: source })).status).toBe(404);
    expect((await call("DELETE", "/pages/training")).status).toBe(200);
  });
});

interface SseEvent {
  event: string;
  id?: string;
  data: unknown;
}

// Minimal EventSource reader over fetch: collects parsed events and comments.
function openEvents(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  // Agent status events land in `agents`; store and file events in `events`.
  const events: SseEvent[] = [];
  const agents: SseEvent[] = [];
  const comments: string[] = [];
  let resolveResponse!: (response: Response) => void;
  const responsePromise = new Promise<Response>((resolve) => (resolveResponse = resolve));
  const done = (async () => {
    const response = await fetch(url, {
      headers: { accept: "text/event-stream", ...headers },
      signal: controller.signal,
    });
    resolveResponse(response);
    if (!response.body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event: Partial<SseEvent> & { lines: string[] } = { lines: [] };
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) comments.push(line.slice(1).trim());
            else if (line.startsWith("event: ")) event.event = line.slice(7);
            else if (line.startsWith("id: ")) event.id = line.slice(4);
            else if (line.startsWith("data: ")) event.lines.push(line.slice(6));
          }
          if (event.event) {
            (event.event === "agent" ? agents : events).push({
              event: event.event,
              ...(event.id ? { id: event.id } : {}),
              data: JSON.parse(event.lines.join("\n")) as unknown,
            });
          }
        }
      }
    } catch {
      // Aborted or closed by the server.
    }
  })();
  cleanups.push(() => controller.abort());
  return {
    events,
    agents,
    comments,
    response: responsePromise,
    done,
    close: () => controller.abort(),
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("page routes", () => {
  it("creates, lists, serves files, rejects duplicates and deletes", async () => {
    const { call, dataDir } = await boot();
    const created = await call("POST", "/pages", { id: "films", title: "Films" });
    expect(created.status).toBe(201);
    expect(JSON.parse(created.text)).toMatchObject({ id: "films", url: "/p/films/" });
    expect((await call("POST", "/pages", { id: "films" })).status).toBe(409);
    expect((await call("POST", "/pages", { id: "Bad" })).status).toBe(400);
    expect(
      JSON.parse((await call("GET", "/pages")).text).pages.map((page: { id: string }) => page.id),
    ).toEqual(["films"]);

    await mkdir(join(pageDirPath(dataDir, "films"), "css"), { recursive: true });
    await writeFile(join(pageDirPath(dataDir, "films"), "css", "a b.css"), "body{}", "utf8");
    const index = await call("GET", "/pages/films/files/index.html");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(index.headers.get("content-security-policy")).toBeNull();
    expect((await call("GET", "/pages/films/files/css/a%20b.css")).text).toBe("body{}");
    expect((await call("GET", "/pages/films/files/data.sqlite")).status).toBe(404);
    expect((await call("GET", "/pages/films/files/%2e%2e/%2e%2e/spur.yaml")).status).toBe(404);
    expect((await call("GET", "/pages/films/files/%E0%A4%A")).status).toBe(404);

    expect(JSON.parse((await call("DELETE", "/pages/films")).text)).toEqual({
      deleted: true,
      id: "films",
    });
    expect((await call("DELETE", "/pages/films")).status).toBe(404);
    expect((await call("GET", "/pages/films/files/index.html")).status).toBe(404);
  });
});

describe("store agent routes", () => {
  it("reports no page agent before the first message and validates send bodies", async () => {
    const { call } = await boot();
    await call("POST", "/pages", { id: "films" });
    expect(JSON.parse((await call("GET", "/stores/page%3Afilms/agent/status")).text)).toEqual({
      state: "none",
      sessionId: null,
    });
    expect(JSON.parse((await call("GET", "/stores/page%3Afilms/agent/messages")).text)).toEqual({
      sessionId: null,
      messages: [],
      status: { state: "none", sessionId: null },
    });
    expect((await call("GET", "/stores/page%3Afilms/agent/messages?limit=101")).status).toBe(400);
    expect((await call("POST", "/stores/page%3Afilms/agent/send", { message: "" })).status).toBe(
      400,
    );
    expect((await call("POST", "/stores/page%3Anope/agent/send", { message: "hi" })).status).toBe(
      404,
    );
    expect((await call("GET", "/stores/session%3Anope/agent/status")).status).toBe(404);
  });
});

describe("page event stream", () => {
  it("pins SSE headers, rejects non-SSE Accept with 406, and 404s an unknown page", async () => {
    const { base, call } = await boot();
    await call("POST", "/pages", { id: "films" });
    expect((await call("GET", "/pages/films/events")).status).toBe(406);
    expect(
      (await fetch(`${base}/pages/nope/events`, { headers: { accept: "text/event-stream" } }))
        .status,
    ).toBe(404);
    const stream = openEvents(`${base}/pages/films/events`);
    const response = await stream.response;
    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(SSE_HEADERS)) {
      if (name !== "connection") expect(response.headers.get(name)).toBe(value);
    }
    await waitFor(() => stream.agents.length === 1);
    expect(stream.agents[0]?.data).toEqual({ state: "none", sessionId: null });
  });

  it("sends change after a store write and reload after a file write", async () => {
    const { base, call, dataDir } = await boot();
    await call("POST", "/pages", { id: "films" });
    const stream = openEvents(`${base}/pages/films/events`);
    await stream.response;
    await waitFor(() => stream.comments.includes("open"));
    await call("POST", "/stores/page%3Afilms/docs/items/d1", { data: { title: "Dune" } });
    await waitFor(() => stream.events.some((event) => event.event === "change"));
    expect(stream.events[0]).toEqual({
      event: "change",
      id: "1",
      data: expect.objectContaining({ seq: 1, collection: "items", id: "d1", op: "set", rev: 1 }),
    });
    expect((stream.events[0]?.data as { doc: { data: unknown } }).doc.data).toEqual({
      title: "Dune",
    });
    await writeFile(join(pageDirPath(dataDir, "films"), "index.html"), "<p>new</p>", "utf8");
    await waitFor(() => stream.events.some((event) => event.event === "reload"));
    expect(stream.events.find((event) => event.event === "reload")?.data).toEqual({
      path: "index.html",
    });
  });

  it("replays after since, resumes from Last-Event-ID and signals reset", async () => {
    const { base, call } = await boot();
    await call("POST", "/pages", { id: "films" });
    for (const id of ["a", "b", "c"]) {
      await call("POST", `/stores/page%3Afilms/docs/items/${id}`, { data: { id } });
    }
    await call("DELETE", "/stores/page%3Afilms/docs/items/a");
    const replay = openEvents(`${base}/pages/films/events?since=1`);
    await waitFor(() => replay.events.length === 3);
    expect(replay.events.map((event) => [event.id, (event.data as { op: string }).op])).toEqual([
      ["2", "set"],
      ["3", "set"],
      ["4", "delete"],
    ]);
    expect((replay.events[2]?.data as { doc: unknown }).doc).toBeNull();

    const resumed = openEvents(`${base}/pages/films/events?since=0`, { "last-event-id": "3" });
    await waitFor(() => resumed.events.length === 1);
    expect(resumed.events[0]?.id).toBe("4");

    const reset = openEvents(`${base}/pages/films/events?since=99`);
    await waitFor(() => reset.events.length === 1);
    expect(reset.events[0]).toEqual({ event: "reset", id: "4", data: { lastSeq: 4 } });
  });

  it("closes open streams on DELETE and on shutdown within a second", async () => {
    const { base, call, stop } = await boot();
    await call("POST", "/pages", { id: "films" });
    await call("POST", "/pages", { id: "notes" });
    const films = openEvents(`${base}/pages/films/events`);
    const notes = openEvents(`${base}/pages/notes/events`);
    await films.response;
    await notes.response;
    await call("DELETE", "/pages/films");
    await films.done;
    const started = Date.now();
    await stop();
    await notes.done;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("SseHub", () => {
  async function hubServer(hub: SseHub): Promise<{ url: string; server: Server }> {
    const server = createServer((request, response) => {
      hub.open(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          hub.closeAll();
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server };
  }

  it("heartbeats, caps open streams with 503, and frees a slot on client close", async () => {
    const hub = new SseHub({ maxStreams: 2, heartbeatMs: 30 });
    const { url } = await hubServer(hub);
    const first = openEvents(url);
    const second = openEvents(url);
    await first.response;
    await second.response;
    await waitFor(() => first.comments.includes("ping"));
    const rejected = await fetch(url, { headers: { accept: "text/event-stream" } });
    expect(rejected.status).toBe(503);
    expect(hub.size).toBe(2);
    first.close();
    await waitFor(() => hub.size === 1);
    const third = openEvents(url);
    expect((await third.response).status).toBe(200);
  });
});
