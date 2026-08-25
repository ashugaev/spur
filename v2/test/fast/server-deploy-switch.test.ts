import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEventLogCollapse, type SpurLogEntry } from "../../src/event-log.js";
import { __resetReleasesCacheForTest } from "../../src/releases-cache.js";
import { findFreePort } from "../helpers/common.js";

interface DeploySwitchSuccess {
  accepted: true;
  version: string;
  autoUpdate: boolean;
}

interface DeploySwitchError {
  error: string;
}

function isDeploySwitchSuccess(value: unknown): value is DeploySwitchSuccess {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { accepted?: unknown; version?: unknown; autoUpdate?: unknown };
  return v.accepted === true && typeof v.version === "string" && typeof v.autoUpdate === "boolean";
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
const spawnedChildren: EventEmitter[] = [];
let unrefCount = 0;
let currentVersion = "0.1.0";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return {
    ...actual,
    spawn: (
      command: string,
      args: ReadonlyArray<string>,
      options: { detached?: boolean; stdio?: unknown; env?: NodeJS.ProcessEnv },
    ) => {
      spawnCalls.push({
        command,
        args: [...args],
        detached: options.detached === true,
      });
      const fake = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
      fake.pid = process.pid;
      fake.unref = () => {
        unrefCount += 1;
      };
      spawnedChildren.push(fake);
      return fake;
    },
  };
});

vi.mock("../../src/version.js", () => ({
  getVersion: () => currentVersion,
}));

async function setupConfig(port: number, autoUpdate?: boolean): Promise<string> {
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
      ...(autoUpdate === undefined ? [] : [`autoUpdate: ${autoUpdate}`]),
      "projects:",
      "  demo:",
      `    path: ${repoDir}`,
    ].join("\n"),
    "utf8",
  );
  return configPath;
}

