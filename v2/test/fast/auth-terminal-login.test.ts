import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthLogin } from "../../src/auth-proxy.js";
import {
  AuthTerminalLogins,
  TERMINAL_DEADLINE_MS,
  TERMINAL_TICK_MS,
  type AuthTerminalDeps,
} from "../../src/auth-terminal-login.js";
import type { QuotaSourceResult } from "../../src/usage-report.js";

const ACCOUNT = "11111111-2222-3333-4444-555555555555";
const login = (status: AuthLogin["status"], extra: Partial<AuthLogin> = {}): AuthLogin => ({
  accountId: ACCOUNT,
  status,
  ...extra,
});
const okQuota = { status: "ok" } as QuotaSourceResult;
const errorQuota = (error: string) => ({ status: "error", error }) as QuotaSourceResult;

async function setup(overrides: Partial<AuthTerminalDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), "spur-terminal-"));
  const dataDir = join(root, "data");
  const homeDir = join(root, "home");
  await mkdir(dataDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const clock = { ms: 1_000_000 };
  const calls: string[] = [];
  const homeAtKill: boolean[] = [];
  const managedHome = join(dataDir, "auth-terminal", ACCOUNT);
  const deps = {
    dataDir,
    homeDir,
    createTmuxCommandSession: vi.fn(async (input: { sessionName: string }) => {
      calls.push(`create:${input.sessionName}`);
    }),
    killTmuxSession: vi.fn(async (name: string) => {
      calls.push(`kill:${name}`);
      homeAtKill.push(existsSync(managedHome));
    }),
    tmuxPaneDead: vi.fn(async () => false),
    accountProvider: vi.fn(() => "claude" as const),
    cancelLogin: vi.fn(async () => {
      calls.push("cancel");
    }),
    importNativeLogin: vi.fn(async () => login("sign-in-required")),
    loginStatus: vi.fn(async () => login("pending")),
    hostProbe: vi.fn(async () => okQuota),
    agentCommand: vi.fn((provider: string) => (provider === "claude" ? "claude" : "codex")),
    now: () => clock.ms,
    ...overrides,
  } satisfies AuthTerminalDeps;
  const terminals = new AuthTerminalLogins(deps);
  // Fires the watcher timer, then lets the tick's real file I/O settle.
  const fire = async () => {
    await vi.advanceTimersByTimeAsync(TERMINAL_TICK_MS);
    await new Promise((resolve) => realSetTimeout(resolve, 25));
  };
  const advance = async (ticks = 1) => {
    for (let index = 0; index < ticks; index += 1) {
      clock.ms += TERMINAL_TICK_MS;
      await fire();
    }
  };
  return {
    deps,
    terminals,
    clock,
    calls,
    homeAtKill,
    managedHome,
    advance,
    fire,
    dataDir,
    homeDir,
  };
}

