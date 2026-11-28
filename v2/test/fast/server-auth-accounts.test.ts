import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthAccounts } from "../../src/auth-accounts.js";
import { AuthProxy } from "../../src/auth-proxy.js";
import { startServer, type StartedServer } from "../../src/server.js";
import { SessionService } from "../../src/session-service.js";
import { findFreePort } from "../helpers/common.js";
import type { SessionView } from "../../src/types.js";

describe("managed authorization HTTP boundary", () => {
  let server: StartedServer | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await server?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function fixture(): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), "spur-auth-http-"));
    const port = await findFreePort();
    const config = join(directory, "config.yaml");
    await writeFile(
      config,
      `server: {host: 127.0.0.1, port: ${port}}\ndataDir: ${join(directory, "data")}\nworktreeDir: ${join(directory, "worktrees")}\n`,
    );
    server = await startServer(config, { info: () => undefined, warn: () => undefined });
    return `http://127.0.0.1:${port}`;
  }

  it("lists provider profiles and rejects a wrong provider before service dispatch", async () => {
    const list = vi
      .spyOn(SessionService.prototype, "listAuthorizationAccounts")
      .mockResolvedValue({ accounts: [], pools: {} });
    const base = await fixture();
    expect((await fetch(`${base}/auth-accounts?agent=codex`)).status).toBe(200);
    expect(list).toHaveBeenCalledWith("codex", { quota: true });
    list.mockClear();
    expect((await fetch(`${base}/auth-accounts?agent=cursor`)).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("validates login input and forwards explicit cancellation without treating files as ready", async () => {
    const input = vi
      .spyOn(SessionService.prototype, "authorizationLoginInput")
      .mockResolvedValue({ accountId: "work", status: "sign-in-required" });
    const base = await fixture();
    const send = (body: object) =>
      fetch(`${base}/auth-accounts/work/login-input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await send({})).status).toBe(400);
    expect(input).not.toHaveBeenCalled();
    const response = await send({ cancel: true });
    expect(await response.json()).toEqual({ accountId: "work", status: "sign-in-required" });
    expect(input).toHaveBeenCalledWith("work", null);
  });

  const pool = { defaultAccountId: null, defaultGeneration: 0, autoRotate: false };

  it.each([{}, { autoRotate: false }, { defaultAccountId: null }])(
    "preserves omitted pool fields and explicit values %j, keeping active sessions",
    async (update) => {
      const change = vi
        .spyOn(SessionService.prototype, "updateAuthorizationPool")
        .mockResolvedValue({ pool, moved: 0 });
      const base = await fixture();
      const response = await fetch(`${base}/auth-pools/codex`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      expect(response.status).toBe(200);
      expect(change).toHaveBeenCalledExactlyOnceWith("codex", update, false);
    },
  );

  it.each([true, false])("forwards applyToActive=%s and returns moved", async (applyToActive) => {
    const change = vi
      .spyOn(SessionService.prototype, "updateAuthorizationPool")
      .mockResolvedValue({ pool, moved: 3 });
    const base = await fixture();
    const send = (body: unknown) =>
      fetch(`${base}/auth-pools/claude`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const response = await send({ defaultAccountId: "work", applyToActive });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pool, moved: 3 });
    expect(change).toHaveBeenCalledExactlyOnceWith(
      "claude",
      { defaultAccountId: "work" },
      applyToActive,
    );
    expect((await send({ defaultAccountId: "work", applyToActive: "yes" })).status).toBe(400);
    expect((await send({ applyToActive: true })).status).toBe(400);
    expect((await send({ autoRotate: true, applyToActive: false })).status).toBe(400);
    expect(change).toHaveBeenCalledTimes(1);
  });

  const post = (base: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const account = (provider: "claude" | "codex") => ({
    schema: 1 as const,
    accounts: [{ id: "work", provider, createdAt: "2026-11-16T00:00:00.000Z" }],
    pools: {},
  });

  it("login forwards method; wrong method for provider is 400", async () => {
    vi.spyOn(AuthAccounts.prototype, "read").mockReturnValue(account("codex"));
    const login = vi
      .spyOn(AuthProxy.prototype, "login")
      .mockResolvedValue({ accountId: "work", status: "pending" });
    const base = await fixture();
    expect((await post(base, "/auth-accounts/work/login", { method: "browser" })).status).toBe(200);
    expect(login).toHaveBeenLastCalledWith("work", "codex", "browser");
    expect((await post(base, "/auth-accounts/work/login")).status).toBe(200);
    expect(login).toHaveBeenLastCalledWith("work", "codex", "device");
    login.mockClear();
    expect((await post(base, "/auth-accounts/work/login", { method: "oauth" })).status).toBe(400);
    expect((await post(base, "/auth-accounts/work/login", { method: "magic" })).status).toBe(400);
    expect((await post(base, "/auth-accounts/work/login", { extra: 1 })).status).toBe(400);
    expect(login).not.toHaveBeenCalled();
    vi.spyOn(AuthAccounts.prototype, "read").mockReturnValue(account("claude"));
    expect((await post(base, "/auth-accounts/work/login", { method: "device" })).status).toBe(400);
    expect((await post(base, "/auth-accounts/work/login")).status).toBe(200);
    expect(login).toHaveBeenCalledExactlyOnceWith("work", "claude", "oauth");
  });

  it("api-key takes only apiKey and never echoes it", async () => {
    vi.spyOn(AuthAccounts.prototype, "read").mockReturnValue(account("claude"));
    const setKey = vi
      .spyOn(AuthProxy.prototype, "setApiKey")
      .mockResolvedValue({ accountId: "work", status: "pending", method: "api_key" });
    const base = await fixture();
    const secret = "sk-test-secret-value";
    for (const bad of [
      {},
      { label: "A" },
      { label: "A", apiKey: secret },
      { apiKey: secret, x: 1 },
    ]) {
      const response = await post(base, "/auth-accounts/work/api-key", bad);
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain(secret);
    }
    expect(setKey).not.toHaveBeenCalled();
    const response = await post(base, "/auth-accounts/work/api-key", { apiKey: secret });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(secret);
    expect(setKey).toHaveBeenCalledWith("work", "claude", secret);
  });

  it("add takes only a provider; renaming an account is gone", async () => {
    const add = vi
      .spyOn(SessionService.prototype, "addAuthorizationAccount")
      .mockResolvedValue({ id: "new", provider: "codex", createdAt: "x" });
    const base = await fixture();
    expect((await post(base, "/auth-accounts", { provider: "codex", label: "Work" })).status).toBe(
      400,
    );
    expect(add).not.toHaveBeenCalled();
    expect((await post(base, "/auth-accounts", { provider: "codex" })).status).toBe(201);
    expect(add).toHaveBeenCalledExactlyOnceWith("codex");
    const renamed = await fetch(`${base}/auth-accounts/new`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Work" }),
    });
    expect(renamed.status).toBe(404);
  });

  it("legacy /claude-accounts ignores a label and exposes only the legacy projection", async () => {
    const stored = { id: "work", provider: "claude" as const, createdAt: "x" };
    const added = vi.spyOn(AuthAccounts.prototype, "add").mockReturnValue(stored);
    vi.spyOn(AuthAccounts.prototype, "read").mockReturnValue({
      schema: 1,
      accounts: [{ ...stored, identity: { email: "alek@x.com", organizationId: "org-1" } }],
      pools: {},
    });
    vi.spyOn(AuthProxy.prototype, "configure").mockResolvedValue();
    vi.spyOn(AuthProxy.prototype, "getState").mockResolvedValue({
      accounts: [
        {
          id: "work",
          provider: "claude",
          status: "ready",
          credential: "oauth",
          identity: { email: "alek@x.com", organizationId: "org-1" },
        },
      ],
      sessions: [],
    });
    vi.spyOn(SessionService.prototype, "startAccountLogin").mockResolvedValue({
      loginTmuxSession: "claude-login-work",
    });
    const base = await fixture();
    const created = await post(base, "/claude-accounts/add", { label: "Typed" });
    expect(created.status).toBe(201);
    expect(added).toHaveBeenCalledExactlyOnceWith("claude");
    expect(await created.json()).toEqual({
      account: { id: "work", label: "New Claude account", authenticated: false },
      loginTmuxSession: "claude-login-work",
    });
    const listed = (await (await fetch(`${base}/claude-accounts`)).json()) as {
      accounts: Record<string, unknown>[];
    };
    expect(Object.keys(listed.accounts[0] ?? {}).sort()).toEqual([
      "authenticated",
      "createdAt",
      "credential",
      "id",
      "label",
      "limited",
      "provider",
      "status",
    ]);
    expect(listed.accounts[0]).toMatchObject({ label: "alek@x.com" });
    expect(JSON.stringify(listed)).not.toContain("org-1");
  });

  it("user-action record for api-key has no params", async () => {
    vi.spyOn(AuthAccounts.prototype, "read").mockReturnValue(account("claude"));
    vi.spyOn(AuthProxy.prototype, "setApiKey").mockResolvedValue({
      accountId: "work",
      status: "pending",
    });
    const base = await fixture();
    const secret = "sk-test-secret-value";
    await post(base, "/auth-accounts/work/api-key", { apiKey: secret });
    const log = await readFile(join(directory!, "data", "user-actions.jsonl"), "utf8");
    expect(log).toContain("/auth-accounts/work/api-key");
    expect(log).not.toContain(secret);
    expect(log).not.toContain('"params"');
  });

  it("auth-alerts returns service alerts", async () => {
    const alerts = [
      {
        id: "managed:work",
        kind: "managed" as const,
        provider: "claude" as const,
        accountId: "work",
        label: "Work",
        since: "2026-11-16T09:00:00Z",
        sessionsWaiting: 1,
      },
    ];
    vi.spyOn(SessionService.prototype, "listAuthAlerts").mockResolvedValue({ alerts });
    const base = await fixture();
    const response = await fetch(`${base}/auth-alerts`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ alerts });
  });

  it("terminal-logins validate target union and 404 unknown id", async () => {
    const terminal = {
      id: "auth-login-host-codex",
      target: { host: "codex" as const },
      tmuxSession: "auth-login-host-codex",
      status: "running" as const,
      command: "codex login --device-auth",
    };
    const start = vi
      .spyOn(SessionService.prototype, "startTerminalLogin")
      .mockResolvedValue(terminal);
    const base = await fixture();
    for (const bad of [
      {},
      { host: "cursor" },
      { accountId: "a", host: "codex" },
      { accountId: "" },
    ]) {
      expect((await post(base, "/auth-terminal-logins", bad)).status).toBe(400);
    }
    expect(start).not.toHaveBeenCalled();
    const ok = await post(base, "/auth-terminal-logins", { host: "codex" });
    expect(await ok.json()).toEqual(terminal);
    expect(start).toHaveBeenCalledWith({ host: "codex" });
    await post(base, "/auth-terminal-logins", { accountId: "work" });
    expect(start).toHaveBeenLastCalledWith({ accountId: "work" });
    const missing = await fetch(`${base}/auth-terminal-logins/auth-login-nope`);
    expect(missing.status).toBe(404);
    const removed = await fetch(`${base}/auth-terminal-logins/auth-login-nope`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(404);
    vi.spyOn(SessionService.prototype, "stopTerminalLogin").mockResolvedValue();
    const stopped = await fetch(`${base}/auth-terminal-logins/auth-login-host-codex`, {
      method: "DELETE",
    });
    expect(await stopped.json()).toEqual({ stopped: "auth-login-host-codex" });
  });

  it("accepts Auto account selection without the legacy Claude-menu gate", async () => {
    const change = vi
      .spyOn(SessionService.prototype, "switchAuth")
      .mockResolvedValue({ id: "agent-1" } as SessionView);
    const base = await fixture();
    const response = await fetch(`${base}/sessions/agent-1/switch-auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: null }),
    });
    expect(response.status).toBe(200);
    expect(change).toHaveBeenCalledWith("agent-1", null, { reason: "manual", force: false });
  });
});
