import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { listAccounts, sessionClaudeHome, type ClaudeAccount } from "./claude-accounts.js";
import { listSessions, sessionFilePath } from "./metadata.js";
import {
  summarizeTokenUsageWindows,
  type TokenUsageActivity,
  type TokenUsageWindowSummary,
} from "./token-usage.js";

export type QuotaProvider = "claude" | "codex";

export interface QuotaWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
}

export type QuotaErrorKind =
  | "no_credentials"
  | "expired"
  | "unauthorized"
  | "rate_limited"
  | "http_error"
  | "network_error"
  | "unparsable";

interface QuotaSourceBase {
  provider: QuotaProvider;
  source: string;
  label: string;
  fetchedAt: string;
}

export type QuotaSourceResult =
  | (QuotaSourceBase & { status: "ok"; plan: string | null; windows: QuotaWindow[] })
  | (QuotaSourceBase & {
      status: "error";
      error: QuotaErrorKind;
      message: string;
      httpStatus: number | null;
    });

export interface UsageReport {
  generatedAt: string;
  quotas: QuotaSourceResult[];
  tokens: TokenUsageWindowSummary[];
}

export interface UsageReportDeps {
  fetch: typeof fetch;
  homeDir: string;
  dataDir: string;
  nowMs: number;
  todayStartMs: number;
}

const CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
const CACHE_TTL_MS = 180_000;
const MAX_RETRY_AFTER_S = 3600;
const FETCH_TIMEOUT_MS = 5_000;

const ERROR_MESSAGES: Record<QuotaErrorKind, string> = {
  no_credentials: "no saved login found",
  expired: "saved login expired; run the agent to refresh it",
  unauthorized: "saved login rejected; run the agent to refresh it",
  rate_limited: "usage endpoint rate limited",
  http_error: "usage endpoint returned an error",
  network_error: "usage endpoint unreachable",
  unparsable: "usage response not recognized",
};

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function makeWindow(label: string, used: number, resetsAt: string | null): QuotaWindow {
  const usedPercent = Math.min(100, Math.max(0, used));
  return { label, usedPercent, remainingPercent: 100 - usedPercent, resetsAt };
}

// ---- Claude parse ----

interface ClaudeLimit {
  kind: string;
  group: string | undefined;
  percent: number | undefined;
  resetsAt: string | null;
  displayName: string;
  modelId: string | undefined;
  isActive: boolean;
}

function readLimit(raw: unknown): ClaudeLimit | null {
  if (!isObj(raw) || typeof raw.kind !== "string") return null;
  const model = isObj(raw.scope) && isObj(raw.scope.model) ? raw.scope.model : undefined;
  return {
    kind: raw.kind,
    group: typeof raw.group === "string" ? raw.group : undefined,
    percent: finiteNumber(raw.percent),
    resetsAt: typeof raw.resets_at === "string" ? raw.resets_at : null,
    displayName: typeof model?.display_name === "string" ? model.display_name.trim() : "",
    modelId: typeof model?.id === "string" && model.id !== "" ? model.id.toLowerCase() : undefined,
    isActive: raw.is_active === true,
  };
}

function isPlaceholder(limit: ClaudeLimit): boolean {
  return limit.displayName === "" && (limit.percent ?? 0) === 0 && limit.resetsAt === null;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
}

function sameScope(a: ClaudeLimit, b: ClaudeLimit): boolean {
  if (a.modelId !== undefined && b.modelId !== undefined) return a.modelId === b.modelId;
  return a.displayName.toLowerCase() === b.displayName.toLowerCase();
}

function mergedWindow(
  label: string,
  bucket: unknown,
  limit: ClaudeLimit | undefined,
): QuotaWindow | null {
  const bucketUsed = isObj(bucket) ? finiteNumber(bucket.utilization) : undefined;
  const used = bucketUsed ?? limit?.percent ?? (bucket === null ? 0 : undefined);
  if (used === undefined) return null;
  const bucketReset =
    isObj(bucket) && typeof bucket.resets_at === "string" ? bucket.resets_at : null;
  return makeWindow(label, used, bucketReset ?? limit?.resetsAt ?? null);
}

