"use client";

import { useRef, useState } from "react";
import { BusyContent } from "@/components/BusyContent";
import { CheckIcon } from "@/components/icons/CheckIcon";
import { Spinner } from "@/components/icons/Spinner";
import { IconCloseButton } from "@/components/IconCloseButton";
import { CHECKBOX_CLASS, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from "@/design/classes";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
  accountLines,
  authProviderName,
  autoAccount,
  quotaText,
  useAuthAccounts,
} from "@/lib/auth-accounts";
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
// The row carries the focus ring; the radio inside it stays outline-free.
const RADIO_CLASS = "accent-[var(--color-accent)] outline-hidden disabled:opacity-50";
const ROW_CLASS =
  "flex cursor-pointer items-center gap-2 border-b border-[var(--color-border-subtle)] px-2.5 py-2 last:border-b-0 has-[:checked]:bg-[var(--color-hover-overlay)] has-[:disabled]:cursor-not-allowed has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-[var(--color-accent)]";

function QuotaCell({ text }: { text: ReturnType<typeof quotaText> }) {
  if (!text) return null;
  return (
    <span
      className="flex shrink-0 flex-col items-end text-[var(--color-text-secondary)]"
      title={text.title || undefined}
    >
      <span>{text.left}</span>
      {text.resets ? <span>{text.resets}</span> : null}
    </span>
  );
}

export function SwitchAuthDialog({
  auth,
  status,
  errorMessage,
  onConfirm,
  onCancel,
}: SwitchAuthDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const accountsQuery = useAuthAccounts(true, { poll: true });
  const providerAccounts = (accountsQuery.data?.accounts ?? []).filter(
    (account) => account.provider === auth.provider,
  );
  // The pinned account always has a row, so the dialog never hides what the session runs on.
  const identified = providerAccounts.filter(
    (account) => account.identity !== undefined || account.id === auth.accountId,
  );
  const resolvedAuto = autoAccount(
    providerAccounts,
    accountsQuery.data?.pools[auth.provider],
    auth,
  );
  const current = auth.mode === "pinned" ? (auth.accountId ?? AUTO_VALUE) : AUTO_VALUE;
  const [selected, setSelected] = useState(current);
  const [force, setForce] = useState(false);
  const providerName = authProviderName(auth.provider);
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
        className="max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4 shadow-[0_8px_24px_var(--color-shadow-modal-sm)]"
      >
        <div className="mb-3 flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2
              className="font-bold uppercase text-[var(--color-text-primary)]"
              id="switch-auth-dialog-title"
            >
              Switch {providerName} account
            </h2>
            <span
              className="normal-case tracking-normal text-[var(--color-text-secondary)]"
              data-testid="switch-auth-current"
            >
              Applies from this session&apos;s next request.
            </span>
          </div>
          <IconCloseButton
            disabled={pending}
            idleTextClass="text-[var(--color-text-secondary)]"
            label="Close"
            onClick={onCancel}
          />
        </div>
        <div
          aria-labelledby="switch-auth-dialog-title"
          className="mb-3 border border-[var(--color-border-default)] normal-case tracking-normal"
          data-testid="switch-auth-account"
          role="radiogroup"
        >
          <label className={ROW_CLASS}>
            <input
              checked={selected === AUTO_VALUE}
              className={RADIO_CLASS}
              disabled={pending}
              name="switch-auth-account"
              type="radio"
              value={AUTO_VALUE}
              onChange={() => setSelected(AUTO_VALUE)}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-bold text-[var(--color-text-primary)]">Auto</span>
              {resolvedAuto ? (
                <span
                  className="truncate text-[var(--color-text-secondary)]"
                  title={resolvedAuto.displayName}
                >
                  now {resolvedAuto.displayName}
                </span>
              ) : null}
            </span>
            {resolvedAuto ? <QuotaCell text={quotaText(resolvedAuto)} /> : null}
          </label>
          {identified.map((account) => {
            const lines = accountLines(account);
            const signedOut = account.status !== "ready";
            return (
              <label key={account.id} className={ROW_CLASS}>
                <input
                  checked={selected === account.id}
                  className={RADIO_CLASS}
                  disabled={pending || signedOut}
                  name="switch-auth-account"
                  type="radio"
                  value={account.id}
                  onChange={() => setSelected(account.id)}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="truncate font-bold text-[var(--color-text-primary)]"
                      title={lines.primary}
                    >
                      {lines.primary}
                    </span>
                    {account.id === auth.effectiveAccountId ? (
                      <span
                        className="shrink-0 text-[var(--color-text-primary)]"
                        role="img"
                        aria-label="current"
                        title="This session runs on it now"
                      >
                        <CheckIcon className="h-3 w-3" />
                      </span>
                    ) : null}
                  </span>
                  {lines.secondary ? (
                    <span
                      className="truncate text-[var(--color-text-secondary)]"
                      title={lines.secondary}
                    >
                      {lines.secondary}
                    </span>
                  ) : null}
                </span>
                {signedOut ? (
                  <span className="shrink-0 text-[var(--color-text-secondary)]">signed out</span>
                ) : (
                  <QuotaCell text={quotaText(account)} />
                )}
              </label>
            );
          })}
        </div>
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
          Interrupt the request in flight
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
            className={PRIMARY_BUTTON_CLASS}
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
