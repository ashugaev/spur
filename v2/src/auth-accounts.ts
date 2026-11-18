import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AuthQuotaSummary, QuotaFailureKind } from "./auth-quota.js";
import { listAccounts } from "./claude-accounts.js";

export const authProviderSchema = z.enum(["claude", "codex"]);
export type AuthProvider = z.infer<typeof authProviderSchema>;

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 = 409,
  ) {
    super(message);
  }
}

const identitySchema = z.object({
  email: z.string().optional(),
  organizationName: z.string().optional(),
  organizationId: z.string().optional(),
  plan: z.string().optional(),
  keyHint: z.string().optional(),
});
/** Provider identity of a signed-in account; never a secret. */
export type AuthIdentity = z.infer<typeof identitySchema>;

const accountSchema = z.object({
  id: z.string().min(1),
  provider: authProviderSchema,
  identity: identitySchema.optional(),
  createdAt: z.string(),
});
export type AuthAccount = z.infer<typeof accountSchema>;

const poolSchema = z.object({
  defaultAccountId: z.string().nullable(),
  defaultGeneration: z.number().int().nonnegative(),
  autoRotate: z.boolean(),
});
export type AuthPool = z.infer<typeof poolSchema>;

const storeSchema = z.object({
  schema: z.literal(1),
  accounts: z.array(accountSchema),
  pools: z.object({ claude: poolSchema.optional(), codex: poolSchema.optional() }),
});
export type AuthAccountsState = z.infer<typeof storeSchema>;

export interface AuthAccountSummary extends AuthAccount {
  /** The one name every surface shows; see authDisplayNames. */
  displayName: string;
  /** Cached quota; present only on GET /auth-accounts for ready OAuth accounts. */
  quota?: AuthQuotaSummary;
  /** Kind of the last failed quota refresh; set with opts.quota only while no quota is cached. */
  quotaError?: QuotaFailureKind;
  authenticated: boolean;
  status: "ready" | "sign_in_required" | "pending" | "error";
  /** True while a shared quota cooldown is active; cooldownUntil is its ISO end. */
  limited: boolean;
  cooldownUntil?: string;
  /** Kind of the registered credential, when the companion reports one. */
  credential?: "oauth" | "api_key";
}

const PROVIDER_NAME: Record<AuthProvider, string> = { claude: "Claude", codex: "Codex" };

function upperFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Schema key order with the plan first-letter-uppercased, so stored and live identities compare equal. */
function normalizeIdentity(identity: AuthIdentity): AuthIdentity {
  return identitySchema.parse({
    ...identity,
    ...(identity.plan ? { plan: upperFirst(identity.plan) } : {}),
  });
}

function lastFour(value: string): string {
  return `····${value.slice(-4)}`;
}

/**
 * Display name per account id, from provider identity only. Per provider: API key "API key ····1234";
 * no identity "New Claude account"; unique email as is; a repeated email adds the organization (Claude)
 * or plan (Codex), then the last 4 of the organization id when that is still ambiguous.
 */
export function authDisplayNames(
  accounts: { id: string; provider: AuthProvider; identity?: AuthIdentity | undefined }[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const provider of authProviderSchema.options) {
    const pool = accounts.filter((account) => account.provider === provider);
    const emailOf = (account: (typeof pool)[number]): string =>
      account.identity?.email?.trim().toLowerCase() ?? "";
    const secondaryOf = (account: (typeof pool)[number]): string =>
      (provider === "claude"
        ? account.identity?.organizationName
        : account.identity?.plan
      )?.trim() ?? "";
    const sameEmail = (account: (typeof pool)[number]) =>
      pool.filter((other) => emailOf(other) === emailOf(account));
    for (const account of pool) {
      const identity = account.identity;
      const email = identity?.email?.trim();
      if (identity?.keyHint) {
        names.set(account.id, `API key ${lastFour(identity.keyHint)}`);
      } else if (!email) {
        names.set(account.id, `New ${PROVIDER_NAME[provider]} account`);
      } else if (sameEmail(account).length === 1) {
        names.set(account.id, email);
      } else {
        const secondary = secondaryOf(account);
        const shared = sameEmail(account).filter((other) => secondaryOf(other) === secondary);
        if (secondary && shared.length === 1) {
          names.set(account.id, `${email} · ${secondary}`);
        } else if (identity?.organizationId) {
          names.set(account.id, `${email} · ${lastFour(identity.organizationId)}`);
        } else {
          names.set(account.id, email);
        }
      }
    }
  }
  return names;
}

