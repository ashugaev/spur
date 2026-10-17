import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/mcp.js";
import { mcpFixture, session } from "./mcp-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(projects: string[] = ["test"], host?: string) {
  const fixture = await mcpFixture(host);
  cleanups.push(fixture.close);
  const server = await createMcpServer(fixture.configPath, projects);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanups.push(() => client.close());
  return {
    fixture,
    client,
    call: (name: string, args: object = {}) => client.callTool({ name, arguments: { ...args } }),
  };
}

describe("MCP daemon boundary", () => {
  it("discovers only eligible configured projects and paginates after launch filtering", async () => {
    const { call } = await setup([]);
    expect((await call("list_projects", { limit: 1 })).structuredContent).toEqual({
      projects: [{ id: "other", name: "Other" }],
      total: 2,
      nextOffset: 1,
    });
    expect((await call("list_projects", { offset: 1 })).structuredContent).toEqual({
      projects: [{ id: "test", name: "Test" }],
      total: 2,
      nextOffset: null,
    });
  });

  it("projects all six calls and sends only reduced mutation bodies without caller identity", async () => {
    const { fixture, call, client } = await setup();
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_projects",
      "list_sessions",
      "get_session",
      "get_conversation",
      "spawn_session",
      "send_message",
    ]);
    for (const tool of tools) {
      const write = tool.name === "spawn_session" || tool.name === "send_message";
      expect(tool.annotations).toMatchObject({
        readOnlyHint: !write,
        destructiveHint: write,
        idempotentHint: !write,
      });
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    const projected = {
      id: session.id,
      project: session.project,
      agent: session.agent,
      status: session.status,
      state: session.state,
      branch: session.branch,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      title: "Task",
    };
    expect((await call("get_session", { sessionId: session.id })).structuredContent).toEqual(
      projected,
    );
    expect((await call("list_sessions", { includeCompleted: true })).structuredContent).toEqual({
      sessions: [projected],
      total: 1,
      nextOffset: null,
    });
    expect(
      (await call("get_conversation", { sessionId: session.id, from: 10, limit: 3 }))
        .structuredContent,
    ).toEqual({
      sessionId: session.id,
      state: "waiting",
      messages: [{ index: 12, role: "assistant", text: "Answer", timestampMs: 123 }],
      startIndex: 10,
      totalEntries: 14,
      nextFrom: 13,
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
    expect(
      (await call("spawn_session", { project: "test", prompt: "  task  " })).structuredContent,
    ).toEqual(projected);
    expect(
      (await call("send_message", { sessionId: session.id, message: "  followup  " }))
        .structuredContent,
    ).toEqual(projected);
    expect(
      fixture.calls
        .filter((call) => call.method === "POST")
        .map(({ path, body }) => ({ path, body })),
    ).toEqual([
      { path: "/sessions/background", body: { project: "test", prompt: "task" } },
      { path: `/sessions/${session.id}/send`, body: { message: "followup" } },
    ]);
    expect(fixture.calls.some((call) => call.path === "/sessions?includeCompleted=1")).toBe(true);
    for (const call of fixture.calls) {
      expect(call.headers["x-spur-origin"]).toBe("mcp");
      expect(call.headers["x-spur-caller-session"]).toBeUndefined();
    }
  });

  it("rejects direct-ID scope bypasses, removal, and out-of-scope writes", async () => {
    const { fixture, call } = await setup();
    for (const sessionId of ["other-one", "loose-one"]) {
      for (const name of ["get_session", "get_conversation", "send_message"])
        expect(
          (await call(name, { sessionId, ...(name === "send_message" ? { message: "x" } : {}) }))
            .isError,
        ).toBe(true);
    }
    expect((await call("spawn_session", { project: "other", prompt: "x" })).isError).toBe(true);
    fixture.state.projects = [];
    expect((await call("get_session", { sessionId: session.id })).isError).toBe(true);
    expect((await call("list_sessions")).structuredContent).toMatchObject({
      sessions: [],
      total: 0,
    });
    expect(
      fixture.calls.some((call) => call.method === "POST" || call.path.includes("/conversation")),
    ).toBe(false);
  });

  it.each([
    ["get_session", { sessionId: "../secret" }],
    ["get_session", { sessionId: "%2F" }],
    ["list_sessions", { limit: 101 }],
    ["list_projects", { offset: -1 }],
    ["spawn_session", { project: "test", prompt: " " }],
    ["spawn_session", { project: "test", prompt: "x".repeat(32769) }],
    ["send_message", { sessionId: session.id, message: "x", interrupt: true }],
    ["list_projects", { extra: true }],
  ])("rejects invalid %s input before HTTP", async (name, args) => {
    const { fixture, call } = await setup();
    const before = fixture.calls.length;
    expect((await call(name, args)).isError).toBe(true);
    expect(fixture.calls).toHaveLength(before);
  });

  it("rejects absent/invalid config without creating files, and checks instance identity/version", async () => {
    const fixture = await mcpFixture();
    cleanups.push(fixture.close);
    const before = await readFile(fixture.configPath, "utf8");
    await expect(createMcpServer(join(fixture.root, "absent.yaml"))).rejects.toThrow(
      "existing valid",
    );
    fixture.state.info.configPath = join(fixture.root, "absent.yaml");
    await expect(createMcpServer(fixture.configPath)).rejects.toThrow("does not match");
    fixture.state.info.configPath = fixture.configPath;
    fixture.state.info.apiVersion = -1;
    await expect(createMcpServer(fixture.configPath)).rejects.toThrow("Invalid daemon response");
    fixture.state.info.apiVersion = 3;
    await expect(createMcpServer(fixture.configPath, ["unknown"])).rejects.toThrow();
    expect(await readFile(fixture.configPath, "utf8")).toBe(before);
    expect(await readdir(fixture.root)).toEqual(["instance.yaml"]);
    await writeFile(fixture.configPath, "server: [invalid");
    await expect(createMcpServer(fixture.configPath)).rejects.toThrow("existing valid");
  });

  it("supports wildcard bind configs without selecting another instance", async () => {
    const { call } = await setup(["test"], "0.0.0.0");
    expect((await call("list_projects")).isError).toBeUndefined();
  });

  it.each(["json", "shape", "oversize", "redirect", "wrong-id"])(
    "rejects %s daemon data without leaking payloads",
    async (mode) => {
      const { fixture, call } = await setup();
      fixture.state.override = (path) =>
        path === `/sessions/${session.id}`
          ? mode === "json"
            ? { raw: "secret broken" }
            : mode === "shape"
              ? { value: { secret: "secret" } }
              : mode === "oversize"
                ? { raw: "s".repeat(8 * 1024 * 1024 + 1) }
                : mode === "redirect"
                  ? { status: 302 }
                  : { value: { ...session, id: "wrong" } }
          : undefined;
      const output = await call("get_session", { sessionId: session.id });
      expect(output.isError).toBe(true);
      expect(JSON.stringify(output)).not.toContain("secret");
    },
  );

  it("reports uncertain writes once for malformed/failed POST results", async () => {
    const { fixture, call } = await setup();
    fixture.state.override = (_path, method) =>
      method === "POST" ? { raw: "invalid" } : undefined;
    expect(JSON.stringify(await call("spawn_session", { project: "test", prompt: "x" }))).toContain(
      "uncertain",
    );
    expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("shares one tool deadline across preflight and writes without retries", async () => {
    const { fixture, call } = await setup();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadlines = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => timeout(ms === 90_000 ? 30 : ms));
    fixture.state.override = (path) => (path === "/projects" ? { hold: true } : undefined);
    expect((await call("spawn_session", { project: "test", prompt: "x" })).isError).toBe(true);
    expect(deadlines).toHaveBeenCalledWith(90_000);
    expect(fixture.calls.filter((call) => call.path === "/projects")).toHaveLength(2);
    expect(fixture.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("bounds multibyte conversation output, truncates metadata and preserves source cursor", async () => {
    const { fixture, call } = await setup();
    fixture.state.conversation = {
      state: "waiting",
      startIndex: 0,
      totalEntries: 10,
      entries: Array.from({ length: 10 }, () => ({
        kind: "message",
        role: "assistant",
        text: "🙂".repeat(12000),
      })),
    };
    const output = await call("get_conversation", { sessionId: session.id });
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(128 * 1024);
    expect(output.structuredContent).toMatchObject({ nextFrom: 2, hasMoreAfter: true });
    expect(output.structuredContent).toMatchObject({
      messages: [
        { index: 0, textTruncated: true },
        { index: 1, textTruncated: true },
      ],
    });
    fixture.state.sessions = [
      {
        ...session,
        branch: "b".repeat(900),
        slots: { title: "t".repeat(900), links: { secret: "x" } },
      },
    ];
    expect((await call("get_session", { sessionId: session.id })).structuredContent).toMatchObject({
      branch: "b".repeat(512),
      title: "t".repeat(512),
      truncatedFields: ["branch", "title"],
    });
  });
  it("consumes a single escaped oversized message after explicit truncation", async () => {
    const { fixture, call } = await setup();
    fixture.state.conversation = {
      state: "waiting",
      startIndex: 0,
      totalEntries: 1,
      entries: [{ kind: "message", role: "assistant", text: "\u0000".repeat(8192) }],
    };
    const output = await call("get_conversation", { sessionId: session.id });
    expect(output.isError).toBeUndefined();
    expect(output.structuredContent).toMatchObject({
      nextFrom: 1,
      hasMoreAfter: false,
      messages: [{ textTruncated: true }],
    });
  });

  it("rejects oversized projected results rather than cutting JSON or identifiers", async () => {
    const { fixture, call } = await setup();
    fixture.state.sessions = Array.from({ length: 100 }, (_, index) => ({
      ...session,
      id: `test-${index}`,
      slots: { title: "🙂".repeat(512), links: { secret: "x" } },
    }));
    expect((await call("list_sessions", { limit: 100 })).isError).toBe(true);
    expect((await call("list_sessions", { limit: 1 })).isError).toBeUndefined();
  });

  it("times out a started write once and marks its outcome uncertain", async () => {
    const { fixture, call } = await setup();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(ms === 90_000 ? 50 : ms));
    fixture.state.override = (_path, method) => (method === "POST" ? { hold: true } : undefined);
    expect(JSON.stringify(await call("spawn_session", { project: "test", prompt: "x" }))).toContain(
      "uncertain",
    );
    expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("aborts in-flight requests when the SDK connection closes", async () => {
    const { fixture, client, call } = await setup();
    fixture.state.override = (path) => (path === "/projects" ? { hold: true } : undefined);
    const pending = call("list_projects");
    const failed = expect(pending).rejects.toThrow();
    await vi.waitFor(() =>
      expect(fixture.calls.filter((call) => call.path === "/projects")).toHaveLength(2),
    );
    await client.close();
    await failed;
    expect(fixture.calls.some((call) => call.method === "POST")).toBe(false);
  });
});
