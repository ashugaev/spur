import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadInstanceConfigReadOnly } from "./config.js";
import { getDaemonOperation } from "./daemon-contracts.js";
import { SPUR_DAEMON_API_VERSION } from "./types.js";
import { McpResults } from "./mcp-results.js";
import { getBuildId } from "./build-identity.js";

export interface DaemonRequest {
  operationId: string;
  pathParams?: Record<string, string> | undefined;
  query?: Record<string, string | number | boolean | undefined> | undefined;
  body?: unknown;
  bodyHandle?: string | undefined;
}

interface WaitCursor {
  sessionId: string;
  instanceId: string;
  from: number;
  message?: string | undefined;
  unconfirmed: boolean;
  spawn: boolean;
  generation?: string | undefined;
  expires: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid daemon object response");
  return value as Record<string, unknown>;
}

export class McpGateway {
  readonly lifetime = new AbortController();
  private readonly cursors = new Map<string, WaitCursor>();
  private constructor(
    readonly config: ReturnType<typeof loadInstanceConfigReadOnly> & { status: "ok" },
    readonly results: McpResults,
    private readonly baseUrl: string,
    private readonly configIdentity: string,
  ) {}

  static async create(configPath?: string): Promise<McpGateway> {
    const loaded = loadInstanceConfigReadOnly(configPath);
    if (loaded.status !== "ok")
      throw new Error("MCP requires an existing valid Spur instance config");
    const host =
      loaded.config.server.host === "0.0.0.0"
        ? "127.0.0.1"
        : loaded.config.server.host === "::"
          ? "::1"
          : loaded.config.server.host;
    return new McpGateway(
      loaded,
      await McpResults.create(loaded.config.dataDir),
      `http://${host.includes(":") ? `[${host}]` : host}:${loaded.config.server.port}`,
      realpathSync(loaded.config.configPath),
    );
  }

