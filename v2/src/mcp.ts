import { realpathSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadInstanceConfigReadOnly } from "./config.js";
import { SESSION_STATES, SPUR_DAEMON_API_VERSION } from "./types.js";
import { getVersion } from "./version.js";

const BODY_BYTES = 8 * 1024 * 1024;
const DATA_BYTES = 48 * 1024;
const RESULT_BYTES = 128 * 1024;
const id = z.string().min(1).max(256);
const sessionId = id.refine(
  (value) => !/[\p{Cc}\s/\\%?#]/u.test(value) && value !== "." && value !== "..",
);
const text = z.string().trim().min(1).max(32768);
const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const page = { offset: offset.optional(), limit: z.number().int().min(1).max(100).optional() };
const state = z.enum(SESSION_STATES);
const projectSchema = z.object({
  id,
  name: z.string(),
  configured: z.boolean(),
  kind: z.enum(["project", "shepherd"]).optional(),
});
const sessionSchema = z.object({
  id: sessionId,
  project: id,
  agent: z.enum(["claude", "codex", "cursor", "opencode"]),
  status: z.enum([
    "spawning",
    "running",
    "stopped",
    "budget_limited",
    "paused",
    "errored",
    "completed",
    "killed",
  ]),
  state,
  branch: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  slots: z.object({ title: z.string().optional() }).optional(),
  error: z.string().optional(),
});
const entrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    timestampMs: z.number().finite().optional(),
  }),
  z.object({ kind: z.literal("tool") }),
  z.object({ kind: z.literal("reasoning") }),
  z.object({ kind: z.literal("question") }),
]);
const conversationSchema = z
  .object({
    state,
    entries: z.array(entrySchema),
    startIndex: offset,
    totalEntries: offset,
  })
  .refine((value) => value.startIndex + value.entries.length <= value.totalEntries);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Invalid daemon response");
  return result.data;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function result(data: NonNullable<CallToolResult["structuredContent"]>): CallToolResult {
  if (bytes(data) > DATA_BYTES)
    throw new Error("Result exceeds MCP data limit; request a smaller page");
  const output: CallToolResult = {
    structuredContent: data,
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
  if (bytes(output) > RESULT_BYTES) throw new Error("Result exceeds MCP result limit");
  return output;
}

function summary(value: z.infer<typeof sessionSchema>) {
  const { slots, error, ...fields } = value;
  const truncatedFields: string[] = [];
  const clip = (key: string, value: string, limit = 512): string => {
    if (value.length <= limit) return value;
    truncatedFields.push(key);
    return value.slice(0, limit);
  };
  return {
    ...fields,
    branch: clip("branch", fields.branch),
    ...(slots?.title !== undefined ? { title: clip("title", slots.title) } : {}),
    ...(error !== undefined ? { error: clip("error", error, 2048) } : {}),
    ...(truncatedFields.length ? { truncatedFields } : {}),
  };
}

function paginate<T>(items: T[], start = 0, limit = 50) {
  const selected = items.slice(start, start + limit);
  return {
    selected,
    total: items.length,
    nextOffset: start + selected.length < items.length ? start + selected.length : null,
  };
}

/** A foreground adapter: never bootstraps config or changes daemon lifecycle. */
export async function createMcpServer(
  configPath?: string,
  projects: string[] = [],
): Promise<McpServer> {
  const loaded = loadInstanceConfigReadOnly(configPath);
  if (loaded.status !== "ok")
    throw new Error("MCP requires an existing valid Spur instance config");
  const config = loaded.config;
  const configIdentity = realpathSync(config.configPath);
  const host =
    config.server.host === "0.0.0.0"
      ? "127.0.0.1"
      : config.server.host === "::"
        ? "::1"
        : config.server.host;
  const baseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${config.server.port}`;
  const filter = new Set(projects.map((project) => id.parse(project)));
  const lifetime = new AbortController();
  const server = new McpServer({ name: "spur", version: getVersion() });
  server.server.onclose = () => lifetime.abort();

  async function request(path: string, signal: AbortSignal, body?: object): Promise<unknown> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal,
      headers: { "x-spur-origin": "mcp", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Daemon request failed");
    }
    if (!response.body) throw new Error("Invalid daemon response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > BODY_BYTES) throw new Error("Daemon response exceeds body limit");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new Error("Invalid daemon JSON response");
    }
  }

  async function scope(signal: AbortSignal) {
    const info = parse(
      z.object({
        ok: z.literal(true),
        apiVersion: z.literal(SPUR_DAEMON_API_VERSION),
        configPath: z.string(),
      }),
      await request("/info", signal),
    );
    let matching = false;
    try {
      matching = realpathSync(info.configPath) === configIdentity;
    } catch {
      /* Missing identity is a different instance. */
    }
    if (!matching) throw new Error("Daemon instance does not match selected config");
    return parse(z.array(projectSchema), await request("/projects", signal)).filter(
      (project) =>
        project.configured &&
        project.kind !== "shepherd" &&
        (!filter.size || filter.has(project.id)),
    );
  }

  const startup = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
  const initial = await scope(startup);
  if ([...filter].some((project) => !initial.some((entry) => entry.id === project)))
    throw new Error("Unavailable MCP launch project");

  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: z.ZodObject<S, "strict">,
    write: boolean,
    run: (
      input: z.output<typeof schema>,
      context: {
        signal: AbortSignal;
        allowed: Set<string>;
        projects: z.infer<typeof projectSchema>[];
        writing: () => void;
      },
    ) => Promise<NonNullable<CallToolResult["structuredContent"]>>,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: !write,
          destructiveHint: write,
          idempotentHint: !write,
          openWorldHint: true,
        },
      },
      async (input, extra) => {
        const mutation = { started: false };
        const signal = AbortSignal.any([
          extra.signal,
          lifetime.signal,
          AbortSignal.timeout(90_000),
        ]);
        try {
          const projects = await scope(signal);
          const allowed = new Set(projects.map((project) => project.id));
          return result(
            await run(input, {
              signal,
              allowed,
              projects,
              writing: () => {
                mutation.started = true;
              },
            }),
          );
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: mutation.started
                  ? "Write outcome uncertain. Inspect session state before resubmitting; no automatic retry was made."
                  : "MCP request failed: unavailable resource, invalid daemon response, or request limit reached.",
              },
            ],
          };
        }
      },
    );
  }

  function authorize(project: string, allowed: Set<string>) {
    if (!allowed.has(project)) throw new Error("Unavailable resource");
  }
  async function detail(id: string, allowed: Set<string>, signal: AbortSignal) {
    const value = parse(
      sessionSchema,
      await request(`/sessions/${encodeURIComponent(id)}`, signal),
    );
    if (value.id !== id) throw new Error("Invalid daemon response");
    authorize(value.project, allowed);
    return value;
  }

  register(
    "list_projects",
    "List configured projects available to this MCP connection.",
    z.object(page).strict(),
    false,
    async (input, { projects }) => {
      const items = projects
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(({ id, name }) => ({
          id,
          name: name.slice(0, 512),
          ...(name.length > 512 ? { nameTruncated: true } : {}),
        }));
      const { selected, ...pagination } = paginate(items, input.offset, input.limit);
      return { projects: selected, ...pagination };
    },
  );
  register(
    "list_sessions",
    "List scoped sessions; completed sessions excluded by default.",
    z
      .object({ ...page, project: id.optional(), includeCompleted: z.boolean().optional() })
      .strict(),
    false,
    async (input, { signal, allowed }) => {
      if (input.project !== undefined) authorize(input.project, allowed);
      const items = parse(
        z.array(sessionSchema),
        await request(
          `/sessions?includeCompleted=${input.includeCompleted === true ? "1" : "0"}`,
          signal,
        ),
      )
        .filter(
          (session) =>
            allowed.has(session.project) && (!input.project || session.project === input.project),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
        .map(summary);
      const { selected, ...pagination } = paginate(items, input.offset, input.limit);
      return { sessions: selected, ...pagination };
    },
  );
  register(
    "get_session",
    "Read scoped session state, including background task errors.",
    z.object({ sessionId }).strict(),
    false,
    async (input, { signal, allowed }) => summary(await detail(input.sessionId, allowed, signal)),
  );
  register(
    "get_conversation",
    "Read user/assistant messages. Cursors count source entries, including hidden tools/reasoning.",
    z.object({ sessionId, from: offset.optional(), limit: page.limit }).strict(),
    false,
    async (input, { signal, allowed }) => {
      await detail(input.sessionId, allowed, signal);
      const value = parse(
        conversationSchema,
        await request(
          `/sessions/${encodeURIComponent(input.sessionId)}/conversation${input.from === undefined ? "" : `?from=${input.from}`}`,
          signal,
        ),
      );
      const messages: {
        index: number;
        role: "user" | "assistant";
        text: string;
        timestampMs?: number;
        textTruncated?: boolean;
      }[] = [];
      let consumed = 0;
      for (const entry of value.entries.slice(0, input.limit ?? 50)) {
        if (entry.kind === "message") {
          const message = {
            index: value.startIndex + consumed,
            role: entry.role,
            text: entry.text.slice(0, 8192),
            ...(entry.timestampMs !== undefined ? { timestampMs: entry.timestampMs } : {}),
            ...(entry.text.length > 8192 ? { textTruncated: true } : {}),
          };
          while (messages.length === 0 && bytes(message) > DATA_BYTES - 2048) {
            message.text = message.text.slice(0, Math.floor(message.text.length / 2));
            message.textTruncated = true;
          }
          if (bytes(messages) + bytes(message) > DATA_BYTES - 2048) break;
          messages.push(message);
        }
        consumed++;
      }
      const nextFrom = value.startIndex + consumed;
      return {
        sessionId: input.sessionId,
        state: value.state,
        messages,
        startIndex: value.startIndex,
        totalEntries: value.totalEntries,
        nextFrom,
        hasMoreBefore: value.startIndex > 0,
        hasMoreAfter: nextFrom < value.totalEntries,
      };
    },
  );
  register(
    "spawn_session",
    "Execute a full-access coding agent in a scoped project. Returns accepted background task; poll session/conversation for completion. Agents can replace/delete files.",
    z.object({ project: id, prompt: text }).strict(),
    true,
    async (input, { signal, allowed, writing }) => {
      authorize(input.project, allowed);
      writing();
      const value = parse(
        sessionSchema,
        await request("/sessions/background", signal, {
          project: input.project,
          prompt: input.prompt,
        }),
      );
      if (value.project !== input.project) throw new Error("Invalid daemon response");
      return summary(value);
    },
  );
  register(
    "send_message",
    "Send a followup to a scoped full-access coding agent, retaining daemon queue/interrupt defaults. Agents can replace/delete files.",
    z.object({ sessionId, message: text }).strict(),
    true,
    async (input, { signal, allowed, writing }) => {
      const before = await detail(input.sessionId, allowed, signal);
      writing();
      const value = parse(
        sessionSchema,
        await request(`/sessions/${encodeURIComponent(input.sessionId)}/send`, signal, {
          message: input.message,
        }),
      );
      if (value.id !== before.id || value.project !== before.project)
        throw new Error("Invalid daemon response");
      return summary(value);
    },
  );
  return server;
}

export async function runMcp(configPath?: string, projects?: string[]): Promise<void> {
  const server = await createMcpServer(configPath, projects);
  const close = () => {
    void server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdin.once("end", close);
  server.server.onclose = (() => {
    const onclose = server.server.onclose;
    return () => {
      onclose?.();
      process.removeListener("SIGINT", close);
      process.removeListener("SIGTERM", close);
      process.stdin.removeListener("end", close);
    };
  })();
  await server.connect(new StdioServerTransport());
}