const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("auth terminal logins", () => {
  it("cancels in-UI login before creating the command session", async () => {
    const s = await setup();
    await s.terminals.start({ accountId: ACCOUNT });
    expect(s.calls.indexOf("cancel")).toBeGreaterThanOrEqual(0);
    expect(s.calls.indexOf("cancel")).toBeLessThan(s.calls.indexOf(`create:auth-login-${ACCOUNT}`));
    s.terminals.dispose();
  });

  it("managed home is emptied, 0700, codex config.toml file store", async () => {
    const s = await setup({ accountProvider: vi.fn(() => "codex" as const) });
    await mkdir(s.managedHome, { recursive: true });
    await writeFile(join(s.managedHome, "stale.json"), "old");
    await s.terminals.start({ accountId: ACCOUNT });
    expect(existsSync(join(s.managedHome, "stale.json"))).toBe(false);
    expect(statSync(s.managedHome).mode & 0o777).toBe(0o700);
    expect(await readFile(join(s.managedHome, "config.toml"), "utf8")).toBe(
      'cli_auth_credentials_store = "file"\n',
    );
    s.terminals.dispose();
  });

  it("launch strings per target unset provider env and use the resolved binary", async () => {
    const s = await setup({ agentCommand: (provider) => `/opt/bin/${provider} x` });
    const launches = async () =>
      s.deps.createTmuxCommandSession.mock.calls.map((call) => call[0].launchCommand);
    await s.terminals.start({ accountId: ACCOUNT });
    await s.terminals.start({ host: "claude" });
    await s.terminals.start({ host: "codex" });
    const [claude, hostClaude, hostCodex] = await launches();
    expect(claude).toBe(
      `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR='${s.managedHome}' '/opt/bin/claude x' auth login`,
    );
    expect(hostClaude).toBe(`env -u CLAUDE_CONFIG_DIR '/opt/bin/claude x' auth login`);
    expect(hostCodex).toBe(`env -u CODEX_HOME '/opt/bin/codex x' login --device-auth`);
    const codex = await setup({ accountProvider: () => "codex" });
    await codex.terminals.start({ accountId: ACCOUNT });
    expect(codex.deps.createTmuxCommandSession.mock.calls[0]?.[0].launchCommand).toBe(
      `env -u OPENAI_API_KEY -u CODEX_API_KEY -u OPENAI_BASE_URL CODEX_HOME='${codex.managedHome}' 'codex' login --device-auth`,
    );
    for (const item of [s, codex]) item.terminals.dispose();
  });

  it("rejects an unsafe account id before touching anything", async () => {
    const s = await setup();
    await expect(s.terminals.start({ accountId: "../x" })).rejects.toThrow("Invalid");
    expect(s.calls).toEqual([]);
  });

  it("credential written and pane dead in the same tick -> import wins, verifying then ready", async () => {
    const s = await setup();
    s.deps.importNativeLogin.mockResolvedValueOnce(login("pending", { stage: "verifying" }));
    s.deps.tmuxPaneDead.mockResolvedValue(true);
    const started = await s.terminals.start({ accountId: ACCOUNT });
    await s.advance();
    expect(s.terminals.get(started.id).status).toBe("verifying");
    expect(s.deps.importNativeLogin).toHaveBeenCalledTimes(1);
    expect(s.deps.tmuxPaneDead).not.toHaveBeenCalled();
    expect(existsSync(s.managedHome)).toBe(false);
    s.deps.loginStatus.mockResolvedValueOnce(login("ready"));
    await s.advance();
    expect(s.terminals.get(started.id)).toMatchObject({ status: "ready" });
    expect(s.deps.importNativeLogin).toHaveBeenCalledTimes(1);
  });

  it("dead pane with no credential -> one final import, then not_signed_in reason exited", async () => {
    const s = await setup();
    s.deps.tmuxPaneDead.mockResolvedValue(true);
    const started = await s.terminals.start({ accountId: ACCOUNT });
    await s.advance();
    expect(s.deps.importNativeLogin).toHaveBeenCalledTimes(2);
    expect(s.terminals.get(started.id)).toMatchObject({
      status: "not_signed_in",
      reason: "exited",
    });
  });

  it("a credential completed between the dead-pane check and the final import is still imported", async () => {
    const s = await setup();
    s.deps.tmuxPaneDead.mockResolvedValue(true);
    s.deps.importNativeLogin
      .mockResolvedValueOnce(login("sign-in-required"))
      .mockResolvedValueOnce(login("pending"));
    const started = await s.terminals.start({ accountId: ACCOUNT });
    await s.advance();
    expect(s.terminals.get(started.id).status).toBe("verifying");
  });

  it("no import after end state", async () => {
    const s = await setup();
    s.deps.tmuxPaneDead.mockResolvedValue(true);
    await s.terminals.start({ accountId: ACCOUNT });
    await s.advance();
    const count = s.deps.importNativeLogin.mock.calls.length;
    await s.advance(5);
    expect(s.deps.importNativeLogin).toHaveBeenCalledTimes(count);
  });

  it("busy maps to running reason another_sign_in_pending and keeps polling", async () => {
    const s = await setup();
    s.deps.importNativeLogin.mockResolvedValue(login("busy"));
    const started = await s.terminals.start({ accountId: ACCOUNT });
    await s.advance(3);
    expect(s.terminals.get(started.id)).toMatchObject({
      status: "running",
      reason: "another_sign_in_pending",
    });
    expect(s.deps.importNativeLogin).toHaveBeenCalledTimes(3);
    s.terminals.dispose();
  });

  it("companion unreachable keeps running reason companion_unavailable", async () => {
    const s = await setup();
    s.deps.importNativeLogin.mockRejectedValueOnce(new Error("down"));
    const started = await s.terminals.start({ accountId: ACCOUNT });
    await s.advance();
    expect(s.terminals.get(started.id)).toMatchObject({
      status: "running",
      reason: "companion_unavailable",
    });
    await s.advance();
    expect(s.terminals.get(started.id)).toEqual(
      expect.not.objectContaining({ reason: "companion_unavailable" }),
    );
    s.terminals.dispose();
  });

  it("failed identity/not_confirmed map to not_signed_in with reason", async () => {
    for (const [errorCode, reason] of [
      ["identity", "identity"],
      ["not_confirmed", "not_confirmed"],
      ["expired", "failed"],
    ] as const) {
      const s = await setup();
      s.deps.importNativeLogin.mockResolvedValue(login("failed", { errorCode }));
      const started = await s.terminals.start({ accountId: ACCOUNT });
      await s.advance();
      expect(s.terminals.get(started.id)).toMatchObject({ status: "not_signed_in", reason });
    }
  });

  describe("home deleted and tmux killed (in that order) on every end state", () => {
    const assertCleaned = (s: Awaited<ReturnType<typeof setup>>) => {
      expect(existsSync(s.managedHome)).toBe(false);
      const kills = s.calls.filter((call) => call.startsWith("kill:"));
      expect(kills.length).toBeGreaterThanOrEqual(2);
      // The kill that follows the end state still saw the home; deletion came after it.
      expect(s.homeAtKill.at(-1)).toBe(true);
    };

    it("ready", async () => {
      const s = await setup();
      s.deps.importNativeLogin.mockResolvedValue(login("ready"));
      await s.terminals.start({ accountId: ACCOUNT });
      await s.advance();
      assertCleaned(s);
    });

    it("not_signed_in", async () => {
      const s = await setup();
      s.deps.tmuxPaneDead.mockResolvedValue(true);
      await s.terminals.start({ accountId: ACCOUNT });
      await s.advance();
      assertCleaned(s);
    });

    it("stop", async () => {
      const s = await setup();
      const started = await s.terminals.start({ accountId: ACCOUNT });
      await s.terminals.stop(started.id);
      assertCleaned(s);
      expect(s.terminals.get(started.id)).toMatchObject({ reason: "stopped" });
      const kills = s.calls.filter((call) => call.startsWith("kill:")).length;
      await s.terminals.stop(started.id);
      expect(s.calls.filter((call) => call.startsWith("kill:"))).toHaveLength(kills);
    });

    it("deadline", async () => {
      const s = await setup();
      const started = await s.terminals.start({ accountId: ACCOUNT });
      s.clock.ms += TERMINAL_DEADLINE_MS;
      await s.fire();
      expect(s.terminals.get(started.id)).toMatchObject({
        status: "not_signed_in",
        reason: "timed_out",
      });
      assertCleaned(s);
    });

    it("sweep", async () => {
      const s = await setup();
      await mkdir(join(s.dataDir, "auth-terminal", "orphan-id"), { recursive: true });
      await s.terminals.sweep([ACCOUNT]);
      expect(s.calls).toEqual(
        expect.arrayContaining([
          "kill:auth-login-host-claude",
          "kill:auth-login-host-codex",
          `kill:auth-login-${ACCOUNT}`,
          "kill:auth-login-orphan-id",
        ]),
      );
      expect(existsSync(join(s.dataDir, "auth-terminal"))).toBe(false);
    });
  });

  it("deadline stops watcher", async () => {
    const s = await setup();
    await s.terminals.start({ accountId: ACCOUNT });
    s.clock.ms += TERMINAL_DEADLINE_MS - TERMINAL_TICK_MS;
    await s.fire();
    await s.advance(3);
    const imports = s.deps.importNativeLogin.mock.calls.length;
    expect(imports).toBeLessThanOrEqual(481);
    await s.advance(10);
    expect(s.deps.importNativeLogin).toHaveBeenCalledTimes(imports);
  });

  it("restarting the same target replaces the earlier attempt", async () => {
    const s = await setup();
    const first = await s.terminals.start({ accountId: ACCOUNT });
    const second = await s.terminals.start({ accountId: ACCOUNT });
    expect(second.id).toBe(first.id);
    expect(s.terminals.get(first.id).status).toBe("running");
    expect(s.deps.createTmuxCommandSession).toHaveBeenCalledTimes(2);
    s.terminals.dispose();
  });

  it("unknown id is 404", async () => {
    const s = await setup();
    expect(() => s.terminals.get("auth-login-nope")).toThrow("Unknown terminal login");
    await expect(s.terminals.stop("auth-login-nope")).rejects.toThrow("Unknown terminal login");
  });

  describe("host", () => {
    async function hostSetup() {
      const s = await setup();
      const credential = join(s.homeDir, ".claude", ".credentials.json");
      await mkdir(join(s.homeDir, ".claude"), { recursive: true });
      await writeFile(credential, "{}");
      await utimes(credential, new Date(s.clock.ms - 60_000), new Date(s.clock.ms - 60_000));
      const touch = (offsetMs: number) =>
        utimes(credential, new Date(s.clock.ms + offsetMs), new Date(s.clock.ms + offsetMs));
      return { ...s, touch };
    }

    it("unchanged mtime keeps running; newer mtime + ok probe -> ready; probe once per mtime", async () => {
      const s = await hostSetup();
      const started = await s.terminals.start({ host: "claude" });
      await s.advance(2);
      expect(s.terminals.get(started.id).status).toBe("running");
      expect(s.deps.hostProbe).not.toHaveBeenCalled();
      s.deps.hostProbe.mockResolvedValueOnce(errorQuota("unauthorized"));
      await s.touch(1_000);
      await s.advance();
      await s.advance(2);
      expect(s.deps.hostProbe).toHaveBeenCalledTimes(1);
      expect(s.terminals.get(started.id).status).toBe("running");
      await s.touch(2_000);
      await s.advance();
      expect(s.deps.hostProbe).toHaveBeenCalledTimes(2);
      expect(s.terminals.get(started.id).status).toBe("ready");
      expect(s.calls.filter((call) => call === "kill:auth-login-host-claude").length).toBe(2);
    });

    it("rate limited probe counts as ready", async () => {
      const s = await hostSetup();
      s.deps.hostProbe.mockResolvedValue(errorQuota("rate_limited"));
      const started = await s.terminals.start({ host: "claude" });
      await s.touch(1_000);
      await s.advance();
      expect(s.terminals.get(started.id).status).toBe("ready");
    });

    it("pane exit without a verified credential ends not_signed_in exited", async () => {
      const s = await hostSetup();
      s.deps.tmuxPaneDead.mockResolvedValue(true);
      const started = await s.terminals.start({ host: "claude" });
      await s.advance();
      expect(s.terminals.get(started.id)).toMatchObject({
        status: "not_signed_in",
        reason: "exited",
      });
    });
  });
});
