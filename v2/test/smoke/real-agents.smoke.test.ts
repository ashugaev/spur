import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SessionService } from "../../src/session-service.js";
import { startServer } from "../../src/server.js";
import type { AgentName, SpawnResult } from "../../src/types.js";
import { createTempDir, execFileAsync, findFreePort, pollUntil } from "../helpers/common.js";
import {
  isTmuxAvailable,
  killTmuxSession,
  killTmuxSessionsByPrefix,
  readTmuxStatus,
  setActiveTmuxSocketName,
  syncTmuxEnvironment,
} from "../helpers/runtime.js";

const SMOKE_REPO_DIR = fileURLToPath(new URL("../../..", import.meta.url));
const SMOKE_BASE_REF = await git(SMOKE_REPO_DIR, "rev-parse", "HEAD");
const tmuxOk = await isTmuxAvailable();
const CLAUDE_BIN = await binaryPath("claude");
const CODEX_BIN = await binaryPath("codex");
const GROUP_SMOKE_TEST_TIMEOUT_MS = 480_000;
const CURSOR_BIN = await binaryPath("agent");

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

function errorOutput(error: unknown): { stdout: string; stderr: string } {
  if (!error || typeof error !== "object") {
    return { stdout: "", stderr: "" };
  }
  const output = error as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: typeof output.stdout === "string" ? output.stdout : "",
    stderr: typeof output.stderr === "string" ? output.stderr : "",
  };
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }
  const { stdout, stderr } = errorOutput(error);
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "";
  return [stdout, stderr, message].filter(Boolean).join("\n").trim();
}

function parseClaudeAuthStatus(text: string): AuthStatus | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  if (typeof (parsed as { loggedIn?: unknown }).loggedIn !== "boolean") {
    return null;
  }
  if ((parsed as { loggedIn: boolean }).loggedIn) {
    return { available: true };
  }
  return { available: false, skipReason: "claude not authenticated" };
}

