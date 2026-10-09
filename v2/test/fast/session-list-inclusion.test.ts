import { describe, expect, it } from "vitest";
import { isListedSessionView } from "../../src/session-service.js";
import type { LifecycleOperation, SessionStatus } from "../../src/types.js";

function operation(
  action: LifecycleOperation["action"],
  phase: LifecycleOperation["phase"],
): LifecycleOperation {
  return { operationId: "op-1", action, phase, targetIds: ["s"], outcomes: [] };
}

describe("isListedSessionView", () => {
  it.each<
    [string, SessionStatus, boolean | undefined, LifecycleOperation | null, boolean, boolean]
  >([
    ["running", "running", undefined, null, false, true],
    ["completed", "completed", undefined, null, false, false],
    ["completed with includeCompleted", "completed", undefined, null, true, true],
    ["completed with retainInList", "completed", true, null, false, true],
    ["killed", "killed", undefined, null, false, false],
    ["killed with retainInList", "killed", true, null, false, true],
    [
      "killed with pending restore",
      "killed",
      undefined,
      operation("restore", "pending"),
      false,
      true,
    ],
    [
      "killed with pending complete",
      "killed",
      undefined,
      operation("complete", "pending"),
      false,
      false,
    ],
    [
      "killed with settled restore",
      "killed",
      undefined,
      operation("restore", "succeeded"),
      false,
      false,
    ],
    [
      "running with pending complete",
      "running",
      undefined,
      operation("complete", "pending"),
      false,
      true,
    ],
  ])("%s", (_name, status, retainInList, op, includeCompleted, expected) => {
    expect(
      isListedSessionView(
        { status, ...(retainInList ? { retainInList } : {}) },
        op,
        includeCompleted,
      ),
    ).toBe(expected);
  });
});
