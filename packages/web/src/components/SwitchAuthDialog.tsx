"use client";

import { useEffect, useRef, useState } from "react";
import type { SpurClaudeAccount } from "@/lib/types";

interface SwitchAuthDialogProps {
  accounts: SpurClaudeAccount[];
  activeAccountId: string | null;
  status: "idle" | "pending" | "error";
  errorMessage: string | null;
  onConfirm: (accountId: string, force: boolean) => void;
  onCancel: () => void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function accountLabel(account: SpurClaudeAccount): string {
  return account.label?.trim() || account.id.slice(0, 8);
}

export function SwitchAuthDialog({
  accounts,
  activeAccountId,
  status,
  errorMessage,
  onConfirm,
  onCancel,
}: SwitchAuthDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState(
    () =>
      accounts.find(
        (account) => account.status === "ready" && account.id !== activeAccountId,
      )?.id ?? "",
  );
  const [force, setForce] = useState(false);

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
      aria-labelledby="switch-auth-dialog-title"
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
          id="switch-auth-dialog-title"
        >
          Switch Claude account
        </h2>
        <p className="mb-3 normal-case tracking-normal text-[var(--color-text-secondary)]">
          Relaunch this Claude session under a different logged-in account. The session restarts and
          resumes in the same worktree.
        </p>
        <label className="mb-3 block normal-case tracking-normal text-[var(--color-text-secondary)]">
          Account
          <select
            className="mt-1 block w-full border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-2 py-1 text-[var(--color-text-primary)] outline-none"
            data-testid="switch-auth-account"
            disabled={status === "pending"}
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {accounts.map((account) => (
              <option
                key={account.id}
                disabled={account.status !== "ready" || account.id === activeAccountId}
                value={account.id}
              >
                {accountLabel(account)}
                {account.id === activeAccountId ? " (current)" : ""}
                {account.status !== "ready" ? ` (${account.status})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="mb-3 flex items-center gap-2 normal-case tracking-normal text-[var(--color-text-secondary)]">
          <input
            checked={force}
            disabled={status === "pending"}
            type="checkbox"
            onChange={(event) => setForce(event.target.checked)}
          />
          Force (kill in-flight work)
        </label>
        {status === "error" && errorMessage ? (
          <p
            className="mb-3 normal-case tracking-normal text-[var(--color-status-attention)]"
            data-testid="switch-auth-error"
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
            className="border border-[var(--color-status-attention)] px-3 py-1 font-bold text-[var(--color-status-attention)] outline-none transition-colors hover:bg-[var(--color-status-attention)] hover:text-[var(--color-bg-elevated)] focus-visible:bg-[var(--color-status-attention)] focus-visible:text-[var(--color-bg-elevated)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={status === "pending" || !selected}
            type="button"
            onClick={() => onConfirm(selected, force)}
          >
            {status === "pending" ? "Switching…" : "Switch"}
          </button>
        </div>
      </div>
    </div>
  );
}
