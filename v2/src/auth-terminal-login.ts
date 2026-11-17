import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthorizationError, type AuthProvider } from "./auth-accounts.js";
import type { AuthLogin } from "./auth-proxy.js";
import { shellEscape } from "./agents/shell-escape.js";
import type { QuotaSourceResult } from "./usage-report.js";

export type TerminalLoginTarget =
  | { accountId: string; provider: AuthProvider }
  | { host: AuthProvider };
export type TerminalLoginStatus = "running" | "verifying" | "ready" | "not_signed_in";
export type TerminalLoginReason =
  | "exited"
  | "timed_out"
  | "stopped"
  | "identity"
  | "duplicate"
  | "not_confirmed"
  | "failed"
  | "another_sign_in_pending"
  | "companion_unavailable";

export interface TerminalLogin {
  id: string;
  target: TerminalLoginTarget;
  tmuxSession: string;
  status: TerminalLoginStatus;
  reason?: TerminalLoginReason;
  /** Display string of the native login command running in the terminal; no env, no path. */
  command: string;
}

export interface AuthTerminalDeps {
  dataDir: string;
  homeDir: string;
  createTmuxCommandSession: (input: {
    sessionName: string;
    cwd: string;
    launchCommand: string;
  }) => Promise<void>;
  killTmuxSession: (sessionName: string) => Promise<void>;
  tmuxPaneDead: (sessionName: string, options: { fresh: boolean }) => Promise<boolean>;
  accountProvider: (accountId: string) => AuthProvider;
  cancelLogin: (accountId: string) => Promise<unknown>;
  importNativeLogin: (accountId: string, provider: AuthProvider) => Promise<AuthLogin>;
  loginStatus: (accountId: string) => Promise<AuthLogin>;
  /** Fresh host quota read for one provider; also refreshes the usage cache. */
  hostProbe: (provider: AuthProvider) => Promise<QuotaSourceResult | null>;
  agentCommand: (provider: AuthProvider) => string;
  now: () => number;
}

export const TERMINAL_TICK_MS = 2_000;
export const TERMINAL_DEADLINE_MS = 16 * 60_000;

const ACCOUNT_ID = /^[A-Za-z0-9_-]+$/;
const CLAUDE_UNSET_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
];
const CODEX_UNSET_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"];
/** Arguments of the native login command: builds the tmux launch command and the displayed one. */
const LOGIN_ARGS: Record<AuthProvider, string> = {
  claude: "auth login",
  codex: "login --device-auth",
};

interface Entry {
  login: TerminalLogin;
  /** The displayed login command; copied into every rebuilt login. */
  command: string;
  home?: string;
  startedAt: number;
  ended: boolean;
  following: boolean;
  probedMtimeMs: number | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  cleanup: Promise<void> | undefined;
}

function unsetFlags(names: string[]): string {
  return names.map((name) => `-u ${name}`).join(" ");
}

/** Daemon-owned native sign-in terminals: tmux session, throwaway home, import watcher. */
export class AuthTerminalLogins {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(private readonly deps: AuthTerminalDeps) {}

  private get root(): string {
    return join(this.deps.dataDir, "auth-terminal");
  }

  get(id: string): TerminalLogin {
    const entry = this.entries.get(id);
    if (!entry) throw new AuthorizationError(`Unknown terminal login: ${id}`, 404);
    return { ...entry.login };
  }

