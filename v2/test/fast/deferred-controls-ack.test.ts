// First import: registers the harness's vi.mock()s before any src module loads.
import {
  resetSessionServiceHarness,
  disposeSessionServiceHarness,
  agentSubmitAckPacingMock,
  createAgentSubmitAckBindingMock,
  writeSessionMock,
  isProcessRunningInTmuxMock,
  probeTmuxProcessMatchMock,
  sendMessageToTmuxMock,
  sendSensitiveMessageToTmuxMock,
  sendSubmitKeyToTmuxMock,
  logSpurEventMock,
  mockTimerPromisesSleepWithFakeTimers,
  loadSessionServiceModule,
  createSessionStore,
  mockClaudeJsonlState,
  mockClaudeSessionStatus,
  runningSession,
  sessionServiceInternals,
  SUBMIT_UNCONFIRMED,
} from "../helpers/session-service-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/types.js";
// Type-only, so it never bypasses the mocked module registry.
import type { AgentSendOutcome } from "../../src/session-service.js";

describe("SessionService", () => {
  beforeEach(() => resetSessionServiceHarness(() => []));

  afterEach(disposeSessionServiceHarness);

  // spur-f68f: deferred-controls-ack fix.
  // P1 — createAgentSubmitAckBindingMock defaults to null for every agent but
  // codex (resetSessionServiceHarness), and a null binding returns
  // "submitted" before any scan. Every case below overrides it to a live,
  // non-acking binding. P2 — the harness's vi.mock("../../src/agents/index.js",
  // ...) partial-mocks via importOriginal, so the real
  // DEFERRED_CONTROLS_ACK_WINDOW_MS (5_000) flows through unmocked while
  // agentSubmitAckPacingMock still returns 300_000 for claude. P3 — liveness is
  // driven through isProcessRunningInTmuxMock, the only lever over the
  // module-private agentProcessAlive. P4 — assertions read logSpurEventMock
  // (pre-redaction), never the on-disk event log.
  describe("deferred controls ack", () => {
    type DeferredInternals = {
      sendDeferredSensitiveInitialMessage(
        session: Pick<
          SessionRecord,
          "id" | "tmuxSession" | "agent" | "launchCommand" | "worktreePath" | "agentSessionId"
        >,
        message: string,
      ): Promise<AgentSendOutcome>;
    };

    function deferredInternals(service: unknown): DeferredInternals {
      return service as unknown as DeferredInternals;
    }

    // The controls text (containing ap1_) never acks, so the deferred scan
    // times out; any other text (an ordinary body send) acks immediately, so
    // AC2's real deliver() call does not also time out on its unrelated body
    // leg (a live-agent body timeout recovers too, see the body-leg tests).
    function primeLiveNonAckingBinding(
      lastScannedFile: string | null = "/some/claude.jsonl",
    ): void {
      createAgentSubmitAckBindingMock.mockResolvedValue({
        scan: vi.fn().mockImplementation(async (text: string) => ({
          found: !text.includes("ap1_"),
          lastScannedFile,
        })),
      });
    }

    function controlsMessage(): string {
      return `unsubscribe ${"ap1_" + "a".repeat(43)}`;
    }

    it("AC1: live agent that never acks treats controls as delivered with exactly one warn event", async () => {
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      await expect(
        deferredInternals(service).sendDeferredSensitiveInitialMessage(
          runningSession(),
          controlsMessage(),
        ),
      ).resolves.toBe(SUBMIT_UNCONFIRMED);

      const recoveredEvents = logSpurEventMock.mock.calls
        .map(([, entry]) => entry)
        .filter((entry) => entry.event === "session.controls.delivery_recovered");
      expect(recoveredEvents).toHaveLength(1);
      expect(recoveredEvents[0]?.level).toBe("warn");
      expect(
        logSpurEventMock.mock.calls.filter(([, entry]) => entry.level === "error"),
      ).toHaveLength(0);
      service.dispose();
    });

    it("AC2: a real deliver() whose controls leg times out on a live agent does not fail and does not re-send the body", async () => {
      const sessions = createSessionStore();
      sessions.set("api-1", runningSession());
      mockClaudeSessionStatus("waiting", "idle");
      mockClaudeJsonlState("waiting");
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      sendMessageToTmuxMock.mockClear();

      await expect(
        service.deliver("api-1", "the task body", { sensitivePromptSuffix: controlsMessage() }),
      ).resolves.toBeDefined();
      expect(sendMessageToTmuxMock).toHaveBeenCalledTimes(1);
      service.dispose();
    });

    function eventsOf(name: string) {
      return logSpurEventMock.mock.calls
        .map(([, entry]) => entry)
        .filter((entry) => entry.event === name);
    }

    it("a real deliver() whose body ack times out on a live agent resolves, logs delivery_recovered, and still sends the controls", async () => {
      const sessions = createSessionStore();
      sessions.set("api-1", runningSession());
      mockClaudeSessionStatus("waiting", "idle");
      mockClaudeJsonlState("waiting");
      createAgentSubmitAckBindingMock.mockResolvedValue({
        scan: vi.fn().mockResolvedValue({ found: false, lastScannedFile: "/x.jsonl" }),
      });
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService, LaunchPromptPendingError } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      vi.spyOn(sessionServiceInternals(service), "waitForSubmitAck").mockResolvedValue({
        found: false,
        lastScannedFile: "/x.jsonl",
      });
      sendMessageToTmuxMock.mockClear();

      await expect(
        service.deliver("api-1", "the task body", { sensitivePromptSuffix: controlsMessage() }),
      ).resolves.toBeDefined();

      expect(sendMessageToTmuxMock).toHaveBeenCalledTimes(1);
      expect(sendMessageToTmuxMock.mock.calls[0]).toContain("the task body");
      expect(sendSensitiveMessageToTmuxMock).toHaveBeenCalledTimes(1);
      expect(sendSensitiveMessageToTmuxMock.mock.calls[0]).toContain(controlsMessage());
      const recovered = eventsOf("session.message.delivery_recovered");
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.details).toMatchObject({ entryPoint: "deliver" });
      expect(eventsOf("session.message.failed")).toHaveLength(0);
      const holdAt = sessions.get("api-1")?.submitUnconfirmedAt;
      expect(holdAt).toBeDefined();

      // I9: a second deliver during the hold rejects and pastes nothing.
      await expect(
        service.deliver("api-1", "next digest", { sensitivePromptSuffix: controlsMessage() }),
      ).rejects.toBeInstanceOf(LaunchPromptPendingError);
      expect(sessions.get("api-1")?.submitUnconfirmedAt).toBe(holdAt);
      expect(sendMessageToTmuxMock).toHaveBeenCalledTimes(1);
      expect(sendSensitiveMessageToTmuxMock).toHaveBeenCalledTimes(1);
      service.dispose();
    });

    it("a recovered body whose controls leg then fails on a probe diagnostic still resolves, holds, and pastes the body once", async () => {
      const sessions = createSessionStore();
      sessions.set("api-1", runningSession());
      mockClaudeSessionStatus("waiting", "idle");
      mockClaudeJsonlState("waiting");
      createAgentSubmitAckBindingMock.mockResolvedValue({
        scan: vi.fn().mockResolvedValue({ found: false, lastScannedFile: "/x.jsonl" }),
      });
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      vi.spyOn(sessionServiceInternals(service), "waitForSubmitAck").mockResolvedValue({
        found: false,
        lastScannedFile: "/x.jsonl",
      });
      probeTmuxProcessMatchMock
        .mockReset()
        .mockImplementation(async () =>
          sendSensitiveMessageToTmuxMock.mock.calls.length > 0
            ? { alive: false, matchedByName: false, unresponsive: false, diagnostic: "tmux gone" }
            : { alive: true, matchedByName: true, unresponsive: false },
        );
      sendMessageToTmuxMock.mockClear();

      await expect(
        service.deliver("api-1", "the task body", { sensitivePromptSuffix: controlsMessage() }),
      ).resolves.toBeDefined();

      expect(sendMessageToTmuxMock).toHaveBeenCalledTimes(1);
      expect(sendSensitiveMessageToTmuxMock).toHaveBeenCalledTimes(1);
      expect(eventsOf("session.message.delivery_recovered")).toHaveLength(1);
      const failed = eventsOf("session.controls.delivery_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.level).toBe("warn");
      expect(sessions.get("api-1")?.submitUnconfirmedAt).toBeDefined();
      service.dispose();
    });

    it("an acked body whose controls send throws still resolves with one body paste", async () => {
      const sessions = createSessionStore();
      sessions.set("api-1", runningSession());
      mockClaudeSessionStatus("waiting", "idle");
      mockClaudeJsonlState("waiting");
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      sendMessageToTmuxMock.mockClear();
      sendSensitiveMessageToTmuxMock.mockRejectedValueOnce(new Error("paste failed"));

      await expect(
        service.deliver("api-1", "the task body", { sensitivePromptSuffix: controlsMessage() }),
      ).resolves.toBeDefined();

      expect(sendMessageToTmuxMock).toHaveBeenCalledTimes(1);
      expect(eventsOf("session.controls.delivery_failed")).toHaveLength(1);
      expect(eventsOf("session.message.failed")).toHaveLength(0);
      service.dispose();
    });

    it("a real deliver() whose body ack times out on a dead agent rejects and sends no controls", async () => {
      const sessions = createSessionStore();
      sessions.set("api-1", runningSession());
      mockClaudeSessionStatus("waiting", "idle");
      mockClaudeJsonlState("waiting");
      createAgentSubmitAckBindingMock.mockResolvedValue({
        scan: vi.fn().mockResolvedValue({ found: false, lastScannedFile: "/x.jsonl" }),
      });
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      const waitSpy = vi
        .spyOn(sessionServiceInternals(service), "waitForSubmitAck")
        .mockResolvedValue({ found: false, lastScannedFile: "/x.jsonl" });
      sendMessageToTmuxMock.mockClear();
      isProcessRunningInTmuxMock
        .mockReset()
        .mockImplementation(async () => sendMessageToTmuxMock.mock.calls.length === 0);

      await expect(
        service.deliver("api-1", "the task body", { sensitivePromptSuffix: controlsMessage() }),
      ).rejects.toMatchObject({
        name: "SubmitAckTimeoutError",
        processAlive: false,
        probeUnresponsive: false,
      });

      expect(sendMessageToTmuxMock).toHaveBeenCalledTimes(1);
      expect(sendMessageToTmuxMock.mock.calls[0]).toContain("the task body");
      expect(waitSpy).toHaveBeenCalled();
      expect(sendSensitiveMessageToTmuxMock).not.toHaveBeenCalled();
      expect(eventsOf("session.message.failed").length).toBeGreaterThan(0);
      expect(eventsOf("session.message.delivery_recovered")).toHaveLength(0);
      expect(sessions.get("api-1")?.submitUnconfirmedAt).toBeUndefined();
      service.dispose();
    });

    it("AC3: a genuinely dead agent rejects with a typed SubmitAckTimeoutError and this method emits no event of its own", async () => {
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(false);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      await expect(
        deferredInternals(service).sendDeferredSensitiveInitialMessage(
          runningSession(),
          controlsMessage(),
        ),
      ).rejects.toMatchObject({ name: "SubmitAckTimeoutError", processAlive: false });

      // Filtered, not a raw before/after call-count delta: the SessionService
      // constructor fires unawaited background ticks that can log later and
      // bleed into a plain counter. Scoped to this method's own event surface
      // (session.controls.*) so an unrelated background event never fails
      // this assertion for the wrong reason.
      const ownEvents = logSpurEventMock.mock.calls
        .map(([, entry]) => entry)
        .filter((entry) => entry.event.startsWith("session.controls."));
      expect(ownEvents).toHaveLength(0);
      service.dispose();
    });

    // Safety criteria, NOT a proof of the fix (they already hold against
    // unmodified source; the details key-set assertion is the one part that
    // constrains the new code).
    it("AC4: no ap1_ handle reaches an event payload or a persisted session write, and the event details key set is exact", async () => {
      const sessions = createSessionStore();
      sessions.set("api-1", runningSession());
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      const handle = "ap1_" + "a".repeat(43);

      await deferredInternals(service).sendDeferredSensitiveInitialMessage(
        runningSession(),
        `unsubscribe ${handle}`,
      );

      expect(JSON.stringify(logSpurEventMock.mock.calls)).not.toContain(handle);
      const recovered = logSpurEventMock.mock.calls
        .map(([, entry]) => entry)
        .find((entry) => entry.event === "session.controls.delivery_recovered");
      expect(recovered).toBeDefined();
      expect(Object.keys(recovered?.details ?? {}).sort()).toEqual([
        "agent",
        "controlCount",
        "elapsedMs",
        "lastScannedFile",
        "processAlive",
      ]);
      expect(JSON.stringify(writeSessionMock.mock.calls)).not.toContain(handle);
      service.dispose();
    });

    it("AC5: exactly DEFERRED_CONTROLS_MAX_RESENDS bare-Enter resends and 3 scans when the ack never lands", async () => {
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      const waitSpy = vi.spyOn(sessionServiceInternals(service), "waitForSubmitAck");

      await expect(
        deferredInternals(service).sendDeferredSensitiveInitialMessage(
          runningSession(),
          controlsMessage(),
        ),
      ).resolves.toBe(SUBMIT_UNCONFIRMED);

      expect(sendSubmitKeyToTmuxMock).toHaveBeenCalledTimes(2);
      expect(waitSpy).toHaveBeenCalledTimes(3);
      service.dispose();
    });

    it("resend rescue: an ack that lands on the second scan resolves submitted, exactly 1 resend, no delivery_recovered event", async () => {
      // The first window's scan never finds it (acked stays false for the
      // whole first waitForSubmitAck call); the resend's own Enter is what
      // flips `acked`, so the SECOND window's very first scan finds it.
      let acked = false;
      const scan = vi.fn().mockImplementation(async () => ({
        found: acked,
        lastScannedFile: acked ? "/some/claude.jsonl" : null,
      }));
      createAgentSubmitAckBindingMock.mockResolvedValue({ scan });
      sendSubmitKeyToTmuxMock.mockReset().mockImplementation(async () => {
        acked = true;
      });
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      const waitSpy = vi.spyOn(sessionServiceInternals(service), "waitForSubmitAck");

      await expect(
        deferredInternals(service).sendDeferredSensitiveInitialMessage(
          runningSession(),
          controlsMessage(),
        ),
      ).resolves.toBe("submitted");

      expect(sendSubmitKeyToTmuxMock).toHaveBeenCalledTimes(1);
      expect(waitSpy).toHaveBeenCalledTimes(2);
      const recoveredEvents = logSpurEventMock.mock.calls
        .map(([, entry]) => entry)
        .filter((entry) => entry.event === "session.controls.delivery_recovered");
      expect(recoveredEvents).toHaveLength(0);
      service.dispose();
    });

    it("dead agent: the loop stops resending into a dead pane after the first blind scan", async () => {
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(false);
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      const waitSpy = vi.spyOn(sessionServiceInternals(service), "waitForSubmitAck");

      await expect(
        deferredInternals(service).sendDeferredSensitiveInitialMessage(
          runningSession(),
          controlsMessage(),
        ),
      ).rejects.toMatchObject({ name: "SubmitAckTimeoutError", processAlive: false });

      // A dead process does not come back inside one send: the first
      // unacked scan's mid-loop liveness probe sees it dead and breaks
      // before spending a resend on it. Exactly 1 scan, 0 resends.
      expect(waitSpy).toHaveBeenCalledTimes(1);
      expect(sendSubmitKeyToTmuxMock).not.toHaveBeenCalled();
      service.dispose();
    });

    it("unresponsive liveness probe: stops after one scan, latches the read, and throws probeUnresponsive", async () => {
      primeLiveNonAckingBinding();
      probeTmuxProcessMatchMock
        .mockReset()
        .mockResolvedValue({ alive: false, matchedByName: false, unresponsive: true });
      mockTimerPromisesSleepWithFakeTimers();
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      const waitSpy = vi.spyOn(sessionServiceInternals(service), "waitForSubmitAck");

      await expect(
        deferredInternals(service).sendDeferredSensitiveInitialMessage(
          runningSession(),
          controlsMessage(),
        ),
      ).rejects.toMatchObject({
        name: "SubmitAckTimeoutError",
        processAlive: false,
        probeUnresponsive: true,
      });

      expect(waitSpy).toHaveBeenCalledTimes(1);
      expect(sendSubmitKeyToTmuxMock).not.toHaveBeenCalled();
      // Latched: the post-loop read reuses the mid-loop result.
      expect(probeTmuxProcessMatchMock).toHaveBeenCalledTimes(1);
      service.dispose();
    });

    it.each(
      (["mid-loop", "final"] as const).flatMap((boundary) =>
        [false, true].flatMap((unresponsive) =>
          [undefined, "process probe failed"].map((diagnostic) => ({
            boundary,
            unresponsive,
            diagnostic,
          })),
        ),
      ),
    )(
      "deferred ack false-probe contract at $boundary with $unresponsive/$diagnostic",
      async ({ boundary, unresponsive, diagnostic }) => {
        primeLiveNonAckingBinding();
        const { SessionService } = await loadSessionServiceModule();
        const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
        const waitSpy = vi
          .spyOn(sessionServiceInternals(service), "waitForSubmitAck")
          .mockResolvedValue({ found: false, lastScannedFile: null });
        probeTmuxProcessMatchMock.mockReset().mockResolvedValue({
          alive: false,
          matchedByName: false,
          unresponsive,
          ...(diagnostic ? { diagnostic } : {}),
        });
        if (boundary === "final") {
          probeTmuxProcessMatchMock
            .mockResolvedValueOnce({ alive: true, matchedByName: true, unresponsive: false })
            .mockResolvedValueOnce({ alive: true, matchedByName: true, unresponsive: false });
        }
        await expect(
          deferredInternals(service).sendDeferredSensitiveInitialMessage(
            runningSession(),
            controlsMessage(),
          ),
        ).rejects.toMatchObject(
          diagnostic
            ? { name: "TmuxProbeUnknownError", message: diagnostic }
            : {
                name: "SubmitAckTimeoutError",
                processAlive: false,
                probeUnresponsive: unresponsive,
              },
        );
        expect(waitSpy).toHaveBeenCalledTimes(boundary === "mid-loop" ? 1 : 3);
        expect(probeTmuxProcessMatchMock).toHaveBeenCalledTimes(boundary === "mid-loop" ? 1 : 3);
        expect(sendSubmitKeyToTmuxMock).toHaveBeenCalledTimes(boundary === "mid-loop" ? 0 : 2);
        expect(
          logSpurEventMock.mock.calls.filter(
            ([, entry]) => entry.event === "session.controls.delivery_recovered",
          ),
        ).toHaveLength(0);
        service.dispose();
      },
    );

    it("AC7: the deferred scan window is the short constant, not pacing.windowMs", async () => {
      primeLiveNonAckingBinding();
      isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
      mockTimerPromisesSleepWithFakeTimers();
      // Claude's non-fresh-launch pacing is 300_000 (resetSessionServiceHarness
      // default); the deferred path must not use it.
      agentSubmitAckPacingMock.mockReset().mockReturnValue({ windowMs: 300_000, maxResends: 2 });
      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
      const waitSpy = vi.spyOn(sessionServiceInternals(service), "waitForSubmitAck");

      await deferredInternals(service).sendDeferredSensitiveInitialMessage(
        runningSession(),
        controlsMessage(),
      );

      expect(waitSpy).toHaveBeenCalledWith(expect.anything(), expect.any(String), 5_000);
      // The resend cap must also come from the real exported constant
      // (agents/index.ts), not a test literal — this module is
      // partial-mocked via importOriginal (P2), so the real value flows
      // through unmocked.
      const agentsIndex = await import("../../src/agents/index.js");
      expect(agentsIndex.DEFERRED_CONTROLS_MAX_RESENDS).toBe(2);
      expect(waitSpy).toHaveBeenCalledTimes(3);
      service.dispose();
    });
  });
});
