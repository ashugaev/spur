import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromiseTimeoutError, withTimeout } from "../../src/promise-timeout.js";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the value when the promise settles first", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "boom")).resolves.toBe(42);
  });

  it("propagates the underlying rejection unchanged", async () => {
    const underlying = new Error("underlying");
    await expect(withTimeout(Promise.reject(underlying), 1000, "boom")).rejects.toBe(underlying);
  });

  it("rejects with PromiseTimeoutError when the promise hangs past the timeout", async () => {
    const hang = new Promise<void>(() => {});
    const raced = withTimeout(hang, 1000, "triggers.stop timeout");
    const assertion = expect(raced).rejects.toThrow(PromiseTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("carries the supplied message on the timeout error", async () => {
    const hang = new Promise<void>(() => {});
    const raced = withTimeout(hang, 1000, "triggers.stop timeout");
    const assertion = expect(raced).rejects.toThrow("triggers.stop timeout");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("clears the timer once the promise settles so it never lingers", async () => {
    await withTimeout(Promise.resolve("ok"), 10_000, "boom");
    expect(vi.getTimerCount()).toBe(0);
  });
});
