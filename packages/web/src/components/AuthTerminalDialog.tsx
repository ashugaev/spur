"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SignInAccount } from "@/components/AuthLoginDialog";
import { BusyContent } from "@/components/BusyContent";
import { CheckIcon } from "@/components/icons/CheckIcon";
import { DirectTerminal } from "@/components/DirectTerminal";
import { WaitLine } from "@/components/AuthLoginParts";
import { IconCloseButton } from "@/components/IconCloseButton";
import { PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from "@/design/classes";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
  accountIdentityLine,
  authProviderName,
  invalidateAuthQueries,
  isTerminalLogin,
  postAuthJson,
  useAuthAccounts,
} from "@/lib/auth-accounts";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import type { AuthProvider, TerminalLogin, TerminalLoginReason } from "@/lib/types";

const TERMINAL_POLL_INTERVAL_MS = 2_000;

const NOT_SIGNED_IN_NOTE: Partial<Record<TerminalLoginReason, string>> = {
  exited: "Terminal exited. Account still signed out.",
  timed_out: "Terminal timed out. Account still signed out.",
  stopped: "Terminal closed. Account still signed out.",
  identity: "The signed-in account could not be identified. Account still signed out.",
  not_confirmed: "The test request failed. Account still signed out.",
  failed: "Sign-in failed. Account still signed out.",
};

const RUNNING_NOTE: Partial<Record<TerminalLoginReason, string>> = {
  another_sign_in_pending: "Another sign-in is pending. Waiting for it to finish.",
  companion_unavailable: "Auth proxy unavailable. Retrying.",
};

type PollResult = TerminalLogin | "gone";

interface AuthTerminalDialogProps {
  target: { accountId: string } | { host: AuthProvider };
  provider: AuthProvider;
  /** The account being signed in; absent for the daemon user's own (host) credentials. */
  account?: SignInAccount;
  onClose: () => void;
}

