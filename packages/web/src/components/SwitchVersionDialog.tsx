"use client";

import { useEffect, useRef } from "react";
import { BusyContent } from "@/components/BusyContent";

interface SwitchVersionDialogProps {
  current: string;
  pending: string;
  status: "idle" | "pending" | "error";
  errorMessage: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function SwitchVersionDialog({
  current,
  pending,
  status,
  errorMessage,
  onConfirm,
  onCancel,
}: SwitchVersionDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && status !== "pending") {
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, status]);

  return (
    <div
      aria-labelledby="switch-version-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      role="dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget && status !== "pending") onCancel();
      }}
    >
      <div
        ref={panelRef}
        className="w-[min(22rem,calc(100vw-2rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4 shadow-[0_8px_24px_var(--color-shadow-modal-sm)]"
      >
        <h2
          className="mb-2 font-bold text-[var(--color-text-primary)]"
          id="switch-version-dialog-title"
        >
          Switch Spur version
        </h2>
        <p className="mb-3 normal-case tracking-normal text-[var(--color-text-secondary)]">
          Switch from <span className="text-[var(--color-text-primary)]">{current || "?"}</span> to{" "}
          <span className="text-[var(--color-text-primary)]">{pending}</span>? The Spur daemon will
          restart. Refresh this page in about 10 seconds.
        </p>
        {status === "error" && errorMessage ? (
          <p
            className="mb-3 normal-case tracking-normal text-[var(--color-status-attention)]"
            data-testid="switch-version-error"
          >
            {errorMessage}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            className="border border-[var(--color-border-default)] px-3 py-1 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={status === "pending"}
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            aria-busy={status === "pending" || undefined}
            aria-label={status === "pending" ? "Switching version" : undefined}
            className="border border-[var(--color-status-attention)] px-3 py-1 font-bold text-[var(--color-status-attention)] outline-none transition-colors hover:bg-[var(--color-status-attention)] hover:text-[var(--color-bg-elevated)] focus-visible:bg-[var(--color-status-attention)] focus-visible:text-[var(--color-bg-elevated)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={status === "pending"}
            type="button"
            onClick={onConfirm}
          >
            <BusyContent busy={status === "pending"}>Switch</BusyContent>
          </button>
        </div>
      </div>
    </div>
  );
}
