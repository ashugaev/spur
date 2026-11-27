"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BusyContent } from "@/components/BusyContent";
import { IconCloseButton } from "@/components/IconCloseButton";
import { PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from "@/design/classes";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { accountLines, authProviderName, quotaText } from "@/lib/auth-accounts";
import type { AuthAccountSummary, AuthProvider } from "@/lib/types";

interface SetDefaultDialogProps {
  provider: AuthProvider;
  account: AuthAccountSummary;
  /** Display name of the default this replaces. */
  replaces: string | null;
  /** Running Auto sessions that would move. */
  active: number;
  /** Running pinned sessions; they never move. */
  pinned: number;
  pending: boolean;
  onConfirm: (applyToActive: boolean) => void;
  onCancel: () => void;
}

// The row carries the focus ring; the radio inside it stays outline-free.
const RADIO_CLASS = "accent-[var(--color-accent)] outline-none disabled:opacity-50";
const ROW_CLASS =
  "flex cursor-pointer items-start gap-2 border-b border-[var(--color-border-subtle)] px-2.5 py-2 last:border-b-0 has-[:checked]:bg-[var(--color-hover-overlay)] has-[:disabled]:cursor-not-allowed has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-[var(--color-accent)]";
const NOTE_CLASS = "normal-case tracking-normal";

/** Scope choice for a provider default change that would reach running Auto sessions. */
export function SetDefaultDialog({
  provider,
  account,
  replaces,
  active,
  pinned,
  pending,
  onConfirm,
  onCancel,
}: SetDefaultDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [applyToActive, setApplyToActive] = useState(false);
  const providerName = authProviderName(provider);
  const lines = accountLines(account);
  const quota = quotaText(account);

  useDialogFocus({ panelRef, initialRef: cancelRef, onEscape: onCancel, escapeBlocked: pending });

  return createPortal(
    <div
      aria-labelledby="set-default-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      role="dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div
        ref={panelRef}
        className="max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4 shadow-dialog"
      >
        <div className="mb-3 flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2
              className="font-bold uppercase text-[var(--color-text-primary)]"
              id="set-default-dialog-title"
            >
              Set {providerName} default
            </h2>
            <span className={`${NOTE_CLASS} text-[var(--color-text-secondary)]`}>
              New {providerName} sessions start on this account.
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
          className={`mb-3 flex items-center gap-2 border border-[var(--color-border-default)] px-2.5 py-2 ${NOTE_CLASS}`}
          data-testid="set-default-account"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className="truncate font-bold text-[var(--color-text-primary)]"
              title={lines.primary}
            >
              {lines.primary}
            </span>
            {lines.secondary ? (
              <span className="truncate text-[var(--color-text-secondary)]" title={lines.secondary}>
                {lines.secondary}
              </span>
            ) : null}
          </span>
          {quota ? (
            <span className="shrink-0 text-[var(--color-text-secondary)]">{quota.left}</span>
          ) : null}
        </div>
        {replaces ? (
          <p className={`mb-3 ${NOTE_CLASS} text-[var(--color-text-secondary)]`}>
            Replaces {replaces}.
          </p>
        ) : null}
        <div className="mb-1 uppercase tracking-meta text-[var(--color-text-secondary)]">
          Running sessions
        </div>
        <div
          aria-label="Running sessions"
          className={`mb-3 border border-[var(--color-border-default)] ${NOTE_CLASS}`}
          role="radiogroup"
        >
          <label className={ROW_CLASS}>
            <input
              checked={!applyToActive}
              className={RADIO_CLASS}
              disabled={pending}
              name="set-default-scope"
              type="radio"
              onChange={() => setApplyToActive(false)}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-bold text-[var(--color-text-primary)]">Only new sessions</span>
              <span className="text-[var(--color-text-secondary)]">
                Active sessions keep their account.
              </span>
            </span>
          </label>
          <label className={ROW_CLASS}>
            <input
              checked={applyToActive}
              className={RADIO_CLASS}
              disabled={pending}
              name="set-default-scope"
              type="radio"
              onChange={() => setApplyToActive(true)}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-bold text-[var(--color-text-primary)]">
                Also switch active sessions
              </span>
              <span className="text-[var(--color-text-secondary)]">
                They move on their next request.
              </span>
            </span>
            <span className="shrink-0 text-[var(--color-text-primary)]">{active} active</span>
          </label>
        </div>
        {pinned > 0 ? (
          <p className={`mb-3 ${NOTE_CLASS} text-[var(--color-text-secondary)]`}>
            {pinned} pinned {pinned === 1 ? "session keeps its" : "sessions keep their"} account.
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
            aria-label={pending ? "Setting default" : undefined}
            className={PRIMARY_BUTTON_CLASS}
            disabled={pending}
            type="button"
            onClick={() => onConfirm(applyToActive)}
          >
            <BusyContent busy={pending}>Set default</BusyContent>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
