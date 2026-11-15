"use client";

import { INPUT_CLASS } from "@/design/classes";
import type { AgentName } from "@/lib/agents";
import {
  AUTH_STATUS_LABEL,
  authAccountName,
  isAuthProvider,
  useAuthAccounts,
} from "@/lib/auth-accounts";

interface AuthAccountSelectProps {
  agent: AgentName;
  /** `null` is Auto. */
  value: string | null;
  onChange: (next: string | null) => void;
}

/** Spawn-time account picker; renders nothing when the agent has no managed accounts. */
export function AuthAccountSelect({ agent, value, onChange }: AuthAccountSelectProps) {
  const managed = isAuthProvider(agent);
  const { data } = useAuthAccounts(managed);
  if (!managed) return null;
  const accounts = (data?.accounts ?? []).filter((account) => account.provider === agent);
  if (accounts.length === 0) return null;

  return (
    <select
      aria-label="Spawn auth"
      className={`min-w-24 flex-1 ${INPUT_CLASS}`}
      onChange={(event) => onChange(event.target.value || null)}
      value={value ?? ""}
    >
      <option value="">Auth · Auto</option>
      {accounts.map((account) => (
        <option disabled={!account.authenticated} key={account.id} value={account.id}>
          {`Auth · ${authAccountName(account)}${
            account.authenticated ? "" : ` (${AUTH_STATUS_LABEL[account.status]})`
          }`}
        </option>
      ))}
    </select>
  );
}
