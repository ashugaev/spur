"use client";

import { useEffect, useState } from "react";
import { BlockingOverlayShell } from "@/components/BlockingOverlayShell";
import { BusyContent } from "@/components/BusyContent";
import { LoadingBar } from "@/components/LoadingBar";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import { buildSessionPath } from "@/lib/project-routes";
import { useVersionSwitch, versionSwitchFailedMessage } from "@/lib/version-switch-context";

type DiagnoseState = "idle" | "spawning" | "sent" | "error";

// Response contract of /api/diagnose-update, which validates it server-side.
interface DiagnoseUpdateResult {
  disposition: "spawned" | "reused";
  session: { id: string; project: string };
}

const DIAGNOSE_LABEL: Record<DiagnoseState, string> = {
  idle: "Diagnose update",
  spawning: "Diagnose update",
  sent: "Diagnosis sent",
  error: "Retry diagnose",
};

export function VersionSwitchOverlay() {
  const { phase, target, dismiss } = useVersionSwitch();
  const [diagnoseState, setDiagnoseState] = useState<DiagnoseState>("idle");
  const [diagnoseResult, setDiagnoseResult] = useState<{
    disposition: "spawned" | "reused";
    id: string;
    project: string;
  } | null>(null);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);

  // Reset the Diagnose button on every fresh failure so a stuck
  // A sent/error state from a prior switch attempt must not carry
  // over into the next one (the overlay never unmounts between attempts).
  useEffect(() => {
    if (phase === "failed") {
      setDiagnoseState("idle");
      setDiagnoseResult(null);
      setDiagnoseError(null);
    }
  }, [phase, target]);

  if (phase === "idle" || phase === "done") return null;

  const handleDiagnose = async () => {
    setDiagnoseState("spawning");
    setDiagnoseError(null);
    try {
      const response = await fetch("/api/diagnose-update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: target ?? "" }),
      });
      const payload = await readResponsePayload(response);
      if (!response.ok) {
        setDiagnoseError(
          responseErrorMessage(payload, `Diagnosis request failed (HTTP ${response.status})`),
        );
        setDiagnoseState("error");
        return;
      }
      // /api/diagnose-update validates the daemon body and 502s on any other
      // shape, so a 2xx payload is already this contract.
      const result = payload as DiagnoseUpdateResult;
      setDiagnoseResult({ ...result.session, disposition: result.disposition });
      setDiagnoseState("sent");
    } catch (error) {
      setDiagnoseError(error instanceof Error ? error.message : "Diagnosis request failed");
      setDiagnoseState("error");
    }
  };

  const headingId = "version-switch-overlay-heading";

  return (
    <BlockingOverlayShell
      ariaLive="assertive"
      headingId={headingId}
      testId="version-switch-overlay"
    >
      {phase === "switching" ? (
        <div aria-busy="true" className="space-y-3">
          <p className="font-bold text-[var(--color-text-primary)]" id={headingId}>
            Spur update
          </p>
          <LoadingBar label="Updating Spur" />
          <p className="normal-case tracking-normal text-[var(--color-text-secondary)]">
            Switching to {target}. The page will reload automatically once the daemon is back.
          </p>
        </div>
      ) : (
        <div>
          <p className="font-bold text-[var(--color-status-error)]" id={headingId}>
            Updating Spur failed
          </p>
          <p className="mt-1 normal-case tracking-normal text-[var(--color-text-secondary)]">
            {versionSwitchFailedMessage(target ?? "")}
          </p>
          {diagnoseResult ? (
            <p className="mt-2 normal-case tracking-normal text-[var(--color-text-secondary)]">
              {diagnoseResult.disposition === "reused" ? "Sent to" : "Spawned"}{" "}
              <a
                className="text-[var(--color-text-primary)] underline"
                href={buildSessionPath(diagnoseResult.id, diagnoseResult.project)}
              >
                {diagnoseResult.id}
              </a>
            </p>
          ) : null}
          {diagnoseError ? (
            <p
              className="mt-2 normal-case tracking-normal text-[var(--color-status-error)]"
              role="alert"
            >
              {diagnoseError}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <button
              aria-busy={diagnoseState === "spawning" || undefined}
              aria-label={diagnoseState === "spawning" ? "Spawning diagnostic agent" : undefined}
              className="border border-[var(--color-border-default)] px-3 py-1 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={diagnoseState === "spawning" || diagnoseState === "sent"}
              type="button"
              onClick={() => void handleDiagnose()}
            >
              <BusyContent busy={diagnoseState === "spawning"}>
                {DIAGNOSE_LABEL[diagnoseState]}
              </BusyContent>
            </button>
            <button
              className="border border-[var(--color-border-default)] px-3 py-1 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
              type="button"
              onClick={dismiss}
            >
              Dismiss
            </button>
            <button
              className="border border-[var(--color-status-attention)] px-3 py-1 font-bold text-[var(--color-status-attention)] outline-none transition-colors hover:bg-[var(--color-status-attention)] hover:text-[var(--color-bg-elevated)] focus-visible:bg-[var(--color-status-attention)] focus-visible:text-[var(--color-bg-elevated)]"
              type="button"
              onClick={() => window.location.reload()}
            >
              Reload now
            </button>
          </div>
        </div>
      )}
    </BlockingOverlayShell>
  );
}
