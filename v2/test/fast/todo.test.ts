import { describe, expect, it } from "vitest";
import {
  formatTodoNudgeMessage,
  formatTodoSpawnMessage,
  parseTodoFile,
  shouldNudge,
  todoStateFromSnapshot,
  TODO_NUDGE_COOLDOWN_MS,
  type TodoSnapshot,
} from "../../src/todo.js";
import type { SessionTodoState } from "../../src/types.js";

describe("parseTodoFile", () => {
  it("parses pending, done, skipped, and failed items", () => {
    const content = `- [ ] #1 Research the codebase
- [x] #2 Implement the feature :: Added API wiring
- [s] #3 Optional cleanup :: Not needed after the merge
- [f] #4 Deploy to staging :: Missing credentials`;
    const items = parseTodoFile(content);
    expect(items).toEqual([
      { id: 1, text: "Research the codebase", status: "pending" },
      { id: 2, text: "Implement the feature", status: "done", summary: "Added API wiring" },
      { id: 3, text: "Optional cleanup", status: "skipped", summary: "Not needed after the merge" },
      { id: 4, text: "Deploy to staging", status: "failed", summary: "Missing credentials" },
    ]);
  });

  it("returns empty for content without todo items", () => {
    expect(parseTodoFile("just some text\n")).toEqual([]);
  });

  it("ignores malformed lines", () => {
    const content = `- [ ] #1 Valid item
not a todo
- [x] #2 Another valid`;
    expect(parseTodoFile(content)).toHaveLength(2);
  });
});

describe("todoStateFromSnapshot", () => {
  it("returns running with zeros for null snapshot", () => {
    expect(todoStateFromSnapshot(null)).toEqual({
      status: "running",
      total: 0,
      done: 0,
      skipped: 0,
      failed: 0,
      items: [],
    });
  });

  it("returns completed when all items are terminal without failures", () => {
    const snapshot: TodoSnapshot = {
      items: [
        { id: 1, text: "task", status: "done", summary: "shipped" },
        { id: 2, text: "cleanup", status: "skipped", summary: "not needed" },
      ],
      total: 2,
      done: 1,
      skipped: 1,
      failed: 0,
      pending: 0,
      allResolved: true,
      raw: "- [x] #1 task :: shipped\n- [s] #2 cleanup :: not needed",
    };
    expect(todoStateFromSnapshot(snapshot)).toEqual({
      status: "completed",
      total: 2,
      done: 1,
      skipped: 1,
      failed: 0,
      items: snapshot.items,
    });
  });

  it("returns failed when all items are terminal and at least one failed", () => {
    const snapshot: TodoSnapshot = {
      items: [
        { id: 1, text: "a", status: "done", summary: "ok" },
        { id: 2, text: "b", status: "failed", summary: "blocked" },
      ],
      total: 2,
      done: 1,
      skipped: 0,
      failed: 1,
      pending: 0,
      allResolved: true,
      raw: "",
    };
    expect(todoStateFromSnapshot(snapshot).status).toBe("failed");
  });

  it("returns running when items remain", () => {
    const snapshot: TodoSnapshot = {
      items: [
        { id: 1, text: "a", status: "done", summary: "ok" },
        { id: 2, text: "b", status: "pending" },
      ],
      total: 2,
      done: 1,
      skipped: 0,
      failed: 0,
      pending: 1,
      allResolved: false,
      raw: "",
    };
    expect(todoStateFromSnapshot(snapshot).status).toBe("running");
  });
});

describe("formatTodoSpawnMessage", () => {
  it("includes the prompt and instructions", () => {
    const msg = formatTodoSpawnMessage("ship the task");
    expect(msg).toContain("[Spur todo]");
    expect(msg).toContain("$SPUR_SESSION_TOOL_DIR/todo.md");
    expect(msg).toContain("outside the repo worktree");
    expect(msg).toContain("ship the task");
    expect(msg).toContain("- [ ] #1");
    expect(msg).toContain("- [s] #3");
    expect(msg).toContain('append " :: <summary or reason>"');
  });
});

describe("formatTodoNudgeMessage", () => {
  it("includes progress and next item", () => {
    const snapshot: TodoSnapshot = {
      items: [
        { id: 1, text: "done task", status: "done", summary: "ok" },
        { id: 2, text: "skipped task", status: "skipped", summary: "n/a" },
        { id: 3, text: "next task", status: "pending" },
      ],
      total: 3,
      done: 1,
      skipped: 1,
      failed: 0,
      pending: 1,
      allResolved: false,
      raw: "",
    };
    const msg = formatTodoNudgeMessage(snapshot);
    expect(msg).toContain("2/3 tasks resolved");
    expect(msg).toContain("1 done, 1 skipped");
    expect(msg).toContain("#3 next task");
    expect(msg).toContain("[x], [s], or [f]");
  });
});

describe("shouldNudge", () => {
  const snapshot: TodoSnapshot = {
    items: [{ id: 1, text: "task", status: "pending" }],
    total: 1,
    done: 0,
    skipped: 0,
    failed: 0,
    pending: 1,
    allResolved: false,
    raw: "",
  };

  it("returns true when todo is running with incomplete items", () => {
    const state: SessionTodoState = {
      status: "running",
      total: 1,
      done: 0,
      skipped: 0,
      failed: 0,
      items: [],
    };
    expect(shouldNudge(state, snapshot)).toBe(true);
  });

  it("returns false when all items are terminal", () => {
    const state: SessionTodoState = {
      status: "running",
      total: 1,
      done: 1,
      skipped: 0,
      failed: 0,
      items: [],
    };
    const doneSnapshot: TodoSnapshot = {
      ...snapshot,
      items: [{ id: 1, text: "task", status: "done", summary: "ok" }],
      done: 1,
      pending: 0,
      allResolved: true,
    };
    expect(shouldNudge(state, doneSnapshot)).toBe(false);
  });

  it("returns false when todo status is completed", () => {
    const state: SessionTodoState = {
      status: "completed",
      total: 1,
      done: 1,
      skipped: 0,
      failed: 0,
      items: [],
    };
    expect(shouldNudge(state, snapshot)).toBe(false);
  });

  it("returns false within cooldown period", () => {
    const state: SessionTodoState = {
      status: "running",
      total: 1,
      done: 0,
      skipped: 0,
      failed: 0,
      items: [],
      lastNudgeAt: new Date(Date.now() - TODO_NUDGE_COOLDOWN_MS / 2).toISOString(),
    };
    expect(shouldNudge(state, snapshot)).toBe(false);
  });

  it("returns true after cooldown expires", () => {
    const state: SessionTodoState = {
      status: "running",
      total: 1,
      done: 0,
      skipped: 0,
      failed: 0,
      items: [],
      lastNudgeAt: new Date(Date.now() - TODO_NUDGE_COOLDOWN_MS - 1000).toISOString(),
    };
    expect(shouldNudge(state, snapshot)).toBe(true);
  });
});
