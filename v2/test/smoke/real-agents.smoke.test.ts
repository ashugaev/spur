import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SessionService } from "../../src/session-service.js";
import type { AgentName } from "../../src/types.js";
import { createTempDir, execFileAsync, findFreePort, pollUntil } from "../helpers/common.js";
import {
  isTmuxAvailable,
  killTmuxSession,
  killTmuxSessionsByPrefix,
  syncTmuxEnvironment,
} from "../helpers/runtime.js";

const SMOKE_REPO_DIR = fileURLToPath(new URL("../../..", import.meta.url));
const SMOKE_BASE_REF = await git(SMOKE_REPO_DIR, "rev-parse", "HEAD");
const tmuxOk = await isTmuxAvailable();
const CLAUDE_BIN = await binaryPath("claude");
const CODEX_BIN = await binaryPath("codex");

interface AuthStatus {
  available: boolean;
  skipReason?: string;
  error?: string;
}

interface CleanupItem {
  rootDir: string;
  sessionPrefix: string;
  branch?: string;
  worktreePath?: string;
}

async function binaryPath(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [name]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }
  const stdout =
    typeof (error as { stdout?: unknown }).stdout === "string"
      ? (error as { stdout: string }).stdout
      : "";
  const stderr =
    typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr
      : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "";
  return [stdout, stderr, message].filter(Boolean).join("\n").trim();
}

async function claudeStatus(): Promise<AuthStatus> {
  if (!tmuxOk) {
    return { available: false, skipReason: "tmux unavailable" };
  }
  if (!CLAUDE_BIN) {
    return { available: false, skipReason: "claude unavailable" };
  }

  try {
    const { stdout } = await execFileAsync(CLAUDE_BIN, ["auth", "status"], { timeout: 10_000 });
    const parsed = JSON.parse(stdout) as { loggedIn?: boolean };
    if (parsed.loggedIn === true) {
      return { available: true };
    }
    if (parsed.loggedIn === false) {
      return { available: false, skipReason: "claude not authenticated" };
    }
    return { available: false, error: `Unexpected claude auth status output: ${stdout.trim()}` };
  } catch (error) {
    return { available: false, error: `Failed to read claude auth status: ${errorText(error)}` };
  }
}

async function codexStatus(): Promise<AuthStatus> {
  if (!tmuxOk) {
    return { available: false, skipReason: "tmux unavailable" };
  }
  if (!CODEX_BIN) {
    return { available: false, skipReason: "codex unavailable" };
  }

  try {
    const { stdout, stderr } = await execFileAsync(CODEX_BIN, ["login", "status"], {
      timeout: 10_000,
    });
    const text = `${stdout}\n${stderr}`.trim();
    const normalized = text.toLowerCase();
    if (normalized.includes("logged in")) {
      return { available: true };
    }
    if (normalized.includes("not logged in") || normalized.includes("logged out")) {
      return { available: false, skipReason: "codex not authenticated" };
    }
    return { available: false, error: `Unexpected codex login status output: ${text}` };
  } catch (error) {
    const text = errorText(error);
    const normalized = text.toLowerCase();
    if (normalized.includes("not logged in") || normalized.includes("logged out")) {
      return { available: false, skipReason: "codex not authenticated" };
    }
    return { available: false, error: `Failed to read codex login status: ${text}` };
  }
}

const claudeAuth = await claudeStatus();
const codexAuth = await codexStatus();

const cleanupItems: CleanupItem[] = [];

function popCleanupItem(): (typeof cleanupItems)[number] {
  const current = cleanupItems.pop();
  if (!current) {
    throw new Error("Expected a smoke cleanup item");
  }
  return current;
}

