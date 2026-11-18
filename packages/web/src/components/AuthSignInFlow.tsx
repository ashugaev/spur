"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AuthLoginDialog, type SignInAccount } from "@/components/AuthLoginDialog";
import { AuthTerminalDialog } from "@/components/AuthTerminalDialog";
import { invalidateAuthQueries, isAuthLogin, postAuthJson } from "@/lib/auth-accounts";
import { readResponsePayload } from "@/lib/json-payload";
import type { AuthProvider } from "@/lib/types";

export type SignInTarget =
  | { kind: "account"; account: SignInAccount; isNew?: boolean }
  | { kind: "host"; provider: AuthProvider };

interface AuthSignInFlowProps {
  target: SignInTarget;
  /** Host credentials have no in-UI method, so they start in the terminal. */
  initialMode?: "ui" | "terminal";
  onClose: () => void;
}

/** One sign-in for one account or host: the guided dialog, switchable to a native terminal. */
export function AuthSignInFlow({ target, initialMode = "ui", onClose }: AuthSignInFlowProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState(target.kind === "host" ? "terminal" : initialMode);
  const newAccountId = target.kind === "account" && target.isNew ? target.account.id : null;

  // A new account that never reached ready is deleted. Only a successful status read that says
  // "not ready" deletes: a failed or unparsable read leaves the account.
  const close = useCallback(() => {
    onClose();
    if (!newAccountId) return;
    const path = `/api/auth-accounts/${encodeURIComponent(newAccountId)}`;
    void (async () => {
      try {
        const response = await fetch(`${path}/login-status`);
        if (!response.ok) return;
        const payload = await readResponsePayload(response);
        if (!isAuthLogin(payload) || payload.status === "ready") return;
        await postAuthJson(path, "DELETE", undefined, "Failed to remove account");
      } catch {
        // The account stays; the menu still lists it with Sign in.
      } finally {
        void invalidateAuthQueries(queryClient);
      }
    })();
  }, [newAccountId, onClose, queryClient]);

  if (target.kind === "host") {
    return (
      <AuthTerminalDialog
        provider={target.provider}
        target={{ host: target.provider }}
        onClose={close}
      />
    );
  }
  if (mode === "terminal") {
    return (
      <AuthTerminalDialog
        account={target.account}
        provider={target.account.provider}
        target={{ accountId: target.account.id }}
        onClose={close}
      />
    );
  }
  return (
    <AuthLoginDialog
      account={target.account}
      isNew={target.isNew === true}
      onClose={close}
      onContinueInTerminal={() => setMode("terminal")}
    />
  );
}
