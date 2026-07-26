"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFooterPopover } from "@/lib/footer-popover";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import { AccountsIcon } from "@/components/icons/AccountsIcon";
import { getAgentDisplayName } from "@/lib/agents";
import type { ClaudeAccountSummary } from "@/lib/types";

interface AccountsResponse {
  accounts: ClaudeAccountSummary[];
}

interface AccountResult {
  account: ClaudeAccountSummary;
}

function isAccountsResponse(value: unknown): value is AccountsResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { accounts?: unknown }).accounts)
  );
}

function isAccountResult(value: unknown): value is AccountResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { account?: unknown }).account === "object" &&
    (value as { account?: unknown }).account !== null
  );
}

function accountName(account: ClaudeAccountSummary): string {
  return account.label?.trim() || account.id.slice(0, 8);
}

export function ClaudeAccountsMenu() {
  const popover = useFooterPopover();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [enrollId, setEnrollId] = useState<string | null>(null);

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
    enabled: popover.open,
    staleTime: 30_000,
  });

  const refreshAccounts = () => queryClient.invalidateQueries({ queryKey: ["claude-accounts"] });

  const enrollMutation = useMutation<
    AccountResult,
    Error,
    { id: string | null; label: string; setupToken: string }
  >({
    mutationFn: async (input) => {
      const path = input.id
        ? `/api/claude-accounts/${encodeURIComponent(input.id)}/enroll`
        : "/api/claude-accounts/add";
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(input.id ? {} : { label: input.label }),
          setupToken: input.setupToken,
        }),
      });
      const payload = await readResponsePayload(response);
      if (!response.ok || !isAccountResult(payload)) {
        throw new Error(responseErrorMessage(payload, "Failed to enroll Claude account"));
      }
      return payload;
    },
    onSuccess: () => {
      setLabel("");
      setSetupToken("");
      setEnrollId(null);
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
    onSuccess: () => void refreshAccounts(),
  });

  const accounts = accountsQuery.data?.accounts ?? [];
  const readyCount = accounts.filter((account) => account.status === "ready").length;
  const error = enrollMutation.error?.message ?? removeMutation.error?.message ?? null;

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
        title="Manage Claude accounts"
        type="button"
        onClick={popover.toggle}
      >
        <AccountsIcon className="h-4 w-4" />
      </button>
      {popover.open ? (
        <div className="absolute bottom-full right-0 z-50 mb-1.5 w-[min(28rem,calc(100vw-1rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]">
          <div className="mb-2 flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-2">
            <span className="text-[var(--color-text-secondary)]">
              {getAgentDisplayName("claude")} accounts
            </span>
            <span className="font-bold text-[var(--color-text-primary)]">{readyCount} ready</span>
          </div>
          {accounts.length > 0 ? (
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
                        account.status === "ready"
                          ? "text-[var(--color-status-ready)]"
                          : "text-[var(--color-status-attention)]"
                      }
                    >
                      {account.status}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {account.status !== "ready" ? (
                      <button
                        className="border border-[var(--color-border-default)] px-1.5 py-0.5 font-bold text-[var(--color-text-secondary)]"
                        type="button"
                        onClick={() => setEnrollId(account.id)}
                      >
                        Re-enroll
                      </button>
                    ) : null}
                    <button
                      aria-label={`Remove Claude account ${accountName(account)}`}
                      className="border border-[var(--color-border-default)] px-1.5 py-0.5 font-bold text-[var(--color-status-error)] disabled:opacity-50"
                      disabled={removeMutation.isPending}
                      type="button"
                      onClick={() => removeMutation.mutate(account.id)}
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-2 normal-case tracking-normal text-[var(--color-text-secondary)]">
              No enrolled accounts.
            </p>
          )}
          <div className="border-t border-[var(--color-border-subtle)] pt-2">
            <p className="mb-2 normal-case tracking-normal text-[var(--color-text-secondary)]">
              Run <code>claude setup-token</code> in a trusted terminal, then paste the token.
              Enrollment makes one validation request. Tokens last about one year and support
              inference only: no Remote Control, connectors, or bare mode. Spur cannot verify the
              organization. Processes under the same Unix user can inspect process environment.
            </p>
            {!enrollId ? (
              <input
                aria-label="New Claude account label"
                className="mb-2 w-full border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 normal-case tracking-normal text-[var(--color-text-primary)] outline-none focus-visible:border-[var(--color-accent)]"
                disabled={enrollMutation.isPending}
                placeholder="Label (optional)"
                type="text"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            ) : null}
            <div className="flex gap-2">
              <input
                aria-label="Claude setup token"
                autoComplete="off"
                className="min-w-0 flex-1 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 normal-case tracking-normal text-[var(--color-text-primary)] outline-none focus-visible:border-[var(--color-accent)]"
                disabled={enrollMutation.isPending}
                placeholder="Setup token"
                type="password"
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
              />
              <button
                className="border border-[var(--color-border-default)] px-2 py-1 font-bold text-[var(--color-text-secondary)] disabled:opacity-50"
                data-testid="add-account"
                disabled={enrollMutation.isPending || !setupToken.trim()}
                type="button"
                onClick={() =>
                  enrollMutation.mutate({
                    id: enrollId,
                    label: label.trim(),
                    setupToken: setupToken.trim(),
                  })
                }
              >
                {enrollMutation.isPending ? "Validating…" : enrollId ? "Re-enroll" : "Enroll"}
              </button>
              {enrollId ? (
                <button type="button" onClick={() => setEnrollId(null)}>
                  Cancel
                </button>
              ) : null}
            </div>
          </div>
          {error ? (
            <p className="mt-2 normal-case tracking-normal text-[var(--color-status-error)]">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
