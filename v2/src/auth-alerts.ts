import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { authProviderSchema, type AuthProvider } from "./auth-accounts.js";
import { logSpurEventUncollapsed } from "./event-log.js";
import { isTerminalSessionStatus, type SessionRecord } from "./types.js";
import type { QuotaSourceResult } from "./usage-report.js";

export interface AuthAlert {
  id: string;
  kind: "managed" | "host";
  provider: AuthProvider;
  accountId?: string;
  label: string;
  since: string;
  sessionsWaiting?: number;
}

const entrySchema = z.object({
  id: z.string(),
  kind: z.enum(["managed", "host"]),
  provider: authProviderSchema,
  since: z.string(),
});
const fileSchema = z.object({ schema: z.literal(1), entries: z.array(entrySchema) });
export type AlertEntry = z.infer<typeof entrySchema>;

export interface ManagedBreakage {
  accountId: string;
  provider: AuthProvider;
  label: string;
  brokenAt: string;
}

export type HostObservation = "broken" | "ok" | "unknown";

export interface AlertEvaluationInput {
  /** Companion accounts with a breakage mark; null when the companion could not be read. */
  managed: ManagedBreakage[] | null;
  host: { provider: AuthProvider; observation: HostObservation }[];
  sessions: { status: SessionRecord["status"]; auth?: { effectiveAccountId: string } }[];
}

export interface AlertEvaluation {
  alerts: AuthAlert[];
  opened: AlertEntry[];
}

/** expired and unauthorized open a host alert; ok and rate_limited close it; the rest leave it. */
export function observeHostSource(result: QuotaSourceResult): HostObservation {
  if (result.status === "ok") return "ok";
  if (result.error === "expired" || result.error === "unauthorized") return "broken";
  if (result.error === "rate_limited") return "ok";
  return "unknown";
}

export function countSessionsWaiting(
  sessions: AlertEvaluationInput["sessions"],
  accountId: string,
): number {
  return sessions.filter(
    (session) =>
      !isTerminalSessionStatus(session.status) && session.auth?.effectiveAccountId === accountId,
  ).length;
}

const HOST_LABELS: Record<AuthProvider, string> = { claude: "Claude host", codex: "Codex host" };

/** Event details for session.auth.failed; never carries a session id or credential. */
export function failedEventDetails(entry: AlertEntry): {
  kind: AlertEntry["kind"];
  provider: AuthProvider;
  accountId?: string;
} {
  return {
    kind: entry.kind,
    provider: entry.provider,
    ...(entry.kind === "managed" ? { accountId: entry.id.slice("managed:".length) } : {}),
  };
}

/** One session.auth.failed line per call. The alert file already dedupes, so the warn collapse must not drop any. */
export function logAuthFailed(dataDir: string, entry: AlertEntry): void {
  logSpurEventUncollapsed(dataDir, {
    event: "session.auth.failed",
    level: "warn",
    message: `${entry.provider} sign-in is broken`,
    details: failedEventDetails(entry),
  });
}

function entryKey(entry: AlertEntry): string {
  return `${entry.id}@${entry.since}`;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export interface AuthAlertsDeps {
  dataDir: string;
  /** Called once per newly opened breakage, only after the alert file holds it. */
  onOpened: (alert: AlertEntry) => void;
  write?: (path: string, content: string) => void;
}

/** Owns <dataDir>/auth-alerts.json. Evaluations run one at a time; the file is the dedupe state. */
export class AuthAlerts {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AuthAlertsDeps) {}

  private get path(): string {
    return join(this.deps.dataDir, "auth-alerts.json");
  }

  /** A function input is read inside the chain, so it never lags an earlier evaluation's write. */
  evaluate(
    source: AlertEvaluationInput | (() => AlertEvaluationInput | Promise<AlertEvaluationInput>),
    now: Date,
  ): Promise<AlertEvaluation> {
    const run = this.chain.then(async () =>
      this.evaluateNow(typeof source === "function" ? await source() : source, now),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  private readStored(): AlertEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const parsed = fileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.entries : [];
    } catch {
      return [];
    }
  }

  private evaluateNow(input: AlertEvaluationInput, now: Date): AlertEvaluation {
    const stored = this.readStored();
    const labels = new Map<string, string>();
    const next: AlertEntry[] = [];

    if (input.managed === null) {
      next.push(...stored.filter((entry) => entry.kind === "managed"));
    } else {
      for (const breakage of input.managed) {
        const id = `managed:${breakage.accountId}`;
        labels.set(id, breakage.label);
        next.push({
          id,
          kind: "managed",
          provider: breakage.provider,
          since: breakage.brokenAt,
        });
      }
    }

    for (const provider of authProviderSchema.options) {
      const id = `host:${provider}`;
      const known = stored.find((entry) => entry.id === id);
      const observation = input.host.find((item) => item.provider === provider)?.observation;
      if (observation === "ok") continue;
      if (observation === "broken") {
        next.push(known ?? { id, kind: "host", provider, since: now.toISOString() });
      } else if (known) {
        next.push(known);
      }
    }

    const storedKeys = new Set(stored.map(entryKey));
    const opened = next.filter((entry) => !storedKeys.has(entryKey(entry)));
    const changed = opened.length > 0 || stored.length !== next.length;
    if (changed) {
      const write = this.deps.write ?? atomicWrite;
      let written = true;
      try {
        write(this.path, `${JSON.stringify({ schema: 1, entries: next }, null, 2)}\n`);
      } catch {
        written = false;
      }
      if (written) for (const entry of opened) this.deps.onOpened(entry);
      else opened.length = 0;
    }

    return {
      opened,
      alerts: next.map((entry): AuthAlert => {
        if (entry.kind === "host") {
          return {
            id: entry.id,
            kind: "host",
            provider: entry.provider,
            label: HOST_LABELS[entry.provider],
            since: entry.since,
          };
        }
        const accountId = entry.id.slice("managed:".length);
        return {
          id: entry.id,
          kind: "managed",
          provider: entry.provider,
          accountId,
          label: labels.get(entry.id) ?? accountId,
          since: entry.since,
          sessionsWaiting: countSessionsWaiting(input.sessions, accountId),
        };
      }),
    };
  }
}
