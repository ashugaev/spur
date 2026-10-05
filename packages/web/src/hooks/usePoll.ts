"use client";

import { useCallback, useEffect, useRef } from "react";

export type PollLoad = (signal: AbortSignal) => Promise<void>;

// Single-flight poll: runs `load` on mount, then again `intervalMs` after each
// run settles, so one resource never has two requests in flight. The returned
// refresh aborts the in-flight run and starts a fresh one now — a mutation's
// follow-up read never waits behind a slow poll. A new `load` identity or
// unmount aborts the in-flight run; `load` must drop its result when
// `signal.aborted`.
export function usePoll(load: PollLoad, intervalMs: number): () => Promise<void> {
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: number | undefined;
    const run = async () => {
      if (disposed) return;
      window.clearTimeout(timer);
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        await load(current.signal);
      } finally {
        if (controller === current) {
          controller = null;
          if (!disposed) timer = window.setTimeout(() => void run(), intervalMs);
        }
      }
    };
    refreshRef.current = run;
    void run();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [load, intervalMs]);

  return useCallback(() => refreshRef.current(), []);
}