function parseCursorAuthStatus(text: string): AuthStatus | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (
    normalized.includes("not authenticated") ||
    normalized.includes("authenticated: false") ||
    normalized.includes("authentication required") ||
    normalized.includes("not logged in") ||
    normalized.includes("logged in: false") ||
    normalized.includes("no api key") ||
    normalized.includes("missing api key") ||
    normalized.includes("api key required") ||
    normalized.includes("unable to fetch user details") ||
    normalized.includes("agent login")
  ) {
    return { available: false, skipReason: "cursor not authenticated" };
  }
  if (
    normalized.includes("authenticated") ||
    normalized.includes("logged in") ||
    normalized.includes("api key")
  ) {
    return { available: true };
  }
  return null;
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
    const parsed = parseClaudeAuthStatus(stdout);
    if (parsed) {
      return parsed;
    }
    return { available: false, error: `Unexpected claude auth status output: ${stdout.trim()}` };
  } catch (error) {
    const { stdout, stderr } = errorOutput(error);
    const parsed = parseClaudeAuthStatus(stdout) ?? parseClaudeAuthStatus(stderr);
    if (parsed) {
      return parsed;
    }
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
    if (normalized.includes("not logged in") || normalized.includes("logged out")) {
      return { available: false, skipReason: "codex not authenticated" };
    }
    if (normalized.includes("logged in")) {
      return { available: true };
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

async function cursorStatus(): Promise<AuthStatus> {
  if (!tmuxOk) {
    return { available: false, skipReason: "tmux unavailable" };
  }
  if (!CURSOR_BIN) {
    return { available: false, skipReason: "cursor agent unavailable" };
  }
  if (process.env.CURSOR_API_KEY?.trim() || process.env.CURSOR_AUTH_TOKEN?.trim()) {
    return { available: true };
  }
  try {
    const { stdout, stderr } = await execFileAsync(CURSOR_BIN, ["status"], {
      timeout: 10_000,
    });
    const text = `${stdout}\n${stderr}`.trim();
    const parsed = parseCursorAuthStatus(text);
    if (parsed) {
      return parsed;
    }
    return { available: false, error: `Unexpected cursor status output: ${text}` };
  } catch (error) {
    const text = errorText(error);
    const parsed = parseCursorAuthStatus(text);
    if (parsed) {
      return parsed;
    }
    return { available: false, error: `Failed to read cursor auth status: ${text}` };
  }
}

const claudeAuth = await claudeStatus();
const codexAuth = await codexStatus();
const cursorAuth = await cursorStatus();

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
  extraProjectYaml?: string;
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
${args.extraProjectYaml ?? ""}
`;
}

async function withPinnedAgentBinaries<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    SPUR_CLAUDE_BIN: process.env.SPUR_CLAUDE_BIN,
    SPUR_CODEX_BIN: process.env.SPUR_CODEX_BIN,
    SPUR_CURSOR_BIN: process.env.SPUR_CURSOR_BIN,
  };
  if (CLAUDE_BIN) {
    process.env.SPUR_CLAUDE_BIN = CLAUDE_BIN;
  }
  if (CODEX_BIN) {
    process.env.SPUR_CODEX_BIN = CODEX_BIN;
  }
  if (CURSOR_BIN) {
    process.env.SPUR_CURSOR_BIN = CURSOR_BIN;
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
    if (saved.SPUR_CURSOR_BIN === undefined) {
      delete process.env.SPUR_CURSOR_BIN;
    } else {
      process.env.SPUR_CURSOR_BIN = saved.SPUR_CURSOR_BIN;
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

async function runSmoke(
  agent: AgentName,
  options?: { expectedPreflightBranch?: string },
): Promise<void> {
  const rootDir = await createTempDir(`spur-smoke-${agent}-`);
  const port = await findFreePort();
  const dataDir = join(rootDir, "data");
  const worktreeDir = join(rootDir, "worktrees");
  const sessionPrefix = `smoke-${agent}-${port}`;
  const tmuxSocketName = `spur-${port}`;
  const expectedPreflightBranch = options?.expectedPreflightBranch
    ? `${options.expectedPreflightBranch}-${port}`
    : undefined;
  const cleanupItem: CleanupItem = { rootDir, sessionPrefix };
  cleanupItems.push(cleanupItem);

  setActiveTmuxSocketName(tmuxSocketName);
  await syncTmuxEnvironment({});

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
      ...(expectedPreflightBranch
        ? {
            extraProjectYaml: `    preflight:
      prompt: "Set branch exactly to ${expectedPreflightBranch}."
`,
          }
        : {}),
    }),
    "utf8",
  );

  await withPinnedAgentBinaries(async () => {
    const service = await startServer(configPath, {});
    const initialSmokeTimeoutMs = agent === "claude" ? 180_000 : 240_000;
    const expectedTitle = `${agent} smoke slots`;
    const expectedLinks = [
      { label: "tracker", url: `https://tracker.example.com/${agent}-smoke` },
      { label: "pr", url: `https://example.com/${agent}/pull/1` },
    ] as const;
    const expectedLinkPairs = expectedLinks.map((link) => `${link.label}=${link.url}`).sort();
    try {
      const session = await service.spawn({
        project: "api",
        agent,
        prompt: `Create a file named smoke-initial.txt containing exactly "${agent} initial".
This task title is "${expectedTitle}".
The related links are tracker=${expectedLinks[0].url} and pr=${expectedLinks[1].url}.
After the file and the session metadata are set, wait for more instructions.`,
      });
      cleanupItem.branch = session.branch;
      cleanupItem.worktreePath = session.worktreePath;
      if (expectedPreflightBranch) {
        expect(session.branch).toBe(expectedPreflightBranch);
        expect(session.branchSource).toBe("preflight");
      }

      const initialFile = join(session.worktreePath, "smoke-initial.txt");
      await pollUntil(async () => existsSync(initialFile), {
        timeoutMs: initialSmokeTimeoutMs,
        accept: Boolean,
      });
      const liveState = await service.get(session.id);
      if (liveState.slots?.title) {
        expect(liveState.slots.title).toBe(expectedTitle);
        expect(liveState.slots.links).toHaveLength(expectedLinks.length);
        expect(liveState.slots.links).toEqual(expect.arrayContaining([...expectedLinks]));
        const status = await readTmuxStatus(session.id);
        expect(status).toBe("off");
        const links = liveState.slots.links.map((link) => `${link.label}=${link.url}`).sort();
        expect(links).toEqual(expectedLinkPairs);
      }
      expect((await readFile(initialFile, "utf8")).trim()).toBe(`${agent} initial`);

      await killTmuxSession(session.id);

      const restored = await service.restore(session.id);
      expect(restored.id).toBe(session.id);
      if (restored.slots?.title) {
        expect(restored.slots.title).toBe(expectedTitle);
        expect(restored.slots.links).toEqual(expect.arrayContaining([...expectedLinks]));
      }

      await service.send(session.id, {
        message: `Create a file named smoke-followup.txt containing exactly "${agent} followup".`,
      });

      const followupFile = join(session.worktreePath, "smoke-followup.txt");
      await pollUntil(async () => existsSync(followupFile), {
        timeoutMs: 120_000,
        accept: Boolean,
      });
      expect((await readFile(followupFile, "utf8")).trim()).toBe(`${agent} followup`);

      const killed = await service.kill(session.id, { force: true });
      expect(killed.status).toBe("killed");
      expect(existsSync(session.worktreePath)).toBe(false);
    } finally {
      await service.stop();
    }
  });
}

