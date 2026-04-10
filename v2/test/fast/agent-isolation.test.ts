import { createServer } from "node:net";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, test } from "vitest";
import {
  AGENT_PORT_END,
  AGENT_PORT_START,
  ensureAgentIsolatedConfig,
  findAvailableAgentPort,
  removeAgentIsolatedConfig,
} from "../../src/agent-isolation.js";

describe("findAvailableAgentPort", () => {
  test("returns first port in range when all free", async () => {
    const port = await findAvailableAgentPort();
    expect(port).toBe(AGENT_PORT_START);
  });

  test("skips ports with active listeners", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(AGENT_PORT_START, "127.0.0.1", resolve);
    });
    try {
      const port = await findAvailableAgentPort();
      expect(port).toBe(AGENT_PORT_START + 1);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});

describe("ensureAgentIsolatedConfig", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("creates config with correct values", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "spur-test-"));
    const configPath = ensureAgentIsolatedConfig({
      parentDataDir: tmpDir,
      sessionId: "test-session-1",
      port: 4325,
    });
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    const server = parsed["server"] as Record<string, unknown>;
    const tmux = parsed["tmux"] as Record<string, unknown>;
    expect(server["port"]).toBe(4325);
    expect(server["host"]).toBe("127.0.0.1");
    expect(tmux["socketName"]).toBe("spur-4325");
    expect(parsed["dataDir"]).toContain("agent-instances/test-session-1");
  });
});

describe("removeAgentIsolatedConfig", () => {
  test("removes instance directory", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "spur-test-"));
    try {
      ensureAgentIsolatedConfig({
        parentDataDir: tmpDir,
        sessionId: "test-rm",
        port: 4330,
      });
      const instanceDir = join(tmpDir, "agent-instances", "test-rm");
      expect(existsSync(instanceDir)).toBe(true);
      removeAgentIsolatedConfig(tmpDir, "test-rm");
      expect(existsSync(instanceDir)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("constants", () => {
  test("port range is valid", () => {
    expect(AGENT_PORT_START).toBe(4320);
    expect(AGENT_PORT_END).toBe(4399);
    expect(AGENT_PORT_END).toBeGreaterThan(AGENT_PORT_START);
  });
});