  private fetch(path: string, signal: AbortSignal, method = "GET", body?: string | Buffer) {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      signal,
      redirect: "manual",
      headers: {
        "x-spur-origin": "mcp",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
  }

  private async json(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.fetch(path, signal);
    const raw = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Daemon ${response.status}: invalid JSON`);
    }
    if (!response.ok) throw new Error(`Daemon ${response.status}: ${raw.slice(0, 2048)}`);
    return object(value);
  }

  async info(signal: AbortSignal): Promise<Record<string, unknown>> {
    const info = await this.json("/info", signal);
    if (info.ok !== true || info.apiVersion !== SPUR_DAEMON_API_VERSION)
      throw new Error("Daemon API mismatch or unavailable; wait for installed services to recover");
    if (info.buildId !== getBuildId())
      throw new Error("Daemon/MCP build mismatch; wait for installed services to recover");
    let matches = false;
    try {
      matches =
        typeof info.configPath === "string" &&
        realpathSync(info.configPath) === this.configIdentity;
    } catch {
      /* An absent config is not this instance. */
    }
    if (!matches) throw new Error("Daemon instance does not match selected config");
    const { ok, apiVersion, buildId, pid, configPath, lifecycleInstanceId } = info;
    return { ok, apiVersion, buildId, pid, configPath, lifecycleInstanceId };
  }

  async dispatch(input: DaemonRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    const operation = getDaemonOperation(input.operationId);
    if (!operation) throw new Error("Unknown daemon operation; use describe_operations");
    if (input.body !== undefined && input.bodyHandle !== undefined)
      throw new Error("Use body or bodyHandle, not both");
    const params = input.pathParams ?? {};
    if (Object.keys(params).some((name) => !operation.pathParams.includes(name)))
      throw new Error("Unexpected daemon path parameter");
    let path = operation.path;
    for (const name of operation.pathParams) {
      const value = params[name];
      if (!value || /[\p{Cc}]/u.test(value))
        throw new Error(`Missing or invalid path parameter: ${name}`);
      const parts = operation.catchAllPathParams?.includes(name) ? value.split("/") : [value];
      if (parts.some((part) => !part || part === "." || part === ".."))
        throw new Error("Invalid path segment");
      path = path.replace(`{${name}}`, parts.map(encodeURIComponent).join("/"));
    }
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("{"))
      throw new Error("Invalid daemon path");
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(input.query ?? {}))
      if (value !== undefined) query.set(name, String(value));
    if (query.size) path += `?${query}`;
    const info = await this.info(signal);
    let cursor: WaitCursor | undefined;
    if (
      input.operationId === "send_message" ||
      input.operationId === "spawn_session" ||
      input.operationId === "spawn_background_session"
    ) {
      const writeBody = input.body === undefined ? undefined : object(input.body);
      const sessionId = params.sessionId;
      const before = sessionId ? await this.conversation(sessionId, signal) : undefined;
      const beforeSession = sessionId
        ? await this.json(`/sessions/${encodeURIComponent(sessionId)}`, signal)
        : undefined;
      cursor = {
        sessionId: sessionId ?? "",
        instanceId: String(info.lifecycleInstanceId ?? ""),
        from: typeof before?.totalEntries === "number" ? before.totalEntries : 0,
        message:
          typeof writeBody?.message === "string"
            ? writeBody.message.trim()
            : typeof writeBody?.prompt === "string"
              ? writeBody.prompt.trim()
              : undefined,
        unconfirmed:
          input.bodyHandle !== undefined ||
          (typeof writeBody?.message === "string" && writeBody.message.length > 8192) ||
          (Array.isArray(writeBody?.attachments) && writeBody.attachments.length > 0),
        spawn: input.operationId !== "send_message",
        generation:
          typeof beforeSession?.agentSessionId === "string"
            ? beforeSession.agentSessionId
            : undefined,
        expires: Date.now() + 600_000,
      };
    }
    const body =
      input.bodyHandle !== undefined
        ? await this.results.consume(input.bodyHandle)
        : input.body !== undefined
          ? JSON.stringify(input.body)
          : undefined;
    if (cursor && Buffer.isBuffer(body)) {
      let staged: unknown;
      try {
        staged = JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        throw new Error("Staged request JSON could not be read");
      }
      const request = object(staged);
      cursor.message =
        typeof request.message === "string"
          ? request.message.trim()
          : typeof request.prompt === "string"
            ? request.prompt.trim()
            : undefined;
      cursor.unconfirmed =
        (Array.isArray(request.attachments) && request.attachments.length > 0) ||
        (cursor.message?.length ?? 0) > 8192;
    }
    let started = false;
    try {
      started = operation.method !== "GET";
      const response = await this.fetch(path, signal, operation.method, body);
      const after = cursor && response.ok ? randomUUID() : undefined;
      const captured = await this.results.capture(response, signal, after ? { after } : undefined);
      if (cursor && response.ok) {
        const responseBody =
          captured.body ??
          (typeof captured.responseId === "string"
            ? await this.results.inspectJson(captured.responseId)
            : undefined);
        if (
          !cursor.sessionId &&
          responseBody &&
          typeof responseBody === "object" &&
          "id" in responseBody &&
          typeof responseBody.id === "string"
        )
          cursor.sessionId = responseBody.id;
        if (cursor.sessionId) {
          for (const [id, value] of this.cursors)
            if (value.expires <= Date.now()) this.cursors.delete(id);
          if (this.cursors.size >= 32) this.cursors.delete(this.cursors.keys().next().value ?? "");
          if (after) this.cursors.set(after, cursor);
        } else delete captured.after;
      }
      return captured;
    } catch (error) {
      return {
        ok: false,
        transportError: true,
        uncertainWrite: started,
        message: error instanceof Error ? error.message : "Daemon transport failed",
        ...(started
          ? { recovery: "Inspect daemon state before resubmitting; no automatic retry was made" }
          : {}),
      };
    }
  }

  private conversation(sessionId: string, signal: AbortSignal, from?: number) {
    return this.json(
      `/sessions/${encodeURIComponent(sessionId)}/conversation?view=messages&limit=100${from === undefined ? "" : `&from=${from}`}`,
      signal,
    );
  }

  private async hasNewQuestion(
    sessionId: string,
    from: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const response = await this.fetch(
      `/sessions/${encodeURIComponent(sessionId)}/conversation?from=${from}`,
      signal,
    );
    const captured = await this.results.capture(response, signal);
    try {
      if (!response.ok) return false;
      const value =
        captured.body ??
        (typeof captured.responseId === "string"
          ? await this.results.inspectJson(captured.responseId)
          : undefined);
      if (
        !value ||
        typeof value !== "object" ||
        !("entries" in value) ||
        !Array.isArray(value.entries) ||
        !("startIndex" in value) ||
        typeof value.startIndex !== "number"
      )
        return false;
      const startIndex = value.startIndex;
      return value.entries.some(
        (entry: unknown, index: number) =>
          startIndex + index >= from &&
          entry !== null &&
          typeof entry === "object" &&
          "kind" in entry &&
          entry.kind === "question",
      );
    } finally {
      if (typeof captured.responseId === "string") await this.results.release(captured.responseId);
    }
  }

  async wait(
    input: {
      sessionId: string;
      after?: string | undefined;
      until?: "ready" | "terminal" | undefined;
      timeoutMs?: number | undefined;
    },
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const cursor = input.after ? this.cursors.get(input.after) : undefined;
    if (
      input.after &&
      (!cursor || cursor.sessionId !== input.sessionId || cursor.expires <= Date.now())
    )
      throw new Error("Unknown or expired wait cursor");
    const deadline = Date.now() + (input.timeoutMs ?? 55_000);
    const timeout = AbortSignal.timeout(input.timeoutMs ?? 55_000);
    const waiting = AbortSignal.any([signal, timeout]);
    let submitted = false;
    let submittedIndex: number | undefined;
    let progressed = false;
    let nextFrom = cursor?.from ?? 0;
    let firstTotal: number | undefined;
    let latest: Record<string, unknown> = {};
    try {
      for (;;) {
        waiting.throwIfAborted();
        const info = await this.info(waiting);
        const session = await this.json(
          `/sessions/${encodeURIComponent(input.sessionId)}`,
          waiting,
        );
        const history = await this.conversation(input.sessionId, waiting, nextFrom);
        const total = typeof history.totalEntries === "number" ? history.totalEntries : 0;
        firstTotal ??= total;
        const reset =
          (cursor && cursor.instanceId !== String(info.lifecycleInstanceId ?? "")) ||
          (cursor?.generation !== undefined && session.agentSessionId !== cursor.generation) ||
          total < nextFrom ||
          total < firstTotal;
        if (cursor && cursor.generation === undefined && typeof session.agentSessionId === "string")
          cursor.generation = session.agentSessionId;
        const terminal = ["completed", "killed", "errored"].includes(String(session.status));
        const queued = object(session.queuedMessages ?? {});
        const pending =
          session.status === "spawning" ||
          Boolean(session.submitUnconfirmedAt || session.queuedMessageTyped) ||
          Object.values(queued).some((value) =>
            Array.isArray(value)
              ? value.length > 0
              : value === true || (typeof value === "number" && value > 0),
          );
        const messages = Array.isArray(history.messages) ? history.messages : [];
        for (const entry of messages) {
          const message = object(entry);
          if (
            message.role === "user" &&
            cursor?.message &&
            typeof message.text === "string" &&
            (cursor.spawn ? message.text.includes(cursor.message) : message.text === cursor.message)
          ) {
            submitted = true;
            progressed = false;
            if (typeof message.index === "number") submittedIndex = message.index;
          } else if (submitted && message.role === "assistant") progressed = true;
        }
        if (submittedIndex !== undefined && !progressed && session.state === "needs_input")
          progressed = await this.hasNewQuestion(input.sessionId, submittedIndex + 1, waiting);
        if (typeof history.nextFrom === "number") nextFrom = history.nextFrom;
        const ready =
          !pending &&
          history.hasMoreAfter !== true &&
          (cursor ? !cursor.unconfirmed && submitted && progressed : true) &&
          ["waiting", "needs_input", "rate_limited", "paused", "stopped", "error"].includes(
            String(session.state),
          );
        const reason = reset
          ? "cursor-reset"
          : terminal
            ? "terminal"
            : input.until !== "terminal" && ready
              ? "ready"
              : Date.now() >= deadline
                ? "timeout"
                : undefined;
        latest = {
          sessionId: input.sessionId,
          status: session.status,
          state: session.state,
          pending,
          submitted,
          progressed,
          unconfirmed: cursor?.unconfirmed ?? false,
          nextFrom,
          messagesPreview: true,
          messages: messages.slice(-3).map((entry) => {
            const message = object(entry);
            return {
              role: message.role,
              index: message.index,
              text: typeof message.text === "string" ? message.text.slice(0, 1024) : "",
              textTruncated:
                message.textTruncated === true ||
                (typeof message.text === "string" && message.text.length > 1024),
            };
          }),
          logs: { operationId: "get_session_logs", pathParams: { sessionId: input.sessionId } },
          conversation: {
            operationId: "get_conversation",
            pathParams: { sessionId: input.sessionId },
            query: { from: cursor?.from ?? 0 },
          },
          ...(session.state === "needs_input"
            ? {
                question: {
                  operationId: "get_conversation",
                  pathParams: { sessionId: input.sessionId },
                },
                answer: {
                  operationId: "answer_question",
                  pathParams: { sessionId: input.sessionId },
                  contract: "describe_operations",
                },
              }
            : {}),
        };
        if (reason) return { ...latest, reason };
        if (history.hasMoreAfter === true) continue;
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            waiting.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            clearTimeout(timer);
            waiting.removeEventListener("abort", abort);
            reject(waiting.reason);
          };
          const timer = setTimeout(done, Math.min(1000, Math.max(1, deadline - Date.now())));
          waiting.addEventListener("abort", abort, { once: true });
        });
      }
    } catch (error) {
      if (timeout.aborted && !signal.aborted)
        return {
          ...latest,
          reason: "timeout",
          sessionId: input.sessionId,
          submitted,
          progressed,
          unconfirmed: cursor?.unconfirmed ?? false,
          nextFrom,
        };
      throw error;
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await this.results.close();
  }
}
