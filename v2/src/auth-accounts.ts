import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
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

const accountSchema = z.object({
  id: z.string().min(1),
  provider: authProviderSchema,
  label: z.string().optional(),
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
  authenticated: boolean;
  status: "ready" | "sign_in_required" | "pending" | "error";
}

/** Runtime labels and pool preferences. Provider credentials belong to the companion. */
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
        accounts: legacy.map(({ id, label, createdAt }) => ({
          id,
          provider: "claude",
          ...(label ? { label } : {}),
          createdAt,
        })),
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

  add(provider: AuthProvider, label?: string): AuthAccount {
    const state = this.read();
    const account: AuthAccount = {
      id: randomUUID(),
      provider,
      ...(label?.trim() ? { label: label.trim() } : {}),
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

  rename(id: string, label: string): AuthAccount {
    const state = this.read();
    const account = state.accounts.find((entry) => entry.id === id);
    if (!account) throw new AuthorizationError(`Unknown authorization account: ${id}`, 404);
    account.label = label.trim();
    this.write(state);
    return account;
  }

  remove(id: string): void {
    const state = this.read();
    const account = state.accounts.find((entry) => entry.id === id);
    if (!account) throw new AuthorizationError(`Unknown authorization account: ${id}`, 404);
    state.accounts = state.accounts.filter((entry) => entry.id !== id);
    const pool = state.pools[account.provider];
    if (pool?.defaultAccountId === id) {
      pool.defaultAccountId =
        state.accounts.find((entry) => entry.provider === account.provider)?.id ?? null;
      pool.defaultGeneration += 1;
    }
    this.write(state);
  }

  updatePool(
    provider: AuthProvider,
    update: { defaultAccountId?: string | null; autoRotate?: boolean },
  ): AuthPool {
    const state = this.read();
    const pool = state.pools[provider];
    if (!pool) throw new AuthorizationError(`No managed authorization pool for ${provider}`, 404);
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
