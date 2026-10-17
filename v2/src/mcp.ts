import { PassThrough } from "node:stream";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { connectDaemon, type ConnectedDaemon } from "./client.js";
import { SESSION_STATES, type AgentName, type SessionStatus } from "./types.js";
import { getVersion } from "./version.js";

const id = z.string().min(1).max(128);
const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const agent = z.enum(["claude", "codex", "cursor", "opencode"] satisfies AgentName[]);
const state = z.enum(SESSION_STATES);
const status = z.enum([
  "spawning",
  "running",
  "stopped",
  "budget_limited",
  "paused",
  "errored",
  "completed",
  "killed",
] satisfies SessionStatus[]);
const text = z
  .string()
  .max(32_000)
  .refine((value) => value.trim().length > 0);
const paging = { offset: offset.optional(), limit: z.number().int().min(1).max(50).optional() };
const sessionSchema = z.object({
  id,
  project: id,
  agent,
  status,
  state,
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
  prompt: z.string(),
  slots: z.object({ title: z.string().optional() }).optional(),
});
const projectSchema = z.object({ id, name: z.string(), configured: z.boolean() });
const messageSchema = z.object({
  kind: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  timestampMs: z.number().finite().optional(),
});
const entrySchema = z.discriminatedUnion("kind", [
  messageSchema,
  z.object({ kind: z.literal("tool") }),
  z.object({ kind: z.literal("reasoning") }),
  z.object({ kind: z.literal("question") }),
]);
const conversationSchema = z
  .object({ state, startIndex: offset, totalEntries: offset, entries: z.array(entrySchema) })
  .refine((value) => value.startIndex + value.entries.length <= value.totalEntries);

function summary(session: z.output<typeof sessionSchema>) {
  const title = session.slots?.title;
  return {
    id: session.id,
    project: session.project,
    agent: session.agent,
    status: session.status,
    state: session.state,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(title !== undefined ? { title: title.slice(0, 256) } : {}),
    promptPreview: session.prompt.slice(0, 512),
    truncated: session.prompt.length > 512 || (title?.length ?? 0) > 256,
  };
}

function page<T>(items: T[], options: { offset?: number | undefined; limit?: number | undefined }) {
  const start = options.offset ?? 0;
  const values = items.slice(start, start + (options.limit ?? 20));
  return {
    values,
    total: items.length,
    nextOffset: start + values.length < items.length ? start + values.length : null,
  };
}

function conversation(value: unknown, sessionId: string, from?: number) {
  const source = conversationSchema.parse(value);
  const reset = from !== undefined && (from > source.totalEntries || source.startIndex > from);
  const messages: Array<{
    index: number;
    role: "user" | "assistant";
    text: string;
    timestampMs?: number;
    truncated: boolean;
  }> = [];
  let nextFrom = source.startIndex;
  let remaining = 24_000;
  if (from === source.totalEntries || source.totalEntries === 0) {
    return {
      sessionId,
      state: source.state,
      startIndex: source.totalEntries,
      nextFrom: source.totalEntries,
      totalEntries: source.totalEntries,
      reset,
      hasMore: false,
      messages,
    };
  }
  for (const [position, entry] of source.entries.entries()) {
    const index = source.startIndex + position;
    if (entry.kind === "message") {
      if (messages.length === 20 || Math.min(entry.text.length, 8_000) > remaining) break;
      const clipped = entry.text.slice(0, 8_000);
      messages.push({
        index,
        role: entry.role,
        text: clipped,
        ...(entry.timestampMs !== undefined ? { timestampMs: entry.timestampMs } : {}),
        truncated: clipped.length < entry.text.length,
      });
      remaining -= clipped.length;
    }
    nextFrom = index + 1;
  }
  return {
    sessionId,
    state: source.state,
    startIndex: source.startIndex,
    nextFrom,
    totalEntries: source.totalEntries,
    reset,
    hasMore: nextFrom < source.totalEntries,
    messages,
  };
}

function failure(invalid: boolean, outcomeUnknown: boolean): CallToolResult {
  const error = {
    code: invalid ? "invalid_daemon_response" : "operation_failed",
    message: outcomeUnknown
      ? "Request outcome unknown. Inspect sessions before retrying."
      : "Spur request failed.",
    outcomeUnknown,
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] };
}

