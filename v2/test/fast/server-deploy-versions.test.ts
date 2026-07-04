import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetReleasesCacheForTest } from "../../src/releases-cache.js";
import { startServer } from "../../src/server.js";
import { findFreePort } from "../helpers/common.js";

interface DeployVersionsResponse {
  current: string;
  available: Array<{ tag: string; publishedAt: string; channel: string }>;
  stale?: boolean;
  registryError?: string;
  switchState?: Record<string, unknown>;
}

function isDeployVersionsResponse(value: unknown): value is DeployVersionsResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { current?: unknown; available?: unknown };
  return typeof v.current === "string" && Array.isArray(v.available);
}

async function setupConfig(port: number): Promise<{ configPath: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "spur-deploy-versions-"));
  const repoDir = join(root, "repo");
  const dataDir = join(root, "data");
  const worktreeDir = join(root, "worktrees");
  await mkdir(repoDir, { recursive: true });
  const configPath = join(root, "spur.yaml");
  await writeFile(
    configPath,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      `dataDir: ${dataDir}`,
      `worktreeDir: ${worktreeDir}`,
      "projects:",
      "  demo:",
      `    path: ${repoDir}`,
    ].join("\n"),
    "utf8",
  );
  return { configPath, dataDir };
}

describe("GET /deploy/versions", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    __resetReleasesCacheForTest();
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns current version and sorted available releases", async () => {
    const registryDoc = {
      versions: { "0.1.0": {}, "0.2.0": {}, "1.0.0-beta.1": {} },
      time: {
        "0.1.0": "2026-01-01T00:00:00.000Z",
        "0.2.0": "2026-02-01T00:00:00.000Z",
        "1.0.0-beta.1": "2026-03-01T00:00:00.000Z",
      },
    };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(registryDoc), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const port = await findFreePort();
    const { configPath } = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });

    try {
      // Use the real network fetch to talk to the local daemon by temporarily
      // restoring it. The daemon's own /deploy/versions call already happened
      // in-process and was mocked above.
      const realFetch = originalFetch.bind(globalThis);
      const response = await realFetch(`http://127.0.0.1:${port}/deploy/versions`);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(isDeployVersionsResponse(body)).toBe(true);
      if (!isDeployVersionsResponse(body)) throw new Error("unreachable");
      expect(typeof body.current).toBe("string");
      expect(body.available.map((entry) => entry.tag)).toEqual(["0.2.0", "0.1.0"]);
      expect(body.available.map((entry) => entry.channel)).toEqual(["stable", "stable"]);
      expect(body.switchState).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it("includes alpha channel entries and the switch state without its pid", async () => {
    const registryDoc = {
      versions: { "0.2.0": {}, "0.3.0-alpha.1": {} },
      time: {
        "0.2.0": "2026-02-01T00:00:00.000Z",
        "0.3.0-alpha.1": "2026-03-01T00:00:00.000Z",
      },
    };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(registryDoc), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const port = await findFreePort();
    const { configPath, dataDir } = await setupConfig(port);
    await mkdir(join(dataDir, "deploy"), { recursive: true });
    await writeFile(
      join(dataDir, "deploy", "switch-state.json"),
      JSON.stringify({
        phase: "rolled_back",
        from: "0.1.0",
        to: "0.2.0",
        startedAt: "2026-07-04T12:00:00Z",
        finishedAt: "2026-07-04T12:01:30Z",
        error: "healthcheck timeout after 60s",
        pid: 4242,
      }),
      "utf8",
    );
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });

    try {
      const realFetch = originalFetch.bind(globalThis);
      const response = await realFetch(`http://127.0.0.1:${port}/deploy/versions`);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(isDeployVersionsResponse(body)).toBe(true);
      if (!isDeployVersionsResponse(body)) throw new Error("unreachable");
      expect(body.available.map((entry) => [entry.tag, entry.channel])).toEqual([
        ["0.3.0-alpha.1", "alpha"],
        ["0.2.0", "stable"],
      ]);
      expect(body.switchState).toEqual({
        phase: "rolled_back",
        from: "0.1.0",
        to: "0.2.0",
        startedAt: "2026-07-04T12:00:00Z",
        finishedAt: "2026-07-04T12:01:30Z",
        error: "healthcheck timeout after 60s",
      });
    } finally {
      await server.stop();
    }
  });

  it("returns 200 with empty available and registryError on registry failure", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));

    const port = await findFreePort();
    const { configPath } = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });

    try {
      const realFetch = originalFetch.bind(globalThis);
      const response = await realFetch(`http://127.0.0.1:${port}/deploy/versions`);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(isDeployVersionsResponse(body)).toBe(true);
      if (!isDeployVersionsResponse(body)) throw new Error("unreachable");
      expect(body.available).toEqual([]);
      expect(body.registryError).toBe("network down");
    } finally {
      await server.stop();
    }
  });
});
