import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSession, writeSession } from "../../src/metadata.js";
import {
  ensureTodoLedger,
  mutateTodo,
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
  it("starts empty and writes no ledger file until the first real item", async () => {
    const { dataDir, session } = await fixture();
    const first = ensureTodoLedger(dataDir, session);
    const marked = readSession(dataDir, session.id);
    if (!marked) throw new Error("Expected marked session");
    const ledgerFile = join(dataDir, "sessions", session.id, "todo.jsonl");

    expect(first.counts.total).toBe(0);
    expect(first.items).toHaveLength(0);
    expect(marked?.todoLedgerVersion).toBe(1);
    expect(existsSync(ledgerFile)).toBe(false);

    const second = ensureTodoLedger(dataDir, marked);
    expect(second.counts.total).toBe(0);
    expect(existsSync(ledgerFile)).toBe(false);

    const added = mutateTodo(
      dataDir,
      requiredSession(dataDir, session.id),
      { action: "add", text: "Implement native ToDo", reason: "Session objective" },
      actor,
    );
    expect(added.counts.total).toBe(1);
    expect(existsSync(ledgerFile)).toBe(true);
  });

  it("preserves history through every supported transition", async () => {
    const { dataDir, session } = await fixture();
    let projection = mutateTodo(
      dataDir,
      session,
      { action: "add", text: "Implement native ToDo", reason: "Session objective" },
      actor,
    );
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
    mutateTodo(
      dataDir,
      session,
      { action: "add", text: "Implement native ToDo", reason: "Session objective" },
      actor,
    );
    const path = join(dataDir, "sessions", session.id, "todo.jsonl");
    writeFileSync(path, `${readFileSync(path, "utf8")}{`, "utf8");
    expect(() => replayTodo(dataDir, session.id)).toThrow(TodoLedgerCorruptError);
  });

  it("rejects a ledger file missing its trailing newline", async () => {
    const { dataDir, session } = await fixture();
    mutateTodo(
      dataDir,
      session,
      { action: "add", text: "Implement native ToDo", reason: "Session objective" },
      actor,
    );
    const path = join(dataDir, "sessions", session.id, "todo.jsonl");
    const content = readFileSync(path, "utf8");
    writeFileSync(path, content.slice(0, -1), "utf8");
    expect(() => replayTodo(dataDir, session.id)).toThrow(/empty or truncated/);
  });

  it("throws TodoLedgerCorruptError, not a raw fs error, when the ledger file is absent", async () => {
    const { dataDir, session } = await fixture();
    expect(() => replayTodo(dataDir, session.id)).toThrow(TodoLedgerCorruptError);
  });

  it("rejects blank mutation fields before append", async () => {
    const { dataDir, session } = await fixture();
    mutateTodo(
      dataDir,
      session,
      { action: "add", text: "Implement native ToDo", reason: "Session objective" },
      actor,
    );
    expect(() =>
      mutateTodo(
        dataDir,
        requiredSession(dataDir, session.id),
        { action: "add", text: " ", reason: "scope" },
        actor,
      ),
    ).toThrow(InvalidTodoRequestError);
  });

  it("replays a legacy human override on an empty ledger without throwing", async () => {
    const { dataDir, session } = await fixture();
    ensureTodoLedger(dataDir, session);
    const sessionDir = join(dataDir, "sessions", session.id);
    mkdirSync(sessionDir, { recursive: true });
    const path = join(sessionDir, "todo.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({
        version: 1,
        eventId: "override-1",
        sessionId: session.id,
        at: "2026-08-20T00:01:00.000Z",
        actor: { kind: "human", origin: "cli" },
        type: "finish_override_recorded",
        reason: "Nothing to track",
        unfinishedItemIds: [],
      })}\n`,
      "utf8",
    );
    const after = replayTodo(dataDir, session.id);
    expect(after.counts.total).toBe(0);
    expect(after.finishOverrides).toHaveLength(1);
  });

  it("terminal sessions with no ledger file start empty rather than seeded", async () => {
    const { dataDir, session } = await fixture("completed");
    const projection = ensureTodoLedger(dataDir, session);
    expect(projection.status).toBe("resolved");
    expect(projection.counts.total).toBe(0);
    expect(readSession(dataDir, session.id)?.todoLedgerVersion).toBe(1);
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
    const before = mutateTodo(
      dataDir,
      session,
      { action: "add", text: "Implement native ToDo", reason: "Session objective" },
      actor,
    );
    const archivedParent = join(dataDir, "sessions-archive", session.project);
    mkdirSync(archivedParent, { recursive: true });
    renameSync(join(dataDir, "sessions", session.id), join(archivedParent, session.id));
    expect(replayTodo(dataDir, session.id)).toEqual(before);
  });
});
