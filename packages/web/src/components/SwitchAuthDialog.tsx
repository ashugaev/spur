"use client";

import { useEffect, useRef, useState } from "react";
import { BusyContent } from "@/components/BusyContent";
import { getAgentDisplayName } from "@/lib/agents";
import { authAccountName, useAuthAccounts } from "@/lib/auth-accounts";
import type { SpurSessionAuth } from "@/lib/types";

interface SwitchAuthDialogProps {
  auth: SpurSessionAuth;
  status: "idle" | "pending" | "error";
  errorMessage: string | null;
  /** `null` selects Auto. */
  onConfirm: (accountId: string | null, force: boolean) => void;
  onCancel: () => void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const AUTO_VALUE = "";

export function SwitchAuthDialog({
  auth,
  status,
  errorMessage,
  onConfirm,
  onCancel,
}: SwitchAuthDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const accountsQuery = useAuthAccounts();
  const providerAccounts = (accountsQuery.data?.accounts ?? []).filter(
    (account) => account.provider === auth.provider,
  );
  const accounts = providerAccounts.filter((account) => account.authenticated);
  const effective = providerAccounts.find((account) => account.id === auth.effectiveAccountId);
  const current = auth.mode === "pinned" ? (auth.accountId ?? AUTO_VALUE) : AUTO_VALUE;
  const [selected, setSelected] = useState(current);
  const [force, setForce] = useState(false);
  const providerName = getAgentDisplayName(auth.provider);

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
          Switch {providerName} account
        </h2>
        <p
          className="mb-3 normal-case tracking-normal text-[var(--color-text-secondary)]"
          data-testid="switch-auth-current"
        >
          {`Now: ${effective ? authAccountName(effective) : auth.effectiveAccountId.slice(0, 8)} (${
            auth.mode === "auto" ? "Auto" : "pinned"
          }). Next request uses the new account.`}
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
            <option value={AUTO_VALUE}>Auto</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {authAccountName(account)}
              </option>
            ))}
          </select>
        </label>
        {accountsQuery.isError ? (
          <p className="mb-3 normal-case tracking-normal text-[var(--color-status-error)]">
            {accountsQuery.error.message}
          </p>
        ) : null}
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
            aria-busy={status === "pending" || undefined}
            aria-label={status === "pending" ? "Switching account" : undefined}
            className="border border-[var(--color-status-attention)] px-3 py-1 font-bold text-[var(--color-status-attention)] outline-none transition-colors hover:bg-[var(--color-status-attention)] hover:text-[var(--color-bg-elevated)] focus-visible:bg-[var(--color-status-attention)] focus-visible:text-[var(--color-bg-elevated)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={status === "pending" || selected === current}
            type="button"
            onClick={() => onConfirm(selected === AUTO_VALUE ? null : selected, force)}
          >
            <BusyContent busy={status === "pending"}>Switch</BusyContent>
          </button>
        </div>
      </div>
    </div>
  );
}
