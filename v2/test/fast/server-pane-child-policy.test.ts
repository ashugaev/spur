import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startServer } from "../../src/server.js";
import { findFreePort } from "../helpers/common.js";

const policyKeys = [
  "SPUR_CLAUDE_PANE_CHILD_FALLBACK",
  "SPUR_CODEX_PANE_CHILD_FALLBACK",
  "SPUR_CURSOR_PANE_CHILD_FALLBACK",
  "SPUR_OPENCODE_PANE_CHILD_FALLBACK",
] as const;
const logger = { info: () => undefined, warn: () => undefined };

async function privateConfig(): Promise<{ root: string; configPath: string; port: number }> {
  const root = await mkdtemp(join(tmpdir(), "spur-pane-child-policy-"));
  const port = await findFreePort();
  const configPath = join(root, "config.yaml");
  await writeFile(
    configPath,
    `server: {host: 127.0.0.1, port: ${port}}\ndataDir: ${join(root, "data")}\nworktreeDir: ${join(root, "worktrees")}\n`,
  );
  return { root, configPath, port };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(policyKeys)("rejects invalid %s before listening", async (key) => {
  for (const policyKey of policyKeys) vi.stubEnv(policyKey, undefined);
  vi.stubEnv(key, "invalid");
  const { root, configPath } = await privateConfig();
  const listen = vi.spyOn(Server.prototype, "listen");
  let started: Awaited<ReturnType<typeof startServer>> | undefined;
  let startupError: unknown;
  try {
    try {
      started = await startServer(configPath, logger);
    } catch (error) {
      startupError = error;
    }
    expect(startupError).toBeInstanceOf(Error);
    expect((startupError as Error).message).toContain(key);
    expect(listen).not.toHaveBeenCalled();
  } finally {
    await started?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([undefined, "auto", "off"])("starts with %s pane-child policy", async (value) => {
  for (const key of policyKeys) vi.stubEnv(key, undefined);
  if (value !== undefined) vi.stubEnv("SPUR_CODEX_PANE_CHILD_FALLBACK", value);
  const { root, configPath, port } = await privateConfig();
  let started: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    started = await startServer(configPath, logger);
    expect((await fetch(`http://127.0.0.1:${port}/info`)).status).toBe(200);
  } finally {
    await started?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
