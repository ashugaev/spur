import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AutoUpdateConfigModule from "../../src/auto-update-config.js";
import { startServer } from "../../src/server.js";
import { findFreePort } from "../helpers/common.js";

async function setupConfig(port: number, autoUpdate?: boolean): Promise<string> {
  return (await setupInstance(port, autoUpdate)).configPath;
}

async function setupInstance(
  port: number,
  autoUpdate?: boolean,
): Promise<{ configPath: string; dataDir: string }> {
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
  return { configPath, dataDir };
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

  describe("clearing the rollback notice", () => {
    const TERMINAL = {
      version: "0.67.2",
      pid: 4242,
      startedAt: "2026-08-24T15:17:00Z",
      finishedAt: "2026-08-24T15:17:02Z",
      exitCode: 1,
      initiator: "auto",
    } as const;

    async function postEnabled(
      enabled: boolean,
      record: unknown,
    ): Promise<{ statePath: string; recordAfter: string | null }> {
      const port = await findFreePort();
      const { configPath, dataDir } = await setupInstance(port, !enabled);
      await mkdir(dataDir, { recursive: true });
      const statePath = join(dataDir, "deploy-switch.json");
      await writeFile(statePath, `${JSON.stringify(record)}\n`, "utf8");
      const server = await startServer(configPath, {
        info: () => undefined,
        warn: () => undefined,
      });
      try {
        const response = await fetch(`http://127.0.0.1:${port}/deploy/auto-update`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        expect(response.status).toBe(200);
        return {
          statePath,
          recordAfter: existsSync(statePath) ? await readFile(statePath, "utf8") : null,
        };
      } finally {
        await server.stop();
      }
    }

    it("enabled true clears a rolled-back record", async () => {
      const { recordAfter } = await postEnabled(true, {
        ...TERMINAL,
        phase: "failed",
        failureKind: "rolled_back",
      });

      expect(recordAfter).toBeNull();
    });

    it("enabled false leaves the same record alone", async () => {
      // Unchecking the box is not the operator answering the rollback, and it
      // is the only checkbox action available while the notice already stands
      // with the flag on.
      const record = { ...TERMINAL, phase: "failed", failureKind: "rolled_back" };
      const { recordAfter } = await postEnabled(false, record);

      expect(recordAfter).toBe(`${JSON.stringify(record)}\n`);
    });

    it("enabled true leaves a succeeded record and a retryable failure alone", async () => {
      const succeeded = { ...TERMINAL, phase: "succeeded", exitCode: 0 };
      const retryable = { ...TERMINAL, phase: "failed", failureKind: "install_failed" };

      expect((await postEnabled(true, succeeded)).recordAfter).toBe(
        `${JSON.stringify(succeeded)}\n`,
      );
      expect((await postEnabled(true, retryable)).recordAfter).toBe(
        `${JSON.stringify(retryable)}\n`,
      );
    });
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
