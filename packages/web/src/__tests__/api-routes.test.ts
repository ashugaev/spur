import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionNotRestorableError,
  type Session,
  type SessionManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type SCM,
} from "@composio/ao-core";

// ── Mock Data ─────────────────────────────────────────────────────────
// Provides test sessions covering the key states the dashboard needs.

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

const testSessions: Session[] = [
  makeSession({ id: "backend-3", status: "needs_input", activity: "waiting_input" }),
  makeSession({
    id: "backend-7",
    status: "mergeable",
    activity: "idle",
    pr: {
      number: 432,
      url: "https://github.com/acme/my-app/pull/432",
      title: "feat: health check",
      owner: "acme",
      repo: "my-app",
      branch: "health-check",
      baseBranch: "main",
      isDraft: false,
    },
  }),
  makeSession({ id: "backend-9", status: "working", activity: "active" }),
  makeSession({
    id: "frontend-1",
    status: "killed",
    activity: "exited",
    projectId: "my-app",
    issueId: "INT-1270",
    branch: "INT-1270-table",
  }),
];

// ── Mock Services ─────────────────────────────────────────────────────

const mockSessionManager: SessionManager = {
  list: vi.fn(async () => testSessions),
  get: vi.fn(async (id: string) => testSessions.find((s) => s.id === id) ?? null),
  spawn: vi.fn(async (config) =>
    makeSession({
      id: `session-${Date.now()}`,
      projectId: config.projectId,
      issueId: config.issueId ?? null,
      status: "spawning",
    }),
  ),
  kill: vi.fn(async (id: string) => {
    if (!testSessions.find((s) => s.id === id)) {
      throw new Error(`Session ${id} not found`);
    }
  }),
  send: vi.fn(async (id: string) => {
    if (!testSessions.find((s) => s.id === id)) {
      throw new Error(`Session ${id} not found`);
    }
  }),
  cleanup: vi.fn(async () => ({ killed: [], skipped: [], errors: [] })),
  spawnOrchestrator: vi.fn(),
  restore: vi.fn(async (id: string) => {
    const session = testSessions.find((s) => s.id === id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    // Simulate SessionNotRestorableError for non-terminal sessions
    if (session.status === "working" && session.activity !== "exited") {
      throw new SessionNotRestorableError(id, "session is not in a terminal state");
    }
    return { ...session, status: "spawning" as const, activity: "active" as const };
  }),
};

const mockSCM: SCM = {
  name: "github",
  detectPR: vi.fn(async () => null),
  getPRState: vi.fn(async () => "open" as const),
  mergePR: vi.fn(async () => {}),
  closePR: vi.fn(async () => {}),
  getCIChecks: vi.fn(async () => []),
  getCISummary: vi.fn(async () => "passing" as const),
  getReviews: vi.fn(async () => []),
  getReviewDecision: vi.fn(async () => "approved" as const),
  getPendingComments: vi.fn(async () => []),
  getAutomatedComments: vi.fn(async () => []),
  getMergeability: vi.fn(async () => ({
    mergeable: true,
    ciPassing: true,
    approved: true,
    noConflicts: true,
    blockers: [],
  })),
};

const mockRegistry: PluginRegistry = {
  register: vi.fn(),
  get: vi.fn(() => mockSCM) as PluginRegistry["get"],
  list: vi.fn(() => []),
  loadBuiltins: vi.fn(async () => {}),
  loadFromConfig: vi.fn(async () => {}),
};

const mockConfig: OrchestratorConfig = {
  configPath: "/tmp/ao-test/agent-orchestrator.yaml",
  port: 3000,
  readyThresholdMs: 300_000,
  defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
  projects: {
    "my-app": {
      name: "My App",
      repo: "acme/my-app",
      path: "/tmp/my-app",
      defaultBranch: "main",
      sessionPrefix: "my-app",
      scm: { plugin: "github" },
    },
  },
  notifiers: {},
  notificationRouting: { urgent: [], action: [], warning: [], info: [] },
  reactions: {},
};

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    config: mockConfig,
    registry: mockRegistry,
    sessionManager: mockSessionManager,
  })),
  getSCM: vi.fn(() => mockSCM),
}));

