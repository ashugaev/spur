"use client";

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFooterPopover } from "@/lib/footer-popover";
import { AccountsIcon } from "@/components/icons/AccountsIcon";
import { AuthLoginDialog } from "@/components/AuthLoginDialog";
import { BusyContent } from "@/components/BusyContent";
import { getAgentDisplayName } from "@/lib/agents";
import {
  AUTH_ACCOUNTS_QUERY_KEY,
  AUTH_PROVIDERS,
  AUTH_STATUS_LABEL,
  authAccountName,
  isAuthLogin,
  postAuthJson,
  useAuthAccounts,
} from "@/lib/auth-accounts";
import type { AuthAccountSummary, AuthLogin, AuthPool, AuthProvider } from "@/lib/types";

interface LoginState {
  account: AuthAccountSummary;
  login: AuthLogin;
}

const SMALL_BUTTON_CLASS =
  "border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10px] font-bold uppercase outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const STATUS_COLOR: Record<AuthAccountSummary["status"], string> = {
  ready: "text-[var(--color-status-ready)]",
  sign_in_required: "text-[var(--color-status-attention)]",
  pending: "text-[var(--color-status-attention)]",
  error: "text-[var(--color-status-error)]",
};

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
  const name = getAgentDisplayName(provider);
  const refresh = () => queryClient.invalidateQueries({ queryKey: AUTH_ACCOUNTS_QUERY_KEY });

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
    onSettled: () => void refresh(),
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
    onSuccess: (account) => {
      setLabel("");
      signInMutation.mutate(account);
    },
    onSettled: () => void refresh(),
  });

  const readyCount = accounts.filter((account) => account.authenticated).length;
  const defaultId = pool?.defaultAccountId ?? null;
  const error =
    poolMutation.error ?? removeMutation.error ?? signInMutation.error ?? addMutation.error;
  const busy =
    poolMutation.isPending ||
    removeMutation.isPending ||
    signInMutation.isPending ||
    addMutation.isPending;

  return (
    <section className="flex flex-col gap-1.5" data-testid={`auth-section-${provider}`}>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-1">
        <span className="text-[var(--color-text-secondary)]">{name} accounts</span>
        <span className="font-bold text-[var(--color-text-primary)]">{readyCount} ready</span>
      </div>
      <label className="flex items-center gap-2 normal-case tracking-normal text-[var(--color-text-secondary)]">
        <input
          aria-label={`Auto-rotate ${name} accounts`}
          checked={pool?.autoRotate ?? false}
          className="accent-[var(--color-accent)]"
          disabled={busy}
          type="checkbox"
          onChange={(event) => poolMutation.mutate({ autoRotate: event.target.checked })}
        />
        Auto-rotate on quota limit
      </label>
      {accounts.length === 0 ? (
        <div className="normal-case tracking-normal text-[var(--color-text-tertiary)]">
          No {name} accounts.
        </div>
      ) : (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {accounts.map((account) => {
            const accountLabel = authAccountName(account);
            const isDefault = account.id === defaultId;
            return (
              <li
                key={account.id}
                className="flex items-center justify-between gap-2 normal-case tracking-normal"
                data-testid={`auth-account-${account.id}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-bold text-[var(--color-text-primary)]">
                    {accountLabel}
                  </span>
                  <span className={STATUS_COLOR[account.status]}>
                    {AUTH_STATUS_LABEL[account.status]}
                  </span>
                  {isDefault ? (
                    <span className="uppercase text-[var(--color-text-tertiary)]">default</span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {account.authenticated ? (
                    <button
                      aria-label={`Make ${name} account ${accountLabel} default`}
                      className={`${SMALL_BUTTON_CLASS} text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]`}
                      disabled={busy || isDefault}
                      type="button"
                      onClick={() => poolMutation.mutate({ defaultAccountId: account.id })}
                    >
                      Default
                    </button>
                  ) : (
                    <button
                      aria-label={`Sign in ${name} account ${accountLabel}`}
                      className={`${SMALL_BUTTON_CLASS} text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]`}
                      disabled={busy}
                      type="button"
                      onClick={() => signInMutation.mutate(account)}
                    >
                      Sign in
                    </button>
                  )}
                  <button
                    aria-label={`Remove ${name} account ${accountLabel}`}
                    className={`${SMALL_BUTTON_CLASS} text-[var(--color-status-error)] hover:bg-[var(--color-status-error)] hover:text-[var(--color-bg-elevated)]`}
                    disabled={busy}
                    type="button"
                    onClick={() => removeMutation.mutate(account.id)}
                  >
                    Remove
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <div className="normal-case tracking-normal text-[var(--color-status-error)]">
          {error.message}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          aria-label={`New ${name} account label`}
          className="min-w-0 flex-1 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 normal-case tracking-normal text-[var(--color-text-primary)] outline-none focus-visible:border-[var(--color-accent)]"
          disabled={busy}
          placeholder="Label (optional)"
          type="text"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <button
          aria-busy={addMutation.isPending || undefined}
          aria-label={addMutation.isPending ? "Adding account" : `Add ${name} account`}
          className="border border-[var(--color-border-default)] px-2 py-1 font-bold uppercase text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
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
  const accounts = accountsQuery.data?.accounts ?? [];
  const pools = accountsQuery.data?.pools ?? {};

  return (
    <div
      ref={popover.containerRef}
      className="relative"
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
        <div className="absolute bottom-full right-0 z-50 mb-1.5 flex max-h-[70vh] w-[min(26rem,calc(100vw-1rem))] flex-col gap-3 overflow-y-auto border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]">
          {accountsQuery.isError ? (
            <div className="normal-case tracking-normal text-[var(--color-status-error)]">
              {accountsQuery.error.message}
            </div>
          ) : null}
          {AUTH_PROVIDERS.map((provider) => (
            <ProviderSection
              key={provider}
              accounts={accounts.filter((account) => account.provider === provider)}
              pool={pools[provider]}
              provider={provider}
              onSignIn={setLogin}
            />
          ))}
        </div>
      ) : null}
      {login ? (
        <AuthLoginDialog account={login.account} login={login.login} onClose={closeLogin} />
      ) : null}
    </div>
  );
}
