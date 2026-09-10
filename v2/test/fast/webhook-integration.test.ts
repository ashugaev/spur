import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { EventBus } from "../../src/event-bus.js";
import { startConfiguredSources } from "../../src/event-sources/index.js";
import { startConfiguredTriggers } from "../../src/triggers.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function post(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = '{"kind":"deploy","2":"second","10":"tenth"}';
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/events",
        method: "POST",
        headers: {
          Authorization: "Bearer test-webhook-key",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        agent: false,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("webhook source integration", () => {
  it("routes real HTTP through the source registry, event bus, and spawn trigger", async () => {
    const rootDir = await createTempDir("spur-webhook-integration-");
    tempDirs.push(rootDir);
    const repoPath = join(rootDir, "repo");
    const dataDir = join(rootDir, "data");
    const configPath = join(rootDir, "spur.yaml");
    const port = await freePort();
    await mkdir(repoPath, { recursive: true });
    await writeFile(
      configPath,
      `dataDir: ${dataDir}
projects:
  api:
    path: ${repoPath}
    sources:
      incoming:
        type: webhook
        port: ${port}
        path: /events
        secret: test-webhook-key
    triggers:
      receive:
        source: incoming
        event: webhook:received
        spawn:
          prompt: "Body={{body}} At={{receivedAt}}"
`,
      "utf8",
    );
    const config = loadConfig(configPath);
    const bus = new EventBus();
    const envelopes: unknown[] = [];
    bus.subscribe((event) => envelopes.push(event));
    let resolveSpawn: ((value: { id: string }) => void) | undefined;
    let spawnSettled = false;
    const spawn = vi.fn().mockImplementation(() =>
      new Promise<{ id: string }>((resolve) => {
        resolveSpawn = resolve;
      }).finally(() => {
        spawnSettled = true;
      }),
    );
    const triggerController = startConfiguredTriggers({
      config,
      bus,
      sessionService: { spawn } as never,
      logger: { warn: vi.fn() },
    });
    const sourceController = await startConfiguredSources({
      config,
      bus,
      listSessions: vi.fn().mockResolvedValue([]),
    });

    try {
      await expect(post(port)).resolves.toBe(202);
      expect(spawnSettled).toBe(false);
      expect(envelopes).toHaveLength(1);
      const envelope = envelopes[0] as {
        name: string;
        projectId: string;
        sourceId: string;
        data: { body: string; receivedAt: string };
      };
      expect(envelope).toEqual({
        name: "webhook:received",
        projectId: "api",
        sourceId: "incoming",
        data: {
          body: '{"2":"second","10":"tenth","kind":"deploy"}',
          receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith({
        project: "api",
        prompt: `Body=${envelope.data.body} At=${envelope.data.receivedAt}`,
      });
      resolveSpawn?.({ id: "api-webhook" });
      await vi.waitFor(() => expect(spawnSettled).toBe(true));
    } finally {
      resolveSpawn?.({ id: "api-webhook" });
      await sourceController.stop();
      await triggerController.stop();
    }
  });
});
