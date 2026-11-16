"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BusyContent } from "@/components/BusyContent";
import { DirectTerminal } from "@/components/DirectTerminal";
import { WaitLine } from "@/components/AuthLoginParts";
import { IconCloseButton } from "@/components/IconCloseButton";
import { PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from "@/design/classes";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { getAgentDisplayName } from "@/lib/agents";
import { invalidateAuthQueries, isTerminalLogin, postAuthJson } from "@/lib/auth-accounts";
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
  /** Account label, or "host" for the daemon user's own credentials. */
  label: string;
  onClose: () => void;
}

/** Native CLI sign-in in a daemon terminal; success shows only on a verified `ready`. */
export function AuthTerminalDialog({ target, provider, label, onClose }: AuthTerminalDialogProps) {
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const startedOnMount = useRef(false);
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
  const close = () => (terminalId ? stopMutation.mutate() : onClose());
  useDialogFocus({ panelRef, initialRef: closeRef, onEscape: close, escapeBlocked: closing });

  const running = status === "running" && !ended && !restarting;
  const name = getAgentDisplayName(provider);

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
            : "w-[min(26rem,calc(100vw-2rem))]"
        }`}
      >
        <div className="mb-3 flex items-center gap-2">
          <h2
            className="min-w-0 flex-1 font-bold uppercase text-[var(--color-text-primary)] [overflow-wrap:anywhere]"
            id="auth-terminal-dialog-title"
          >
            Sign in {name} · {label} · Terminal
          </h2>
          <IconCloseButton
            disabled={closing}
            idleTextClass="text-[var(--color-text-secondary)]"
            label="Close terminal sign-in"
            onClick={close}
          />
        </div>

        {running && login ? (
          <div className="mb-2.5 h-[min(24rem,55dvh)] bg-[var(--color-terminal-bg)]">
            <DirectTerminal
              agent={provider}
              agentInputEnabled={false}
              hideHeader
              sessionId={login.tmuxSession}
            />
          </div>
        ) : null}

        <div
          aria-live="polite"
          className="flex items-start gap-2 border border-[var(--color-border-default)] px-2.5 py-2 normal-case tracking-normal text-[var(--color-text-secondary)]"
          data-testid="auth-terminal-status"
          role="status"
        >
          {startError !== null ? (
            <span className="text-[var(--color-status-error)]">{startError}</span>
          ) : restarting ? (
            <WaitLine live={false}>Opening terminal…</WaitLine>
          ) : status === "ready" ? (
            <span className="font-bold text-[var(--color-status-ready)]">
              ✓ Signed in · verified by test request
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
                {login
                  ? "Waiting for terminal sign-in… success shows after Spur verifies the account."
                  : "Opening terminal…"}
              </WaitLine>
              {login?.reason && RUNNING_NOTE[login.reason] ? (
                <span>{RUNNING_NOTE[login.reason]}</span>
              ) : null}
            </span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
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
  );
}
