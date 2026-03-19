import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionService } from "../../src/session-service.js";
import type { AgentName } from "../../src/types.js";
import { createTempDir, execFileAsync, findFreePort, pollUntil } from "../helpers/common.js";
import {
  createGitRepo,
  isTmuxAvailable,
  killTmuxSession,
  killTmuxSessionsByPrefix,
  syncTmuxEnvironment,
} from "../helpers/runtime.js";

const tmuxOk = await isTmuxAvailable();

async function hasBinary(name: string): Promise<boolean> {
  try {
    await execFileAsync("which", [name]);
    return true;
  } catch {
    return false;
  }
}

const claudeOk = tmuxOk && Boolean(process.env.ANTHROPIC_API_KEY) && (await hasBinary("claude"));
const codexOk = tmuxOk && Boolean(process.env.OPENAI_API_KEY) && (await hasBinary("codex"));

const cleanupItems: Array<{
  rootDir: string;
  repoDir: string;
  sessionPrefix: string;
}> = [];

function smokeConfig(args: {
  port: number;
  dataDir: string;
  worktreeDir: string;
  repoDir: string;
  sessionPrefix: string;
  agent: AgentName;
}): string {
  return `server:
  host: 127.0.0.1
  port: ${args.port}
dataDir: ${args.dataDir}
worktreeDir: ${args.worktreeDir}
defaultAgent: ${args.agent}
projects:
  api:
    path: ${args.repoDir}
    defaultBranch: main
    sessionPrefix: ${args.sessionPrefix}
`;
}

async function runSmoke(agent: AgentName): Promise<void> {
  const rootDir = await createTempDir(`spur-smoke-${agent}-`);
  const repoDir = await createGitRepo();
  const port = await findFreePort();
  const dataDir = join(rootDir, "data");
  const worktreeDir = join(rootDir, "worktrees");
  const sessionPrefix = `smoke-${agent}-${port}`;
  cleanupItems.push({ rootDir, repoDir, sessionPrefix });

  await syncTmuxEnvironment({
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  });

  const configPath = join(rootDir, "spur.yaml");
  await writeFile(
    configPath,
    smokeConfig({
      port,
      dataDir,
      worktreeDir,
      repoDir,
      sessionPrefix,
      agent,
    }),
    "utf8",
  );

  const service = new SessionService(configPath, "2026-03-18T10:00:00.000Z");
  const session = await service.spawn({
    project: "api",
    agent,
    prompt: `Create a file named smoke-initial.txt containing exactly "${agent} initial".`,
  });

  const initialFile = join(session.worktreePath, "smoke-initial.txt");
  await pollUntil(
    async () => existsSync(initialFile),
    {
      timeoutMs: 120_000,
      accept: Boolean,
    },
  );
  expect((await readFile(initialFile, "utf8")).trim()).toBe(`${agent} initial`);

  await killTmuxSession(session.id);

  const restored = await service.restore(session.id);
  expect(restored.id).toBe(session.id);

  await service.send(session.id, {
    message: `Create a file named smoke-followup.txt containing exactly "${agent} followup".`,
  });

  const followupFile = join(session.worktreePath, "smoke-followup.txt");
  await pollUntil(
    async () => existsSync(followupFile),
    {
      timeoutMs: 120_000,
      accept: Boolean,
    },
  );
  expect((await readFile(followupFile, "utf8")).trim()).toBe(`${agent} followup`);

  const killed = await service.kill(session.id);
  expect(killed.status).toBe("killed");
}

describe.skipIf(!claudeOk)("Spur real-agent smoke (claude)", () => {
  afterEach(async () => {
    while (cleanupItems.length > 0) {
      const current = cleanupItems.pop()!;
      await killTmuxSessionsByPrefix(current.sessionPrefix);
      await rm(current.rootDir, { recursive: true, force: true });
      await rm(current.repoDir, { recursive: true, force: true });
    }
  });

  it("launches claude, restores it, and accepts a follow-up send", async () => {
    await runSmoke("claude");
  });
});

describe.skipIf(!codexOk)("Spur real-agent smoke (codex)", () => {
  afterEach(async () => {
    while (cleanupItems.length > 0) {
      const current = cleanupItems.pop()!;
      await killTmuxSessionsByPrefix(current.sessionPrefix);
      await rm(current.rootDir, { recursive: true, force: true });
      await rm(current.repoDir, { recursive: true, force: true });
    }
  });

  it("launches codex, restores it, and accepts a follow-up send", async () => {
    await runSmoke("codex");
  });
});
