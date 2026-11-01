/**
 * Per-case ownership for the real-agent smoke suite. Vitest rejects a timed-out
 * test but never cancels its async body, so a case that outlives its timeout
 * keeps polling, and its in-process service keeps rewriting the process-global
 * tmux socket and env, inside the next case. Each case owns an abort signal,
 * its started service, and its body promise; `SmokeCaseRegistry.drain` stops
 * all three before the next case can start.
 */

export interface StoppableService {
  stop(): Promise<unknown>;
}

export interface SmokeCase {
  readonly signal: AbortSignal;
  /**
   * Register the case's in-process service so teardown can stop it. When the
   * case is already aborted (it timed out inside startServer), the service is
   * stopped here and the abort reason is thrown.
   */
  ownService(service: StoppableService): void;
}

interface OwnedCase extends SmokeCase {
  readonly controller: AbortController;
  service: StoppableService | undefined;
  /** Stop of a service registered after the case was aborted. */
  lateStop: Promise<unknown> | undefined;
  /** Settles once the body and any late stop have both settled. */
  done: Promise<void> | undefined;
  settled: boolean;
}

export interface SmokeCaseDrainOptions {
  /** Total bound on stopping a case's service and waiting for its body. */
  budgetMs: number;
}

export class SmokeCaseRegistry {
  private readonly cases: OwnedCase[] = [];
  private outlived: OwnedCase[] = [];

  /** Run `body` as an owned case; the returned promise is the body's own. */
  run<T>(body: (smokeCase: SmokeCase) => Promise<T>): Promise<T> {
    this.outlived = this.outlived.filter((owned) => !owned.settled);
    if (this.outlived.length > 0) {
      return Promise.reject(
        new Error(
          `${this.outlived.length} earlier smoke case(s) are still running after teardown; refusing to start a case that would share their process-global state`,
        ),
      );
    }
    const controller = new AbortController();
    const owned: OwnedCase = {
      controller,
      signal: controller.signal,
      service: undefined,
      lateStop: undefined,
      done: undefined,
      settled: false,
      ownService(service) {
        if (controller.signal.aborted) {
          owned.lateStop = service.stop();
          throw controller.signal.reason;
        }
        owned.service = service;
      },
    };
    this.cases.push(owned);
    const promise = body(owned);
    const ignore = (): void => {};
    owned.done = promise
      .then(ignore, ignore)
      // lateStop is assigned before the body observes the abort, so it is visible here.
      .then(() => owned.lateStop?.then(ignore, ignore))
      .then(() => {
        owned.settled = true;
      });
    return promise;
  }

  /**
   * Abort, stop services, wait for bodies, then run `cleanup`. Cleanup runs even
   * when a case outlives the budget; that case stays tracked, blocks `run`, and
   * is reported by throwing.
   */
  async drain(cleanup: () => Promise<void>, options: SmokeCaseDrainOptions): Promise<void> {
    const deadline = Date.now() + options.budgetMs;
    const remaining = (): number => Math.max(0, deadline - Date.now());
    const stuck: OwnedCase[] = [];
    try {
      for (const owned of this.cases.splice(0).reverse()) {
        owned.controller.abort(new Error("smoke case aborted by teardown"));
        if (owned.service) await settleWithin(owned.service.stop(), remaining());
        if (owned.done) await settleWithin(owned.done, remaining());
        if (!owned.settled) stuck.push(owned);
      }
    } finally {
      this.outlived.push(...stuck);
      await cleanup();
    }
    if (stuck.length > 0) {
      throw new Error(
        `Smoke case outlived teardown (${stuck.length} body still pending after ${options.budgetMs}ms); later cases may be contaminated`,
      );
    }
  }
}

/** Resolves once `promise` settles (either way) or `ms` elapses; a rejection is not rethrown. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([
      promise.then(
        () => undefined,
        () => undefined,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
