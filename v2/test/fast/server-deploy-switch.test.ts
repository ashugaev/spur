import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetReleasesCacheForTest } from "../../src/releases-cache.js";
import { findFreePort } from "../helpers/common.js";

interface DeploySwitchSuccess {
  accepted: true;
  version: string;
}

interface DeploySwitchError {
  error: string;
}

function isDeploySwitchSuccess(value: unknown): value is DeploySwitchSuccess {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { accepted?: unknown; version?: unknown };
  return v.accepted === true && typeof v.version === "string";
}

function isDeploySwitchError(value: unknown): value is DeploySwitchError {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { error?: unknown }).error === "string";
}

interface SpawnCall {
  command: string;
  args: ReadonlyArray<string>;
  detached: boolean;
}

const spawnCalls: SpawnCall[] = [];
let unrefCount = 0;
let currentVersion = "0.1.0";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return {
    ...actual,
    spawn: (
      command: string,
      args: ReadonlyArray<string>,
      options: { detached?: boolean; stdio?: unknown },
    ) => {
      spawnCalls.push({
        command,
        args: [...args],
        detached: options.detached === true,
      });
      const fake = new EventEmitter() as EventEmitter & { unref: () => void };
      fake.unref = () => {
        unrefCount += 1;
      };
      return fake;
    },
  };
});

vi.mock("../../src/version.js", () => ({
  getVersion: () => currentVersion,
}));

async function setupConfig(port: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spur-deploy-switch-"));
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
  return configPath;
}

function registryResponse(versions: ReadonlyArray<string>): Response {
  const doc = {
    versions: Object.fromEntries(versions.map((v) => [v, {}])),
    time: Object.fromEntries(versions.map((v) => [v, "2026-01-01T00:00:00.000Z"])),
  };
  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("POST /deploy/switch", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    __resetReleasesCacheForTest();
    spawnCalls.length = 0;
    unrefCount = 0;
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    delete process.env["SPUR_DEPLOY_SWITCH_FORCE"];
    currentVersion = "0.1.0";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env["SPUR_DEPLOY_SWITCH_FORCE"];
  });

  it("rejects malformed version body with 400", async () => {
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const realFetch = originalFetch.bind(globalThis);
      const response = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "not-a-version" }),
      });
      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      expect(isDeploySwitchError(body)).toBe(true);
      if (!isDeploySwitchError(body)) throw new Error("unreachable");
      expect(body.error).toBe("invalid version");
      expect(spawnCalls).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("returns 409 when running from a source checkout", async () => {
    fetchSpy.mockResolvedValueOnce(registryResponse(["0.2.0", "0.1.0"]));
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const realFetch = originalFetch.bind(globalThis);
      const response = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.2.0" }),
      });
      expect(response.status).toBe(409);
      const body: unknown = await response.json();
      expect(isDeploySwitchError(body)).toBe(true);
      if (!isDeploySwitchError(body)) throw new Error("unreachable");
      expect(body.error).toBe("running from source checkout");
      expect(spawnCalls).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("rejects an unknown version with 400 when forced", async () => {
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
    fetchSpy.mockResolvedValueOnce(registryResponse(["0.2.0", "0.1.0"]));
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const realFetch = originalFetch.bind(globalThis);
      const response = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "9.9.9" }),
      });
      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      expect(isDeploySwitchError(body)).toBe(true);
      if (!isDeploySwitchError(body)) throw new Error("unreachable");
      expect(body.error).toBe("version not in registry");
      expect(spawnCalls).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("returns 503 when the registry is unreachable with a cold cache", async () => {
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const realFetch = originalFetch.bind(globalThis);
      const response = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.2.0" }),
      });
      expect(response.status).toBe(503);
      const body: unknown = await response.json();
      expect(isDeploySwitchError(body)).toBe(true);
      if (!isDeploySwitchError(body)) throw new Error("unreachable");
      expect(body.error).toBe("npm registry unreachable");
      expect(spawnCalls).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("spawns the helper detached and returns 202 on a valid version", async () => {
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
    fetchSpy.mockResolvedValueOnce(registryResponse(["0.2.0", "0.1.0"]));
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const realFetch = originalFetch.bind(globalThis);
      const response = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.2.0" }),
      });
      expect(response.status).toBe(202);
      const body: unknown = await response.json();
      expect(isDeploySwitchSuccess(body)).toBe(true);
      if (!isDeploySwitchSuccess(body)) throw new Error("unreachable");
      expect(body.version).toBe("0.2.0");
      expect(spawnCalls).toHaveLength(1);
      const [call] = spawnCalls;
      if (!call) throw new Error("expected spawn call");
      expect(call.command).toBe("bash");
      expect(call.detached).toBe(true);
      expect(call.args).toHaveLength(2);
      expect(call.args[0]).toMatch(/scripts\/install-and-restart\.sh$/);
      expect(call.args[1]).toBe("0.2.0");
      expect(unrefCount).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it("returns 202 without spawning the helper when the version is already current", async () => {
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
    currentVersion = "0.2.0";
    fetchSpy.mockResolvedValueOnce(registryResponse(["0.2.0", "0.1.0"]));
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const realFetch = originalFetch.bind(globalThis);
      const response = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.2.0" }),
      });
      expect(response.status).toBe(202);
      const body: unknown = await response.json();
      expect(isDeploySwitchSuccess(body)).toBe(true);
      if (!isDeploySwitchSuccess(body)) throw new Error("unreachable");
      expect(body.version).toBe("0.2.0");
      expect(spawnCalls).toEqual([]);
      expect(unrefCount).toBe(0);
    } finally {
      await server.stop();
    }
  });
});
