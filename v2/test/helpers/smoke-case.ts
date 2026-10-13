/**
 * Per-case ownership for the real-agent smoke suite. Vitest rejects a timed-out
 * test but never cancels its async body, so a case that outlives its timeout
 * keeps polling, and its in-process service keeps rewriting the process-global
 * tmux socket and env, inside the next case. Each case owns an abort signal,
 * its started service, and its body promise; `drainSmokeCases` stops all three
 * before the next case can start.
 */

export interface StoppableService {
  stop(): Promise<unknown>;
}

export interface SmokeCase {
  readonly signal: AbortSignal;
  /** Register the case's in-process service so teardown can stop it. */
  ownService(service: StoppableService): void;
}

interface OwnedCase extends SmokeCase {
  readonly controller: AbortController;
  service: StoppableService | undefined;
  body: Promise<unknown> | undefined;
}

export interface SmokeCaseDrainOptions {
  /** Bound on awaiting service.stop(). */
  stopTimeoutMs: number;
  /** Bound on awaiting a still-running body after stop. */
  settleTimeoutMs: number;
}

export class SmokeCaseRegistry {
  private readonly cases: OwnedCase[] = [];

  /** Run `body` as an owned case; the returned promise is the body's own. */
  run<T>(body: (smokeCase: SmokeCase) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const owned: OwnedCase = {
      controller,
      signal: controller.signal,
      service: undefined,
      body: undefined,
      ownService(service) {
        owned.service = service;
      },
    };
    this.cases.push(owned);
    const promise = body(owned);
    owned.body = promise;
    return promise;
  }

  /**
   * Abort, stop services, wait for bodies, then run `cleanup`. Cleanup runs even
   * when a case outlives the bounds; that case is then reported by throwing.
   */
  async drain(cleanup: () => Promise<void>, options: SmokeCaseDrainOptions): Promise<void> {
    const outlived: string[] = [];
    try {
      for (const owned of this.cases.splice(0).reverse()) {
        owned.controller.abort(new Error("smoke case aborted by teardown"));
        if (owned.service) {
          const stopped = await settleWithin(owned.service.stop(), options.stopTimeoutMs);
          if (!stopped) outlived.push("service.stop()");
        }
        if (owned.body && !(await settleWithin(owned.body, options.settleTimeoutMs))) {
          outlived.push("body");
        }
      }
    } finally {
      await cleanup();
    }
    if (outlived.length > 0) {
      throw new Error(
        `Smoke case outlived teardown (${outlived.join(", ")} still pending); later cases may be contaminated`,
      );
    }
  }
}

/** True when `promise` settled (either way) inside `ms`; a rejection is not rethrown. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
