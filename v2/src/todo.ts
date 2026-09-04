import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeSession } from "./metadata.js";
import {
  type SessionRecord,
  type TodoActor,
  type TodoBlocker,
  type TodoEvent,
  type TodoItemProjection,
  type TodoMutationRequest,
  type TodoProjection,
} from "./types.js";

export class TodoLedgerCorruptError extends Error {
  readonly statusCode = 500;
  readonly code = "todo_ledger_corrupt";
  constructor(
    readonly sessionId: string,
    message: string,
    readonly line?: number,
  ) {
    super(message);
  }
}

export class InvalidTodoRequestError extends Error {
  readonly statusCode = 400;
  readonly code = "invalid_todo_request";
}

export class TodoTransitionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "todo_transition_conflict";
  constructor(
    readonly sessionId: string,
    readonly itemId: string,
    message: string,
  ) {
    super(message);
  }
}

export class TodoOpenWorkError extends Error {
  readonly statusCode = 409;
  readonly code = "todo_open_work";
  constructor(
    readonly sessions: Array<{ sessionId: string; openItemIds: string[]; heldItemIds: string[] }>,
  ) {
    super(
      'Spur ToDo has open or held items. Resolve each with "$SPUR_TODO_COMMAND" complete/cancel/resume --reason <why>.',
    );
  }
}

export class TodoEmptyLedgerError extends Error {
  readonly statusCode = 409;
  readonly code = "todo_ledger_empty";
  constructor(readonly sessionIds: string[]) {
    super(
      'Spur ToDo ledger is empty. Record each step with "$SPUR_TODO_COMMAND" add --text <step> --reason <why>, then complete it.',
    );
  }
}

