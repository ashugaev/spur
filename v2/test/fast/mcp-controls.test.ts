import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/mcp.js";
import { mcpFixture, session } from "./mcp-fixture.js";
import { restartDaemonIfRunning } from "../../src/client.js";

vi.mock("../../src/client.js", () => ({ restartDaemonIfRunning: vi.fn() }));

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
});
async function setup() {
  const fixture = await mcpFixture();
  cleanups.push(fixture.close);
  let status: unknown;
  let statusCode = 200;
  const requests: URL[] = [];
  const web = createServer((request, response) => {
    requests.push(new URL(request.url ?? "/", "http://localhost"));
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(typeof status === "string" ? status : JSON.stringify(status));
  });
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    web.closeAllConnections();
    await new Promise<void>((resolve) => web.close(() => resolve()));
  });
  const address = web.address();
  if (!address || typeof address === "string") throw new Error("Owned web port missing");
  await appendFile(fixture.configPath, `ui:\n  port: ${address.port}\n`);
  const server = await createMcpServer(fixture.configPath);
  const client = new Client({ name: "controls", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanups.push(() => client.close());
  const source = "spur-web-pr-status-cache";
  const instance = createHash("sha256").update(fixture.configPath).digest("hex");
  const setStatus = (value: unknown, code = 200) => {
    status = value;
    statusCode = code;
  };
  return { fixture, client, requests, source, instance, setStatus };
}
it("discovers bounded schemas and reads attached cached status without provider refresh", async () => {
  const { fixture, client, requests, source, instance, setStatus } = await setup();
  const discovered = (await client.listTools()).tools;
  for (const tool of [
    "restart_daemon",
    "get_daemon_restart",
    "read_daemon_logs",
    "get_session_pr_status",
  ])
    expect(discovered.some((entry) => entry.name === tool)).toBe(true);
  const restart = discovered.find((entry) => entry.name === "restart_daemon");
  expect(restart?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
  const url = "https://github.com/acme/repo/pull/1";
  fixture.state.override = (path) =>
    path === `/sessions/${session.id}` ? { value: { ...session, pr: { url } } } : undefined;
  for (const status of ["available", "unknown"]) {
    setStatus({
      instance,
      source,
      status,
      stale: true,
      observedAt: 123,
      ageMs: 456,
      refreshed: false,
      info: { fetchedAt: 1 },
      ready: null,
    });
    const result = await client.callTool({
      name: "get_session_pr_status",
      arguments: { sessionId: session.id },
    });
    expect(result.structuredContent).toMatchObject({
      status,
      source,
      stale: true,
      observedAt: 123,
      ageMs: 456,
      info: { fetchedAt: 1 },
      sessionId: session.id,
      url,
      refreshed: false,
    });
  }
  expect(requests).toHaveLength(2);
  expect(requests[0]?.pathname).toBe("/api/pr-status");
  expect(requests[0]?.searchParams.get("cacheOnly")).toBe("1");
  expect(requests[0]?.searchParams.get("instance")).toBe(instance);
  fixture.state.override = undefined;
  const missing = await client.callTool({
    name: "get_session_pr_status",
    arguments: { sessionId: session.id },
  });
  expect(missing.structuredContent).toMatchObject({ status: "missing", refreshed: false });
  expect(requests).toHaveLength(2);
});
it("reports unavailable for a wrong cache instance, redirects, malformed and oversized cache output", async () => {
  const { fixture, client, source, instance, setStatus } = await setup();
  fixture.state.override = (path) =>
    path === `/sessions/${session.id}`
      ? { value: { ...session, pr: { url: "https://github.com/acme/repo/pull/1" } } }
      : undefined;
  for (const [value, code] of [
    [{ instance: "other", source, refreshed: false }, 200],
    [{ instance, source, refreshed: false }, 302],
    ["not json", 200],
    ["x".repeat(20000), 200],
  ] as const) {
    setStatus(value, code);
    const result = await client.callTool({
      name: "get_session_pr_status",
      arguments: { sessionId: session.id },
    });
    expect(result.structuredContent).toMatchObject({
      status: "unavailable",
      reason: "selected_web_cache_unavailable",
      refreshed: false,
    });
  }
});
it("keeps serialized daemon log output bounded with pagination and rejects paths", async () => {
  const { fixture, client } = await setup();
  const data = join(fixture.root, "data");
  await mkdir(data, { recursive: true });
  await writeFile(
    join(data, "events.jsonl"),
    Array.from(
      { length: 1000 },
      (_, index) => JSON.stringify({ event: "daemon.test", message: `event-${index}` }) + "\n",
    ).join(""),
  );
  fixture.state.override = (path) => (path === "/info" ? { hold: true } : undefined);
  const first = await client.callTool({ name: "read_daemon_logs", arguments: { limit: 1 } });
  expect(first.structuredContent).toMatchObject({
    source: "daemon-event-journal",
    status: "available",
    entries: [{ message: "event-0" }],
  });
  const second = await client.callTool({
    name: "read_daemon_logs",
    arguments: { cursor: first.structuredContent?.nextCursor, limit: 1 },
  });
  expect(second.structuredContent).toMatchObject({ entries: [{ message: "event-1" }] });
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(131072);
  expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThan(131072);
  expect(
    (await client.callTool({ name: "read_daemon_logs", arguments: { path: "../../private" } }))
      .isError,
  ).toBe(true);
});

it("returns original durable admission during a stalled daemon probe without repeating restart", async () => {
  const { fixture, client } = await setup();
  vi.mocked(restartDaemonIfRunning).mockResolvedValue({
    restarted: true,
    baseUrl: "http://localhost",
  });
  const operationId = randomUUID();
  const accepted = await client.callTool({ name: "restart_daemon", arguments: { operationId } });
  expect(accepted.structuredContent).toMatchObject({
    receipt: { status: "accepted", operationId },
  });
  fixture.state.override = (path) => (path === "/info" ? { hold: true } : undefined);
  const receipt = await client.callTool({ name: "get_daemon_restart", arguments: { operationId } });
  expect(receipt.structuredContent).toMatchObject({
    daemonAvailable: false,
    receipt: { operationId },
  });
  expect(
    (await client.callTool({ name: "restart_daemon", arguments: { operationId } }))
      .structuredContent,
  ).toMatchObject({ duplicate: true });
  expect(restartDaemonIfRunning).toHaveBeenCalledOnce();
});
