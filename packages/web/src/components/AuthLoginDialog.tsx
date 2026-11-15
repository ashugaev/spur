"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BusyContent } from "@/components/BusyContent";
import { IconCloseButton } from "@/components/IconCloseButton";
import {
  AUTH_ACCOUNTS_QUERY_KEY,
  authAccountName,
  isAuthLogin,
  postAuthJson,
} from "@/lib/auth-accounts";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import { getAgentDisplayName } from "@/lib/agents";
import type { AuthAccountSummary, AuthLogin } from "@/lib/types";

const LOGIN_POLL_INTERVAL_MS = 3_000;

interface AuthLoginDialogProps {
  account: Pick<AuthAccountSummary, "id" | "label" | "provider">;
  login: AuthLogin;
  onClose: () => void;
}

const BUTTON_CLASS =
  "border border-[var(--color-border-default)] px-3 py-1 font-bold uppercase text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50";

export function AuthLoginDialog({ account, login: initialLogin, onClose }: AuthLoginDialogProps) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const loginPath = `/api/auth-accounts/${encodeURIComponent(account.id)}`;

  const statusQuery = useQuery<AuthLogin>({
    queryKey: ["auth-account-login", account.id],
    queryFn: async ({ signal }) => {
      const response = await fetch(`${loginPath}/login-status`, { signal });
      const payload = await readResponsePayload(response);
      if (!response.ok || !isAuthLogin(payload)) {
        throw new Error(responseErrorMessage(payload, "Failed to read sign-in status"));
      }
      return payload;
    },
    initialData: initialLogin,
    refetchInterval: (query) =>
      query.state.data?.status === "ready" || query.state.data?.status === "failed"
        ? false
        : LOGIN_POLL_INTERVAL_MS,
  });
  const login = statusQuery.data;

  const inputMutation = useMutation<unknown, Error, { input: string } | { cancel: true }>({
    mutationFn: (body) =>
      postAuthJson(`${loginPath}/login-input`, "POST", body, "Failed to submit sign-in input"),
    onSuccess: (result, body) => {
      if ("cancel" in body) {
        onClose();
        return;
      }
      setCode("");
      if (isAuthLogin(result)) queryClient.setQueryData(["auth-account-login", account.id], result);
    },
  });

  const ready = login.status === "ready";
  useEffect(() => {
    if (!ready) return;
    void queryClient.invalidateQueries({ queryKey: AUTH_ACCOUNTS_QUERY_KEY });
    onClose();
  }, [ready, queryClient, onClose]);

  const errorText = inputMutation.error?.message ?? login.error ?? null;
  const busy = inputMutation.isPending;

  return (
    <div
      aria-labelledby="auth-login-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      role="dialog"
    >
      <div className="w-[min(26rem,calc(100vw-2rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4 shadow-[0_8px_24px_var(--color-shadow-modal-sm)]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-bold text-[var(--color-text-primary)]" id="auth-login-dialog-title">
            Sign in {getAgentDisplayName(account.provider)} · {authAccountName(account)}
          </h2>
          <IconCloseButton label="Close sign-in" onClick={onClose} disabled={busy} />
        </div>
        <div className="flex flex-col gap-2 normal-case tracking-normal text-[var(--color-text-secondary)]">
          {login.url ? (
            <a
              className="break-all text-[var(--color-accent)] underline"
              data-testid="auth-login-url"
              href={login.url}
              rel="noreferrer"
              target="_blank"
            >
              {login.url}
            </a>
          ) : null}
          {login.userCode ? (
            <div>
              Code{" "}
              <span
                className="font-mono font-bold text-[var(--color-text-primary)]"
                data-testid="auth-login-user-code"
              >
                {login.userCode}
              </span>
            </div>
          ) : null}
          {login.prompt ? <div>{login.prompt}</div> : null}
          {!login.url && !login.userCode && !login.prompt && login.status === "pending" ? (
            <div>Waiting for sign-in…</div>
          ) : null}
          {errorText ? (
            <div className="text-[var(--color-status-error)]" data-testid="auth-login-error">
              {errorText}
            </div>
          ) : null}
        </div>
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const input = code.trim();
            if (input) inputMutation.mutate({ input });
          }}
        >
          <input
            aria-label="Authorization code"
            className="min-w-0 flex-1 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 normal-case tracking-normal text-[var(--color-text-primary)] outline-none focus-visible:border-[var(--color-accent)]"
            disabled={busy}
            placeholder="Paste code if asked"
            type="text"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <button className={BUTTON_CLASS} disabled={busy || !code.trim()} type="submit">
            <BusyContent busy={busy}>Submit</BusyContent>
          </button>
          <button
            className={BUTTON_CLASS}
            disabled={busy}
            type="button"
            onClick={() => inputMutation.mutate({ cancel: true })}
          >
            Cancel
          </button>
        </form>
      </div>
    </div>
  );
}
