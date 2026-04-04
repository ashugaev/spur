import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionTodoState } from "./types.js";

const TODO_FILENAME = "todo.md";
const TODO_DIR = ".spur";

/** Minimum seconds between nudges for the same session. */
export const TODO_NUDGE_COOLDOWN_MS = 60_000;

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

export interface TodoSnapshot {
  items: TodoItem[];
  total: number;
  done: number;
  allDone: boolean;
  raw: string;
}

const ITEM_RE = /^- \[([ x])\] #(\d+) (.+)$/;

export function todoFilePath(worktreePath: string): string {
  return join(worktreePath, TODO_DIR, TODO_FILENAME);
}

export function parseTodoFile(content: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const line of content.split("\n")) {
    const m = ITEM_RE.exec(line.trim());
    if (m) {
      items.push({
        id: Number(m[2]),
        text: m[3]!,
        done: m[1] === "x",
      });
    }
  }
  return items;
}

export function readTodoSnapshot(worktreePath: string): TodoSnapshot | null {
  const path = todoFilePath(worktreePath);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const items = parseTodoFile(raw);
    if (items.length === 0) {
      return null;
    }
    const done = items.filter((i) => i.done).length;
    return {
      items,
      total: items.length,
      done,
      allDone: done === items.length,
      raw,
    };
  } catch {
    return null;
  }
}

export function todoStateFromSnapshot(snapshot: TodoSnapshot | null): SessionTodoState {
  if (!snapshot) {
    return { status: "running", total: 0, done: 0 };
  }
  return {
    status: snapshot.allDone ? "completed" : "running",
    total: snapshot.total,
    done: snapshot.done,
  };
}

export function formatTodoSpawnMessage(prompt: string): string {
  return `[Spur todo]
Your first step is to analyze the task and create a todo list at .spur/todo.md.
Format: one line per task, using markdown checkboxes with numeric IDs.
Example:
- [ ] #1 Research the codebase
- [ ] #2 Implement the feature
- [ ] #3 Write tests

Rules:
- Mark each task [x] when complete
- Add new tasks: append to end, prepend to start, or insert after any #ID
- Keep IDs unique and sequential
- You cannot stop until ALL tasks are [x]

Task:
${prompt}`;
}

export function formatTodoNudgeMessage(snapshot: TodoSnapshot): string {
  const next = snapshot.items.find((i) => !i.done);
  const progress = `${snapshot.done}/${snapshot.total} tasks complete.`;
  const nextHint = next ? ` Next: #${next.id} ${next.text}.` : "";
  return `[Spur todo] ${progress}${nextHint} You cannot stop until all tasks are done.`;
}

export function shouldNudge(
  todoState: SessionTodoState | undefined,
  snapshot: TodoSnapshot | null,
): boolean {
  if (!todoState || todoState.status !== "running") {
    return false;
  }
  if (!snapshot || snapshot.allDone) {
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
