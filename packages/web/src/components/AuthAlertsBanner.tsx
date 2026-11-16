"use client";

import { useCallback, useState } from "react";
import { AuthSignInFlow, type SignInTarget } from "@/components/AuthSignInFlow";
import { TerminalIconButton } from "@/components/TerminalIconButton";
import { getAgentDisplayName } from "@/lib/agents";
import { useAuthAlerts } from "@/lib/auth-accounts";
import type { AuthAlert } from "@/lib/types";

interface OpenFlow {
  alert: AuthAlert;
  mode: "ui" | "terminal";
}

function flowTarget(alert: AuthAlert): SignInTarget {
  return alert.kind === "managed" && alert.accountId
    ? {
        kind: "account",
        account: { id: alert.accountId, provider: alert.provider, label: alert.label },
      }
    : { kind: "host", provider: alert.provider };
}

function sessionsWaiting(count: number | undefined): string | null {
  if (!count) return null;
  return `${count} ${count === 1 ? "session" : "sessions"} waiting`;
}

/** One row per broken managed account or host login; rows come only from the daemon. */
export function AuthAlertsBanner() {
  const alertsQuery = useAuthAlerts();
  const [flow, setFlow] = useState<OpenFlow | null>(null);
  const alerts = alertsQuery.data?.alerts ?? [];
  const closeFlow = useCallback(() => setFlow(null), []);

  return (
    <>
      {alerts.length > 0 ? (
        <section aria-label="Sign-in alerts" className="mt-4 flex flex-col gap-1.5">
          {alerts.map((alert) => {
            const meta =
              alert.kind === "host"
                ? "host credentials"
                : ["managed account", sessionsWaiting(alert.sessionsWaiting)]
                    .filter(Boolean)
                    .join(" · ");
            return (
              <div
                key={alert.id}
                className="flex items-center gap-2.5 border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-1.5 text-[var(--color-chip-error-text)]"
                data-testid={`auth-alert-${alert.id}`}
                role="alert"
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 bg-[var(--color-status-error)]"
                />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {alert.kind === "host"
                    ? `${alert.label} login expired or rejected`
                    : `${getAgentDisplayName(alert.provider)} · ${alert.label} signed out`}
                  <span className="text-[var(--color-text-secondary)]"> · {meta}</span>
                </span>
                <button
                  aria-label={`Sign in ${alert.label}`}
                  className="shrink-0 border border-[var(--color-chip-error-border)] px-2 py-1 font-bold uppercase text-[var(--color-chip-error-text)] outline-none transition-colors hover:bg-[var(--color-hover-overlay)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)]"
                  type="button"
                  onClick={() => setFlow({ alert, mode: "ui" })}
                >
                  Sign in
                </button>
                <TerminalIconButton
                  tone="error"
                  onClick={() => setFlow({ alert, mode: "terminal" })}
                />
              </div>
            );
          })}
        </section>
      ) : null}
      {flow ? (
        <AuthSignInFlow
          initialMode={flow.mode}
          target={flowTarget(flow.alert)}
          onClose={closeFlow}
        />
      ) : null}
    </>
  );
}