export function parseClaudeUsage(body: unknown): QuotaWindow[] | null {
  if (!isObj(body)) return null;
  if (body.five_hour === undefined && body.seven_day === undefined && body.limits === undefined) {
    return null;
  }
  const limits = (Array.isArray(body.limits) ? body.limits : [])
    .map(readLimit)
    .filter((limit): limit is ClaudeLimit => limit !== null);
  const usable = (kind: string): ClaudeLimit | undefined =>
    limits.find((limit) => limit.kind === kind && !isPlaceholder(limit));

  const windows: QuotaWindow[] = [];
  const five = mergedWindow("5h", body.five_hour, usable("session"));
  if (five) windows.push(five);
  const weekly = mergedWindow("weekly", body.seven_day, usable("weekly_all"));
  if (weekly) windows.push(weekly);

  const legacy: Array<{ name: string; window: QuotaWindow }> = [];
  for (const [key, name, label] of [
    ["seven_day_opus", "opus", "weekly Opus"],
    ["seven_day_sonnet", "sonnet", "weekly Sonnet"],
  ] as const) {
    const bucket = body[key];
    const used = isObj(bucket) ? finiteNumber(bucket.utilization) : undefined;
    if (used === undefined) continue;
    const resetsAt =
      isObj(bucket) && typeof bucket.resets_at === "string" ? bucket.resets_at : null;
    legacy.push({ name, window: makeWindow(label, used, resetsAt) });
  }

  const scoped: ClaudeLimit[] = [];
  for (const limit of limits) {
    if (limit.kind !== "weekly_scoped") continue;
    if (limit.group !== undefined && limit.group !== "weekly") continue;
    if (limit.displayName === "" || normalizeName(limit.displayName) === "all models") continue;
    if (limit.percent === undefined) continue;
    const index = scoped.findIndex((existing) => sameScope(existing, limit));
    if (index < 0) scoped.push(limit);
    else if (limit.isActive && !scoped[index]?.isActive) scoped[index] = limit;
  }

  const extra: QuotaWindow[] = legacy.map((entry) => entry.window);
  for (const limit of scoped) {
    const lower = limit.displayName.toLowerCase();
    const legacyIndex = legacy.findIndex((entry) => entry.name === lower);
    const legacyWindow = legacyIndex >= 0 ? legacy[legacyIndex]?.window : undefined;
    const window = makeWindow(
      `weekly ${limit.displayName}`,
      limit.percent ?? 0,
      limit.resetsAt ?? legacyWindow?.resetsAt ?? null,
    );
    if (legacyWindow) extra[legacyIndex] = window;
    else extra.push(window);
  }
  windows.push(...extra);
  return windows;
}

// ---- Codex parse ----

