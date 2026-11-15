"use client";

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFooterPopover } from "@/lib/footer-popover";
import { AccountsIcon } from "@/components/icons/AccountsIcon";
import { Spinner } from "@/components/icons/Spinner";
import { AuthLoginDialog } from "@/components/AuthLoginDialog";
import { BusyContent } from "@/components/BusyContent";
import {
  CHECKBOX_CLASS,
  DANGER_BUTTON_CLASS,
  INPUT_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "@/design/classes";
import { getAgentDisplayName } from "@/lib/agents";
import {
  AUTH_ACCOUNTS_QUERY_KEY,
  AUTH_PROVIDERS,
  AUTH_STATUS_LABEL,
  authAccountName,
  authLimitLabel,
  isAuthLogin,
  postAuthJson,
  useAuthAccounts,
} from "@/lib/auth-accounts";
import type { AuthAccountSummary, AuthLogin, AuthPool, AuthProvider } from "@/lib/types";

interface LoginState {
  account: AuthAccountSummary;
  login: AuthLogin;
}

const STATUS_COLOR: Record<AuthAccountSummary["status"], string> = {
  ready: "text-[var(--color-status-ready)]",
  sign_in_required: "text-[var(--color-status-attention)]",
  pending: "text-[var(--color-status-attention)]",
  error: "text-[var(--color-status-error)]",
};

const NOTE_CLASS = "normal-case tracking-normal";

function ProviderSection({
  provider,
  accounts,
  pool,
  onSignIn,
}: {
  provider: AuthProvider;
  accounts: AuthAccountSummary[];
  pool: AuthPool | undefined;
  onSignIn: (state: LoginState) => void;
}) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  // One error per section: each action clears it on start, sets it on failure.
  const [lastError, setLastError] = useState<string | null>(null);
  const name = getAgentDisplayName(provider);
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
    onSettled: () => {
      setConfirmRemoveId(null);
      void refresh();
    },
  });

  const signInMutation = useMutation<LoginState, Error, AuthAccountSummary>({
    mutationFn: async (account) => {
      const login = await postAuthJson(
        `/api/auth-accounts/${encodeURIComponent(account.id)}/login`,
        "POST",
        undefined,
        "Failed to start sign-in",
      );
      if (!isAuthLogin(login)) throw new Error("Failed to start sign-in");
      return { account, login };
    },
    ...errorHandlers,
    onSuccess: onSignIn,
    onSettled: () => void refresh(),
  });

  const addMutation = useMutation<AuthAccountSummary, Error, string>({
    mutationFn: async (nextLabel) => {
      const result = (await postAuthJson(
        "/api/auth-accounts",
        "POST",
        { provider, ...(nextLabel ? { label: nextLabel } : {}) },
        `Failed to add ${name} account`,
      )) as { account?: AuthAccountSummary };
      if (!result.account) throw new Error(`Failed to add ${name} account`);
      return result.account;
    },
    ...errorHandlers,
    onSuccess: (account) => {
      setLabel("");
      signInMutation.mutate(account);
    },
    onSettled: () => void refresh(),
  });

  const readyCount = accounts.filter((account) => account.authenticated).length;
  const defaultId = pool?.defaultAccountId ?? null;
  const rotating = poolMutation.isPending && "autoRotate" in (poolMutation.variables ?? {});
  const busy =
    poolMutation.isPending ||
    removeMutation.isPending ||
    signInMutation.isPending ||
    addMutation.isPending;

  return (
    <section className="flex flex-col gap-1.5" data-testid={`auth-section-${provider}`}>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-1">
        <span className="uppercase text-[var(--color-text-secondary)]">{name} accounts</span>
        <span className="font-bold uppercase text-[var(--color-text-primary)]">
          {readyCount} ready
        </span>
      </div>
      <label className={`flex items-center gap-2 ${NOTE_CLASS} text-[var(--color-text-secondary)]`}>
        <input
          aria-busy={rotating || undefined}
          aria-label={`Auto-rotate ${name} accounts`}
          checked={pool?.autoRotate ?? false}
          className={CHECKBOX_CLASS}
          disabled={busy}
          type="checkbox"
          onChange={(event) => poolMutation.mutate({ autoRotate: event.target.checked })}
        />
        Auto-rotate on quota limit
        {rotating ? <Spinner className="h-3 w-3" strokeWidth={1.5} /> : null}
      </label>
      {accounts.length === 0 ? (
        <div className={`${NOTE_CLASS} text-[var(--color-text-tertiary)]`}>No {name} accounts.</div>
      ) : (
        <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
          {accounts.map((account) => {
            const accountLabel = authAccountName(account);
            const isDefault = account.id === defaultId;
            const limit = authLimitLabel(account, " · ");
            const confirming = confirmRemoveId === account.id;
            const removing = removeMutation.isPending && removeMutation.variables === account.id;
            return (
              <li
                key={account.id}
                className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 ${NOTE_CLASS}`}
                data-testid={`auth-account-${account.id}`}
              >
                <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-2">
                  <span className="truncate font-bold text-[var(--color-text-primary)]">
                    {accountLabel}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className={STATUS_COLOR[account.status]}>
                      {AUTH_STATUS_LABEL[account.status]}
                    </span>
                    {limit ? (
                      <span className="text-[var(--color-status-attention)]">{limit}</span>
                    ) : null}
                    {isDefault ? (
                      <span className="uppercase text-[var(--color-text-tertiary)]">default</span>
                    ) : null}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {confirming ? (
                    <>
                      <button
                        aria-busy={removing || undefined}
                        aria-label={
                          removing
                            ? "Removing account"
                            : `Confirm remove ${name} account ${accountLabel}`
                        }
                        className={DANGER_BUTTON_CLASS}
                        disabled={busy}
                        type="button"
                        onClick={() => removeMutation.mutate(account.id)}
                      >
                        <BusyContent busy={removing}>Confirm</BusyContent>
                      </button>
                      <button
                        className={SECONDARY_BUTTON_CLASS}
                        disabled={removing}
                        type="button"
                        onClick={() => setConfirmRemoveId(null)}
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      {account.authenticated ? (
                        <button
                          aria-label={`Make ${name} account ${accountLabel} default`}
                          className={SECONDARY_BUTTON_CLASS}
                          disabled={busy || isDefault}
                          type="button"
                          onClick={() => poolMutation.mutate({ defaultAccountId: account.id })}
                        >
                          Default
                        </button>
                      ) : (
                        <button
                          aria-label={`Sign in ${name} account ${accountLabel}`}
                          className={SECONDARY_BUTTON_CLASS}
                          disabled={busy}
                          type="button"
                          onClick={() => signInMutation.mutate(account)}
                        >
                          Sign in
                        </button>
                      )}
                      <button
                        aria-label={`Remove ${name} account ${accountLabel}`}
                        className={DANGER_BUTTON_CLASS}
                        disabled={busy}
                        type="button"
                        onClick={() => setConfirmRemoveId(account.id)}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </span>
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
      <div className="flex items-center gap-2">
        <input
          aria-label={`New ${name} account label`}
          className={`min-w-0 flex-1 ${NOTE_CLASS} ${INPUT_CLASS}`}
          disabled={busy}
          placeholder="Label (optional)"
          type="text"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <button
          aria-busy={addMutation.isPending || undefined}
          aria-label={addMutation.isPending ? "Adding account" : `Add ${name} account`}
          className={SECONDARY_BUTTON_CLASS}
          data-testid={`add-account-${provider}`}
          disabled={busy}
          type="button"
          onClick={() => addMutation.mutate(label.trim())}
        >
          <BusyContent busy={addMutation.isPending}>Add</BusyContent>
        </button>
      </div>
    </section>
  );
}

/** Footer menu over every managed provider account and its global pool. */
export function AuthAccountsMenu() {
  const popover = useFooterPopover();
  const [login, setLogin] = useState<LoginState | null>(null);
  const accountsQuery = useAuthAccounts(popover.open || login !== null);
  const closeLogin = useCallback(() => setLogin(null), []);

  return (
    <div
      ref={popover.containerRef}
      // Below sm the wrapper stays static, so the popover anchors to the
      // full-width footer instead of this trigger and stays on screen.
      className="sm:relative"
      onBlur={popover.onBlur}
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
                accounts={accountsQuery.data.accounts.filter(
                  (account) => account.provider === provider,
                )}
                pool={accountsQuery.data.pools[provider]}
                provider={provider}
                onSignIn={setLogin}
              />
            ))
          )}
        </div>
      ) : null}
      {login ? (
        <AuthLoginDialog account={login.account} login={login.login} onClose={closeLogin} />
      ) : null}
    </div>
  );
}
