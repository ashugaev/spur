import { type QueryClient, useQuery } from "@tanstack/react-query";
import { formatClockTime } from "@/lib/format";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import type {
  AuthAccountStatus,
  AuthAccountSummary,
  AuthAccountsResponse,
  AuthAlertsResponse,
  AuthLogin,
  AuthProvider,
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
  const record = value as { id?: unknown; tmuxSession?: unknown; status?: unknown };
  return (
    typeof record.id === "string" &&
    typeof record.tmuxSession === "string" &&
    typeof record.status === "string"
  );
}

export function authAccountName(account: Pick<AuthAccountSummary, "id" | "label">): string {
  return account.label?.trim() || account.id.slice(0, 8);
}

export const AUTH_STATUS_LABEL: Record<AuthAccountStatus, string> = {
  ready: "ready",
  sign_in_required: "sign in required",
  pending: "signing in",
  error: "error",
};

/** "limited", or "limited<joiner>until 14:05" while cooling; null when not limited. */
export function authLimitLabel(
  account: Pick<AuthAccountSummary, "limited" | "cooldownUntil">,
  joiner = " ",
): string | null {
  if (!account.limited) return null;
  return account.cooldownUntil
    ? `limited${joiner}until ${formatClockTime(account.cooldownUntil)}`
    : "limited";
}

/** Option text for pickers: label plus status or limit suffix. */
export function authAccountOptionLabel(account: AuthAccountSummary): string {
  const suffix = account.authenticated
    ? authLimitLabel(account)
    : AUTH_STATUS_LABEL[account.status];
  return suffix ? `${authAccountName(account)} (${suffix})` : authAccountName(account);
}

/** One shared cache of every managed account and pool, filtered per caller. */
export function useAuthAccounts(enabled = true) {
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
