"use client";

import { useEffect, useState } from "react";
import { BlockingOverlayShell } from "@/components/BlockingOverlayShell";
import { BusyContent } from "@/components/BusyContent";
import { LoadingBar } from "@/components/LoadingBar";
import { useVersionSwitch, versionSwitchFailedMessage } from "@/lib/version-switch-context";

type DiagnoseState = "idle" | "spawning" | "spawned" | "error";

const DIAGNOSE_LABEL: Record<DiagnoseState, string> = {
  idle: "Diagnose update",
  spawning: "Diagnose update",
  spawned: "Agent spawned",
  error: "Retry diagnose",
};

export function VersionSwitchOverlay() {
  const { phase, target, dismiss } = useVersionSwitch();
  const [diagnoseState, setDiagnoseState] = useState<DiagnoseState>("idle");

  // Reset the Diagnose button on every fresh failure so a stuck
  // "Agent spawned"/error state from a prior switch attempt doesn't carry
  // over into the next one (the overlay never unmounts between attempts).
  useEffect(() => {
    if (phase === "failed") setDiagnoseState("idle");
  }, [phase, target]);

  if (phase === "idle" || phase === "done") return null;

  const handleDiagnose = async () => {
    setDiagnoseState("spawning");
    try {
      const response = await fetch("/api/diagnose-update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: target ?? "" }),
      });
      setDiagnoseState(response.ok ? "spawned" : "error");
    } catch {
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
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <button
              aria-busy={diagnoseState === "spawning" || undefined}
              aria-label={diagnoseState === "spawning" ? "Spawning diagnostic agent" : undefined}
              className="border border-[var(--color-border-default)] px-3 py-1 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={diagnoseState === "spawning" || diagnoseState === "spawned"}
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