function codexLabel(seconds: unknown, fallback: string): string {
  const s = finiteNumber(seconds);
  if (s === undefined || s <= 0) return fallback;
  if (s === 604_800) return "weekly";
  if (s % 86_400 === 0) return `${s / 86_400}d`;
  if (s % 3_600 === 0) return `${s / 3_600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

function codexWindow(raw: unknown, fallback: string, prefix: string): QuotaWindow | null {
  if (!isObj(raw)) return null;
  const used = finiteNumber(raw.used_percent);
  if (used === undefined) return null;
  const reset = finiteNumber(raw.reset_at) ?? finiteNumber(raw.resets_at);
  const resetDate = reset === undefined ? null : new Date(reset * 1000);
  const resetsAt =
    resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null;
  const label = codexLabel(raw.limit_window_seconds, fallback);
  return makeWindow(prefix === "" ? label : `${prefix} ${label}`, used, resetsAt);
}

function codexRateWindows(rateLimit: unknown, prefix: string): QuotaWindow[] {
  if (!isObj(rateLimit)) return [];
  return [
    codexWindow(rateLimit.primary_window, "5h", prefix),
    codexWindow(rateLimit.secondary_window, "weekly", prefix),
  ].filter((window): window is QuotaWindow => window !== null);
}

export function parseCodexUsage(
  body: unknown,
): { plan: string | null; windows: QuotaWindow[] } | null {
  if (!isObj(body)) return null;
  if (body.rate_limit === undefined && body.additional_rate_limits === undefined) return null;
  const windows = codexRateWindows(body.rate_limit, "");
  if (Array.isArray(body.additional_rate_limits)) {
    for (const entry of body.additional_rate_limits) {
      if (!isObj(entry)) continue;
      const name =
        typeof entry.limit_name === "string" && entry.limit_name !== ""
          ? entry.limit_name
          : typeof entry.metered_feature === "string"
            ? entry.metered_feature
            : "";
      windows.push(...codexRateWindows(entry.rate_limit, name));
    }
  }
  return { plan: typeof body.plan_type === "string" ? body.plan_type : null, windows };
}

// ---- credentials (read-only) ----

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

interface ClaudeCredential {
  accessToken: string;
  expiresAt: number | null;
  plan: string | null;
}

async function readClaudeCredential(path: string): Promise<ClaudeCredential | null> {
  const json = await readJson(path);
  const oauth = isObj(json) && isObj(json.claudeAiOauth) ? json.claudeAiOauth : undefined;
  if (!oauth || typeof oauth.accessToken !== "string" || oauth.accessToken.trim() === "") {
    return null;
  }
  return {
    accessToken: oauth.accessToken,
    expiresAt: finiteNumber(oauth.expiresAt) ?? null,
    plan: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null,
  };
}

async function readCodexCredential(
  homeDir: string,
): Promise<{ accessToken: string; accountId: string | null } | null> {
  const json = await readJson(join(homeDir, ".codex", "auth.json"));
  const tokens = isObj(json) && isObj(json.tokens) ? json.tokens : undefined;
  if (!tokens || typeof tokens.access_token !== "string" || tokens.access_token.trim() === "") {
    return null;
  }
  return {
    accessToken: tokens.access_token,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : null,
  };
}

// ---- cache + fetch ----

interface FetchOutcome {
  result: QuotaSourceResult;
  retryAfterS: number | null;
}

interface CacheEntry {
  inflight: Promise<QuotaSourceResult> | null;
  settled: { result: QuotaSourceResult; expiresAtMs: number } | null;
}

const cache = new Map<string, CacheEntry>();

export function __resetUsageCacheForTest(): void {
  cache.clear();
}

function errorResult(
  base: Omit<QuotaSourceBase, "fetchedAt">,
  nowMs: number,
  error: QuotaErrorKind,
  httpStatus: number | null = null,
): QuotaSourceResult {
  return {
    ...base,
    fetchedAt: new Date(nowMs).toISOString(),
    status: "error",
    error,
    message: ERROR_MESSAGES[error],
    httpStatus,
  };
}

async function requestQuota(
  deps: UsageReportDeps,
  base: Omit<QuotaSourceBase, "fetchedAt">,
  url: string,
  headers: Record<string, string>,
  parse: (body: unknown) => { plan: string | null; windows: QuotaWindow[] } | null,
  fallbackPlan: string | null,
): Promise<FetchOutcome> {
  const fail = (
    error: QuotaErrorKind,
    httpStatus: number | null = null,
    retryAfterS = null as number | null,
  ) => ({
    result: errorResult(base, deps.nowMs, error, httpStatus),
    retryAfterS,
  });
  let response: Response;
  try {
    response = await deps.fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "spur", ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return fail("network_error");
  }
  if (!response.ok) await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403)
    return fail("unauthorized", response.status);
  if (response.status === 429) {
    const seconds = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    const retryAfterS =
      Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_S) : null;
    return fail("rate_limited", 429, retryAfterS);
  }
  if (!response.ok) return fail("http_error", response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fail("unparsable");
  }
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(body);
  } catch {
    return fail("unparsable");
  }
  if (!parsed) return fail("unparsable");
  return {
    result: {
      ...base,
      fetchedAt: new Date(deps.nowMs).toISOString(),
      status: "ok",
      plan: parsed.plan ?? fallbackPlan,
      windows: parsed.windows,
    },
    retryAfterS: null,
  };
}

function cached(
  key: string,
  nowMs: number,
  run: () => Promise<FetchOutcome>,
): Promise<QuotaSourceResult> {
  const entry = cache.get(key);
  if (entry?.inflight) return entry.inflight;
  if (entry?.settled && entry.settled.expiresAtMs > nowMs)
    return Promise.resolve(entry.settled.result);
  const next: CacheEntry = { inflight: null, settled: entry?.settled ?? null };
  next.inflight = run()
    .then((outcome) => {
      const holdMs = outcome.retryAfterS === null ? CACHE_TTL_MS : outcome.retryAfterS * 1000;
      next.settled = { result: outcome.result, expiresAtMs: nowMs + holdMs };
      return outcome.result;
    })
    .finally(() => {
      next.inflight = null;
    });
  cache.set(key, next);
  return next.inflight;
}

// ---- sources ----

async function claudeSource(
  deps: UsageReportDeps,
  account: ClaudeAccount,
  boundSessionIds: readonly string[],
  fresh = false,
): Promise<QuotaSourceResult> {
  const base = {
    provider: "claude" as const,
    source: account.id,
    label: account.label ?? account.id,
  };
  const paths = [
    join(account.configDir, ".credentials.json"),
    ...boundSessionIds.map((id) =>
      join(sessionClaudeHome(join(deps.dataDir, "session-tools", id)), ".credentials.json"),
    ),
  ];
  const found = (await Promise.all(paths.map(readClaudeCredential))).filter(
    (credential): credential is ClaudeCredential => credential !== null,
  );
  if (found.length === 0) return errorResult(base, deps.nowMs, "no_credentials");
  const best = found.reduce((a, b) =>
    (b.expiresAt ?? -Infinity) > (a.expiresAt ?? -Infinity) ? b : a,
  );
  if (best.expiresAt !== null && best.expiresAt <= deps.nowMs)
    return errorResult(base, deps.nowMs, "expired");
  const fetchQuota = () =>
    requestQuota(
      deps,
      base,
      CLAUDE_URL,
      { Authorization: `Bearer ${best.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      (body) => {
        const windows = parseClaudeUsage(body);
        return windows ? { plan: null, windows } : null;
      },
      best.plan,
    );
  return fresh ? (await fetchQuota()).result : cached(`claude:${account.id}`, deps.nowMs, fetchQuota);
}

