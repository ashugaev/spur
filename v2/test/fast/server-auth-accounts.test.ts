import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