// ── Import routes after mocking ───────────────────────────────────────

import { GET as sessionsGET } from "@/app/api/sessions/route";
import { POST as spawnPOST } from "@/app/api/spawn/route";
import { POST as sendPOST } from "@/app/api/sessions/[id]/send/route";
import { POST as killPOST } from "@/app/api/sessions/[id]/kill/route";
import { POST as restorePOST } from "@/app/api/sessions/[id]/restore/route";
import { POST as mergePOST } from "@/app/api/prs/[id]/merge/route";
import { GET as eventsGET } from "@/app/api/events/route";
import { GET as integrationsStatusGET } from "@/app/api/integrations/status/route";

const originalIntegrationsSnapshotPath = process.env.AO_INTEGRATIONS_HEALTH_SNAPSHOT_PATH;
const originalHealthSnapshotPath = process.env.AO_HEALTH_SNAPSHOT_PATH;
const originalIntegrationsStatusPath = process.env.AO_INTEGRATIONS_STATUS_PATH;
const originalConfigPath = process.env.AO_CONFIG_PATH;
const originalProjectId = process.env.AO_PROJECT_ID;

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL(url, "http://localhost:3000"),
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  if (originalIntegrationsSnapshotPath === undefined) {
    delete process.env.AO_INTEGRATIONS_HEALTH_SNAPSHOT_PATH;
  } else {
    process.env.AO_INTEGRATIONS_HEALTH_SNAPSHOT_PATH = originalIntegrationsSnapshotPath;
  }
  if (originalHealthSnapshotPath === undefined) {
    delete process.env.AO_HEALTH_SNAPSHOT_PATH;
  } else {
    process.env.AO_HEALTH_SNAPSHOT_PATH = originalHealthSnapshotPath;
  }
  if (originalIntegrationsStatusPath === undefined) {
    delete process.env.AO_INTEGRATIONS_STATUS_PATH;
  } else {
    process.env.AO_INTEGRATIONS_STATUS_PATH = originalIntegrationsStatusPath;
  }
  if (originalConfigPath === undefined) {
    delete process.env.AO_CONFIG_PATH;
  } else {
    process.env.AO_CONFIG_PATH = originalConfigPath;
  }
  if (originalProjectId === undefined) {
    delete process.env.AO_PROJECT_ID;
  } else {
    process.env.AO_PROJECT_ID = originalProjectId;
  }

  // Re-set default return values
  (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue(testSessions);
  (mockSessionManager.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (id: string) => testSessions.find((s) => s.id === id) ?? null,
  );
});