async function codexSource(deps: UsageReportDeps, fresh = false): Promise<QuotaSourceResult> {
  const base = { provider: "codex" as const, source: "codex", label: "codex" };
  const credential = await readCodexCredential(deps.homeDir);
  if (!credential) return errorResult(base, deps.nowMs, "no_credentials");
  const headers: Record<string, string> = { Authorization: `Bearer ${credential.accessToken}` };
  if (credential.accountId !== null) headers["ChatGPT-Account-Id"] = credential.accountId;
  const fetchQuota = () => requestQuota(deps, base, CODEX_URL, headers, parseCodexUsage, null);
  return fresh ? (await fetchQuota()).result : cached("codex:codex", deps.nowMs, fetchQuota);
}

export async function readFreshSessionQuota(
  deps: UsageReportDeps,
  session: { id: string; agent: string; claudeAccountId?: string },
): Promise<QuotaSourceResult | null> {
  if (session.agent === "codex") return codexSource(deps, true);
  if (session.agent !== "claude") return null;
  const accountId = session.claudeAccountId ?? "default";
  const account = claudeAccounts(deps.dataDir).find((item) => item.id === accountId) ??
    (accountId === "default"
      ? { id: "default", configDir: join(deps.homeDir, ".claude"), createdAt: "" }
      : null);
  if (!account) return null;
  const boundSessionIds = safeListSessions(deps.dataDir)
    .filter((candidate) => candidate.claudeAccountId === accountId)
    .map((candidate) => candidate.id);
  return claudeSource(deps, account, boundSessionIds, true);
}

function claudeAccounts(dataDir: string): ClaudeAccount[] {
  try {
    return listAccounts(dataDir);
  } catch {
    return [];
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function tokenActivity(
  deps: UsageReportDeps,
  sessions: ReturnType<typeof listSessions>,
): Promise<TokenUsageActivity[]> {
  const entries = await Promise.all(
    sessions.map(async (session): Promise<TokenUsageActivity | null> => {
      if (!session.tokenUsage) return null;
      let mtimeMs = Number.NaN;
      try {
        mtimeMs = (await stat(sessionFilePath(deps.dataDir, session.project, session.id))).mtimeMs;
      } catch {
        // updatedAt alone
      }
      const updatedMs = Date.parse(session.updatedAt);
      const activityMs = Math.max(
        Number.isFinite(updatedMs) ? updatedMs : -Infinity,
        Number.isFinite(mtimeMs) ? mtimeMs : -Infinity,
      );
      if (!Number.isFinite(activityMs)) return null;
      return { tokenUsage: session.tokenUsage, model: session.model ?? null, activityMs };
    }),
  );
  return entries.filter((entry): entry is TokenUsageActivity => entry !== null);
}

function safeListSessions(dataDir: string): ReturnType<typeof listSessions> {
  try {
    return listSessions(dataDir);
  } catch {
    return [];
  }
}

export async function buildUsageReport(deps: UsageReportDeps): Promise<UsageReport> {
  const sessions = safeListSessions(deps.dataDir);
  const accounts = claudeAccounts(deps.dataDir);
  const defaultDir = join(deps.homeDir, ".claude");
  if (
    !accounts.some((account) => account.configDir === defaultDir) &&
    (await fileExists(join(defaultDir, ".credentials.json")))
  ) {
    accounts.unshift({ id: "default", label: "default", configDir: defaultDir, createdAt: "" });
  }
  const [quotas, tokens] = await Promise.all([
    Promise.all([
      ...accounts.map((account) =>
        claudeSource(
          deps,
          account,
          sessions.filter((s) => s.claudeAccountId === account.id).map((s) => s.id),
        ),
      ),
      codexSource(deps),
    ]),
    tokenActivity(deps, sessions),
  ]);
  return {
    generatedAt: new Date(deps.nowMs).toISOString(),
    quotas,
    tokens: summarizeTokenUsageWindows(tokens, deps.nowMs, deps.todayStartMs),
  };
}
