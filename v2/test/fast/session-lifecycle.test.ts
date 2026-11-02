import { describe, expect, it, vi } from "vitest";
import {
  parseLifecycleOperationId,
  SessionLifecycleRegister,
  createRestoreOperation,
} from "../../src/session-lifecycle.js";

describe("session lifecycle register", () => {
  it("revokes a cancelled restore wait and fences a replaced owner by identity", async () => {
    const register = new SessionLifecycleRegister();
    const owner = register.begin("restore", ["a"]);
    const controller = new AbortController();
    const operation = createRestoreOperation(controller.signal, () => register.owns(owner));
    const wait = operation.wait(new Promise<void>(() => undefined));
    controller.abort();
    await expect(wait).rejects.toThrow("cancelled");
    register.settle(
      owner,
      false,
      () => "failed",
      () => true,
    );
    const successor = register.begin("restore", ["a"]);
    expect(() => operation.assertActive()).toThrow("cancelled");
    register.settle(
      owner,
      true,
      () => "succeeded",
      () => true,
    );
    expect(register.owns(successor)).toBe(true);
    operation.dispose();
  });

  it("times out a restore wait after the finite restore budget", async () => {
    vi.useFakeTimers();
    const operation = createRestoreOperation();
    try {
      const wait = operation.wait(new Promise<void>(() => undefined));
      const rejection = expect(wait).rejects.toMatchObject({
        statusCode: 504,
        code: "restore_deadline",
      });
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      await rejection;
    } finally {
      operation.dispose();
      vi.useRealTimers();
    }
  });
  it("reserves an entire group atomically and retains the incumbent on overlap", () => {
    const register = new SessionLifecycleRegister();
    const owner = register.begin("complete", ["a", "b"], "one");
    expect(() => register.begin("restore", ["c", "b"], "two")).toThrow();
    expect(register.snapshot("c").operation).toBeNull();
    expect(register.snapshot("b")).toBe(owner);
    const independent = register.begin("restore", ["c"], "independent");
    expect(register.snapshot("c")).toBe(independent);
    expect(register.snapshot("b")).toBe(owner);
    expect(owner.operation?.outcomes).toEqual([]);
    expect(Object.isFrozen(owner.operation)).toBe(true);
  });

  it("settles partial outcomes once, rejects latest-ID reuse, and protects a newer owner", () => {
    const register = new SessionLifecycleRegister();
    const owner = register.begin("complete", ["a", "b"], "one");
    const settled = register.settle(
      owner,
      false,
      (id) => (id === "a" ? "succeeded" : "failed"),
      () => true,
    );
    expect(settled.revision).toBeGreaterThan(owner.revision);
    expect(settled.operation?.outcomes).toEqual([
      { sessionId: "a", phase: "succeeded" },
      { sessionId: "b", phase: "failed" },
    ]);
    expect(() => register.begin("restore", ["a"], "one")).toThrow();
    const newer = register.begin("reopen", ["a"], "two");
    register.settle(
      owner,
      true,
      () => "succeeded",
      () => true,
    );
    expect(register.snapshot("a")).toBe(newer);
  });

  it("keeps pending deleted targets until settlement and prunes only deleted receipts", () => {
    const register = new SessionLifecycleRegister();
    const owner = register.begin("restore", ["a", "b"]);
    register.prune(new Set(["a"]));
    expect(register.snapshot("b")).toBe(owner);
    register.settle(
      owner,
      false,
      () => "failed",
      (id) => id === "a",
    );
    expect(register.snapshot("b").operation).toBeNull();
    expect(register.snapshot("a").operation?.phase).toBe("failed");
    register.prune(new Set());
    expect(register.snapshot("a").revision).toBe(0);
    expect(new SessionLifecycleRegister().instanceId).not.toBe(register.instanceId);
  });

  it.each([null, 2, "", " ", " padded", "padded ", "a".repeat(129)])(
    "rejects malformed operation ID %s",
    (value) => {
      expect(() => parseLifecycleOperationId(value)).toThrow();
    },
  );

  it("accepts omitted and bounded operation IDs", () => {
    expect(parseLifecycleOperationId(undefined)).toBeUndefined();
    expect(parseLifecycleOperationId("a".repeat(128))).toHaveLength(128);
  });
});
