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
    expect(list).toHaveBeenCalledWith("codex");
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

  it.each([{}, { autoRotate: false }, { defaultAccountId: null }])(
    "preserves omitted pool fields and explicit values %j",
    async (update) => {
      const change = vi
        .spyOn(SessionService.prototype, "updateAuthorizationPool")
        .mockResolvedValue({ defaultAccountId: null, defaultGeneration: 0, autoRotate: false });
      const base = await fixture();
      const response = await fetch(`${base}/auth-pools/codex`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      expect(response.status).toBe(200);
      expect(change).toHaveBeenCalledExactlyOnceWith("codex", update);
    },
  );

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

  it("api-key requires label and apiKey, renames, never echoes key", async () => {
    vi.spyOn(AuthAccounts.prototype, "read").mockReturnValue(account("claude"));
    const rename = vi
      .spyOn(AuthAccounts.prototype, "rename")
      .mockReturnValue({ id: "work", provider: "claude", createdAt: "x" });
    const setKey = vi
      .spyOn(AuthProxy.prototype, "setApiKey")
      .mockResolvedValue({ accountId: "work", status: "pending", method: "api_key" });
    const base = await fixture();
    const secret = "sk-test-secret-value";
    for (const bad of [{}, { label: "A" }, { apiKey: secret }, { label: " ", apiKey: secret }]) {
      const response = await post(base, "/auth-accounts/work/api-key", bad);
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain(secret);
    }
    expect(
      (await post(base, "/auth-accounts/work/api-key", { label: "A", apiKey: secret, x: 1 }))
        .status,
    ).toBe(400);
    expect(setKey).not.toHaveBeenCalled();
    const response = await post(base, "/auth-accounts/work/api-key", {
      label: " Work key ",
      apiKey: secret,
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(secret);
    expect(rename).toHaveBeenCalledWith("work", "Work key");
    expect(setKey).toHaveBeenCalledWith("work", "claude", secret);
  });

  it("user-action record for api-key has no params", async () => {
    vi.spyOn(AuthAccounts.prototype, "read").mockReturnValue(account("claude"));
    vi.spyOn(AuthAccounts.prototype, "rename").mockReturnValue({
      id: "work",
      provider: "claude",
      createdAt: "x",
    });
    vi.spyOn(AuthProxy.prototype, "setApiKey").mockResolvedValue({
      accountId: "work",
      status: "pending",
    });
    const base = await fixture();
    const secret = "sk-test-secret-value";
    await post(base, "/auth-accounts/work/api-key", { label: "A", apiKey: secret });
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
