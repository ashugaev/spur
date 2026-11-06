import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeSession } from "../../src/metadata.js";
import {
  __resetUsageCacheForTest,
  buildUsageReport,
  parseClaudeUsage,
  parseCodexUsage,
  type UsageReportDeps,
} from "../../src/usage-report.js";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const TODAY = Date.parse("2026-11-06T00:00:00.000Z");
const FUTURE = NOW + 3_600_000;
const TOKEN = "sk-fixture-secret-token";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

const CLAUDE_BODY = { five_hour: { utilization: 12, resets_at: "2026-11-06T15:00:00Z" } };
const CODEX_BODY = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1_762_430_400 },
    secondary_window: { used_percent: 5, limit_window_seconds: 604800 },
  },
};

async function writeClaudeCreds(dir: string, expiresAt: number, token = TOKEN): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, ".credentials.json");
  await writeFile(
    path,
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt, subscriptionType: "max" } }),
  );
  return path;
}

async function setup(): Promise<{
  home: string;
  dataDir: string;
  deps: (f: typeof fetch) => UsageReportDeps;
}> {
  const root = await mkdtemp(join(tmpdir(), "spur-usage-"));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  await mkdir(home, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  return {
    home,
    dataDir,
    deps: (f) => ({ fetch: f, homeDir: home, dataDir, nowMs: NOW, todayStartMs: TODAY }),
  };
}

function session(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    project: "demo",
    agent: "claude",
    prompt: "p",
    branch: "b",
    worktree: false,
    worktreePath: "/tmp/x",
    tmuxSession: id,
    launchCommand: "claude",
    status: "stopped",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  } as unknown as Parameters<typeof writeSession>[1];
}

beforeEach(() => {
  __resetUsageCacheForTest();
});

describe("parseClaudeUsage", () => {
  it("maps buckets and limits per field; null bucket takes limit data", () => {
    const windows = parseClaudeUsage({
      five_hour: null,
      seven_day: { utilization: 40, resets_at: null },
      limits: [
        { kind: "session", percent: 7, resets_at: "2026-11-06T15:00:00Z" },
        { kind: "weekly_all", percent: 99, resets_at: "2026-11-10T00:00:00Z" },
      ],
    });
    expect(windows).toEqual([
      { label: "5h", usedPercent: 7, remainingPercent: 93, resetsAt: "2026-11-06T15:00:00Z" },
      { label: "weekly", usedPercent: 40, remainingPercent: 60, resetsAt: "2026-11-10T00:00:00Z" },
    ]);
  });

  it("null bucket without usable limit is 0%; absent bucket with placeholder limit has no window", () => {
    expect(parseClaudeUsage({ five_hour: null, seven_day: null })).toEqual([
      { label: "5h", usedPercent: 0, remainingPercent: 100, resetsAt: null },
      { label: "weekly", usedPercent: 0, remainingPercent: 100, resetsAt: null },
    ]);
    expect(
      parseClaudeUsage({
        five_hour: { utilization: 1, resets_at: null },
        limits: [{ kind: "weekly_all", percent: 0, resets_at: null }],
      })?.map((w) => w.label),
    ).toEqual(["5h"]);
  });

  it("scoped opus replaces legacy weekly Opus and inherits its reset; long names do not match", () => {
    const windows = parseClaudeUsage({
      seven_day: { utilization: 1, resets_at: null },
      seven_day_opus: { utilization: 10, resets_at: "2026-11-09T00:00:00Z" },
      limits: [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 55,
          resets_at: null,
          scope: { model: { display_name: "opus" } },
        },
        { kind: "weekly_scoped", percent: 3, scope: { model: { display_name: "Claude Opus 4" } } },
        { kind: "weekly_scoped", percent: 9, scope: { model: { display_name: "All models" } } },
      ],
    });
    expect(windows?.map((w) => [w.label, w.usedPercent, w.resetsAt])).toEqual([
      ["weekly", 1, null],
      ["weekly opus", 55, "2026-11-09T00:00:00Z"],
      ["weekly Claude Opus 4", 3, null],
    ]);
  });

  it("folds scoped duplicates by id then name; active wins", () => {
    const windows = parseClaudeUsage({
      limits: [
        { kind: "weekly_scoped", percent: 1, scope: { model: { id: "m1", display_name: "A" } } },
        {
          kind: "weekly_scoped",
          percent: 2,
          is_active: true,
          scope: { model: { id: "M1", display_name: "B" } },
        },
        { kind: "weekly_scoped", percent: 3, scope: { model: { display_name: "b" } } },
      ],
    });
    expect(windows?.map((w) => [w.label, w.usedPercent])).toEqual([["weekly B", 2]]);
  });

  it("clamps percent and rejects unknown shapes", () => {
    expect(parseClaudeUsage({ five_hour: { utilization: 250 } })?.[0]?.usedPercent).toBe(100);
    expect(parseClaudeUsage({ other: 1 })).toBeNull();
    expect(parseClaudeUsage([])).toBeNull();
    expect(parseClaudeUsage(null)).toBeNull();
  });
});

