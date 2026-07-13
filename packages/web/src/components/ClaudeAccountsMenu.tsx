"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFooterPopover } from "@/lib/footer-popover";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import { TerminalModal } from "@/components/TerminalModal";
import type { ClaudeAccountSummary, DashboardSession } from "@/lib/types";

const LOGIN_POLL_INTERVAL_MS = 3_000;

interface AccountsResponse {
  accounts: ClaudeAccountSummary[];
}

interface AddAccountResult {
  account: ClaudeAccountSummary;
  loginTmuxSession: string;
}

interface LoginStatusResult {
  authenticated: boolean;
  loginActive: boolean;
}

interface LoginState {
  account: ClaudeAccountSummary;
  tmuxSession: string;
}

function isAccountsResponse(value: unknown): value is AccountsResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { accounts?: unknown }).accounts)
  );
}

function isAddAccountResult(value: unknown): value is AddAccountResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { account?: unknown; loginTmuxSession?: unknown };
  return (
    typeof record.loginTmuxSession === "string" &&
    typeof record.account === "object" &&
    record.account !== null
  );
}

function isLoginStatusResult(value: unknown): value is LoginStatusResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { authenticated?: unknown; loginActive?: unknown };
  return typeof record.authenticated === "boolean" && typeof record.loginActive === "boolean";
}

function accountName(account: ClaudeAccountSummary): string {
  return account.label?.trim() || account.id.slice(0, 8);
}

// A synthetic session so TerminalModal can attach to the login tmux pane. The
// override drives the terminal; the rest is filler for the shared component.
function buildLoginSession(account: ClaudeAccountSummary, tmuxSession: string): DashboardSession {
  return {
    id: `claude-login-${account.id}`,
    projectId: "",
    projectName: "Claude login",
    agent: "claude",
    title: accountName(account),
    prompt: "",
    originalTaskPrompt: null,
    startupAttachmentIds: [],
    branch: null,
    worktree: false,
    tmuxSession,
    status: "running",
    state: "working",
    createdAt: "",
    updatedAt: "",
    lastActivityAt: "",
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: "",
    services: [],
    artifacts: [],
    queuedMessages: { messages: [], awaitingPrompt: false },
    sidecars: [],
    runningSidecars: [],
    links: [],
    tags: [],
    hasServiceIssues: false,
    deskKey: "",
  };
}

