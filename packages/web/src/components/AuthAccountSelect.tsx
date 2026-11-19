"use client";

import { useEffect } from "react";

import { INPUT_CLASS } from "@/design/classes";
import type { AgentName } from "@/lib/agents";
import { autoAccount, isAuthProvider, useAuthAccounts } from "@/lib/auth-accounts";

interface AuthAccountSelectProps {
  agent: AgentName;
  /** `null` is Auto. */
  value: string | null;
  onChange: (next: string | null) => void;
}

const SELECT_CLASS = `min-w-24 flex-1 ${INPUT_CLASS}`;

/**
 * Spawn-time account picker. Loading and load failure render a disabled
 * placeholder; a loaded agent with no identified accounts renders nothing.
 */
export function AuthAccountSelect({ agent, value, onChange }: AuthAccountSelectProps) {
  const managed = isAuthProvider(agent);
  const query = useAuthAccounts(managed);
  const providerAccounts = query.data?.accounts.filter((account) => account.provider === agent);
  const accounts = providerAccounts?.filter((account) => account.identity !== undefined);
  const hidden =
    accounts !== undefined &&
    (accounts.length === 0 || accounts.filter((account) => account.authenticated).length === 1);
  // A selection that is no longer a usable option must not reach the spawn payload.
  const stale =
    accounts !== undefined &&
    value !== null &&
    (hidden || !accounts.some((account) => account.id === value && account.authenticated));
  useEffect(() => {
    if (stale) onChange(null);
  }, [stale, onChange]);
  if (!managed) return null;
  if (query.isPending || query.isError) {
    return (
      <select
        aria-busy={query.isPending || undefined}
        aria-label="Spawn account"
        className={SELECT_CLASS}
        disabled
        value=""
      >
        <option value="">{query.isError ? "Account · unavailable" : "Account"}</option>
      </select>
    );
  }
  // No identified accounts, or Auto lands on the only usable one: nothing to choose.
  if (hidden || !providerAccounts || !accounts) return null;
  const auto = autoAccount(providerAccounts, query.data.pools[agent]);

  return (
    <select
      aria-label="Spawn account"
      className={SELECT_CLASS}
      onChange={(event) => onChange(event.target.value || null)}
      value={value ?? ""}
    >
      <option value="">
        {auto ? `Account · Auto (now ${auto.displayName})` : "Account · Auto"}
      </option>
      {accounts.map((account) => (
        <option disabled={!account.authenticated} key={account.id} value={account.id}>
          {`Account · ${account.displayName}${account.authenticated ? "" : " — signed out"}`}
        </option>
      ))}
    </select>
  );
}