async function readLoggedEvents(configPath: string): Promise<SpurLogEntry[]> {
  const raw = await readFile(join(dirname(configPath), "data", "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SpurLogEntry);
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
    spawnedChildren.length = 0;
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

  it("spawns the helper detached, disarms autoUpdate, and returns 202 on a valid version", async () => {
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
    fetchSpy.mockResolvedValueOnce(registryResponse(["0.2.0", "0.1.0"]));
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port, true);
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
      expect(body.autoUpdate).toBe(false);
      expect(spawnCalls).toHaveLength(1);
      const [call] = spawnCalls;
      if (!call) throw new Error("expected spawn call");
      expect(call.command).toBe("bash");
      expect(call.detached).toBe(true);
      expect(call.args).toHaveLength(2);
      expect(call.args[0]).toMatch(/scripts\/install-and-restart\.sh$/);
      expect(call.args[1]).toBe("0.2.0");
      expect(unrefCount).toBe(1);
      const configText = await readFile(configPath, "utf8");
      expect(configText).toContain("autoUpdate: false");
    } finally {
      await server.stop();
    }
  });

  it("returns 202 without spawning the helper when the version is already current, and disarms autoUpdate", async () => {
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
    currentVersion = "0.2.0";
    fetchSpy.mockResolvedValueOnce(registryResponse(["0.2.0", "0.1.0"]));
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port, true);
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
      expect(body.autoUpdate).toBe(false);
      expect(spawnCalls).toEqual([]);
      expect(unrefCount).toBe(0);
      const configText = await readFile(configPath, "utf8");
      expect(configText).toContain("autoUpdate: false");
    } finally {
      await server.stop();
    }
  });

  it("leaves autoUpdate untouched on a 400/409/503 rejection", async () => {
    const port = await findFreePort();
    const configPath = await setupConfig(port, true);

    // 400: malformed version, no SPUR_DEPLOY_SWITCH_FORCE needed.
    {
      const { startServer } = await import("../../src/server.js");
      const server = await startServer(configPath, {
        info: () => undefined,
        warn: () => undefined,
      });
      try {
        const realFetch = originalFetch.bind(globalThis);
        const response = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: "not-a-version" }),
        });
        expect(response.status).toBe(400);
      } finally {
        await server.stop();
      }
    }
    let configText = await readFile(configPath, "utf8");
    expect(configText).toContain("autoUpdate: true");

    // 409: source checkout guard rejects before ever calling the registry
    // (no SPUR_DEPLOY_SWITCH_FORCE, no fetch mock queued).
    {
      const { startServer } = await import("../../src/server.js");
      const server = await startServer(configPath, {
        info: () => undefined,
        warn: () => undefined,
      });
      try {
        const realFetch = originalFetch.bind(globalThis);
        const response = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: "0.2.0" }),
        });
        expect(response.status).toBe(409);
      } finally {
        await server.stop();
      }
    }
    configText = await readFile(configPath, "utf8");
    expect(configText).toContain("autoUpdate: true");

    // 503: registry unreachable, forced past the source-checkout guard.
    {
      process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
      fetchSpy.mockRejectedValueOnce(new Error("network down"));
      const { startServer } = await import("../../src/server.js");
      const server = await startServer(configPath, {
        info: () => undefined,
        warn: () => undefined,
      });
      try {
        const realFetch = originalFetch.bind(globalThis);
        const response = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: "0.2.0" }),
        });
        expect(response.status).toBe(503);
      } finally {
        await server.stop();
      }
    }
    configText = await readFile(configPath, "utf8");
    expect(configText).toContain("autoUpdate: true");
  });

  it("rejects an overlapping switch while the helper is still running", async () => {
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
    fetchSpy.mockResolvedValue(registryResponse(["0.3.0", "0.2.0", "0.1.0"]));
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const realFetch = originalFetch.bind(globalThis);
      const first = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.2.0" }),
      });
      expect(first.status).toBe(202);

      const second = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.3.0" }),
      });
      expect(second.status).toBe(409);
      const secondBody: unknown = await second.json();
      expect(isDeploySwitchError(secondBody)).toBe(true);
      if (!isDeploySwitchError(secondBody)) throw new Error("unreachable");
      expect(secondBody.error).toBe("deploy switch already in progress for 0.2.0");
      expect(spawnCalls).toHaveLength(1);

      spawnedChildren[0]?.emit("exit", 0);
      const third = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.3.0" }),
      });
      expect(third.status).toBe(202);
      expect(spawnCalls).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });

  it("retains the active target across a daemon restart and exposes terminal status", async () => {
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
    fetchSpy.mockResolvedValue(registryResponse(["0.2.0", "0.1.0"]));
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    let server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    const realFetch = originalFetch.bind(globalThis);
    try {
      const first = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.2.0" }),
      });
      expect(first.status).toBe(202);
      await server.stop();

      server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
      const overlap = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.1.0" }),
      });
      expect(overlap.status).toBe(409);
      await expect(overlap.json()).resolves.toEqual(
        expect.objectContaining({ inProgress: true, version: "0.2.0" }),
      );

      spawnedChildren[0]?.emit("exit", 0);
      const status = await realFetch(`http://127.0.0.1:${port}/deploy/switch/status`);
      await expect(status.json()).resolves.toEqual(
        expect.objectContaining({
          phase: "succeeded",
          version: "0.2.0",
          exitCode: 0,
          initiator: "manual",
        }),
      );
    } finally {
      await server.stop();
    }
  });

  it("logs daemon.deploy_switch.started with initiator manual", async () => {
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
    fetchSpy.mockResolvedValue(registryResponse(["0.2.0", "0.1.0"]));
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const realFetch = originalFetch.bind(globalThis);
      const accepted = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.2.0" }),
      });
      expect(accepted.status).toBe(202);

      const events = await readLoggedEvents(configPath);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "daemon.deploy_switch.started",
            level: "info",
            details: { version: "0.2.0", status: "accepted", initiator: "manual" },
          }),
        ]),
      );
    } finally {
      await server.stop();
    }
  });

  it("logs daemon.deploy_switch.rejected when the switch is refused", async () => {
    // warn events are collapse-keyed on level+event only, not on dataDir, so
    // an earlier rejection in this file would swallow this one.
    resetEventLogCollapse();
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const realFetch = originalFetch.bind(globalThis);
      const rejected = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "not-a-version" }),
      });
      expect(rejected.status).toBe(400);

      const events = await readLoggedEvents(configPath);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "daemon.deploy_switch.rejected",
            level: "warn",
            details: { version: "not-a-version", status: "invalid_version" },
          }),
        ]),
      );
    } finally {
      await server.stop();
    }
  });

  it("keeps the helper's failureKind after the daemon observes the child exit", async () => {
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
    fetchSpy.mockResolvedValue(registryResponse(["0.2.0", "0.1.0"]));
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    const realFetch = originalFetch.bind(globalThis);
    try {
      const accepted = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.2.0" }),
      });
      expect(accepted.status).toBe(202);
      const statePath = join(dirname(configPath), "data", "deploy-switch.json");

      // The helper's EXIT trap runs before the process exits, so it writes
      // this record first; the daemon's exit handler must leave it alone.
      await writeFile(
        statePath,
        `${JSON.stringify({
          phase: "failed",
          version: "0.2.0",
          pid: process.pid,
          startedAt: "2026-08-24T15:17:00Z",
          finishedAt: "2026-08-24T15:17:02Z",
          exitCode: 1,
          initiator: "manual",
          failureKind: "rolled_back",
        })}\n`,
        "utf8",
      );
      spawnedChildren[0]?.emit("exit", 1);

      const status = await realFetch(`http://127.0.0.1:${port}/deploy/switch/status`);
      await expect(status.json()).resolves.toEqual(
        expect.objectContaining({
          phase: "failed",
          version: "0.2.0",
          exitCode: 1,
          initiator: "manual",
          failureKind: "rolled_back",
        }),
      );
    } finally {
      await server.stop();
    }
  });

  it("writes its own terminal record with no failureKind when the helper wrote nothing", async () => {
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
    fetchSpy.mockResolvedValue(registryResponse(["0.2.0", "0.1.0"]));
    const { startServer } = await import("../../src/server.js");
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    const realFetch = originalFetch.bind(globalThis);
    try {
      const accepted = await realFetch(`http://127.0.0.1:${port}/deploy/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "0.2.0" }),
      });
      expect(accepted.status).toBe(202);

      spawnedChildren[0]?.emit("exit", 7);

      const status = await realFetch(`http://127.0.0.1:${port}/deploy/switch/status`);
      const body: unknown = await status.json();
      expect(body).toEqual(
        expect.objectContaining({
          phase: "failed",
          version: "0.2.0",
          exitCode: 7,
          initiator: "manual",
        }),
      );
      expect(body).not.toHaveProperty("failureKind");
    } finally {
      await server.stop();
    }
  });
});
