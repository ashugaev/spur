"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { readResponsePayload } from "@/lib/json-payload";
import { isRuntimeInfoResponse, useVersionSwitch } from "@/lib/version-switch-context";

// Heartbeat cadence while the backend looks healthy: cheap enough to catch a
// dropped daemon quickly without hammering it.
export const HEARTBEAT_INTERVAL_MS = 5_000;
// Tighter cadence while disconnected: we want to reload as soon as the
// daemon comes back, not wait out a full healthy-state heartbeat.
export const RECONNECT_INTERVAL_MS = 4_000;
const RECONNECT_MAX_INTERVAL_MS = 8_000;
// Require this many consecutive failures before flipping to "disconnected".
// Combined with retryIntervalMs, this buys a ≥32s tolerance window so
// daemon event-loop stalls shorter than that leave the overlay hidden.
export const FAILURE_THRESHOLD = 4;
// Must stay comfortably below RECONNECT_INTERVAL_MS: a black-holed
// connection (sleep/wake, VPN drop that neither errors nor resolves) would
// otherwise never resolve and never count as a failure, leaving the gate
// stuck showing a healthy app against a dead backend.
export const PROBE_TIMEOUT_MS = 3_000;

export function retryIntervalMs(consecutiveFailures: number): number {
  return Math.min(
    RECONNECT_INTERVAL_MS * 2 ** (consecutiveFailures - 1),
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
  // A version switch owns its own overlay + reload; the general liveness
  // gate must stay dormant while one is in flight so the two never race on
  // window.location.reload().
  const { phase: versionSwitchPhase } = useVersionSwitch();
  const dormant = versionSwitchPhase !== "idle";
  const [state, setState] = useState<BackendConnectionState>(CONNECTED_STATE);
  // Reactive (not a plain ref) so a failure immediately reschedules the
  // interval onto the fast cadence below — see intervalMs. Always updated
  // via the functional setter form so overlapping/stale reads can't drop a
  // real failure and indefinitely defer reaching FAILURE_THRESHOLD.
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const reloadedRef = useRef(false);
  // Last daemon version observed on a healthy probe, used to decide whether
  // a recovery is a real restart/update (different version, needs a reload
  // for fresh assets) or just a transient blip on the same daemon.
  const lastVersionRef = useRef<string | null>(null);
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
      reloadedRef.current = false;
      lastVersionRef.current = null;
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
            // Flip to connected first: if reload() below turns out to be a
            // no-op (embedded webview, cancelled beforeunload) the overlay
            // must not stay stuck against a now-healthy backend.
            const baseline = lastVersionRef.current;
            const versionChanged = baseline === null || baseline !== version;
            lastVersionRef.current = version;
            setState(CONNECTED_STATE);
            setConsecutiveFailures(0);
            if (versionChanged) {
              // A real daemon restart/update needs fresh assets.
              if (!reloadedRef.current) {
                reloadedRef.current = true;
                window.location.reload();
              }
            }
            // Same version recovering from a transient blip: stay
            // connected without reloading, so React Query can refetch in
            // place and preserve unsaved composer/spawn input.
            return;
          }

          if (version !== null) {
            lastVersionRef.current = version;
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