function result(value: Record<string, unknown>, mutation: boolean): CallToolResult {
  const response: CallToolResult = {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
  return Buffer.byteLength(JSON.stringify(response)) <= 1_048_576
    ? response
    : failure(true, mutation);
}

/** Fixed tools over one startup-bound daemon; no endpoint or lifecycle tools. */
export function createMcpServer(
  daemon: ConnectedDaemon,
  shutdown: AbortSignal = new AbortController().signal,
): McpServer {
  const server = new McpServer({ name: "spur", version: getVersion() });
  function tool<S extends z.ZodObject>(
    name: string,
    description: string,
    schema: S,
    mutation: boolean,
    action: (args: z.output<S>, signal: AbortSignal) => Promise<Record<string, unknown>>,
  ) {
    const callback: ToolCallback<z.ZodObject> = async (args, extra) => {
      if (shutdown.aborted || extra.signal.aborted) return failure(false, false);
      try {
        return result(
          await action(args as z.output<S>, AbortSignal.any([shutdown, extra.signal])),
          mutation,
        );
      } catch (error) {
        return failure(error instanceof z.ZodError, mutation);
      }
    };
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: !mutation,
          destructiveHint: mutation,
          idempotentHint: !mutation,
          openWorldHint: mutation,
        },
      },
      callback as ToolCallback<S>,
    );
  }
  tool(
    "list_projects",
    "Discover configured Spur projects. Offset paging follows a mutable snapshot.",
    z.object(paging).strict(),
    false,
    async (args, signal) => {
      const projects = z.array(projectSchema).parse(await daemon.get("/projects", signal));
      const selected = page(projects, args);
      return {
        projects: selected.values.map((project) => ({
          id: project.id,
          name: project.name.slice(0, 256),
          configured: project.configured,
          ...(project.name.length > 256 ? { truncated: true } : {}),
        })),
        total: selected.total,
        nextOffset: selected.nextOffset,
      };
    },
  );
  tool(
    "list_sessions",
    "List Spur sessions. Offset paging follows a mutable snapshot.",
    z
      .object({ ...paging, project: id.optional(), includeCompleted: z.boolean().optional() })
      .strict(),
    false,
    async (args, signal) => {
      const sessions = z
        .array(sessionSchema)
        .parse(
          await daemon.get(
            `/sessions?view=dashboard&includeCompleted=${args.includeCompleted ?? false}`,
            signal,
          ),
        );
      const selected = page(
        sessions.filter(
          (session) => args.project === undefined || session.project === args.project,
        ),
        args,
      );
      return {
        sessions: selected.values.map(summary),
        total: selected.total,
        nextOffset: selected.nextOffset,
      };
    },
  );
  tool(
    "get_session",
    "Inspect Spur session state and prompt preview.",
    z.object({ sessionId: id }).strict(),
    false,
    async (args, signal) => ({
      session: summary(
        sessionSchema.parse(
          await daemon.get(`/sessions/${encodeURIComponent(args.sessionId)}`, signal),
        ),
      ),
    }),
  );
  tool(
    "read_conversation",
    "Read user/assistant text with source-entry cursor. Default: transcript tail. Clipped text is consumed; use nextFrom for subsequent entries.",
    z.object({ sessionId: id, from: offset.optional() }).strict(),
    false,
    async (args, signal) =>
      conversation(
        await daemon.get(
          `/sessions/${encodeURIComponent(args.sessionId)}/conversation${args.from !== undefined ? `?from=${args.from}` : ""}`,
          signal,
        ),
        args.sessionId,
        args.from,
      ),
  );
  const authority =
    " Agent work uses daemon user's configured access and can change files or invoke external services. Acceptance is not work completion. On uncertain outcome inspect sessions before retrying.";
  tool(
    "spawn_session",
    "Start agent work in a configured project." + authority,
    z.object({ project: id, prompt: text, agent: agent.optional() }).strict(),
    true,
    async (args, signal) => ({
      session: summary(
        sessionSchema.parse(
          await daemon.post(
            "/sessions/background",
            {
              project: args.project,
              prompt: args.prompt,
              ...(args.agent !== undefined ? { agent: args.agent } : {}),
            },
            signal,
          ),
        ),
      ),
    }),
  );
  tool(
    "send_message",
    "Queue a follow-up for a Spur session." + authority,
    z.object({ sessionId: id, message: text }).strict(),
    true,
    async (args, signal) => ({
      session: summary(
        sessionSchema.parse(
          await daemon.post(
            `/sessions/${encodeURIComponent(args.sessionId)}/send`,
            { message: args.message, queue: true },
            signal,
          ),
        ),
      ),
    }),
  );
  return server;
}

export async function runMcp(configPath?: string): Promise<void> {
  const shutdown = new AbortController();
  const input = new PassThrough({ highWaterMark: STDIO_DEFAULT_MAX_BUFFER_SIZE });
  let server: McpServer | undefined;
  const close = () => {
    shutdown.abort();
    void server?.close();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  process.stdin.once("end", close);
  // Drain stdin during the probe; retain frames until the SDK attaches.
  process.stdin.pipe(input);
  try {
    const daemon = await connectDaemon(configPath, shutdown.signal);
    if (shutdown.signal.aborted) return;
    const runningServer = createMcpServer(daemon, shutdown.signal);
    server = runningServer;
    const closed = new Promise<void>((resolve) => {
      runningServer.server.onclose = resolve;
      if (shutdown.signal.aborted) {
        void runningServer.close();
      }
    });
    await runningServer.connect(new StdioServerTransport(input));
    await closed;
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    shutdown.abort();
    await server?.close();
    process.removeListener("SIGTERM", close);
    process.removeListener("SIGINT", close);
    process.stdin.removeListener("end", close);
    process.stdin.unpipe(input);
    input.destroy();
    process.stdin.pause();
  }
}
