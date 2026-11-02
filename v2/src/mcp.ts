import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { describeDaemonOperations } from "./daemon-contracts.js";
import { McpGateway } from "./mcp-gateway.js";
import { getBuildId } from "./build-identity.js";
import { readMcpTunnelStatus } from "./mcp-tunnel.js";
import { getVersion } from "./version.js";
import { encodeMcpResult, MCP_RESULT_BYTES } from "./mcp-results.js";

const id = z.string().min(1).max(1024);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const params = z.record(z.string());
const query = z.record(z.union([z.string(), z.number().finite(), z.boolean()]));

export function mcpResult(data: Record<string, unknown>): CallToolResult {
  const output = encodeMcpResult(data);
  if (Buffer.byteLength(JSON.stringify(output)) > MCP_RESULT_BYTES)
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "MCP result exceeds 131072 bytes; request a smaller description/page",
        },
      ],
    };
  return output;
}

/** Protocol wrappers borrow the gateway; only the host closes shared state. */
export function createMcpWrapper(gateway: McpGateway): McpServer {
  const server = new McpServer({ name: "spur", version: getVersion() });
  const connection = new AbortController();
  server.server.onclose = () => connection.abort();
  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    write: boolean,
    run: (input: z.output<z.ZodObject<S>>, signal: AbortSignal) => Promise<Record<string, unknown>>,
    annotations?: { idempotentHint: boolean; openWorldHint: boolean },
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: z.object(shape).strict(),
        annotations: {
          readOnlyHint: !write,
          destructiveHint: write,
          idempotentHint: !write,
          openWorldHint: true,
          ...annotations,
        },
      },
      async (input, extra) => {
        if (Buffer.byteLength(JSON.stringify(input)) > 128 * 1024)
          return mcpResult({
            ok: false,
            message: "Tool arguments exceed 131072 bytes; use stage_request",
          });
        const signal = AbortSignal.any([
          extra.signal,
          connection.signal,
          gateway.lifetime.signal,
          AbortSignal.timeout(90_000),
        ]);
        try {
          return mcpResult(await run(input, signal));
        } catch (error) {
          return mcpResult({
            ok: false,
            message: error instanceof Error ? error.message : "MCP request failed",
          });
        }
      },
    );
  }
  register(
    "describe_operations",
    "Discover every daemon operation, fields, modes and examples. Select operationId for its full contract.",
    {
      operationId: id.optional(),
      offset: count.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    false,
    async (input) => {
      const described = describeDaemonOperations({
        ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return { ...described };
    },
  );
  register(
    "daemon_request",
    "Execute any daemon operation with full operator rights. Discover fields through describe_operations. Mutations can delete data; never replay uncertain writes.",
    {
      operationId: id,
      pathParams: params.optional(),
      query: query.optional(),
      body: z.unknown().optional(),
      bodyHandle: id.optional(),
    },
    true,
    (input, signal) => gateway.dispatch(input, signal),
  );
  register(
    "read_response",
    "Read lossless response bytes as base64. Handles expire after 10 minutes or host restart.",
    {
      responseId: id,
      offset: count.optional(),
      limit: z.number().int().min(1).max(32768).optional(),
    },
    false,
    (input) => gateway.results.read(input.responseId, input.offset, input.limit),
  );
  register(
    "release_response",
    "Dispose a retained response and reclaim its quota. Subsequent read_response fails; repeated or unknown IDs return released:false. Request uploads are untouched.",
    { responseId: id },
    true,
    async ({ responseId }) => ({ released: await gateway.results.release(responseId) }),
    { idempotentHint: true, openWorldHint: false },
  );
  register(
    "stage_request",
    "Upload sequential base64 JSON chunks: 32768 decoded bytes each, 15000000 total. complete validates JSON; daemon_request consumes bodyHandle once.",
    {
      bodyHandle: id.optional(),
      offset: count.optional(),
      data: z.string().max(43692),
      complete: z.boolean().optional(),
    },
    true,
    (input) => gateway.results.stage(input),
  );
  register(
    "mcp_status",
    "Read this MCP host and selected daemon identity; daemon outage does not stop the MCP listener.",
    {},
    false,
    async (_input, signal) => {
      const tunnel = await readMcpTunnelStatus(gateway.config.config.dataDir);
      return {
        ok: tunnel.ready,
        pid: process.pid,
        buildId: getBuildId(),
        configPath: gateway.config.config.configPath,
        daemon: await gateway.info(signal),
        tunnel,
      };
    },
  );
  register(
    "restart_daemon",
    "Restart the backend daemon, preserving session agents. Supply a new UUID operationId once; retries reuse that ID. Returns durable accepted receipt, not completion. Resolve with get_daemon_restart after reconnect; never replay unknown effects with a new ID.",
    { operationId: z.string().uuid() },
    true,
    ({ operationId }, signal) => gateway.restartDaemon(operationId, signal),
    { idempotentHint: true, openWorldHint: false },
  );
  register(
    "get_daemon_restart",
    "Read the durable daemon.restart operator receipt during outage or after MCP reconnect. completed requires a different ready daemon generation; accepted/unknown never authorize another restart.",
    { operationId: z.string().uuid() },
    false,
    ({ operationId }, signal) => gateway.getDaemonRestart(operationId, signal),
  );
  register(
    "read_daemon_logs",
    "Read bounded daemon logs: source=runtime selects captured daemon logger/server diagnostics; events selects structured daemon/http events. Session/service/sidecar logs, prebootstrap raw stdio and external journals are excluded. Forward nextCursor; rotation requires a fresh read; oversized records report truncation.",
    {
      cursor: z.string().max(1024).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      maxBytes: z.number().int().min(1024).max(16384).optional(),
      source: z.enum(["events", "runtime"]).optional(),
    },
    false,
    (input, signal) => gateway.daemonLogs(input, signal),
  );
  register(
    "get_session_pr_status",
    "Read existing extracted status for the PR attached to a session: state, CI, review decision, merge conflict, thread counts, ready semantics and cache freshness/provenance. Cache only; never refreshes GitHub. Missing attachment, unknown cache and unavailable web service are distinct.",
    { sessionId: id },
    false,
    ({ sessionId }, signal) => gateway.sessionPrStatus(sessionId, signal),
  );
  register(
    "wait_session",
    "Wait for structured progress. Pass after from spawn/send to require matching submission and assistant/question progress; old idle cannot complete a write.",
    {
      sessionId: id,
      after: id.optional(),
      until: z.enum(["ready", "terminal"]).optional(),
      timeoutMs: z.number().int().min(1).max(90000).optional(),
    },
    false,
    (input, signal) => gateway.wait(input, signal),
  );
  register(
    "list_projects",
    "List all daemon projects, including unconfigured and shepherd projects.",
    {},
    false,
    (_input, signal) => gateway.dispatch({ operationId: "list_projects" }, signal),
  );
  register(
    "list_sessions",
    "List daemon sessions with daemon filters.",
    { view: z.enum(["full", "dashboard"]).optional(), includeCompleted: z.boolean().optional() },
    false,
    (input, signal) =>
      gateway.dispatch(
        {
          operationId: "list_sessions",
          query: {
            ...(input.view ? { view: input.view } : {}),
            ...(input.includeCompleted !== undefined
              ? { includeCompleted: input.includeCompleted ? "1" : "0" }
              : {}),
          },
        },
        signal,
      ),
  );
  register(
    "get_session",
    "Read complete daemon session and lifecycle state.",
    { sessionId: id },
    false,
    (input, signal) => gateway.dispatch({ operationId: "get_session", pathParams: input }, signal),
  );
  register(
    "get_conversation",
    "Read raw tools, outputs, reasoning and questions. view=messages selects bounded display pages. Large raw results have lossless response handles.",
    {
      sessionId: id,
      from: count.optional(),
      view: z.literal("messages").optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    false,
    ({ sessionId, ...input }, signal) =>
      gateway.dispatch(
        { operationId: "get_conversation", pathParams: { sessionId }, query: input },
        signal,
      ),
  );
  server.registerTool(
    "spawn_session",
    {
      description:
        "Spawn a full-access agent. All SpawnSessionRequest fields accepted; background defaults true. describe_operations(spawn_session) describes fields. Agents can delete files.",
      inputSchema: z.object({ project: id, background: z.boolean().optional() }).passthrough(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      if (Buffer.byteLength(JSON.stringify(input)) > 128 * 1024)
        return mcpResult({
          ok: false,
          message: "Use stage_request for arguments exceeding 131072 bytes",
        });
      const { background = true, ...body } = input;
      try {
        return mcpResult(
          await gateway.dispatch(
            { operationId: background ? "spawn_background_session" : "spawn_session", body },
            AbortSignal.any([
              extra.signal,
              connection.signal,
              gateway.lifetime.signal,
              AbortSignal.timeout(90_000),
            ]),
          ),
        );
      } catch (error) {
        return mcpResult({
          ok: false,
          message: error instanceof Error ? error.message : "MCP spawn failed",
        });
      }
    },
  );
  register(
    "send_message",
    "Send all SendMessageRequest fields. queue and interrupt retain daemon semantics. Pass returned after to wait_session.",
    {
      sessionId: id,
      message: z.string(),
      attachments: z.array(z.object({ name: z.string(), data: z.string() })).optional(),
      queue: z.boolean().optional(),
      interrupt: z.boolean().optional(),
    },
    true,
    ({ sessionId, ...body }, signal) =>
      gateway.dispatch({ operationId: "send_message", pathParams: { sessionId }, body }, signal),
  );
  return server;
}

export async function createMcpServer(configPath?: string): Promise<McpServer> {
  const gateway = await McpGateway.create(configPath);
  const server = createMcpWrapper(gateway);
  const close = server.server.onclose;
  server.server.onclose = () => {
    close?.();
    void gateway.close();
  };
  return server;
}

export async function runMcp(configPath?: string): Promise<void> {
  const server = await createMcpServer(configPath);
  const close = () => {
    void server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdin.once("end", close);
  const previous = server.server.onclose;
  server.server.onclose = () => {
    previous?.();
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    process.stdin.removeListener("end", close);
  };
  await server.connect(new StdioServerTransport());
}