/** Accounts carrying the identity the companion reports now; the stored one lags a write behind a first sign-in. */
export function withCompanionIdentity<T extends { id: string }>(
  accounts: T[],
  entries: { id: string; identity?: AuthIdentity | undefined }[],
): T[] {
  return accounts.map((account) => {
    const identity = entries.find((entry) => entry.id === account.id)?.identity;
    return identity ? { ...account, identity: normalizeIdentity(identity) } : account;
  });
}

/** Pool preferences and provider identity. Provider credentials belong to the companion. */
export class AuthAccounts {
  constructor(
    private readonly dataDir: string,
    private readonly initialAutoRotate: () => boolean,
  ) {}

  private get path(): string {
    return join(this.dataDir, "auth-accounts.json");
  }

  read(): AuthAccountsState {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const legacy = listAccounts(this.dataDir);
      const state: AuthAccountsState = {
        schema: 1,
        accounts: legacy.map(({ id, createdAt }) => ({ id, provider: "claude", createdAt })),
        pools:
          legacy.length > 0 || existsSync(join(this.dataDir, "claude-accounts.json"))
            ? {
                claude: {
                  defaultAccountId: legacy[0]?.id ?? null,
                  defaultGeneration: 0,
                  autoRotate: this.initialAutoRotate(),
                },
              }
            : {},
      };
      this.write(state);
      return state;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid managed authorization account store");
    }
    const result = storeSchema.safeParse(parsed);
    if (!result.success) throw new Error("Invalid managed authorization account store");
    return result.data;
  }

  private write(state: AuthAccountsState): void {
    mkdirSync(this.dataDir, { recursive: true });
    const temporary = `${this.path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }

  add(provider: AuthProvider): AuthAccount {
    const state = this.read();
    const account: AuthAccount = {
      id: randomUUID(),
      provider,
      createdAt: new Date().toISOString(),
    };
    state.accounts.push(account);
    state.pools[provider] ??= {
      defaultAccountId: account.id,
      defaultGeneration: 0,
      autoRotate: this.initialAutoRotate(),
    };
    const pool = state.pools[provider];
    if (pool.defaultAccountId === null) {
      pool.defaultAccountId = account.id;
      pool.defaultGeneration += 1;
    }
    this.write(state);
    return account;
  }

  /** Stores the identity the companion reports per account; writes only when something changed. */
  recordIdentities(entries: { id: string; identity?: AuthIdentity | undefined }[]): void {
    const state = this.read();
    let changed = false;
    for (const { id, identity } of entries) {
      const account = state.accounts.find((candidate) => candidate.id === id);
      if (!account || !identity) continue;
      const next = normalizeIdentity(identity);
      if (JSON.stringify(account.identity) === JSON.stringify(next)) continue;
      account.identity = next;
      changed = true;
    }
    if (changed) this.write(state);
  }

  /** Removes an account; a removed default moves to the first ready account of the provider. */
  remove(id: string, isReady: (accountId: string) => boolean): void {
    const state = this.read();
    const account = state.accounts.find((entry) => entry.id === id);
    if (!account) throw new AuthorizationError(`Unknown authorization account: ${id}`, 404);
    state.accounts = state.accounts.filter((entry) => entry.id !== id);
    const pool = state.pools[account.provider];
    if (pool?.defaultAccountId === id) {
      pool.defaultAccountId =
        state.accounts.find((entry) => entry.provider === account.provider && isReady(entry.id))
          ?.id ?? null;
      pool.defaultGeneration += 1;
    }
    this.write(state);
  }

  updatePool(
    provider: AuthProvider,
    update: { defaultAccountId?: string | null; autoRotate?: boolean },
  ): AuthPool {
    const state = this.read();
    const pool = (state.pools[provider] ??= {
      defaultAccountId: null,
      defaultGeneration: 0,
      autoRotate: this.initialAutoRotate(),
    });
    if (update.defaultAccountId !== undefined) {
      if (
        update.defaultAccountId !== null &&
        !state.accounts.some(
          (entry) => entry.id === update.defaultAccountId && entry.provider === provider,
        )
      ) {
        throw new AuthorizationError(`Unknown ${provider} authorization account`, 400);
      }
      if (pool.defaultAccountId !== update.defaultAccountId) {
        pool.defaultAccountId = update.defaultAccountId;
        pool.defaultGeneration += 1;
      }
    }
    if (update.autoRotate !== undefined) pool.autoRotate = update.autoRotate;
    this.write(state);
    return pool;
  }
}
