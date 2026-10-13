import { describe, expect, it } from "vitest";

import { pollUntil, sleep } from "../helpers/common.js";
import { SmokeCaseRegistry } from "../helpers/smoke-case.js";

const BOUNDS = { stopTimeoutMs: 1_000, settleTimeoutMs: 1_000 };

describe("pollUntil abort signal", () => {
  it("rejects with the reason before calling fn when already aborted", async () => {
    const reason = new Error("stop now");
    let calls = 0;
    await expect(
      pollUntil(async () => ++calls, {
        timeoutMs: 1_000,
        accept: () => false,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(calls).toBe(0);
  });

  it("wakes from the sleep on abort without waiting for the interval", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted mid-sleep");
    let calls = 0;
    const polling = pollUntil(async () => ++calls, {
      timeoutMs: 60_000,
      intervalMs: 30_000,
      accept: () => false,
      signal: controller.signal,
    });
    await sleep(20);
    const started = Date.now();
    controller.abort(reason);
    await expect(polling).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toBe(1);
  });

  it("is unchanged without a signal", async () => {
    let calls = 0;
    await expect(
      pollUntil(async () => ++calls, { timeoutMs: 1_000, intervalMs: 5, accept: (n) => n >= 3 }),
    ).resolves.toBe(3);
    await expect(
      pollUntil(async () => 0, { timeoutMs: 20, intervalMs: 5, accept: () => false }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("SmokeCaseRegistry.drain", () => {
  it("aborts a pending body, stops the service, then cleans up only after the body settled", async () => {
    const events: string[] = [];
    const registry = new SmokeCaseRegistry();
    // Body mimics a timed-out case: polling forever, then a late "socket write" in its finally.
    void registry
      .run(async (smokeCase) => {
        smokeCase.ownService({
          stop: async () => {
            events.push("stop:start");
            await sleep(20);
            events.push("stop:end");
          },
        });
        try {
          await pollUntil(async () => false, {
            timeoutMs: 60_000,
            intervalMs: 10,
            signal: smokeCase.signal,
          });
        } finally {
          await sleep(30);
          events.push("body:late-socket-write");
        }
      })
      .catch(() => events.push("body:rejected"));

    await registry.drain(async () => {
      events.push("cleanup");
    }, BOUNDS);
    events.push("next-case-arm");

    expect(events).toEqual([
      "stop:start",
      "stop:end",
      "body:late-socket-write",
      "body:rejected",
      "cleanup",
      "next-case-arm",
    ]);
  });

  it("is a no-op for settled cases and still runs cleanup", async () => {
    const registry = new SmokeCaseRegistry();
    let stops = 0;
    await registry.run(async (smokeCase) => {
      smokeCase.ownService({
        stop: async () => {
          stops += 1;
        },
      });
    });
    let cleaned = false;
    await registry.drain(async () => {
      cleaned = true;
    }, BOUNDS);
    expect(stops).toBe(1);
    expect(cleaned).toBe(true);
  });

  it("runs cleanup then throws when a body outlives the bound", async () => {
    const registry = new SmokeCaseRegistry();
    const events: string[] = [];
    void registry.run(() => new Promise<void>(() => {}));
    await expect(
      registry.drain(
        async () => {
          events.push("cleanup");
        },
        { stopTimeoutMs: 50, settleTimeoutMs: 50 },
      ),
    ).rejects.toThrow(/outlived teardown.*contaminated/);
    expect(events).toEqual(["cleanup"]);
  });
});
