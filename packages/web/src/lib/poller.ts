export type PollOutcome = "ok" | "failed";

const MAX_BACKOFF_FACTOR = 8;

// Delay between a settled run and the next start: doubles per consecutive
// failure, never shorter than the last run took, capped at 8x the base.
export function nextPollDelayMs(intervalMs: number, failures: number, durationMs: number): number {
  return Math.min(
    intervalMs * MAX_BACKOFF_FACTOR,
    Math.max(intervalMs * 2 ** failures, durationMs),
  );
}

export interface Poller {
  // Aborts the in-flight run and runs now, visible or not. Resolves when that run settles.
  refresh(): Promise<void>;
  // Never aborts. In flight: one follow-up run starts after settle. Hidden: runs on visible.
  request(): void;
  stop(): void;
}

export interface PollerOptions {
  intervalMs: number;
  run: (signal: AbortSignal) => Promise<PollOutcome>;
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

// Single-flight poll scheduler: the next run starts only after the previous one
// settles, spaced by nextPollDelayMs. A hidden document starts no run; the
// first visible moment runs once if the last settle is older than the delay.
export function startPoller({ intervalMs, run }: PollerOptions): Poller {
  let stopped = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let lastDurationMs = 0;
  let lastSettledAt: number | null = null;
  let followUp = false;

  const delayMs = () => nextPollDelayMs(intervalMs, failures, lastDurationMs);

  const arm = () => {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || controller || isHidden() || lastSettledAt === null) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (!stopped && !controller && !isHidden()) void execute();
      },
      Math.max(0, lastSettledAt + delayMs() - Date.now()),
    );
  };

  const execute = async (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const startedAt = Date.now();
    let outcome: PollOutcome;
    try {
      outcome = await run(current.signal);
    } catch {
      outcome = "failed";
    }
    if (controller !== current) return;
    controller = null;
    failures = outcome === "ok" ? 0 : failures + 1;
    lastDurationMs = Date.now() - startedAt;
    lastSettledAt = Date.now();
    if (stopped) return;
    if (followUp && !isHidden()) {
      followUp = false;
      void execute();
      return;
    }
    arm();
  };

  const onVisibilityChange = () => {
    if (stopped) return;
    if (isHidden()) {
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    if (controller) return;
    if (followUp || lastSettledAt === null || Date.now() - lastSettledAt >= delayMs()) {
      followUp = false;
      void execute();
      return;
    }
    arm();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  if (!isHidden()) void execute();

  return {
    refresh: () => (stopped ? Promise.resolve() : execute()),
    request: () => {
      if (stopped) return;
      if (controller || isHidden()) {
        followUp = true;
        return;
      }
      void execute();
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      controller = null;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    },
  };
}