  async start(target: { accountId: string } | { host: AuthProvider }): Promise<TerminalLogin> {
    if ("accountId" in target && !ACCOUNT_ID.test(target.accountId)) {
      throw new AuthorizationError("Invalid authorization account id", 400);
    }
    const resolved: TerminalLoginTarget =
      "accountId" in target
        ? { accountId: target.accountId, provider: this.deps.accountProvider(target.accountId) }
        : target;
    const id =
      "host" in resolved ? `auth-login-host-${resolved.host}` : `auth-login-${resolved.accountId}`;
    const previous = this.entries.get(id);
    if (previous && !previous.ended) await this.finish(previous, "not_signed_in", "stopped");

    if ("accountId" in resolved) await this.deps.cancelLogin(resolved.accountId);

    const provider = "host" in resolved ? resolved.host : resolved.provider;
    const displayCommand = `${provider} ${LOGIN_ARGS[provider]}`;
    const entry: Entry = {
      login: {
        id,
        target: resolved,
        tmuxSession: id,
        status: "running",
        command: displayCommand,
      },
      command: displayCommand,
      startedAt: this.deps.now(),
      ended: false,
      following: false,
      probedMtimeMs: null,
      timer: undefined,
      cleanup: undefined,
    };
    const command = shellEscape(this.deps.agentCommand(provider));
    let launchCommand: string;
    let cwd = this.deps.homeDir;
    if ("accountId" in resolved) {
      const home = join(this.root, resolved.accountId);
      await rm(home, { recursive: true, force: true });
      await mkdir(home, { recursive: true, mode: 0o700 });
      if (provider === "codex") {
        await writeFile(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n', {
          mode: 0o600,
        });
      }
      entry.home = home;
      cwd = home;
      launchCommand =
        provider === "claude"
          ? `env ${unsetFlags(CLAUDE_UNSET_ENV)} CLAUDE_CONFIG_DIR=${shellEscape(home)} ${command} ${LOGIN_ARGS.claude}`
          : `env ${unsetFlags(CODEX_UNSET_ENV)} CODEX_HOME=${shellEscape(home)} ${command} ${LOGIN_ARGS.codex}`;
    } else {
      launchCommand =
        provider === "claude"
          ? `env -u CLAUDE_CONFIG_DIR ${command} ${LOGIN_ARGS.claude}`
          : `env -u CODEX_HOME ${command} ${LOGIN_ARGS.codex}`;
    }

