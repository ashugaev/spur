import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CACHE_TTL_MS,
  MAX_RETRY_AFTER_S,
  parseClaudeUsage,
  parseCodexUsage,
  type QuotaWindow,
} from "./usage-report.js";

/** One account's usage read as the companion reports it; the body is the provider answer on 2xx. */
export interface UsageEntry {
  accountId: string;
  status: "ok" | "error";
  httpStatus?: number | undefined;
  retryAfterSeconds?: number | undefined;
  body?: string | undefined;
}

export interface AuthQuotaSummary {
  /** Smallest remaining percent over all windows. */
  leftPercent: number;
  /** Reset time of the window that sets leftPercent. */
  resetsAt: string | null;
  windows: QuotaWindow[];
  fetchedAt: string;
}

export interface AuthQuotaAccount {
  id: string;
  provider: "claude" | "codex";
  status: string;
  credential?: "oauth" | "api_key";
}

const MAX_SERVED_AGE_MS = MAX_RETRY_AFTER_S * 1000;
const CHUNK = 4;

const windowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  remainingPercent: z.number(),
  resetsAt: z.string().nullable(),
});
const entrySchema = z.object({
  fetchedAt: z.string().optional(),
  quota: z
    .object({
      leftPercent: z.number(),
      resetsAt: z.string().nullable(),
      windows: z.array(windowSchema),
    })
    .optional(),
  nextAt: z.number(),
  failures: z.number().int().nonnegative(),
});
const fileSchema = z.object({ schema: z.literal(1), entries: z.record(z.string(), entrySchema) });
type Entry = z.infer<typeof entrySchema>;

/** The quota of the window with the least remaining, or undefined when there are no windows. */
export function quotaFromWindows(
  windows: QuotaWindow[],
): Pick<AuthQuotaSummary, "leftPercent" | "resetsAt" | "windows"> | undefined {
  let tightest: QuotaWindow | undefined;
  for (const window of windows) {
    if (!tightest || window.remainingPercent < tightest.remainingPercent) tightest = window;
  }
  if (!tightest) return undefined;
  return { leftPercent: tightest.remainingPercent, resetsAt: tightest.resetsAt, windows };
}

function parseBody(provider: "claude" | "codex", body: string): QuotaWindow[] | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  return provider === "claude" ? parseClaudeUsage(json) : (parseCodexUsage(json)?.windows ?? null);
}

/**
 * Persisted managed-account quota cache. read() never waits on a provider: it returns what is
 * cached and starts at most one background refresh for accounts that are due.
 */
export class AuthQuota {
  private entries: Record<string, Entry> | undefined;
  private refreshing = false;

  constructor(
    private readonly options: {
      dataDir: string;
      fetchUsage: (accountIds: string[]) => Promise<UsageEntry[]>;
      now: () => number;
    },
  ) {}

  private get path(): string {
    return join(this.options.dataDir, "auth-quota.json");
  }

  private load(): Record<string, Entry> {
    if (this.entries) return this.entries;
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      this.entries = parsed.success ? parsed.data.entries : {};
    } catch {
      this.entries = {};
    }
    return this.entries;
  }

  private save(): void {
    mkdirSync(this.options.dataDir, { recursive: true });
    const temporary = `${this.path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify({ schema: 1, entries: this.load() }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }

  /** Cached quota per account id. accounts must be every store account, not a provider subset. */
  read(accounts: AuthQuotaAccount[]): Map<string, AuthQuotaSummary> {
    const now = this.options.now();
    const eligible = new Map(
      accounts
        .filter((account) => account.status === "ready" && account.credential === "oauth")
        .map((account) => [account.id, account]),
    );
    const loaded = Object.entries(this.load());
    const kept = loaded.filter(([id]) => eligible.has(id));
    if (kept.length !== loaded.length) {
      this.entries = Object.fromEntries(kept);
      this.save();
    }
    const entries = this.load();

    const due = [...eligible.values()].filter((account) => {
      const entry = entries[account.id];
      return !entry || now >= entry.nextAt;
    });
    if (due.length > 0 && !this.refreshing) {
      this.refreshing = true;
      void this.refresh(due).finally(() => {
        this.refreshing = false;
      });
    }

    const served = new Map<string, AuthQuotaSummary>();
    for (const [id, entry] of Object.entries(entries)) {
      if (!entry.quota || !entry.fetchedAt) continue;
      if (now - Date.parse(entry.fetchedAt) > MAX_SERVED_AGE_MS) continue;
      served.set(id, { ...entry.quota, fetchedAt: entry.fetchedAt });
    }
    return served;
  }

  private async refresh(due: AuthQuotaAccount[]): Promise<void> {
    for (let index = 0; index < due.length; index += CHUNK) {
      const chunk = due.slice(index, index + CHUNK);
      let answers: UsageEntry[] | undefined;
      try {
        answers = await this.options.fetchUsage(chunk.map((account) => account.id));
      } catch {
        // A rejected call counts as one error for every requested id.
      }
      for (const account of chunk) {
        this.apply(
          account,
          answers?.find((answer) => answer.accountId === account.id),
        );
      }
      this.save();
    }
  }

  private apply(account: AuthQuotaAccount, answer: UsageEntry | undefined): void {
    const entries = this.load();
    const now = this.options.now();
    const previous = entries[account.id];
    if (answer?.status === "ok" && answer.body !== undefined) {
      const windows = parseBody(account.provider, answer.body);
      if (windows) {
        const quota = quotaFromWindows(windows);
        entries[account.id] = {
          fetchedAt: new Date(now).toISOString(),
          ...(quota ? { quota } : {}),
          nextAt: now + CACHE_TTL_MS,
          failures: 0,
        };
        return;
      }
    }
    const failures = (previous?.failures ?? 0) + 1;
    const holdSeconds = Math.min(
      MAX_RETRY_AFTER_S,
      Math.max(answer?.retryAfterSeconds ?? 0, (CACHE_TTL_MS / 1000) * 2 ** (failures - 1)),
    );
    const keepQuota = answer?.httpStatus === 429 && previous?.quota !== undefined;
    entries[account.id] = {
      ...(keepQuota ? { fetchedAt: previous.fetchedAt, quota: previous.quota } : {}),
      nextAt: now + holdSeconds * 1000,
      failures,
    };
  }
}
