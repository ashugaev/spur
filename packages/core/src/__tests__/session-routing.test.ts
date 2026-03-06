import { describe, expect, it } from "vitest";
import {
  coerceOrchestratorSessionRoutingCandidates,
  selectFallbackOrchestratorSessionId,
  type OrchestratorSessionRoutingCandidate,
} from "../session-routing.js";

function makeCandidate(
  partial: Partial<OrchestratorSessionRoutingCandidate> & Pick<OrchestratorSessionRoutingCandidate, "id">,
): OrchestratorSessionRoutingCandidate {
  return {
    id: partial.id,
    status: partial.status ?? "working",
    activity: partial.activity ?? "active",
    lastActivityAt: partial.lastActivityAt ?? new Date("2026-03-06T00:00:00.000Z"),
    metadata: partial.metadata,
  };
}

describe("selectFallbackOrchestratorSessionId", () => {
  it("returns default session id when explicitly configured", () => {
    const sessionId = selectFallbackOrchestratorSessionId(
      [makeCandidate({ id: "app-orchestrator" })],
      { defaultSessionId: "forced-session" },
    );
    expect(sessionId).toBe("forced-session");
  });

  it("prefers the configured project orchestrator when available", () => {
    const sessionId = selectFallbackOrchestratorSessionId(
      [
        makeCandidate({ id: "lib-orchestrator", lastActivityAt: "2026-03-06T00:00:01.000Z" }),
        makeCandidate({ id: "app-orchestrator", lastActivityAt: "2026-03-06T00:00:00.000Z" }),
      ],
      { preferredOrchestratorSessionId: "app-orchestrator" },
    );
    expect(sessionId).toBe("app-orchestrator");
  });

  it("excludes terminal sessions from active candidates", () => {
    const sessionId = selectFallbackOrchestratorSessionId([
      makeCandidate({ id: "dead-orchestrator", status: "killed", activity: "exited" }),
      makeCandidate({ id: "live-orchestrator", status: "working", activity: "ready" }),
    ]);
    expect(sessionId).toBe("live-orchestrator");
  });

  it("returns null when multiple routable orchestrators exist without explicit preference", () => {
    const sessionId = selectFallbackOrchestratorSessionId([
      makeCandidate({ id: "a-orchestrator", lastActivityAt: "2026-03-06T00:00:00.000Z" }),
      makeCandidate({ id: "b-orchestrator", lastActivityAt: "2026-03-06T00:00:05.000Z" }),
    ]);
    expect(sessionId).toBeNull();
  });

  it("returns null when preferred orchestrator is not routable or missing", () => {
    const sessionId = selectFallbackOrchestratorSessionId(
      [
        makeCandidate({ id: "a-orchestrator", status: "killed", activity: "exited" }),
        makeCandidate({ id: "b-orchestrator", status: "working", activity: "ready" }),
      ],
      { preferredOrchestratorSessionId: "a-orchestrator" },
    );
    expect(sessionId).toBeNull();
  });

  it("detects orchestrator sessions by metadata role", () => {
    const sessionId = selectFallbackOrchestratorSessionId([
      makeCandidate({ id: "custom-session-1", metadata: { role: "orchestrator" } }),
      makeCandidate({ id: "worker-1", metadata: { role: "worker" } }),
    ]);
    expect(sessionId).toBe("custom-session-1");
  });
});

describe("coerceOrchestratorSessionRoutingCandidates", () => {
  it("normalizes only valid entries from unknown payload", () => {
    const normalized = coerceOrchestratorSessionRoutingCandidates([
      {
        id: "app-orchestrator",
        status: "working",
        activity: "active",
        lastActivityAt: "2026-03-06T00:00:00.000Z",
        metadata: { role: "orchestrator" },
      },
      { id: "" },
      null,
      "bad",
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toEqual(
      expect.objectContaining({
        id: "app-orchestrator",
        status: "working",
        activity: "active",
      }),
    );
  });
});
