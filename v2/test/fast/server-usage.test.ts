import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { startServer } from "../../src/server.js";
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
