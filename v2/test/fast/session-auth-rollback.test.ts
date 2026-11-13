import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthRegistration } from "../../src/auth-proxy.js";
import {
  authAccountsReadMock,
  authProxyRegisterSessionMock,
  authProxyRemoveAccountMock,
  authProxyRevokeSessionMock,
  createTmuxSessionMock,
  createSessionStore,
  createWorktreeMock,
  disposeSessionServiceHarness,
  findForeignAgentProcessesForSessionMock,
  isProcessRunningInTmuxMock,
  loadSessionServiceModule,
  logSpurEventMock,
  resetSessionServiceHarness,
  tmuxSessionExistsMock,
} from "../helpers/session-service-harness.js";

describe("managed foreground authorization rollback", () => {
  beforeEach(async () => {
    await resetSessionServiceHarness(() => []);
    authAccountsReadMock.mockReturnValue({
      schema: 1,
      accounts: [{ id: "backup", provider: "claude", createdAt: "2026-03-18T09:00:00.000Z" }],
      pools: {
        claude: { defaultAccountId: "backup", defaultGeneration: 0, autoRotate: true },
      },
    });
  });

  afterEach(disposeSessionServiceHarness);

  async function fixture() {
    const sessions = createSessionStore();
    const bindings = new Map<string, AuthRegistration>();
    authProxyRegisterSessionMock.mockImplementation(async (request) => {
      const existing = bindings.get(request.sessionId);
      if (existing && existing.accountId !== request.accountId) {
        throw new Error("different saved authorization");
      }
      const registration: AuthRegistration = existing ?? {
        sessionId: request.sessionId,
        provider: request.provider,
        mode: request.accountId ? "pinned" : "auto",
        accountId: request.accountId,
        effectiveAccountId: "backup",
        generation: 3,
        endpoint: "http://127.0.0.1:9999",
        token: "fixture-routing-key",
      };
      bindings.set(request.sessionId, registration);
      return registration;
    });
    authProxyRevokeSessionMock.mockImplementation(async (id) => {
      bindings.delete(id);
    });
    authProxyRemoveAccountMock.mockImplementation(async () => {
      if ([...bindings.values()].some((binding) => binding.accountId === "backup")) {
        throw new Error("account still referenced");
      }
    });
    isProcessRunningInTmuxMock.mockResolvedValue(false);
    tmuxSessionExistsMock.mockResolvedValue(false);
    findForeignAgentProcessesForSessionMock.mockResolvedValue({ status: "ok", pids: [] });
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z", {
      deferBackgroundLoops: true,
    });
    return { service, sessions, bindings };
  }

  async function failWorktree(service: Awaited<ReturnType<typeof fixture>>["service"]) {
    createWorktreeMock.mockRejectedValueOnce(new Error("fixture worktree failure"));
    await expect(
      service.spawn({ project: "api", prompt: "fixture", authAccountId: "backup" }),
    ).rejects.toThrow("fixture worktree failure");
  }

  it("retains the pinned binding and generation on the errored record", async () => {
    const { service, sessions, bindings } = await fixture();
    await failWorktree(service);
    expect(sessions.get("api-1")).toMatchObject({
      status: "errored",
      auth: { mode: "pinned", accountId: "backup", effectiveAccountId: "backup", generation: 3 },
    });
    expect(sessions.get("api-1")?.auth).not.toHaveProperty("token");
    expect(bindings.get("api-1")?.accountId).toBe("backup");
    expect(authProxyRevokeSessionMock).not.toHaveBeenCalled();
  });

  it("restores the failed session with its retained authorization", async () => {
    const { service } = await fixture();
    await failWorktree(service);
    createTmuxSessionMock.mockImplementation(async () => {
      isProcessRunningInTmuxMock.mockResolvedValue(true);
      tmuxSessionExistsMock.mockResolvedValue(true);
    });
    await expect(service.restore("api-1")).resolves.toBeDefined();
    expect(authProxyRegisterSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionId: "api-1",
      accountId: "backup",
    });
  });

  it("keeps a newer persisted binding instead of replacing it with the initial registration", async () => {
    const { service, sessions, bindings } = await fixture();
    createWorktreeMock.mockImplementationOnce(async () => {
      const current = sessions.get("api-1");
      const binding = bindings.get("api-1");
      if (!current || !binding) throw new Error("Missing fixture authorization");
      const next = { ...binding, accountId: "next", effectiveAccountId: "next", generation: 4 };
      bindings.set("api-1", next);
      const { token: _token, endpoint: _endpoint, ...auth } = next;
      sessions.set("api-1", { ...current, auth });
      throw new Error("fixture worktree failure");
    });
    await expect(
      service.spawn({ project: "api", prompt: "fixture", authAccountId: "backup" }),
    ).rejects.toThrow("fixture worktree failure");
    expect(sessions.get("api-1")?.auth).toMatchObject({ accountId: "next", generation: 4 });
  });

  it("revokes the failed session binding before removing its account", async () => {
    const { service, bindings } = await fixture();
    await failWorktree(service);
    await expect(service.removeAuthorizationAccount("backup")).resolves.toBeUndefined();
    expect(bindings.size).toBe(0);
    expect(authProxyRevokeSessionMock).toHaveBeenCalledWith("api-1");
  });

  it.each([
    { name: "live", scan: { status: "ok" as const, pids: [4242] } },
    { name: "unknown", scan: { status: "unavailable" as const } },
  ])("refuses errored account removal when process ownership is $name", async ({ scan }) => {
    const { service, bindings } = await fixture();
    await failWorktree(service);
    findForeignAgentProcessesForSessionMock.mockResolvedValue(scan);
    await expect(service.removeAuthorizationAccount("backup")).rejects.toThrow(
      "session process exit is unconfirmed",
    );
    expect(bindings.get("api-1")?.accountId).toBe("backup");
    expect(authProxyRevokeSessionMock).not.toHaveBeenCalled();
    expect(authProxyRemoveAccountMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "absent", scan: { status: "ok" as const, pids: [] }, revoke: true },
    { name: "live", scan: { status: "ok" as const, pids: [4242] }, revoke: false },
    { name: "unknown", scan: { status: "unavailable" as const }, revoke: false },
  ])(
    "pre-placeholder rollback retains authorization unless owner is absent: $name",
    async ({ scan, revoke }) => {
      const { service, sessions, bindings } = await fixture();
      findForeignAgentProcessesForSessionMock.mockResolvedValue(scan);
      logSpurEventMock.mockImplementation((_directory, event) => {
        if (event.event === "session.spawn.started") {
          throw new Error("fixture before placeholder");
        }
      });
      await expect(
        service.spawn({ project: "api", prompt: "fixture", authAccountId: "backup" }),
      ).rejects.toThrow("fixture before placeholder");
      expect(sessions.size).toBe(0);
      expect(findForeignAgentProcessesForSessionMock).toHaveBeenCalledWith({
        sessionId: "api-1",
        processMatchers: expect.any(Array),
        excludePanePids: [],
      });
      expect(bindings.has("api-1")).toBe(!revoke);
      if (revoke) expect(authProxyRevokeSessionMock).toHaveBeenCalledWith("api-1");
      else {
        expect(authProxyRevokeSessionMock).not.toHaveBeenCalled();
        expect(logSpurEventMock.mock.calls).toContainEqual([
          expect.any(String),
          expect.objectContaining({
            event: "session.spawn.failed",
            details: expect.objectContaining({
              authorizationRollbackWarning: expect.stringContaining("Saved authorization retained"),
            }),
          }),
        ]);
      }
    },
  );
});