function ledgerPath(dataDir: string, sessionId: string, project?: string): string {
  const live = join(dataDir, "sessions", sessionId, "todo.jsonl");
  if (existsSync(live)) return live;
  if (project) {
    const archived = join(dataDir, "sessions-archive", project, sessionId, "todo.jsonl");
    if (existsSync(join(dataDir, "sessions-archive", project, sessionId))) return archived;
  }
  const archiveRoot = join(dataDir, "sessions-archive");
  if (existsSync(archiveRoot)) {
    for (const projectId of readdirSync(archiveRoot)) {
      const archived = join(archiveRoot, projectId, sessionId, "todo.jsonl");
      if (existsSync(archived)) return archived;
    }
  }
  return live;
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function actorValid(actor: unknown): actor is TodoActor {
  if (!actor || typeof actor !== "object") return false;
  const value = actor as Record<string, unknown>;
  if (value.kind === "agent") {
    return (
      (value.agent === "claude" ||
        value.agent === "codex" ||
        value.agent === "cursor" ||
        value.agent === "opencode") &&
      nonblank(value.sessionId)
    );
  }
  if (value.kind === "human") return value.origin === "cli" || value.origin === "ui";
  return (
    value.kind === "system" &&
    (value.source === "spawn" || value.source === "legacy_migration" || value.source === "handoff")
  );
}

function parseEvent(raw: unknown, owner: string, line: number): TodoEvent {
  const fail = (message: string): never => {
    throw new TodoLedgerCorruptError(owner, message, line);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Event is not an object");
  const event = raw as Record<string, unknown>;
  if (
    event.version !== 1 ||
    !nonblank(event.eventId) ||
    event.sessionId !== owner ||
    !nonblank(event.at) ||
    Number.isNaN(Date.parse(event.at)) ||
    !actorValid(event.actor) ||
    !nonblank(event.type)
  ) {
    fail("Event envelope is invalid");
  }
  if (event.type === "item_added") {
    if (!nonblank(event.itemId) || !nonblank(event.text) || !nonblank(event.reason)) {
      fail("Added item fields are invalid");
    }
  } else if (event.type === "item_completed" || event.type === "item_cancelled") {
    if (!nonblank(event.itemId) || !nonblank(event.reason)) fail("Resolution fields are invalid");
  } else if (event.type === "item_held") {
    if (
      !nonblank(event.itemId) ||
      !nonblank(event.reason) ||
      !event.blocker ||
      typeof event.blocker !== "object"
    ) {
      fail("Hold fields are invalid");
    }
    const blocker = event.blocker as Record<string, unknown>;
    if (
      blocker.kind !== "external" &&
      !(blocker.kind === "human" && nonblank(blocker.requiredAction))
    ) {
      fail("Hold blocker is invalid");
    }
  } else if (event.type === "item_resumed") {
    if (!nonblank(event.itemId)) fail("Resume item id is invalid");
  } else if (event.type === "finish_override_recorded") {
    if (
      !nonblank(event.reason) ||
      !Array.isArray(event.unfinishedItemIds) ||
      !event.unfinishedItemIds.every(nonblank)
    ) {
      fail("Finish override fields are invalid");
    }
  } else {
    fail("Event type is unknown");
  }
  return event as unknown as TodoEvent;
}

function appendEvent(dataDir: string, event: TodoEvent, project?: string): void {
  const path = ledgerPath(dataDir, event.sessionId, project);
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "a", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(event)}\n`, undefined, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function eventBase(sessionId: string, actor: TodoActor) {
  return {
    version: 1 as const,
    eventId: randomUUID(),
    sessionId,
    at: new Date().toISOString(),
    actor,
  };
}

export function replayTodo(dataDir: string, sessionId: string): TodoProjection {
  const path = ledgerPath(dataDir, sessionId);
  if (!existsSync(path)) throw new TodoLedgerCorruptError(sessionId, "ToDo ledger is missing");
  const text = readFileSync(path, "utf8");
  if (!text || !text.endsWith("\n"))
    throw new TodoLedgerCorruptError(sessionId, "ToDo ledger is empty or truncated");
  const events = text
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      try {
        return parseEvent(JSON.parse(line) as unknown, sessionId, index + 1);
      } catch (error) {
        if (error instanceof TodoLedgerCorruptError) throw error;
        throw new TodoLedgerCorruptError(sessionId, "ToDo ledger contains invalid JSON", index + 1);
      }
    });
  const eventIds = new Set<string>();
  const items: TodoItemProjection[] = [];
  const byId = new Map<string, TodoItemProjection>();
  const finishOverrides: TodoEvent[] = [];
  for (const event of events) {
    if (eventIds.has(event.eventId))
      throw new TodoLedgerCorruptError(sessionId, "Duplicate event id");
    eventIds.add(event.eventId);
    if (event.type === "item_added") {
      if (byId.has(event.itemId)) throw new TodoLedgerCorruptError(sessionId, "Duplicate item id");
      const item: TodoItemProjection = {
        id: event.itemId,
        text: event.text,
        status: "open",
        added: { reason: event.reason, actor: event.actor, at: event.at },
        history: [event],
      };
      items.push(item);
      byId.set(item.id, item);
      continue;
    }
    // No writer left: overrides ended when a human close stopped being gated.
    // Ledgers written before that still replay, so the branch stays.
    if (event.type === "finish_override_recorded") {
      const unfinished = items
        .filter((item) => item.status === "open" || item.status === "held")
        .map((item) => item.id);
      if (event.unfinishedItemIds.join("\0") !== unfinished.join("\0")) {
        throw new TodoLedgerCorruptError(sessionId, "Finish override item set is invalid");
      }
      finishOverrides.push(event);
      continue;
    }
    const item = byId.get(event.itemId);
    if (!item) throw new TodoLedgerCorruptError(sessionId, "Event references an unknown item");
    const terminal = item.status === "completed" || item.status === "cancelled";
    if (
      terminal ||
      (event.type === "item_resumed" && item.status !== "held") ||
      (event.type === "item_held" && item.status !== "open")
    ) {
      throw new TodoLedgerCorruptError(sessionId, "Event contains an invalid transition");
    }
    item.history.push(event);
    if (event.type === "item_completed") item.status = "completed";
    if (event.type === "item_cancelled") item.status = "cancelled";
    if (event.type === "item_held") item.status = "held";
    if (event.type === "item_resumed") item.status = "open";
    item.latestTransition = {
      type: event.type.replace("item_", "") as "completed" | "cancelled" | "held" | "resumed",
      ...(event.type !== "item_resumed" ? { reason: event.reason } : {}),
      ...(event.type === "item_held" ? { blocker: event.blocker } : {}),
      actor: event.actor,
      at: event.at,
    };
  }
  const counts = {
    total: items.length,
    open: items.filter((item) => item.status === "open").length,
    held: items.filter((item) => item.status === "held").length,
    completed: items.filter((item) => item.status === "completed").length,
    cancelled: items.filter((item) => item.status === "cancelled").length,
  };
  return {
    revision: events.at(-1)?.eventId ?? "",
    status: counts.open > 0 ? "active" : counts.held > 0 ? "held" : "resolved",
    counts,
    items,
    finishOverrides,
  };
}

function emptyProjection(): TodoProjection {
  return {
    revision: "",
    status: "resolved",
    counts: { total: 0, open: 0, held: 0, completed: 0, cancelled: 0 },
    items: [],
    finishOverrides: [],
  };
}

export function ensureTodoLedger(dataDir: string, session: SessionRecord): TodoProjection {
  const path = ledgerPath(dataDir, session.id, session.project);
  if (!existsSync(path)) {
    if (session.todoLedgerVersion !== 1) {
      writeSession(dataDir, { ...session, todoLedgerVersion: 1 });
    }
    return emptyProjection();
  }
  if (session.todoLedgerVersion === 1) return replayTodo(dataDir, session.id);
  let projection = replayTodo(dataDir, session.id);
  if (session.status === "completed" || session.status === "killed") {
    const actor: TodoActor = { kind: "system", source: "legacy_migration" };
    for (const item of projection.items) {
      if (item.status !== "open" && item.status !== "held") continue;
      appendEvent(
        dataDir,
        {
          ...eventBase(session.id, actor),
          type: session.status === "completed" ? "item_completed" : "item_cancelled",
          itemId: item.id,
          reason:
            session.status === "completed"
              ? "Session completed before Spur ToDo tracking"
              : "Session killed before Spur ToDo tracking",
        },
        session.project,
      );
    }
    projection = replayTodo(dataDir, session.id);
  }
  writeSession(dataDir, { ...session, todoLedgerVersion: 1 });
  return projection;
}

export function todoLedgerBlock(projection: TodoProjection): "empty" | "unfinished" | null {
  if (projection.counts.total === 0) return "empty";
  const { openItemIds, heldItemIds } = unfinishedTodo(projection);
  if (openItemIds.length > 0 || heldItemIds.length > 0) return "unfinished";
  return null;
}

export function mutateTodo(
  dataDir: string,
  session: SessionRecord,
  request: TodoMutationRequest,
  actor: TodoActor,
): TodoProjection {
  if (
    (request.action === "add" && (!request.text.trim() || !request.reason.trim())) ||
    ((request.action === "complete" || request.action === "cancel" || request.action === "hold") &&
      !request.reason.trim()) ||
    (request.action === "hold" &&
      request.blocker === "human" &&
      !request.requiredHumanAction?.trim())
  ) {
    throw new InvalidTodoRequestError("ToDo text, reason, or human action is blank");
  }
  const projection = ensureTodoLedger(dataDir, session);
  if (session.status === "completed" || session.status === "killed") {
    throw new TodoTransitionConflictError(session.id, "", `Session is already ${session.status}`);
  }
  const base = eventBase(session.id, actor);
  let event: TodoEvent;
  if (request.action === "add") {
    event = {
      ...base,
      type: "item_added",
      itemId: randomUUID(),
      text: request.text.trim(),
      reason: request.reason.trim(),
    };
  } else {
    const item = projection.items.find((candidate) => candidate.id === request.itemId);
    if (!item)
      throw new TodoTransitionConflictError(session.id, request.itemId, "ToDo item not found");
    if (item.status === "completed" || item.status === "cancelled")
      throw new TodoTransitionConflictError(session.id, request.itemId, "ToDo item is terminal");
    if (request.action === "complete")
      event = {
        ...base,
        type: "item_completed",
        itemId: request.itemId,
        reason: request.reason.trim(),
      };
    else if (request.action === "cancel")
      event = {
        ...base,
        type: "item_cancelled",
        itemId: request.itemId,
        reason: request.reason.trim(),
      };
    else if (request.action === "resume") {
      if (item.status !== "held")
        throw new TodoTransitionConflictError(
          session.id,
          request.itemId,
          "Only held items can resume",
        );
      event = { ...base, type: "item_resumed", itemId: request.itemId };
    } else {
      if (item.status !== "open")
        throw new TodoTransitionConflictError(
          session.id,
          request.itemId,
          "Only open items can be held",
        );
      const blocker: TodoBlocker =
        request.blocker === "human"
          ? { kind: "human", requiredAction: request.requiredHumanAction?.trim() ?? "" }
          : { kind: "external" };
      event = {
        ...base,
        type: "item_held",
        itemId: request.itemId,
        reason: request.reason.trim(),
        blocker,
      };
    }
  }
  appendEvent(dataDir, event, session.project);
  return replayTodo(dataDir, session.id);
}

export function unfinishedTodo(projection: TodoProjection) {
  return {
    openItemIds: projection.items.filter((item) => item.status === "open").map((item) => item.id),
    heldItemIds: projection.items.filter((item) => item.status === "held").map((item) => item.id),
  };
}
