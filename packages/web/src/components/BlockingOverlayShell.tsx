"use client";

import type { ReactNode } from "react";
import { StatusCard } from "@/components/StatusCard";

interface BlockingOverlayShellProps {
  testId: string;
  headingId: string;
  ariaLive?: "assertive";
  children: ReactNode;
}

// Shared full-screen blocking-overlay chrome for the app's global gates
// (version switch, backend connectivity): container + backdrop + elevated
// card. z-[100] sits above TerminalModal's z-[90] (the highest layer in the
// app otherwise) so whichever gate is active stays visible even if a
// terminal modal is open. Callers slot their own heading/body/actions and
// own their aria wiring beyond what's common here, so a future chrome tweak
// (spacing, shadow, backdrop) can't drift the two overlays apart.
export function BlockingOverlayShell({
  testId,
  headingId,
  ariaLive,
  children,
}: BlockingOverlayShellProps) {
  return (
    <div
      aria-labelledby={headingId}
      aria-live={ariaLive}
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      data-testid={testId}
      role="alertdialog"
    >
      <StatusCard>{children}</StatusCard>
    </div>
  );
}
