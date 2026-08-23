import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSession, writeSession } from "../../src/metadata.js";
import {
  ensureTodoLedger,
  mutateTodo,
  readStampedTodoProjection,
  replayTodo,
  TodoLedgerCorruptError,
  InvalidTodoRequestError,
  TodoTransitionConflictError,
} from "../../src/todo.js";
import type { SessionRecord, TodoActor } from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];
const actor: TodoActor = { kind: "agent", agent: "codex", sessionId: "s-1" };

function requiredSession(dataDir: string, sessionId: string): SessionRecord {
  const session = readSession(dataDir, sessionId);
  if (!session) throw new Error(`Missing test session ${sessionId}`);
  return session;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(status: SessionRecord["status"] = "running") {
  const dataDir = await createTempDir("spur-todo-");
  tempDirs.push(dataDir);
  const session: SessionRecord = {
    id: "s-1",
    project: "test",
    workspaceId: "s-1",
    agent: "codex",
    prompt: "Implement native ToDo",
    branch: "feature/todo",
    worktree: true,
    worktreePath: "/tmp/todo",
    tmuxSession: "todo",
    launchCommand: "codex",
    status,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  writeSession(dataDir, session);
  return { dataDir, session };
}

describe("Spur ToDo ledger", () => {
  it("initializes once and persists the marker", async () => {
    const { dataDir, session } = await fixture();
    const first = ensureTodoLedger(dataDir, session, "spawn");
    const marked = readSession(dataDir, session.id);
    if (!marked) throw new Error("Expected marked session");
    const second = ensureTodoLedger(dataDir, marked);

    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.text).toBe("Implement native ToDo");
    expect(second.counts.total).toBe(1);
    expect(marked?.todoLedgerVersion).toBe(1);
  });

  it("preserves history through every supported transition", async () => {
    const { dataDir, session } = await fixture();
    let projection = ensureTodoLedger(dataDir, session, "spawn");
    const initial = projection.items[0]?.id;
    if (!initial) throw new Error("Expected initial item");
    projection = mutateTodo(
      dataDir,
      requiredSession(dataDir, session.id),
      {
        action: "hold",
        itemId: initial,
        reason: "Need answer",
        blocker: "human",
        requiredHumanAction: "Choose API name",
      },
      actor,
    );
    expect(projection.status).toBe("held");
    mutateTodo(
      dataDir,
      requiredSession(dataDir, session.id),
      { action: "resume", itemId: initial },
      actor,
    );
    mutateTodo(
      dataDir,
      requiredSession(dataDir, session.id),
      { action: "complete", itemId: initial, reason: "Shipped" },
      actor,
    );
    projection = mutateTodo(
      dataDir,
      requiredSession(dataDir, session.id),
      { action: "add", text: "Document it", reason: "Public command" },
      actor,
    );
    const added = projection.items[1]?.id;
    if (!added) throw new Error("Expected added item");
    projection = mutateTodo(
      dataDir,
      requiredSession(dataDir, session.id),
      { action: "cancel", itemId: added, reason: "Covered elsewhere" },
      actor,
    );

    expect(projection.status).toBe("resolved");
    expect(projection.items[0]?.history).toHaveLength(4);
    expect(projection.items[1]?.history).toHaveLength(2);
    expect(() =>
      mutateTodo(
        dataDir,
        requiredSession(dataDir, session.id),
        { action: "resume", itemId: initial },
        actor,
      ),
    ).toThrow(TodoTransitionConflictError);
  });

  it("fails closed for a torn or malformed ledger", async () => {
    const { dataDir, session } = await fixture();
    ensureTodoLedger(dataDir, session, "spawn");
    const path = join(dataDir, "sessions", session.id, "todo.jsonl");
    writeFileSync(path, `${readFileSync(path, "utf8")}{`, "utf8");
    expect(() => replayTodo(dataDir, session.id)).toThrow(TodoLedgerCorruptError);
  });

  it("rejects blank mutation fields before append", async () => {
    const { dataDir, session } = await fixture();
    ensureTodoLedger(dataDir, session, "spawn");
    expect(() =>
      mutateTodo(
        dataDir,
        requiredSession(dataDir, session.id),
        { action: "add", text: " ", reason: "scope" },
        actor,
      ),
    ).toThrow(InvalidTodoRequestError);
  });

  it("AC5 ledger migration pins terminal legacy records with a terminal item", async () => {
    const { dataDir, session } = await fixture("completed");
    const projection = ensureTodoLedger(dataDir, session);
    expect(projection.status).toBe("resolved");
    expect(projection.items[0]?.status).toBe("completed");
  });

  it("repairs a terminal migration interrupted after the initial add", async () => {
    const { dataDir, session } = await fixture("completed");
    const ledgerDir = join(dataDir, "sessions", session.id);
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      join(ledgerDir, "todo.jsonl"),
      `${JSON.stringify({
        version: 1,
        eventId: "interrupted-add",
        sessionId: session.id,
        at: "2026-08-20T00:01:00.000Z",
        actor: { kind: "system", source: "legacy_migration" },
        type: "item_added",
        itemId: "legacy-item",
        text: session.prompt,
        reason: "Imported from the session objective when Spur ToDo was enabled",
      })}\n`,
      "utf8",
    );

    const projection = ensureTodoLedger(dataDir, session);

    expect(projection.items[0]?.status).toBe("completed");
    expect(readSession(dataDir, session.id)?.todoLedgerVersion).toBe(1);
    expect(readFileSync(join(ledgerDir, "todo.jsonl"), "utf8").split("\n")).toHaveLength(3);
  });

  it("replays unchanged history after the session shard is archived", async () => {
    const { dataDir, session } = await fixture();
    const before = ensureTodoLedger(dataDir, session, "spawn");
    const archivedParent = join(dataDir, "sessions-archive", session.project);
    mkdirSync(archivedParent, { recursive: true });
    renameSync(join(dataDir, "sessions", session.id), join(archivedParent, session.id));
    expect(replayTodo(dataDir, session.id)).toEqual(before);
  });

  it("AC7 exact-path ledger stamp follows archive movement", async () => {
    const { dataDir, session } = await fixture();
    ensureTodoLedger(dataDir, session, "spawn");
    const marked = requiredSession(dataDir, session.id);
    const live = readStampedTodoProjection(dataDir, marked);
    expect(live.stamp.path).toBe(join(dataDir, "sessions", session.id, "todo.jsonl"));
    expect(live.stamp.ino).toBeGreaterThan(0);

    const archivedParent = join(dataDir, "sessions-archive", session.project);
    mkdirSync(archivedParent, { recursive: true });
    renameSync(join(dataDir, "sessions", session.id), join(archivedParent, session.id));
    const archived = readStampedTodoProjection(dataDir, marked);
    expect(archived.stamp.path).toBe(join(archivedParent, session.id, "todo.jsonl"));
    expect(archived.projection).toEqual(live.projection);
  });

  it("AC7 exact-path ledger corruption keeps its stable stamp", async () => {
    const { dataDir, session } = await fixture();
    ensureTodoLedger(dataDir, session, "spawn");
    const marked = requiredSession(dataDir, session.id);
    const path = join(dataDir, "sessions", session.id, "todo.jsonl");
    writeFileSync(path, "not-json\n", "utf8");

    try {
      readStampedTodoProjection(dataDir, marked);
      throw new Error("Expected corrupt ledger");
    } catch (error) {
      expect(error).toBeInstanceOf(TodoLedgerCorruptError);
      expect((error as TodoLedgerCorruptError).stamp?.path).toBe(path);
    }
  });
});
