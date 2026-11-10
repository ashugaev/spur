"use client";

import { useCallback, useEffect, useRef } from "react";
import { startPoller, type PollOutcome } from "@/lib/poller";

export type PollLoad = (signal: AbortSignal) => Promise<PollOutcome>;

// Single-flight poll on the shared poller: runs `load` on mount, then again
// after each run settles (backoff on "failed", paused while the tab is hidden).
// The returned refresh aborts the in-flight run and starts a fresh one now — a
// mutation's follow-up read never waits behind a slow poll. A new `load`
// identity or unmount aborts the in-flight run; `load` must drop its result
// when `signal.aborted` and return "ok" for an aborted run.
export function usePoll(load: PollLoad, intervalMs: number): () => Promise<void> {
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const poller = startPoller({ intervalMs, run: load });
    refreshRef.current = poller.refresh;
    return () => poller.stop();
  }, [load, intervalMs]);

  return useCallback(() => refreshRef.current(), []);
}
