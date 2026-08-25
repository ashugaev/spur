import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetReleasesCacheForTest } from "../../src/releases-cache.js";
import { startServer } from "../../src/server.js";
import { findFreePort } from "../helpers/common.js";

interface DeployVersionsResponse {
  current: string;
  available: Array<{ tag: string; publishedAt: string }>;
  autoUpdate: boolean;
  stale?: boolean;
  registryError?: string;
  updateFailure?: { version: string; failureKind: string; initiator: string };
}

function isDeployVersionsResponse(value: unknown): value is DeployVersionsResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { current?: unknown; available?: unknown; autoUpdate?: unknown };
  return (
    typeof v.current === "string" && Array.isArray(v.available) && typeof v.autoUpdate === "boolean"
  );
}

async function setupConfig(port: number, autoUpdate?: boolean): Promise<string> {
  return (await setupInstance(port, autoUpdate)).configPath;
}

async function setupInstance(
  port: number,
  autoUpdate?: boolean,
): Promise<{ configPath: string; dataDir: string }> {
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
      ...(autoUpdate === undefined ? [] : [`autoUpdate: ${autoUpdate}`]),
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
    const configPath = await setupConfig(port);
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
      expect(body.autoUpdate).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("carries autoUpdate: true when the config sets the key", async () => {
    const registryDoc = {
      versions: { "0.1.0": {} },
      time: { "0.1.0": "2026-01-01T00:00:00.000Z" },
    };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(registryDoc), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const port = await findFreePort();
    const configPath = await setupConfig(port, true);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });

    try {
      const realFetch = originalFetch.bind(globalThis);
      const response = await realFetch(`http://127.0.0.1:${port}/deploy/versions`);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(isDeployVersionsResponse(body)).toBe(true);
      if (!isDeployVersionsResponse(body)) throw new Error("unreachable");
      expect(body.autoUpdate).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("returns 200 with empty available and registryError on registry failure", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));

    const port = await findFreePort();
    const configPath = await setupConfig(port);
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

  describe("updateFailure", () => {
    // Terminal records differ only in the two fields the notice is derived
    // from, so one seeded record per row is the whole input.
    const TERMINAL = {
      version: "0.67.2",
      pid: 4242,
      startedAt: "2026-08-24T15:17:00Z",
      finishedAt: "2026-08-24T15:17:02Z",
      exitCode: 1,
      initiator: "auto",
    } as const;

    async function readVersions(record: unknown): Promise<DeployVersionsResponse> {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ versions: {}, time: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const port = await findFreePort();
      const { configPath, dataDir } = await setupInstance(port);
      await mkdir(dataDir, { recursive: true });
      const statePath = join(dataDir, "deploy-switch.json");
      if (record !== null) {
        await writeFile(statePath, `${JSON.stringify(record)}\n`, "utf8");
      }
      const server = await startServer(configPath, {
        info: () => undefined,
        warn: () => undefined,
      });
      try {
        const realFetch = originalFetch.bind(globalThis);
        const response = await realFetch(`http://127.0.0.1:${port}/deploy/versions`);
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        if (!isDeployVersionsResponse(body)) throw new Error("unexpected versions payload");
        return body;
      } finally {
        await server.stop();
      }
    }

    it("names the version and kind for a rolled-back record", async () => {
      const body = await readVersions({ ...TERMINAL, phase: "failed", failureKind: "rolled_back" });

      expect(body.updateFailure).toEqual({
        version: "0.67.2",
        failureKind: "rolled_back",
        initiator: "auto",
      });
    });

    it("names the version and kind for an unhealthy install that was not rolled back", async () => {
      const body = await readVersions({
        ...TERMINAL,
        phase: "failed",
        failureKind: "install_unhealthy",
      });

      expect(body.updateFailure).toEqual({
        version: "0.67.2",
        failureKind: "install_unhealthy",
        initiator: "auto",
      });
    });

    it("carries the initiator, so the UI can tell a disarm from a manual rollback", async () => {
      const body = await readVersions({
        ...TERMINAL,
        initiator: "manual",
        phase: "failed",
        failureKind: "rolled_back",
      });

      expect(body.updateFailure).toEqual({
        version: "0.67.2",
        failureKind: "rolled_back",
        initiator: "manual",
      });
    });

    it("stays absent for a failure the tick will retry, a success, and no record at all", async () => {
      const retryable = await readVersions({
        ...TERMINAL,
        phase: "failed",
        failureKind: "install_failed",
      });
      const noKind = await readVersions({ ...TERMINAL, phase: "failed" });
      const succeeded = await readVersions({ ...TERMINAL, phase: "succeeded", exitCode: 0 });
      const absent = await readVersions(null);

      expect(retryable.updateFailure).toBeUndefined();
      expect(noKind.updateFailure).toBeUndefined();
      expect(succeeded.updateFailure).toBeUndefined();
      expect(absent.updateFailure).toBeUndefined();
    });

    it("stays absent while a switch is running, and the GET writes nothing", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ versions: {}, time: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const port = await findFreePort();
      const { configPath, dataDir } = await setupInstance(port);
      await mkdir(dataDir, { recursive: true });
      const statePath = join(dataDir, "deploy-switch.json");
      // A dead process identity: `reconcileDeploySwitchState` would rewrite
      // this to `failed` on read, so an unchanged file proves the route reads
      // and never reconciles.
      const running = {
        phase: "running",
        version: "0.67.2",
        pid: 4242,
        processStartTime: "1",
        startedAt: "2026-08-24T15:17:00Z",
        initiator: "auto",
      };
      const onDisk = `${JSON.stringify(running)}\n`;
      await writeFile(statePath, onDisk, "utf8");
      const server = await startServer(configPath, {
        info: () => undefined,
        warn: () => undefined,
      });
      try {
        const realFetch = originalFetch.bind(globalThis);
        const response = await realFetch(`http://127.0.0.1:${port}/deploy/versions`);
        const body: unknown = await response.json();
        if (!isDeployVersionsResponse(body)) throw new Error("unexpected versions payload");
        expect(body.updateFailure).toBeUndefined();
        expect(await readFile(statePath, "utf8")).toBe(onDisk);
      } finally {
        await server.stop();
      }
    });
  });
});
