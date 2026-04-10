import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, test } from "vitest";
import {
  AGENT_PORT_START,
  ensureAgentIsolatedConfig,
  findAvailableAgentPort,
  releaseAgentPort,
  removeAgentIsolatedConfig,
} from "../../src/agent-isolation.js";

describe("findAvailableAgentPort", () => {
  afterEach(() => {
    // Release any ports allocated during the test.
    for (let p = AGENT_PORT_START; p <= AGENT_PORT_START + 10; p++) {
      releaseAgentPort(p);
    }
  });

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

  test("skips ports already allocated by the process", async () => {
    const first = await findAvailableAgentPort();
    const second = await findAvailableAgentPort();
    expect(first).toBe(AGENT_PORT_START);
    expect(second).toBe(AGENT_PORT_START + 1);
  });

  test("releaseAgentPort makes port available again", async () => {
    const first = await findAvailableAgentPort();
    releaseAgentPort(first);
    const second = await findAvailableAgentPort();
    expect(second).toBe(first);
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

  test("creates config with correct values and quoted paths", () => {
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
    // Verify paths are YAML-quoted (string type preserved through special chars)
    expect(typeof parsed["dataDir"]).toBe("string");
    expect(typeof parsed["worktreeDir"]).toBe("string");
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

