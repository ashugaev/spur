"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { readResponsePayload } from "@/lib/json-payload";

// Poll cadence for confirming a version switch: the daemon restart takes a few
// seconds; npm install can take tens of seconds on a cold cache.
export const SWITCH_POLL_INTERVAL_MS = 3_000;
export const SWITCH_POLL_ATTEMPTS = 30;

export interface RuntimeInfoResponse {
  version: string;
}

export function isRuntimeInfoResponse(value: unknown): value is RuntimeInfoResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof (value as { version: unknown }).version === "string"
  );
}

export type VersionSwitchPhase = "idle" | "switching" | "done" | "failed";

// Failure copy shown by the blocking overlay (VersionSwitchOverlay), the only
// place users see version-switch status.
export function versionSwitchFailedMessage(target: string): string {
  return `Switch to ${target} not confirmed — check ~/.spur/logs/install-and-restart.log.`;
}

export interface VersionSwitchState {
  phase: VersionSwitchPhase;
  target: string | null;
}

interface VersionSwitchContextValue extends VersionSwitchState {
  startSwitch: (version: string) => void;
  dismiss: () => void;
}

const IDLE_STATE: VersionSwitchState = { phase: "idle", target: null };

const defaultValue: VersionSwitchContextValue = {
  ...IDLE_STATE,
  startSwitch: () => {},
  dismiss: () => {},
};

const VersionSwitchContext = createContext<VersionSwitchContextValue>(defaultValue);

export function useVersionSwitch(): VersionSwitchContextValue {
  return useContext(VersionSwitchContext);
}

export function VersionSwitchProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<VersionSwitchState>(IDLE_STATE);
  const reloadedRef = useRef(false);

  const startSwitch = useCallback((version: string) => {
    reloadedRef.current = false;
    setState({ phase: "switching", target: version });
  }, []);

  const dismiss = useCallback(() => {
    setState(IDLE_STATE);
  }, []);

  // Confirm the switch by polling the daemon until it reports the target
  // version. Fetch errors are expected while the daemon restarts.
  useEffect(() => {
    if (state.phase !== "switching") return;
    const target = state.target;
    let attempts = 0;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        attempts += 1;
        try {
          const response = await fetch("/api/runtime/info");
          if (response.ok) {
            const payload = await readResponsePayload(response);
            if (!cancelled && isRuntimeInfoResponse(payload) && payload.version === target) {
              // Reload synchronously here: the full page reload discards the
              // query cache anyway, so invalidating first only delays
              // navigation and leaves the blocking overlay's "done" phase
              // (which renders nothing) exposed with an interactive,
              // stale-state dashboard underneath.
              setState({ phase: "done", target });
              if (!reloadedRef.current) {
                reloadedRef.current = true;
                window.location.reload();
              }
              return;
            }
          }
        } catch {
          // daemon restarting; keep polling
        }
        if (!cancelled && attempts >= SWITCH_POLL_ATTEMPTS) {
          setState({ phase: "failed", target });
        }
      })();
    }, SWITCH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state.phase, state.target]);

  return (
    <VersionSwitchContext.Provider value={{ ...state, startSwitch, dismiss }}>
      {children}
    </VersionSwitchContext.Provider>
  );
}
