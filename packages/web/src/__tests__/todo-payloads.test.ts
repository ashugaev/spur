import { describe, expect, it } from "vitest";
import { isTodoLedgerEmptyPayload, isTodoOpenWorkPayload } from "@/lib/types";

describe("isTodoOpenWorkPayload", () => {
  it("accepts the real daemon shape", () => {
    expect(
      isTodoOpenWorkPayload({
        code: "todo_open_work",
        sessions: [{ sessionId: "api-1", openItemIds: ["item-1"], heldItemIds: [] }],
        error: "Spur ToDo has open or held items.",
      }),
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isTodoOpenWorkPayload(null)).toBe(false);
  });

  it("rejects an array", () => {
    expect(isTodoOpenWorkPayload([])).toBe(false);
  });

  it("rejects a wrong code", () => {
    expect(
      isTodoOpenWorkPayload({
        code: "todo_ledger_empty",
        sessions: [{ sessionId: "api-1", openItemIds: [], heldItemIds: [] }],
      }),
    ).toBe(false);
  });

  it("rejects a non-array sessions", () => {
    expect(isTodoOpenWorkPayload({ code: "todo_open_work", sessions: "nope" })).toBe(false);
  });

  it("rejects an entry with a non-string sessionId", () => {
    expect(
      isTodoOpenWorkPayload({
        code: "todo_open_work",
        sessions: [{ sessionId: 1, openItemIds: [], heldItemIds: [] }],
      }),
    ).toBe(false);
  });

  it("rejects an entry with a non-string[] openItemIds", () => {
    expect(
      isTodoOpenWorkPayload({
        code: "todo_open_work",
        sessions: [{ sessionId: "api-1", openItemIds: [1, 2], heldItemIds: [] }],
      }),
    ).toBe(false);
  });
});

describe("isTodoLedgerEmptyPayload", () => {
  it("accepts the real daemon shape with a single sessionId", () => {
    expect(
      isTodoLedgerEmptyPayload({
        code: "todo_ledger_empty",
        sessionId: "api-1",
        error: "Spur ToDo ledger is empty.",
      }),
    ).toBe(true);
  });

  it("accepts the real daemon shape with sessionIds", () => {
    expect(
      isTodoLedgerEmptyPayload({
        code: "todo_ledger_empty",
        sessionIds: ["api-1", "api-2"],
        error: "Spur ToDo ledger is empty.",
      }),
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isTodoLedgerEmptyPayload(null)).toBe(false);
  });

  it("rejects an array", () => {
    expect(isTodoLedgerEmptyPayload([])).toBe(false);
  });

  it("rejects a wrong code", () => {
    expect(isTodoLedgerEmptyPayload({ code: "todo_open_work" })).toBe(false);
  });
});
