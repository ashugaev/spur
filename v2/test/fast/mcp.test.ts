import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp.js";
import { DAEMON_OPERATIONS } from "../../src/daemon-contracts.js";
import { McpGateway } from "../../src/mcp-gateway.js";
import { mcpFixture, session } from "./mcp-fixture.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const fixture = await mcpFixture();
  cleanups.push(fixture.close);
  const server = await createMcpServer(fixture.configPath);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanups.push(() => client.close());
  return {
    fixture,
    client,
    call: (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }),
  };
}
it("exposes all projects, raw conversation and complete operator requests without inherited identity", async () => {
  const { fixture, call, client } = await setup();
  expect((await client.listTools()).tools).toHaveLength(13);
  const projects = (await call("list_projects")).structuredContent;
  expect(projects).toMatchObject({ ok: true, status: 200, body: fixture.state.projects });
  expect((await call("get_session", { sessionId: "loose-one" })).isError).toBeUndefined();
  await call("get_conversation", { sessionId: session.id });
  expect(fixture.calls.at(-1)?.path).toBe(`/sessions/${session.id}/conversation`);
  const body = {
    project: "test",
    prompt: "task",
    agent: "codex",
    model: "auto",
    reasoningEffort: "high",
    mode: "manager",
    branch: "feature/test",
    steps: ["true"],
    planMode: true,
    restrictWrites: false,
    overrides: { worktree: true },
    bootstrap: true,
  };
  await call("spawn_session", body);
  expect(fixture.calls.at(-1)).toMatchObject({ path: "/sessions/background", body });
  await call("spawn_session", { ...body, background: false });
  expect(fixture.calls.at(-1)).toMatchObject({ path: "/sessions", body });
  await call("send_message", {
    sessionId: session.id,
    message: "followup",
    queue: true,
    interrupt: false,
    attachments: [{ name: "x", data: "eA==" }],
  });
  expect(fixture.calls.at(-1)?.body).toEqual({
    message: "followup",
    queue: true,
    interrupt: false,
    attachments: [{ name: "x", data: "eA==" }],
  });
  for (const request of fixture.calls) {
    expect(request.headers["x-spur-origin"]).toBe("mcp");
    expect(request.headers["x-spur-caller-session"]).toBeUndefined();
  }
});
it("preserves daemon status/message and never follows redirects or replays mutations", async () => {
  const { fixture, call } = await setup();
  for (const status of [400, 403, 404, 409, 500, 302]) {
    fixture.state.override = (path) =>
      path === "/sessions/background"
        ? { status, value: { error: `daemon ${status}` } }
        : undefined;
    const before = fixture.calls.length;
    expect(
      (await call("spawn_session", { project: "test", prompt: "x" })).structuredContent,
    ).toMatchObject({ ok: false, status, body: { error: `daemon ${status}` } });
    expect(fixture.calls.slice(before).filter((request) => request.method === "POST")).toHaveLength(
      1,
    );
  }
});
it("forwards every catalog example to a fixed method/template preserving fields", async () => {
  const fixture = await mcpFixture();
  cleanups.push(fixture.close);
  const gateway = await McpGateway.create(fixture.configPath);
  cleanups.push(() => gateway.close());
  fixture.state.override = (path) =>
    path === "/info" ? undefined : { status: 200, value: { id: session.id } };
  for (const operation of DAEMON_OPERATIONS) {
    for (const example of operation.examples) {
      // Write receipts additionally inspect the existing conversation baseline.
      fixture.state.override = (path) =>
        path === "/info"
          ? undefined
          : path.includes("/conversation")
            ? { value: { totalEntries: 0, messages: [] } }
            : { status: 200, value: { id: session.id } };
      await gateway.dispatch(
        { operationId: operation.operationId, ...example },
        AbortSignal.timeout(5000),
      );
      const request = fixture.calls.at(-1);
      if (!request) throw new Error("Missing daemon request");
      let path = operation.path;
      for (const name of operation.pathParams) {
        const value = example.pathParams?.[name];
        if (!value) throw new Error("Missing example path parameter");
        path = path.replace(
          `{${name}}`,
          operation.catchAllPathParams?.includes(name)
            ? value.split("/").map(encodeURIComponent).join("/")
            : encodeURIComponent(value),
        );
      }
      const query = new URLSearchParams(example.query);
      if (query.size) path += `?${query}`;
      expect(request).toMatchObject({ method: operation.method, path });
      expect(request.body).toEqual(example.body);
    }
  }
});
it("rejects unknown operation/path traversal/wrong-instance before mutation and survives daemon outage", async () => {
  const { fixture, call } = await setup();
  for (const args of [
    { operationId: "https://evil.test" },
    { operationId: "get_session", pathParams: { sessionId: ".." } },
    { operationId: "get_session", pathParams: { sessionId: "x", extra: "y" } },
  ])
    expect((await call("daemon_request", args)).isError).toBe(true);
  fixture.state.info.configPath = "/absent";
  expect((await call("spawn_session", { project: "test" })).isError).toBe(true);
  expect(fixture.calls.filter((request) => request.method === "POST")).toHaveLength(0);
  fixture.state.info.configPath = fixture.configPath;
  expect((await call("list_projects")).isError).toBeUndefined();
});
it("returns uncertain transport writes once and preserves large mutation response handles", async () => {
  const fixture = await mcpFixture();
  cleanups.push(fixture.close);
  const gateway = await McpGateway.create(fixture.configPath);
  cleanups.push(() => gateway.close());
  const controller = new AbortController();
  fixture.state.override = (_path, method) => {
    if (method !== "POST") return undefined;
    controller.abort(new Error("Caller cancelled after mutation receipt"));
    return { hold: true };
  };
  const uncertain = await gateway.dispatch(
    { operationId: "spawn_background_session", body: { project: "test", prompt: "x" } },
    controller.signal,
  );
  expect(uncertain).toMatchObject({ ok: false, transportError: true, uncertainWrite: true });
  expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  fixture.state.override = (_path, method) =>
    method === "POST"
      ? { value: { ...session, diagnostic: "x".repeat(9 * 1024 * 1024) } }
      : undefined;
  const large = await gateway.dispatch(
    { operationId: "spawn_background_session", body: { project: "test", prompt: "x" } },
    AbortSignal.timeout(5000),
  );
  expect(large).toMatchObject({
    ok: true,
    status: 200,
    responseId: expect.any(String),
    totalBytes: expect.any(Number),
  });
  expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(2);
});
it("keeps all catalog descriptions and status identities within the serialized MCP budget", async () => {
  const { fixture, call } = await setup();
  for (const operation of DAEMON_OPERATIONS) {
    const description = await call("describe_operations", { operationId: operation.operationId });
    expect(description.isError).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(description))).toBeLessThanOrEqual(131072);
  }
  for (let offset = 0; offset < DAEMON_OPERATIONS.length; offset += 50) {
    const description = await call("describe_operations", { offset, limit: 50 });
    expect(description.isError).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(description))).toBeLessThanOrEqual(131072);
  }
  fixture.state.override = (path) =>
    path === "/info"
      ? {
          value: {
            ...fixture.state.info,
            tags: [{ name: "large", description: "\0".repeat(32768) }],
          },
        }
      : undefined;
  const status = await call("mcp_status");
  expect(status.isError).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThanOrEqual(131072);
  expect(status.structuredContent).toMatchObject({ daemon: { configPath: fixture.configPath } });
  expect(JSON.stringify(status)).not.toContain("tags");
});
