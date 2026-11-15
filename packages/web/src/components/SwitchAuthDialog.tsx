"use client";

import { useRef, useState } from "react";
import { BusyContent } from "@/components/BusyContent";
import { Spinner } from "@/components/icons/Spinner";
import {
  ATTENTION_BUTTON_CLASS,
  CHECKBOX_CLASS,
  INPUT_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "@/design/classes";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { getAgentDisplayName } from "@/lib/agents";
import { authAccountName, authAccountOptionLabel, useAuthAccounts } from "@/lib/auth-accounts";
import type { SpurSessionAuth } from "@/lib/types";

interface SwitchAuthDialogProps {
  auth: SpurSessionAuth;
  status: "idle" | "pending" | "error";
  errorMessage: string | null;
  /** `null` selects Auto. */
  onConfirm: (accountId: string | null, force: boolean) => void;
  onCancel: () => void;
}

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
  const pending = status === "pending";

  useDialogFocus({ panelRef, initialRef: cancelRef, onEscape: onCancel, escapeBlocked: pending });

  return (
    <div
      aria-labelledby="switch-auth-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      role="dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div
        ref={panelRef}
        className="w-[min(22rem,calc(100vw-2rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4 shadow-[0_8px_24px_var(--color-shadow-modal-sm)]"
      >
        <h2
          className="mb-2 font-bold uppercase text-[var(--color-text-primary)]"
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
            className={`mt-1 block w-full ${INPUT_CLASS}`}
            data-testid="switch-auth-account"
            disabled={pending}
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value={AUTO_VALUE}>Auto</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {authAccountOptionLabel(account)}
              </option>
            ))}
          </select>
        </label>
        {accountsQuery.isPending ? (
          <div
            aria-label="Loading accounts"
            className="mb-3 flex justify-center text-[var(--color-text-tertiary)]"
            data-testid="switch-auth-loading"
            role="status"
          >
            <Spinner className="h-4 w-4" strokeWidth={1.5} />
          </div>
        ) : null}
        {accountsQuery.isError ? (
          <p
            className="mb-3 normal-case tracking-normal text-[var(--color-status-error)]"
            role="alert"
          >
            {accountsQuery.error.message}
          </p>
        ) : null}
        <label className="mb-3 flex items-center gap-2 normal-case tracking-normal text-[var(--color-text-secondary)]">
          <input
            checked={force}
            className={CHECKBOX_CLASS}
            disabled={pending}
            type="checkbox"
            onChange={(event) => setForce(event.target.checked)}
          />
          Force (kill in-flight work)
        </label>
        {status === "error" && errorMessage ? (
          <p
            className="mb-3 normal-case tracking-normal text-[var(--color-status-error)]"
            data-testid="switch-auth-error"
            role="alert"
          >
            {errorMessage}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            className={SECONDARY_BUTTON_CLASS}
            disabled={pending}
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            aria-busy={pending || undefined}
            aria-label={pending ? "Switching account" : undefined}
            className={ATTENTION_BUTTON_CLASS}
            disabled={pending || selected === current}
            type="button"
            onClick={() => onConfirm(selected === AUTO_VALUE ? null : selected, force)}
          >
            <BusyContent busy={pending}>Switch</BusyContent>
          </button>
        </div>
      </div>
    </div>
  );
}
