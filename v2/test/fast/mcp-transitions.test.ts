import { afterEach, describe, expect, it } from "vitest";
import { describeDaemonOperations, getDaemonOperation } from "../../src/daemon-contracts.js";
import { McpGateway } from "../../src/mcp-gateway.js";
import { mcpFixture } from "./mcp-fixture.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("MCP transitions operation", () => {
  it("discovers the polling operation and retained-cursor errors", () => {
    const operation = getDaemonOperation("list_session_transitions");
    expect(operation).toMatchObject({ method: "GET", path: "/sessions/transitions" });
    expect(operation?.query.map((field) => field.name)).toEqual([
      "since",
      "link",
      "limit",
      "kinds",
    ]);
    expect(operation?.query).toContainEqual(
      expect.objectContaining({ name: "limit", default: 200, required: false }),
    );
    expect(operation?.responses).toContainEqual(expect.objectContaining({ status: 410 }));
    expect(describeDaemonOperations({ operationId: "list_session_transitions" })).toMatchObject({
      operations: [expect.objectContaining({ operationId: "list_session_transitions" })],
      total: 1,
    });
  });

  it("uses the existing gateway and preserves repeated links and the response envelope", async () => {
    const fixture = await mcpFixture();
    cleanups.push(fixture.close);
    const envelope = { entries: [], nextCursor: "opaque.4", hasMore: false };
    fixture.state.override = (path) =>
      path.startsWith("/sessions/transitions") ? { status: 200, value: envelope } : undefined;
    const gateway = await McpGateway.create(fixture.configPath);
    cleanups.push(() => gateway.close());
    const result = await gateway.dispatch(
      {
        operationId: "list_session_transitions",
        query: {
          since: "opaque.1",
          link: ["board-task=https://example.com/task?a=b", "board-role"],
          limit: 1,
          kinds: "status,state",
        },
      },
      AbortSignal.timeout(5000),
    );
    expect(result).toMatchObject({ ok: true, status: 200, body: envelope });
    const request = fixture.calls.at(-1);
    expect(request?.method).toBe("GET");
    const query = new URL(request?.path ?? "", "http://localhost").searchParams;
    expect(query.getAll("link")).toEqual(["board-task=https://example.com/task?a=b", "board-role"]);
    expect(query.get("since")).toBe("opaque.1");
    expect(query.get("limit")).toBe("1");
    expect(query.get("kinds")).toBe("status,state");
  });

  it("preserves the daemon's 410 resync payload", async () => {
    const fixture = await mcpFixture();
    cleanups.push(fixture.close);
    const payload = {
      error: "Expired transitions cursor",
      floorCursor: "opaque.10",
      latestCursor: "opaque.20",
    };
    fixture.state.override = (path) =>
      path.startsWith("/sessions/transitions") ? { status: 410, value: payload } : undefined;
    const gateway = await McpGateway.create(fixture.configPath);
    cleanups.push(() => gateway.close());
    expect(
      await gateway.dispatch(
        { operationId: "list_session_transitions", query: { since: "opaque.1" } },
        AbortSignal.timeout(5000),
      ),
    ).toMatchObject({ ok: false, status: 410, body: payload });
  });
});
