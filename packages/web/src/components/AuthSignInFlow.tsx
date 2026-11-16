"use client";

import { useState } from "react";
import { AuthLoginDialog } from "@/components/AuthLoginDialog";
import { AuthTerminalDialog } from "@/components/AuthTerminalDialog";
import { authAccountName } from "@/lib/auth-accounts";
import type { AuthAccountSummary, AuthProvider } from "@/lib/types";

export type SignInTarget =
  | { kind: "account"; account: Pick<AuthAccountSummary, "id" | "label" | "provider"> }
  | { kind: "host"; provider: AuthProvider };

interface AuthSignInFlowProps {
  target: SignInTarget;
  /** Host credentials have no in-UI method, so they start in the terminal. */
  initialMode?: "ui" | "terminal";
  onClose: () => void;
}

/** One sign-in for one account or host: the guided dialog, switchable to a native terminal. */
export function AuthSignInFlow({ target, initialMode = "ui", onClose }: AuthSignInFlowProps) {
  const [mode, setMode] = useState(target.kind === "host" ? "terminal" : initialMode);

  if (target.kind === "host") {
    return (
      <AuthTerminalDialog
        label="host"
        provider={target.provider}
        target={{ host: target.provider }}
        onClose={onClose}
      />
    );
  }
  if (mode === "terminal") {
    return (
      <AuthTerminalDialog
        label={authAccountName(target.account)}
        provider={target.account.provider}
        target={{ accountId: target.account.id }}
        onClose={onClose}
      />
    );
  }
  return (
    <AuthLoginDialog
      account={target.account}
      onClose={onClose}
      onContinueInTerminal={() => setMode("terminal")}
    />
  );
}
