"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BusyContent } from "@/components/BusyContent";
import { IconCloseButton } from "@/components/IconCloseButton";
import { INPUT_CLASS, SECONDARY_BUTTON_CLASS } from "@/design/classes";
import { useDialogFocus } from "@/hooks/useDialogFocus";
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

type LoginAction = { input: string } | { cancel: true } | { retry: true };

export function AuthLoginDialog({ account, login: initialLogin, onClose }: AuthLoginDialogProps) {
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const [code, setCode] = useState("");
  const loginPath = `/api/auth-accounts/${encodeURIComponent(account.id)}`;
  const loginKey = ["auth-account-login", account.id];

  const statusQuery = useQuery<AuthLogin>({
    queryKey: loginKey,
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

  const actionMutation = useMutation<unknown, Error, LoginAction>({
    mutationFn: (action) =>
      "retry" in action
        ? postAuthJson(`${loginPath}/login`, "POST", undefined, "Failed to start sign-in")
        : postAuthJson(
            `${loginPath}/login-input`,
            "POST",
            action,
            "Failed to submit sign-in input",
          ),
    onSuccess: (result, action) => {
      if ("cancel" in action) {
        onClose();
        return;
      }
      setCode("");
      if (isAuthLogin(result)) queryClient.setQueryData(loginKey, result);
    },
  });

  const ready = login.status === "ready";
  useEffect(() => {
    if (!ready) return;
    void queryClient.invalidateQueries({ queryKey: AUTH_ACCOUNTS_QUERY_KEY });
    onClose();
  }, [ready, queryClient, onClose]);

  const busy = actionMutation.isPending;
  // Every dismissal cancels the unfinished sign-in.
  const dismiss = () => actionMutation.mutate({ cancel: true });
  useDialogFocus({ panelRef, initialRef: codeRef, onEscape: dismiss, escapeBlocked: busy });

  const failed = login.status === "failed";
  const errorText =
    actionMutation.error?.message ?? login.error ?? (failed ? "Sign-in failed" : null);

  return (
    <div
      aria-labelledby="auth-login-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      role="dialog"
    >
      <div
        ref={panelRef}
        className="w-[min(26rem,calc(100vw-2rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4 shadow-[0_8px_24px_var(--color-shadow-modal-sm)]"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2
            className="font-bold uppercase text-[var(--color-text-primary)]"
            id="auth-login-dialog-title"
          >
            Sign in {getAgentDisplayName(account.provider)} · {authAccountName(account)}
          </h2>
          <IconCloseButton label="Close sign-in" onClick={dismiss} disabled={busy} />
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
            <div
              className="text-[var(--color-status-error)]"
              data-testid="auth-login-error"
              role="alert"
            >
              {errorText}
            </div>
          ) : null}
        </div>
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const input = code.trim();
            if (input) actionMutation.mutate({ input });
          }}
        >
          <input
            ref={codeRef}
            aria-label="Authorization code"
            className={`min-w-0 flex-1 normal-case tracking-normal ${INPUT_CLASS}`}
            disabled={busy}
            placeholder="Paste code if asked"
            type="text"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          {failed ? (
            <button
              className={SECONDARY_BUTTON_CLASS}
              disabled={busy}
              type="button"
              onClick={() => actionMutation.mutate({ retry: true })}
            >
              <BusyContent busy={busy}>Retry</BusyContent>
            </button>
          ) : (
            <button
              className={SECONDARY_BUTTON_CLASS}
              disabled={busy || !code.trim()}
              type="submit"
            >
              <BusyContent busy={busy}>Submit</BusyContent>
            </button>
          )}
          <button
            className={SECONDARY_BUTTON_CLASS}
            disabled={busy}
            type="button"
            onClick={dismiss}
          >
            Cancel
          </button>
        </form>
      </div>
    </div>
  );
}
