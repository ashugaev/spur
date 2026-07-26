"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useVersionSwitch } from "@/lib/version-switch-context";

// Heartbeat cadence while the backend looks healthy: cheap enough to catch a
// dropped daemon quickly without hammering it.
export const HEARTBEAT_INTERVAL_MS = 5_000;
// Tighter cadence while disconnected: we want to reload as soon as the
// daemon comes back, not wait out a full healthy-state heartbeat.
export const RECONNECT_INTERVAL_MS = 2_000;
// Require this many consecutive failures before flipping to "disconnected"
// so a single transient blip (e.g. a 5xx during a daemon GC pause) doesn't
// flash the blocking overlay.
export const FAILURE_THRESHOLD = 3;

export type BackendConnectionPhase = "connected" | "disconnected";

export interface BackendConnectionState {
  phase: BackendConnectionPhase;
  // Probe count while disconnected, for display only.
  attempts: number;
}

const CONNECTED_STATE: BackendConnectionState = { phase: "connected", attempts: 0 };

const BackendConnectionContext = createContext<BackendConnectionState>(CONNECTED_STATE);

export function useBackendConnection(): BackendConnectionState {
  return useContext(BackendConnectionContext);
}

async function probeBackend(): Promise<boolean> {
  try {
    const response = await fetch("/api/runtime/info");
    return response.ok;
  } catch {
    return false;
  }
}

export function BackendConnectionProvider({ children }: { children: ReactNode }) {
  // A version switch owns its own overlay + reload; the general liveness
  // gate must stay dormant while one is in flight so the two never race on
  // window.location.reload().
  const { phase: versionSwitchPhase } = useVersionSwitch();
  const dormant = versionSwitchPhase !== "idle";
  const [state, setState] = useState<BackendConnectionState>(CONNECTED_STATE);
  const consecutiveFailuresRef = useRef(0);
  const reloadedRef = useRef(false);

  useEffect(() => {
    if (dormant) {
      consecutiveFailuresRef.current = 0;
      reloadedRef.current = false;
      setState(CONNECTED_STATE);
      return;
    }

    let cancelled = false;
    const intervalMs =
      state.phase === "disconnected" ? RECONNECT_INTERVAL_MS : HEARTBEAT_INTERVAL_MS;

    const timer = window.setInterval(() => {
      void (async () => {
        const ok = await probeBackend();
        if (cancelled) return;

        if (state.phase === "disconnected") {
          if (ok) {
            if (!reloadedRef.current) {
              reloadedRef.current = true;
              window.location.reload();
            }
            return;
          }
          setState((current) => ({ phase: "disconnected", attempts: current.attempts + 1 }));
          return;
        }

        if (ok) {
          consecutiveFailuresRef.current = 0;
          return;
        }
        consecutiveFailuresRef.current += 1;
        if (consecutiveFailuresRef.current >= FAILURE_THRESHOLD) {
          setState({ phase: "disconnected", attempts: 1 });
        }
      })();
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [dormant, state.phase]);

  return (
    <BackendConnectionContext.Provider value={state}>{children}</BackendConnectionContext.Provider>
  );
}
