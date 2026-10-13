import type { ReactNode } from "react";

interface StatusCardProps {
  tone?: "default" | "error";
  testId?: string;
  role?: "status" | "alert";
  ariaLive?: "polite";
  children: ReactNode;
}

// Elevated card chrome shared by BlockingOverlayShell and SessionLoadState so
// the two surfaces can't drift apart.
export function StatusCard({
  tone = "default",
  testId,
  role,
  ariaLive,
  children,
}: StatusCardProps) {
  const border =
    tone === "error"
      ? "border-[var(--color-chip-error-border)]"
      : "border-[var(--color-border-default)]";
  return (
    <div
      aria-live={ariaLive}
      className={`w-[min(24rem,calc(100vw-2rem))] border ${border} bg-[var(--color-bg-elevated)] p-4 shadow-[0_8px_24px_var(--color-shadow-modal-sm)]`}
      data-testid={testId}
      role={role}
    >
      {children}
    </div>
  );
}
