import { type QueryClient, useQuery } from "@tanstack/react-query";
import { formatClockTime } from "@/lib/format";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import type {
  AuthAccountSummary,
  AuthAccountsResponse,
  AuthAlertsResponse,
  AuthLogin,
  AuthPool,
  AuthProvider,
  SpurSessionAuth,
  SpurSessionsResponse,
  TerminalLogin,
} from "@/lib/types";

export const AUTH_PROVIDERS: readonly AuthProvider[] = ["claude", "codex"];
export const AUTH_ACCOUNTS_QUERY_KEY = ["auth-accounts"] as const;
export const AUTH_ALERTS_QUERY_KEY = ["auth-alerts"] as const;
const AUTH_ALERTS_POLL_INTERVAL_MS = 30_000;

/** Account status and alert rows both change when a sign-in settles. */
export function invalidateAuthQueries(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: AUTH_ACCOUNTS_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: AUTH_ALERTS_QUERY_KEY }),
  ]);
}

export function isAuthProvider(value: string): value is AuthProvider {
  return (AUTH_PROVIDERS as readonly string[]).includes(value);
}

function isAuthAccountsResponse(value: unknown): value is AuthAccountsResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { accounts?: unknown; pools?: unknown };
  return (
    Array.isArray(record.accounts) && typeof record.pools === "object" && record.pools !== null
  );
}

export function isAuthLogin(value: unknown): value is AuthLogin {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { accountId?: unknown; status?: unknown };
  return typeof record.accountId === "string" && typeof record.status === "string";
}

function isAuthAlertsResponse(value: unknown): value is AuthAlertsResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { alerts?: unknown }).alerts)
  );
}

export function isTerminalLogin(value: unknown): value is TerminalLogin {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    id?: unknown;
    tmuxSession?: unknown;
    status?: unknown;
    command?: unknown;
  };
  return (
    typeof record.id === "string" &&
    typeof record.tmuxSession === "string" &&
    typeof record.status === "string" &&
    typeof record.command === "string"
  );
}

const PROVIDER_NAME: Record<AuthProvider, string> = { claude: "Claude", codex: "Codex" };

/** Capitalized provider name for account surfaces. */
export function authProviderName(provider: AuthProvider): string {
  return PROVIDER_NAME[provider];
}
const API_NAME: Record<AuthProvider, string> = { claude: "Anthropic API", codex: "OpenAI API" };

type AccountLinesInput = Pick<AuthAccountSummary, "provider"> &
  Partial<Pick<AuthAccountSummary, "identity" | "credential" | "createdAt">>;

/** Two-line identity of an account: email and organization or plan; API keys and unnamed accounts have fixed forms. */
export function accountLines(account: AccountLinesInput): { primary: string; secondary: string } {
  const identity = account.identity;
  if (account.credential === "api_key" || identity?.keyHint) {
    return {
      primary: `API key ····${identity?.keyHint ?? ""}`,
      secondary: API_NAME[account.provider],
    };
  }
  if (!identity?.email) {
    return {
      primary: `New ${PROVIDER_NAME[account.provider]} account`,
      secondary: account.createdAt ? `added ${formatClockTime(account.createdAt)}` : "",
    };
  }
  return { primary: identity.email, secondary: identity.organizationName ?? identity.plan ?? "" };
}

/** One line "primary · secondary" (primary alone when secondary is empty). */
export function accountIdentityLine(account: AccountLinesInput): string {
  const { primary, secondary } = accountLines(account);
  return secondary ? `${primary} · ${secondary}` : primary;
}

export interface QuotaText {
  /** "62% left" or "0% left". */
  left: string;
  /** "resets 16:20"; only while the account is out of quota. */
  resets?: string;
  /** One line per window. */
  title: string;
}

function percentLeft(value: number): string {
  return `${Math.round(value)}% left`;
}