function smokeConfig(args: {
  port: number;
  dataDir: string;
  worktreeDir: string;
  repoDir: string;
  baseRef: string;
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
    defaultBranch: ${args.baseRef}
    sessionPrefix: ${args.sessionPrefix}
`;
}

async function withPinnedAgentBinaries<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    SPUR_CLAUDE_BIN: process.env.SPUR_CLAUDE_BIN,
    SPUR_CODEX_BIN: process.env.SPUR_CODEX_BIN,
  };
  if (CLAUDE_BIN) {
    process.env.SPUR_CLAUDE_BIN = CLAUDE_BIN;
  }
  if (CODEX_BIN) {
    process.env.SPUR_CODEX_BIN = CODEX_BIN;
  }

  try {
    return await fn();
  } finally {
    if (saved.SPUR_CLAUDE_BIN === undefined) {
      delete process.env.SPUR_CLAUDE_BIN;
    } else {
      process.env.SPUR_CLAUDE_BIN = saved.SPUR_CLAUDE_BIN;
    }
    if (saved.SPUR_CODEX_BIN === undefined) {
      delete process.env.SPUR_CODEX_BIN;
    } else {
      process.env.SPUR_CODEX_BIN = saved.SPUR_CODEX_BIN;
    }
  }
}

async function cleanupSmokeItem(item: CleanupItem): Promise<void> {
  await killTmuxSessionsByPrefix(item.sessionPrefix);
  if (item.worktreePath) {
    try {
      await git(SMOKE_REPO_DIR, "worktree", "remove", "--force", item.worktreePath);
    } catch {
      // Best effort only.
    }
  }
  if (item.branch) {
    try {
      await git(SMOKE_REPO_DIR, "branch", "-D", item.branch);
    } catch {
      // Best effort only.
    }
  }
  try {
    await git(SMOKE_REPO_DIR, "worktree", "prune", "--expire", "now");
  } catch {
    // Best effort only.
  }
  await rm(item.rootDir, { recursive: true, force: true });
}

async function runSmoke(agent: AgentName): Promise<void> {
  const rootDir = await createTempDir(`spur-smoke-${agent}-`);
  const port = await findFreePort();
  const dataDir = join(rootDir, "data");
  const worktreeDir = join(rootDir, "worktrees");
  const sessionPrefix = `smoke-${agent}-${port}`;
  const cleanupItem: CleanupItem = { rootDir, sessionPrefix };
  cleanupItems.push(cleanupItem);

  await syncTmuxEnvironment({
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    SPUR_CLAUDE_BIN: CLAUDE_BIN ?? undefined,
    SPUR_CODEX_BIN: CODEX_BIN ?? undefined,
  });

  const configPath = join(rootDir, "spur.yaml");
  await writeFile(
    configPath,
    smokeConfig({
      port,
      dataDir,
      worktreeDir,
      repoDir: SMOKE_REPO_DIR,
      baseRef: SMOKE_BASE_REF,
      sessionPrefix,
      agent,
    }),
    "utf8",
  );

  await withPinnedAgentBinaries(async () => {
    const service = new SessionService(configPath, "2026-03-18T10:00:00.000Z");
    const session = await service.spawn({
      project: "api",
      agent,
      prompt: `Create a file named smoke-initial.txt containing exactly "${agent} initial".`,
    });
    cleanupItem.branch = session.branch;
    cleanupItem.worktreePath = session.worktreePath;

    const initialFile = join(session.worktreePath, "smoke-initial.txt");
    await pollUntil(async () => existsSync(initialFile), {
      timeoutMs: 120_000,
      accept: Boolean,
    });
    expect((await readFile(initialFile, "utf8")).trim()).toBe(`${agent} initial`);

    await killTmuxSession(session.id);

    const restored = await service.restore(session.id);
    expect(restored.id).toBe(session.id);

    await service.send(session.id, {
      message: `Create a file named smoke-followup.txt containing exactly "${agent} followup".`,
    });

    const followupFile = join(session.worktreePath, "smoke-followup.txt");
    await pollUntil(async () => existsSync(followupFile), {
      timeoutMs: 120_000,
      accept: Boolean,
    });
    expect((await readFile(followupFile, "utf8")).trim()).toBe(`${agent} followup`);

    const killed = await service.kill(session.id);
    expect(killed.status).toBe("killed");
    expect(existsSync(session.worktreePath)).toBe(false);
  });
}

afterEach(async () => {
  while (cleanupItems.length > 0) {
    await cleanupSmokeItem(popCleanupItem());
  }
});

if (claudeAuth.error) {
  describe("Spur real-agent smoke (claude)", () => {
    it("passes the auth preflight", () => {
      throw new Error(claudeAuth.error);
    });
  });
} else {
  describe.skipIf(!claudeAuth.available)("Spur real-agent smoke (claude)", () => {
    it("launches claude, restores it, and accepts a follow-up send", async () => {
      await runSmoke("claude");
    });
  });
}

if (codexAuth.error) {
  describe("Spur real-agent smoke (codex)", () => {
    it("passes the auth preflight", () => {
      throw new Error(codexAuth.error);
    });
  });
} else {
  describe.skipIf(!codexAuth.available)("Spur real-agent smoke (codex)", () => {
    it("launches codex, restores it, and accepts a follow-up send", async () => {
      await runSmoke("codex");
    });
  });
}