describe("parseCodexUsage", () => {
  it("maps primary, secondary and additional windows", () => {
    const parsed = parseCodexUsage({
      ...CODEX_BODY,
      additional_rate_limits: [
        {
          limit_name: "spark",
          rate_limit: {
            primary_window: { used_percent: 1, limit_window_seconds: 7200, resets_at: 0 },
          },
        },
      ],
    });
    expect(parsed?.plan).toBe("plus");
    expect(parsed?.windows.map((w) => w.label)).toEqual(["5h", "weekly", "spark 2h"]);
    expect(parsed?.windows[0]?.resetsAt).toBe(new Date(1_762_430_400_000).toISOString());
    expect(parsed?.windows[1]?.resetsAt).toBeNull();
  });

  it("rejects unknown shapes", () => {
    expect(parseCodexUsage({ plan_type: "x" })).toBeNull();
    expect(parseCodexUsage("x")).toBeNull();
  });
});

describe("buildUsageReport quotas", () => {
  it("fetches Claude default and Codex with exact urls and headers", async () => {
    const s = await setup();
    await writeClaudeCreds(join(s.home, ".claude"), FUTURE);
    await mkdir(join(s.home, ".codex"), { recursive: true });
    await writeFile(
      join(s.home, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: "cx-token", account_id: "acct" } }),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("anthropic") ? json(CLAUDE_BODY) : json(CODEX_BODY),
    );
    const report = await buildUsageReport(s.deps(fetchMock as unknown as typeof fetch));
    expect(report.quotas.map((q) => [q.provider, q.source, q.status])).toEqual([
      ["claude", "default", "ok"],
      ["codex", "codex", "ok"],
    ]);
    const claudeCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("anthropic"));
    expect(String(claudeCall?.[0])).toBe("https://api.anthropic.com/api/oauth/usage");
    const claudeInit = (claudeCall as unknown as [string, RequestInit])[1];
    expect(claudeInit.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "spur",
    });
    expect(claudeInit.signal).toBeInstanceOf(AbortSignal);
    const codexCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("chatgpt"));
    expect(String(codexCall?.[0])).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect((codexCall as unknown as [string, RequestInit])[1].headers).toMatchObject({
      Authorization: "Bearer cx-token",
      "ChatGPT-Account-Id": "acct",
    });
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(JSON.stringify(report)).not.toContain("cx-token");
    expect(JSON.stringify(report)).not.toContain(s.home);
  });

  it("no_credentials and expired send no request", async () => {
    const s = await setup();
    const fetchMock = vi.fn();
    let report = await buildUsageReport(s.deps(fetchMock as unknown as typeof fetch));
    expect(report.quotas.map((q) => q.status === "error" && q.error)).toEqual(["no_credentials"]);
    await writeClaudeCreds(join(s.home, ".claude"), NOW - 1);
    report = await buildUsageReport(s.deps(fetchMock as unknown as typeof fetch));
    expect(report.quotas.map((q) => q.status === "error" && q.error)).toEqual([
      "expired",
      "no_credentials",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [429, "rate_limited"],
    [500, "http_error"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const s = await setup();
    await writeClaudeCreds(join(s.home, ".claude"), FUTURE);
    const fetchMock = vi.fn(async () => new Response("body-secret", { status }));
    const report = await buildUsageReport(s.deps(fetchMock as unknown as typeof fetch));
    const q = report.quotas[0];
    expect(q?.status === "error" && [q.error, q.httpStatus]).toEqual([kind, status]);
    expect(JSON.stringify(report)).not.toContain("body-secret");
  });

  it("maps throw to network_error and bad bodies to unparsable", async () => {
    const s = await setup();
    await writeClaudeCreds(join(s.home, ".claude"), FUTURE);
    let report = await buildUsageReport(
      s.deps((async () => {
        throw new Error(`boom ${TOKEN}`);
      }) as unknown as typeof fetch),
    );
    expect(report.quotas[0]).toMatchObject({ status: "error", error: "network_error" });
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    __resetUsageCacheForTest();
    report = await buildUsageReport(
      s.deps((async () => new Response("not json")) as unknown as typeof fetch),
    );
    expect(report.quotas[0]).toMatchObject({ error: "unparsable" });
    __resetUsageCacheForTest();
    report = await buildUsageReport(
      s.deps((async () => json({ x: 1 })) as unknown as typeof fetch),
    );
    expect(report.quotas[0]).toMatchObject({ error: "unparsable" });
  });

  it("uses the freshest token among account configDir and bound session homes, writing nothing", async () => {
    const s = await setup();
    const accountDir = join(s.home, "acct-a");
    const stalePath = await writeClaudeCreds(accountDir, NOW - 1, "stale-token");
    const homePath = await writeClaudeCreds(
      join(s.dataDir, "session-tools", "sess-1", "claude-home"),
      FUTURE,
      "fresh-token",
    );
    await writeFile(
      join(s.dataDir, "claude-accounts.json"),
      JSON.stringify([
        { id: "a", label: "Acct A", configDir: accountDir, createdAt: "2026-01-01T00:00:00Z" },
      ]),
    );
    writeSession(s.dataDir, session("sess-1", { claudeAccountId: "a" }));
    const before = await Promise.all(
      [stalePath, homePath].map(async (p) => [await readFile(p, "utf8"), (await stat(p)).mtimeMs]),
    );
    const fetchMock = vi.fn(async () => json(CLAUDE_BODY));
    const report = await buildUsageReport(s.deps(fetchMock as unknown as typeof fetch));
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ Authorization: "Bearer fresh-token" });
    expect(report.quotas[0]).toMatchObject({
      source: "a",
      label: "Acct A",
      status: "ok",
      plan: "max",
    });
    const after = await Promise.all(
      [stalePath, homePath].map(async (p) => [await readFile(p, "utf8"), (await stat(p)).mtimeMs]),
    );
    expect(after).toEqual(before);
  });

  it("caches within 180 s, shares in-flight requests, holds 429 per Retry-After", async () => {
    const s = await setup();
    await writeClaudeCreds(join(s.home, ".claude"), FUTURE);
    const fetchMock = vi.fn(async () => json(CLAUDE_BODY));
    const f = fetchMock as unknown as typeof fetch;
    await Promise.all([buildUsageReport(s.deps(f)), buildUsageReport(s.deps(f))]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const again = await buildUsageReport({ ...s.deps(f), nowMs: NOW + 179_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.quotas[0]?.fetchedAt).toBe(new Date(NOW).toISOString());
    await buildUsageReport({ ...s.deps(f), nowMs: NOW + 181_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    __resetUsageCacheForTest();
    const limited = vi.fn(
      async () => new Response("", { status: 429, headers: { "retry-after": "600" } }),
    );
    const lf = limited as unknown as typeof fetch;
    await buildUsageReport(s.deps(lf));
    await buildUsageReport({ ...s.deps(lf), nowMs: NOW + 500_000 });
    expect(limited).toHaveBeenCalledTimes(1);
    await buildUsageReport({ ...s.deps(lf), nowMs: NOW + 601_000 });
    expect(limited).toHaveBeenCalledTimes(2);
  });
});

describe("buildUsageReport tokens", () => {
  it("dates sessions by max(updatedAt, record mtime)", async () => {
    const s = await setup();
    const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };
    const tokenUsage = { provider: "claude", generations: { g: usage }, ...usage };
    writeSession(
      s.dataDir,
      session("old", { updatedAt: "2026-10-01T00:00:00.000Z", tokenUsage, model: "opus" }),
    );
    writeSession(s.dataDir, session("plain", { updatedAt: "2026-10-01T00:00:00.000Z" }));
    const fixed = new Date(NOW - 60_000);
    await utimes(join(s.dataDir, "sessions", "demo", "old.json"), fixed, fixed);
    const report = await buildUsageReport(s.deps(vi.fn() as unknown as typeof fetch));
    const today = report.tokens.find((w) => w.window === "today");
    expect(today?.byProvider[0]).toMatchObject({
      provider: "claude",
      sessionCount: 1,
      byModel: [{ model: "opus", totals: { totalTokens: 10 } }],
    });

    const stale = new Date(NOW - 10 * 86_400_000);
    await utimes(join(s.dataDir, "sessions", "demo", "old.json"), stale, stale);
    const later = await buildUsageReport(s.deps(vi.fn() as unknown as typeof fetch));
    expect(later.tokens.find((w) => w.window === "today")?.byProvider).toEqual([]);
    expect(later.tokens.find((w) => w.window === "30d")?.byProvider[0]?.sessionCount).toBe(1);
  });
});
