import {
  resetSessionServiceHarness,
  disposeSessionServiceHarness,
  baseConfig,
  loadConfigMock,
  loadSessionServiceModule,
  createSessionStore,
  runningSession,
  mockClaudeJsonlState,
  sessionServiceInternals,
  createTmuxSessionMock,
  killTmuxSessionMock,
  terminateAgentProcessesMock,
  buildAgentRestorePlanMock,
  removeWorktreeMock,
} from "../helpers/session-service-harness.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetSessionServiceHarness(() => []);
  mockClaudeJsonlState("waiting");
});

afterEach(disposeSessionServiceHarness);

async function fixture(scope: "global" | "project", warmup: boolean, stopped = false) {
  const config = baseConfig();
  loadConfigMock.mockReturnValue({
    ...config,
    admission: { ...config.admission, maxLiveSessions: scope === "global" ? 2 : 10 },
    projects: {
      api: {
        ...config.projects.api,
        ...(scope === "project" ? { maxLiveSessions: 2 } : {}),
        modes: { manager: { skill: "manager" } },
      },
    },
  });
  const target = runningSession({
    id: "api-a",
    status: stopped ? "stopped" : "running",
    ...(stopped ? { stopReason: "manual_pause" as const } : {}),
    agentSessionId: "session-uuid",
    model: "sonnet",
    mode: "manager",
  });
  const peer = runningSession({ id: "api-b", agentSessionId: "peer-native-id" });
  const cold = runningSession({ id: "api-c", status: "stopped", stopReason: "manual_pause" });
  const sessions = createSessionStore(target, peer, cold);
  const { SessionService, SessionAdmissionDeniedError } = await loadSessionServiceModule();
  const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z", {
    deferBackgroundLoops: true,
  });
  const deadline = Date.now() + 30_000;
  if (warmup) sessionServiceInternals(service).restoreWarmupUntil.set(target.id, deadline);
  return { service, sessions, target, peer, cold, deadline, SessionAdmissionDeniedError };
}

describe.each(["global", "project"] as const)("public restart admission at the %s cap", (scope) => {
  it.each([true, false])(
    "restarts at cap with retained warmup %s and preserves identity and peer",
    async (warmup) => {
      const { service, sessions, target, peer, deadline } = await fixture(scope, warmup);
      expect(Date.now()).toBeLessThan(deadline);
      const restored = await service.restore(target.id, { restart: true });
      expect(restored.status).toBe("running");
      expect(sessions.get(target.id)).toMatchObject({
        id: target.id,
        agentSessionId: target.agentSessionId,
        worktreePath: target.worktreePath,
        prompt: target.prompt,
        model: target.model,
        mode: target.mode,
      });
      expect(sessions.get(peer.id)).toEqual(peer);
      expect(sessionServiceInternals(service).restoreWarmupUntil.get(target.id)).toBe(deadline);
      expect(Date.now()).toBeLessThan(deadline);
      expect(killTmuxSessionMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
        createTmuxSessionMock.mock.invocationCallOrder[0]!,
      );
      expect(terminateAgentProcessesMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
        createTmuxSessionMock.mock.invocationCallOrder[0]!,
      );
      expect(buildAgentRestorePlanMock).toHaveBeenCalledWith(
        "claude",
        target.worktreePath,
        "",
        expect.objectContaining({ model: target.model, agentSessionId: target.agentSessionId }),
      );
      expect(removeWorktreeMock).not.toHaveBeenCalled();
    },
  );

  it("counts the target's own warmup during ordinary restore", async () => {
    const { service, sessions, target, peer, deadline, SessionAdmissionDeniedError } =
      await fixture(scope, true, true);
    await expect(service.restore(target.id)).rejects.toMatchObject({
      constructor: SessionAdmissionDeniedError,
      reason: "cap",
      message: expect.stringContaining("2 live, 0 reserved"),
    });
    expect(createTmuxSessionMock).not.toHaveBeenCalled();
    expect(killTmuxSessionMock).not.toHaveBeenCalled();
    expect(sessions.get(target.id)).toEqual(target);
    expect(sessions.get(peer.id)).toEqual(peer);
    expect(sessionServiceInternals(service).restoreWarmupUntil.get(target.id)).toBe(deadline);
    expect(Date.now()).toBeLessThan(deadline);
  });

  it("denies unrelated cold restore while stopped warmup and running peer claim cap", async () => {
    const { service, sessions, target, peer, cold, deadline, SessionAdmissionDeniedError } =
      await fixture(scope, true, true);
    await expect(service.restore(cold.id)).rejects.toMatchObject({
      constructor: SessionAdmissionDeniedError,
      reason: "cap",
      message: expect.stringContaining("2 live, 0 reserved"),
    });
    expect(createTmuxSessionMock).not.toHaveBeenCalled();
    expect(killTmuxSessionMock).not.toHaveBeenCalled();
    expect(sessions.get(target.id)).toEqual(target);
    expect(sessions.get(peer.id)).toEqual(peer);
    expect(sessions.get(cold.id)).toEqual(cold);
    expect(sessionServiceInternals(service).restoreWarmupUntil.get(target.id)).toBe(deadline);
    expect(Date.now()).toBeLessThan(deadline);
  });

  it.each(["warmup", "reservation"] as const)(
    "counts a competing %s acquired during strict stop",
    async (claim) => {
      const { service, sessions, target, peer, cold, deadline, SessionAdmissionDeniedError } =
        await fixture(scope, true);
      const internals = sessionServiceInternals(service);
      const reservation = Symbol("competing admission");
      terminateAgentProcessesMock.mockImplementationOnce(async () => {
        if (claim === "warmup") internals.restoreWarmupUntil.set(cold.id, deadline);
        else internals.admissionReservations.set(reservation, target.project);
        return { status: "clear" };
      });
      await expect(service.restore(target.id, { restart: true })).rejects.toMatchObject({
        constructor: SessionAdmissionDeniedError,
        reason: "cap",
        message: expect.stringContaining(
          claim === "warmup" ? "2 live, 0 reserved" : "1 live, 1 reserved",
        ),
      });
      expect(terminateAgentProcessesMock).toHaveBeenCalledOnce();
      expect(killTmuxSessionMock).toHaveBeenCalledOnce();
      expect(createTmuxSessionMock).not.toHaveBeenCalled();
      expect(sessions.get(target.id)).toMatchObject({ status: "stopped" });
      expect(sessions.get(peer.id)).toEqual(peer);
      expect(sessions.get(cold.id)).toEqual(cold);
      expect(internals.restoreWarmupUntil.get(target.id)).toBe(deadline);
      if (claim === "warmup") expect(internals.restoreWarmupUntil.get(cold.id)).toBe(deadline);
      else expect(internals.admissionReservations.get(reservation)).toBe(target.project);
      expect(Date.now()).toBeLessThan(deadline);
    },
  );
});
