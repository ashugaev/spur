import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_EVENT_LOG_CONFIG, eventLogPath, setEventLogConfig } from "../../src/event-log.js";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { startServer } from "../../src/server.js";
import { SessionService } from "../../src/session-service.js";
import { __resetUsageCacheForTest, type UsageReport } from "../../src/usage-report.js";
import { findFreePort } from "../helpers/common.js";

async function setup(): Promise<{ configPath: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "spur-server-usage-"));
  const repoDir = join(root, "repo");
  const home = join(root, "home");
  await mkdir(repoDir, { recursive: true });
  await mkdir(home, { recursive: true });
  const port = await findFreePort();
  const configPath = join(root, "spur.yaml");
  await writeFile(
    configPath,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      `dataDir: ${join(root, "data")}`,
      `worktreeDir: ${join(root, "worktrees")}`,
      "projects:",
      "  demo:",
      `    path: ${repoDir}`,
    ].join("\n"),
    "utf8",
  );
  return { configPath, home };
}

describe("GET /usage", () => {
  let fetchSpy: Mock<typeof fetch>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    __resetUsageCacheForTest();
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function get(configPath: string): Promise<{ status: number; body: UsageReport }> {
    const port = Number(/port: (\d+)/.exec(await readFile(configPath, "utf8"))?.[1]);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const response = await originalFetch(`http://127.0.0.1:${port}/usage`);
      return { status: response.status, body: (await response.json()) as UsageReport };
    } finally {
      await server.stop();
    }
  }

  it("returns quotas and tokens under a temp HOME with stubbed fetch", async () => {
    const { configPath, home } = await setup();
    vi.stubEnv("HOME", home);
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3_600_000 },
      }),
    );
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ five_hour: { utilization: 20, resets_at: null } }), {
        status: 200,
      }),
    );
    const { status, body } = await get(configPath);
    expect(status).toBe(200);
    expect(body.quotas[0]).toMatchObject({ provider: "claude", source: "default", status: "ok" });
    expect(body.quotas[1]).toMatchObject({ provider: "codex", error: "no_credentials" });
    expect(body.tokens.map((w) => w.window)).toEqual(["today", "7d", "30d"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("passes managed accounts to the report and hides the host row", async () => {
    const { configPath, home } = await setup();
    vi.stubEnv("HOME", home);
    const list = vi.spyOn(SessionService.prototype, "listAuthorizationAccounts").mockResolvedValue({
      accounts: [
        {
          id: "acc-1",
          provider: "codex",
          displayName: "c@example.com",
          credential: "oauth",
          status: "ready",
          quota: {
            leftPercent: 90,
            resetsAt: null,
            windows: [{ label: "5h", usedPercent: 10, remainingPercent: 90, resetsAt: null }],
            fetchedAt: "2026-11-06T11:59:00.000Z",
          },
        },
      ],
      pools: {},
    } as unknown as Awaited<ReturnType<SessionService["listAuthorizationAccounts"]>>);
    const { status, body } = await get(configPath);
    expect(status).toBe(200);
    expect(list).toHaveBeenCalledWith(undefined, { quota: true });
    expect(body.quotas.map((q) => [q.provider, q.source, q.label, q.status])).toEqual([
      ["codex", "acc-1", "c@example.com", "ok"],
    ]);
  });

  it("still returns host rows when the managed account read fails", async () => {
    const { configPath, home } = await setup();
    vi.stubEnv("HOME", home);
    const list = vi
      .spyOn(SessionService.prototype, "listAuthorizationAccounts")
      .mockRejectedValue(new Error("companion down"));
    const port = Number(/port: (\d+)/.exec(await readFile(configPath, "utf8"))?.[1]);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    setEventLogConfig({ ...DEFAULT_EVENT_LOG_CONFIG, collapseWindowMs: 0 });
    const events = async (): Promise<string[]> =>
      (await readFile(eventLogPath(join(dirname(configPath), "data")), "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.includes("usage.managed_accounts.unavailable"));
    try {
      for (let i = 0; i < 2; i += 1) {
        const response = await originalFetch(`http://127.0.0.1:${port}/usage`);
        const body = (await response.json()) as UsageReport;
        expect(response.status).toBe(200);
        expect(body.quotas.map((q) => [q.provider, q.source])).toEqual([["codex", "codex"]]);
      }
      const failed = await events();
      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain("companion down");

      list.mockResolvedValue({ accounts: [], pools: {} });
      await originalFetch(`http://127.0.0.1:${port}/usage`);
      list.mockRejectedValue(new Error("companion down again"));
      await originalFetch(`http://127.0.0.1:${port}/usage`);
      expect(await events()).toHaveLength(2);
    } finally {
      setEventLogConfig(DEFAULT_EVENT_LOG_CONFIG);
      await server.stop();
    }
  });

  it("returns 200 with no_credentials entries and no fetch when nothing is saved", async () => {
    const { configPath, home } = await setup();
    vi.stubEnv("HOME", home);
    const { status, body } = await get(configPath);
    expect(status).toBe(200);
    expect(body.quotas.map((q) => (q.status === "error" ? q.error : "ok"))).toEqual([
      "no_credentials",
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
