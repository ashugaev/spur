import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/mcp.js";

const session = {
  id: "s/1",
  project: "TEST",
  agent: "codex",
  status: "running",
  state: "working",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  prompt: "task",
  worktreePath: "/private",
  launchCommand: "secret",
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

async function harness(value: unknown = session, shutdown?: AbortSignal) {
  const daemon = { get: vi.fn().mockResolvedValue(value), post: vi.fn().mockResolvedValue(value) };
  const server = createMcpServer(daemon, shutdown);
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return {
    client,
    daemon,
    call: (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }),
  };
}

describe("Spur MCP boundary", () => {
  it("discovers exactly six strict schemas with irreversible mutation annotations", async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_projects",
      "list_sessions",
      "get_session",
      "read_conversation",
      "spawn_session",
      "send_message",
    ]);
    for (const tool of tools) {
      const mutation = ["spawn_session", "send_message"].includes(tool.name);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations).toEqual({
        readOnlyHint: !mutation,
        destructiveHint: mutation,
        idempotentHint: !mutation,
        openWorldHint: mutation,
      });
    }
  });

  it.each([
    ["get_session", { sessionId: "s", url: "evil" }],
    ["get_session", { sessionId: "x".repeat(129) }],
    ["spawn_session", { project: "TEST", prompt: "  " }],
    ["spawn_session", { project: "TEST", prompt: "x".repeat(32_001) }],
    ["spawn_session", { project: "TEST", prompt: "task", agent: "shell" }],
    ["list_projects", { offset: Number.MAX_SAFE_INTEGER + 1 }],
    ["list_projects", { limit: 51 }],
    ["read_conversation", { sessionId: "s", from: -1 }],
  ])("rejects invalid %s input before daemon dispatch", async (name, args) => {
    const { call, daemon } = await harness();
    expect((await call(name, args)).isError).toBe(true);
    expect(daemon.get).not.toHaveBeenCalled();
    expect(daemon.post).not.toHaveBeenCalled();
  });

  it("projects bounded session fields and encodes path segments", async () => {
    const { call, daemon } = await harness({
      ...session,
      prompt: "p".repeat(513),
      slots: { title: "t".repeat(257) },
    });
    const result = await call("get_session", { sessionId: "s/1" });
    expect(daemon.get).toHaveBeenCalledWith("/sessions/s%2F1", expect.any(AbortSignal));
    expect(result.structuredContent).toEqual({
      session: {
        id: "s/1",
        project: "TEST",
        agent: "codex",
        status: "running",
        state: "working",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        promptPreview: "p".repeat(512),
        title: "t".repeat(256),
        truncated: true,
      },
    });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent) },
    ]);
  });

  it("pages projects and filters sessions before slicing", async () => {
    const { call, daemon } = await harness();
    daemon.get.mockResolvedValueOnce([
      { id: "a", name: "n".repeat(257), configured: true, path: "secret" },
      { id: "b", name: "B", configured: false },
    ]);
    expect((await call("list_projects", { limit: 1 })).structuredContent).toEqual({
      projects: [{ id: "a", name: "n".repeat(256), configured: true, truncated: true }],
      total: 2,
      nextOffset: 1,
    });
    daemon.get.mockResolvedValueOnce([
      { ...session, project: "OTHER" },
      session,
      { ...session, id: "s2" },
    ]);
    const result = await call("list_sessions", {
      project: "TEST",
      offset: 1,
      includeCompleted: true,
    });
    expect(result.structuredContent).toMatchObject({
      total: 2,
      nextOffset: null,
      sessions: [{ id: "s2" }],
    });
    expect(daemon.get).toHaveBeenLastCalledWith(
      "/sessions?view=dashboard&includeCompleted=true",
      expect.any(AbortSignal),
    );
    daemon.get.mockResolvedValueOnce([]);
    await call("list_sessions");
    expect(daemon.get).toHaveBeenLastCalledWith(
      "/sessions?view=dashboard&includeCompleted=false",
      expect.any(AbortSignal),
    );
  });

  it("sends exact mutation bodies and omits absent agent", async () => {
    const { call, daemon } = await harness();
    await call("spawn_session", { project: "TEST", prompt: "task" });
    expect(daemon.post).toHaveBeenLastCalledWith(
      "/sessions/background",
      { project: "TEST", prompt: "task" },
      expect.any(AbortSignal),
    );
    await call("spawn_session", { project: "TEST", prompt: "task", agent: "claude" });
    expect(daemon.post).toHaveBeenLastCalledWith(
      "/sessions/background",
      { project: "TEST", prompt: "task", agent: "claude" },
      expect.any(AbortSignal),
    );
    await call("send_message", { sessionId: "s/1", message: "next" });
    expect(daemon.post).toHaveBeenLastCalledWith(
      "/sessions/s%2F1/send",
      { message: "next", queue: true },
      expect.any(AbortSignal),
    );
  });

  it("redacts transport failures and invalid daemon data, never retries mutations", async () => {
    const { call, daemon } = await harness();
    daemon.post.mockRejectedValueOnce(new Error("private-host/path/token"));
    const failure = await call("send_message", { sessionId: "s", message: "next" });
    expect(failure).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "operation_failed",
              message: "Request outcome unknown. Inspect sessions before retrying.",
              outcomeUnknown: true,
            },
          }),
        },
      ],
    });
    expect(daemon.post).toHaveBeenCalledTimes(1);
    daemon.get.mockResolvedValueOnce({ ...session, status: "invented" });
    expect(await call("get_session", { sessionId: "s" })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("invalid_daemon_response") }],
    });
  });

  it("reports known pre-dispatch shutdown without an uncertain mutation outcome", async () => {
    const controller = new AbortController();
    controller.abort();
    const { call, daemon } = await harness(session, controller.signal);
    const result = await call("spawn_session", { project: "TEST", prompt: "task" });
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('"outcomeUnknown":false') }],
    });
    expect(daemon.post).not.toHaveBeenCalled();
  });

  it.each([
    {
      entries: [],
      startIndex: 0,
      totalEntries: 0,
      from: undefined,
      nextFrom: 0,
      reset: false,
      indexes: [],
    },
    {
      entries: [
        { kind: "tool", output: "private" },
        { kind: "reasoning", text: "private" },
      ],
      startIndex: 3,
      totalEntries: 5,
      from: 3,
      nextFrom: 5,
      reset: false,
      indexes: [],
    },
    {
      entries: [{ kind: "tool" }, { kind: "message", role: "assistant", text: "answer" }],
      startIndex: 3,
      totalEntries: 5,
      from: 3,
      nextFrom: 5,
      reset: false,
      indexes: [4],
    },
    {
      entries: [{ kind: "message", role: "assistant", text: "replay" }],
      startIndex: 4,
      totalEntries: 5,
      from: 5,
      nextFrom: 5,
      reset: false,
      indexes: [],
    },
    {
      entries: [{ kind: "message", role: "assistant", text: "tail" }],
      startIndex: 4,
      totalEntries: 5,
      from: 8,
      nextFrom: 5,
      reset: true,
      indexes: [4],
    },
    {
      entries: [{ kind: "message", role: "assistant", text: "rotated" }],
      startIndex: 4,
      totalEntries: 5,
      from: 0,
      nextFrom: 5,
      reset: true,
      indexes: [4],
    },
  ])(
    "preserves source indexes and tail/shrink semantics $from/$totalEntries",
    async ({ entries, startIndex, totalEntries, from, nextFrom, reset, indexes }) => {
      const { call } = await harness({ entries, startIndex, totalEntries, state: "waiting" });
      const result = await call("read_conversation", {
        sessionId: "s",
        ...(from !== undefined ? { from } : {}),
      });
      expect(result.structuredContent).toMatchObject({
        nextFrom,
        reset,
        hasMore: false,
        messages: indexes.map((index) => expect.objectContaining({ index })),
      });
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );

  it("caps message count, per-message text and aggregate text without losing cursor", async () => {
    const { call, daemon } = await harness({
      entries: Array.from({ length: 21 }, () => ({
        kind: "message",
        role: "assistant",
        text: "x",
      })),
      startIndex: 0,
      totalEntries: 21,
      state: "waiting",
    });
    expect(
      (await call("read_conversation", { sessionId: "s", from: 0 })).structuredContent,
    ).toMatchObject({
      nextFrom: 20,
      hasMore: true,
      messages: expect.objectContaining({ length: 20 }),
    });
    daemon.get.mockResolvedValueOnce({
      entries: Array.from({ length: 4 }, () => ({
        kind: "message",
        role: "assistant",
        text: '🙂"\\'.repeat(3000),
      })),
      startIndex: 0,
      totalEntries: 4,
      state: "waiting",
    });
    const result = await call("read_conversation", { sessionId: "s" });
    expect(result.structuredContent).toMatchObject({
      nextFrom: 3,
      hasMore: true,
      messages: Array.from({ length: 3 }, () =>
        expect.objectContaining({ text: expect.stringMatching(/^[\s\S]{8000}$/), truncated: true }),
      ),
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1_048_576);
  });

  it("bounds aggregate serialization for maximal escaped list fields", async () => {
    const { call } = await harness(
      Array.from({ length: 50 }, (_, i) => ({
        ...session,
        id: `${i}${"\u0000".repeat(125)}`,
        project: "\u0000".repeat(128),
        createdAt: "\u0000".repeat(64),
        updatedAt: "\u0000".repeat(64),
        prompt: "\u0000".repeat(512),
        slots: { title: "\u0000".repeat(256) },
      })),
    );
    const result = await call("list_sessions", { limit: 50 });
    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1_048_576);
  });

  it("propagates SDK request cancellation to daemon requests", async () => {
    const { client, daemon } = await harness();
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    daemon.get.mockImplementationOnce(
      (_path: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          requestSignal = signal;
          started();
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "get_session", arguments: { sessionId: "s" } },
      undefined,
      { signal: controller.signal },
    );
    await dispatched;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
  });
});