/** Quota text for a row; null when the account is not ready, is an API key, or has no known quota. */
export function quotaText(
  account: Pick<
    AuthAccountSummary,
    "status" | "credential" | "limited" | "cooldownUntil" | "quota"
  >,
): QuotaText | null {
  if (account.status !== "ready" || account.credential === "api_key") return null;
  const quota = account.quota;
  const title = (quota?.windows ?? [])
    .map(
      (window) =>
        `${window.label} ${percentLeft(window.remainingPercent)}${
          window.resetsAt ? ` · resets ${formatClockTime(window.resetsAt)}` : ""
        }`,
    )
    .join("\n");
  if (account.limited || quota?.leftPercent === 0) {
    const resetsAt = quota?.resetsAt ?? account.cooldownUntil;
    return {
      left: percentLeft(0),
      ...(resetsAt ? { resets: `resets ${formatClockTime(resetsAt)}` } : {}),
      title,
    };
  }
  return quota ? { left: percentLeft(quota.leftPercent), title } : null;
}

/** The ready account Auto resolves to: the session's effective account for Auto sessions, else the pool default. */
export function autoAccount(
  accounts: AuthAccountSummary[],
  pool: AuthPool | undefined,
  auth?: Pick<SpurSessionAuth, "mode" | "effectiveAccountId">,
): AuthAccountSummary | undefined {
  const id = auth?.mode === "auto" ? auth.effectiveAccountId : pool?.defaultAccountId;
  return accounts.find((account) => account.id === id && account.authenticated);
}

/**
 * Running sessions of a provider a default change touches: Auto sessions on another account move
 * when applied to active sessions, pinned ones never do. A failed read counts none, so the change
 * applies to new sessions only.
 */
export async function countRunningAuthSessions(
  provider: AuthProvider,
  newDefaultId: string,
): Promise<{ active: number; pinned: number }> {
  const counts = { active: 0, pinned: 0 };
  try {
    const response = await fetch("/api/sessions", { cache: "no-store" });
    if (!response.ok) return counts;
    const payload = (await response.json()) as Partial<SpurSessionsResponse>;
    for (const session of payload.sessions ?? []) {
      const auth = session.auth;
      if (!auth || auth.provider !== provider || session.status !== "running") continue;
      if (!session.runtimeAlive) continue;
      if (auth.mode === "pinned") counts.pinned += 1;
      else if (auth.effectiveAccountId !== newDefaultId) counts.active += 1;
    }
  } catch {
    return { active: 0, pinned: 0 };
  }
  return counts;
}

/** One shared cache of every managed account and pool, filtered per caller. `poll` refetches while a menu or dialog is open. */
export function useAuthAccounts(enabled = true, options: { poll?: boolean } = {}) {
  return useQuery<AuthAccountsResponse>({
    queryKey: AUTH_ACCOUNTS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/auth-accounts", { signal });
      const payload = await readResponsePayload(response);
      if (!response.ok || !isAuthAccountsResponse(payload)) {
        throw new Error(responseErrorMessage(payload, "Failed to list authorization accounts"));
      }
      return payload;
    },
    enabled,
    staleTime: 30_000,
    ...(options.poll ? { refetchInterval: AUTH_ALERTS_POLL_INTERVAL_MS } : {}),
  });
}

/** Sign-in alert rows, polled every 30s while the tab is visible. */
export function useAuthAlerts() {
  return useQuery<AuthAlertsResponse>({
    queryKey: AUTH_ALERTS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/auth-alerts", { signal });
      const payload = await readResponsePayload(response);
      if (!response.ok || !isAuthAlertsResponse(payload)) {
        throw new Error(responseErrorMessage(payload, "Failed to list sign-in alerts"));
      }
      return payload;
    },
    refetchInterval: AUTH_ALERTS_POLL_INTERVAL_MS,
    staleTime: AUTH_ALERTS_POLL_INTERVAL_MS,
  });
}

export async function postAuthJson(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  fallback: string,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload = await readResponsePayload(response);
  if (!response.ok) throw new Error(responseErrorMessage(payload, fallback));
  return payload;
}