/** Native CLI sign-in in a daemon terminal; success shows only on a verified `ready`. */
export function AuthTerminalDialog({
  target,
  provider,
  account,
  onClose,
}: AuthTerminalDialogProps) {
  const queryClient = useQueryClient();
  const accountsQuery = useAuthAccounts(account !== undefined);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const startedOnMount = useRef(false);
  const closedRef = useRef(false);
  // Plain state, not a mutation: a mutation observer detaches when StrictMode replays the mount effect.
  const [started, setStarted] = useState<TerminalLogin | undefined>(undefined);
  const [startError, setStartError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const terminalId = started?.id;

  const start = useCallback(async () => {
    setRestarting(true);
    setStartError(null);
    try {
      const result = await postAuthJson(
        "/api/auth-terminal-logins",
        "POST",
        target,
        "Failed to start terminal sign-in",
      );
      if (!isTerminalLogin(result)) throw new Error("Failed to start terminal sign-in");
      if (closedRef.current) {
        // Closed while the start was in flight: stop the terminal it just created.
        await postAuthJson(
          `/api/auth-terminal-logins/${encodeURIComponent(result.id)}`,
          "DELETE",
          undefined,
          "Failed to stop terminal sign-in",
        );
        return;
      }
      // A restart reuses the id: seed the new state so the settled poll resumes.
      queryClient.setQueryData(["auth-terminal-login", result.id], result);
      setStarted(result);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Failed to start terminal sign-in");
    } finally {
      setRestarting(false);
      void invalidateAuthQueries(queryClient);
    }
  }, [target, queryClient]);

  const statusQuery = useQuery<PollResult>({
    queryKey: ["auth-terminal-login", terminalId],
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `/api/auth-terminal-logins/${encodeURIComponent(terminalId ?? "")}`,
        {
          signal,
        },
      );
      // The daemon forgets terminal logins on restart.
      if (response.status === 404) return "gone";
      const payload = await readResponsePayload(response);
      if (!response.ok || !isTerminalLogin(payload)) {
        throw new Error(responseErrorMessage(payload, "Failed to read terminal sign-in"));
      }
      return payload;
    },
    enabled: terminalId !== undefined,
    staleTime: TERMINAL_POLL_INTERVAL_MS,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data === "gone" || data?.status === "ready" || data?.status === "not_signed_in"
        ? false
        : TERMINAL_POLL_INTERVAL_MS;
    },
  });

  // Restart posts the same target again; the daemon restarts that terminal.
  useEffect(() => {
    if (startedOnMount.current) return;
    startedOnMount.current = true;
    void start();
  }, [start]);

  const stopMutation = useMutation<unknown, Error>({
    mutationFn: () =>
      postAuthJson(
        `/api/auth-terminal-logins/${encodeURIComponent(terminalId ?? "")}`,
        "DELETE",
        undefined,
        "Failed to stop terminal sign-in",
      ),
    // A terminal the daemon already ended, or forgot, still closes the dialog.
    onSettled: () => {
      void invalidateAuthQueries(queryClient);
      onClose();
    },
  });

  const polled = statusQuery.data;
  const login = polled === "gone" ? undefined : (polled ?? started);
  const status = login?.status;
  const ended = !restarting && (polled === "gone" || status === "not_signed_in");

  useEffect(() => {
    if (status === "ready") void invalidateAuthQueries(queryClient);
  }, [status, queryClient]);

  const closing = stopMutation.isPending;
  const close = () => {
    // Any start or restart still in flight stops its terminal when it resolves.
    closedRef.current = true;
    if (terminalId) {
      stopMutation.mutate();
      return;
    }
    onClose();
  };
  useDialogFocus({ panelRef, initialRef: closeRef, onEscape: close, escapeBlocked: closing });

  const running = status === "running" && !ended && !restarting;
  const name = authProviderName(provider);
  // The refetched account carries the identity a first sign-in just produced.
  const current = accountsQuery.data?.accounts.find((entry) => entry.id === account?.id) ?? account;
  const identityLine = !current
    ? `${name} host`
    : current.identity || current.credential
      ? accountIdentityLine(current)
      : current.displayName;

  return (
    <div
      aria-labelledby="auth-terminal-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      role="dialog"
    >
      <div
        ref={panelRef}
        className={`max-h-[calc(100dvh-2rem)] overflow-y-auto border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4 shadow-[0_8px_24px_var(--color-shadow-modal-sm)] ${
          running || restarting
            ? "w-[min(44rem,calc(100vw-2rem))]"
            : "w-[min(28rem,calc(100vw-2rem))]"
        }`}
      >
        <div className="mb-2 flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="uppercase text-[var(--color-text-secondary)]">
              Sign in · {name} · terminal
            </span>
            <h2
              className="truncate font-bold normal-case tracking-normal text-[var(--color-text-primary)]"
              id="auth-terminal-dialog-title"
              title={identityLine}
            >
              {identityLine}
            </h2>
          </div>
          <IconCloseButton
            disabled={closing}
            idleTextClass="text-[var(--color-text-secondary)]"
            label="Close terminal sign-in"
            onClick={close}
          />
        </div>

        {running && login ? (
          <p className="mb-2 normal-case tracking-normal text-[var(--color-text-secondary)]">
            Finish sign-in in the terminal. Success shows after Spur verifies the account.
          </p>
        ) : null}

        {running && login ? (
          <div className="mb-2.5 h-[min(24rem,55dvh)] border border-[var(--color-border-default)] bg-[var(--color-terminal-bg)]">
            <DirectTerminal
              agent={provider}
              agentInputEnabled={false}
              hideHeader
              keyBar
              sessionId={login.tmuxSession}
            />
          </div>
        ) : null}

        <div className="mt-1 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div
            aria-live="polite"
            className="flex min-w-0 flex-1 basis-56 items-start gap-2 py-1 normal-case tracking-normal text-[var(--color-text-secondary)] [overflow-wrap:anywhere]"
            data-testid="auth-terminal-status"
            role="status"
          >
            {startError !== null ? (
              <span className="text-[var(--color-status-error)]">{startError}</span>
            ) : restarting ? (
              <WaitLine live={false}>Opening terminal…</WaitLine>
            ) : status === "ready" ? (
              <span className="flex min-w-0 items-center gap-2 font-bold text-[var(--color-status-ready)]">
                <CheckIcon className="h-3 w-3 shrink-0" />
                <span className="truncate" title={identityLine}>
                  Signed in as {identityLine}
                </span>
              </span>
            ) : ended ? (
              <>
                <span
                  aria-hidden="true"
                  className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--color-text-secondary)]"
                />
                <span>
                  <span className="font-bold text-[var(--color-text-primary)]">Not signed in</span>
                  <br />
                  {(login?.reason && NOT_SIGNED_IN_NOTE[login.reason]) ??
                    "Terminal ended. Account still signed out."}
                </span>
              </>
            ) : status === "verifying" ? (
              <WaitLine live={false}>Verifying sign-in…</WaitLine>
            ) : (
              <span className="flex flex-col gap-1">
                <WaitLine live={false}>
                  {login ? "Waiting for sign-in…" : "Opening terminal…"}
                </WaitLine>
                {login?.reason && RUNNING_NOTE[login.reason] ? (
                  <span>{RUNNING_NOTE[login.reason]}</span>
                ) : null}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {status === "ready" ? (
              <button
                ref={closeRef}
                className={PRIMARY_BUTTON_CLASS}
                disabled={closing}
                type="button"
                onClick={close}
              >
                Done
              </button>
            ) : (
              <>
                <button
                  ref={closeRef}
                  className={SECONDARY_BUTTON_CLASS}
                  disabled={closing}
                  type="button"
                  onClick={close}
                >
                  Close
                </button>
                {ended || startError !== null ? (
                  <button
                    className={PRIMARY_BUTTON_CLASS}
                    disabled={closing || restarting}
                    type="button"
                    onClick={() => void start()}
                  >
                    <BusyContent busy={restarting}>Restart terminal</BusyContent>
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
