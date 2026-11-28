import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthProvider } from "./auth-accounts.js";

/** Who a host (system) login belongs to. Identity fields only; no token is kept. */
export interface HostIdentity {
  email: string;
  /** Claude organization uuid, Codex ChatGPT account id. */
  organizationId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

function identityOf(email: unknown, organizationId: unknown): HostIdentity | null {
  const address = text(email);
  if (!address) return null;
  const organization = text(organizationId);
  return { email: address, ...(organization ? { organizationId: organization } : {}) };
}

/** Claude: `oauthAccount` of ~/.claude.json. */
async function readClaudeHostIdentity(homeDir: string): Promise<HostIdentity | null> {
  const json = await readJson(join(homeDir, ".claude.json"));
  const account = isRecord(json) ? json["oauthAccount"] : undefined;
  return isRecord(account)
    ? identityOf(account["emailAddress"], account["organizationUuid"])
    : null;
}

/** Codex: claims of the id_token in ~/.codex/auth.json; only the payload's identity claims are read. */
async function readCodexHostIdentity(homeDir: string): Promise<HostIdentity | null> {
  const json = await readJson(join(homeDir, ".codex", "auth.json"));
  const tokens = isRecord(json) ? json["tokens"] : undefined;
  const idToken = isRecord(tokens) ? text(tokens["id_token"]) : undefined;
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (!isRecord(claims)) return null;
  const auth = claims["https://api.openai.com/auth"];
  return identityOf(
    claims["email"],
    (isRecord(auth) ? auth["chatgpt_account_id"] : undefined) ?? claims["chatgpt_account_id"],
  );
}

export function readHostIdentity(
  provider: AuthProvider,
  homeDir: string,
): Promise<HostIdentity | null> {
  return provider === "claude" ? readClaudeHostIdentity(homeDir) : readCodexHostIdentity(homeDir);
}

/**
 * The one rule for a host login next to managed accounts: the host entry is a duplicate when a
 * managed account of the same provider has the same email and, where both sides carry one, the
 * same organization or account id. The managed account takes priority.
 */
export function hostDuplicatesManaged(
  host: HostIdentity | null,
  provider: AuthProvider,
  managed: readonly {
    provider: AuthProvider;
    identity?: { email?: string | undefined; organizationId?: string | undefined } | undefined;
  }[],
): boolean {
  if (!host) return false;
  const email = host.email.toLowerCase();
  return managed.some((account) => {
    if (account.provider !== provider) return false;
    const identity = account.identity;
    if (identity?.email?.trim().toLowerCase() !== email) return false;
    return (
      !host.organizationId ||
      !identity.organizationId ||
      host.organizationId === identity.organizationId
    );
  });
}