describe("API Routes", () => {
  // ── GET /api/sessions ──────────────────────────────────────────────

  describe("GET /api/sessions", () => {
    it("returns sessions array and stats", async () => {
      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.sessions).toBeDefined();
      expect(Array.isArray(data.sessions)).toBe(true);
      expect(data.sessions.length).toBe(testSessions.length);
      expect(data.stats).toBeDefined();
      expect(data.stats.totalSessions).toBe(data.sessions.length);
    });

    it("stats include expected fields", async () => {
      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      const data = await res.json();
      expect(data.stats).toHaveProperty("totalSessions");
      expect(data.stats).toHaveProperty("workingSessions");
      expect(data.stats).toHaveProperty("openPRs");
      expect(data.stats).toHaveProperty("needsReview");
    });

    it("sessions have expected shape", async () => {
      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      const data = await res.json();
      const session = data.sessions[0];
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("projectId");
      expect(session).toHaveProperty("status");
      expect(session).toHaveProperty("activity");
      expect(session).toHaveProperty("createdAt");
    });
  });

  // ── POST /api/spawn ────────────────────────────────────────────────

  describe("POST /api/spawn", () => {
    it("creates a session with valid input", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app", issueId: "INT-100" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.session).toBeDefined();
      expect(data.session.projectId).toBe("my-app");
      expect(data.session.status).toBe("spawning");
    });

    it("returns 400 when projectId is missing", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/projectId/);
    });

    it("returns 400 with invalid JSON", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);
      expect(res.status).toBe(400);
    });

    it("handles missing issueId gracefully", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.session.issueId).toBeNull();
    });
  });

  // ── POST /api/sessions/:id/send ────────────────────────────────────

  describe("POST /api/sessions/:id/send", () => {
    it("sends a message to a valid session", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({ message: "Fix the tests" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.message).toBe("Fix the tests");
    });

    it("returns 404 for unknown session", async () => {
      (mockSessionManager.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Session nonexistent not found"),
      );
      const req = makeRequest("/api/sessions/nonexistent/send", {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });

    it("returns 400 when message is missing", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/message/);
    });

    it("returns 400 for invalid JSON body", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
    });

    it("returns 400 for control-char-only message", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({ message: "\x00\x01\x02" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/empty/);
    });
  });

  // ── POST /api/sessions/:id/kill ────────────────────────────────────

  describe("POST /api/sessions/:id/kill", () => {
    it("kills a valid session", async () => {
      const req = makeRequest("/api/sessions/backend-3/kill", { method: "POST" });
      const res = await killPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.sessionId).toBe("backend-3");
    });

    it("returns 404 for unknown session", async () => {
      (mockSessionManager.kill as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Session nonexistent not found"),
      );
      const req = makeRequest("/api/sessions/nonexistent/kill", { method: "POST" });
      const res = await killPOST(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/sessions/:id/restore ─────────────────────────────────

  describe("POST /api/sessions/:id/restore", () => {
    it("restores a killed session", async () => {
      const req = makeRequest("/api/sessions/frontend-1/restore", { method: "POST" });
      const res = await restorePOST(req, { params: Promise.resolve({ id: "frontend-1" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.sessionId).toBe("frontend-1");
    });

    it("returns 404 for unknown session", async () => {
      const req = makeRequest("/api/sessions/nonexistent/restore", { method: "POST" });
      const res = await restorePOST(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });

    it("returns 409 for active session", async () => {
      const req = makeRequest("/api/sessions/backend-9/restore", { method: "POST" });
      const res = await restorePOST(req, { params: Promise.resolve({ id: "backend-9" }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toMatch(/not in a terminal state/);
    });
  });

  // ── POST /api/prs/:id/merge ────────────────────────────────────────

  describe("POST /api/prs/:id/merge", () => {
    it("merges a mergeable PR", async () => {
      const req = makeRequest("/api/prs/432/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "432" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.prNumber).toBe(432);
    });

    it("returns 404 for unknown PR", async () => {
      const req = makeRequest("/api/prs/99999/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "99999" }) });
      expect(res.status).toBe(404);
    });

    it("returns 422 for non-mergeable PR", async () => {
      (mockSCM.getMergeability as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: true,
        blockers: ["CI checks failing", "Needs review"],
      });
      const req = makeRequest("/api/prs/432/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "432" }) });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toMatch(/not mergeable/);
      expect(data.blockers).toBeDefined();
    });

    it("returns 400 for non-numeric PR id", async () => {
      const req = makeRequest("/api/prs/abc/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "abc" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/Invalid PR number/);
    });

    it("returns 409 for merged PR", async () => {
      (mockSCM.getPRState as ReturnType<typeof vi.fn>).mockResolvedValueOnce("merged");
      const req = makeRequest("/api/prs/432/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "432" }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toMatch(/merged/);
    });
  });

  // ── GET /api/integrations/status ───────────────────────────────────

  describe("GET /api/integrations/status", () => {
    it("returns integration listener snapshot from file", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "ao-integrations-status-"));
      const snapshotPath = join(tmp, "snapshot.json");
      writeFileSync(
        snapshotPath,
        JSON.stringify({
          version: 1,
          projectId: "my-app",
          updatedAt: "2026-03-06T11:22:33.000Z",
          entries: [
            {
              id: "telegram-polling",
              service: "telegram",
              kind: "polling",
              active: true,
              connected: true,
              ok: true,
              state: "healthy",
              message: "Polling active",
            },
            {
              id: "jira-comment-polling",
              service: "jira",
              kind: "polling",
              active: true,
              connected: true,
              ok: false,
              state: "degraded",
              message: "Auth needs refresh",
            },
            {
              id: "listener:jira-broai",
              service: "jira",
              kind: "listener",
              active: true,
              connected: true,
              ok: true,
              state: "healthy",
              message: "Listener running",
            },
          ],
        }),
        "utf-8",
      );

      process.env.AO_INTEGRATIONS_HEALTH_SNAPSHOT_PATH = snapshotPath;

      try {
        const res = await integrationsStatusGET();
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.source).toBe("snapshot");
        expect(data.updatedAt).toBe("2026-03-06T11:22:33.000Z");
        expect(data.integrations.telegramInboundPolling.active).toBe(true);
        expect(data.integrations.telegramInboundPolling.connected).toBe(true);
        expect(data.integrations.telegramInboundPolling.ok).toBe(true);
        expect(data.integrations.jiraCommentPolling.ok).toBe(false);
        expect(data.integrations.jiraCommentPolling.message).toMatch(/Auth needs refresh/);
        expect(data.integrations.jiraTriggerListeners.state).toBe("healthy");
        expect(data.integrations.jiraTriggerListeners.ok).toBe(true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("returns inactive/unknown fallback when snapshot is missing", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "ao-integrations-status-missing-"));
      delete process.env.AO_CONFIG_PATH;
      delete process.env.AO_PROJECT_ID;
      delete process.env.AO_HEALTH_SNAPSHOT_PATH;
      delete process.env.AO_INTEGRATIONS_STATUS_PATH;
      process.env.AO_INTEGRATIONS_HEALTH_SNAPSHOT_PATH = join(tmp, "missing-integrations.json");

      try {
        const res = await integrationsStatusGET();
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.source).toBe("fallback");
        expect(data.integrations.telegramInboundPolling.active).toBe(false);
        expect(data.integrations.jiraCommentPolling.active).toBe(false);
        expect(data.integrations.jiraTriggerListeners.active).toBe(false);
        expect(data.integrations.telegramInboundPolling.state).toBe("unknown");
        expect(data.integrations.jiraCommentPolling.state).toBe("unknown");
        expect(data.integrations.jiraTriggerListeners.state).toBe("unknown");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("normalizes legacy integration payload shape to canonical contract", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "ao-integrations-status-legacy-"));
      const snapshotPath = join(tmp, "snapshot.json");
      writeFileSync(
        snapshotPath,
        JSON.stringify({
          updatedAt: "2026-03-06T12:00:00.000Z",
          integrations: {
            telegramInboundPolling: { state: "starting" },
            jiraCommentPolling: { state: "degraded", detail: "Rate limit reached" },
            jiraTriggerListeners: true,
          },
        }),
        "utf-8",
      );

      process.env.AO_INTEGRATIONS_HEALTH_SNAPSHOT_PATH = snapshotPath;

      try {
        const res = await integrationsStatusGET();
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.source).toBe("snapshot");
        expect(data.integrations.telegramInboundPolling.state).toBe("starting");
        expect(data.integrations.telegramInboundPolling.active).toBe(true);
        expect(data.integrations.telegramInboundPolling.connected).toBe(false);
        expect(data.integrations.telegramInboundPolling.ok).toBe(false);
        expect(data.integrations.jiraCommentPolling.state).toBe("degraded");
        expect(data.integrations.jiraCommentPolling.message).toMatch(/Rate limit reached/);
        expect(data.integrations.jiraTriggerListeners.state).toBe("healthy");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("returns fallback when snapshot JSON is invalid", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "ao-integrations-status-invalid-"));
      const snapshotPath = join(tmp, "snapshot.json");
      writeFileSync(snapshotPath, "{ this is not valid json", "utf-8");
      process.env.AO_INTEGRATIONS_HEALTH_SNAPSHOT_PATH = snapshotPath;

      try {
        const res = await integrationsStatusGET();
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.source).toBe("fallback");
        expect(data.snapshotPath).toBe(snapshotPath);
        expect(data.integrations.telegramInboundPolling.message).toMatch(/invalid JSON/);
        expect(data.integrations.telegramInboundPolling.state).toBe("unknown");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("falls back from missing explicit env snapshot to config-dir default snapshot path", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "ao-integrations-status-default-fallback-"));
      const configPath = join(tmp, "agent-orchestrator.yaml");
      const fallbackSnapshotPath = join(tmp, ".ao-integrations-health.json");

      writeFileSync(
        fallbackSnapshotPath,
        JSON.stringify({
          version: 1,
          projectId: "default-fallback",
          updatedAt: "2026-03-06T13:00:00.000Z",
          entries: [
            {
              id: "telegram-polling",
              service: "telegram",
              kind: "polling",
              active: true,
              connected: true,
              ok: true,
              state: "healthy",
              message: "Polling active",
            },
          ],
        }),
        "utf-8",
      );

      process.env.AO_CONFIG_PATH = configPath;
      delete process.env.AO_PROJECT_ID;
      delete process.env.AO_HEALTH_SNAPSHOT_PATH;
      delete process.env.AO_INTEGRATIONS_STATUS_PATH;
      process.env.AO_INTEGRATIONS_HEALTH_SNAPSHOT_PATH = join(tmp, "missing-snapshot.json");

      try {
        const res = await integrationsStatusGET();
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.source).toBe("snapshot");
        expect(data.snapshotPath).toBe(fallbackSnapshotPath);
        expect(data.integrations.telegramInboundPolling.ok).toBe(true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("resolves relative snapshot env path from AO_CONFIG_PATH directory", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "ao-integrations-status-relative-"));
      const configPath = join(tmp, "agent-orchestrator.yaml");
      const relativeSnapshotPath = join(".ao", "integration-health.json");
      const absoluteSnapshotPath = join(tmp, relativeSnapshotPath);
      const originalConfigPath = process.env.AO_CONFIG_PATH;

      mkdirSync(join(tmp, ".ao"), { recursive: true });
      writeFileSync(
        absoluteSnapshotPath,
        JSON.stringify({
          updatedAt: "2026-03-06T12:22:00.000Z",
          integrations: {
            telegramInboundPolling: { active: true, connected: true, ok: true, state: "healthy" },
            jiraCommentPolling: { active: false, connected: false, ok: false, state: "inactive" },
            jiraTriggerListeners: { active: false, connected: false, ok: false, state: "inactive" },
          },
        }),
        "utf-8",
      );

      process.env.AO_CONFIG_PATH = configPath;
      process.env.AO_INTEGRATIONS_HEALTH_SNAPSHOT_PATH = relativeSnapshotPath;

      try {
        const res = await integrationsStatusGET();
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.source).toBe("snapshot");
        expect(data.snapshotPath).toBe(absoluteSnapshotPath);
        expect(data.integrations.telegramInboundPolling.ok).toBe(true);
      } finally {
        if (originalConfigPath === undefined) {
          delete process.env.AO_CONFIG_PATH;
        } else {
          process.env.AO_CONFIG_PATH = originalConfigPath;
        }
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  // ── GET /api/events (SSE) ──────────────────────────────────────────

  describe("GET /api/events", () => {
    it("returns SSE content type", async () => {
      const res = await eventsGET();
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
    });

    it("streams initial snapshot event", async () => {
      const res = await eventsGET();
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      reader.cancel();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("data: ");
      const jsonStr = text.replace("data: ", "").trim();
      const event = JSON.parse(jsonStr);
      expect(event.type).toBe("snapshot");
      expect(Array.isArray(event.sessions)).toBe(true);
      expect(event.sessions.length).toBeGreaterThan(0);
      expect(event.sessions[0]).toHaveProperty("id");
      expect(event.sessions[0]).toHaveProperty("attentionLevel");
    });
  });
});
