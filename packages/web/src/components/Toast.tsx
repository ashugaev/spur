"use client";

import { CloseIcon } from "@/components/icons/CloseIcon";
import type { ToastEntry } from "@/hooks/useToasts";
import type { CSSProperties } from "react";

const TOAST_MAX_HEIGHT_BY_STACK_SIZE = [
  "min(32rem, calc(100dvh - 2rem))",
  "min(32rem, calc(50dvh - 1.25rem))",
  "min(32rem, calc(33.333dvh - 1rem))",
  "min(32rem, calc(25dvh - 0.875rem))",
  "min(32rem, calc(20dvh - 0.8rem))",
] as const;

function toastMaxHeight(stackSize: number): string {
  const index = Math.min(Math.max(stackSize, 1), TOAST_MAX_HEIGHT_BY_STACK_SIZE.length) - 1;
  return TOAST_MAX_HEIGHT_BY_STACK_SIZE[index];
}

function ToastItem({
  toast,
  stackSize,
  onDismiss,
}: {
  toast: ToastEntry;
  stackSize: number;
  onDismiss: (id: number) => void;
}) {
  const backgroundClass =
    toast.tone === "success" ? "bg-[var(--color-bg-surface)]" : "bg-[var(--color-bg-base)]";
  const toneClass =
    toast.tone === "success"
      ? "border-[var(--color-status-ready)] text-[var(--color-text-primary)]"
      : "border-[var(--color-status-error)] text-[var(--color-chip-error-text)]";
  const toastStyle: CSSProperties = {
    maxHeight: toastMaxHeight(stackSize),
  };

  return (
    <div
      className={`pointer-events-auto grid min-h-0 w-[min(calc(100vw-2rem),36rem)] grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_minmax(0,1fr)] gap-x-3 overflow-hidden border px-3 py-2 shadow-[0_8px_30px_var(--color-shadow-menu)] ${backgroundClass} ${toneClass}`}
      role={toast.tone === "error" ? "alert" : "status"}
      style={toastStyle}
    >
      <div className="col-start-1 row-start-1 text-[10px] font-bold uppercase tracking-[0.12em]">
        {toast.tone === "success" ? "Success" : "Error"}
      </div>
      <div
        className="col-start-1 row-start-2 mt-1 min-h-0 overflow-y-auto overscroll-contain pr-1"
        data-toast-scroll
      >
        <div className="whitespace-pre-wrap break-words font-medium">{toast.title}</div>
        {toast.detail ? (
          <div className="mt-1 whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">
            {toast.detail}
          </div>
        ) : null}
      </div>
      <button
        aria-label="Dismiss toast"
        className={`col-start-2 row-span-2 row-start-1 inline-flex h-7 w-7 shrink-0 items-center justify-center border border-[var(--color-border-strong)] ${backgroundClass} text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]`}
        onClick={() => onDismiss(toast.id)}
        type="button"
      >
        <CloseIcon className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
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
  const stackSize = Math.max(toasts.length, 1);

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-hidden"
      style={{ maxHeight: "calc(100dvh - 2rem)" }}
    >
      <div aria-live="polite" className="contents">
        {successToasts.map((toast) => (
          <ToastItem key={toast.id} stackSize={stackSize} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
      <div aria-live="assertive" className="contents">
        {errorToasts.map((toast) => (
          <ToastItem key={toast.id} stackSize={stackSize} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}
