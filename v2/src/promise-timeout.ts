export class PromiseTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromiseTimeoutError";
  }
}

// Resolves/rejects with `promise` when it settles first, otherwise rejects with a
// PromiseTimeoutError after `timeoutMs`. The timer is always cleared and unref'd so a
// lost race never keeps the event loop alive.
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PromiseTimeoutError(message)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
