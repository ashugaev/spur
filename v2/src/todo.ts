import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionTodoItem, SessionTodoState, TodoItemStatus } from "./types.js";

const TODO_FILENAME = "todo.md";
const TODO_AGENT_PATH = "$SPUR_SESSION_TOOL_DIR/todo.md";

/** Minimum seconds between nudges for the same session. */
export const TODO_NUDGE_COOLDOWN_MS = 60_000;

export type TodoItem = SessionTodoItem;

export interface TodoSnapshot {
  items: TodoItem[];
  total: number;
  done: number;
  skipped: number;
  failed: number;
  pending: number;
  allResolved: boolean;
  raw: string;
}

const ITEM_RE = /^- \[([ xsf])\] #(\d+) (.+)$/i;
const SUMMARY_SEPARATOR = " :: ";

function parseTodoStatus(marker: string): TodoItemStatus {
  const normalized = marker.toLowerCase();
  if (normalized === "x") return "done";
  if (normalized === "s") return "skipped";
  if (normalized === "f") return "failed";
  return "pending";
}

function splitTodoTextAndSummary(value: string): Pick<TodoItem, "text" | "summary"> {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf(SUMMARY_SEPARATOR);
  if (separatorIndex === -1) {
    return { text: trimmed };
  }
  const text = trimmed.slice(0, separatorIndex).trim();
  const summary = trimmed.slice(separatorIndex + SUMMARY_SEPARATOR.length).trim();
  return summary ? { text, summary } : { text };
}

export function todoFilePath(sessionToolDir: string): string {
  return join(sessionToolDir, TODO_FILENAME);
}

export function parseTodoFile(content: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const line of content.split("\n")) {
    const m = ITEM_RE.exec(line.trim());
    if (m) {
      const status = parseTodoStatus(m[1] ?? "");
      const { text, summary } = splitTodoTextAndSummary(m[3] ?? "");
      items.push({
        id: Number(m[2]),
        text,
        status,
        ...(summary ? { summary } : {}),
      });
    }
  }
  return items;
}

export function readTodoSnapshot(sessionToolDir: string): TodoSnapshot | null {
  const path = todoFilePath(sessionToolDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const items = parseTodoFile(raw);
    if (items.length === 0) {
      return null;
    }
    const done = items.filter((item) => item.status === "done").length;
    const skipped = items.filter((item) => item.status === "skipped").length;
    const failed = items.filter((item) => item.status === "failed").length;
    const pending = items.filter((item) => item.status === "pending").length;
    return {
      items,
      total: items.length,
      done,
      skipped,
      failed,
      pending,
      allResolved: pending === 0,
      raw,
    };
  } catch {
    return null;
  }
}

export function todoStateFromSnapshot(snapshot: TodoSnapshot | null): SessionTodoState {
  if (!snapshot) {
    return { status: "running", total: 0, done: 0, skipped: 0, failed: 0, items: [] };
  }
  return {
    status: snapshot.pending > 0 ? "running" : snapshot.failed > 0 ? "failed" : "completed",
    total: snapshot.total,
    done: snapshot.done,
    skipped: snapshot.skipped,
    failed: snapshot.failed,
    items: snapshot.items,
  };
}

export function formatTodoSpawnMessage(prompt: string): string {
  return `[Spur todo]
Your first step is to analyze the task and create a todo list at ${TODO_AGENT_PATH}.
This file is session-owned and outside the repo worktree; do not copy it into the repository.
Format: one line per task, using markdown checkboxes with numeric IDs.
Example:
- [ ] #1 Research the codebase
- [x] #2 Implement the feature :: Added the session API and tests
- [s] #3 Optional cleanup :: Not needed after the merge
- [f] #4 Deploy to staging :: Missing required credentials

Rules:
- Use [ ] for pending, [x] for done, [s] for skipped, [f] for failed
- When marking [x], [s], or [f], append " :: <summary or reason>"
- Add new tasks: append to end, prepend to start, or insert after any #ID
- Keep IDs unique and sequential
- You cannot stop until every task is terminal: [x], [s], or [f]

Task:
${prompt}`;
}

export function formatTodoNudgeMessage(snapshot: TodoSnapshot): string {
  const next = snapshot.items.find((item) => item.status === "pending");
  const resolved = snapshot.total - snapshot.pending;
  const detail = [`${snapshot.done} done`];
  if (snapshot.skipped > 0) {
    detail.push(`${snapshot.skipped} skipped`);
  }
  if (snapshot.failed > 0) {
    detail.push(`${snapshot.failed} failed`);
  }
  const progress = `${resolved}/${snapshot.total} tasks resolved (${detail.join(", ")}).`;
  const nextHint = next ? ` Next: #${next.id} ${next.text}.` : "";
  return `[Spur todo] ${progress}${nextHint} You cannot stop until every task is marked [x], [s], or [f].`;
}

export function shouldNudge(
  todoState: SessionTodoState | undefined,
  snapshot: TodoSnapshot | null,
): boolean {
  if (!todoState || todoState.status !== "running") {
    return false;
  }
  if (!snapshot || snapshot.allResolved) {
    return false;
  }
  if (todoState.lastNudgeAt) {
    const elapsed = Date.now() - new Date(todoState.lastNudgeAt).getTime();
    if (elapsed < TODO_NUDGE_COOLDOWN_MS) {
      return false;
    }
  }
  return true;
}
