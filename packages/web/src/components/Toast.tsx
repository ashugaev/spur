"use client";

import { CloseIcon } from "@/components/icons/CloseIcon";
import type { ToastEntry } from "@/hooks/useToasts";

function ToastItem({ toast, onDismiss }: { toast: ToastEntry; onDismiss: (id: number) => void }) {
  const backgroundClass =
    toast.tone === "success" ? "bg-[var(--color-bg-surface)]" : "bg-[var(--color-bg-base)]";
  const toneClass =
    toast.tone === "success"
      ? "border-[var(--color-status-ready)] text-[var(--color-text-primary)]"
      : "border-[var(--color-status-error)] text-[var(--color-chip-error-text)]";

  return (
    <div
      className={`pointer-events-auto max-h-[min(calc(100vh-2rem),32rem)] w-[min(calc(100vw-2rem),36rem)] overflow-y-auto overscroll-contain border px-3 py-2 shadow-[0_8px_30px_var(--color-shadow-menu)] ${backgroundClass} ${toneClass}`}
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
          className={`sticky top-0 inline-flex h-7 w-7 shrink-0 items-center justify-center border border-[var(--color-border-strong)] ${backgroundClass} text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]`}
          onClick={() => onDismiss(toast.id)}
          type="button"
        >
          <CloseIcon className="h-3.5 w-3.5" strokeWidth={2} />
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
  const successToasts = toasts.filter((toast) => toast.tone === "success");
  const errorToasts = toasts.filter((toast) => toast.tone === "error");

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col gap-2">
      <div aria-live="polite" className="contents">
        {successToasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
      <div aria-live="assertive" className="contents">
        {errorToasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}
