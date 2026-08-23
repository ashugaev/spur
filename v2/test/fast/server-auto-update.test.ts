import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AutoUpdateConfigModule from "../../src/auto-update-config.js";
import { startServer } from "../../src/server.js";
import { findFreePort } from "../helpers/common.js";

async function setupConfig(port: number, autoUpdate?: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spur-auto-update-route-"));
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

describe("POST /deploy/auto-update", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("turns the flag on and writes it to disk", async () => {
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/deploy/auto-update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toEqual({ autoUpdate: true });
      const configText = await readFile(configPath, "utf8");
      expect(configText).toContain("autoUpdate: true");
    } finally {
      await server.stop();
    }
  });

  it("turns the flag back off and writes it to disk", async () => {
    const port = await findFreePort();
    const configPath = await setupConfig(port, true);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/deploy/auto-update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toEqual({ autoUpdate: false });
      const configText = await readFile(configPath, "utf8");
      expect(configText).toContain("autoUpdate: false");
    } finally {
      await server.stop();
    }
  });

  it("returns 400 on a non-boolean enabled value", async () => {
    const port = await findFreePort();
    const configPath = await setupConfig(port);
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/deploy/auto-update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: "yes" }),
      });
      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      expect(body).toEqual({ error: "enabled must be a boolean" });
    } finally {
      await server.stop();
    }
  });

  describe("write failure mapping", () => {
    afterEach(async () => {
      vi.doUnmock("../../src/auto-update-config.js");
      vi.resetModules();
    });

    it("maps conflict, config_invalid, not_mapping, and missing to 409, and invalid_output/io to 500", async () => {
      const cases: Array<{
        reason: "conflict" | "config_invalid" | "not_mapping" | "missing" | "invalid_output" | "io";
        message: string;
        expectedStatus: number;
        expectedError: string;
      }> = [
        {
          reason: "conflict",
          message: "spur.yaml changed on disk",
          expectedStatus: 409,
          expectedError: "config changed on disk",
        },
        {
          reason: "config_invalid",
          message: "autoUpdate must be a boolean",
          expectedStatus: 409,
          expectedError: "autoUpdate must be a boolean",
        },
        {
          reason: "not_mapping",
          message: "not a mapping",
          expectedStatus: 409,
          expectedError: "config is not a YAML mapping",
        },
        {
          reason: "missing",
          message: "gone",
          expectedStatus: 409,
          expectedError: "config not found",
        },
        {
          reason: "invalid_output",
          message: "produced config failed to parse back",
          expectedStatus: 500,
          expectedError: "produced config failed to parse back",
        },
        {
          reason: "io",
          message: "EACCES",
          expectedStatus: 500,
          expectedError: "EACCES",
        },
      ];

      for (const testCase of cases) {
        vi.resetModules();
        vi.doMock("../../src/auto-update-config.js", async () => {
          const actual = await vi.importActual<typeof AutoUpdateConfigModule>(
            "../../src/auto-update-config.js",
          );
          return {
            ...actual,
            writeAutoUpdateFlag: () =>
              ({ ok: false, reason: testCase.reason, message: testCase.message }) as const,
          };
        });

        const { startServer: mockedStartServer } = await import("../../src/server.js");
        const port = await findFreePort();
        const configPath = await setupConfig(port);
        const server = await mockedStartServer(configPath, {
          info: () => undefined,
          warn: () => undefined,
        });
        try {
          const response = await fetch(`http://127.0.0.1:${port}/deploy/auto-update`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: true }),
          });
          expect(response.status).toBe(testCase.expectedStatus);
          const body: unknown = await response.json();
          expect(body).toEqual({ error: testCase.expectedError });
        } finally {
          await server.stop();
        }
        vi.doUnmock("../../src/auto-update-config.js");
      }
    });
  });
});
