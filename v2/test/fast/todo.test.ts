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
  it("parses a mixed todo list", () => {
    const content = `- [ ] #1 Research the codebase
- [x] #2 Implement the feature
- [ ] #3 Write tests`;
    const items = parseTodoFile(content);
    expect(items).toEqual([
      { id: 1, text: "Research the codebase", done: false },
      { id: 2, text: "Implement the feature", done: true },
      { id: 3, text: "Write tests", done: false },
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
    });
  });

  it("returns completed when all done", () => {
    const snapshot: TodoSnapshot = {
      items: [{ id: 1, text: "task", done: true }],
      total: 1,
      done: 1,
      allDone: true,
      raw: "- [x] #1 task",
    };
    expect(todoStateFromSnapshot(snapshot)).toEqual({
      status: "completed",
      total: 1,
      done: 1,
    });
  });

  it("returns running when items remain", () => {
    const snapshot: TodoSnapshot = {
      items: [
        { id: 1, text: "a", done: true },
        { id: 2, text: "b", done: false },
      ],
      total: 2,
      done: 1,
      allDone: false,
      raw: "",
    };
    expect(todoStateFromSnapshot(snapshot).status).toBe("running");
  });
});

describe("formatTodoSpawnMessage", () => {
  it("includes the prompt and instructions", () => {
    const msg = formatTodoSpawnMessage("ship the task");
    expect(msg).toContain("[Spur todo]");
    expect(msg).toContain(".spur/todo.md");
    expect(msg).toContain("ship the task");
    expect(msg).toContain("- [ ] #1");
  });
});

describe("formatTodoNudgeMessage", () => {
  it("includes progress and next item", () => {
    const snapshot: TodoSnapshot = {
      items: [
        { id: 1, text: "done task", done: true },
        { id: 2, text: "next task", done: false },
      ],
      total: 2,
      done: 1,
      allDone: false,
      raw: "",
    };
    const msg = formatTodoNudgeMessage(snapshot);
    expect(msg).toContain("1/2 tasks complete");
    expect(msg).toContain("#2 next task");
    expect(msg).toContain("cannot stop");
  });
});

describe("shouldNudge", () => {
  const snapshot: TodoSnapshot = {
    items: [{ id: 1, text: "task", done: false }],
    total: 1,
    done: 0,
    allDone: false,
    raw: "",
  };

  it("returns true when todo is running with incomplete items", () => {
    const state: SessionTodoState = { status: "running", total: 1, done: 0 };
    expect(shouldNudge(state, snapshot)).toBe(true);
  });

  it("returns false when all items are done", () => {
    const state: SessionTodoState = { status: "running", total: 1, done: 1 };
    const doneSnapshot: TodoSnapshot = { ...snapshot, allDone: true, done: 1 };
    expect(shouldNudge(state, doneSnapshot)).toBe(false);
  });

  it("returns false when todo status is completed", () => {
    const state: SessionTodoState = { status: "completed", total: 1, done: 1 };
    expect(shouldNudge(state, snapshot)).toBe(false);
  });

  it("returns false within cooldown period", () => {
    const state: SessionTodoState = {
      status: "running",
      total: 1,
      done: 0,
      lastNudgeAt: new Date(Date.now() - TODO_NUDGE_COOLDOWN_MS / 2).toISOString(),
    };
    expect(shouldNudge(state, snapshot)).toBe(false);
  });

  it("returns true after cooldown expires", () => {
    const state: SessionTodoState = {
      status: "running",
      total: 1,
      done: 0,
      lastNudgeAt: new Date(Date.now() - TODO_NUDGE_COOLDOWN_MS - 1000).toISOString(),
    };
    expect(shouldNudge(state, snapshot)).toBe(true);
  });
});
