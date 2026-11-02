import { describe, expect, it } from "vitest";

import { pollUntil, sleep } from "../helpers/common.js";
import { SmokeCaseRegistry } from "../helpers/smoke-case.js";

const BOUNDS = { budgetMs: 1_000 };

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

  it("rejects when aborted during an fn call whose result passes accept", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted during fn");
    await expect(
      pollUntil(
        async () => {
          controller.abort(reason);
          return "ok";
        },
        { timeoutMs: 1_000, signal: controller.signal },
      ),
    ).rejects.toBe(reason);
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
        { budgetMs: 50 },
      ),
    ).rejects.toThrow(/outlived teardown.*contaminated/);
    expect(events).toEqual(["cleanup"]);
  });

  it("stops a service registered after drain started, before cleanup", async () => {
    const events: string[] = [];
    const registry = new SmokeCaseRegistry();
    // Body mimics a case that timed out inside startServer.
    const body = registry.run(async (smokeCase) => {
      await sleep(30);
      smokeCase.ownService({
        stop: async () => {
          await sleep(20);
          events.push("late-service:stopped");
        },
      });
      events.push("not-reached");
    });
    body.catch(() => events.push("body:rejected"));

    await registry.drain(async () => {
      events.push("cleanup");
    }, BOUNDS);

    expect(events).toEqual(["body:rejected", "late-service:stopped", "cleanup"]);
  });

  it("does not report a slow service stop when the body settles in budget", async () => {
    const registry = new SmokeCaseRegistry();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    void registry
      .run(async (smokeCase) => {
        smokeCase.ownService({ stop: () => gate });
        await gate;
      })
      .catch(() => {});
    setTimeout(release, 60);
    await expect(registry.drain(async () => {}, { budgetMs: 500 })).resolves.toBeUndefined();
  });

  it("refuses to start a case while an outlived body is still pending", async () => {
    const registry = new SmokeCaseRegistry();
    let finish: () => void = () => {};
    void registry.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(registry.drain(async () => {}, { budgetMs: 30 })).rejects.toThrow(/outlived/);
    await expect(registry.run(async () => {})).rejects.toThrow(/still running after teardown/);
    finish();
    await sleep(5);
    await expect(registry.run(async () => "next")).resolves.toBe("next");
  });

  it("keeps a case unsettled until its late service stop finishes", async () => {
    const registry = new SmokeCaseRegistry();
    let finishStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    void registry
      .run(async (smokeCase) => {
        await sleep(10);
        smokeCase.ownService({ stop: () => stopGate });
      })
      .catch(() => {});
    // Body rejects immediately; the late stop is still running when the budget ends.
    await expect(registry.drain(async () => {}, { budgetMs: 60 })).rejects.toThrow(/outlived/);
    await expect(registry.run(async () => {})).rejects.toThrow(/still running after teardown/);
    finishStop();
    await sleep(5);
    await expect(registry.run(async () => "next")).resolves.toBe("next");
  });
});
