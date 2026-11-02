import { describe, expect, it } from "vitest";
import { createConcurrencyGate } from "../../src/concurrency-gate.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createConcurrencyGate", () => {
  it("never runs more than the limit at once and runs every task", async () => {
    const gate = createConcurrencyGate(2);
    let live = 0;
    let peak = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        gate.run(async () => {
          live += 1;
          peak = Math.max(peak, live);
          await tick();
          live -= 1;
          done += 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(done).toBe(6);
  });

  it("releases the slot when a task rejects", async () => {
    const gate = createConcurrencyGate(1);
    await expect(gate.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(gate.run(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("reset resumes queued waiters", async () => {
    const gate = createConcurrencyGate(1);
    let release: () => void = () => {};
    const held = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const waiter = gate.run(() => Promise.resolve("ran"));
    gate.reset();
    await expect(waiter).resolves.toBe("ran");
    release();
    await held;
  });
});
