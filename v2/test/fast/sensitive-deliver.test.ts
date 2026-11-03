// First import: registers the harness's vi.mock()s before any src module loads.
import {
  resetSessionServiceHarness,
  disposeSessionServiceHarness,
  createAgentSubmitAckBindingMock,
  isProcessRunningInTmuxMock,
  sendMessageToTmuxMock,
  sendSensitiveMessageToTmuxMock,
  mockTimerPromisesSleepWithFakeTimers,
  loadSessionServiceModule,
  createSessionStore,
  mockClaudeJsonlState,
  mockClaudeSessionStatus,
  runningSession,
  sessionServiceInternals,
} from "../helpers/session-service-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HANDLE = `ap1_${"a".repeat(43)}`;
const MESSAGE = `body\n\nCan't act now? Mute\n  forever   spur auto-ping mute ${HANDLE} --forever`;

describe("SessionService sensitive deliver", () => {
  beforeEach(() => resetSessionServiceHarness(() => []));
  afterEach(disposeSessionServiceHarness);

  async function setup() {
    const sessions = createSessionStore();
    sessions.set("api-1", runningSession());
    mockClaudeSessionStatus("waiting", "idle");
    mockClaudeJsonlState("waiting");
    isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
    mockTimerPromisesSleepWithFakeTimers();
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    sendMessageToTmuxMock.mockClear();
    sendSensitiveMessageToTmuxMock.mockClear();
    return { sessions, service };
  }

  function storedText(sessions: Map<string, unknown>): string {
    return JSON.stringify([...sessions.values()]);
  }

  it("writes the full message once through the sensitive transport and never the argv path", async () => {
    const { sessions, service } = await setup();

    await expect(service.deliver("api-1", MESSAGE, { sensitive: true })).resolves.toBeDefined();

    expect(sendSensitiveMessageToTmuxMock).toHaveBeenCalledTimes(1);
    expect(sendSensitiveMessageToTmuxMock.mock.calls[0]?.[1]).toBe(MESSAGE);
    expect(sendMessageToTmuxMock).not.toHaveBeenCalled();
    expect(storedText(sessions)).not.toContain("ap1_");
    service.dispose();
  });

  it("keeps the normal transport for a non-sensitive deliver", async () => {
    const { service } = await setup();
    await service.deliver("api-1", "plain body");
    expect(sendMessageToTmuxMock).toHaveBeenCalledTimes(1);
    expect(sendSensitiveMessageToTmuxMock).not.toHaveBeenCalled();
    service.dispose();
  });

  it("persists no text when the submit ack times out on a live agent", async () => {
    const { sessions, service } = await setup();
    createAgentSubmitAckBindingMock.mockResolvedValue({
      scan: vi.fn().mockResolvedValue({ found: false, lastScannedFile: "/x.jsonl" }),
    });
    vi.spyOn(sessionServiceInternals(service), "waitForSubmitAck").mockResolvedValue({
      found: false,
      lastScannedFile: "/x.jsonl",
    });

    await expect(service.deliver("api-1", MESSAGE, { sensitive: true })).resolves.toBeDefined();

    expect(sendSensitiveMessageToTmuxMock).toHaveBeenCalledTimes(1);
    expect(storedText(sessions)).not.toContain("ap1_");
    expect(sessions.get("api-1")?.queuedMessageTyped).toBeUndefined();
    service.dispose();
  });

  it("treats an unknown liveness probe as delivered and persists no text", async () => {
    const { sessions, service } = await setup();
    const { TmuxProbeUnknownError } = await import("../../src/runtime-tmux.js");
    createAgentSubmitAckBindingMock.mockResolvedValue({
      scan: vi.fn().mockResolvedValue({ found: false, lastScannedFile: null }),
    });
    vi.spyOn(sessionServiceInternals(service), "waitForSubmitAck").mockRejectedValue(
      new TmuxProbeUnknownError("probe unavailable"),
    );

    await expect(service.deliver("api-1", MESSAGE, { sensitive: true })).resolves.toBeDefined();

    expect(storedText(sessions)).not.toContain("ap1_");
    expect(sessions.get("api-1")?.submitUnconfirmedAt).toBeUndefined();
    service.dispose();
  });

  it("persists no text when the write fails", async () => {
    const { sessions, service } = await setup();
    sendSensitiveMessageToTmuxMock.mockRejectedValueOnce(new Error("paste failed"));

    await expect(service.deliver("api-1", MESSAGE, { sensitive: true })).rejects.toThrow(
      "paste failed",
    );

    expect(storedText(sessions)).not.toContain("ap1_");
    expect(sessions.get("api-1")?.queuedMessages?.messages ?? []).toEqual([]);
    service.dispose();
  });

  it("refuses a sensitive message on an interactive or queued path", async () => {
    const { service } = await setup();
    const internals = sessionServiceInternals(service) as unknown as {
      runDeliveryTransaction(
        sessionId: string,
        message: string,
        intent: { kind: string },
        options: { sensitive: true; interactive?: boolean },
      ): Promise<unknown>;
    };
    await expect(
      internals.runDeliveryTransaction(
        "api-1",
        MESSAGE,
        { kind: "direct" },
        { sensitive: true, interactive: true },
      ),
    ).rejects.toThrow(/never queued/);
    expect(sendSensitiveMessageToTmuxMock).not.toHaveBeenCalled();
    service.dispose();
  });
});