export function ClaudeAccountsMenu() {
  const popover = useFooterPopover();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [login, setLogin] = useState<LoginState | null>(null);

  const accountsQuery = useQuery<AccountsResponse>({
    queryKey: ["claude-accounts"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/claude-accounts", { signal });
      const payload = await readResponsePayload(response);
      if (!response.ok || !isAccountsResponse(payload)) {
        throw new Error(responseErrorMessage(payload, "Failed to list Claude accounts"));
      }
      return payload;
    },
    enabled: popover.open || login !== null,
    staleTime: 30_000,
  });

  const refreshAccounts = () => queryClient.invalidateQueries({ queryKey: ["claude-accounts"] });

  const addMutation = useMutation<AddAccountResult, Error, string>({
    mutationFn: async (nextLabel) => {
      const response = await fetch("/api/claude-accounts/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(nextLabel ? { label: nextLabel } : {}),
      });
      const payload = await readResponsePayload(response);
      if (response.status !== 201 || !isAddAccountResult(payload)) {
        throw new Error(responseErrorMessage(payload, "Failed to add Claude account"));
      }
      return payload;
    },
    onSuccess: (result) => {
      setLabel("");
      setLogin({ account: result.account, tmuxSession: result.loginTmuxSession });
      void refreshAccounts();
    },
  });

  const finishMutation = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/claude-accounts/${encodeURIComponent(id)}/finish-login`, {
        method: "POST",
      });
    },
    onSettled: () => {
      setLogin(null);
      void refreshAccounts();
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch("/api/claude-accounts/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) {
        const payload = await readResponsePayload(response);
        throw new Error(responseErrorMessage(payload, "Failed to remove Claude account"));
      }
    },
    onSuccess: () => {
      void refreshAccounts();
    },
  });

  // Poll the pending login until the account authenticates, then auto-close.
  const loginStatusQuery = useQuery<LoginStatusResult>({
    queryKey: ["claude-account-login", login?.account.id],
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `/api/claude-accounts/${encodeURIComponent(login?.account.id ?? "")}/login-status`,
        { signal },
      );
      const payload = await readResponsePayload(response);
      if (!response.ok || !isLoginStatusResult(payload)) {
        throw new Error(responseErrorMessage(payload, "Failed to read login status"));
      }
      return payload;
    },
    enabled: login !== null,
    refetchInterval: LOGIN_POLL_INTERVAL_MS,
  });

  const loginAuthenticated = loginStatusQuery.data?.authenticated === true;
  useEffect(() => {
    // Route auto-close through finishMutation (same as manual close) so the
    // claude-login-{id} tmux pane is killed; onSettled clears login + refreshes.
    if (login && loginAuthenticated && !finishMutation.isPending) {
      finishMutation.mutate(login.account.id);
    }
  }, [login, loginAuthenticated, finishMutation]);

  const accounts = accountsQuery.data?.accounts ?? [];
  const authenticatedCount = accounts.filter((account) => account.authenticated).length;

  const addError = addMutation.error?.message ?? null;
  const removeError = removeMutation.error?.message ?? null;

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
        aria-label="Manage Claude accounts"
        className="-m-1.5 flex items-center gap-1.5 p-1.5 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
        data-testid="claude-accounts-trigger"
        type="button"
        onClick={popover.toggle}
      >
        <span>Claude accounts</span>
        <span className="font-bold text-[var(--color-text-primary)]">{authenticatedCount}</span>
      </button>
      {popover.open ? (
        <div className="absolute bottom-full right-0 z-50 mb-1.5 w-[min(22rem,calc(100vw-1rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]">
          <div className="mb-2 flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-2">
            <span className="text-[var(--color-text-secondary)]">Claude accounts</span>
            <span className="font-bold text-[var(--color-text-primary)]">
              {authenticatedCount} ready
            </span>
          </div>
          {accounts.length === 0 ? (
            <div className="mb-2 normal-case tracking-normal text-[var(--color-text-secondary)]">
              {accountsQuery.isError
                ? (accountsQuery.error as Error).message
                : "No accounts yet. Add one to log in."}
            </div>
          ) : (
            <ul className="mb-2 flex max-h-48 flex-col gap-1 overflow-y-auto">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className="flex items-center justify-between gap-3 normal-case tracking-normal"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-bold text-[var(--color-text-primary)]">
                      {accountName(account)}
                    </span>
                    <span
                      className={
                        account.authenticated
                          ? "text-[var(--color-status-ready)]"
                          : "text-[var(--color-status-attention)]"
                      }
                    >
                      {account.authenticated ? "ready" : "not logged in"}
                    </span>
                  </span>
                  <button
                    aria-label={`Remove Claude account ${accountName(account)}`}
                    className="border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-status-error)] outline-none transition-colors hover:bg-[var(--color-status-error)] hover:text-[var(--color-bg-elevated)] focus-visible:bg-[var(--color-status-error)] focus-visible:text-[var(--color-bg-elevated)] disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid={`remove-account-${account.id}`}
                    disabled={removeMutation.isPending}
                    type="button"
                    onClick={() => removeMutation.mutate(account.id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {removeError ? (
            <div className="mb-2 normal-case tracking-normal text-[var(--color-status-error)]">
              {removeError}
            </div>
          ) : null}
          <div className="flex items-center gap-2 border-t border-[var(--color-border-subtle)] pt-2">
            <input
              aria-label="New Claude account label"
              className="min-w-0 flex-1 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 normal-case tracking-normal text-[var(--color-text-primary)] outline-none focus-visible:border-[var(--color-accent)]"
              disabled={addMutation.isPending}
              placeholder="Label (optional)"
              type="text"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <button
              className="border border-[var(--color-border-default)] px-2 py-1 font-bold text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="add-account"
              disabled={addMutation.isPending}
              type="button"
              onClick={() => addMutation.mutate(label.trim())}
            >
              {addMutation.isPending ? "Adding…" : "Add account"}
            </button>
          </div>
          {addError ? (
            <div className="mt-2 normal-case tracking-normal text-[var(--color-status-error)]">
              {addError}
            </div>
          ) : null}
        </div>
      ) : null}
      {login ? (
        <TerminalModal
          session={buildLoginSession(login.account, login.tmuxSession)}
          titleSuffix="Login — run /login, then complete browser auth"
          tmuxSessionOverride={login.tmuxSession}
          onClose={() => finishMutation.mutate(login.account.id)}
        />
      ) : null}
    </div>
  );
}
