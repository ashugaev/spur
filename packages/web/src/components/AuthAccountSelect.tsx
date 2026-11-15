"use client";

import { INPUT_CLASS } from "@/design/classes";
import type { AgentName } from "@/lib/agents";
import { authAccountOptionLabel, isAuthProvider, useAuthAccounts } from "@/lib/auth-accounts";

interface AuthAccountSelectProps {
  agent: AgentName;
  /** `null` is Auto. */
  value: string | null;
  onChange: (next: string | null) => void;
}

const SELECT_CLASS = `min-w-24 flex-1 ${INPUT_CLASS}`;

/**
 * Spawn-time account picker. Loading and load failure render a disabled
 * placeholder; a loaded agent with no managed accounts renders nothing.
 */
export function AuthAccountSelect({ agent, value, onChange }: AuthAccountSelectProps) {
  const managed = isAuthProvider(agent);
  const query = useAuthAccounts(managed);
  if (!managed) return null;
  if (query.isPending || query.isError) {
    return (
      <select aria-label="Spawn auth" className={SELECT_CLASS} disabled value="">
        <option value="">{query.isError ? "Auth · unavailable" : "Auth · Loading…"}</option>
      </select>
    );
  }
  const accounts = query.data.accounts.filter((account) => account.provider === agent);
  if (accounts.length === 0) return null;

  return (
    <select
      aria-label="Spawn auth"
      className={SELECT_CLASS}
      onChange={(event) => onChange(event.target.value || null)}
      value={value ?? ""}
    >
      <option value="">Auth · Auto</option>
      {accounts.map((account) => (
        <option disabled={!account.authenticated} key={account.id} value={account.id}>
          {`Auth · ${authAccountOptionLabel(account)}`}
        </option>
      ))}
    </select>
  );
}
