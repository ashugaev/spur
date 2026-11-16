"use client";

import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFooterPopover } from "@/lib/footer-popover";
import { AccountsIcon } from "@/components/icons/AccountsIcon";
import { CheckIcon } from "@/components/icons/CheckIcon";
import { Spinner } from "@/components/icons/Spinner";
import { TrashIcon } from "@/components/icons/TrashIcon";
import { AuthSignInFlow, type SignInTarget } from "@/components/AuthSignInFlow";
import { BusyContent } from "@/components/BusyContent";
import { CHECKBOX_CLASS, DANGER_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from "@/design/classes";
import {
  AUTH_ACCOUNTS_QUERY_KEY,
  AUTH_PROVIDERS,
  accountLines,
  authProviderName,
  postAuthJson,
  quotaText,
  useAuthAccounts,
} from "@/lib/auth-accounts";
import type { AuthAccountSummary, AuthPool, AuthProvider } from "@/lib/types";

const NOTE_CLASS = "normal-case tracking-normal";
const ROW_CLASS = `grid grid-cols-[minmax(0,1fr)_auto_5rem_1.75rem] items-center gap-x-2 border-b border-[var(--color-border-subtle)] py-1.5 last:border-b-0 ${NOTE_CLASS}`;
const SIGN_IN_BUTTON_CLASS = `${SECONDARY_BUTTON_CLASS} border-[var(--color-status-attention)]! text-[var(--color-chip-warn-text)]!`;

type SignInRequest = Extract<SignInTarget, { kind: "account" }>;

function ProviderSection({
  provider,
  accounts,
  pool,
  onSignIn,
  focusHandoff,
}: {
  provider: AuthProvider;
  accounts: AuthAccountSummary[];
  pool: AuthPool | undefined;
  onSignIn: (request: SignInRequest) => void;
  /** Set while this section moves focus itself, so the unmounting element's blur never closes the popover. */
  focusHandoff: MutableRefObject<boolean>;
}) {
  const queryClient = useQueryClient();
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const trashRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreTrashId = useRef<string | null>(null);
  // Focus enters the confirm row when it opens and returns to the row's trash button when cancelled.
  const swapRow = (confirmId: string | null) => {
    focusHandoff.current = true;
    setConfirmRemoveId(confirmId);
    window.setTimeout(() => {
      focusHandoff.current = false;
    }, 0);
  };
  useEffect(() => {
    if (confirmRemoveId) {
      cancelRef.current?.focus();
    } else if (restoreTrashId.current) {
      trashRefs.current.get(restoreTrashId.current)?.focus();
      restoreTrashId.current = null;
    }
  }, [confirmRemoveId]);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const pendingRemoval = useRef<{ id: string; focusId: string | null } | null>(null);
  // A removed row hands focus to the next row's trash button, else the Add button.
  useEffect(() => {
    const pending = pendingRemoval.current;
    if (!pending || accounts.some((account) => account.id === pending.id)) return;
    pendingRemoval.current = null;
    const next = pending.focusId ? trashRefs.current.get(pending.focusId) : undefined;
    (next ?? addRef.current)?.focus();
  }, [accounts]);
  // One error per section: each action clears it on start, sets it on failure.
  const [lastError, setLastError] = useState<string | null>(null);
  const name = authProviderName(provider);
  const refresh = () => queryClient.invalidateQueries({ queryKey: AUTH_ACCOUNTS_QUERY_KEY });
  const errorHandlers = {
    onMutate: () => setLastError(null),
    onError: (error: Error) => setLastError(error.message),
  };

  const poolMutation = useMutation<
    unknown,
    Error,
    { defaultAccountId: string | null } | { autoRotate: boolean }
  >({
    mutationFn: (update) =>
      postAuthJson(
        `/api/auth-pools/${provider}`,
        "PATCH",
        update,
        `Failed to update ${name} rotation`,
      ),
    ...errorHandlers,
    onSettled: () => void refresh(),
  });

  const removeMutation = useMutation<unknown, Error, string>({
    mutationFn: (id) =>
      postAuthJson(
        `/api/auth-accounts/${encodeURIComponent(id)}`,
        "DELETE",
        undefined,
        `Failed to remove ${name} account`,
      ),
    ...errorHandlers,
    onSettled: (_data, error, id) => {
      if (error) {
        restoreTrashId.current = id;
        swapRow(null);
        void refresh();
        return;
      }
      // The row unmounts when the refetch lands: hold the blur guard until focus has moved on.
      const index = accounts.findIndex((account) => account.id === id);
      pendingRemoval.current = { id, focusId: accounts[index + 1]?.id ?? null };
      focusHandoff.current = true;
      setConfirmRemoveId(null);
      void refresh().finally(() => {
        window.setTimeout(() => {
          focusHandoff.current = false;
        }, 50);
      });
    },
  });

  const addMutation = useMutation<{ id: string; createdAt: string }, Error>({
    mutationFn: async () => {
      const result = (await postAuthJson(
        "/api/auth-accounts",
        "POST",
        { provider },
        `Failed to add ${name} account`,
      )) as { account?: { id?: unknown; createdAt?: unknown } };
      const { id, createdAt } = result.account ?? {};
      if (typeof id !== "string" || typeof createdAt !== "string") {
        throw new Error(`Failed to add ${name} account`);
      }
      return { id, createdAt };
    },
    ...errorHandlers,
    onSuccess: ({ id, createdAt }) =>
      onSignIn({
        kind: "account",
        isNew: true,
        account: { id, provider, displayName: `New ${name} account`, createdAt },
      }),
    onSettled: () => void refresh(),
  });

  const defaultId = pool?.defaultAccountId ?? null;
  const rotating = poolMutation.isPending && "autoRotate" in (poolMutation.variables ?? {});
  const busy = poolMutation.isPending || removeMutation.isPending || addMutation.isPending;

  return (
    <section className="flex flex-col gap-1" data-testid={`auth-section-${provider}`}>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-1">
        <span className="font-bold uppercase text-[var(--color-text-primary)]">{name}</span>
        <label
          className={`flex items-center gap-2 ${NOTE_CLASS} text-[var(--color-text-secondary)]`}
          title="Switch to the next account when this one hits its limit"
        >
          <input
            aria-busy={rotating || undefined}
            aria-label={`Auto-rotate ${name} accounts`}
            checked={pool?.autoRotate ?? false}
            className={CHECKBOX_CLASS}
            disabled={busy}
            type="checkbox"
            onChange={(event) => poolMutation.mutate({ autoRotate: event.target.checked })}
          />
          Auto-rotate
          {rotating ? <Spinner className="h-3 w-3" strokeWidth={1.5} /> : null}
        </label>
      </div>
      {accounts.length === 0 ? (
        <div className={`${NOTE_CLASS} text-[var(--color-text-tertiary)]`}>No {name} accounts.</div>
      ) : (
        <ul className="flex flex-col">
          {accounts.map((account) => {
            const lines = accountLines(account);
            const quota = quotaText(account);
            const inUse = account.id === defaultId && account.status === "ready";
            const confirming = confirmRemoveId === account.id;
            const removing = removeMutation.isPending && removeMutation.variables === account.id;
            if (confirming) {
              return (
                <li
                  key={account.id}
                  className={`flex items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-hover-overlay)] px-1 py-1.5 last:border-b-0 ${NOTE_CLASS}`}
                  data-testid={`auth-account-${account.id}`}
                >
                  <span aria-label="Confirm remove" className="flex min-w-0 flex-col" role="group">
                    <b
                      className="truncate text-[var(--color-text-primary)]"
                      title={account.displayName}
                    >
                      Remove {account.displayName}?
                    </b>
                    <span className="text-[var(--color-text-secondary)]">
                      Its sign-in is deleted from Spur.
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <button
                      ref={cancelRef}
                      className={SECONDARY_BUTTON_CLASS}
                      disabled={removing}
                      type="button"
                      onClick={() => {
                        restoreTrashId.current = account.id;
                        swapRow(null);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      aria-busy={removing || undefined}
                      aria-label={removing ? "Removing account" : undefined}
                      className={DANGER_BUTTON_CLASS}
                      disabled={busy}
                      type="button"
                      onClick={() => removeMutation.mutate(account.id)}
                    >
                      <BusyContent busy={removing}>Remove</BusyContent>
                    </button>
                  </span>
                </li>
              );
            }
            return (
              <li key={account.id} className={ROW_CLASS} data-testid={`auth-account-${account.id}`}>
                <span className="flex min-w-0 flex-col">
                  <span
                    className={`truncate ${
                      account.identity
                        ? "font-bold text-[var(--color-text-primary)]"
                        : "text-[var(--color-text-secondary)]"
                    }`}
                    title={lines.primary}
                  >
                    {lines.primary}
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
                <span
                  className="flex flex-col items-end text-[var(--color-text-secondary)]"
                  title={quota?.title || undefined}
                >
                  {quota ? <span>{quota.left}</span> : null}
                  {quota?.resets ? <span>{quota.resets}</span> : null}
                </span>
                <span className="flex justify-center">
                  {account.status !== "ready" ? (
                    <button
                      aria-label={`Sign in ${account.displayName}`}
                      className={SIGN_IN_BUTTON_CLASS}
                      disabled={busy}
                      type="button"
                      onClick={() => onSignIn({ kind: "account", account })}
                    >
                      Sign in
                    </button>
                  ) : inUse ? (
                    <span
                      aria-label="In use"
                      className="text-[var(--color-text-primary)]"
                      role="img"
                      title="In use: new and Auto sessions run on this account"
                    >
                      <CheckIcon className="h-3 w-3" />
                    </span>
                  ) : (
                    <button
                      aria-label={`Switch ${name} to ${account.displayName}`}
                      className={SECONDARY_BUTTON_CLASS}
                      disabled={busy}
                      type="button"
                      onClick={() => poolMutation.mutate({ defaultAccountId: account.id })}
                    >
                      Switch
                    </button>
                  )}
                </span>
                <button
                  ref={(element) => {
                    if (element) trashRefs.current.set(account.id, element);
                    else trashRefs.current.delete(account.id);
                  }}
                  aria-label={`Remove ${account.displayName}`}
                  className={`flex h-7 w-7 items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50 ${CHECKBOX_CLASS}`}
                  disabled={busy}
                  title="Remove"
                  type="button"
                  onClick={() => swapRow(account.id)}
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {lastError ? (
        <div className={`${NOTE_CLASS} text-[var(--color-status-error)]`} role="alert">
          {lastError}
        </div>
      ) : null}
      <button
        ref={addRef}
        aria-busy={addMutation.isPending || undefined}
        className={`self-start py-1 uppercase tracking-[0.08em] text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50`}
        data-testid={`add-account-${provider}`}
        disabled={busy}
        type="button"
        onClick={() => addMutation.mutate()}
      >
        + Add {name} account
      </button>
    </section>
  );
}

/** Footer menu over every managed provider account and its global pool. */
export function AuthAccountsMenu() {
  const popover = useFooterPopover();
  const [signIn, setSignIn] = useState<SignInRequest | null>(null);
  const accountsQuery = useAuthAccounts(popover.open || signIn !== null, { poll: popover.open });
  const closeSignIn = useCallback(() => setSignIn(null), []);
  const focusHandoff = useRef(false);

  return (
    <div
      ref={popover.containerRef}
      // Below sm the wrapper stays static, so the popover anchors to the
      // full-width footer instead of this trigger and stays on screen.
      className="sm:relative"
      onBlur={(event) => {
        if (!focusHandoff.current) popover.onBlur(event);
      }}
      onMouseEnter={popover.onMouseEnter}
      onMouseLeave={popover.onMouseLeave}
    >
      <button
        aria-expanded={popover.open}
        aria-haspopup="true"
        aria-label="Manage agent accounts"
        className="-m-1.5 flex items-center gap-1.5 p-1.5 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
        data-testid="auth-accounts-trigger"
        title="Manage agent accounts"
        type="button"
        onClick={popover.toggle}
      >
        <AccountsIcon className="h-4 w-4" />
      </button>
      {popover.open ? (
        <div
          className="absolute inset-x-2 bottom-full z-50 mb-1.5 flex max-h-[70vh] flex-col gap-3 overflow-y-auto border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)] sm:inset-x-auto sm:right-0 sm:w-[min(26rem,calc(100vw-1rem))]"
          data-testid="auth-accounts-popover"
        >
          {accountsQuery.isPending ? (
            <div
              aria-label="Loading accounts"
              className="flex items-center justify-center py-2 text-[var(--color-text-tertiary)]"
              data-testid="auth-accounts-loading"
              role="status"
            >
              <Spinner className="h-4 w-4" strokeWidth={1.5} />
            </div>
          ) : accountsQuery.isError ? (
            <div className="flex items-center justify-between gap-2">
              <span className={`${NOTE_CLASS} text-[var(--color-status-error)]`} role="alert">
                {accountsQuery.error.message}
              </span>
              <button
                aria-busy={accountsQuery.isFetching || undefined}
                className={SECONDARY_BUTTON_CLASS}
                disabled={accountsQuery.isFetching}
                type="button"
                onClick={() => void accountsQuery.refetch()}
              >
                <BusyContent busy={accountsQuery.isFetching}>Retry</BusyContent>
              </button>
            </div>
          ) : (
            AUTH_PROVIDERS.map((provider) => (
              <ProviderSection
                key={provider}
                focusHandoff={focusHandoff}
                accounts={accountsQuery.data.accounts.filter(
                  (account) => account.provider === provider,
                )}
                pool={accountsQuery.data.pools[provider]}
                provider={provider}
                onSignIn={setSignIn}
              />
            ))
          )}
        </div>
      ) : null}
      {signIn ? <AuthSignInFlow target={signIn} onClose={closeSignIn} /> : null}
    </div>
  );
}
