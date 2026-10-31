export interface ConcurrencyGate {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Zeroes the active count and resumes queued waiters. Test seam. */
  reset(): void;
}

export function createConcurrencyGate(limit: number): ConcurrencyGate {
  let active = 0;
  const queue: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
  }

  function release(): void {
    // Hand the slot straight to the next waiter; the count only drops when the
    // queue is empty, so a burst never opens a gap above the limit.
    const next = queue.shift();
    if (next) next();
    // Clamped for the reset seam only: it zeroes the counter under waiters
    // that release afterwards.
    else active = Math.max(0, active - 1);
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    reset(): void {
      for (const resume of queue.splice(0)) resume();
      active = 0;
    },
  };
}