    await this.deps.killTmuxSession(id);
    try {
      await this.deps.createTmuxCommandSession({ sessionName: id, cwd, launchCommand });
    } catch (error) {
      await this.cleanup(entry);
      throw error;
    }
    this.entries.set(id, entry);
    this.schedule(entry);
    return { ...entry.login };
  }

  async stop(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new AuthorizationError(`Unknown terminal login: ${id}`, 404);
    if (!entry.ended) await this.finish(entry, "not_signed_in", "stopped");
  }

  /** Daemon start: kill every sign-in tmux session this data dir could own and drop all homes. */
  async sweep(accountIds: readonly string[]): Promise<void> {
    let leftovers: string[] = [];
    try {
      leftovers = await readdir(this.root);
    } catch {
      // no throwaway homes
    }
    const names = new Set([
      "auth-login-host-claude",
      "auth-login-host-codex",
      ...[...accountIds, ...leftovers]
        .filter((id) => ACCOUNT_ID.test(id))
        .map((id) => `auth-login-${id}`),
    ]);
    for (const name of names) await this.deps.killTmuxSession(name);
    await rm(this.root, { recursive: true, force: true });
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  private schedule(entry: Entry): void {
    if (this.disposed || entry.ended) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.tick(entry)
        .catch(() => undefined)
        .finally(() => this.schedule(entry));
    }, TERMINAL_TICK_MS);
    entry.timer.unref();
  }

  private cleanup(entry: Entry): Promise<void> {
    entry.cleanup ??= (async () => {
      await this.deps.killTmuxSession(entry.login.tmuxSession);
      if (entry.home) await rm(entry.home, { recursive: true, force: true });
    })();
    return entry.cleanup;
  }

  // Reads `ended` through a call so a check after an await is not narrowed by an earlier one.
  private hasEnded(entry: Entry): boolean {
    return entry.ended;
  }

  private async finish(
    entry: Entry,
    status: "ready" | "not_signed_in",
    reason?: TerminalLoginReason,
  ): Promise<void> {
    if (entry.ended) return;
    entry.ended = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.login = {
      id: entry.login.id,
      target: entry.login.target,
      tmuxSession: entry.login.tmuxSession,
      status,
      ...(reason ? { reason } : {}),
      command: entry.command,
    };
    await this.cleanup(entry);
  }

  private setRunning(entry: Entry, reason?: TerminalLoginReason): void {
    if (entry.ended) return;
    entry.login = {
      id: entry.login.id,
      target: entry.login.target,
      tmuxSession: entry.login.tmuxSession,
      status: "running",
      ...(reason ? { reason } : {}),
      command: entry.command,
    };
  }

  private async tick(entry: Entry): Promise<void> {
    if (entry.ended) return;
    if (this.deps.now() - entry.startedAt >= TERMINAL_DEADLINE_MS) {
      await this.finish(entry, "not_signed_in", "timed_out");
      return;
    }
    if ("host" in entry.login.target) await this.tickHost(entry, entry.login.target.host);
    else if (entry.following) await this.follow(entry, entry.login.target.accountId);
    else await this.tickManaged(entry, entry.login.target);
  }

  private async tickManaged(
    entry: Entry,
    target: { accountId: string; provider: AuthProvider },
  ): Promise<void> {
    let result: AuthLogin;
    try {
      result = await this.deps.importNativeLogin(target.accountId, target.provider);
    } catch {
      this.setRunning(entry, "companion_unavailable");
      return;
    }
    if (entry.ended) return;
    if (result.status === "sign-in-required") {
      let dead = false;
      try {
        dead = await this.deps.tmuxPaneDead(entry.login.tmuxSession, { fresh: true });
      } catch {
        // unknown pane state: treat as alive
      }
      if (this.hasEnded(entry)) return;
      if (!dead) {
        this.setRunning(entry);
        return;
      }
      try {
        result = await this.deps.importNativeLogin(target.accountId, target.provider);
      } catch {
        this.setRunning(entry, "companion_unavailable");
        return;
      }
      if (this.hasEnded(entry)) return;
      if (result.status === "sign-in-required") {
        await this.finish(entry, "not_signed_in", "exited");
        return;
      }
    }
    await this.applyLogin(entry, result);
  }

  private async follow(entry: Entry, accountId: string): Promise<void> {
    let result: AuthLogin;
    try {
      result = await this.deps.loginStatus(accountId);
    } catch {
      return;
    }
    if (entry.ended) return;
    await this.applyLogin(entry, result);
  }

  private async applyLogin(entry: Entry, result: AuthLogin): Promise<void> {
    switch (result.status) {
      case "busy":
        this.setRunning(entry, "another_sign_in_pending");
        return;
      case "pending":
        if (!entry.following) {
          entry.following = true;
          entry.login = {
            id: entry.login.id,
            target: entry.login.target,
            tmuxSession: entry.login.tmuxSession,
            status: "verifying",
            command: entry.command,
          };
          await this.cleanup(entry);
        }
        return;
      case "ready":
        await this.finish(entry, "ready");
        return;
      case "failed":
        await this.finish(
          entry,
          "not_signed_in",
          result.errorCode === "identity" ||
            result.errorCode === "duplicate" ||
            result.errorCode === "not_confirmed"
            ? result.errorCode
            : "failed",
        );
        return;
      case "sign-in-required":
        // Reached only while following: the companion lost the attempt.
        await this.finish(entry, "not_signed_in", "failed");
    }
  }

  private async tickHost(entry: Entry, provider: AuthProvider): Promise<void> {
    const path =
      provider === "claude"
        ? join(this.deps.homeDir, ".claude", ".credentials.json")
        : join(this.deps.homeDir, ".codex", "auth.json");
    let mtimeMs: number | null = null;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      // no credential file yet
    }
    if (entry.ended) return;
    if (mtimeMs !== null && mtimeMs > entry.startedAt && mtimeMs !== entry.probedMtimeMs) {
      entry.probedMtimeMs = mtimeMs;
      entry.login = { ...entry.login, status: "verifying" };
      let result: QuotaSourceResult | null = null;
      try {
        result = await this.deps.hostProbe(provider);
      } catch {
        // probe failure leaves the terminal running
      }
      if (this.hasEnded(entry)) return;
      if (result && (result.status === "ok" || result.error === "rate_limited")) {
        await this.finish(entry, "ready");
        return;
      }
      this.setRunning(entry);
    }
    let dead = false;
    try {
      dead = await this.deps.tmuxPaneDead(entry.login.tmuxSession, { fresh: true });
    } catch {
      // unknown pane state: treat as alive
    }
    if (this.hasEnded(entry)) return;
    if (dead) await this.finish(entry, "not_signed_in", "exited");
  }
}
