"use client";

import type { ToastEntry } from "@/hooks/useToasts";

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
      viewBox="0 0 16 16"
    >
      <path d="M3 3l10 10M13 3 3 13" />
    </svg>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastEntry;
  onDismiss: (id: number) => void;
}) {
  const toneClass =
    toast.tone === "success"
      ? "border-[var(--color-status-ready)] bg-[var(--color-bg-surface)] text-[var(--color-text-primary)]"
      : "border-[var(--color-status-error)] bg-[var(--color-chip-error-bg)] text-[var(--color-chip-error-text)]";

  return (
    <div
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
      className={`pointer-events-auto w-[min(calc(100vw-2rem),36rem)] border px-3 py-2 shadow-[0_8px_30px_var(--color-shadow-menu)] ${toneClass}`}
      role={toast.tone === "error" ? "alert" : "status"}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.12em]">
            {toast.tone === "success" ? "Success" : "Error"}
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words font-medium">{toast.title}</div>
          {toast.detail ? (
            <div className="mt-1 whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">
              {toast.detail}
            </div>
          ) : null}
        </div>
        <button
          aria-label="Dismiss toast"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]"
          onClick={() => onDismiss(toast.id)}
          type="button"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: readonly ToastEntry[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