afterEach(async () => {
  while (cleanupItems.length > 0) {
    const item = popCleanupItem();
    try {
      await cleanupSmokeItem(item);
    } catch (error) {
      // one item's cleanup failure must not abandon the rest of the drain.
      // eslint-disable-next-line no-console
      console.warn(`cleanupSmokeItem failed for ${item.rootDir}: ${String(error)}`);
    }
  }
});

describe("cursor auth status parsing", () => {
  it.each([
    ["not authenticated", { available: false, skipReason: "cursor not authenticated" }],
    [
      "Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.",
      { available: false, skipReason: "cursor not authenticated" },
    ],
    ["Authenticated: false", { available: false, skipReason: "cursor not authenticated" }],
    [
      "Logged in (unable to fetch user details)",
      { available: false, skipReason: "cursor not authenticated" },
    ],
    ["no api key found", { available: false, skipReason: "cursor not authenticated" }],
    ["missing api key", { available: false, skipReason: "cursor not authenticated" }],
    ["api key required", { available: false, skipReason: "cursor not authenticated" }],
    ["authenticated", { available: true }],
    ["logged in", { available: true }],
    ["agent status pending", null],
  ] as const)("parses %s", (text, expected) => {
    expect(parseCursorAuthStatus(text)).toEqual(expected);
  });
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

    it("uses claude spawn preflight before the normal session launch", async () => {
      await runSmoke("claude", { expectedPreflightBranch: "smoke-claude-preflight" });
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

    it("uses codex spawn preflight before the normal session launch", async () => {
      await runSmoke("codex", { expectedPreflightBranch: "smoke-codex-preflight" });
    });
  });
}

describe.skipIf(!claudeAuth.available || !codexAuth.available)(
  "Spur real-agent smoke (grouped)",
  () => {
    it(
      "launches grouped claude and codex sessions for one task",
      async () => {
        const rootDir = await createTempDir("spur-smoke-group-");
        const port = await findFreePort();
        const dataDir = join(rootDir, "data");
        const worktreeDir = join(rootDir, "worktrees");
        const sessionPrefix = `smoke-group-${port}`;
        const tmuxSocketName = `spur-${port}`;

        await syncTmuxEnvironment({
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          SPUR_TMUX_SOCKET_NAME: tmuxSocketName,
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
            agent: "claude",
          }),
          "utf8",
        );

        await withPinnedAgentBinaries(async () => {
          const service = new SessionService(configPath, "2026-03-18T10:00:00.000Z");
          const spawned = (await service.spawn({
            project: "api",
            prompt:
              "Create a file named smoke-group.txt containing exactly your agent name, then wait for more instructions.",
            members: [{ agent: "claude" }, { agent: "codex" }],
          })) as SpawnResult;

          expect(spawned.groupId).toBeTruthy();
          expect(spawned.sessions).toHaveLength(2);

          for (const session of spawned.sessions) {
            cleanupItems.push({
              rootDir,
              sessionPrefix,
              branch: session.branch,
              worktreePath: session.worktreePath,
            });
            const groupFile = join(session.worktreePath, "smoke-group.txt");
            await pollUntil(async () => existsSync(groupFile), {
              timeoutMs: session.agent === "codex" ? 240_000 : 180_000,
              accept: Boolean,
            });
            expect((await readFile(groupFile, "utf8")).trim()).toBe(session.agent);
            const killed = await service.kill(session.id, { force: true });
            expect(killed.status).toBe("killed");
          }
        });
      },
      GROUP_SMOKE_TEST_TIMEOUT_MS,
    );
  },
);

if (cursorAuth.error) {
  describe("Spur real-agent smoke (cursor)", () => {
    it("passes the auth preflight", () => {
      throw new Error(cursorAuth.error);
    });
  });
} else {
  describe.skipIf(!cursorAuth.available)("Spur real-agent smoke (cursor)", () => {
    it("launches cursor, restores it, and accepts a follow-up send", async () => {
      await runSmoke("cursor");
    });

    it("uses cursor spawn preflight before the normal session launch", async () => {
      await runSmoke("cursor", { expectedPreflightBranch: "smoke-cursor-preflight" });
    });
  });
}
