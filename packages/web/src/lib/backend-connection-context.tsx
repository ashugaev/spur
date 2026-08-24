"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { readResponsePayload } from "@/lib/json-payload";
import { isRuntimeInfoResponse, useVersionSwitch } from "@/lib/version-switch-context";

// Heartbeat cadence while the backend looks healthy: cheap enough to catch a
// dropped daemon quickly without hammering it.
export const HEARTBEAT_INTERVAL_MS = 5_000;
// Tighter cadence while disconnected: we want to reload as soon as the
// daemon comes back, not wait out a full healthy-state heartbeat.
export const RECONNECT_INTERVAL_MS = 2_000;
const RECONNECT_MAX_INTERVAL_MS = 8_000;
const RETRY_BASE_INTERVAL_MS = 4_000;
// Require this many consecutive failures before flipping to "disconnected".
// Combined with retryIntervalMs this buys a 20-52s confirmation window:
// 20s when probes fail instantly, 52s when each probe burns its full timeout.
export const FAILURE_THRESHOLD = 4;
// Budget for one probe of a zero-I/O endpoint. Sized for a weak mobile link
// (high RTT, head-of-line blocking behind other in-flight requests) rather
// than for a LAN: a probe that answers in 6s still proves the backend is
// alive, and cutting it off at 3s was the main source of false-alarm
// overlays. It only stretches the confirmation window when probes actually
// hang — a genuinely dead daemon still fails instantly and trips the gate
// in 20s. Longer than the tick cadence in both phases, so the in-flight
// guard skips ticks and the effective cadence is the probe itself;
// instant failures and a recovered backend still get the full tick cadence.
export const PROBE_TIMEOUT_MS = 8_000;

// Precondition: consecutiveFailures is in 1..FAILURE_THRESHOLD-1.
export function retryIntervalMs(consecutiveFailures: number): number {
  return Math.min(
    RETRY_BASE_INTERVAL_MS * 2 ** (consecutiveFailures - 1),
    RECONNECT_MAX_INTERVAL_MS,
  );
}

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

// Resolves the daemon's reported version on a healthy, well-formed
// response, or null on any failure: network error, timeout/abort, non-ok
// status, or a response that isn't a runtime-info payload (e.g. a captive
// portal or misconfigured proxy returning 200 with an unrelated body).
async function probeBackend(): Promise<string | null> {
  try {
    const response = await fetch("/api/runtime/info", {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = await readResponsePayload(response);
    return isRuntimeInfoResponse(payload) ? payload.version : null;
  } catch {
    return null;
  }
}

export function BackendConnectionProvider({ children }: { children: ReactNode }) {
  // A version switch owns its own recovery overlay. The general liveness
  // gate stays dormant while one is in flight so the two never compete.
  const { phase: versionSwitchPhase } = useVersionSwitch();
  const dormant = versionSwitchPhase !== "idle";
  const [state, setState] = useState<BackendConnectionState>(CONNECTED_STATE);
  // Reactive (not a plain ref) so a failure immediately reschedules the
  // interval onto the fast cadence below — see intervalMs. Always updated
  // via the functional setter form so overlapping/stale reads can't drop a
  // real failure and indefinitely defer reaching FAILURE_THRESHOLD.
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  // Fires the very first probe of an activation immediately instead of
  // waiting a full heartbeat — otherwise opening the UI against an
  // already-dead daemon shows a broken dashboard for HEARTBEAT_INTERVAL_MS
  // before the overlay engages. Only that first probe is immediate;
  // probes triggered by a subsequent failure-count change still wait out
  // the (now-faster) interval, so a real outage is confirmed at a
  // deliberate cadence instead of a synchronous cascade.
  const needsInitialProbeRef = useRef(true);

  useEffect(() => {
    if (dormant) {
      setConsecutiveFailures(0);
      needsInitialProbeRef.current = true;
      setState(CONNECTED_STATE);
      return;
    }

    // A prior tick already confirmed FAILURE_THRESHOLD consecutive
    // failures. Flip to disconnected here and let the effect re-run for
    // the disconnected-phase cadence rather than probing again in this
    // render.
    if (state.phase === "connected" && consecutiveFailures >= FAILURE_THRESHOLD) {
      setState({ phase: "disconnected", attempts: 1 });
      return;
    }

    let cancelled = false;
    // In-flight guard: a probe that hasn't resolved yet (e.g. approaching
    // its own PROBE_TIMEOUT_MS abort) must not be piled on top of by the
    // next tick on slow HTTP/1.1.
    let probeInFlight = false;

    // Use the slow heartbeat only in the fully-healthy steady state (zero
    // failures). Once a failure is seen, apply capped doubling backoff via
    // retryIntervalMs for the rest of the confirmation window. While
    // disconnected the cadence stays flat at RECONNECT_INTERVAL_MS.
    const intervalMs =
      state.phase === "disconnected"
        ? RECONNECT_INTERVAL_MS
        : consecutiveFailures > 0
          ? retryIntervalMs(consecutiveFailures)
          : HEARTBEAT_INTERVAL_MS;

    const runProbe = () => {
      if (probeInFlight) return;
      probeInFlight = true;
      void (async () => {
        try {
          const version = await probeBackend();
          if (cancelled) return;

          if (state.phase === "disconnected") {
            if (version === null) {
              setState((current) => ({ phase: "disconnected", attempts: current.attempts + 1 }));
              return;
            }
            setState(CONNECTED_STATE);
            setConsecutiveFailures(0);
            // Keep the mounted app tree and its transports alive. Active
            // queries and terminal sockets recover through their existing
            // polling/reconnect paths without discarding local UI state.
            return;
          }

          if (version !== null) {
            setConsecutiveFailures(0);
            return;
          }
          setConsecutiveFailures((current) => current + 1);
        } finally {
          probeInFlight = false;
        }
      })();
    };

    if (needsInitialProbeRef.current) {
      needsInitialProbeRef.current = false;
      runProbe();
    }
    const timer = window.setInterval(runProbe, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [dormant, state.phase, consecutiveFailures]);

  return (
    <BackendConnectionContext.Provider value={state}>{children}</BackendConnectionContext.Provider>
  );
}
